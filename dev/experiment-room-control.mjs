// Maintainer tool (not shipped — see .homeyignore). Answers one question automatically:
//
//   Does writing the room setpoint (holding 206) actually regulate anything, once room-sensor
//   control (holding 202) is switched on?
//
// Why this needs an experiment rather than a read. 206 IS writable — verified, a write of 21.5
// took and persisted — but on this pump it sat at its factory 20.0 while the pump really ran on
// the zone setpoint (2505), which mirrors myUplink and refuses Modbus writes. So "writable" and
// "has any effect" are separate questions, and only the second one matters.
//
// What it watches, and why not degree minutes. The obvious signal — the compressor starting — is
// unavailable whenever the outdoor average is above the heating cut-off (184), which in summer it
// usually is. Register 1017 "Calculated supply climate system 1" is the pump's *computed* flow
// target: it is recalculated from the curve and, if room-sensor control is active, from the gap
// between room temperature (116) and setpoint (206). It moves whether or not the compressor is
// permitted to run, so the experiment works in August.
//
// The method is a three-phase A/B/A:
//   baseline   sample 1017 with everything as found
//   demand     202 = 1, 206 = room + OFFSET   -> if room control is live, 1017 must rise
//   satisfied  206 = room - OFFSET            -> 1017 must fall back
// A verdict needs BOTH directions to move; one could be coincidence or drift.
//
// Everything it changes is snapshotted first and restored at the end — including on Ctrl-C and on
// error. The registers touched are 202 and 206 only, unless --allow-heating is given, which also
// lifts 184 so the compressor is permitted (that one genuinely heats your house, so it is opt-in).
//
// The pump accepts a single Modbus client, so the Homey app loses its connection while this runs.
//
//   node dev/experiment-room-control.mjs [host] [--minutes 4] [--offset 3] [--allow-heating]

import net from 'net';
import {createRequire} from 'module';

const require = createRequire(import.meta.url);
const {ModbusTCPClient} = require('jsmodbus');

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? Number(argv[i + 1]) : fallback;
};
const host = argv.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? '10.136.1.93';
// Minutes per phase. 1017 is recomputed on the pump's own cycle, not instantly, so a phase has to
// be long enough for a recalculation to land — a couple of minutes is the shortest that is fair.
const phaseMinutes = flag('minutes', 4);
// How far to push the setpoint either side of the current room temperature. Large enough that a
// real response is unmistakable, small enough not to slam the house.
const offset = flag('offset', 3);
const allowHeating = has('allow-heating');
const sampleMs = 20000;

const R = {
    useRoomSensor:   {address: 202,  width: 16, div: 1,  name: 'Use room sensor CS1'},
    roomSetpoint:    {address: 206,  width: 16, div: 10, name: 'Room sensor setpoint CS1'},
    roomFactor:      {address: 210,  width: 16, div: 10, name: 'Room sensor factor CS1'},
    stopHeatingOut:  {address: 184,  width: 16, div: 10, name: 'Stop heating above outdoor avg'},
    zoneSetpoint:    {address: 2505, width: 32, div: 10, name: 'Zone 1 setpoint (mirror)'},
    // The calculated supply cannot fall below this. If it is already sitting on the floor, a
    // "satisfied" phase has nowhere to go and the experiment cannot show a downward response —
    // which would read as "no effect" when it is really "no room to move".
    minSupply:       {address: 34,   width: 16, div: 10, name: 'Min supply CS1'},
    // Degree minutes is a HOLDING register. Reading address 11 as an input gives Brine out
    // (BT11), and two words from there decodes to millions — which is exactly what the first
    // run printed.
    degreeMinutes:   {address: 11,   width: 32, div: 10, name: 'Degree minutes'}
};
const IN = {
    roomTemp:        {address: 116,  width: 16, div: 10, name: 'Room temperature CS1'},
    calcSupply:      {address: 1017, width: 16, div: 10, name: 'Calculated supply CS1'},
    outdoorAvg:      {address: 37,   width: 16, div: 10, name: 'Outdoor average'},
    outdoor:         {address: 1,    width: 16, div: 10, name: 'Outdoor temperature'},
    priority:        {address: 1028, width: 16, div: 1,  name: 'Priority'}
};

const SENTINEL16 = 0x8000;
const SENTINEL32 = 0x80000000;

function decode(raw, spec) {
    if (raw === undefined || raw === (spec.width === 32 ? SENTINEL32 : SENTINEL16))
        return undefined;
    const limit = spec.width === 32 ? 0x100000000 : 65536;
    return (raw >= limit / 2 ? raw - limit : raw) / spec.div;
}

function connect() {
    // Client before connect — jsmodbus goes online off the socket's own 'connect' event.
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

const {socket, client} = await connect();
console.log(`connected to ${host}:502\n`);

async function read(spec, holding) {
    const count = spec.width === 32 ? 2 : 1;
    const response = await (holding
        ? client.readHoldingRegisters(spec.address, count)
        : client.readInputRegisters(spec.address, count));
    const v = response.response.body.values;
    return decode(spec.width === 32 ? v[1] * 65536 + v[0] : v[0], spec);
}
const readHolding = (spec) => read(spec, true);
const readInput = (spec) => read(spec, false);

async function writeHolding(spec, value) {
    const raw = Math.round(value * spec.div);
    const encoded = raw < 0 ? raw + 0x100000000 : raw;
    if (spec.width === 32)
        await client.writeMultipleRegisters(spec.address,
            [encoded & 0xFFFF, Math.floor(encoded / 65536) & 0xFFFF]);
    else
        await client.writeSingleRegister(spec.address, encoded & 0xFFFF);
    // Never trust the ACK: 2505 accepts writes and discards them. Confirm by reading back.
    const after = await readHolding(spec);
    if (Math.abs(after - value) > 0.05)
        throw new Error(`${spec.name} (${spec.address}) did not take — wrote ${value}, reads ${after}`);
    return after;
}

// Snapshot before anything is touched, so restore is possible from any exit path.
const snapshot = {
    useRoomSensor: await readHolding(R.useRoomSensor),
    roomSetpoint: await readHolding(R.roomSetpoint),
    stopHeatingOut: await readHolding(R.stopHeatingOut)
};
let restored = false;
async function restore() {
    if (restored)
        return;
    restored = true;
    console.log('\n--- restoring ---');
    for (const [key, spec] of [['roomSetpoint', R.roomSetpoint], ['useRoomSensor', R.useRoomSensor],
        ['stopHeatingOut', R.stopHeatingOut]]) {
        try {
            await writeHolding(spec, snapshot[key]);
            console.log(`  ${spec.name} (${spec.address}) back to ${snapshot[key]}`);
        } catch (error) {
            console.error(`  !! ${spec.name} (${spec.address}) NOT restored to ${snapshot[key]}: `
                + `${error?.message ?? error} — SET THIS BACK YOURSELF`);
        }
    }
}
process.on('SIGINT', async () => {
    await restore();
    socket.end();
    socket.destroy();
    process.exit(130);
});

async function samplePhase(label, minutes) {
    const until = Date.now() + minutes * 60000;
    const supplies = [];
    const outdoors = [];
    let everHeated = false;
    console.log(`\n--- ${label} (${minutes} min) ---`);
    while (Date.now() < until) {
        const supply = await readInput(IN.calcSupply);
        const room = await readInput(IN.roomTemp);
        const outdoor = await readInput(IN.outdoor);
        const dm = await readHolding(R.degreeMinutes);
        const priority = await readInput(IN.priority);
        supplies.push(supply);
        outdoors.push(outdoor);
        if (priority === 30)
            everHeated = true;
        console.log(`  ${new Date().toLocaleTimeString()}  calc supply ${supply} °C  `
            + `room ${room} °C  outdoor ${outdoor} °C  DM ${dm}  priority ${priority}`);
        await new Promise((resolve) => setTimeout(resolve, sampleMs));
    }
    const valid = supplies.filter((s) => s !== undefined);
    const validOut = outdoors.filter((s) => s !== undefined);
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
    return {
        mean: mean(valid), last: valid[valid.length - 1], samples: valid.length,
        // Outdoor drift is the confound: the curve moves the supply on its own as the evening
        // cools, which can masquerade as a response to the setpoint.
        outdoorMean: mean(validOut), everHeated
    };
}

try {
    const room = await readInput(IN.roomTemp);
    const outdoorAvg = await readInput(IN.outdoorAvg);
    const factor = await readHolding(R.roomFactor);
    const zone = await readHolding(R.zoneSetpoint);

    console.log('Starting state:');
    console.log(`  room temperature (116)      ${room} °C`);
    console.log(`  zone setpoint   (2505)      ${zone} °C   [mirror, refuses writes]`);
    console.log(`  room setpoint   (206)       ${snapshot.roomSetpoint} °C`);
    console.log(`  use room sensor (202)       ${snapshot.useRoomSensor}`);
    console.log(`  room factor     (210)       ${factor}`);
    console.log(`  outdoor average (37)        ${outdoorAvg} °C`);
    console.log(`  stop heating above (184)    ${snapshot.stopHeatingOut} °C`);
    const blocked = outdoorAvg > snapshot.stopHeatingOut;
    console.log(`  => heating is currently ${blocked ? 'BLOCKED by the outdoor cut-off' : 'permitted'}`);
    if (blocked && !allowHeating)
        console.log('     (fine — this experiment reads the *calculated* supply, which the pump\n'
            + '      recomputes regardless. Pass --allow-heating to lift 184 as well if you want\n'
            + '      the compressor to respond too; it is restored afterwards.)');
    if (room === undefined) {
        console.error('\nNo room temperature on 116 — nothing to regulate against. Stopping.');
    } else {
        if (allowHeating) {
            await writeHolding(R.stopHeatingOut, Math.ceil(outdoorAvg) + 5);
            console.log(`\n  184 temporarily raised to ${Math.ceil(outdoorAvg) + 5} °C so heating is permitted`);
        }

        const baseline = await samplePhase('BASELINE — as found', Math.max(1, Math.round(phaseMinutes / 2)));

        await writeHolding(R.useRoomSensor, 1);
        console.log(`\n  202 set to 1 (room-sensor control ON)`);
        await writeHolding(R.roomSetpoint, room + offset);
        console.log(`  206 set to ${room + offset} °C — ${offset} °C ABOVE the room, so heat is wanted`);
        const demand = await samplePhase('DEMAND — setpoint above room', phaseMinutes);

        await writeHolding(R.roomSetpoint, room - offset);
        console.log(`\n  206 set to ${room - offset} °C — ${offset} °C BELOW the room, so no heat is wanted`);
        const satisfied = await samplePhase('SATISFIED — setpoint below room', phaseMinutes);

        console.log('\n=== RESULT ===');
        const fmt = (p) => `${p.mean.toFixed(2)} °C mean over ${p.samples} samples (last ${p.last}), `
            + `outdoor ${p.outdoorMean.toFixed(1)} °C`;
        console.log(`  baseline   calculated supply: ${fmt(baseline)}`);
        console.log(`  demand     calculated supply: ${fmt(demand)}`);
        console.log(`  satisfied  calculated supply: ${fmt(satisfied)}`);
        const rose = demand.mean - baseline.mean;
        const fell = demand.mean - satisfied.mean;
        const drift = satisfied.outdoorMean - baseline.outdoorMean;
        const minSupply = await readHolding(R.minSupply);
        console.log(`\n  demand vs baseline:  ${rose >= 0 ? '+' : ''}${rose.toFixed(2)} °C`);
        console.log(`  demand vs satisfied: ${fell >= 0 ? '+' : ''}${fell.toFixed(2)} °C`);
        console.log(`  outdoor drift across the run: ${drift >= 0 ? '+' : ''}${drift.toFixed(2)} °C`);
        console.log(`  min supply floor (34): ${minSupply} °C`);

        // Refuse to conclude when the pump could not have responded. A flat supply proves nothing
        // if heating was switched off the whole time, or if the supply was already pinned to its
        // floor and had nowhere to fall. The first run of this script claimed "NO EFFECT" under
        // exactly those conditions, which was not a finding — it was an untestable setup.
        const heated = baseline.everHeated || demand.everHeated || satisfied.everHeated;
        const onFloor = Math.min(baseline.mean, demand.mean, satisfied.mean) - minSupply < 0.6;
        const blockers = [];
        if (!heated)
            blockers.push('the pump never once prioritised heating (priority 30) — with heating '
                + 'stopped there is nothing for a room setpoint to influence. Re-run with '
                + '--allow-heating.');
        if (onFloor)
            blockers.push(`the calculated supply sat within 0.6 °C of its floor (min supply `
                + `${minSupply} °C), so it could not fall even if the setpoint asked it to.`);

        if (blockers.length) {
            console.log('\n  VERDICT: INCONCLUSIVE — the experiment could not have detected a response:');
            for (const b of blockers)
                console.log(`    - ${b}`);
        } else if (fell > 0.5 && rose > 0.2) {
            console.log('\n  VERDICT: room-sensor control WORKS. Writing 206 with 202 = 1 moves the\n'
                + '  pump\'s calculated supply in both directions. This is a usable indoor setpoint.');
        } else if (Math.abs(fell) <= 0.5 && Math.abs(drift) < 0.5) {
            console.log('\n  VERDICT: NO EFFECT. The calculated supply did not follow the setpoint while\n'
                + '  the pump was heating and free to move, so 206 is stored but not acted on.');
        } else {
            console.log('\n  VERDICT: INCONCLUSIVE — the movement is within what outdoor drift alone\n'
                + `  could explain (${drift.toFixed(2)} °C over the run). Re-run with --offset 5.`);
        }
    }
} catch (error) {
    console.error(`\nExperiment failed: ${error?.message ?? error}`);
} finally {
    await restore();
    socket.end();
    socket.destroy();
}
