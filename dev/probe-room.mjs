// Maintainer tool (not shipped — see .homeyignore). Answers one question: which registers
// actually carry the indoor temperature and its setpoint on this pump?
//
// Two things are being settled, and the second is the reason this exists at all.
//
// (1) WHICH REGISTER IS "INDOOR TEMPERATURE". The app reads input 111 as BT50 today, with 26
//     as an alternate. All six of Nibe's model CSVs say 111 is "Room average temp. clim.
//     system 6" and that climate system *1* is at 116 — while 26 is a different quantity
//     again ("Roomsensor 1-1", an individual sensor rather than the system average). On a
//     one-climate-system house several of these can read plausibly at once, so only the pump
//     can say which is the real regulating value.
//
// (2) WHICH REGISTER IS THE SETPOINT, AND WHAT ITS RANGE REALLY IS. The CSVs list holding 206
//     "Room sensor set point value climate system 1" as 50..300 (5.0..30.0 °C) and holding 55
//     "External adjustment with room sensor climate system 1" identically. Set a distinctive
//     temperature in the myUplink app first and run this: whichever register echoes it is the
//     one to write, and if it echoes a value outside 50..300 then the documented range is
//     wrong and the app must not clamp to it.
//
// --watch is the strongest evidence: leave it running, change the temperature in the myUplink
// app, and it prints only the registers that moved. A register that follows the app is the
// register the app is writing.
//
// The pump accepts a single Modbus client, so the running Homey app loses its connection while
// this runs (it reconnects by itself afterwards).
//
// --write settles a different question: does the pump ACCEPT a Modbus write to the zone setpoint,
// and by which function code? The app writes 32-bit registers with FC16 (write multiple), because
// the low word alone would leave the high word behind. If the pump only honours FC6 (write single)
// there, the write throws, Homey reverts the capability, and the setpoint appears to "snap back"
// to its old value with no obvious error. This tries FC6 and FC16 in turn and reports which took.
//
//   THIS WRITES TO YOUR HEAT PUMP. It sets the zone 1 indoor setpoint to the value you give and
//   leaves it there — it does not restore the previous value, because a failed restore would be
//   worse than a known one. Note down your current setting first.
//
//   node dev/probe-room.mjs [host] [--watch] [--interval 10] [--expect 35]
//   node dev/probe-room.mjs --write 21.5                              # zone 1 setpoint (2505)
//   node dev/probe-room.mjs --register 66 --width 16 --divisor 1 --write 27   # harmless control
//   node dev/probe-room.mjs --register 843 --width 16 --divisor 1 --write 0   # SPA off
//   node dev/probe-room.mjs --scan 5960 6010                           # find undocumented ones
//
// Establish a control FIRST. If a register the app already writes successfully (heat curve, 26)
// reports TOOK while 2505 reports ACKED BUT DISCARDED, then Modbus writes work on this pump and
// 2505 specifically is protected. If the control is also discarded, the problem is broader.

import net from 'net';
import {createRequire} from 'module';

const require = createRequire(import.meta.url);
const {ModbusTCPClient} = require('jsmodbus');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? Number(argv[i + 1]) : fallback;
};
const host = argv.find((a) => !a.startsWith('--') && !/^\d+(\.\d+)?$/.test(a)) ?? '10.136.1.93';
const watch = argv.includes('--watch');
const intervalMs = flag('interval', 10) * 1000;
// The temperature you set in the myUplink app before running, so a matching register can be
// called out by name instead of you having to scan the column.
const expect = flag('expect', undefined);
// Value in °C to write, and which holding register to write it to. Defaults to the zone 1
// setpoint. 2505 turned out to ACK writes and discard them (see the header), so being able to
// point this at 206, 55 or anything else without editing the file is the whole point.
const write = flag('write', undefined);
const target = flag('register', 2505);
// --scan FROM TO reads every holding register in a range, whether or not the CSV lists it.
// probe-sweep.mjs can't do this: it walks the model CSV, so a register the export predates is
// invisible to it — which is exactly the situation for the external-sensor family added in
// firmware 2.22.12. The three outcomes are all meaningful and must stay distinct:
//   value      the register exists and carries data
//   sentinel   the register EXISTS but is empty — this is how an unfed "external reading of
//              value X" register answers, and it is NOT the same as absent
//   exception  the register is not implemented on this model
const scanFrom = flag('scan', undefined);
const scanTo = (() => {
    const i = argv.indexOf('--scan');
    return i >= 0 && argv[i + 2] && !argv[i + 2].startsWith('--') ? Number(argv[i + 2]) : undefined;
})();
const width = flag('width', target === 2505 ? 32 : 16);
const divisor = flag('divisor', 10);

// address, label, divisor. Everything here is a single 16-bit word.
const INPUT = [
    [1,   'Outdoor temp BT1 — sanity check',              10],
    [26,  'Roomsensor 1-1 (individual sensor)',           10],
    [25,  'Roomsensor 2-1',                               10],
    [24,  'Roomsensor 3-1',                               10],
    [116, 'Room avg clim.system 1  <- CSV says this is CS1', 10],
    [115, 'Room avg clim.system 2',                       10],
    [114, 'Room avg clim.system 3',                       10],
    [113, 'Room avg clim.system 4',                       10],
    [112, 'Room avg clim.system 5',                       10],
    [111, 'Room avg clim.system 6  <- what the app reads today', 10],
    [110, 'Room avg clim.system 7',                       10],
    [109, 'Room avg clim.system 8',                       10],
];

const HOLDING = [
    [206,  'Room sensor set point CS1  <- candidate write target', 10],
    [205,  'Room sensor set point CS2',                     10],
    [204,  'Room sensor set point CS3',                     10],
    [203,  'Room sensor set point CS4',                     10],
    [55,   'External adjustment w/ room sensor CS1',        10],
    [54,   'External adjustment w/ room sensor CS2',        10],
    [53,   'External adjustment w/ room sensor CS3',        10],
    [202,  'Use room sensor CS1',                            1],
    [201,  'Use room sensor CS2',                            1],
    [200,  'Use room sensor CS3',                            1],
    [199,  'Use room sensor CS4',                            1],
    [210,  'Room sensor factor CS1',                        10],
    [209,  'Room sensor factor CS2',                        10],
    [208,  'Room sensor factor CS3',                        10],
    [207,  'Room sensor factor CS4',                        10],
    [1102, 'Smart home room control',                        1],
    [19,   'Holiday function status',                        1],
    [26,   'Heating curve CS1 — sanity check',               1],
    // Feeding a room temperature INTO the pump. Nibe added this family in firmware 2.22.12
    // (2023-08-30) and Home Assistant uses it on the SMO S40 from FW 4.2.4: write 1 to the
    // "activated" register, then the temperature to the one after it, and the pump treats it as
    // BT50. The S1156/S1256 CSV lists 5986/5987 for BT50; the S1155/S1255 export predates the
    // feature and lists only the BT68/BT69 pair at 6003-6006 — which is why 6003 is read here as
    // a control. If 6003 answers and 5986 excepts, the family exists but not for BT50.
    [5986, 'External reading of BT50 activated (S1156 CSV)',  1],
    [5987, 'External reading of value BT50 (S1156 CSV)',     10],
    [6003, 'External reading of BT68 activated — control',    1],
    [6004, 'External reading of value BT68 — control',       10],
];

const SENTINEL = 0x8000;

// Decoded value, or undefined when the register carried nothing. Matches the app's own
// handling: the not-available sentinel is an absence, not a reading of -32768.
function decode(raw, div) {
    if (raw === undefined || raw === SENTINEL)
        return undefined;
    const signed = raw >= 32768 ? raw - 65536 : raw;
    return signed / div;
}

function format(raw, div) {
    if (raw === undefined)
        return 'no value in response';
    if (raw === SENTINEL)
        return 'UNAVAILABLE (sentinel 0x8000)';
    const value = decode(raw, div);
    return `${String(value).padStart(8)}   (raw ${raw})`;
}

// The client must be constructed BEFORE the socket connects: jsmodbus marks itself online off
// the socket's own 'connect' event, so a client built after that event has already fired stays
// offline forever and every read fails with "no connection to modbus server" on a socket that is
// demonstrably open. lib/detection.ts:201 has the same ordering for the same reason.
function connect() {
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

async function readOne(client, kind, address) {
    const read = kind === 'input'
        ? client.readInputRegisters(address, 1)
        : client.readHoldingRegisters(address, 1);
    try {
        const response = await read;
        return {raw: response.response.body.values[0]};
    } catch (error) {
        // A model that doesn't implement the address answers with a Modbus exception rather
        // than the sentinel, which is a different fact and worth keeping distinct.
        const body = error?.response?.body;
        return {error: body ? JSON.stringify(body) : (error?.message ?? String(error))};
    }
}

async function pass(client) {
    const results = {};
    for (const [kind, list] of [['input', INPUT], ['holding', HOLDING]]) {
        for (const [address, , div] of list) {
            const key = `${kind}:${address}`;
            const {raw, error} = await readOne(client, kind, address);
            results[key] = {raw, error, value: decode(raw, div)};
            await new Promise((resolve) => setTimeout(resolve, 70));
        }
    }
    return results;
}

function report(results) {
    for (const [kind, list, heading] of [
        ['input', INPUT, 'INPUT REGISTERS (read-only — what the pump measures)'],
        ['holding', HOLDING, 'HOLDING REGISTERS (read/write — what the pump is set to)']
    ]) {
        console.log(`\n=== ${heading} ===`);
        for (const [address, label, div] of list) {
            const {raw, error} = results[`${kind}:${address}`];
            const shown = error ? `ERROR: ${error}` : format(raw, div);
            console.log(String(address).padStart(5), label.padEnd(48), shown);
        }
    }

    if (expect === undefined)
        return;
    const hits = [];
    for (const [kind, list] of [['input', INPUT], ['holding', HOLDING]])
        for (const [address, label, div] of list) {
            const {value} = results[`${kind}:${address}`];
            if (value !== undefined && Math.abs(value - expect) < 0.05)
                hits.push(`  ${kind} ${address} — ${label}`);
        }
    console.log(`\n=== REGISTERS READING ${expect} ===`);
    console.log(hits.length ? hits.join('\n') : `  none — nothing on this pump reads ${expect}`);
}

function reportChanges(before, after) {
    const lines = [];
    for (const [kind, list] of [['input', INPUT], ['holding', HOLDING]])
        for (const [address, label, div] of list) {
            const key = `${kind}:${address}`;
            const was = before[key]?.raw;
            const now = after[key]?.raw;
            if (was === now)
                continue;
            lines.push(`  ${kind} ${String(address).padStart(4)} ${label.padEnd(48)} `
                + `${format(was, div).trim()}  ->  ${format(now, div).trim()}`);
        }
    if (lines.length)
        console.log(`\n[${new Date().toLocaleTimeString()}] changed:\n${lines.join('\n')}`);
}

const {socket, client} = await connect();
console.log(`connected to ${host}:502`);

let previous = await pass(client);

// Input register 1 (outdoor temperature) answers on every S-series pump. If even that fails the
// run carries no information about the registers under test, so say so rather than printing a
// column of identical errors that looks like a finding about the pump.
const sanity = previous['input:1'];
if (sanity.error) {
    console.error(`\nAborting: input register 1 (outdoor temperature) failed — "${sanity.error}".`);
    console.error('That register exists on every S-series pump, so this is the probe or the link,');
    console.error('not the registers being tested. Nothing below would be trustworthy.');
    socket.end();
    socket.destroy();
    process.exit(1);
}

if (scanFrom !== undefined && scanTo !== undefined) {
    console.log(`\n=== SCAN: holding ${scanFrom}..${scanTo} ===`);
    for (let address = scanFrom; address <= scanTo; ++address) {
        const {raw, error} = await readOne(client, 'holding', address);
        if (error)
            continue;                                 // not implemented — the common case, stay quiet
        console.log(String(address).padStart(6),
            raw === SENTINEL ? 'EXISTS, empty (sentinel)' : `= ${raw}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
    }
    console.log('(registers that answered with a Modbus exception are omitted)');
    socket.end();
    socket.destroy();
    process.exit(0);
}

report(previous);

if (write !== undefined) {
    // The 5..35 sanity band applies to the zone setpoint only. Once --register can point
    // anywhere, a fixed temperature range would refuse perfectly valid writes — `--register 843
    // --write 0` (turn Smart Price Adaption off) being the one we most need.
    if (target === 2505 && !(write >= 5 && write <= 35)) {
        console.error(`\nRefusing to write ${write} °C to the zone setpoint — outside 5..35.`);
        socket.end();
        socket.destroy();
        process.exit(1);
    }
    const raw = Math.round(write * divisor);
    const readBack = async () => {
        const response = await client.readHoldingRegisters(target, width === 32 ? 2 : 1);
        const values = response.response.body.values;
        const combined = width === 32 ? values[1] * 65536 + values[0] : values[0];
        return combined / divisor;
    };
    // A write the pump ACKs and then discards looks identical to a successful one until you
    // read back a moment later — register 2505 does exactly this. Re-read after a pause as
    // well as immediately, so "accepted" is never reported for a value that didn't stick.
    const settle = 3000;

    console.log(`\n=== WRITE TEST: holding ${target} (${width}-bit, ÷${divisor}) -> ${write} ===`);
    console.log(`before: ${await readBack()}`);

    // Every shape the pump might accept, tried in turn. This exists because concluding "2505 is
    // read-only" from FC6 + FC16-low-word-first was wrong: halderex measured on an S735 that the
    // pump takes exactly ONE shape — a two-word FC16 assembled HIGH word first, the opposite of
    // the order it reads in (PR #5). Every other shape is ACKed and silently discarded, so a
    // partial matrix looks identical to a read-only register. Test them all or conclude nothing.
    //
    // The original value is restored between attempts, so each starts from the same place and a
    // later shape can't inherit an earlier one's success.
    const original = await readBack();
    const restoreOriginal = async () => {
        // Restore with whatever shape works; if none does, the register never changed anyway.
        for (const words of [[Math.floor(rawOf(original) / 65536), rawOf(original) % 65536],
            [rawOf(original) % 65536, Math.floor(rawOf(original) / 65536)]]) {
            try {
                if (width === 32)
                    await client.writeMultipleRegisters(target, words);
                else
                    await client.writeSingleRegister(target, rawOf(original));
                if (await readBack() === original)
                    return;
            } catch { /* try the next shape */ }
        }
    };
    function rawOf(value) {
        const r = Math.round(value * divisor);
        return r < 0 ? r + 0x100000000 : r;
    }

    const attempt = async (label, send) => {
        let result;
        try {
            await send();
            const immediate = await readBack();
            await new Promise((resolve) => setTimeout(resolve, settle));
            const settled = await readBack();
            result = settled === write
                ? `TOOK — reads back ${settled}`
                : `ACKED BUT DISCARDED — immediately ${immediate}, after ${settle / 1000}s ${settled} `
                    + `(wanted ${write})`;
        } catch (error) {
            const body = error?.response?.body;
            result = `REJECTED — ${body ? JSON.stringify(body) : (error?.message ?? String(error))}`;
        }
        console.log(`  ${label}: ${result}`);
        await restoreOriginal();
    };

    const lo = raw % 65536;
    const hi = Math.floor(raw / 65536);
    if (width === 32) {
        // High word first is the one halderex measured as working. Tried first so a run that
        // succeeds says so before touching the shapes already known to be discarded.
        await attempt('FC16 [high, low]  (halderex order)',
            () => client.writeMultipleRegisters(target, [hi, lo]));
        await attempt('FC16 [low, high]  (read order)    ',
            () => client.writeMultipleRegisters(target, [lo, hi]));
        await attempt(`FC6  single word at ${target}       `,
            () => client.writeSingleRegister(target, lo));
        await attempt(`FC6  single word at ${target + 1}       `,
            () => client.writeSingleRegister(target + 1, hi));
    } else {
        await attempt('FC6  writeSingleRegister          ',
            () => client.writeSingleRegister(target, raw));
    }

    console.log('\n  TOOK                 that shape genuinely writes the register.');
    console.log('  ACKED BUT DISCARDED  the pump accepts the request and ignores it. NOT evidence');
    console.log('                       the register is read-only — only that this shape is wrong.');
    console.log('  REJECTED             the pump refused it outright, with the exception shown.');
    console.log(`\nHolding ${target} restored to ${await readBack()} (was ${original}).`);
}

if (watch) {
    console.log(`\nWatching every ${intervalMs / 1000}s. Change the temperature in the myUplink `
        + `app — whichever register follows it is the one to write. Ctrl-C to stop.`);
    const stop = () => {
        socket.end();
        socket.destroy();
        process.exit(0);
    };
    process.on('SIGINT', stop);
    for (;;) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        const current = await pass(client);
        reportChanges(previous, current);
        previous = current;
    }
}

socket.end();
socket.destroy();
