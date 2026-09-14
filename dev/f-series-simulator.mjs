// Synthetic F730-like Modbus TCP fixture. No heat-pump control or upstream code.
import net from 'node:net';
import {pathToFileURL} from 'node:url';

export function createFixture({room = true, power = true, production = true} = {}) {
    const words = new Map();
    const set = (address, value, wide = false) => {
        words.set(address, value & 0xffff);
        if (wide) words.set(address + 1, (value >>> 16) & 0xffff);
    };
    // Only implemented registers exist: absent accessories must not be inferred from zeros.
    for (const [a, v] of [[40004, 75], [40008, 350], [40012, 290], [40013, 520],
        [40014, 470], [40025, 215], [40026, 30], [43009, 360], [43005, -600],
        [43108, 65], [43437, 45], [45001, 0], [47011, 0], [47398, 210], [47402, 20], [47007, 9], [47041, 1], [48132, 0], [47050, 1], [47265, 65], [47137, 0], [47370, 1], [47371, 1]]) set(a, v);
    set(47394, room ? 1 : 0);
    if (room) set(40033, 212);
    const produced = {heating: 1000, hotwater: 500};
    const consumed = {heating: 300, hotwater: 200};
    const advance = (phase, seconds) => {
        const running = phase === 'heating' || phase === 'hotwater';
        const immersion = phase === 'immersion';
        const role = phase === 'hotwater' ? 'hotwater' : 'heating';
        const compressor = running ? 1000 : 0;
        const addition = immersion ? 2000 : 0;
        set(43086, running || immersion ? (role === 'hotwater' ? 20 : 30) : 10);
        set(43435, running ? 1 : 0); set(43136, running ? 500 : 0);
        if (power) { set(43141, compressor); set(43375, compressor); set(43084, addition / 10); }
        consumed[role] += (compressor + addition) * seconds / 3600000;
        produced[role] += (compressor * (role === 'heating' ? 3 : 2.5) + addition) * seconds / 3600000;
        if (production) {
            set(42439, Math.floor(produced.heating * 10), true);
            set(42437, Math.floor(produced.hotwater * 10), true);
        }
        set(41850, Math.floor(consumed.heating * 10), true);
        set(41848, Math.floor(consumed.hotwater * 10), true);
        set(41846, 100, true);
    };
    advance('idle', 0);
    return {words, advance};
}

export async function startSimulator({host = '127.0.0.1', port = 1502, mode = 'modbus40',
    phaseSeconds = 120, room = true, power = true, production = true,
    readDelayMs = 0, logSet = /** @type {number[]} */ ([])} = {}) {
    if (!['modbus40', 'nibegw'].includes(mode)) throw new Error('mode must be modbus40 or nibegw');
    if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isFinite(phaseSeconds) || phaseSeconds < 1)
        throw new Error('Invalid port or phase duration');
    if (!Number.isFinite(readDelayMs) || readDelayMs < 0) throw new Error('Invalid read delay');
    const broadcast = new Set(logSet);
    const replies = new Set();
    const wide = new Set([42439, 42437, 41850, 41848, 41846]);
    const fixture = createFixture({room, power, production});
    const phases = ['heating', 'hotwater', 'immersion', 'idle'];
    const started = Date.now(); let last = started;
    const timer = setInterval(() => {
        const now = Date.now();
        fixture.advance(phases[Math.floor((now - started) / 1000 / phaseSeconds) % phases.length], (now - last) / 1000);
        last = now;
    }, 1000);
    fixture.advance('heating', 0);
    const sockets = new Set();
    const server = net.createServer((socket) => {
        sockets.add(socket); socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        let pending = Buffer.alloc(0);
        socket.on('data', (data) => {
            pending = Buffer.concat([pending, data]);
            while (pending.length >= 7) {
                const length = pending.readUInt16BE(4);
                if (length < 2 || length > 254 || pending.readUInt16BE(2) !== 0) { socket.destroy(); return; }
                if (pending.length < length + 6) return;
                const frame = pending.subarray(0, length + 6); pending = pending.subarray(length + 6);
                const fc = frame[7]; let error = 0; let values = []; let delay = 0;
                if (fc === 16 && length === 9 && frame[12] === 2 && frame.readUInt16BE(10) === 1) {
                    const address = frame.readUInt16BE(8) + (mode === 'nibegw' ? 40000 : 0);
                    const raw = frame.readUInt16BE(13);
                    const signed = raw >= 32768 ? raw - 65536 : raw;
                    const bounds = {47007: [0, 15], 47011: [-10, 10], 47394: [0, 1],
                        47398: [50, 300], 47402: [0, 60], 47041: [0, 4], 48132: [0, 4],
                        47050: [0, 1], 47265: [0, 100], 47137: [0, 2], 47370: [0, 1], 47371: [0, 1]};
                    const range = bounds[address];
                    if (!range) error = 2;
                    else if (signed < range[0] || signed > range[1] || (address === 47041 && raw === 3)) error = 3;
                    else {
                        fixture.words.set(address, raw);
                        const header = Buffer.from(frame.subarray(0, 7)); header.writeUInt16BE(6, 4);
                        socket.write(Buffer.concat([header, frame.subarray(7, 12)]));
                        continue;
                    }
                } else if (fc !== 3) error = fc === 16 ? 3 : 1;
                else if (length !== 6) error = 3;
                else {
                    const start = frame.readUInt16BE(8) + (mode === 'nibegw' ? 40000 : 0);
                    const count = frame.readUInt16BE(10);
                    delay = broadcast.has(start) ? 0 : readDelayMs;
                    // One logical parameter, including its two words for a 32-bit counter.
                    if (count !== (wide.has(start) ? 2 : 1)) error = 3;
                    else {
                        values = Array.from({length: count}, (_, i) => fixture.words.get(start + i));
                        if (values.some((v) => v === undefined)) error = 2;
                    }
                }
                const pdu = error ? Buffer.from([fc | 0x80, error]) : Buffer.alloc(2 + values.length * 2);
                if (!error) { pdu[0] = fc; pdu[1] = values.length * 2; values.forEach((v, i) => pdu.writeUInt16BE(v, 2 + i * 2)); }
                const header = Buffer.from(frame.subarray(0, 7)); header.writeUInt16BE(pdu.length + 1, 4);
                const reply = Buffer.concat([header, pdu]);
                if (delay > 0) {
                    const timer = setTimeout(() => {
                        replies.delete(timer);
                        if (!socket.destroyed) socket.write(reply);
                    }, delay);
                    replies.add(timer);
                } else socket.write(reply);
            }
        });
    });
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); }
    catch (error) { clearInterval(timer); throw error; }
    return {fixture, port: server.address().port, close: async () => {
        clearInterval(timer); replies.forEach(clearTimeout); sockets.forEach((s) => s.destroy());
        await new Promise((resolve) => server.close(resolve));
    }};
}

async function main() {
    const args = process.argv.slice(2);
    const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
    const host = option('--host', '127.0.0.1');
    const simulator = await startSimulator({host, port: Number(option('--port', 1502)),
        mode: option('--mode', 'modbus40'), phaseSeconds: Number(option('--phase-seconds', 120)),
        readDelayMs: Number(option('--read-delay-ms', 0)),
        logSet: String(option('--log-set', '')).split(',').filter(Boolean).map(Number),
        room: !args.includes('--no-room'), power: !args.includes('--no-power'), production: !args.includes('--no-production')});
    console.log(`Synthetic F-series at ${host}:${simulator.port}. Heating → hot water → immersion → idle. Ctrl-C stops.`);
    process.once('SIGINT', async () => { await simulator.close(); });
    process.once('SIGTERM', async () => { await simulator.close(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    main().catch((error) => { console.error(error.message); process.exitCode = 1; });
