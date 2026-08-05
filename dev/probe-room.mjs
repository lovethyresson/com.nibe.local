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
//   node dev/probe-room.mjs [host] [--watch] [--interval 10] [--expect 35]

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

report(previous);

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
