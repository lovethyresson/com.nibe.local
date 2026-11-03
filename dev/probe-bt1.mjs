// Maintainer tool (not shipped — see .homeyignore). Answers the M0 questions in
// docs/smart-heating-plan.md §3: is feeding the outdoor sensor (BT1) through holding 5217 a safe
// enough lever to build Smart heating on?
//
// What is already known (docs/external-sensors.md, S1155, 2026-09-11): FC6 raw 149 to 5217 moved
// input 1 from 148 to 149, the mailbox cleared to 0x8000 within ~1 s, and input 1 held the value
// for at least 30 s without a refresh. What is NOT known is everything Smart heating rests on:
//
//   0.0  Is there a readable "external BT1 enabled" flag, like input 5986 for BT50?   --watch
//   0.1  Does one write EXPIRE, and does the pump go back to the wired sensor?          --hold
//   0.2  …and across a Modbus disconnect?                                       --hold --reconnect
//   0.3  While we feed, can the PHYSICAL sensor still be read anywhere?          --find-physical
//   0.4  How fast and how far does a BT1 step move calculated supply (1017)?          --step
//   0.5  What else does a fake BT1 move (auto-stop 184/185, cooling 183, add heat)?   --step --force
//   0.7  Does a 30 s feed cadence hold for an hour without exceptions?      --step 0 --minutes 60
//   3.3  Does the gain hold far from the real temperature (±20 K, the planner's limit)? --ladder
//
//   node dev/probe-bt1.mjs [host]                              one pass: context + thresholds
//   node dev/probe-bt1.mjs --watch [--interval 5]              toggle menu 7.5.9.2 on the display
//   node dev/probe-bt1.mjs --hold -5 [--minutes 120] [--reconnect]
//   node dev/probe-bt1.mjs --find-physical [--offset -5]
//   node dev/probe-bt1.mjs --step -5 [--minutes 30]            also --step +5, --step 0
//        [--after 150] [--settle 30] [--lat 59.3 --lon 18.1] [--allow-spa] [--max-indoor 1]
//   node dev/probe-bt1.mjs --ladder -5,-10,-15,-20 [--rung 75] [--after 150] [--min-dm -600] [--tau 49]
//
// --ladder (plan §3.3) walks the offset out in rungs, --rung minutes each, then recovers. It reads
// the gain per rung with the curve's lag known (τ 49 min, §3.1), so a rung shorter than 3τ still
// says whether 1 K of fed outdoor still moves supply 0.5 K out there. Besides --step's aborts it
// stops on the immersion heater starting (1029) or degree minutes below --min-dm.
// --resume <file.json> picks up a killed ladder without settling again: {real, y0, indoor0, x, at,
// rungEnd, prev: {x, dy}} from the dead run's log, with --ladder listing the rungs still to run.
// Only valid while the pump still holds the dead run's fed value, so the curve never saw a break.
// --no-abort turns the indoor, immersion, degree-minute and held-setting aborts into WARN lines.
//
// --step is the gain/latency test (plan §3.1). Before the first write it checks SPA (843) is off,
// snapshots the settings that feed the curve, and waits until calculated supply has been flat for
// --settle minutes. During the run it aborts on a changed setting or an indoor drift past
// --max-indoor K. After --after minutes of recovery it fits a first-order response to each half.
//
// THIS WRITES TO YOUR HEAT PUMP (everything except the plain pass and --watch). It only ever
// writes the 5217 mailbox — a fake outdoor temperature — never a setting. Menu 7.5.9 (Modbus
// writes) and 7.5.9.2 (external BT1) must be on, or input 1 ignores the write and the script
// stops after the first verification. On exit, including Ctrl-C, it feeds the real temperature
// measured before the test once more. That is NOT a guaranteed return to the wired sensor — that
// is precisely what --hold measures — so if a run ends with "still held", turn 7.5.9.2 off and on
// at the display.
//
// The S1155 accepts two Modbus clients, so the Homey app keeps running alongside. Make sure no Flow
// uses "Set outdoor temperature (BT1)" during a run, or it will overwrite the fed value.

import net from 'net';
import {readFileSync} from 'fs';
import {createRequire} from 'module';

const require = createRequire(import.meta.url);
const {ModbusTCPClient} = require('jsmodbus');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const num = (n, d) => {
    const i = argv.indexOf(`--${n}`);
    if (i < 0 || argv[i + 1] === undefined || /^--[a-z]/.test(argv[i + 1])) return d;
    const v = Number(argv[i + 1]);
    if (!Number.isFinite(v)) throw new Error(`--${n} needs a number`);
    return v;
};

const host = argv.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? '10.136.1.93';
const port = num('port', 502); // only for testing against a local fake
// --sensor bt50 runs the same modes against the indoor mailbox instead (tested 2026-10-28 at the
// maintainer's request). BT50 needs the zone set to be controlled by BT50 (input 5986 = 1).
const SENSORS = {
    bt1: {mailbox: 5217, effective: 1, maxOffset: 20, confirmTries: 4, name: 'BT1 outdoor', menu: '7.5.9.2 (external BT1)'},
    bt50: {mailbox: 5987, effective: 26, fallback: 116, maxOffset: 3, confirmTries: 16, name: 'BT50 indoor', menu: '7.5.9.2 (external BT50) and zone control by BT50'},
};
const sensorName = argv[argv.indexOf('--sensor') + 1];
const SENSOR = has('sensor') ? SENSORS[sensorName] : SENSORS.bt1;
if (!SENSOR) throw new Error(`--sensor must be one of ${Object.keys(SENSORS).join(', ')}`);
const MAX_OFFSET_K = SENSOR.maxOffset;
const UNAVAILABLE = 0x8000;
const FEED_EVERY_MS = 30_000;

// Context read on every sample. All input registers are s16 ÷10 unless noted.
const SAMPLE = [
    ['input', 1, 'BT1 outdoor (input 1)', 10],
    ['input', 37, 'BT1 average (37)', 10],
    ['input', 26, 'Indoor BT50 effective (26)', 10],
    ['input', 116, 'Indoor CS1 average (116)', 10],
    ['input', 1017, 'Calculated supply (1017)', 10],
    ['input', 5, 'Supply BT2 (5)', 10],
    ['input', 1046, 'Compressor Hz (1046)', 10],
    ['input', 1028, 'Priority (1028, raw)', 1],
    ['input', 1029, 'Add heat on (1029)', 1],
];
const THRESHOLDS = [
    ['holding', 184, 'Auto-stop heating (184)', 10],
    ['holding', 185, 'Auto-stop add heat (185)', 10],
    ['holding', 183, 'Auto-start cooling (183)', 10],
    ['holding', 26, 'Heat curve (26)', 1],
    ['holding', 30, 'Curve offset (30)', 1],
    ['holding', 843, 'SPA master (843)', 1],
    ['holding', 237, 'Operating mode (237)', 1],
];
// Everything besides BT1 that feeds calculated supply and can be read. A change mid-run voids it.
const HELD = [
    ['holding', 26, 'Heat curve (26)'],
    ['holding', 30, 'Curve offset (30)'],
    ['holding', 34, 'Min supply (34)'],
    ['holding', 38, 'Max supply (38)'],
    ['holding', 237, 'Operating mode (237)'],
    ['holding', 843, 'SPA master (843)'],
];
// 0.0: where an activation flag could live. 5986 is BT50's (input); 5217 is the BT1 mailbox.
// A raw block around both, on both tables — the CSVs are not trusted for this.
const WATCH_RANGES = [['input', 5975, 6000], ['holding', 5210, 5225], ['holding', 5980, 5995]];
// 0.3: where a physical-BT1 copy could live. Input 108 (~23.4 °C, unidentified) is in here.
const PHYSICAL_RANGES = [['input', 1, 140], ['input', 1000, 1110], ['input', 5970, 6000]];

const s16 = (raw) => (raw >= 0x8000 ? raw - 0x10000 : raw);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = (t0) => `${String(Math.round((Date.now() - t0) / 1000)).padStart(5)}s`;

// The client must be constructed BEFORE the socket connects (see dev/probe-room.mjs).
function connect() {
    const socket = new net.Socket();
    const client = new ModbusTCPClient(socket, 1, 5000);
    return new Promise((resolve, reject) => {
        socket.setTimeout(10000, () => {
            socket.destroy();
            reject(new Error(`connection to ${host}:${port} timed out`));
        });
        socket.once('connect', () => {
            socket.setTimeout(0);
            resolve({socket, client});
        });
        socket.once('error', reject);
        socket.connect({port, host});
    });
}

let conn = await connect();

async function reconnect() {
    conn.socket.end();
    conn.socket.destroy();
    await sleep(1000);
    conn = await connect();
}

// The pump drops the Modbus connection now and then (twice on 2026-11-02, minutes apart). A run
// rides through that: reconnect, and only give up after a few minutes of trying.
async function reconnectPatiently(why) {
    // --no-abort keeps trying: a network blip must not end a run a person has not stopped.
    for (let i = 1; has('no-abort') || i <= 10; i++) {
        try {
            await reconnect();
            console.log(`  reconnected (${why}, attempt ${i})`);
            return true;
        } catch (e) {
            console.log(`  reconnect attempt ${i} failed: ${e.message}`);
            await sleep(15_000);
        }
    }
    return false;
}

async function readRaw(kind, address) {
    try {
        const r = kind === 'input'
            ? await conn.client.readInputRegisters(address, 1)
            : await conn.client.readHoldingRegisters(address, 1);
        return r.response.body.values[0];
    } catch {
        return undefined;
    }
}

async function readValue(kind, address, div) {
    const raw = await readRaw(kind, address);
    if (raw === undefined || raw === UNAVAILABLE) return undefined;
    return s16(raw) / div;
}

// Degree minutes: holding 11, s32 ÷10, low word first.
async function readDM() {
    try {
        const r = await conn.client.readHoldingRegisters(11, 2);
        const [lo, hi] = r.response.body.values;
        return ((hi << 16) | lo) / 10;
    } catch {
        return undefined;
    }
}

async function sample() {
    const out = {};
    for (const [kind, address, , div] of SAMPLE) {
        out[address] = await readValue(kind, address, div);
        await sleep(60);
    }
    out.dm = await readDM();
    return out;
}

const fmt = (v) => (v === undefined ? '   –  ' : String(v).padStart(6));
const sampleLine = (s) => `BT1 ${fmt(s[1])}  avg ${fmt(s[37])}  in ${fmt(s[26])}/${fmt(s[116])}  calc ${fmt(s[1017])}  `
    + `BT2 ${fmt(s[5])}  Hz ${fmt(s[1046])}  prio ${fmt(s[1028])}  add ${fmt(s[1029])}  DM ${fmt(s.dm)}`;

async function writeBT1(celsius) {
    const raw = Math.round(celsius * 10) & 0xffff;
    await conn.client.writeSingleRegister(SENSOR.mailbox, raw);
}

// The mailbox clears within ~1 s, so a feed is confirmed on input 1, never by re-reading 5217.
async function feedAndVerify(celsius) {
    await writeBT1(celsius);
    // BT50 takes seconds to reach input 26 (the app's own feed allows 16 × 750 ms).
    for (let i = 0; i < SENSOR.confirmTries; i++) {
        await sleep(750);
        const now = await readValue('input', SENSOR.effective, 10);
        if (now !== undefined && Math.abs(now - celsius) < 0.05) return true;
    }
    return false;
}

async function thresholds() {
    const t = {};
    console.log('\n=== Settings that a fake BT1 is judged against ===');
    for (const [kind, address, label, div] of THRESHOLDS) {
        t[address] = await readValue(kind, address, div);
        console.log(`  ${label.padEnd(28)} ${fmt(t[address])}`);
        await sleep(60);
    }
    return t;
}

// Refuse a fed value on the other side of a threshold from the real one, unless --force: that is
// question 0.5, and it should be asked on purpose. The thresholds act in Auto only (237 = 0,
// plan §4.1), so in Manual nothing is crossed; there the add-heat aborts stand guard.
function crossings(real, fed, t) {
    const out = [];
    if (t[237] !== undefined && t[237] !== 0) return out;
    for (const [address, label] of [[184, 'auto-stop heating'], [185, 'auto-stop add heat'], [183, 'auto-start cooling']]) {
        const v = t[address];
        if (v !== undefined && (real < v) !== (fed < v)) out.push(`${label} (${v} °C)`);
    }
    return out;
}

let restoreTo; // the real temperature measured before any write
let restoring = false;
async function restore(why) {
    if (restoreTo === undefined || restoring) return;
    restoring = true;
    try {
        const ok = await feedAndVerify(restoreTo);
        console.log(`\n[${why}] fed the pre-test ${SENSOR.name} ${restoreTo} °C once more: ${ok ? `input ${SENSOR.effective} follows` : 'NOT confirmed'}.`);
        console.log('  If the pump holds fed values (see --hold), turn menu 7.5.9.2 off and on to return to the wired sensor.');
    } catch (e) {
        console.log(`\n[${why}] restore write failed: ${e.message}. Reconnecting to try once more.`);
        try {
            if (!(await reconnectPatiently('restore'))) throw new Error('no connection');
            const ok = await feedAndVerify(restoreTo);
            console.log(`  fed ${restoreTo} °C: ${ok ? `input ${SENSOR.effective} follows` : 'NOT confirmed'}.`);
        } catch (e2) {
            console.log(`  failed again: ${e2.message}. A fed value expires within ~5 min on its own (§3.2 0.1).`);
        }
    }
}
process.on('SIGINT', async () => {
    await restore('Ctrl-C');
    process.exit(130);
});

async function startFeed(offset) {
    if (!(Math.abs(offset) <= MAX_OFFSET_K)) throw new Error(`offset must be within ±${MAX_OFFSET_K} K`);
    const t = await thresholds();
    // BT50's effective input 26 goes unavailable ~5 min after the last feed (measured
    // 2026-10-28), so fall back to the climate-system average 116, which keeps reporting.
    const real = await readValue('input', SENSOR.effective, 10)
        ?? (SENSOR.fallback === undefined ? undefined : await readValue('input', SENSOR.fallback, 10));
    if (real === undefined) throw new Error(`input ${SENSOR.effective} (${SENSOR.name}) is unavailable; nothing to offset from`);
    const fed = Math.round((real + offset) * 10) / 10;
    const crossed = SENSOR.mailbox === 5217 ? crossings(real, fed, t) : [];
    if (crossed.length && !has('force')) {
        throw new Error(`fed ${fed} °C would cross ${crossed.join(', ')} from real ${real} °C. `
            + 'Re-run with --force to test exactly that (question 0.5).');
    }
    restoreTo = real;
    console.log(`\nReal ${SENSOR.name} before the test: ${real} °C. Feeding ${fed} °C (${offset >= 0 ? '+' : ''}${offset} K).`);
    if (!(await feedAndVerify(fed))) {
        throw new Error(`input ${SENSOR.effective} did not follow the write. Is menu ${SENSOR.menu} enabled?`);
    }
    return {real, fed};
}

async function plainPass() {
    console.log(`Pump ${host}`);
    console.log(sampleLine(await sample()));
    await thresholds();
}

// 0.0 — print only registers that change. Toggle 7.5.9.2 on the display while this runs.
async function watch() {
    const intervalMs = num('interval', 5) * 1000;
    const read = async () => {
        const m = new Map();
        for (const [kind, from, to] of WATCH_RANGES) {
            for (let a = from; a <= to; a++) {
                m.set(`${kind}:${a}`, await readRaw(kind, a));
                await sleep(40);
            }
        }
        return m;
    };
    let before = await read();
    const answering = [...before].filter(([, v]) => v !== undefined);
    console.log(`Watching ${before.size} registers (${answering.length} answer). Toggle menu 7.5.9.2 now; Ctrl-C to stop.`);
    for (const [k, v] of answering) console.log(`  ${k.padEnd(14)} ${v}`);
    const t0 = Date.now();
    for (;;) {
        await sleep(intervalMs);
        const after = await read();
        for (const [k, v] of after) {
            if (v !== before.get(k)) console.log(`${stamp(t0)}  ${k.padEnd(14)} ${before.get(k)} -> ${v}`);
        }
        before = after;
    }
}

// 0.1 / 0.2 — write once, then watch whether input 1 lets go of the fed value.
async function hold(offset) {
    const minutes = num('minutes', 120);
    const viaReconnect = has('reconnect');
    const {fed} = await startFeed(offset);
    const t0 = Date.now();
    console.log(`Written once. Sampling every 30 s for ${minutes} min${viaReconnect ? ', reconnecting before each sample' : ''}.`);
    console.log('Released = input 1 no longer equals the fed value.\n');
    while (Date.now() - t0 < minutes * 60_000) {
        await sleep(30_000);
        if (viaReconnect) await reconnect();
        const s = await sample();
        const now = s[SENSOR.effective];
        const held = now !== undefined && Math.abs(now - fed) < 0.05;
        console.log(`${stamp(t0)}  ${held ? 'HELD    ' : 'RELEASED'}  ${sampleLine(s)}`);
        if (!held && now !== undefined) {
            console.log(`\nRESULT 0.1${viaReconnect ? '/0.2' : ''}: released after ~${Math.round((Date.now() - t0) / 1000)} s; input ${SENSOR.effective} now ${now} °C.`);
            restoreTo = undefined; // the wired sensor is back — do not overwrite it
            return;
        }
    }
    console.log(`\nRESULT 0.1: STILL HELD after ${minutes} min. Without a release the BT1 lever cannot ship (plan §3).`);
    await restore('still held');
}

// 0.3 — snapshot candidate ranges, feed a distinctive value, snapshot again. A register that keeps
// reading near the real temperature while input 1 shows the fed one is a physical-BT1 candidate.
async function findPhysical() {
    const offset = num('offset', -5);
    const snap = async () => {
        const m = new Map();
        for (const [kind, from, to] of PHYSICAL_RANGES) {
            for (let a = from; a <= to; a++) {
                const raw = await readRaw(kind, a);
                if (raw !== undefined && raw !== UNAVAILABLE) m.set(`${kind}:${a}`, s16(raw) / 10);
                await sleep(40);
            }
        }
        return m;
    };
    console.log('Snapshot before feeding…');
    const before = await snap();
    const {real, fed} = await startFeed(offset);
    // Keep feeding through the second snapshot, which takes longer than one feed interval.
    const keepFeeding = setInterval(() => writeBT1(fed).catch(() => {}), FEED_EVERY_MS);
    await sleep(60_000);
    console.log('Snapshot while feeding…');
    const during = await snap();
    clearInterval(keepFeeding);

    const physical = [];
    const followers = [];
    for (const [k, v0] of before) {
        const v1 = during.get(k);
        if (v1 === undefined) continue;
        // 37 is BT1's own running average: it lags a fed value by hours, so it always looks
        // "physical" over one minute. It is a consumer, not a copy.
        const lagging = k === 'input:37';
        if (!lagging && Math.abs(v0 - real) <= 1.5 && Math.abs(v1 - real) <= 1.5 && Math.abs(v1 - fed) > 1) physical.push([k, v0, v1]);
        if (Math.abs((v1 - v0) - (fed - real)) <= 1) followers.push([k, v0, v1]);
    }
    console.log(`\nReal ${real} °C, fed ${fed} °C (÷10 decode; ignore rows that are not temperatures).`);
    console.log('\nPhysical-BT1 candidates (stayed near real while input 1 showed the fed value):');
    for (const [k, a, b] of physical) console.log(`  ${k.padEnd(14)} ${a} -> ${b}`);
    if (!physical.length) console.log('  none — the real outdoor temperature must come from Homey or the forecast (plan §4.2)');
    console.log('\nRegisters that moved with the fed value (consumers of BT1):');
    for (const [k, a, b] of followers) console.log(`  ${k.padEnd(14)} ${a} -> ${b}`);
    await restore('done');
}

async function heldSnapshot() {
    const m = {};
    for (const [kind, address] of HELD) {
        m[address] = await readRaw(kind, address);
        await sleep(60);
    }
    return m;
}

// An unreadable setting is a lost connection, not a change: compare only what both reads saw.
function heldChanges(before, now) {
    return HELD.filter(([, a]) => before[a] !== undefined && now[a] !== undefined && before[a] !== now[a]).map(([, a, label]) => `${label} ${before[a]} -> ${now[a]}`);
}

// Real outdoor temperature from Open-Meteo: input 1 shows the fed value while feeding, and the
// recovery end point depends on where the real temperature went.
let omAt = 0;
let omTemp;
async function realOutdoor() {
    const lat = num('lat');
    const lon = num('lon');
    if (lat === undefined || lon === undefined) return undefined;
    if (Date.now() - omAt < 15 * 60_000) return omTemp;
    try {
        const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m`);
        omTemp = (await r.json()).current.temperature_2m;
        omAt = Date.now();
    } catch {
        // keep the last value
    }
    return omTemp;
}

// Fits y − y0 = A·(1 − e^(−t/τ)) by a grid over τ (1–300 min) with A solved by least squares.
function fitFirstOrder(points, y0) {
    let best;
    for (let tau = 60; tau <= 300 * 60; tau += 60) {
        let num_ = 0;
        let den = 0;
        for (const {t, y} of points) {
            const u = 1 - Math.exp(-t / tau);
            num_ += u * (y - y0);
            den += u * u;
        }
        if (!den) continue;
        const A = num_ / den;
        let sse = 0;
        for (const {t, y} of points) sse += (y0 + A * (1 - Math.exp(-t / tau)) - y) ** 2;
        if (!best || sse < best.sse) best = {A, tau, sse};
    }
    return best && {A: best.A, tauMin: best.tau / 60, rmse: Math.sqrt(best.sse / points.length)};
}

function phaseLine(s, om) {
    return `${sampleLine(s)}${om === undefined ? '' : `  real~ ${fmt(om)}`}`;
}

// 0.4 / 0.5 / 0.7 / §3.1 — settle, feed a constant offset at the app's cadence, then recover.
async function step(offset) {
    const minutes = num('minutes', 30);
    const afterMin = num('after', offset === 0 ? 0 : 150);
    const settleMin = num('settle', offset === 0 ? 0 : 30);
    const maxIndoor = num('max-indoor', 1);

    const held = await heldSnapshot();
    if (held[843] !== 0 && !has('allow-spa')) {
        throw new Error(`SPA (843) reads ${held[843]}. Switch it off first, or pass --allow-spa to accept it as a confounder.`);
    }
    const checkHeld = async () => {
        const changed = heldChanges(held, await heldSnapshot());
        if (changed.length) throw new Error(`ABORT: a held setting changed: ${changed.join(', ')}`);
    };

    // Settle: calculated supply must sit within 0.2 K for settleMin before anything is fed.
    const t00 = Date.now();
    const settled = [];
    if (settleMin > 0) {
        console.log(`Settling: waiting until calculated supply stays within 0.2 K for ${settleMin} min (max 120 min).`);
        for (;;) {
            const s = await sample();
            settled.push({at: Date.now(), y: s[1017]});
            console.log(`${stamp(t00)}  settle    ${phaseLine(s, await realOutdoor())}`);
            const win = settled.filter((p) => p.at >= Date.now() - settleMin * 60_000 && p.y !== undefined).map((p) => p.y);
            if (Date.now() - t00 >= settleMin * 60_000 && Math.max(...win) - Math.min(...win) <= 0.2) break;
            if (Date.now() - t00 > 120 * 60_000) throw new Error('Calculated supply did not settle within 120 min; not stepping.');
            await sleep(FEED_EVERY_MS);
        }
        await checkHeld();
    }

    // Baseline BEFORE the first write: input 1 and 1017 move within a second of it.
    const base = await sample();
    const y0 = settled.length ? settled.slice(-20).reduce((a, p) => a + (p.y ?? base[1017]), 0) / Math.min(20, settled.length) : base[1017];
    const indoor0 = base[116];
    const {fed} = await startFeed(offset);
    const om0 = await realOutdoor();
    const t0 = Date.now();
    console.log(`${stamp(t0)}  start     ${phaseLine(base, om0)}`);
    const stepPts = [];
    let failures = 0;
    let writes = 0;
    let lastHeldCheck = Date.now();
    while (Date.now() - t0 < minutes * 60_000) {
        await sleep(FEED_EVERY_MS);
        try {
            await writeBT1(fed);
            writes++;
        } catch (e) {
            failures++;
            console.log(`${stamp(t0)}  write failed: ${e.message}`);
        }
        const s = await sample();
        if (s[1017] !== undefined) stepPts.push({t: (Date.now() - t0) / 1000, y: s[1017]});
        console.log(`${stamp(t0)}  feeding   ${phaseLine(s, await realOutdoor())}`);
        if (indoor0 !== undefined && s[116] !== undefined && Math.abs(s[116] - indoor0) > maxIndoor) {
            throw new Error(`ABORT: indoor (116) moved ${indoor0} -> ${s[116]} °C, more than ${maxIndoor} K.`);
        }
        if (Date.now() - lastHeldCheck > 10 * 60_000) {
            await checkHeld();
            lastHeldCheck = Date.now();
        }
    }
    const omStepEnd = await realOutdoor();
    console.log(`\nRESULT: ${writes} writes, ${failures} failures over ${minutes} min.`);
    await restore('step done');
    restoreTo = undefined; // from here the wired sensor is in charge; nothing more to restore

    const t1 = Date.now();
    const afterPts = [];
    const yStepEnd = stepPts.at(-1)?.y;
    while (Date.now() - t1 < Math.max(afterMin, 2) * 60_000) {
        await sleep(FEED_EVERY_MS);
        const s = await sample();
        if (s[1017] !== undefined) afterPts.push({t: (Date.now() - t1) / 1000, y: s[1017]});
        console.log(`${stamp(t1)}  after     ${phaseLine(s, await realOutdoor())}`);
        if (Date.now() - lastHeldCheck > 10 * 60_000) {
            await checkHeld();
            lastHeldCheck = Date.now();
        }
    }
    await checkHeld();

    if (offset === 0 || y0 === undefined) return;
    const fitStep = fitFirstOrder(stepPts, y0);
    console.log(`\nStep from ${y0.toFixed(2)} °C: A ${fitStep.A.toFixed(2)} K, tau ${fitStep.tauMin} min, rmse ${fitStep.rmse.toFixed(2)}`
        + ` -> gain ${(fitStep.A / -offset).toFixed(2)} K supply per K colder.`);
    if (afterMin > 0 && yStepEnd !== undefined && afterPts.length) {
        const fitAfter = fitFirstOrder(afterPts, yStepEnd);
        // The recovery end point moves with the real outdoor change since the step started.
        const drift = om0 !== undefined && omStepEnd !== undefined ? omStepEnd - om0 : 0;
        const k = fitAfter.A / (offset - drift);
        console.log(`Recovery from ${yStepEnd} °C: A ${fitAfter.A.toFixed(2)} K, tau ${fitAfter.tauMin} min, rmse ${fitAfter.rmse.toFixed(2)}`
            + ` -> gain ${k.toFixed(2)} K per K (real outdoor drift ${drift.toFixed(1)} K).`);
        const gainOk = Math.abs(k - fitStep.A / -offset) <= 0.2 * Math.abs(fitStep.A / -offset);
        const tauOk = Math.abs(fitAfter.tauMin - fitStep.tauMin) <= 0.3 * fitStep.tauMin;
        console.log(`PASS criteria (plan §3.1): gains within 20 % ${gainOk ? 'yes' : 'NO'}, tau within 30 % ${tauOk ? 'yes' : 'NO'}.`);
    }
}

// §3.3 — the gain far from the real temperature: offsets in rungs, then recovery.
async function ladder(rungs) {
    const CURVE_TAU_MIN = num('tau', 49); // only a fake pump wants another
    const rungMin = num('rung', 75);
    const afterMin = num('after', 150);
    const settleMin = num('settle', 30);
    const maxIndoor = num('max-indoor', 1);
    const minDm = num('min-dm', -600);
    if (!rungs.length || rungs.some((r) => !Number.isFinite(r) || Math.abs(r) > MAX_OFFSET_K))
        throw new Error(`--ladder needs offsets within ±${MAX_OFFSET_K} K, e.g. -5,-10,-15,-20`);
    if (rungs.some((r, i) => i > 0 && Math.abs(r - rungs[i - 1]) > 5))
        throw new Error('Rungs may be at most 5 K apart: the app never jumps further than that either.');

    const held = await heldSnapshot();
    if (held[843] !== 0 && !has('allow-spa'))
        throw new Error(`SPA (843) reads ${held[843]}. Switch it off first, or pass --allow-spa.`);
    // --no-abort: a breached limit is logged once as WARN and the run carries on, so a person
    // decides whether to stop it (Ctrl-C restores) instead of losing hours of rungs to a limit.
    const warned = new Set();
    const breach = (kind, msg) => {
        if (!has('no-abort')) throw new Error(`ABORT: ${msg}`);
        if (!warned.has(kind)) console.log(`WARN: ${msg} Carrying on (--no-abort).`);
        warned.add(kind);
    };
    const checkHeld = async () => {
        const changed = heldChanges(held, await heldSnapshot());
        if (changed.length) breach('held', `a held setting changed: ${changed.join(', ')}.`);
    };
    const resume = has('resume') ? JSON.parse(readFileSync(argv[argv.indexOf('--resume') + 1], 'utf8')) : undefined;
    const t00 = Date.now();
    const settled = [];
    if (!resume) console.log(`Settling: calculated supply within 0.2 K for ${settleMin} min (max 120 min).`);
    for (; !resume;) {
        const s = await sample();
        settled.push({at: Date.now(), y: s[1017]});
        console.log(`${stamp(t00)}  settle    ${phaseLine(s, await realOutdoor())}`);
        const win = settled.filter((p) => p.at >= Date.now() - settleMin * 60_000 && p.y !== undefined).map((p) => p.y);
        if (Date.now() - t00 >= settleMin * 60_000 && Math.max(...win) - Math.min(...win) <= 0.2) break;
        if (Date.now() - t00 > 120 * 60_000) throw new Error('Calculated supply did not settle within 120 min.');
        await sleep(FEED_EVERY_MS);
    }
    await checkHeld();

    const base = await sample();
    const y0 = resume?.y0 ?? settled.slice(-20).reduce((a, p) => a + (p.y ?? base[1017]), 0) / Math.min(20, settled.length);
    const indoor0 = resume?.indoor0 ?? base[116];
    // The widest rung is checked against the thresholds up front; startFeed refuses a crossing.
    const widest = rungs.reduce((a, r) => (Math.abs(r) > Math.abs(a) ? r : a), 0);
    const t = await thresholds();
    // Resuming, input 1 still shows the dead run's fed value, not the real temperature.
    const real = resume?.real ?? await readValue('input', 1, 10);
    if (real === undefined) throw new Error('input 1 is unavailable; nothing to offset from');
    const crossed = crossings(real, real + widest, t);
    if (crossed.length && !has('force'))
        throw new Error(`the ${widest} K rung would cross ${crossed.join(', ')} from real ${real} °C. Pick a day where it doesn't, or --force.`);
    restoreTo = real;
    const t0 = Date.now();
    const points = [];
    let x = resume?.x ?? 0; // the curve's filtered view of the offset
    let last = resume?.at ?? t0;
    let writes = 0, failures = 0, lastHeldCheck = Date.now();
    for (const offset of rungs) {
        const fed = Math.round((real + offset) * 10) / 10;
        const end = offset === rungs[0] && resume ? resume.rungEnd : undefined;
        console.log(`\nRung ${offset >= 0 ? '+' : ''}${offset} K: feeding ${fed} °C for ${end ? `the rest, until ${new Date(end).toLocaleTimeString()}` : `${rungMin} min`}.`);
        if (!(await feedAndVerify(fed))) throw new Error('input 1 did not follow the write. Is menu 7.5.9.2 enabled?');
        const tr = Date.now();
        while (Date.now() < (end ?? tr + rungMin * 60_000)) {
            await sleep(FEED_EVERY_MS);
            try { await writeBT1(fed); writes++; } catch (e) {
                failures++;
                console.log(`${stamp(t0)}  write failed: ${e.message}`);
                if (!(await reconnectPatiently('write failed'))) throw new Error('ABORT: the pump stayed unreachable.');
                await feedAndVerify(fed);
            }
            const s = await sample();
            const now = Date.now();
            x = offset + (x - offset) * Math.exp(-(now - last) / 60_000 / CURVE_TAU_MIN);
            last = now;
            if (s[1017] !== undefined) points.push({rung: offset, x, dy: s[1017] - y0, at: now});
            console.log(`${stamp(t0)}  ${String(offset).padStart(4)} K   ${phaseLine(s, await realOutdoor())}  x ${x.toFixed(1)}`);
            if (indoor0 !== undefined && s[116] !== undefined && Math.abs(s[116] - indoor0) > maxIndoor)
                breach('indoor', `indoor (116) moved ${indoor0} -> ${s[116]} °C, more than ${maxIndoor} K.`);
            if (s[1029] === 1) breach('immersion', 'the immersion heater started (1029). That rung is too deep for this house today.');
            if (s.dm !== undefined && s.dm < minDm) breach('dm', `degree minutes ${s.dm} below ${minDm}.`);
            if (Date.now() - lastHeldCheck > 10 * 60_000) { await checkHeld(); lastHeldCheck = Date.now(); }
        }
    }
    console.log(`\nRESULT: ${writes} writes, ${failures} failures.`);
    await restore('ladder done');
    restoreTo = undefined;

    // Gain per rung: change in supply over change in the filtered offset, last 10 min of each rung
    // against the last 10 min of the one before (or the settled start). Supply per K colder, so
    // the sign matches §3.1's 0.5.
    const tail = (rung) => {
        const pts = points.filter((p) => p.rung === rung);
        const end = pts.at(-1)?.at ?? 0;
        const last10 = pts.filter((p) => p.at >= end - 10 * 60_000);
        return {x: last10.reduce((a, p) => a + p.x, 0) / last10.length, dy: last10.reduce((a, p) => a + p.dy, 0) / last10.length};
    };
    let prev = resume?.prev ?? {x: 0, dy: 0};
    console.log('\nGain per rung (K supply per K colder; §3.1 measured 0.50 at ±5 K):');
    for (const rung of rungs) {
        const now = tail(rung);
        const gain = -(now.dy - prev.dy) / (now.x - prev.x);
        console.log(`  ${String(rung).padStart(4)} K: curve saw ${now.x.toFixed(1)} K, supply ${now.dy >= 0 ? '+' : ''}${now.dy.toFixed(1)} K, `
            + `gain over this rung ${gain.toFixed(2)}`);
        prev = now;
    }
    const sxx = points.reduce((a, p) => a + p.x * p.x, 0);
    console.log(`  Whole ladder, one gain through the origin: ${(-points.reduce((a, p) => a + p.x * p.dy, 0) / sxx).toFixed(2)}.`);
    console.log('  Pass (plan §3.3): every rung within 20 % of 0.50, or the planner\'s bias limit is cut to the last rung that is.');

    const t1 = Date.now();
    while (Date.now() - t1 < afterMin * 60_000) {
        await sleep(FEED_EVERY_MS);
        console.log(`${stamp(t1)}  after     ${phaseLine(await sample(), await realOutdoor())}`);
        if (Date.now() - lastHeldCheck > 10 * 60_000) { await checkHeld(); lastHeldCheck = Date.now(); }
    }
}

try {
    if (has('watch')) await watch();
    else if (has('ladder')) await ladder(String(argv[argv.indexOf('--ladder') + 1] ?? '').split(',').map(Number));
    else if (has('hold')) await hold(num('hold', -5));
    else if (has('find-physical')) await findPhysical();
    else if (has('step')) await step(num('step', -5));
    else await plainPass();
} catch (e) {
    console.error(`\n${e.message}`);
    await restore('error');
    process.exitCode = 1;
} finally {
    conn.socket.end();
    conn.socket.destroy();
}
