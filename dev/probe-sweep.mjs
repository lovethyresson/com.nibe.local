// Maintainer tool (not shipped — see .homeyignore). Reads *every* register in a model's CSV and
// tells you which ones carry a value you're looking for, or which ones moved.
//
// Written to answer "where does the myUplink app put the indoor temperature?" — a question the
// curated probes can't answer, because the answer turned out to be a register with no title.
// Nibe's CSVs leave whole families named only `id:12801`, and the zone setpoints are one of them:
//
//   id:12801-12840  holding 2505-2583 (step 2, s32)  50..300  def 200   40 zones, heating setpoint
//   id:12841-12880  holding 2585-2663 (step 2, s32)  50..350  def 250   40 zones, cooling setpoint
//   id:55035-55037  holding 1555-1557 (u8)            0..40             zone index, one per system?
//
// Two modes, and the second is the one that proves things:
//
//   --expect V   read everything once, list every register whose decoded value is V. Set a
//                distinctive temperature in the myUplink app first, then look for it here.
//   --watch      snapshot everything, then re-read on an interval and print only what changed.
//                Change one thing in the app and the register it writes names itself.
//
// A full pass is ~1200 holding + ~700 input registers, so it takes a couple of minutes. Narrow it
// with --holding / --input / --from / --to when you know roughly where to look.
//
// The pump accepts a single Modbus client, so the running Homey app loses its connection while
// this runs (it reconnects by itself afterwards).
//
//   node dev/probe-sweep.mjs [host] --expect 35
//   node dev/probe-sweep.mjs --watch --interval 20 --holding --from 2000 --to 2700
//   node dev/probe-sweep.mjs --changed          # everything that differs from the CSV default

import net from 'net';
import {readFileSync} from 'fs';
import {fileURLToPath} from 'url';
import {dirname, join} from 'path';
import {createRequire} from 'module';

const require = createRequire(import.meta.url);
const {ModbusTCPClient} = require('jsmodbus');
const here = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? Number(argv[i + 1]) : fallback;
};
const text = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const host = argv.find((a) => !a.startsWith('--') && /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? '10.136.1.93';
const csvName = text('csv', 's1155_s1255.csv');
const expect = flag('expect', undefined);
const watch = has('watch');
const changedOnly = has('changed');
const intervalMs = flag('interval', 20) * 1000;
const from = flag('from', 0);
const to = flag('to', Number.MAX_SAFE_INTEGER);
const onlyHolding = has('holding');
const onlyInput = has('input');
const delayMs = flag('delay', 25);

// The CSVs ship two encodings of the "Size of variable" column: spelled out (u8/s16/u32) in the
// older exports, a numeric code in the newer ones. Mapping lifted from dev/audit-registers.mjs.
const SIZE_CODES = {1: 's8', 2: 's16', 3: 's32', 4: 'u8', 5: 'u16', 6: 'u32'};

function parseCsv(path) {
    const lines = readFileSync(path, 'utf8').split('\n').slice(1);
    const registers = [];
    for (const line of lines) {
        if (!line.trim())
            continue;
        const [title, type, address, div, unit, size, min, max, def] = line.split('\t');
        const kind = type === 'MODBUS_INPUT_REGISTER' ? 'input'
            : type === 'MODBUS_HOLDING_REGISTER' ? 'holding' : undefined;
        if (!kind)
            continue;
        const spelled = SIZE_CODES[size?.trim()] ?? size?.trim() ?? '';
        registers.push({
            title: (title ?? '').trim(),
            kind,
            address: Number(address),
            div: Number(div) || 1,
            unit: (unit ?? '').trim(),
            bits: /32$/.test(spelled) ? 32 : 16,
            def: def === undefined || def.trim() === '' ? undefined : Number(def)
        });
    }
    return registers;
}

// Low word first — verified against the live pump; big-endian word order yields garbage.
function combine(values, bits) {
    return bits === 32 ? values[1] * 65536 + values[0] : values[0];
}

function decode(raw, register) {
    if (raw === undefined || Number.isNaN(raw))
        return undefined;
    if (raw === (register.bits === 32 ? 0x80000000 : 0x8000))
        return undefined;                            // Nibe's not-available sentinel
    const limit = register.bits === 32 ? 0x100000000 : 65536;
    const signed = raw >= limit / 2 ? raw - limit : raw;
    return signed / register.div;
}

async function readOne(client, register) {
    const count = register.bits === 32 ? 2 : 1;
    const read = register.kind === 'input'
        ? client.readInputRegisters(register.address, count)
        : client.readHoldingRegisters(register.address, count);
    try {
        const response = await read;
        return combine(response.response.body.values, register.bits);
    } catch {
        return undefined;                            // absent on this model, or an exception
    }
}

function connect() {
    // Client before connect: jsmodbus goes online off the socket's own 'connect' event, so a
    // client built after that event has fired stays offline and every read fails.
    const socket = new net.Socket();
    const client = new ModbusTCPClient(socket, 1, 5000);
    return new Promise((resolve, reject) => {
        socket.setTimeout(10000, () => {
            socket.destroy();
            reject(new Error(`connection to ${host}:502 timed out`));
        });
        socket.once('connect', () => {
            socket.setTimeout(0);
            resolve({socket, client});
        });
        socket.once('error', reject);
        socket.connect({port: 502, host});
    });
}

function label(register) {
    const name = register.title || '(untitled)';
    return `${register.kind.padEnd(7)} ${String(register.address).padStart(5)}  ${name.padEnd(46)}`;
}

function show(register, value) {
    const unit = register.unit ? ` ${register.unit}` : '';
    return `${String(value).padStart(9)}${unit}`;
}

async function sweep(client, registers, onProgress) {
    const values = new Map();
    let done = 0;
    for (const register of registers) {
        const raw = await readOne(client, register);
        const value = decode(raw, register);
        if (value !== undefined)
            values.set(`${register.kind}:${register.address}`, value);
        if (++done % 100 === 0)
            onProgress(done, registers.length);
        if (delayMs)
            await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return values;
}

const all = parseCsv(join(here, 'csv', csvName));
const registers = all.filter((register) =>
    register.address >= from && register.address <= to
    && (!onlyHolding || register.kind === 'holding')
    && (!onlyInput || register.kind === 'input'));

console.log(`${csvName}: ${registers.length} registers to read `
    + `(${registers.filter((r) => r.kind === 'holding').length} holding, `
    + `${registers.filter((r) => r.kind === 'input').length} input)`);

const {socket, client} = await connect();
console.log(`connected to ${host}:502\n`);

const progress = (done, total) =>
    process.stdout.write(`\r  read ${done}/${total}...`);

let previous = await sweep(client, registers, progress);
process.stdout.write('\r');
console.log(`${previous.size} of ${registers.length} registers carried a value.\n`);

const key = (register) => `${register.kind}:${register.address}`;

if (expect !== undefined) {
    const hits = registers.filter((register) => {
        const value = previous.get(key(register));
        return value !== undefined && Math.abs(value - expect) < 0.001;
    });
    console.log(`=== REGISTERS READING ${expect} ===`);
    console.log(hits.length
        ? hits.map((r) => `  ${label(r)}${show(r, expect)}`).join('\n')
        : `  none`);
    console.log();
}

if (changedOnly) {
    const moved = registers.filter((register) => {
        const value = previous.get(key(register));
        return value !== undefined && register.def !== undefined
            && Math.abs(value - register.def / register.div) > 0.001;
    });
    console.log(`=== ${moved.length} REGISTERS DIFFER FROM THE CSV DEFAULT ===`);
    for (const register of moved)
        console.log(`  ${label(register)}${show(register, previous.get(key(register)))}`
            + `   (default ${register.def / register.div})`);
    console.log();
}

if (watch) {
    console.log(`Watching every ${intervalMs / 1000}s over ${registers.length} registers.`);
    console.log('Change ONE thing in the myUplink app — the register it writes will name itself.');
    console.log('Ctrl-C to stop.\n');
    process.on('SIGINT', () => {
        socket.end();
        socket.destroy();
        process.exit(0);
    });
    for (;;) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        const current = await sweep(client, registers, progress);
        process.stdout.write('\r');
        const lines = [];
        for (const register of registers) {
            const was = previous.get(key(register));
            const now = current.get(key(register));
            if (was === now)
                continue;
            lines.push(`  ${label(register)}${String(was ?? '—').padStart(9)}`
                + `  ->  ${String(now ?? '—').padStart(9)}${register.unit ? ' ' + register.unit : ''}`);
        }
        console.log(lines.length
            ? `[${new Date().toLocaleTimeString()}] changed:\n${lines.join('\n')}`
            : `[${new Date().toLocaleTimeString()}] nothing changed`);
        previous = current;
    }
}

socket.end();
socket.destroy();
