import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import {ModbusTCPServer} from 'jsmodbus';

import {Dir, Register} from '../lib/registers';
import {makeProfile, ModelProfile} from '../lib/profile';
import {PumpConnection, PumpSubscriber, Transport} from '../lib/connection';
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

async function startPump(): Promise<Pump> {
    const input = Buffer.alloc(REG_BYTES);
    const holding = Buffer.alloc(REG_BYTES);
    const server = new net.Server();
    new ModbusTCPServer(server, {input, holding});
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    return {
        port, input, holding,
        close: () => new Promise<void>((resolve) => server.close(() => resolve()))
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
    private regs: Register[];
    up = false;
    energy: {kwh: number; watts: number}[] = [];
    raws: {name: string; raw: number}[] = [];
    private upResolvers: (() => void)[] = [];
    constructor(role: Role, regs: Register[]) { this.role = role; this.regs = regs; }
    wantedRegisters() { return this.regs; }
    onRegisterRaw(register: Register, raw: number) { this.raws.push({name: register.name, raw}); }
    onConnectionUp() { this.up = true; this.upResolvers.forEach((r) => r()); this.upResolvers = []; }
    onConnectionDown() { this.up = false; }
    pollSeconds() { return 5; }
    onEnergy(kwh: number, watts: number) { this.energy.push({kwh, watts}); }
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
                powerSources: ['compr_power', 'add_power'],
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
