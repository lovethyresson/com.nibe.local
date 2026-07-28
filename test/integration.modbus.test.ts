import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import {ModbusTCPServer} from 'jsmodbus';

import {Dir, Register} from '../lib/registers';
import {LocalizedText, makeProfile, ModelProfile} from '../lib/profile';
import {PumpConnection, PumpSubscriber, Transport, inLanguage} from '../lib/connection';
import {Role} from '../lib/roles';

// A buffer-backed fake pump: jsmodbus serves the input/holding buffers with its built-in
// handlers, so seeding a register is just writing 2 big-endian bytes at address*2.
const REG_BYTES = 0x10000 * 2;

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
async function startPump(registerCount = 0x10000): Promise<Pump> {
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
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
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
    onConnectionDown() { this.up = false; }
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

test('a poll where nothing reads at all is not blamed on the registers',
     {timeout: 30000}, async () => {
    // A server that accepts the connection and then never answers: every read times out on
    // the same poll. That is a connection problem, and reporting it as "N registers do not
    // exist on this model" would be actively misleading.
    const sockets: net.Socket[] = [];
    const server = new net.Server((socket) => { sockets.push(socket); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;

    const logs: string[] = [];
    const realLog = console.log;
    console.log = (...args: any[]) => { logs.push(args.join(' ')); };
    try {
        const a = reg({address: 550, name: 'reg_a', scale: 1});
        const b = reg({address: 551, name: 'reg_b', scale: 1});
        const profile = tinyProfile([a, b]);
        const sub = new FakeSub('main', [a, b]);
        const connection = PumpConnection.get('127.0.0.1', profile, {port, unitId: 1});
        connection.attach(sub);
        try {
            await sub.whenUp();
            // The jsmodbus client gives up on a request after 5 s, so this covers a full poll
            // in which every single read failed.
            await new Promise((r) => setTimeout(r, 14000));
            assert.ok(!logs.some((l) => l.includes('did not read (first failure since app start)')),
                'a total loss is a connection problem and must not be blamed on the registers');
        } finally {
            connection.shutdown();
        }
    } finally {
        console.log = realLog;
        sockets.forEach((s) => s.destroy());
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
