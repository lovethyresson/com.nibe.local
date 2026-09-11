import {test} from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import {sProfile} from '../drivers/nibe_s/profile';
import {Dir, encodeRegisterValue, Register} from '../lib/registers';
import {PumpConnection} from '../lib/connection';
import {HOTWATER_VOLUME_CAPABILITY, FUNCTION_COP_CAPABILITY} from '../lib/roles';
import {sampleRegisters} from '../lib/detection';

// Exercise the real device/driver methods. Only the Homey runtime boundary is mocked.
const loader = Module as any;
const originalLoad = loader._load;
class HomeyBase {
    homey = {flow: {getDeviceTriggerCard: () => ({trigger: async () => {}})}};
}
let DeviceClass: any;
let DriverClass: any;
try {
    loader._load = function (id: string, ...args: any[]) {
        return id === 'homey' ? {Device: HomeyBase, Driver: HomeyBase}
            : originalLoad.call(this, id, ...args);
    };
    DeviceClass = require('../lib/device').NibePumpDevice;
    DriverClass = require('../lib/driver').NibePumpDriver;
} finally {
    loader._load = originalLoad;
}
const register = (name: string, extra: Partial<Register> = {}): Register => ({
    name, address: 1, direction: Dir.In, group: 'core', info: {en: name, sv: name}, ...extra
});
function device() {
    const d = new DeviceClass();
    const caps = new Map<string, any>();
    const store = new Map<string, any>();
    Object.assign(d, {
        profile: sProfile, role: 'hotwater',
        hasCapability: () => true,
        getCapabilityValue: (name: string) => caps.get(name),
        setCapabilityValue: async (name: string, value: any) => { caps.set(name, value); },
        getStoreValue: (name: string) => store.get(name),
        setStoreValue: async (name: string, value: any) => { store.set(name, value); },
        setUnavailable: async () => {}, setSettings: async () => {},
        log: () => {}, error: () => {}, noteExternalChange: () => {},
        homey: {__: (key: string) => key, i18n: {getLanguage: () => 'en'}}
    });
    return {d, caps, store};
}

test('operating-mode Flows use raw ids and accept saved legacy labels', async () => {
    const driver = new DriverClass();
    const cards = new Map<string, any>();
    const get = (id: string) => {
        if (!cards.has(id)) cards.set(id, {
            registerArgumentAutocompleteListener(_name: string, fn: any) { this.autocomplete = fn; return this; },
            registerRunListener(fn: any) { this.run = fn; return this; }
        });
        return cards.get(id);
    };
    const mode = sProfile.registerByName['operating_mode_NIBE.h237_operating_mode'];
    Object.assign(driver, {
        profile: sProfile,
        actionSpecs: Object.fromEntries(sProfile.compose.actions.map((a: any) => [a.id, a])),
        conditionSpecs: Object.fromEntries(sProfile.compose.conditions.map((a: any) => [a.id, a])),
        homey: {__: (key: string) => key, flow: {
            getActionCard: (id: string) => get('action:' + id),
            getConditionCard: (id: string) => get('condition:' + id),
            getDeviceTriggerCard: (id: string) => get('trigger:' + id)
        }},
        tracked: (_kind: any, _card: any, _reg: any, fn: any) => fn,
        registerAutofillFlow: () => {}, log: () => {}
    });
    driver.registerFlows();
    const action = get('action:' + mode.name + '.enum');
    const condition = get('condition:' + mode.name + '.enum');
    const choices = await action.autocomplete('');
    assert.deepEqual(choices.map((c: any) => c.id), ['0', '1', '2']);
    const writes: number[] = [];
    const target = {
        getName: () => 'Pump', hasCapability: () => true,
        getCapabilityValue: () => '1',
        writeRegister: async (r: Register, value: any) => { writes.push(encodeRegisterValue(r, value)); }
    };
    for (const option of [{id: '1', name: 'Manual'}, {id: 'Manual', name: 'Manuell'}]) {
        await action.run({device: target, mode: option});
        assert.equal(await condition.run({device: target, mode: option}), true);
    }
    assert.deepEqual(writes, [1, 1]);
    assert.equal(await condition.run({device: target, mode: choices[0]}), false);
});

test('invalid values never reach the device write transport; confirmations use canonical values', async () => {
    const {d} = device();
    const mode = sProfile.registerByName['operating_mode_NIBE.h237_operating_mode'];
    const writes: number[] = [];
    d.connection = {
        writeRegisterValue: async (_r: Register, raw: number) => { writes.push(raw); },
        readRegisterRaw: async () => 1
    };
    d.setValue = async () => {};
    await d.writeRegister(mode, 'Manual');
    assert.deepEqual(writes, [1]);
    await assert.rejects(d.writeRegister(mode, 'Manual123'));
    const numeric = register('temperature', {direction: Dir.Out, min: 5, max: 30, scale: 10});
    for (const value of [NaN, Infinity, null, '20', 31])
        await assert.rejects(d.writeRegister(numeric, value));
    assert.deepEqual(writes, [1]);
    assert.equal(encodeRegisterValue(register('signed', {scale: 10, size: 32}), -35), 4294966946);
    d.connection.readRegisterRaw = async () => 0;
    await assert.rejects(d.writeRegister(mode, 'Manual'), /did not confirm/);
});

test('disconnect excludes offline produced energy from function COP', () => {
    const {d} = device();
    const produced = sProfile.registerByName[sProfile.role.producedRegisterForRole.hotwater!];
    d.setValue = async () => {};
    d.allocationLive = true;
    d.lastProducedSeen = 100;
    d.copProducedAccum = 7;
    d.onConnectionDown();
    assert.equal(d.allocationLive, false);
    assert.equal(d.lastProducedSeen, null);
    d.onEnergy(0, 1000); // reconnect's baseline poll
    d.onRegisterRaw(produced, 110 * (produced.scale || 1));
    assert.equal(d.copProducedAccum, 7);
    d.onEnergy(0.1, 1000);
    d.onRegisterRaw(produced, 111 * (produced.scale || 1));
    assert.equal(d.copProducedAccum, 8);
});

test('hot water derives once per snapshot and discards missing sensor readings', () => {
    const {d, caps} = device();
    d.profile = {...sProfile, hotwaterTank: {...sProfile.hotwaterTank, topRegister: 'top', lowerRegister: 'lower'}};
    d.tankConfig = () => ({litres: 175, inletC: 10});
    d.noteColdWater = () => {};
    const drops: number[] = [];
    d.fireHotwaterDropped = (_previous: number, litres: number) => drops.push(litres);
    const complete = () => d.onPollComplete(new Set(['top', 'lower']));
    d.noteTankReading(register('top'), 55);
    d.noteTankReading(register('lower'), 45);
    complete();
    assert.equal(caps.get(HOTWATER_VOLUME_CAPABILITY), 233.3);
    d.noteTankReading(register('top'), 54);
    d.noteTankReading(register('lower'), 46);
    complete();
    assert.deepEqual(drops, []);
    d.onPollComplete(new Set(['top']));
    assert.equal(caps.get(HOTWATER_VOLUME_CAPABILITY), null);
    assert.equal(caps.get(FUNCTION_COP_CAPABILITY), null);
    d.noteTankReading(register('lower'), 40);
    complete();
    assert.deepEqual(drops, [], 'recovery must not cross a threshold from an old sample');
});

test('power sources reject unavailable, negative, non-finite and partial readings', () => {
    const connection: any = Object.create(PumpConnection.prototype);
    connection.powerGroups = [[register('preferred', {size: 32})], [register('fallback')]];
    connection.notePowerGroup = () => {};
    for (const raw of [0x80000000, 0xffffffff, NaN, Infinity])
        assert.equal(connection.totalWatts(new Map([['preferred', raw], ['fallback', 400]])), 400);
    connection.powerGroups = [[register('compressor'), register('addition')]];
    assert.equal(connection.totalWatts(new Map([['compressor', 500]])), null);
    assert.equal(connection.totalWatts(new Map([['compressor', 500], ['addition', 0]])), 500);
});

test('a missing power sample resets the integration baseline', () => {
    const connection: any = Object.create(PumpConnection.prototype);
    const samples: number[] = [];
    Object.assign(connection, {
        lastPowerReading: 1000, lastPollTime: Date.now() - 1000,
        profile: {role: {}}, totalWatts: () => null, notePowerAvailability: () => {},
        energySubscribers: () => [{onEnergyUnavailable: () => samples.push(-1)}]
    });
    connection.allocateEnergy(new Map());
    assert.equal(connection.lastPowerReading, null);
    assert.deepEqual(samples, [-1]);
});

test('cancelled detection stops reading and cancels its between-pass wait', async () => {
    const controller = new AbortController();
    let reads = 0;
    const profile = {...sProfile, registers: [register('test')]};
    const result = sampleRegisters(profile, async () => { reads++; return 10; },
        () => { controller.abort(); }, 5, 6000, controller.signal);
    await assert.rejects(result, /cancelled/);
    assert.equal(reads, 1);
});

test('shutdown awaits the last durable energy write', async () => {
    const {d} = device();
    let finish!: () => void;
    d.cumulativeEnergy = 1.234;
    d.setSettings = () => new Promise<void>((resolve) => { finish = resolve; });
    let done = false;
    const closing = d.onUninit().then(() => { done = true; });
    await Promise.resolve();
    assert.equal(done, false);
    finish();
    await closing;
    assert.equal(d.persistedCumulativeEnergy, 1.234);
});

test('retiring a connection rejects queued writes and ignores an old in-flight result', async () => {
    const connection: any = Object.create(PumpConnection.prototype);
    Object.assign(connection, {connected: true, destroyed: false, generation: 0,
        wireHigh: [], wireLow: [], wireRunning: false, lastRaw: new Map(), unsupportedUntil: new Map()});
    let release!: () => void;
    const running = connection.withWireAccess(() => new Promise<void>((resolve) => { release = resolve; }));
    let wrote = false;
    const queued = connection.withWireAccess(async () => { wrote = true; }, 'write');
    const stopped = assert.rejects(queued, /closed/);
    const stale = assert.rejects(running, /changed/);
    connection.invalidateWork();
    release();
    await Promise.all([stopped, stale]);
    assert.equal(wrote, false);
});

test('only explicit unsupported-register errors put background reads on cooldown', async () => {
    const connection: any = Object.create(PumpConnection.prototype);
    Object.assign(connection, {generation: 1, profile: {}, unsupportedUntil: new Map(),
        noteRead: () => {}, withWireAccess: async () => { throw {body: {code: 2}}; }});
    await connection.readRegisterRaw(register('missing'));
    assert.ok(connection.unsupportedUntil.get('missing') > Date.now());
    connection.withWireAccess = async () => { throw new Error('timeout'); };
    await connection.readRegisterRaw(register('temporary'));
    assert.equal(connection.unsupportedUntil.has('temporary'), false);
    connection.withWireAccess = async () => { throw {body: {code: 2}}; };
    await connection.readRegisterRaw(register('probe'), false);
    assert.equal(connection.unsupportedUntil.has('probe'), false);
});
