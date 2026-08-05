// Maintainer tool (not shipped — see .homeyignore). Answers one question: should per-function
// energy be integrated from 2166 or from 2305?
//
// The app integrates register 2166 "Instantaneous used power" and charges each interval to
// whichever function the priority register (1028) named at that moment. 2305 "Energy log -
// current power consumption" is the fallback used on models with no 2166 (S320/S325, S330/S332,
// S2125) — and it exists as an input register on ALL six S-series model maps, so it could
// equally be the primary everywhere.
//
// Measured on an S1155 over two forced hot-water cycles (2026-08-03), against the pump's own
// hourly books:
//
//     hour    pump      2166               2305
//     05:00   2.460     2.378  (-3.3%)     2.460  (0.0%)
//     15:00   1.410     1.370  (-2.9%)     1.421  (+0.8%)
//
// 2305 tracks the pump's own accounting better. Two open doubts this script exists to settle:
//
//   1. n=2, on one pump. Does it hold on a second model?
//   2. Both cycles were standby -> hot water -> standby. A function-to-function switch
//      (heating -> hot water), where the compressor never stops, is the case where a lagged
//      power signal should smear worst — and it is completely untested. An exhaust-air model
//      (S735) runs heating year-round, so it can produce that transition in summer.
//
// What it does: polls priority + both power registers, integrates each with the same trapezoid
// and the same attribution the app uses, and at every :00 prints what each source would have
// credited per function beside the figure the pump booked itself.
//
// The pump accepts a single Modbus client, so the running Homey app loses its connection while
// this runs (it reconnects by itself afterwards).
//
//   node dev/probe-power-split.mjs [host] [--hours 4] [--interval 5]

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
const hours = flag('hours', 4);
const intervalMs = flag('interval', 5) * 1000;

// Priority code -> role, mirroring drivers/nibe_s/profile.ts. 10 is "no function" = standby.
const PRIORITY_TO_ROLE = {10: 'standby', 20: 'hotwater', 30: 'heating', 40: 'pool', 60: 'cooling'};

const CTX = [
    {addr: 1028, name: 'priority',            size: 16, div: 1},
    {addr: 2166, name: '2166',                size: 32, div: 1},    // W
    {addr: 2305, name: '2305',                size: 32, div: 100},  // kW -> W below
    {addr: 1046, name: 'compressor Hz',       size: 16, div: 10},
    {addr: 1100, name: 'compressor on',       size: 16, div: 1}
];

// The pump's own per-function books. Each holds the PREVIOUS completed hour and steps at :00.
const LOG = [
    {addr: 2291, role: 'heating',  flow: 'used'},
    {addr: 2299, role: 'heating',  flow: 'used'},   // additional heat, still electricity
    {addr: 2293, role: 'hotwater', flow: 'used'},
    {addr: 2301, role: 'hotwater', flow: 'used'},
    {addr: 2295, role: 'pool',     flow: 'used'},
    {addr: 2303, role: 'pool',     flow: 'used'},
    {addr: 2297, role: 'cooling',  flow: 'used'}
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
        const raw = combineRaw(resp.response.body.values, reg.size);
        if (raw === undefined || Number.isNaN(raw) || isUnavailable(raw, reg.size))
            return undefined;
        return signedValue(raw, reg.size) / (reg.div ?? 1);
    } catch {
        return undefined;
    }
}

// Per-source, per-role kWh for the hour in progress.
const acc = {2166: {}, 2305: {}};
const add = (src, role, kwh) => { acc[src][role] = (acc[src][role] ?? 0) + kwh; };
const last = {2166: null, 2305: null, t: null};
const lastLog = new Map();
let logBaselined = false;
let firstStepSeen = false;
let lastRole = null;
// UTC hour of the last summary. A value *change* is the precise trigger — it fires exactly
// when the pump publishes — but two consecutive hours can book identical figures (a quiet
// night books 0 to everything), and then nothing changes, nothing fires, and the accumulators
// run into the next hour while the pump's figure still describes one. Reported by halderex,
// who lost 3 of 9 hours to it. Clock rollover is the safety net.
let lastReportedHour = null;

function integrate(nowWatts, src, role, dtHours) {
    const previous = last[src];
    if (nowWatts === undefined) {          // a gap must not be integrated across
        last[src] = null;
        return;
    }
    if (previous !== null && role)
        add(src, role, ((previous + nowWatts) / 2) * dtHours / 1000);
    last[src] = nowWatts;
}

function reportHour(stepped = true) {
    const perRole = {};
    for (const reg of LOG) {
        const value = lastLog.get(reg.addr);
        if (value !== undefined)
            perRole[reg.role] = (perRole[reg.role] ?? 0) + value;
    }
    const hour = new Date().toISOString().slice(11, 13) + ':00';
    console.log(`\n===== hour ending ${hour} UTC =====`
        + (stepped ? '' : '   (figures unchanged from the previous hour)'));
    const roles = new Set([...Object.keys(perRole), ...Object.keys(acc[2166]), ...Object.keys(acc[2305])]);
    for (const role of roles) {
        const pump = perRole[role];
        const a = acc[2166][role] ?? 0;
        const b = acc[2305][role] ?? 0;
        if (pump === undefined) {
            // The pump's log has no "standby" line, so there is nothing to score against
            // directly — but that does NOT mean the energy is unaccounted for. On an
            // exhaust-air model the continuous fan draw is booked under *heating*, which is
            // why an idle hour there shows heating at 0.05-0.06 kWh while we book it here.
            // Compare this against the heating row above before calling it unattributed.
            console.log(`  ${role.padEnd(9)} pump —      2166 ${a.toFixed(3)}  2305 ${b.toFixed(3)}  `
                + `(no standby line in the pump's log — check the heating row)`);
            continue;
        }
        const off = (ours) => (pump === 0
            ? (ours < 0.005 ? 'exact' : 'pump booked 0')
            : `${(((ours - pump) / pump) * 100).toFixed(1)}%`.padStart(7));
        console.log(`  ${role.padEnd(9)} pump ${pump.toFixed(3)}  `
            + `2166 ${a.toFixed(3)} (${off(a)})  2305 ${b.toFixed(3)} (${off(b)})`);
    }
    console.log('');
    acc[2166] = {};
    acc[2305] = {};
}

async function sample() {
    const v = {};
    for (const reg of CTX)
        v[reg.addr] = await read(reg);
    // 2305 is documented in kW/100; the app scales it to watts the same way.
    const watts2305 = v[2305] === undefined ? undefined : v[2305] * 1000;
    const watts2166 = v[2166];

    const now = Date.now();
    const dtHours = last.t === null ? 0 : (now - last.t) / 3600000;
    last.t = now;

    const role = PRIORITY_TO_ROLE[v[1028]] ?? 'standby';
    if (dtHours > 0) {
        integrate(watts2166, 2166, role, dtHours);
        integrate(watts2305, 2305, role, dtHours);
    } else {
        last[2166] = watts2166 ?? null;
        last[2305] = watts2305 ?? null;
    }

    const at = new Date();
    const flip = role !== lastRole ? `  <-- ${lastRole} -> ${role}` : '';
    lastRole = role;
    console.log(`${at.toISOString().slice(11, 19)}  prio=${v[1028]} ${role.padEnd(9)}`
        + ` 2166=${watts2166 ?? '—'}W  2305=${watts2305 === undefined ? '—' : Math.round(watts2305)}W`
        + `  Hz=${v[1046] ?? '—'} comp=${v[1100] ?? '—'}${flip}`);

    // Watch the pump's books for their :00 step.
    let stepped = false;
    for (const reg of LOG) {
        const value = await read({...reg, size: 32, div: 100});
        if (value === undefined)
            continue;
        const previous = lastLog.get(reg.addr);
        lastLog.set(reg.addr, value);
        if (previous !== undefined && value !== previous)
            stepped = true;
    }
    const nowDate = new Date();
    const nowHour = nowDate.getUTCHours();
    const rolled = lastReportedHour !== null
        && nowHour !== lastReportedHour
        && nowDate.getUTCMinutes() >= 1;

    if (!logBaselined) {
        logBaselined = true;
        lastReportedHour = nowHour;
        return;
    }
    if ((stepped || rolled) && !firstStepSeen) {
        // The first step covers an hour this script only saw part of, so it cannot be compared.
        // Use it to align on a real boundary; every hour after this one is whole.
        firstStepSeen = true;
        lastReportedHour = nowHour;
        acc[2166] = {};
        acc[2305] = {};
        console.log('\n--- aligned on a real :00 boundary; full hours follow ---\n');
        return;
    }
    if (stepped || rolled) {
        lastReportedHour = nowHour;
        reportHour(stepped);
    }
}

socket.on('error', (error) => {
    console.error('socket error:', error.message);
    process.exit(1);
});

socket.connect({host, port: 502}, async () => {
    console.log(`Connected to ${host}. Sampling every ${intervalMs / 1000}s for ${hours}h.`);
    console.log('Force a hot water cycle, and if the pump runs heating too, let it switch '
        + 'between them — that transition is the interesting one.\n');
    const until = Date.now() + hours * 3600000;
    while (Date.now() < until) {
        await sample();
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    console.log('\nDone.');
    socket.end();
    socket.destroy();
    process.exit(0);
});
