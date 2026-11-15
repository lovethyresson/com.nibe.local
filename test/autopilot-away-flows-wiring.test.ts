import {test} from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import {sProfile} from '../drivers/nibe_s/profile';
import {SLOT_MS} from '../lib/autopilot/prices';
const loader = Module as any;
const originalLoad = loader._load;
class HomeyBase { homey: any = {}; }
let DeviceClass: any, DriverClass: any;
try {
    loader._load = function (id: string, ...args: any[]) {
        return id === 'homey' ? {Device: HomeyBase, Driver: HomeyBase} : originalLoad.call(this, id, ...args);
    };
    DeviceClass = require('../lib/device').NibePumpDevice;
    DriverClass = require('../lib/driver').NibePumpDriver;
} finally { loader._load = originalLoad; }

function settings() {
    const m = new Map<string, any>();
    return {m, get: (k: string) => m.get(k), set: (k: string, v: any) => { m.set(k, v); }, unset: (k: string) => { m.delete(k); }, on: () => {}};
}
function rig() {
    const s = settings();
    const cards = new Map<string, any>();
    const card = (id: string) => {
        if (!cards.has(id)) cards.set(id, {fired: [] as any[], registerRunListener(fn: any) { this.run = fn; return this; },
            registerArgumentAutocompleteListener() { return this; }, async trigger(dev: any, tokens: any, state: any) { this.fired.push({tokens, state}); }});
        return cards.get(id);
    };
    const flow = {getActionCard: card, getConditionCard: card, getDeviceTriggerCard: card, getTriggerCard: card};
    const devices: any[] = [];
    const driver = new DriverClass();
    const homey: any = {__: (k: string) => k, settings: s, flow, clock: {getTimezone: () => 'Europe/Stockholm'},
        drivers: {getDrivers: () => ({s: driver})}, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}};
    Object.assign(driver, {profile: sProfile, homey, getDevices: () => devices, log: () => {}, error: () => {},
        syncInstallProfile: () => {},
        actionSpecs: Object.fromEntries(sProfile.compose.actions.map((a: any) => [a.id, a])),
        conditionSpecs: Object.fromEntries(sProfile.compose.conditions.map((a: any) => [a.id, a])),
        tracked: (_k: any, _c: any, _r: any, fn: any) => fn, registerAutofillFlow: () => {}});
    return {driver, homey, s, card, devices};
}

test('driver: Away until stores, refuses the past, clears on off and on a plain on, ends by itself', async () => {
    const {driver, s, devices} = rig();
    const seen: any[] = [];
    devices.push({applyAway: async (on: boolean) => { seen.push(['away', on]); }, replanHeating: () => seen.push(['replan']), showDayType: async () => {}});
    await assert.rejects(driver.setAway(true, Date.now() - 1000), /away_time_past/);
    assert.equal(s.m.get('autopilotDayType'), undefined, 'a refused time changes nothing');
    const until = Date.now() + 3_600_000;
    await driver.setAway(true, until);
    assert.equal(s.m.get('autopilotAwayUntil'), until);
    assert.equal(s.m.get('autopilotDayType').type, 'away');
    assert.deepEqual(seen.slice(-2), [['away', true], ['replan']]);
    await driver.setAway(true);
    assert.equal(s.m.get('autopilotAwayUntil'), undefined, 'Away on without a time holds until turned off');
    await driver.setAway(true, until);
    await driver.setAway(false);
    assert.equal(s.m.get('autopilotAwayUntil'), undefined);
    assert.notEqual(s.m.get('autopilotDayType').type, 'away');
    // Ends by itself
    await driver.setAway(true, Date.now() + 50);
    await new Promise((r) => setTimeout(r, 80));
    (driver as any).endAwayIfDue();
    await new Promise((r) => setTimeout(r, 20));
    assert.notEqual(s.m.get('autopilotDayType').type, 'away', 'ended');
    assert.equal(s.m.get('autopilotAwayUntil'), undefined);
    // Day type set to working from the Main device (not keepAway) ends Away and its time
    await driver.setAway(true, Date.now() + 3_600_000);
    await driver.setDayType('working');
    assert.equal(s.m.get('autopilotAwayUntil'), undefined);
    // A nightly Flow (keepAway) keeps both
    await driver.setAway(true, until);
    await driver.setDayType('free', true, 'flow');
    assert.equal(s.m.get('autopilotDayType').type, 'away');
    assert.equal(s.m.get('autopilotAwayUntil'), until, 'a nightly Flow keeps the trip and its end');
});

test('driver: period card run listener uses the Flow\'s minutes', async () => {
    const {driver, card} = rig();
    driver.registerFlows();
    const run = card('autopilot_heating_expensive_soon').run;
    assert.ok(run, 'registered');
    assert.ok(card('autopilot_heating_cheap_soon').run);
    assert.ok(card('autopilot_heating_away_until').run);
    const state = {kind: 'expensive', start: 100 * 60_000, end: 200 * 60_000, anchor: 100 * 60_000, from: 69 * 60_000, now: 70 * 60_000};
    assert.equal(await run({minutes: 30}, state), true);
    assert.equal(await run({minutes: '30'}, state), true, 'a number arg as a string still works');
    assert.equal(await run({minutes: 45}, state), false);
});

function heatingDevice(r: ReturnType<typeof rig>) {
    const d = new DeviceClass();
    const caps = new Map<string, any>([['target_temperature', 21.5], ['boolean_NIBE.autopilot_away', true], ['autopilot_status_NIBE', 'holding']]);
    const store = new Map<string, any>([['autopilotHome', 21.5]]);
    Object.assign(d, {setStoreValue: async (n: string, v: any) => { store.set(n, v); }, unsetStoreValue: async (n: string) => { store.delete(n); }});
    Object.assign(d, {profile: sProfile, role: 'heating', homey: r.homey, driver: r.driver,
        hasCapability: (n: string) => caps.has(n) || n.startsWith('autopilot') || n.startsWith('measure_temperature'),
        getCapabilityValue: (n: string) => caps.get(n), setCapabilityValue: async (n: string, v: any) => { caps.set(n, v); },
        getStoreValue: (n: string) => store.get(n), log: () => {}, error: (e: any) => { throw e; }});
    return {d, caps, store};
}

test('device: Away until parses in Homey\'s zone and refuses nonsense', async () => {
    const r = rig();
    const {d} = heatingDevice(r);
    const calls: any[] = [];
    r.driver.setAway = async (on: boolean, until?: number) => { calls.push([on, until]); };
    await d.setAutopilotAwayUntil('24-12-2026', '18:30');
    assert.deepEqual(calls, [[true, Date.UTC(2026, 11, 24, 17, 30)]]);
    await assert.rejects(d.setAutopilotAwayUntil('2026-12-24', '18:30'), /away_time_invalid/);
});

test('device: awayReturn only while away, with the stored home temperature', () => {
    const r = rig();
    const {d, caps} = heatingDevice(r);
    d.autopilot = {houseSummary: () => undefined, sunReady: () => false}; // collector stand-in
    d.startHeatingFeed();
    const hooks = (d.heatingFeed as any).hooks;
    assert.equal(hooks.awayReturn(), undefined, 'no end time');
    r.s.m.set('autopilotAwayUntil', 1_900_000_000_000);
    assert.deepEqual(hooks.awayReturn(), {at: 1_900_000_000_000, setpoint: 21.5});
    caps.set('boolean_NIBE.autopilot_away', false);
    assert.equal(hooks.awayReturn(), undefined, 'not away');
    assert.equal(typeof hooks.tick, 'function');
    hooks.saveWarming(1_900_000_000_000);
    assert.equal(hooks.loadWarming(), 1_900_000_000_000, 'the warm-up latch survives a restart');
    hooks.saveWarming(undefined);
    assert.equal(hooks.loadWarming(), undefined);
});

test('device: period triggers fire once per Flow from the feed\'s plan, with clock tokens', () => {
    const r = rig();
    const {d} = heatingDevice(r);
    const slot = Math.floor(Date.now() / SLOT_MS);
    const prices = Array.from({length: 96}, (_, k) => (k >= 20 && k < 24 ? 5 : k >= 60 && k < 64 ? 0.2 : 1));
    d.heatingFeed = {state: {mode: 'test', bias: 0, target: 0, slot, forecast: prices.map((price) => ({te: 0, sun: 0, price}))}};
    const realNow = Date.now;
    let now = slot * SLOT_MS + 1000;
    Date.now = () => now;
    try {
        const fired: number[] = [];
        for (let i = 0; i < 6 * 60 * 2; i++) { // six hours of 30 s cycles
            (d as any).checkPricePeriods();
            now += 30_000;
        }
        const exp = r.card('autopilot_heating_expensive_soon').fired;
        assert.ok(exp.length > 0);
        const runs = exp.map((f: any) => f.state);
        const due60 = runs.filter((st: any) => require('../lib/autopilot/heating-flows').periodDue(st, 60));
        assert.equal(due60.length, 1, 'a 60-minute Flow fires once');
        assert.equal(due60[0].start, (slot + 20) * SLOT_MS);
        assert.match(exp[0].tokens.start, /^\d\d:\d\d$/);
        assert.match(exp[0].tokens.end, /^\d\d:\d\d$/);
        // Stopped feed: nothing more
        d.heatingFeed.state.stopped = 'spa_on';
        const before = exp.length;
        (d as any).checkPricePeriods();
        assert.equal(exp.length, before);
        void fired;
    } finally { Date.now = realNow; }
});

test('device: entering pre-heating fires its card once, with the status reason; easing off its own', async () => {
    const r = rig();
    const {d, caps} = heatingDevice(r);
    d.autopilot = {houseSummary: () => ({days: 30, needed: 7})};
    d.heatingDay = {predict: () => {}};
    d.homey.notifications = {createNotification: async () => {}};
    d.heatingMode = 'autopilot';
    const slot = Math.floor(Date.now() / SLOT_MS);
    const fc = [1, 1, 1, 5, 5, 1].map((price) => ({te: 0, sun: 0, price}));
    d.heatingFeed = {state: {mode: 'live', bias: 2, target: 2, slot, biases: [2, 2, 2, 0, 0, 0], forecast: fc, fed: 1}};
    d.heatingStatusShown = 'holding';
    await d.showHeatingStatus();
    const pre = r.card('autopilot_heating_preheating_started').fired;
    assert.equal(caps.get('autopilot_status_NIBE'), 'preheating');
    assert.equal(pre.length, 1);
    assert.match(pre[0].tokens.reason, /preheating/);
    await d.showHeatingStatus();
    assert.equal(pre.length, 1, 'staying pre-heating fires nothing');
    d.heatingFeed.state = {...d.heatingFeed.state, bias: -2, target: -2, biases: [-2, -2, 0, 0, 0, 0]};
    await d.showHeatingStatus();
    assert.equal(r.card('autopilot_heating_easing_off_started').fired.length, 1);
    assert.equal(r.card('autopilot_heating_status_changed').fired.length, 2, 'the existing card still fires');
});

test('driver: when ending Away fails on a device, it is retried each minute until it works', async () => {
    const {driver, s, devices} = rig();
    let fail = true;
    const tries: boolean[] = [];
    devices.push({showDayType: async () => {}, replanHeating: () => {},
        applyAway: async (on: boolean) => { tries.push(on); if (!on && fail) throw new Error('pump offline'); }});
    await driver.setAway(true, Date.now() + 30);
    await new Promise((r) => setTimeout(r, 50));
    (driver as any).endAwayIfDue();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(s.m.get('autopilotAwayUntil'), undefined);
    (driver as any).endAwayIfDue(); // the next minute: still offline
    await new Promise((r) => setTimeout(r, 20));
    fail = false;
    (driver as any).endAwayIfDue(); // back online
    await new Promise((r) => setTimeout(r, 20));
    const offs = tries.filter((on) => !on).length;
    (driver as any).endAwayIfDue(); // done: nothing more
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(offs, 3, 'tried at the end, again, and once more when the pump answered');
    assert.equal(tries.filter((on) => !on).length, 3, 'no retry once it worked');
});
