// Maintainer tool (not shipped — see .homeyignore). Answers one question: why does the
// immersion heater never fire during hot water charging?
//
// Observed on an S1155, August 2026: five "More hot water" charges in a row ended at 53-58 °C
// with register 1027 (immersion power) flat at 0 W, several of them on protective alarms —
// 382 "Inverter limited", 216 "High condenser temperature in", 215 "High condenser temperature
// out". A pump with a 6 kW heater available should use it rather than give up, and the same
// heater HAS drawn 6 kW for heating on this pump, and has 200 hours of runtime booked against
// hot water historically. So it can, and it does — just not here.
//
// Four hypotheses were proposed and refuted from the register table alone before this script
// existed: register 61, register 710, the Auto-mode outdoor cutoff, and the Large setpoint. The
// point of a probe is to read the configuration rather than infer it.
//
// Nothing here is added to the app. These are diagnostic reads for a question the app does not
// need to answer at runtime.
//
// The pump accepts a single Modbus client, so the running Homey app loses its connection while
// this runs (it reconnects by itself afterwards).
//
//   node dev/probe-immersion.mjs [host] [--watch 20]     # --watch N = re-read every N seconds

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
const watchSeconds = flag('watch', 0);

// dir: 'in' = input register (FC04), 'out' = holding (FC03). Several addresses exist as BOTH
// with unrelated meanings — 1052 is "max internal additional heat" as holding and "current
// compressor" as input — so the direction is part of the identity, not a detail.
const REGS = [
    ['--- can it use the immersion at all ---'],
    {addr:  102, dir: 'out', div: 100, unit: 'kW', name: 'Max internal additional heat',
     note: '0 here means the immersion can never run, whatever else is set'},
    {addr: 1052, dir: 'out', div: 100, unit: 'kW', name: 'Max internal add. heat (SG Ready)'},
    {addr: 1911, dir: 'in',  div: 1,   unit: '',   name: 'SG Ready operating mode',
     note: 'a blocking state can cap additional heat to nothing'},
    {addr: 1062, dir: 'in',  div: 1,   unit: '',   name: 'Step-controlled add. heat blocking'},
    {addr:  180, dir: 'out', div: 1,   unit: '',   name: 'Permit additional heat, HEATING'},
    {addr:  710, dir: 'out', div: 1,   unit: '',   name: 'HW comfort additional heat (accessory)'},

    ['--- is it being asked for: the degree-minute ladder ---'],
    {addr:   11, dir: 'out', div: 10,  unit: 'DM', size: 32, name: 'Degree minutes'},
    {addr:   97, dir: 'out', div: 1,   unit: 'DM', name: 'DM start heating'},
    {addr:  679, dir: 'out', div: 1,   unit: 'DM', name: 'DM diff. start additional heat'},
    {addr:  159, dir: 'out', div: 1,   unit: 'DM', name: 'DM start step-controlled add. heat'},
    {addr:  100, dir: 'out', div: 1,   unit: 'DM', name: 'DM between additional heat steps'},

    ['--- what it is actually doing ---'],
    {addr: 1027, dir: 'in',  div: 100, unit: 'kW', name: 'Immersion power NOW'},
    {addr: 1029, dir: 'in',  div: 1,   unit: '',   name: 'Immersion operating mode'},
    {addr: 1048, dir: 'in',  div: 1,   unit: 'W',  name: 'Compressor power'},
    {addr: 1046, dir: 'in',  div: 10,  unit: 'Hz', name: 'Compressor frequency'},
    {addr: 1025, dir: 'in',  div: 10,  unit: 'h',  name: 'Immersion runtime, total'},
    {addr: 1069, dir: 'in',  div: 10,  unit: 'h',  name: 'Immersion runtime, hot water'},
    {addr: 1975, dir: 'in',  div: 1,   unit: '',   name: 'Alarm code'},

    ['--- which target is actually in force, and who set it ---'],
    {addr: 1038, dir: 'in',  div: 1,   unit: '',   name: 'Current hot water MODE (in force now)',
     note: 'the mode the pump is really using, vs 56 which is only what is configured'},
    {addr:  137, dir: 'in',  div: 1,   unit: '',   name: 'Current hot water mode CONTROLLED BY',
     note: 'what is imposing that mode - schedule, boost, smart price, user'},
    {addr:  747, dir: 'in',  div: 1,   unit: '',   name: 'Temp. lux forces start of HW demand'},
    {addr: 2301, dir: 'in',  div: 100, unit: 'kWh', size: 32,
     name: 'Immersion energy for hot water, past hour',
     note: 'the pump\'s own record of whether the immersion ran - no inference needed'},
    {addr: 1688, dir: 'in',  div: 1,   unit: '',   name: 'Controlling hot water sensor (BT6)'},
    {addr: 1689, dir: 'in',  div: 1,   unit: '',   name: 'Display hot water sensor (BT7)'},

    ['--- hot water context ---'],
    {addr: 1028, dir: 'in',  div: 1,   unit: '',   name: 'Operating priority (20 = hot water)'},
    {addr:    9, dir: 'in',  div: 10,  unit: 'C',  name: 'Hot water charge (BT6)'},
    {addr:    8, dir: 'in',  div: 10,  unit: 'C',  name: 'Hot water top (BT7)'},
    {addr:   56, dir: 'out', div: 1,   unit: '',   name: 'Demand mode (0 S / 1 M / 2 L / 4 smart)'},
    {addr:   58, dir: 'out', div: 10,  unit: 'C',  name: 'Start, Large'},
    {addr:   62, dir: 'out', div: 10,  unit: 'C',  name: 'Stop, Large'},
    {addr:   61, dir: 'out', div: 10,  unit: 'C',  name: 'Stop, periodic increase'},
    {addr:  697, dir: 'out', div: 1,   unit: 'h',  name: 'More hot water (hours)'},
    {addr:   13, dir: 'in',  div: 10,  unit: 'C',  name: 'Discharge (BT14)'},
    {addr:   10, dir: 'in',  div: 10,  unit: 'C',  name: 'Brine in (BT10)'}
];

// Mirrors lib/registers.ts.
const combineRaw = (v, size) => (size === 32 ? v[1] * 65536 + v[0] : v[0]);
const signed = (raw, size) => (size === 32
    ? (raw >= 0x80000000 ? raw - 0x100000000 : raw)
    : (raw >= 32768 ? raw - 65536 : raw));
const unavailable = (raw, size) => raw === (size === 32 ? 0x80000000 : 0x8000);

const socket = new net.Socket();
const client = new ModbusTCPClient(socket, 1, 5000);

async function read(reg) {
    const count = reg.size === 32 ? 2 : 1;
    try {
        const resp = reg.dir === 'in'
            ? await client.readInputRegisters(reg.addr, count)
            : await client.readHoldingRegisters(reg.addr, count);
        const raw = combineRaw(resp.response.body.values, reg.size);
        if (raw === undefined || Number.isNaN(raw) || unavailable(raw, reg.size))
            return {text: 'not available'};
        return {value: signed(raw, reg.size) / reg.div, raw};
    } catch (error) {
        // A model that does not implement an address answers with an exception rather than a
        // value, and that is an answer: it means "not on this pump", not "the probe failed".
        return {text: `no answer (${error?.response?.body?.code ?? error?.err ?? 'error'})`};
    }
}

async function pass() {
    console.log(`\n===== ${new Date().toISOString().slice(11, 19)} =====`);
    for (const reg of REGS) {
        if (Array.isArray(reg)) { console.log(`\n${reg[0]}`); continue; }
        const r = await read(reg);
        const shown = r.text ?? `${r.value}${reg.unit ? ' ' + reg.unit : ''}`;
        console.log(`  ${String(reg.addr).padStart(4)} ${reg.name.padEnd(40)} ${shown}`
            + (reg.note && !r.text ? `\n       ^ ${reg.note}` : ''));
    }
}

socket.on('error', (error) => {
    console.error('socket error:', error.message);
    process.exit(1);
});

socket.connect({host, port: 502}, async () => {
    console.log(`Connected to ${host}.`);
    if (watchSeconds)
        console.log(`Re-reading every ${watchSeconds}s — start a hot water charge and watch 1027.`);
    await pass();
    if (!watchSeconds) {
        socket.end(); socket.destroy(); process.exit(0);
    }
    setInterval(pass, watchSeconds * 1000);
});
