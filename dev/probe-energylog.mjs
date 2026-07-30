// Maintainer tool (not shipped — see .homeyignore). Answers one question: what does Nibe's
// "Energy log" block (2283-2305) actually mean, and can it replace the priority allocator?
//
// Why this matters. On models with no register 2166 (S320/S325, S330/S332, S2125) the energy
// allocator falls back to 2305, the energy log's *averaged* power reading. Over a whole run
// its integral matches 2166 within ~1.4%, so a pump's TOTAL comes out right — which is why a
// user reports Main agreeing with MyUplink. But the allocator charges each poll to whichever
// function the priority register named at that instant, and an averaged signal still carries
// the previous function's power for a minute or two after a switch. Total preserved, split
// skewed. That is exactly the reported symptom: Main correct, hot water and cooling well off.
//
// The pump computes the split itself:
//     2283/2285/2287/2289  produced energy per function, "over the past hour"
//     2291/2293/2295/2297  used energy per function
//     2299/2301/2303       used by the additional heater, per function
// If those are usable, the allocator, the lag and the priority mapping all stop mattering on
// every model — the pump's own attribution replaces our estimate.
//
// "Over the past hour" is not defined anywhere we can find, and it could be three things:
//     bucket    resets at the top of each hour and climbs within it  (sawtooth)
//     rolling   a true trailing-60-minute window                     (smooth wander)
//     previous  last completed hour's total, static until it steps   (staircase)
// Only the first and third are safely usable as a delta source. This script classifies them
// by watching across at least one hour boundary, then checks whether the per-function numbers
// actually decompose the pump's own total counter (3823) — the test that decides everything.
//
// Run for at least 90 minutes so it spans a :00 boundary, ideally across a hot-water cycle.
// The pump accepts a single Modbus client, so the Homey app loses its connection meanwhile.
//
//   node dev/probe-energylog.mjs [host] [--minutes 90] [--interval 30]

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
const minutes = flag('minutes', 90);
const intervalMs = flag('interval', 30) * 1000;

// `log` marks the energy-log registers under investigation. `ref` are the trusted references
// they are checked against: the pump's own lifetime counters and the instantaneous draw.
const REGS = [
    {addr: 1028, name: 'Priority',                    size: 16, div: 1,   kind: 'ctx'},
    {addr: 1046, name: 'Compressor frequency',        size: 16, div: 10,  kind: 'ctx', unit: 'Hz'},
    {addr: 2166, name: 'Instantaneous used power',    size: 32, div: 1,   kind: 'ctx', unit: 'W'},
    {addr: 2305, name: 'Energy log - current power',  size: 32, div: 100, kind: 'ctx', unit: 'kW'},

    {addr: 2283, name: 'produced heating',            size: 32, div: 100, kind: 'log', role: 'heating',  flow: 'produced'},
    {addr: 2285, name: 'produced hot water',          size: 32, div: 100, kind: 'log', role: 'hotwater', flow: 'produced'},
    {addr: 2287, name: 'produced pool',               size: 32, div: 100, kind: 'log', role: 'pool',     flow: 'produced'},
    {addr: 2289, name: 'produced cooling',            size: 32, div: 100, kind: 'log', role: 'cooling',  flow: 'produced'},

    {addr: 2291, name: 'used heating',                size: 32, div: 100, kind: 'log', role: 'heating',  flow: 'used'},
    {addr: 2293, name: 'used hot water',              size: 32, div: 100, kind: 'log', role: 'hotwater', flow: 'used'},
    {addr: 2295, name: 'used pool',                   size: 32, div: 100, kind: 'log', role: 'pool',     flow: 'used'},
    {addr: 2297, name: 'used cooling',                size: 32, div: 100, kind: 'log', role: 'cooling',  flow: 'used'},

    {addr: 2299, name: 'used add.heat heating',       size: 32, div: 100, kind: 'log', role: 'heating',  flow: 'used'},
    {addr: 2301, name: 'used add.heat hot water',     size: 32, div: 100, kind: 'log', role: 'hotwater', flow: 'used'},
    {addr: 2303, name: 'used add.heat pool',          size: 32, div: 100, kind: 'log', role: 'pool',     flow: 'used'},

    {addr: 3821, name: 'Tot. production (lifetime)',  size: 32, div: 10,  kind: 'ref', unit: 'kWh'},
    {addr: 3823, name: 'Tot. consumption (lifetime)', size: 32, div: 10,  kind: 'ref', unit: 'kWh'}
];

// Mirrors lib/registers.ts.
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
        const values = resp.response.body.values;
        const raw = combineRaw(values, reg.size);
        if (raw === undefined || Number.isNaN(raw) || isUnavailable(raw, reg.size))
            return undefined;
        return signedValue(raw, reg.size) / reg.div;
    } catch {
        return undefined;
    }
}

const samples = [];   // {t, v: {addr -> scaled|undefined}}

async function sample() {
    const v = {};
    for (const reg of REGS)
        v[reg.addr] = await read(reg);
    const at = new Date();
    samples.push({t: at.getTime(), v});
    const shown = [1028, 2166, 2305, 2291, 2293, 2297]
        .map((a) => `${a}=${v[a] === undefined ? '—' : v[a]}`).join('  ');
    console.log(`${at.toISOString().slice(11, 19)}  ${shown}`);
}

const logRegs = () => REGS.filter((r) => r.kind === 'log');
const series = (addr) => samples.map((s) => s.v[addr]).filter((x) => x !== undefined);

// Classify one energy-log register from its shape over the window.
function classify(reg) {
    const points = samples.filter((s) => s.v[reg.addr] !== undefined);
    if (points.length < 3)
        return {verdict: 'no data', detail: `${points.length} reading(s)`};
    const values = points.map((p) => p.v[reg.addr]);
    if (values.every((x) => x === 0))
        return {verdict: 'flat zero', detail: 'never left 0 — this function did not run, or is not wired up'};

    // A change at :00 (or the sample either side of it) is a step to a new hour. A change
    // anywhere else means the value is moving *during* the hour. That distinction is the whole
    // question: both a bucket and a previous-hour report step at the top of the hour, but only
    // a bucket also climbs in between, and only a bucket can be differenced per poll.
    const atBoundary = (d) => d.getMinutes() <= 1 || d.getMinutes() >= 59;
    const drops = [];
    let midHourChanges = 0;
    let boundaryChanges = 0;
    for (let i = 1; i < points.length; ++i) {
        const delta = values[i] - values[i - 1];
        const at = new Date(points[i].t);
        if (delta < -1e-9) drops.push({at, from: values[i - 1], to: values[i]});
        if (Math.abs(delta) > 1e-9)
            atBoundary(at) ? boundaryChanges++ : midHourChanges++;
    }
    const dropMinutes = drops.map((d) => d.at.getMinutes());
    const offHourDrops = drops.filter((d) => !atBoundary(d.at)).length;

    if (offHourDrops > 0)
        return {
            verdict: 'ROLLING or irregular',
            detail: `${offHourDrops} of ${drops.length} drop(s) away from :00 `
                + `(minutes [${[...new Set(dropMinutes)].join(', ')}]) — a trailing window, NOT safe to difference`
        };
    if (boundaryChanges === 0 && midHourChanges === 0)
        return {verdict: 'static', detail: 'never changed — window too short, or this function did not run'};
    if (midHourChanges === 0)
        return {
            verdict: 'PREVIOUS HOUR (steps at :00, static in between)',
            detail: `${boundaryChanges} step(s) at the hour, ${midHourChanges} change(s) in between —`
                + ` the value shown during hour H is the total for hour H-1. Exact, but reported`
                + ` once an hour and up to an hour late. Count it when it steps; never difference it.`
        };
    return {
        verdict: 'BUCKET (accumulates, resets at :00)',
        detail: `${midHourChanges} change(s) during the hour and ${boundaryChanges} at the boundary —`
            + ` climbs within the hour, so it can be differenced each poll for near-live attribution`
    };
}

// The decisive test: do the per-function figures add up to the pump's own totals?
//
// This MUST be aligned to whole hours. The energy log reports hour H-1 during hour H, so
// comparing "everything the log reported during the window" against "the lifetime counter's
// movement across the window" mixes two different spans: the first report covers time before
// sampling began, and the final part-hour is not reported yet. Doing it naively produces a
// few percent of pure artefact and makes an exact source look inaccurate.
//
// So: for each hour fully contained in the sampling window, compare the values the log
// published at its end against the lifetime counters' movement across exactly that hour.
function decomposition() {
    const hourKey = (t) => Math.floor(t / 3600000);
    const atOrAfter = (t) => samples.find((s) => s.t >= t);
    const rows = [];
    const hours = [...new Set(samples.map((s) => hourKey(s.t)))].sort();
    for (const h of hours) {
        const start = atOrAfter(h * 3600000);
        const end = atOrAfter((h + 1) * 3600000);
        // Need a reading at both ends, and the log's report for this hour lands at its end.
        if (!start || !end || start.v[3823] === undefined || end.v[3823] === undefined)
            continue;
        const sumAt = (sample, flow) => logRegs()
            .filter((r) => r.flow === flow && sample.v[r.addr] !== undefined)
            .reduce((acc, r) => acc + sample.v[r.addr], 0);
        rows.push({
            hour: new Date(h * 3600000).toISOString().slice(11, 16),
            refUsed: end.v[3823] - start.v[3823],
            refProduced: (end.v[3821] ?? 0) - (start.v[3821] ?? 0),
            logUsed: sumAt(end, 'used'),
            logProduced: sumAt(end, 'produced')
        });
    }
    return rows;
}

function report() {
    const spanH = samples.length > 1 ? (samples[samples.length - 1].t - samples[0].t) / 3600000 : 0;
    const boundaries = new Set(samples.map((s) => new Date(s.t).getHours())).size - 1;
    console.log(`\n${'='.repeat(80)}`);
    console.log(`Samples: ${samples.length} over ${spanH.toFixed(2)} h, crossing ${boundaries} hour boundary/ies\n`);

    console.log('--- Availability -------------------------------------------------------------');
    for (const reg of REGS) {
        const vals = series(reg.addr);
        const state = vals.length === 0 ? 'NEVER READ'
            : `${Math.min(...vals)} .. ${Math.max(...vals)} ${reg.unit ?? 'kWh'}`;
        console.log(`  ${String(reg.addr).padEnd(6)} ${reg.name.padEnd(30)} `
            + `${String(vals.length).padStart(3)}/${samples.length}  ${state}`);
    }

    console.log('\n--- What the energy-log registers are ----------------------------------------');
    if (boundaries === 0)
        console.log('  !! The window did not cross a :00 boundary — a bucket cannot be told from a\n'
            + '     counter here. Re-run with --minutes 90 or more.\n');
    for (const reg of logRegs()) {
        const {verdict, detail} = classify(reg);
        console.log(`  ${String(reg.addr).padEnd(6)} ${reg.name.padEnd(24)} ${verdict}`);
        console.log(`         ${detail}`);
    }

    console.log('\n--- Do the per-function figures decompose the pump total? ---------------------');
    console.log('    (whole hours only — see decomposition(); a part-hour comparison is meaningless)');
    const rows = decomposition();
    if (!rows.length) {
        console.log('  no complete hour inside the sampling window — run longer');
    } else {
        const pct = (a, b) => (b > 0 ? `${(((a - b) / b) * 100).toFixed(1)}%` : 'n/a');
        for (const r of rows) {
            console.log(`  hour ${r.hour}  used     : log ${r.logUsed.toFixed(2)} kWh  vs  3823 delta `
                + `${r.refUsed.toFixed(2)} kWh  (${pct(r.logUsed, r.refUsed)})`);
            console.log(`             produced : log ${r.logProduced.toFixed(2)} kWh  vs  3821 delta `
                + `${r.refProduced.toFixed(2)} kWh  (${pct(r.logProduced, r.refProduced)})`);
            if (r.refUsed < 0.15)
                console.log('             (counter moved less than its 0.1 kWh resolution — weak evidence)');
        }
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log('Read: if every "used" register is a BUCKET resetting on the hour AND the sums');
    console.log('match 3823 within a few percent, the pump is doing the attribution for us and');
    console.log('the priority allocator can be replaced on every model that has this block.');
    console.log('If they are ROLLING, they cannot be differenced and the allocator stays — in');
    console.log('which case the fix for the lag is to reduce the poll interval or to hold off');
    console.log('attribution for a beat after a priority change.');
}

socket.on('error', (error) => {
    console.error(`Socket error: ${error?.message ?? error}`);
    process.exit(1);
});

socket.connect({port: 502, host}, async () => {
    console.log(`Connected to ${host}:502 — sampling every ${intervalMs / 1000}s for ${minutes} min.`);
    console.log('The Homey app has lost its Modbus slot for the duration; it reconnects after.');
    console.log('Needs to span a :00 boundary to classify the registers.\n');
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
