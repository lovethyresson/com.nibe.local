import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {ModbusTCPClient} from 'jsmodbus';
import {startSimulator, createFixture} from '../dev/f-series-simulator.mjs';

test('slow simulator delays non-LOG.SET reads and accepts only one logical parameter', async () => {
    const server = await startSimulator({port: 0, readDelayMs: 100, logSet: [40004]});
    const socket = net.createConnection(server.port, '127.0.0.1');
    const client = new ModbusTCPClient(socket, 1, 2000);
    try {
        await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
        const fast = await client.readHoldingRegisters(40004, 1);
        assert.equal(fast.response.body.valuesAsArray[0], 75);
        const started = Date.now();
        const slow = await client.readHoldingRegisters(42439, 2);
        assert.equal(slow.response.body.valuesAsArray.length, 2);
        assert.ok(Date.now() - started >= 90);
        await assert.rejects(client.readHoldingRegisters(40004, 2));
    } finally { socket.destroy(); await server.close(); }
});

test('synthetic cycle advances production and consumption in physical units', () => {
    const f = createFixture();
    f.advance('heating', 3600);
    assert.equal(f.words.get(42439), 10030); // +3 kWh production
    assert.equal(f.words.get(41850), 3010); // +1 kWh electricity
    f.advance('immersion', 3600);
    assert.equal(f.words.get(42439), 10050); // resistive COP 1
    assert.equal(f.words.get(41850), 3030);
    assert.equal(createFixture({room: false}).words.has(40033), false);
});

for (const mode of ['modbus40', 'nibegw']) test(`simulator serves ${mode} and rejects missing registers/writes`, async () => {
    const server = await startSimulator({port: 0, mode});
    const socket = net.createConnection(server.port, '127.0.0.1');
    try {
        await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
        const request = (fc: number, address: number) => new Promise<Buffer>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('No simulator reply')), 1000);
            socket.once('data', (data) => { clearTimeout(timer); resolve(data); });
            const frame = Buffer.from([0, 1, 0, 0, 0, 6, 1, fc, 0, 0, 0, 1]);
            frame.writeUInt16BE(address - (mode === 'nibegw' ? 40000 : 0), 8); socket.write(frame);
        });
        assert.equal((await request(3, 40004)).readUInt16BE(9), 75);
        assert.deepEqual([...((await request(3, 40042)).subarray(7))], [0x83, 2]);
        assert.deepEqual([...((await request(6, 47398)).subarray(7))], [0x86, 1]);
        const written = new Promise<Buffer>((resolve) => socket.once('data', resolve));
        const write = Buffer.from([0, 2, 0, 0, 0, 9, 1, 16, 0, 0, 0, 1, 2, 0, 220]);
        write.writeUInt16BE(47398 - (mode === 'nibegw' ? 40000 : 0), 8);
        socket.write(write);
        assert.equal((await written)[7], 16);
        assert.equal((await request(3, 47398)).readUInt16BE(9), 220);
    } finally { socket.destroy(); await server.close(); }
});
