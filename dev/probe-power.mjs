// Maintainer tool (not shipped — see .homeyignore). Answers one question: what does input
// register 2727 "Current power" actually report?
//
// Register 2166 "Instantaneous used power" — the app's only power source — exists only on
// S1155/S1255, S1156/S1256 and S735. It is ABSENT on S320/S325, S330/S332 and S2125, which is
// why per-function energy and COP never populate on those models. 2727 is present on all six
// and is the obvious fallback, but Nibe's CSVs give only a title, so the physical quantity is
// unverified. An S1155 carries 2166 AND 2727 at once, so sampling one settles it:
//
//   H1  2727 is the same quantity as 2166, just coarser   ->  2727*10 W tracks 2166
//   H2  2727 excludes the internal additional heat        ->  2727*10 W tracks 2166 - 1027*10
//   H3  2727 is not the pump's electrical input           ->  tracks neither; correlates with
//                                                             the EME 20 block, or reads 0
//
// The winner is confirmed by integrating it over the window and comparing against the delta of
// the pump's own consumption counter (3823).
//
// The pump accepts a single Modbus client, so the running Homey app loses its connection while
// this runs (it reconnects by itself afterwards).
//
//   node dev/probe-power.mjs [host] [--minutes 5] [--interval 10]

import net from 'net';
import {createRequire} from 'module';

const require = createRequire(import.meta.url);
const {ModbusTCPClient} = require('jsmodbus');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
};
const host = argv.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) ?? '10.136.1.93';
const minutes = flag('minutes', 5);
const intervalMs = flag('interval', 10) * 1000;

// address, label, width, and the divisor that turns the raw value into the CSV's unit.
// `watts` converts the raw value to watts where the register is a power reading, so the
// candidates can be compared on one scale.
const REGS = [
    {addr: 1028, name: 'Priority',                  size: 16, div: 1},
    {addr: 1046, name: 'Compressor frequency',      size: 16, div: 10,  unit: 'Hz'},
    {addr: 2166, name: 'Instantaneous used power',  size: 32, div: 1,   unit: 'W',   watts: (r) => r},
    {addr: 2727, name: 'Current power',             size: 32, div: 100, unit: 'kW',  watts: (r) => r * 10},
    {addr: 2305, name: 'Energy log - Current power', size: 32, div: 100, unit: 'kW', watts: (r) => r * 10},
    {addr: 1027, name: 'Power internal add. heat',  size: 16, div: 100, unit: 'kW',  watts: (r) => r * 10},
    {addr: 2176, name: 'Current power (EME 20)',    size: 32, div: 1,   unit: 'W',   watts: (r) => r},
    {addr: 2178, name: 'Total avg power (EME 20)',  size: 32, div: 100, unit: 'kW',  watts: (r) => r * 10},
    {addr: 3821, name: 'Tot. production',           size: 32, div: 10,  unit: 'kWh'},
    {addr: 3823, name: 'Tot. consumption',          size: 32, div: 10,  unit: 'kWh'}
];

// Mirrors lib/registers.ts: 32-bit values are low word first, everything decodes signed, and
// 0x8000/0x80000000 is Nibe's "not available" sentinel.
const combineRaw = (values, size) => (size === 32 ? values[1] * 65536 + values[0] : values[0]);
const signedValue = (raw, size) => (size === 32
    ? (raw >= 0x80000000 ? raw - 0x100000000 : raw)
    : (raw >= 32768 ? raw - 65536 : raw));
const isUnavailable = (raw, size) => raw === (size === 32 ? 0x80000000 : 0x8000);

const socket = new net.Socket();
const client = new ModbusTCPClient(socket, 1, 5000);

async function read(reg) {
    try {
        const resp = await client.readInputRegisters(reg.addr, reg.size === 32 ? 2 : 1);
        const raw = combineRaw(resp.response.body.values, reg.size);
        if (isUnavailable(raw, reg.size))
            return undefined;
        return signedValue(raw, reg.size);
    } catch {
        return undefined;
    }
}

const samples = [];   // {t, raw: {addr -> raw|undefined}}

async function sample() {
    const raw = {};
    for (const reg of REGS)
        raw[reg.addr] = await read(reg);
    samples.push({t: Date.now(), raw});
    const line = REGS
        .filter((r) => r.watts || r.addr === 1028 || r.addr === 1046)
        .map((r) => {
            const v = raw[r.addr];
            if (v === undefined) return `${r.addr}=—`;
            return `${r.addr}=${(v / r.div).toFixed(r.div === 1 ? 0 : 2)}`;
        })
        .join('  ');
    console.log(`${new Date().toISOString().slice(11, 19)}  ${line}`);
}

// Mean absolute error between two watt series, over samples where both read.
function compare(aWatts, bWatts) {
    let n = 0, sumAbs = 0, sumB = 0;
    for (let i = 0; i < samples.length; ++i) {
        const a = aWatts(samples[i]), b = bWatts(samples[i]);
        if (a === undefined || b === undefined) continue;
        n++;
        sumAbs += Math.abs(a - b);
        sumB += Math.abs(b);
    }
    if (!n) return null;
    return {n, mae: sumAbs / n, relative: sumB ? sumAbs / sumB : null};
}

// Trapezoidal integral of a watt series over the sampling window, in kWh.
function integrate(watts) {
    let kwh = 0;
    for (let i = 1; i < samples.length; ++i) {
        const a = watts(samples[i - 1]), b = watts(samples[i]);
        if (a === undefined || b === undefined) continue;
        kwh += ((a + b) / 2) * ((samples[i].t - samples[i - 1].t) / 3600000) / 1000;
    }
    return kwh;
}

const wattsOf = (addr) => {
    const reg = REGS.find((r) => r.addr === addr);
    return (s) => (s.raw[addr] === undefined ? undefined : reg.watts(s.raw[addr]));
};

function report() {
    const w2166 = wattsOf(2166), w2727 = wattsOf(2727), w2305 = wattsOf(2305);
    const w1027 = wattsOf(1027), w2176 = wattsOf(2176), w2178 = wattsOf(2178);
    const compressorOnly = (s) => {
        const a = w2166(s), b = w1027(s);
        return a === undefined || b === undefined ? undefined : a - b;
    };

    console.log(`\n${'='.repeat(78)}\nSamples: ${samples.length} over ${minutes} min\n`);

    console.log('--- Availability -------------------------------------------------------------');
    for (const reg of REGS) {
        const read = samples.filter((s) => s.raw[reg.addr] !== undefined).length;
        const values = samples.map((s) => s.raw[reg.addr]).filter((v) => v !== undefined);
        const min = values.length ? Math.min(...values) / reg.div : null;
        const max = values.length ? Math.max(...values) / reg.div : null;
        const state = read === 0 ? 'NEVER READ'
            : (max === 0 && min === 0 ? 'FLAT ZERO' : `${min} .. ${max} ${reg.unit ?? ''}`);
        console.log(`  ${String(reg.addr).padEnd(6)} ${reg.name.padEnd(30)} ${String(read).padStart(3)}/${samples.length}  ${state}`);
    }

    console.log('\n--- Hypotheses (mean absolute error vs 2166, in watts) -----------------------');
    const rows = [
        ['H1  2727*10          vs 2166', compare(w2727, w2166)],
        ['H2  2727*10          vs 2166 - 1027*10', compare(w2727, compressorOnly)],
        ['H3a 2727*10          vs 2176 (EME 20)', compare(w2727, w2176)],
        ['H3b 2727*10          vs 2178 (EME 20)', compare(w2727, w2178)],
        ['    2305*10          vs 2166', compare(w2305, w2166)],
        ['    2305*10          vs 2166 - 1027*10', compare(w2305, compressorOnly)]
    ];
    for (const [label, result] of rows) {
        if (!result) { console.log(`  ${label.padEnd(42)} no overlapping samples`); continue; }
        const rel = result.relative === null ? 'n/a' : `${(result.relative * 100).toFixed(1)}%`;
        console.log(`  ${label.padEnd(42)} MAE ${result.mae.toFixed(1).padStart(8)} W   (${rel} relative, n=${result.n})`);
    }

    console.log('\n--- Integration vs the pump\'s own counter (3823) ------------------------------');
    const first = samples.find((s) => s.raw[3823] !== undefined);
    const last = [...samples].reverse().find((s) => s.raw[3823] !== undefined);
    const counterDelta = first && last && first !== last ? (last.raw[3823] - first.raw[3823]) / 10 : null;
    console.log(`  3823 counter delta over window : ${counterDelta === null ? 'n/a' : counterDelta.toFixed(3) + ' kWh'}`);
    console.log(`  integral of 2166               : ${integrate(w2166).toFixed(4)} kWh`);
    console.log(`  integral of 2727*10            : ${integrate(w2727).toFixed(4)} kWh`);
    console.log(`  integral of 2305*10            : ${integrate(w2305).toFixed(4)} kWh`);
    if (counterDelta !== null && counterDelta < 0.1)
        console.log('  NOTE: the counter barely moved (0.1 kWh resolution) — run longer for a'
            + ' meaningful integration check; the MAE table above is the primary evidence.');

    console.log(`\n${'='.repeat(78)}`);
    console.log('Read: H1 wins if 2727 tracks 2166 within a few percent. H2 wins if it tracks');
    console.log('2166-1027 instead (fix: sum 2727 + 1027). If 2727 is FLAT ZERO or only tracks');
    console.log('the EME 20 registers, it is accessory-derived — inconclusive here, and 2305');
    console.log('becomes the candidate. Compare against 1046 to confirm the compressor ran.');
}

socket.on('error', (error) => {
    console.error(`Socket error: ${error?.message ?? error}`);
    process.exit(1);
});

socket.connect({port: 502, host}, async () => {
    console.log(`Connected to ${host}:502 — sampling every ${intervalMs / 1000}s for ${minutes} min.`);
    console.log('The Homey app has lost its Modbus slot for the duration; it reconnects after.\n');
    const deadline = Date.now() + minutes * 60000;
    await sample();
    const timer = setInterval(async () => {
        await sample();
        if (Date.now() >= deadline) {
            clearInterval(timer);
            report();
            socket.end();
            socket.destroy();
            process.exit(0);
        }
    }, intervalMs);
});
