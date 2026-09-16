import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {ModbusTCPClient} from 'jsmodbus';
import {startSimulator, createFixture} from '../dev/f-series-simulator.mjs';
import {fProfile} from '../drivers/nibe_f/profile';
import {readNumeric} from '../lib/detection';
import {combineRaw, toNumericValue} from '../lib/registers';

test('F730 owner packets confirm zero-based addressing and aligned low-word-first current', async () => {
    // Captured by QModMaster, 2026-09-16. Only transaction IDs are adapted.
    const captures = [
        ['000100000006010300180001', '00010000000501030200db'],
        ['000100000006010300190001', '00010000000501030200e4'],
        ['0001000000060103004e0002', '00010000000701030400320000'],
        ['0001000000060103004f0002', '00010000000701030400000020']
    ];
    const requests: Buffer[] = [];
    const peers = new Set<net.Socket>();
    const server = net.createServer((peer) => {
        peers.add(peer);
        let pending = Buffer.alloc(0);
        peer.on('data', (chunk) => {
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= 6 && pending.length >= 6 + pending.readUInt16BE(4)) {
                const length = 6 + pending.readUInt16BE(4);
                const request = pending.subarray(0, length);
                pending = pending.subarray(length);
                const capture = captures[requests.length];
                requests.push(request);
                if (!capture) { peer.destroy(); return; }
                const reply = Buffer.from(capture[1], 'hex');
                request.copy(reply, 0, 0, 2);
                peer.write(reply);
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const socket = net.createConnection((server.address() as net.AddressInfo).port, '127.0.0.1');
    const client = new ModbusTCPClient(socket, 1, 2000);
    try {
        await new Promise<void>((resolve, reject) => {
            socket.once('connect', resolve); socket.once('error', reject);
        });
        const profile = {...fProfile, addressBase: fProfile.addressModes!.nibegw.addressBase};
        const at = (address: number) => fProfile.registers.find((r) => r.address === address)!;
        assert.equal(await readNumeric(client, at(40025), profile), 21.9);
        assert.equal(await readNumeric(client, at(40026), profile), 22.8);
        assert.equal(await readNumeric(client, at(40079), profile), 5);
        const shifted = (await client.readHoldingRegisters(79, 2)).response.body.valuesAsArray;
        // This crosses the sensor boundary; 32 is not a second BE3 measurement.
        assert.equal(toNumericValue(at(40079), combineRaw(Array.from(shifted), 32)), 209715.2);
        assert.equal(requests.length, captures.length);
        requests.forEach((request, i) => assert.deepEqual(request.subarray(2),
            Buffer.from(captures[i][0], 'hex').subarray(2)));
    } finally {
        socket.destroy(); peers.forEach((peer) => peer.destroy());
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test('nibegw reads the named sensor, not its neighbor, and aligns both words of a counter', async () => {
    const server = await startSimulator({port: 0, mode: 'nibegw'});
    server.fixture.words.set(40025, 218);
    server.fixture.words.set(40026, 165);
    server.fixture.words.set(40079, 17);
    server.fixture.words.set(40080, 0);
    server.fixture.words.set(40081, 29);
    const socket = net.createConnection(server.port, '127.0.0.1');
    const client = new ModbusTCPClient(socket, 1, 2000);
    try {
        await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
        // Explicit protocol expectations, independent of the profile's address arithmetic.
        assert.equal((await client.readHoldingRegisters(24, 1)).response.body.valuesAsArray[0], 218);
        assert.equal((await client.readHoldingRegisters(25, 1)).response.body.valuesAsArray[0], 165);
        const profile = {...fProfile, addressBase: fProfile.addressModes!.nibegw.addressBase};
        const at = (address: number) => fProfile.registers.find((r) => r.address === address)!;
        assert.equal(await readNumeric(client, at(40025), profile), 21.8);
        assert.equal(await readNumeric(client, at(40079), profile), 1.7);
        // Old offset starts on the high word, then consumes the next sensor's low word.
        assert.equal(toNumericValue(at(40079), combineRaw([server.fixture.words.get(40080)!,
            server.fixture.words.get(40081)!], 32)), 190054.4);
        await client.writeMultipleRegisters(7010, [2]); // NIBE 47011 curve offset
        assert.equal(server.fixture.words.get(47011), 2);
    } finally { socket.destroy(); await server.close(); }
});

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
            frame.writeUInt16BE(address - (mode === 'nibegw' ? 40001 : 0), 8); socket.write(frame);
        });
        assert.equal((await request(3, 40004)).readUInt16BE(9), 75);
        assert.deepEqual([...((await request(3, 40042)).subarray(7))], [0x83, 2]);
        assert.deepEqual([...((await request(6, 47398)).subarray(7))], [0x86, 1]);
        const written = new Promise<Buffer>((resolve) => socket.once('data', resolve));
        const write = Buffer.from([0, 2, 0, 0, 0, 9, 1, 16, 0, 0, 0, 1, 2, 0, 220]);
        write.writeUInt16BE(47398 - (mode === 'nibegw' ? 40001 : 0), 8);
        socket.write(write);
        assert.equal((await written)[7], 16);
        assert.equal((await request(3, 47398)).readUInt16BE(9), 220);
    } finally { socket.destroy(); await server.close(); }
});
