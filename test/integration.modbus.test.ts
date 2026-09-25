import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import {ModbusTCPServer} from 'jsmodbus';

import {Dir, Register, signedValue} from '../lib/registers';
import {LocalizedText, makeProfile, ModelProfile} from '../lib/profile';
import {PumpConnection, PumpSubscriber, Transport, inLanguage} from '../lib/connection';
import {Role} from '../lib/roles';

// A buffer-backed fake pump: jsmodbus serves the input/holding buffers with its built-in
// handlers, so seeding a register is just writing 2 big-endian bytes at address*2.

function seed(buf: Buffer, address: number, value: number, size?: 16 | 32) {
    if (size === 32) {
        buf.writeUInt16BE(value & 0xffff, address * 2);          // low word first
        buf.writeUInt16BE((value >>> 16) & 0xffff, (address + 1) * 2);
    } else {
        buf.writeUInt16BE(value & 0xffff, address * 2);
    }
}

interface Pump {
    port: number;
    input: Buffer;
    holding: Buffer;
    close: () => Promise<void>;
}

// `registerCount` bounds the served address space. Reading past it makes jsmodbus answer with
// an empty value array — the closest this harness gets to a real pump's "no such register on
// this model", which is what the read-failure reporting exists for.
async function startPump(registerCount = 0x10000, listenPort = 0): Promise<Pump> {
    const input = Buffer.alloc(registerCount * 2);
    const holding = Buffer.alloc(registerCount * 2);
    const server = new net.Server();
    new ModbusTCPServer(server, {input, holding});
    // server.close() only fires once every accepted socket is gone, so a test that closes the
    // pump while a connection is still attached would hang until its timeout.
    const sockets = new Set<net.Socket>();
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(listenPort, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    return {
        port, input, holding,
        close: () => new Promise<void>((resolve) => {
            sockets.forEach((socket) => socket.destroy());
            sockets.clear();
            server.close(() => resolve());
        })
    };
}

// A minimal profile for transport-level tests (no roles/energy needed).
function tinyProfile(registers: Register[], addressBase?: number): ModelProfile {
    return makeProfile({
        registers,
        role: {priorityRawOff: 10, powerSources: [], producedRegisterForRole: {}, priorityToRole: {}},
        transport: {port: 502, unitId: 1},
        addressBase,
        detection: {plausible: {}, discoveryProbe: {address: 1, scale: 10, min: -60, max: 60}},
        compose: {capabilities: [], capabilitiesOptions: {}, actions: [], conditions: [], triggers: []}
    });
}

const reg = (over: Partial<Register> & {address: number; name: string}): Register =>
    ({direction: Dir.In, group: 'core', info: {en: '', sv: ''}, ...over});

// A fake subscriber that records callbacks and resolves when the connection comes up.
class FakeSub implements PumpSubscriber {
    role: Role;
    debug = false;
    private regs: Register[];
    up = false;
    energy: {kwh: number; watts: number}[] = [];
    raws: {name: string; raw: number}[] = [];
    priorityChanges: {from?: number; to?: number; role: Role; reason?: LocalizedText}[] = [];
    private upResolvers: (() => void)[] = [];
    constructor(role: Role, regs: Register[]) { this.role = role; this.regs = regs; }
    wantedRegisters() { return this.regs; }
    onRegisterRaw(register: Register, raw: number) { this.raws.push({name: register.name, raw}); }
    onConnectionUp() { this.up = true; this.upResolvers.forEach((r) => r()); this.upResolvers = []; }
    // Counted, not just latched: a drop followed by a reconnect ends with `up` true again, so the
    // transition is the only evidence the connection was ever dropped.
    downCount = 0;
    onConnectionDown() { this.up = false; this.downCount += 1; }
    pollSeconds() { return 5; }
    debugEnabled() { return this.debug; }
    onEnergy(kwh: number, watts: number) { this.energy.push({kwh, watts}); }
    onPriorityChange(from: number | undefined, to: number | undefined,
                     role: Role, reason: LocalizedText | undefined) {
        this.priorityChanges.push({from, to, role, reason});
    }
    whenUp() { return this.up ? Promise.resolve() : new Promise<void>((r) => this.upResolvers.push(r)); }
}

async function withConnection(
    profile: ModelProfile, transport: Transport, sub: FakeSub, fn: (c: PumpConnection) => Promise<void>
) {
    const connection = PumpConnection.get('127.0.0.1', profile, transport);
    connection.attach(sub);
    try {
        await sub.whenUp();
        await fn(connection);
    } finally {
        connection.shutdown();
    }
}

test('reads a 16-bit input register and decodes low-word-first 32-bit', {timeout: 15000}, async () => {
    const pump = await startPump();
    try {
        const outdoor = reg({address: 100, name: 'outdoor', scale: 10});
        const counter = reg({address: 200, name: 'counter', size: 32, scale: 10});
        seed(pump.input, 100, 65516);          // -20 raw (=-2.0 at scale 10)
        seed(pump.input, 200, 1439070, 32);    // 143907.0 at scale 10
        const profile = tinyProfile([outdoor, counter]);
        await withConnection(profile, {port: pump.port, unitId: 1}, new FakeSub('main', []), async (c) => {
            assert.equal(await c.readRegisterRaw(outdoor), 65516);
            assert.equal(await c.readRegisterRaw(counter), 1439070);
        });
    } finally {
        await pump.close();
    }
});

test('writeSingleRegister lands in the holding buffer', {timeout: 15000}, async () => {
    const pump = await startPump();
    try {
        const setpoint = reg({address: 300, name: 'setpoint', direction: Dir.Out, scale: 10});
        const profile = tinyProfile([setpoint]);
        await withConnection(profile, {port: pump.port, unitId: 1}, new FakeSub('main', []), async (c) => {
            await c.writeSingleRegister(300, 455);
            assert.equal(pump.holding.readUInt16BE(300 * 2), 455);
        });
    } finally {
        await pump.close();
    }
});

// A real pump does NOT round-trip a 32-bit write through this harness's model of memory. It
// accepts one FC16 request assembled HIGH word first and then reads the value back LOW word
// first — measured on halderex's S735 (PR #5) and on the maintainer's S1155, where the other
// three shapes (FC16 low-first, FC6 at either word) are ACKed and silently discarded. jsmodbus's
// server is a flat buffer and cannot reproduce that asymmetry, so these tests pin what goes ON
// THE WIRE. Asserting a read-back here would only test the fake pump, and asserting the read
// order would re-introduce the exact bug: this code sent [low, high] and the setpoint was
// written off as unwritable because three of four shapes look identical from the client side.
test('a 32-bit write puts the high word first on the wire', {timeout: 15000}, async () => {
    const pump = await startPump();
    try {
        // The zone setpoint's shape: s32, scale 10. Both words are seeded with rubbish so the
        // test cannot pass by leaving either of them untouched.
        const setpoint = reg({address: 400, name: 'zone_setpoint', direction: Dir.Out, size: 32, scale: 10});
        pump.holding.writeUInt16BE(0xBEEF, 400 * 2);
        pump.holding.writeUInt16BE(0xBEEF, 401 * 2);
        const profile = tinyProfile([setpoint]);
        await withConnection(profile, {port: pump.port, unitId: 1}, new FakeSub('main', []), async (c) => {
            await c.writeRegisterValue(setpoint, 215);
            assert.equal(pump.holding.readUInt16BE(400 * 2), 0, 'first word on the wire is the HIGH word');
            assert.equal(pump.holding.readUInt16BE(401 * 2), 215, 'second word on the wire is the LOW word');
        });
    } finally {
        await pump.close();
    }
});

test('a negative 32-bit write is two-s complement, high word first', {timeout: 15000}, async () => {
    const pump = await startPump();
    try {
        // Degree minutes is the register this protects: s32 and genuinely negative. Truncating to
        // one word would send 0xF254 alone, which the pump would read as +62036.
        const dm = reg({address: 500, name: 'degree_minutes', direction: Dir.Out, size: 32, scale: 10});
        const profile = tinyProfile([dm]);
        await withConnection(profile, {port: pump.port, unitId: 1}, new FakeSub('main', []), async (c) => {
            await c.writeRegisterValue(dm, -3500);
            const encoded = 0x100000000 - 3500;
            assert.equal(pump.holding.readUInt16BE(500 * 2), Math.floor(encoded / 65536),
                'high word first, carrying the sign');
            assert.equal(pump.holding.readUInt16BE(501 * 2), encoded % 65536);
            // The decode side is unchanged and still low-word-first — that is the asymmetry.
            assert.equal(signedValue(encoded, 32), -3500);
        });
    } finally {
        await pump.close();
    }
});

test('addressBase offsets the PDU address on read and write (F ModbusManager numbering)', {timeout: 15000}, async () => {
    const pump = await startPump();
    try {
        // Logical id 40004 with addressBase 40000 → wire PDU address 4.
        const base = 40000;
        const outdoor = reg({address: 40004, name: 'f_outdoor', scale: 10});
        const setting = reg({address: 47041, name: 'f_setting', direction: Dir.Out});
        seed(pump.input, 40004 - base, 123);   // seeded at the OFFSET location
        const profile = tinyProfile([outdoor, setting], base);
        await withConnection(profile, {port: pump.port, unitId: 1}, new FakeSub('main', []), async (c) => {
            assert.equal(await c.readRegisterRaw(outdoor), 123);          // read the offset location
            await c.writeSingleRegister(47041, 2);
            assert.equal(pump.holding.readUInt16BE((47041 - base) * 2), 2); // written to the offset location
        });
    } finally {
        await pump.close();
    }
});

test('energy allocator sums power sources and charges the prioritised function', {timeout: 20000}, async () => {
    const pump = await startPump();
    try {
        // Two power sources with different scales, both expressed so value/scale = watts:
        //   comprPower: W (scale 1) ; addPower: raw in 0.01 kW units (scale 0.1 → watts)
        const comprPower = reg({address: 500, name: 'compr_power', scale: 1});
        const addPower = reg({address: 501, name: 'add_power', scale: 0.1});
        const priority = reg({address: 502, name: 'priority'});
        seed(pump.input, 500, 1500);   // 1500 W
        seed(pump.input, 501, 50);     // 50 / 0.1 = 500 W  → total 2000 W
        seed(pump.input, 502, 30);     // priority 30 → heating

        const profile = makeProfile({
            registers: [comprPower, addPower, priority],
            role: {
                priorityRegisterName: 'priority',
                priorityRawOff: 10,
                powerSources: [['compr_power', 'add_power']],
                producedRegisterForRole: {},
                priorityToRole: {10: 'main', 30: 'heating'}
            },
            transport: {port: 502, unitId: 1},
            detection: {plausible: {}, discoveryProbe: {address: 1, scale: 10, min: -60, max: 60}},
            compose: {capabilities: [], capabilitiesOptions: {}, actions: [], conditions: [], triggers: []}
        });

        const main = new FakeSub('main', []);
        const heating = new FakeSub('heating', []);
        const connection = PumpConnection.get('127.0.0.1', profile, {port: pump.port, unitId: 1});
        connection.attach(main);
        connection.attach(heating);
        try {
            await main.whenUp();
            // Wait for two polls: the first seeds lastPowerReading (delta 0), the second
            // integrates a real interval. Poll floor is 5 s, so ~11 s covers two.
            await new Promise((r) => setTimeout(r, 11000));
            const heatCharged = heating.energy.filter((e) => e.watts > 0);
            assert.ok(heatCharged.length > 0, 'heating should receive the active-power allocation');
            assert.equal(heatCharged[heatCharged.length - 1].watts, 2000, 'summed watts from both sources');
            assert.ok(heatCharged.some((e) => e.kwh > 0), 'heating should accrue kWh after the second poll');
            // Main (standby) is charged only when idle → it should see 0 watts while heating runs.
            assert.ok(main.energy.every((e) => e.watts === 0), 'main gets no active draw while heating is prioritised');
        } finally {
            connection.shutdown();
        }
    } finally {
        await pump.close();
    }
});

test('an idle 1028 that disagrees with an active 3804 is corrected everywhere at once',
    {timeout: 20000}, async () => {
    const pump = await startPump();
    try {
        const power = reg({address: 500, name: 'power', scale: 1});
        const priority = reg({address: 502, name: 'priority'});
        // A second capability at the same address as the priority register, like the real S
        // profile's enum tile + raw-numeric twin on 1028 — both must move together.
        const priorityTwin = reg({address: 502, name: 'priority_twin'});
        // Name matched exactly against connection.ts's hardcoded lookup in
        // applyEnergyLogPriorityOverride() — not configurable per-profile like priorityRegisterName.
        const energyLogPriority = reg({address: 503, name: 'measure_priority_NIBE.i3804_energylog_priority', internal: true});
        seed(pump.input, 500, 2000);   // 2000 W
        seed(pump.input, 502, 10);     // 1028 reads idle
        seed(pump.input, 503, 30);     // 3804 reads heat

        const profile = makeProfile({
            registers: [power, priority, priorityTwin, energyLogPriority],
            role: {
                priorityRegisterName: 'priority',
                priorityRawOff: 10,
                powerSources: [['power']],
                producedRegisterForRole: {},
                priorityToRole: {10: 'main', 30: 'heating'}
            },
            transport: {port: 502, unitId: 1},
            detection: {plausible: {}, discoveryProbe: {address: 1, scale: 10, min: -60, max: 60}},
            compose: {capabilities: [], capabilitiesOptions: {}, actions: [], conditions: [], triggers: []}
        });

        const main = new FakeSub('main', [priority, priorityTwin]);
        const heating = new FakeSub('heating', []);
        const connection = PumpConnection.get('127.0.0.1', profile, {port: pump.port, unitId: 1});
        connection.attach(main);
        connection.attach(heating);
        try {
            await main.whenUp();
            await new Promise((r) => setTimeout(r, 11000));

            // Energy: charged to heating, not main, despite 1028 reading idle.
            const heatCharged = heating.energy.filter((e) => e.watts > 0);
            assert.ok(heatCharged.length > 0, 'heating should receive the corrected allocation');
            assert.ok(main.energy.every((e) => e.watts === 0), 'main gets no draw once corrected');

            // Tile + its raw twin: both see the corrected 30, never 1028's real reading of 10.
            const primaryRaws = main.raws.filter((r) => r.name === 'priority').map((r) => r.raw);
            const twinRaws = main.raws.filter((r) => r.name === 'priority_twin').map((r) => r.raw);
            assert.ok(primaryRaws.length > 0 && primaryRaws.every((raw) => raw === 30),
                `expected only corrected 30 on the primary register, got ${primaryRaws}`);
            assert.ok(twinRaws.length > 0 && twinRaws.every((raw) => raw === 30),
                `expected only corrected 30 on the twin register, got ${twinRaws}`);

            // priority_changed: fires with the corrected code, not 1028's own 10.
            const change = main.priorityChanges.find((c) => c.to === 30);
            assert.ok(change, 'priority_changed should report the corrected code (30), not 1028\'s own 10');
        } finally {
            connection.shutdown();
        }
    } finally {
        await pump.close();
    }
});

test('an active 1028 reading is never overridden, even if 3804 disagrees', {timeout: 20000}, async () => {
    const pump = await startPump();
    try {
        const power = reg({address: 500, name: 'power', scale: 1});
        const priority = reg({address: 502, name: 'priority'});
        const energyLogPriority = reg({address: 503, name: 'measure_priority_NIBE.i3804_energylog_priority', internal: true});
        seed(pump.input, 500, 2000);
        seed(pump.input, 502, 20);     // 1028 reads hot water — active, must win
        seed(pump.input, 503, 30);     // 3804 disagrees — must be ignored

        const profile = makeProfile({
            registers: [power, priority, energyLogPriority],
            role: {
                priorityRegisterName: 'priority',
                priorityRawOff: 10,
                powerSources: [['power']],
                producedRegisterForRole: {},
                priorityToRole: {10: 'main', 20: 'hotwater', 30: 'heating'}
            },
            transport: {port: 502, unitId: 1},
            detection: {plausible: {}, discoveryProbe: {address: 1, scale: 10, min: -60, max: 60}},
            compose: {capabilities: [], capabilitiesOptions: {}, actions: [], conditions: [], triggers: []}
        });

        const main = new FakeSub('main', [priority]);
        const hotwater = new FakeSub('hotwater', []);
        const heating = new FakeSub('heating', []);
        const connection = PumpConnection.get('127.0.0.1', profile, {port: pump.port, unitId: 1});
        connection.attach(main);
        connection.attach(hotwater);
        connection.attach(heating);
        try {
            await main.whenUp();
            await new Promise((r) => setTimeout(r, 11000));

            assert.ok(hotwater.energy.some((e) => e.watts > 0),
                'hot water keeps the allocation 1028 actually reported');
            assert.ok(heating.energy.every((e) => e.watts === 0),
                '3804 is not trusted over an active 1028 reading');
            const primaryRaws = main.raws.filter((r) => r.name === 'priority').map((r) => r.raw);
            assert.ok(primaryRaws.length > 0 && primaryRaws.every((raw) => raw === 20),
                `expected 1028's own 20, unmodified, got ${primaryRaws}`);
        } finally {
            connection.shutdown();
        }
    } finally {
        await pump.close();
    }
});

test('priority-change reset clears "More hot water" on hot water -> idle', {timeout: 25000}, async () => {
    const pump = await startPump();
    try {
        const priority = reg({address: 600, name: 'priority'});                       // input
        const moreHw = reg({address: 697, name: 'more_hw', direction: Dir.Out,        // holding
            bool: true, onValue: 2, offValue: 0});
        seed(pump.input, 600, 20);        // pump prioritising hot water
        seed(pump.holding, 697, 2);       // "More hot water" boost on

        const profile = makeProfile({
            registers: [priority, moreHw],
            role: {
                priorityRegisterName: 'priority',
                priorityRawOff: 10,
                powerSources: [],
                producedRegisterForRole: {},
                priorityToRole: {10: 'main', 20: 'hotwater'},
                resetOnPriorityChange: [{from: 20, to: 10, register: 'more_hw'}]
            },
            transport: {port: 502, unitId: 1},
            detection: {plausible: {}, discoveryProbe: {address: 1, scale: 10, min: -60, max: 60}},
            compose: {capabilities: [], capabilitiesOptions: {}, actions: [], conditions: [], triggers: []}
        });

        // A hot water device that polls the boost register (so it lands in lastRaw).
        const sub = new FakeSub('hotwater', [moreHw]);
        const connection = PumpConnection.get('127.0.0.1', profile, {port: pump.port, unitId: 1});
        connection.attach(sub);
        try {
            await sub.whenUp();
            await new Promise((r) => setTimeout(r, 900));   // let the first poll record priority 20
            assert.equal(pump.holding.readUInt16BE(697 * 2), 2, 'boost still on before idle');
            seed(pump.input, 600, 10);                       // pump goes idle
            await new Promise((r) => setTimeout(r, 6500));   // next poll sees 20 -> 10 and resets
            assert.equal(pump.holding.readUInt16BE(697 * 2), 0, 'boost cleared after hot water -> idle');
        } finally {
            connection.shutdown();
        }
    } finally {
        await pump.close();
    }
});

test('reconciliation monitor tracks the pump counter without touching live meters', {timeout: 25000}, async () => {
    const pump = await startPump();
    try {
        const power = reg({address: 700, name: 'power', scale: 1});
        const priority = reg({address: 701, name: 'priority'});
        const consumed = reg({address: 702, name: 'consumed', scale: 10, size: 32});
        seed(pump.input, 700, 2000);          // 2000 W
        seed(pump.input, 701, 30);            // heating
        seed(pump.input, 702, 1000, 32);      // 100.0 kWh consumed so far

        const profile = makeProfile({
            registers: [power, priority, consumed],
            role: {
                priorityRegisterName: 'priority',
                priorityRawOff: 10,
                powerSources: [['power']],
                totalConsumptionRegister: 'consumed',
                producedRegisterForRole: {},
                priorityToRole: {10: 'main', 30: 'heating'}
            },
            transport: {port: 502, unitId: 1},
            detection: {plausible: {}, discoveryProbe: {address: 1, scale: 10, min: -60, max: 60}},
            compose: {capabilities: [], capabilitiesOptions: {}, actions: [], conditions: [], triggers: []}
        });

        const heating = new FakeSub('heating', []);
        const connection = PumpConnection.get('127.0.0.1', profile, {port: pump.port, unitId: 1});
        connection.attach(heating);
        try {
            await heating.whenUp();
            await new Promise((r) => setTimeout(r, 900));   // first poll: establishes the reference
            seed(pump.input, 702, 1002, 32);                // pump counter advances 0.2 kWh
            await new Promise((r) => setTimeout(r, 6500));  // next poll consumes that delta
            // The live meter is still the trapezoidal integral — the monitor must not alter it.
            const charged = heating.energy.filter((e) => e.kwh > 0);
            assert.ok(charged.length > 0, 'heating still accrues integrated energy');
            // Integrated energy over ~6 s at 2 kW is ~0.0033 kWh — nowhere near the counter's
            // 0.2 kWh step, proving the monitor accumulates separately from the live meter.
            const total = heating.energy.reduce((sum, e) => sum + e.kwh, 0);
            assert.ok(total < 0.05, `live meter stays on the integral, got ${total} kWh`);
        } finally {
            connection.shutdown();
        }
    } finally {
        await pump.close();
    }
});

test('the priority-change log and the subscriber carry the model\'s explanation',
     {timeout: 25000}, async () => {
    const pump = await startPump();
    const logs: string[] = [];
    const realLog = console.log;
    console.log = (...args: any[]) => { logs.push(args.join(' ')); };
    try {
        const power = reg({address: 500, name: 'power', scale: 1});
        const priority = reg({address: 600, name: 'priority'});
        seed(pump.input, 500, 1500);
        seed(pump.input, 600, 10);                 // idle to begin with
        seed(pump.holding, 11, -600, 32);          // degree minutes -60.0 (s32, scale 10, signed)
        seed(pump.holding, 97, 65536 - 60);        // compressor starts at -60

        const profile = makeProfile({
            registers: [power, priority],
            role: {
                priorityRegisterName: 'priority', priorityRawOff: 10,
                powerSources: [['power']], producedRegisterForRole: {},
                priorityToRole: {10: 'main', 30: 'heating'}
            },
            transport: {port: 502, unitId: 1},
            // A miniature stand-in for the S rules: read the two registers that matter and say
            // what they mean. The real ruleset is unit-tested directly (see unit.test.ts).
            reason: {
                inputs: {
                    dm:      {address: 11, direction: Dir.Out, scale: 10},
                    dmStart: {address: 97, direction: Dir.Out}
                },
                explain: ({role, v}) => {
                    const dm = v('dm');
                    const start = v('dmStart');
                    if (role !== 'heating' || dm === undefined || start === undefined)
                        return undefined;
                    return {
                        en: `Degree minutes reached ${dm}, the ${start} compressor start threshold.`,
                        sv: `Gradminuterna nadde ${dm}, startgransen ${start} for kompressorn.`
                    };
                }
            },
            detection: {plausible: {}, discoveryProbe: {address: 1, scale: 10, min: -60, max: 60}},
            compose: {capabilities: [], capabilitiesOptions: {}, actions: [], conditions: [], triggers: []}
        });

        const sub = new FakeSub('main', []);
        sub.debug = true;                          // the log line itself is debug-gated
        const connection = PumpConnection.get('127.0.0.1', profile, {port: pump.port, unitId: 1});
        connection.attach(sub);
        try {
            await sub.whenUp();
            await new Promise((r) => setTimeout(r, 900));
            seed(pump.input, 600, 30);             // pump starts heating
            await new Promise((r) => setTimeout(r, 6500));
            const line = logs.filter((l) => l.includes('Priority change: raw=30')).pop();
            assert.ok(line, 'expected a priority-change line for the transition to heating');
            assert.match(line!, /role=heating/);
            // Read on demand, signed and scaled, and appended as prose rather than a dump.
            assert.match(line!, /— Degree minutes reached -60, the -60 compressor start threshold\./);

            // The same explanation reaches the subscriber in both languages, so the flow
            // trigger's `reason` token can render it in the user's.
            const change = sub.priorityChanges.filter((c) => c.to === 30).pop();
            assert.ok(change, 'expected the subscriber to be told about the change to heating');
            assert.equal(change!.from, 10);
            assert.equal(change!.role, 'heating');
            assert.equal(inLanguage(change!.reason, 'sv'),
                'Gradminuterna nadde -60, startgransen -60 for kompressorn.');

            // Reason inputs must not leak into the steady-state poll — they are read only at a
            // change, so no subscriber ever sees a `__reason.*` register.
            assert.ok(!sub.raws.some((r) => r.name.startsWith('__reason')),
                'reason inputs must not be dispatched as capabilities');
        } finally {
            connection.shutdown();
        }
    } finally {
        console.log = realLog;
        await pump.close();
    }
});

// ---------------------------------------------------------------------------------------
// Power-source fallback and read-failure visibility. Both exist because of one bug: register
// 2166 is the only power source declared for S, it does not exist on S320/S325, S330/S332 or
// S2125, and nothing anywhere said so — the allocator just silently did nothing and every
// per-function meter and COP stayed empty.
// ---------------------------------------------------------------------------------------

// The pumps below are started with a bounded address space; a register past that edge reads
// as nothing at all, which is what a real pump does for a register its model doesn't have.
const SERVED_REGISTERS = 1000;
const ABSENT_ADDRESS = 5000;

test('the allocator falls back to the next power source when the preferred one is absent',
     {timeout: 20000}, async () => {
    const pump = await startPump(SERVED_REGISTERS);
    try {
        const preferred = reg({address: ABSENT_ADDRESS, name: 'preferred', scale: 1, size: 32});
        // 32-bit values span two words, so the fallback occupies 520 AND 521 — priority has
        // to sit clear of it or it lands in the high word.
        const fallback = reg({address: 520, name: 'fallback', scale: 0.1, size: 32});
        const priority = reg({address: 522, name: 'priority'});
        seed(pump.input, 520, 250, 32);   // 250 / 0.1 = 2500 W
        seed(pump.input, 522, 30);        // heating

        const profile = makeProfile({
            registers: [preferred, fallback, priority],
            role: {
                priorityRegisterName: 'priority', priorityRawOff: 10,
                powerSources: [['preferred'], ['fallback']],
                producedRegisterForRole: {}, priorityToRole: {10: 'main', 30: 'heating'}
            },
            transport: {port: 502, unitId: 1},
            detection: {plausible: {}, discoveryProbe: {address: 1, scale: 10, min: -60, max: 60}},
            compose: {capabilities: [], capabilitiesOptions: {}, actions: [], conditions: [], triggers: []}
        });

        const heating = new FakeSub('heating', []);
        const connection = PumpConnection.get('127.0.0.1', profile, {port: pump.port, unitId: 1});
        connection.attach(heating);
        try {
            await heating.whenUp();
            await new Promise((r) => setTimeout(r, 11000));
            const charged = heating.energy.filter((e) => e.watts > 0);
            assert.ok(charged.length > 0, 'the fallback source must keep the allocator running');
            assert.equal(charged[charged.length - 1].watts, 2500, 'watts come from the fallback alone');
            assert.ok(charged.some((e) => e.kwh > 0), 'and energy still accrues');
        } finally {
            connection.shutdown();
        }
    } finally {
        await pump.close();
    }
});

test('a pump carrying both power sources uses the preferred one, never their sum',
     {timeout: 20000}, async () => {
    const pump = await startPump();
    try {
        // An S1155 has 2166 *and* the energy-log register. Summing them would double-count.
        const preferred = reg({address: 530, name: 'preferred', scale: 1, size: 32});
        const fallback = reg({address: 532, name: 'fallback', scale: 0.1, size: 32});
        const priority = reg({address: 534, name: 'priority'});
        seed(pump.input, 530, 1800, 32);  // 1800 W
        seed(pump.input, 532, 190, 32);   // 1900 W — close but not equal, so a sum is obvious
        seed(pump.input, 534, 30);

        const profile = makeProfile({
            registers: [preferred, fallback, priority],
            role: {
                priorityRegisterName: 'priority', priorityRawOff: 10,
                powerSources: [['preferred'], ['fallback']],
                producedRegisterForRole: {}, priorityToRole: {10: 'main', 30: 'heating'}
            },
            transport: {port: 502, unitId: 1},
            detection: {plausible: {}, discoveryProbe: {address: 1, scale: 10, min: -60, max: 60}},
            compose: {capabilities: [], capabilitiesOptions: {}, actions: [], conditions: [], triggers: []}
        });

        const heating = new FakeSub('heating', []);
        const connection = PumpConnection.get('127.0.0.1', profile, {port: pump.port, unitId: 1});
        connection.attach(heating);
        try {
            await heating.whenUp();
            await new Promise((r) => setTimeout(r, 11000));
            const charged = heating.energy.filter((e) => e.watts > 0);
            assert.ok(charged.length > 0);
            assert.equal(charged[charged.length - 1].watts, 1800,
                'the preferred source wins outright — 3700 would mean both were summed');
        } finally {
            connection.shutdown();
        }
    } finally {
        await pump.close();
    }
});

test('a register that never reads is reported once per app start, and restated when debug goes on',
     {timeout: 25000}, async () => {
    const pump = await startPump(SERVED_REGISTERS);
    const logs: string[] = [];
    const realLog = console.log;
    console.log = (...args: any[]) => { logs.push(args.join(' ')); };
    try {
        const good = reg({address: 540, name: 'good_reg', scale: 1});
        const missing = reg({address: ABSENT_ADDRESS, name: 'missing_reg', scale: 1, size: 32});
        seed(pump.input, 540, 100);

        const profile = tinyProfile([good, missing]);
        const sub = new FakeSub('main', [good, missing]);
        const connection = PumpConnection.get('127.0.0.1', profile, {port: pump.port, unitId: 1});
        connection.attach(sub);
        try {
            await sub.whenUp();
            // Long enough for several polls (5 s floor), so "once per app start" is a real claim.
            await new Promise((r) => setTimeout(r, 12000));

            const reports = logs.filter((l) => l.includes('did not read (first failure since app start)'));
            assert.equal(reports.length, 1, `expected exactly one first-failure report, got ${reports.length}`);
            assert.ok(reports[0].includes('missing_reg'), 'the report must name the register');
            assert.ok(!reports[0].includes('good_reg'), 'a register that reads must not be listed');
            assert.ok(!reports[0].includes('__'), 'on-demand reason inputs are best-effort, not failures');

            // Debug logging is switched on *after* the fact — the usual order of events when a
            // user is asked for logs. The standing failure has to be restated, or the one line
            // that explains their problem is already gone.
            assert.ok(!logs.some((l) => l.includes('still not reading')), 'nothing restated yet');
            sub.debug = true;
            connection.refreshDebug();
            const restated = logs.filter((l) => l.includes('still not reading'));
            assert.equal(restated.length, 1, 'turning debug on must restate standing failures');
            assert.ok(restated[0].includes('missing_reg'));
        } finally {
            connection.shutdown();
        }
    } finally {
        console.log = realLog;
        await pump.close();
    }
});

test('an unresponsive pump is reconnected without blaming individual registers',
     {timeout: 90000}, async () => {
    const sockets: net.Socket[] = [];
    const server = new net.Server((socket) => { sockets.push(socket); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;

    const logs: string[] = [];
    const realLog = console.log;
    console.log = (...args: any[]) => { logs.push(args.join(' ')); };
    try {
        const a = reg({address: 560, name: 'reg_a', scale: 1});
        const profile = tinyProfile([a]);
        const sub = new FakeSub('main', [a]);
        const connection = PumpConnection.get('127.0.0.1', profile, {port, unitId: 1});
        connection.attach(sub);
        try {
            await sub.whenUp();
            assert.equal(sub.up, true, 'starts up');
            // Two consecutive polls must read nothing before the watchdog acts, and each read
            // only fails once the jsmodbus 5 s timeout expires — so this is ~15 s of real time
            // before the drop, plus room for the reconnect that follows.
            await new Promise((r) => setTimeout(r, 30000));

            assert.ok(logs.some((l) => l.includes('the pump has stopped responding')),
                `expected the watchdog to say so; got: ${JSON.stringify(logs.slice(-5))}`);
            // The device must actually be told, not just logged about — that is what turns a
            // frozen tile into an unavailable one. It ends up back "up" because the reconnect
            // succeeds (the server still accepts connections, it just never answers Modbus),
            // so the drop itself is what to assert on.
            assert.ok(sub.downCount >= 1,
                'the device must be marked down, not left looking online with stale values');
            assert.ok(sockets.length >= 2, 'the watchdog must reconnect after dropping the socket');
            assert.ok(!logs.some((l) => l.includes('did not read (first failure since app start)')),
                'a total loss is a connection problem, not an unsupported register');
        } finally {
            connection.shutdown();
        }
    } finally {
        console.log = realLog;
        sockets.forEach((s) => s.destroy());
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

// 60 s, not 30: this test genuinely takes ~28 s of wall clock, which left a 7% margin on a
// suite node runs file-concurrently by default. It failed on a loaded machine, not on a bug.
test('internal registers are polled even though no subscriber wants them, and Main gets the standby share',
     {timeout: 60000}, async () => {
    // Internal registers have no capability, so they never appear in wantedRegisters() — but the
    // energy log lives here and has to be read. This test is the reason the poll loop gained an
    // explicit pass over profile.registers.
    const pump = await startPump();
    const logs: string[] = [];
    const realLog = console.log;
    console.log = (...args: any[]) => { logs.push(args.join(' ')); };
    try {
        const visible = reg({address: 700, name: 'visible', scale: 1});
        const logUsed = reg({address: 702, name: 'log_used', scale: 100, size: 32, internal: true});
        seed(pump.input, 700, 42);
        seed(pump.input, 702, 199, 32);          // 1.99 kWh for the completed hour

        const totalUsed = reg({address: 704, name: 'tot_used', scale: 10, size: 32});
        const totalProduced = reg({address: 706, name: 'tot_produced', scale: 10, size: 32});
        seed(pump.input, 704, 1000, 32);         // 100.0 kWh
        seed(pump.input, 706, 3000, 32);         // 300.0 kWh

        const profile = makeProfile({
            registers: [visible, logUsed, totalUsed, totalProduced],
            role: {priorityRawOff: 10, powerSources: [], producedRegisterForRole: {}, priorityToRole: {},
                   totalConsumptionRegister: 'tot_used', totalProductionRegister: 'tot_produced'},
            transport: {port: 502, unitId: 1},
            energyLog: [{name: 'log_used', label: 'hot water used',
                         role: 'hotwater' as Role, flow: 'used' as const}],
            detection: {plausible: {}, discoveryProbe: {address: 1, scale: 10, min: -60, max: 60}},
            compose: {capabilities: [], capabilitiesOptions: {}, actions: [], conditions: [], triggers: []}
        });

        // The subscriber asks for `visible` only — the internal register must still be read.
        const sub = new FakeSub('main', [visible]);
        sub.debug = true;
        const mainHours: number[] = [];
        (sub as any).onEnergyLogHour = (used?: number) => { if (used !== undefined) mainHours.push(used); };
        const connection = PumpConnection.get('127.0.0.1', profile, {port: pump.port, unitId: 1});
        connection.attach(sub);
        try {
            await sub.whenUp();
            await new Promise((r) => setTimeout(r, 7000));
            assert.equal(connection.lastRawFor('log_used'), 199,
                'an internal register must be polled despite no subscriber wanting it');
            assert.ok(!sub.raws.some((r) => r.name === 'log_used'),
                'but it must never be dispatched to a device as a capability value');

            // Main's standby share: the counter's movement less what the functions booked, one
            // step back because the counter lags the log by about an hour. The baseline and the
            // first (part-hour) step only anchor; nothing is handed out for them.
            seed(pump.input, 702, 50, 32);       // first step: aligns the counter on :00
            await new Promise((r) => setTimeout(r, 7000));
            seed(pump.input, 702, 13, 32);       // a full hour: functions booked 0.13 kWh
            await new Promise((r) => setTimeout(r, 7000));
            assert.equal(mainHours.length, 0, 'no standby share until a previous hour exists');
            seed(pump.input, 702, 7, 32);
            seed(pump.input, 704, 1013, 32);     // the counter moved 1.3 kWh over that hour
            await new Promise((r) => setTimeout(r, 7000));
            assert.equal(mainHours.length, 1);
            assert.ok(Math.abs(mainHours[0] - 1.17) < 1e-9,
                `standby is 1.3 − 0.13 = 1.17 kWh, got ${mainHours[0]}`);
        } finally {
            connection.shutdown();
        }
    } finally {
        console.log = realLog;
        await pump.close();
    }
});

test('each function is handed the pump\'s own hourly figure, without the meter being touched',
     {timeout: 40000}, async () => {
    // The allocator is good at *when* and bad at *how much* — measured crediting hot water with
    // 1.37 kWh on a day the pump's own counter moved 1.00 kWh for the whole unit. The pump's
    // hourly log is the reverse. So integrate live for the shape and correct onto the pump's
    // figure for the level, rather than stepping the meter once an hour (which would price a
    // whole hour into one interval, an hour late).
    const pump = await startPump();
    try {
        const power = reg({address: 800, name: 'power', scale: 1});
        const priority = reg({address: 802, name: 'priority'});
        const logUsed = reg({address: 804, name: 'log_hw_used', scale: 100, size: 32, internal: true});
        seed(pump.input, 800, 3600);            // 3600 W -> 1 kWh/h integrated
        seed(pump.input, 802, 20);              // hot water
        seed(pump.input, 804, 10, 32);          // pump says 0.10 kWh for the completed hour

        const profile = makeProfile({
            registers: [power, priority, logUsed],
            role: {
                priorityRegisterName: 'priority', priorityRawOff: 10,
                powerSources: [['power']], producedRegisterForRole: {},
                priorityToRole: {10: 'main', 20: 'hotwater'}
            },
            transport: {port: 502, unitId: 1},
            energyLog: [{name: 'log_hw_used', label: 'hot water used', role: 'hotwater', flow: 'used'}],
            detection: {plausible: {}, discoveryProbe: {address: 1, scale: 10, min: -60, max: 60}},
            compose: {capabilities: [], capabilitiesOptions: {}, actions: [], conditions: [], triggers: []}
        });

        // A subscriber that mirrors the device's correction so the arithmetic can be observed.
        class EnergySub extends FakeSub {
            total = 0;
            hours: {used?: number}[] = [];
            onEnergy(kwh: number, watts: number) { super.onEnergy(kwh, watts); this.total += kwh; }
            onEnergyLogHour(used?: number) { this.hours.push({used}); }
        }
        const hw = new EnergySub('hotwater', []);
        hw.debug = true;
        const connection = PumpConnection.get('127.0.0.1', profile, {port: pump.port, unitId: 1});
        connection.attach(hw);
        try {
            await hw.whenUp();
            await new Promise((r) => setTimeout(r, 7000));   // baseline poll
            seed(pump.input, 804, 25, 32);                   // first step: aligns, not reported
            await new Promise((r) => setTimeout(r, 7000));
            seed(pump.input, 804, 40, 32);                   // a real completed hour: 0.40 kWh
            await new Promise((r) => setTimeout(r, 7000));

            assert.ok(hw.hours.length >= 1, 'the function must be handed its own hourly figure');
            assert.equal(hw.hours[hw.hours.length - 1].used, 0.40,
                'and it must be that role\'s own kWh for the hour, straight from the pump');

            // Observation only: the meter must be untouched by this. Every increment stays
            // non-negative and nothing scales it, because the size of the attribution error is
            // still being measured rather than corrected.
            for (const e of hw.energy)
                assert.ok(e.kwh >= 0, `a negative increment (${e.kwh}) would rewind the meter`);
        } finally {
            connection.shutdown();
        }
    } finally {
        await pump.close();
    }
});

test('a full queue of unanswered registers is bounded by the poll deadline', {timeout: 5000}, async () => {
    const sockets: net.Socket[] = [];
    const server = new net.Server((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const registers = Array.from({length: 100}, (_,i) => reg({address: i, name: `r${i}`}));
    const connection = PumpConnection.get('127.0.0.1', tinyProfile(registers), {port, unitId: 1});
    const sub = new FakeSub('main', registers);
    (connection as any).pollDeadlineMs = 100;
    connection.attach(sub);
    try {
        await sub.whenUp();
        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.equal(connection.isConnected(), false);
        assert.ok(sub.downCount >= 1);
        assert.equal(sub.raws.length, 0);
        assert.equal((connection as any).wireLow.length, 0);
        assert.equal((connection as any).polling, false);
    } finally {
        connection.shutdown();
        sockets.forEach((socket) => socket.destroy());
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test('live detection preserves sensor choices and uses the shared wire queue', {timeout: 35000}, async () => {
    const pump = await startPump();
    const sensor = reg({address: 10, name: 'room', scale: 10,
        altPlausible: {min: 5, max: 40}, sources: [
            {address: 10, label: {en: 'Zone', sv: 'Zon'}},
            {address: 20, label: {en: 'Sensor', sv: 'Givare'}}
        ]});
    seed(pump.input, 10, 210);
    seed(pump.input, 20, 220);
    const connection = PumpConnection.get('127.0.0.1', tinyProfile([sensor]), {port: pump.port, unitId: 1});
    const sub = new FakeSub('heating', [sensor]);
    connection.attach(sub);
    try {
        await sub.whenUp();
        const internal = connection as any;
        const original = internal.withWireAccess.bind(connection);
        let queued = 0;
        internal.withWireAccess = (...args: any[]) => { queued++; return original(...args); };
        const result = await connection.probe(() => {});
        assert.deepEqual(result.choices.room.map((choice) => choice.address), [10, 20]);
        assert.equal(result.addresses.room, 10);
        assert.ok(queued >= 7, 'five sample passes and both source reads must use the queue');
    } finally {
        connection.shutdown();
        await pump.close();
    }
});

test('the F profile reads the same sensor through both gateway address modes', {timeout: 15000}, async () => {
    const {fProfile} = await import('../drivers/nibe_f/profile');
    const pump = await startPump();
    const outdoor = fProfile.registers.find((r) => r.address === 40004)!;
    try {
        seed(pump.holding, 40004, 215);
        seed(pump.holding, 3, 182);
        for (const [addressBase, expected] of [[0, 215], [fProfile.addressModes!.nibegw.addressBase, 182]]) {
            await withConnection(fProfile, {port: pump.port, unitId: 1, addressBase},
                new FakeSub('main', []), async (c) => {
                    assert.equal(await c.readRegisterRaw(outdoor), expected);
                    assert.match(c.describeLastRead(outdoor.name), new RegExp(`FC3 address=${40004 - addressBase} `));
                    await assert.rejects(c.writeRegisterValue(outdoor, 0), /read-only/);
                });
        }
    } finally { await pump.close(); }
});

// ---- Unreachable pumps: backoff, quiet logging, one down per reason, the search ----

// Records why the devices were marked down, in order.
class ProblemSub extends FakeSub {
    problems: string[] = [];
    searches = 0;
    search: () => Promise<void> = async () => {};
    onConnectionDown(problem?: string) { super.onConnectionDown(); this.problems.push(String(problem)); }
    async searchForPump() { this.searches += 1; await this.search(); }
}

// A port nothing is listening on, so a connect is refused at once.
async function closedPort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

async function captureLogs<T>(fn: (logs: string[]) => Promise<T>): Promise<T> {
    const logs: string[] = [];
    const realLog = console.log;
    console.log = (...args: any[]) => { logs.push(args.join(' ')); };
    try { return await fn(logs); } finally { console.log = realLog; }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a pump that is not there is retried with backoff, logged once and marked down once, then recovers',
     {timeout: 15000}, async () => {
    const port = await closedPort();
    await captureLogs(async (logs) => {
        const a = reg({address: 1, name: 'reg_a'});
        const sub = new ProblemSub('main', [a]);
        const connection = PumpConnection.get('127.0.0.1', tinyProfile([a]), {port, unitId: 1});
        Object.assign(connection as any, {retryDelaysMs: [20, 40, 80], searchAfterMs: 60_000});
        connection.attach(sub);
        let pump: Pump | undefined;
        try {
            await sleep(700);
            const failed = (connection as any).failedAttempts;
            // 20 + 40 + 80 + 80 … — a fixed 20 ms would have tried ~30 times by now.
            assert.ok(failed >= 4 && failed <= 12, `backoff should slow retries; ${failed} attempts`);
            assert.deepEqual(sub.problems, ['connecting', 'refused'],
                'down once, with the reason — not once per failed attempt');
            assert.equal(logs.filter((l) => l.includes('Cannot connect: connect ECONNREFUSED')).length, 1,
                `one line per outage, not per attempt: ${JSON.stringify(logs)}`);

            pump = await startPump(16, port);
            await sub.whenUp();
            assert.ok(logs.some((l) => /Reconnected after \d+ s and \d+ failed attempt/.test(l)),
                'the recovery is logged alongside the failure it closes');
            assert.equal((connection as any).failedAttempts, 0);
        } finally {
            connection.shutdown();
            await pump?.close();
        }
    });
});

test('a connect nothing answers is abandoned by the connect timeout', {timeout: 10000}, async (t) => {
    // TEST-NET-1: routable, never answered. Without a route the kernel fails it at once instead.
    await captureLogs(async (logs) => {
        const a = reg({address: 1, name: 'reg_a'});
        const sub = new ProblemSub('main', [a]);
        const connection = PumpConnection.get('192.0.2.1', tinyProfile([a]), {port: 502, unitId: 1});
        Object.assign(connection as any, {connectTimeoutMs: 200, retryDelaysMs: [60_000]});
        // The first socket was opened by the constructor with the default timeout; start over.
        (connection as any).openSocket();
        connection.attach(sub);
        try {
            await sleep(800);
            const line = logs.find((l) => l.includes('Cannot connect'));
            if (line && !line.includes('timed out')) {
                t.skip(`no route to TEST-NET-1 here: ${line}`);
                return;
            }
            assert.ok(line?.includes('connect timed out'),
                `expected the connect timeout to fire; got ${JSON.stringify(logs)}`);
            assert.deepEqual(sub.problems, ['connecting', 'unreachable']);
        } finally {
            connection.shutdown();
        }
    });
});

test('a long outage asks main to search for the pump, once per window, and restores the reason after',
     {timeout: 15000}, async () => {
    const port = await closedPort();
    await captureLogs(async (logs) => {
        const a = reg({address: 1, name: 'reg_a'});
        const main = new ProblemSub('main', [a]);
        const heating = new ProblemSub('heating', [a]);
        let release!: () => void;
        main.search = () => new Promise<void>((resolve) => { release = resolve; });
        const connection = PumpConnection.get('127.0.0.1', tinyProfile([a]), {port, unitId: 1});
        Object.assign(connection as any, {retryDelaysMs: [20], searchAfterMs: 50, searchEveryMs: 60_000});
        connection.attach(heating);
        connection.attach(main);
        try {
            await sleep(300);
            assert.equal(main.searches, 1, 'main searches once the outage is long enough');
            assert.equal(heating.searches, 0, 'one search per pump, not per device');
            assert.equal(main.problems[main.problems.length - 1], 'searching');
            release();
            await sleep(300);
            assert.equal(main.searches, 1, 'not again inside the window');
            assert.deepEqual(heating.problems, ['connecting', 'refused', 'searching', 'refused']);

            // A search that fails is logged, never thrown into the retry loop.
            main.search = async () => { throw new Error('sweep broke'); };
            (connection as any).lastSearch = 0;
            await sleep(200);
            assert.ok(logs.some((l) => l.includes('Searching for the pump failed: sweep broke')));
            assert.equal(connection.isConnected(), false);
        } finally {
            connection.shutdown();
        }
    });
});
