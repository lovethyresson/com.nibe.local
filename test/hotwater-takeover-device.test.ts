/** The Hot water device taking over and giving back the pump's hot water settings, through the real
 *  writeRegister/readRegister and the S-series register encode/decode. Only the wire is faked: a
 *  holding-register map that can clamp, refuse or stop answering. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import {sProfile} from '../drivers/nibe_s/profile';
import {MAX_FAILURES} from '../lib/autopilot/hotwater-takeover';
import {LEGIONELLA_STATE_KEY} from '../lib/autopilot/hotwater-shadow';

const loader = Module as any;
const originalLoad = loader._load;
class HomeyBase {}
let DeviceClass: any;
try {
    loader._load = function (id: string, ...args: any[]) {
        return id === 'homey' ? {Device: HomeyBase, Driver: HomeyBase} : originalLoad.call(this, id, ...args);
    };
    DeviceClass = require('../lib/device').NibePumpDevice;
} finally {
    loader._load = originalLoad;
}

const DEMAND = 56, START = 60, LARGE_STOP = 62, PERIODIC = 65, INTERVAL = 66, PERIODIC_STOP = 61;

/** A pump whose holding registers hold raw values. */
function pump(raw: Record<number, number>) {
    const holding = new Map(Object.entries(raw).map(([a, v]) => [Number(a), v]));
    const wire = {
        reachable: true,
        clamp: {} as Record<number, (raw: number) => number>,
        refuse: new Set<number>(),
        writes: [] as [number, number][],
        holding,
        readRegisterRaw: async (reg: any) => wire.reachable ? holding.get(reg.address) : undefined,
        writeRegisterValue: async (reg: any, value: number) => {
            if (!wire.reachable || wire.refuse.has(reg.address)) throw new Error('Modbus exception 2');
            wire.writes.push([reg.address, value]);
            holding.set(reg.address, wire.clamp[reg.address] ? wire.clamp[reg.address](value) : value);
        },
    };
    return wire;
}

function device(wire: ReturnType<typeof pump>, mode: string, stored: Record<string, any> = {}) {
    const d = new DeviceClass();
    const store = new Map<string, any>([['smartMode', mode], ...Object.entries(stored)]);
    const timers: number[] = [];
    const warnings: (string | undefined)[] = [];
    const notes: string[] = [];
    const errors: string[] = [];
    Object.assign(d, {
        profile: {...sProfile, writeReadbackIntervalMs: 1}, role: 'hotwater', connection: wire,
        hasCapability: () => false, getCapabilityValue: () => undefined, setCapabilityValue: async () => {},
        getStoreValue: (k: string) => store.get(k), setStoreValue: async (k: string, v: any) => { store.set(k, v); },
        unsetStoreValue: async (k: string) => { store.delete(k); },
        getSettings: () => ({address: 'pump'}), setSettings: async () => {},
        setWarning: async (text: string) => { warnings.push(text); }, unsetWarning: async () => { warnings.push(undefined); },
        getData: () => ({id: 'pump#hotwater'}), driver: {getDevices: () => [d]},
        log: () => {}, error: (...args: any[]) => { errors.push(args.join(' ')); },
        homey: {__: (k: string, tokens?: any) => tokens ? `${k} ${JSON.stringify(tokens)}` : k, i18n: {getLanguage: () => 'en'},
            setTimeout: (_fn: any, ms: number) => { timers.push(ms); return timers.length; }, clearTimeout: () => {},
            notifications: {createNotification: async (n: any) => { notes.push(n.excerpt); }}},
    });
    return {d, store, timers, warnings, notes, errors, sync: () => d.syncHotwaterTakeover()};
}

const OWNER = {[DEMAND]: 1, [START]: 420, [PERIODIC]: 1, [LARGE_STOP]: 580, [INTERVAL]: 14, [PERIODIC_STOP]: 600};

test('a takeover cut short by a restart is finished, and what was already done is only recorded', async () => {
    const wire = pump({...OWNER, [DEMAND]: 0, [START]: 50});
    // Saved before the restart: 56 confirmed; 60 written but not yet recorded; 65 never written.
    const f = device(wire, 'autopilot', {hotwaterOwnerSettings: {owner: {demandMode: 1, startSmallC: 42, periodic: true}, wrote: {demandMode: 0}, at: 1}});
    await f.sync();
    assert.deepEqual(wire.writes, [[PERIODIC, 0]], 'only 65 is written');
    assert.deepEqual(f.store.get('hotwaterOwnerSettings').wrote, {demandMode: 0, startSmallC: 5, periodic: false});
    assert.deepEqual(f.timers, [], 'nothing left to retry');
});

test('a fresh takeover keeps the owner values first, then writes and confirms each; going off puts them back', async () => {
    const wire = pump(OWNER);
    const f = device(wire, 'autopilot');
    await f.sync();
    assert.deepEqual(wire.writes, [[DEMAND, 0], [START, 50], [PERIODIC, 0]]);
    assert.deepEqual(f.store.get('hotwaterOwnerSettings').owner,
        {demandMode: 1, startSmallC: 42, periodic: true, largeStopC: 58, intervalDays: 14, periodicStopC: 60});
    assert.deepEqual(f.store.get(LEGIONELLA_STATE_KEY), {since: f.store.get('hotwaterOwnerSettings').at});
    f.store.set(LEGIONELLA_STATE_KEY, {since: 1, lastReachedAt: 2, runAt: 3, fallbackAt: 4});
    f.store.set('smartMode', 'test');
    await f.sync();
    assert.deepEqual(wire.writes.slice(3), [[DEMAND, 1], [START, 420], [PERIODIC, 1]]);
    assert.equal(f.store.get('hotwaterOwnerSettings'), undefined);
    assert.deepEqual(f.store.get(LEGIONELLA_STATE_KEY), {since: 1, lastReachedAt: 2, runAt: 3}, 'the interval is kept, the safety net ends');
    f.store.set('smartMode', 'autopilot');
    await f.sync();
    assert.deepEqual(f.store.get(LEGIONELLA_STATE_KEY), {since: 1, lastReachedAt: 2, runAt: 3}, 'live again: the interval carries on');
});

test('a clamped write is Autopilot\'s value, not an owner change: no retry, and the restore puts the owner\'s back', async () => {
    const wire = pump(OWNER);
    wire.clamp[START] = (raw) => Math.max(raw, 100); // this pump's Small start goes no lower than 10 °C
    const f = device(wire, 'autopilot');
    await f.sync();
    assert.equal(f.store.get('hotwaterOwnerSettings').wrote.startSmallC, 10);
    assert.deepEqual(f.timers, []);
    f.store.set('smartMode', 'off');
    await f.sync();
    assert.equal(wire.holding.get(START), 420);
});

test('an owner in Large gets Large\'s stop (62) back before Large itself, after Autopilot\'s charges moved it', async () => {
    const wire = pump({...OWNER, [DEMAND]: 2});
    const f = device(wire, 'autopilot');
    await f.sync();
    assert.equal(wire.holding.get(DEMAND), 0);
    wire.holding.set(LARGE_STOP, 650); // the lever's legionella run
    f.store.set('smartMode', 'off');
    const from = wire.writes.length;
    await f.sync();
    assert.deepEqual(wire.writes.slice(from, from + 2), [[LARGE_STOP, 580], [DEMAND, 2]]);
});

test('a setting the pump keeps refusing is tried with a back-off, then given up and named on the device', async () => {
    const wire = pump(OWNER);
    wire.refuse.add(PERIODIC);
    const f = device(wire, 'autopilot');
    for (let k = 0; k < MAX_FAILURES; k++) await f.sync();
    assert.deepEqual(f.timers.map((ms) => ms / 60_000), [5, 30, 120], 'then no more tries');
    assert.equal(f.store.get('hotwaterOwnerSettings').failures.periodic, MAX_FAILURES);
    assert.match(String(f.warnings.at(-1)), /hotwater_takeover\.gave_up .*Periodic hot water/);
    const writes = wire.writes.length;
    await f.sync();
    assert.equal(wire.writes.length, writes, 'no more writes');
});

test('deleting the device with the pump unreachable: one try at every owner value, then logged loudly and on the timeline', async () => {
    const wire = pump(OWNER);
    const f = device(wire, 'autopilot');
    await f.sync();
    wire.reachable = false;
    f.d.removing = true;
    await f.sync();
    assert.ok(f.errors.some((e) => e.startsWith('AUTOPILOT HOT WATER: the device was deleted')), f.errors.join('\n'));
    assert.match(f.notes[0], /deleted_failed/);
    assert.deepEqual(f.timers, [], 'no retry for a deleted device');
});

test('the legionella boost counts as started when More hot water reads on, even if 697 reads back other hours', async () => {
    const wire = pump(OWNER);
    wire.clamp[697] = () => 5; // the pump reports hours left
    const f = device(wire, 'autopilot');
    await f.d.writeBoost(6);
    assert.deepEqual(wire.writes, [[697, 6]]);
    wire.clamp[697] = () => 0; // refused silently: still off
    await assert.rejects(f.d.writeBoost(6), /did not confirm/);
});
