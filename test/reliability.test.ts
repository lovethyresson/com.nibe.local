import {test} from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import {sProfile} from '../drivers/nibe_s/profile';
import {fProfile} from '../drivers/nibe_f/profile';
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
        setUnavailable: async () => {}, setSettings: async () => {}, getSettings: () => ({}),
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
    // BT50 has no standalone Flow: the automatic feed owns that input.
    assert.equal(cards.has('action:external_temperature.h5987_bt50.set'), false);
    await get('action:external_temperature.h5217_bt1.set').run({device: target, value: -12.3});
    assert.equal(writes[writes.length - 1], 65413);
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

test('external temperature commands validate, use heating only, and do not read a cleared mailbox', async () => {
    const {d} = device();
    d.role = 'heating';
    const writes: {address: number; raw: number}[] = [];
    d.connection = {
        writeRegisterValue: async (r: Register, raw: number) => { writes.push({address: r.address, raw}); },
        readRegisterRaw: async () => { throw new Error('Mailbox clears after consumption'); }
    };
    d.setValue = async () => { throw new Error('A sent reading is not a measured capability'); };
    const indoor = sProfile.registerByName['external_temperature.h5987_bt50'];
    const outdoor = sProfile.registerByName['external_temperature.h5217_bt1'];
    await d.writeRegister(indoor, 21.7);
    await d.writeRegister(outdoor, -12.3);
    assert.deepEqual(writes, [{address: 5987, raw: 217}, {address: 5217, raw: 65413}]);
    for (const value of [NaN, Infinity, null, '21.7', 4.9, 40.1])
        await assert.rejects(d.writeRegister(indoor, value));
    for (const value of [-50.1, 60.1])
        await assert.rejects(d.writeRegister(outdoor, value));
    d.role = 'hotwater';
    await assert.rejects(d.writeRegister(outdoor, 10), /not available/);
    assert.equal(writes.length, 2);
    d.role = 'heating';
    d.connection.writeRegisterValue = async () => { throw new Error('Modbus rejected'); };
    await assert.rejects(d.writeRegister(outdoor, 10), /Modbus rejected/);
});

test('disconnect excludes offline produced energy from function COP', () => {
    const {d} = device();
    const produced = sProfile.registerByName[sProfile.role.producedRegisterForRole.hotwater!];
    d.setValue = async () => {};
    d.allocationLive = true;
    d.lastProducedSeen = 100;
    d.copProducedAccum = 7;
    d.onConnectionDown('unreachable');
    assert.equal(d.allocationLive, false);
    assert.equal(d.lastProducedSeen, null);
    d.onEnergy(0, 1000); // reconnect's baseline poll
    d.onRegisterRaw(produced, 110 * (produced.scale || 1));
    assert.equal(d.copProducedAccum, 7);
    d.onEnergy(0.1, 1000);
    d.onRegisterRaw(produced, 111 * (produced.scale || 1));
    assert.equal(d.copProducedAccum, 8);
});

test('F-series production feeds the shared rolling COP over the same observed span', () => {
    const {d, caps, store} = device();
    d.profile = fProfile;
    d.setValue = async () => {};
    d.noteTankReading = () => {};
    d.role = 'hotwater';
    const produced = fProfile.registerByName[fProfile.role.producedRegisterForRole.hotwater!];
    d.onEnergy(0, 1000);
    d.onRegisterRaw(produced, 5000);
    store.set('copSamples', [{t: Date.now(), p: 0, u: 0}]);
    d.onEnergy(1, 1000);
    d.onRegisterRaw(produced, 5025); // 2.5 kWh delivered, 1 kWh covered electricity
    d.onPollComplete(new Set([produced.name]));
    assert.equal(caps.get(FUNCTION_COP_CAPABILITY), 2.5);
    d.onPollComplete(new Set());
    assert.equal(caps.get(FUNCTION_COP_CAPABILITY), null);
});

test('saved nibegw devices and discovery both resolve the corrected wire address', () => {
    const {d} = device(); d.profile = fProfile;
    assert.equal(d.transport({addressMode: 'nibegw', port: 502, unitId: 1}).addressBase, 40001);
    assert.equal(d.transport({addressMode: 'modbus40', port: 502, unitId: 1}).addressBase, 0);
    const driver = new DriverClass(); driver.profile = fProfile;
    assert.equal(driver.discoveryOptions({addressMode: 'nibegw'}).probeAddress, 3);
    assert.equal(driver.discoveryOptions({addressMode: 'modbus40'}).probeAddress, 40004);
    assert.equal(d.transport({addressMode: 'offset40000', port: 502, unitId: 1}).addressBase, 40000);
    assert.equal(driver.discoveryOptions({addressMode: 'offset40000'}).probeAddress, 4);
});

test('F write verification gives a cached reply time to refresh', async () => {
    const {d} = device();
    assert.equal(fProfile.writeReadbackIntervalMs, 2100);
    d.profile = {...fProfile, writeReadbackIntervalMs: 30}; d.role = 'heating';
    d.connection = {writeRegisterValue: async () => {}};
    const times: number[] = [];
    d.readRegister = async (r: Register) => {
        times.push(Date.now()); return d.fromRegisterValue(r, times.length === 1 ? 0 : 1);
    };
    d.setValue = async () => {};
    await d.writeRegister(fProfile.registerByName['curve_displacement_NIBE.h47011_curve_offset'], 1);
    assert.equal(times.length, 2); assert.ok(times[1] - times[0] >= 25);
});

test('F controls reject inactive room control and wrong operating mode before writing', async () => {
    const {d} = device(); d.profile = fProfile; d.role = 'heating';
    const writes: any[] = [];
    d.connection = {writeRegisterValue: async (...args: any[]) => writes.push(args)};
    const values = new Map<string, any>([['measure_temperature', 21],
        ['boolean_NIBE.h47394_room_control', false], ['operating_mode_NIBE.h47137_mode', '0']]);
    d.readRegister = async (r: Register) => values.get(r.name);
    await assert.rejects(d.writeRegister(fProfile.registerByName[fProfile.roomThermostat!.target], 22), /disabled/);
    await assert.rejects(d.writeRegister(fProfile.registerByName['boolean_NIBE.h47371_allow_heating'], false), /Auto/);
    values.delete('measure_temperature');
    await assert.rejects(d.writeRegister(fProfile.registerByName[fProfile.roomThermostat!.enabled], true), /indoor sensor/);
    assert.equal(writes.length, 0);
});

test('F live room state switches between heater and thermostat and wires the new dial', async () => {
    const {d, caps, store} = device();
    d.profile = fProfile; d.role = 'heating';
    let deviceClass = 'heater';
    const listeners = new Map();
    Object.assign(d, {getClass: () => deviceClass, setClass: async (value: string) => { deviceClass = value; },
        getCapabilities: () => [...caps.keys()], hasCapability: (name: string) => caps.has(name),
        addCapability: async (name: string) => { caps.set(name, null); },
        removeCapability: async (name: string) => { caps.delete(name); },
        ensureCapabilityOptions: async () => {}, debug: () => {},
        registerCapabilityListener: (name: string, fn: any) => listeners.set(name, fn)});
    const cfg = fProfile.roomThermostat!;
    const raw = new Map([[cfg.sensor, 210], [cfg.enabled, 1], [cfg.target, 220]]);
    d.connection = {lastRawFor: (name: string) => raw.get(name)};
    store.set('selection', {groups: {heating: true, energy: false}, overrides: {}});
    d.onPollComplete(new Set(raw.keys())); await d.thermostatSync;
    assert.equal(deviceClass, 'thermostat');
    assert.equal(caps.has('target_temperature'), true);
    assert.equal(typeof listeners.get('target_temperature'), 'function');
    raw.set(cfg.enabled, 0);
    d.onPollComplete(new Set(raw.keys())); await d.thermostatSync;
    assert.equal(deviceClass, 'heater');
    assert.equal(caps.has('target_temperature'), false);
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
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(done, false);
    finish();
    await closing;
    assert.equal(d.persistedCumulativeEnergy, 1.234);
});

test('retiring a connection rejects queued writes and ignores an old in-flight result', async () => {
    const connection: any = Object.create(PumpConnection.prototype);
    Object.assign(connection, {connected: true, destroyed: false, generation: 0,
        wireHigh: [], wireLow: [], wireRunning: false, lastRaw: new Map(), unsupportedUntil: new Map(), backgroundAttempted: new Map()});
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
    Object.assign(connection, {generation: 1, profile: {}, transport: {},
        readDiagnostics: new Map(), captureCounts: new Map(), unsupportedUntil: new Map(),
        noteRead: () => {}, withWireAccess: async () => { throw {body: {code: 2}}; }});
    await connection.readRegisterRaw(register('missing'));
    assert.ok(connection.unsupportedUntil.get('missing') > Date.now());
    connection.withWireAccess = async () => { throw {body: {code: 4}}; };
    await connection.readRegisterRaw(register('warming'));
    assert.equal(connection.unsupportedUntil.has('warming'), false);
    connection.withWireAccess = async () => { throw new Error('timeout'); };
    await connection.readRegisterRaw(register('temporary'));
    assert.equal(connection.unsupportedUntil.has('temporary'), false);
    connection.withWireAccess = async () => { throw {body: {code: 2}}; };
    await connection.readRegisterRaw(register('probe'), false);
    assert.equal(connection.unsupportedUntil.has('probe'), false);
});

function indoorDevice() {
    const {d, store} = device();
    d.role = 'heating';
    d.getSettings = () => ({address: 'test-indoor-pump'});
    d.driver = {getDevices: () => [d]};
    d.unsetWarning = async () => {};
    d.unsetStoreValue = async (key: string) => { store.delete(key); };
    d.applySelection = async (s: any) => { store.set('selection', s); };
    store.set('selection', {groups: {heating: true}, overrides: {}, addresses: {measure_temperature: 111}});
    d.indoorRaw = async (address: number) => address === 5986 ? 1 : 220;
    d.readIndoorSensors = async () => [{deviceId: 'room', capabilityId: 'measure_temperature',
        value: 22, available: true, updatedAt: Date.now()}];
    const config = {sensors: [{deviceId: 'room', capabilityId: 'measure_temperature'}], maxAgeMinutes: 120};
    return {d, store, config};
}
test('initial BT50 verification failure leaves a durable retry owner, without claiming confirmed delivery', async (t) => {
    const {d, store, config} = indoorDevice();
    t.after(() => d.stopIndoor());
    d.sendIndoor = async () => {
        assert.equal(store.get('indoorSensors').state, 'active');
        throw new Error('BT50 has not confirmed');
    };
    await assert.rejects(d.activateIndoor(config), /not confirmed/);
    assert.equal(store.get('indoorSensors').state, 'active');
    assert.ok(d.indoorTimer);
    assert.notEqual(d.indoorStatus.state, 'active');
    assert.equal(store.get('selection').addresses.measure_temperature, 111);
});
test('replacement validation failure keeps the previous sensor selection and excludes competing writers', async (t) => {
    const {d, store, config} = indoorDevice(); t.after(() => d.stopIndoor());
    const previous = {...config, state: 'active', sensors: [{deviceId: 'previous', capabilityId: 'measure_temperature'}]};
    store.set('indoorSensors', previous);
    d.sendIndoor = async () => { throw new Error('No readback'); };
    await assert.rejects(d.activateIndoor(config), /No readback/);
    assert.deepEqual(store.get('indoorSensors'), previous);
    await assert.rejects(d.writeRegister(sProfile.registerByName['external_temperature.h5987_bt50'], 22), /automatic/);
});
test('BT50 activation uses effective input readback and preserves the native source for manual handover', async (t) => {
    const {d, store, config} = indoorDevice(); t.after(() => d.stopIndoor());
    const writes: any[] = [];
    d.connection = {writeRegisterValue: async (r: Register, value: number) => { writes.push([r.address, value]); }};
    const status = await d.activateIndoor(config);
    assert.deepEqual(writes, [[5987, 220]]);
    assert.equal(status.measured, 22);
    assert.equal(store.get('selection').addresses.measure_temperature, 26);
    assert.equal(store.get('indoorNativeAddress'), 111);
    await assert.rejects(d.deactivateIndoor(), /disable external/);
    assert.equal(store.get('indoorSensors').state, 'active');
    d.indoorRaw = async () => 0;
    await d.deactivateIndoor();
    assert.equal(store.get('indoorSensors'), undefined);
    assert.equal(store.get('selection').addresses.measure_temperature, 111);
    assert.equal(d.indoorTimer, null);
});
test('simultaneous Heating devices cannot both activate the same pump', async (t) => {
    const first = indoorDevice(); const second = indoorDevice();
    t.after(async () => { await first.d.stopIndoor(); await second.d.stopIndoor(); });
    first.d.sendIndoor = async () => ({measured: 22});
    const starting = first.d.activateIndoor(first.config);
    await assert.rejects(second.d.activateIndoor(second.config), /already supplies/);
    await starting;
});

test('BT50 verification allows delayed effective readback beyond the original three-second window', async (t) => {
    const {d, config} = indoorDevice(); t.after(() => d.stopIndoor());
    let reads = 0;
    d.connection = {writeRegisterValue: async () => {}};
    d.indoorRaw = async (address: number) => address === 5986 ? 1 : (++reads < 5 ? 234 : 220);
    const result = await d.activateIndoor(config);
    assert.equal(reads, 5);
    assert.equal(result.measured, 22);
});

test('BT50 repeatedly sends unchanged readings older than the legacy age limit', async (t) => {
    const {d, config} = indoorDevice(); t.after(() => d.stopIndoor());
    const writes: number[] = [];
    d.connection = {writeRegisterValue: async (_r: Register, value: number) => { writes.push(value); }};
    d.readIndoorSensors = async () => [{deviceId: 'room', capabilityId: 'measure_temperature',
        value: 22, available: true, updatedAt: Date.now() - 24 * 3600000}];
    await d.activateIndoor(config);
    await d.sendIndoor(config);
    assert.deepEqual(writes, [220, 220]);
    d.readIndoorSensors = async () => [{deviceId: 'room', capabilityId: 'measure_temperature',
        value: 22, available: false, updatedAt: Date.now()}];
    await assert.rejects(d.sendIndoor(config), /unavailable/);
    assert.deepEqual(writes, [220, 220]);
});

test('S and F controls decode to Homey capability types and picker ids take precedence over labels', () => {
    const {d} = device();
    for (const profile of [sProfile, fProfile]) {
        d.profile = profile;
        for (const r of profile.registers.filter((r) => r.bool || r.picker || r.enum)) {
            const raw = r.picker ? r.pickerValues![0] : r.enum ? Number(Object.keys(r.enum)[0]) : 0;
            const value = d.fromRegisterValue(r, raw);
            assert.equal(typeof value, r.bool ? 'boolean' : 'string', r.name);
            if (r.picker)
                for (const id of r.pickerValues!)
                    assert.equal(d.fromRegisterValue(r, id), String(id), r.name);
            if (r.bool) {
                assert.equal(d.fromRegisterValue(r, r.offValue ?? 0), false, r.name);
                assert.equal(d.fromRegisterValue(r, r.onValue ?? 1), true, r.name);
            }
        }
    }
    d.profile = fProfile;
    const solar = fProfile.registerByName['meter_power.solar'];
    assert.equal(d.fromRegisterValue(solar, 0xffff8000), null);
    assert.equal(d.fromRegisterValue(solar, 12345), 1234.5);
    const temp = fProfile.registers.find((r) => r.address === 40004);
    assert.equal(d.fromRegisterValue(temp, 161), 16.1);
});

test('debug toggles use new settings immediately across the pump while Homey still returns old settings', async () => {
    const {d} = device(); const {d: sibling} = device(); const {d: other} = device();
    const settings = {address: 'pump-a', debugLogging: false};
    const siblingSettings = {...settings};
    d.getSettings = () => settings;
    sibling.getSettings = () => siblingSettings;
    other.getSettings = () => ({address: 'pump-b', debugLogging: true});
    sibling.setSettings = async (next: any) => { await Promise.resolve(); Object.assign(siblingSettings, next); };
    d.driver = {getDevices: () => [d, sibling, other]};
    let dumps = 0;
    d.dumpRegisters = async () => { assert.equal(d.debugEnabled(), true); dumps++; };
    const logs: string[] = [];
    const c: any = Object.create(PumpConnection.prototype);
    Object.assign(c, {subscribers: new Set([d, sibling]), debugOn: false,
        captureCounts: new Map(), transport: {port: 502, unitId: 1}, profile: fProfile,
        log: (s: string) => logs.push(s), logStandingFailures: () => {}});
    d.connection = c;
    const toggle = async (on: boolean) => {
        await d.onSettings({oldSettings: {...settings}, newSettings: {...settings, debugLogging: on},
            changedKeys: ['debugLogging']});
        // Homey commits the initiating device only after its callback completes.
        assert.equal(c.debugOn, on);
        assert.equal(d.debugEnabled(), on);
        assert.equal(sibling.debugEnabled(), on);
        assert.equal(other.debugEnabled(), true);
        settings.debugLogging = on;
    };
    await toggle(true);
    assert.equal(dumps, 1);
    assert.equal(logs.filter((s) => s.startsWith('Read capture started')).length, 1);
    await toggle(false);
    assert.equal(dumps, 1);
    assert.equal(logs.filter((s) => s.startsWith('Read capture started')).length, 1);
    await toggle(true);
    assert.equal(dumps, 2);
    assert.equal(logs.filter((s) => s.startsWith('Read capture started')).length, 2);
    const {d: restarted} = device(); restarted.getSettings = () => settings;
    assert.equal(restarted.debugEnabled(), true, 'restart uses the saved setting');
});

// The driver whitelist is the boundary that can drop a saved tank during Repair.
test('selection cleaning carries the saved tank through unrelated feature changes', () => {
    const driver = new DriverClass(); driver.profile = sProfile;
    const hotwater = {tankId: 'vpb300', litres: 276, inletC: 12};
    const selection = driver.cleanSelection({groups: {hotwater: true, cooling: false}, hotwater});
    const repaired = driver.cleanSelection({...selection, groups: {...selection.groups, cooling: true}});
    assert.deepEqual(repaired.hotwater, hotwater);
    assert.equal(repaired.groups.cooling, true);
});

test('production source changes cannot add unrelated lifetime totals or consume stale replies', () => {
    const {d, store} = device();
    d.profile = fProfile;
    d.role = 'heating';
    d.setValue = async () => {};
    const original = fProfile.registerByName[fProfile.role.producedRegisterForRole.heating!];
    const alternate = {...original, address: 44300};
    store.set('selection', {groups: {}, overrides: {}, addresses: {}});
    d.allocationLive = true;
    d.onRegisterRaw(original, 1000);
    d.onRegisterRaw(original, 1010);
    assert.equal(d.copProducedAccum, 1);
    store.set('selection', {groups: {}, overrides: {}, addresses: {[original.name]: 44300}});
    d.onRegisterRaw(alternate, 266604);
    assert.equal(d.copProducedAccum, 1, 'lifetime source difference is not new production');
    assert.equal(d.applyBaseline(alternate, 26660.4), 0);
    d.onRegisterRaw(original, 1020);
    assert.equal(d.lastProducedSeen, 26660.4, 'old in-flight reply cannot reset the new baseline');
    d.onRegisterRaw(alternate, 266614);
    assert.equal(d.copProducedAccum, 2);
    store.set('selection', {groups: {}, overrides: {}, addresses: {}});
    d.onRegisterRaw(original, 1030);
    assert.equal(d.copProducedAccum, 2, 'returning to an earlier source also starts a new interval');
    assert.equal(d.applyBaseline(original, 103), 3, 'existing canonical display baseline is preserved');
});

test('diagnostic retention is confined to Main and survives the Homey store boundary', async () => {
    const {d, store} = device();
    const snapshot = {startedAt: '2026-09-23T00:00:00Z', stopped: true,
        completed: 2, expected: 2, registers: []};
    d.onDiagnosticSummary(snapshot);
    assert.equal(store.get('fDiagnosticSummary'), undefined);
    d.role = 'main';
    d.onDiagnosticSummary(snapshot);
    assert.deepEqual(store.get('fDiagnosticSummary'), snapshot);
});

// ---- Moving a pump to another address ----

// A pump's devices on the Homey side, with a driver that owns them and the app's driver list.
function pumpAt(address: string, others: any[] = []) {
    const driver = new DriverClass();
    const devices: any[] = [];
    const make = (role: string, at = address) => {
        const {d, store} = device();
        const settings: any = {address: at, heatpump_type: '15'};
        d.role = role;
        d.getSettings = () => settings;
        d.setSettings = async (next: any) => { d.written.push(next); Object.assign(settings, next); };
        d.written = [] as any[];
        d.moves = [] as any[];
        d.reconnectTo = (to: string, from: string, s?: any) => { d.moves.push({to, from, s}); };
        d.driver = driver;
        devices.push(d);
        return {d, store, settings};
    };
    const notices: string[] = [];
    Object.assign(driver, {
        profile: sProfile, getDevices: () => [...devices, ...others], log: () => {}, error: () => {},
        homey: {
            __: (key: string, args?: any) => args ? `${key} ${JSON.stringify(args)}` : key,
            drivers: {getDrivers: () => ({nibe_s: driver})},
            cloud: {getLocalAddress: async () => '192.168.1.5:80'},
            notifications: {createNotification: async ({excerpt}: any) => { notices.push(excerpt); }}
        }
    });
    return {driver, make, notices};
}

test('changing one device\'s address moves the whole pump, never onto another pump\'s address', async () => {
    const {make} = pumpAt('192.168.1.29');
    const {d: main} = make('main');
    const {d: heating, store: heatingStore} = make('heating');
    const {d: other} = make('main', '192.168.1.60');

    await main.onSettings({oldSettings: {address: '192.168.1.29'}, newSettings: {address: '192.168.1.40'},
        changedKeys: ['address']});
    assert.deepEqual(heating.written, [{address: '192.168.1.40'}], 'the sibling follows');
    assert.deepEqual(main.written, [], 'Homey saves the edited device itself after onSettings');
    assert.deepEqual(main.moves.map((m: any) => m.to), ['192.168.1.40']);
    assert.equal(main.moves[0].s.address, '192.168.1.40', 'reconnects with the settings being saved');
    assert.deepEqual(heating.moves.map((m: any) => [m.from, m.to]), [['192.168.1.29', '192.168.1.40']]);
    assert.deepEqual(other.moves, [], 'another pump is left alone');

    main.getSettings().address = '192.168.1.40';
    main.moves = []; heating.moves = [];
    await assert.rejects(main.onSettings({oldSettings: {address: '192.168.1.40'},
        newSettings: {address: '192.168.1.60'}, changedKeys: ['address']}), /connection\.address_in_use/);
    assert.deepEqual([...main.moves, ...heating.moves], [], 'a refused move touches nothing');

    // The BT50 feed lives on Heating, but editing Main moves Heating too.
    heatingStore.set('indoorSensors', {state: 'active'});
    await assert.rejects(main.onSettings({oldSettings: {address: '192.168.1.40'},
        newSettings: {address: '192.168.1.41'}, changedKeys: ['address']}), /Return to your NIBE sensor/);
});

test('a pump that moved is followed only when exactly one unpaired pump of its model answers', async () => {
    const {driver, make, notices} = pumpAt('192.168.1.29');
    const {d: main} = make('main');
    const {d: heating} = make('heating');
    const transport = {port: 502, unitId: 1};
    let answer: any[] = [];
    const sweeps: any[] = [];
    driver.sweep = async (local: string, exclude: Set<string>, options: any) => {
        sweeps.push({local, exclude: [...exclude], options});
        return answer;
    };

    answer = [{address: '192.168.1.40', identity: 15}, {address: '192.168.1.41', identity: 15}];
    assert.equal(await driver.relocatePump('192.168.1.29', transport), undefined);
    assert.deepEqual(main.written, [], 'two candidates: nothing moves');
    assert.ok(sweeps[0].exclude.includes('192.168.1.29'), 'paired addresses are never candidates');
    assert.equal(sweeps[0].options.identityAddress, 1497, 'the model code is read from each responder');

    answer = [{address: '192.168.1.40', identity: 15}, {address: '192.168.1.41', identity: 99}];
    assert.equal(await driver.relocatePump('192.168.1.29', transport), '192.168.1.40');
    for (const d of [main, heating]) {
        assert.deepEqual(d.written, [{address: '192.168.1.40'}]);
        assert.deepEqual(d.moves.map((m: any) => m.to), ['192.168.1.40']);
    }
    assert.equal(notices.length, 1);
    assert.match(notices[0], /connection\.moved .*192\.168\.1\.29.*192\.168\.1\.40/);
});

test('a device follows its pump to a new address, BT50 ownership included', () => {
    const {d} = device();
    const settings: any = {address: '192.168.1.40'};
    d.role = 'heating';
    d.getSettings = () => settings;
    const attached: string[] = [];
    const fake = (host: string) => ({attach: () => attached.push(`attach ${host}`),
        detach: () => attached.push(`detach ${host}`)});
    d.connection = fake('192.168.1.29');
    (DeviceClass as any).indoorOwners.set('192.168.1.29', d);
    const realGet = PumpConnection.get;
    (PumpConnection as any).get = (host: string) => fake(host);
    try {
        d.reconnectTo('192.168.1.40', '192.168.1.29');
    } finally {
        (PumpConnection as any).get = realGet;
        (DeviceClass as any).indoorOwners.delete('192.168.1.40');
    }
    assert.deepEqual(attached, ['detach 192.168.1.29', 'attach 192.168.1.40']);
    assert.equal((DeviceClass as any).indoorOwners.has('192.168.1.29'), false);
});
