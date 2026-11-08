import {test} from 'node:test';
import assert from 'node:assert';
import {HotwaterModel, KWH_PER_LITRE, localClock} from '../lib/autopilot/hotwater-learner';
import {MIN_HORIZON, ShadowEntry, hotwaterShadowStep, ownDeviceId, summary} from '../lib/autopilot/hotwater-shadow';
import {SLOT_MS, slotOf} from '../lib/autopilot/prices';

const clock = localClock('UTC');
const T0 = Date.UTC(2026, 10, 9); // midnight UTC
const S0 = slotOf(T0);
const tank = {litres: 176, inletC: 10};

/** A working-day household: a morning and an evening peak. */
const hours = Array.from({length: 24}, (_, h) => h === 6 ? 1.6 : h >= 18 && h <= 21 ? 1.5 : 0);
const model: HotwaterModel = {
    loss: {base: 0.03, perKwh: 0.01, samples: 50},
    charge: {heatPerHour: 6, cop: 2.9, copPerK: -0.02, atTop: 48, samples: 50},
    profiles: {any: {days: 30, hours, p80: hours.map((v) => v * 1.3), daily: 7.6, dailyP80: 10}},
    away: [], days: 30,
};
/** 24 h of prices from S0: cheap at night, dear in the evening. */
const prices = new Map(Array.from({length: 96}, (_, k) => {
    const h = Math.floor(k / 4);
    return [S0 + k, {price: h < 6 ? 1.9 : h >= 16 && h < 21 ? 3.3 : 2.7}];
}));
const step = (over: Partial<Parameters<typeof hotwaterShadowStep>[0]> = {}) =>
    hotwaterShadowStep({slot: S0, prices, model, tank, clock, now: {litres: 120, top: 50}, ...over});
const entry = (out: ReturnType<typeof hotwaterShadowStep>): ShadowEntry => {
    assert.ok('entry' in out, `skipped: ${'skip' in out ? out.skip : ''}`);
    return (out as {entry: ShadowEntry}).entry;
};

test('the shadow plans a charge in the cheap night before the morning peak, and logs it', () => {
    const e = entry(step());
    assert.strictEqual(e.horizon, 96);
    assert.ok(e.next, 'a charge is planned');
    const hour = new Date(e.next!.at).getUTCHours();
    assert.ok(hour < 6, `charge at ${e.next!.at}, before the morning`);
    assert.ok(e.next!.targetC >= 45 && e.next!.targetC <= 60);
    assert.match(summary(e), /next charge \d\d:\d\d UTC to \d+ °C/);
});

test('a charge the pump is already running is reported as running, not as a new start', () => {
    const e = entry(step({now: {litres: 60, top: 44, powerW: 2000, stopC: 48}}));
    assert.strictEqual(e.action, 'running');
    assert.strictEqual(e.charging, true);
});

test('under the reserve with a cold top: rescue; with a hot top: it waits', () => {
    const low = 20; // litres, under the 40 L default
    assert.strictEqual(entry(step({now: {litres: low, top: 40}})).action, 'rescue');
    assert.notStrictEqual(entry(step({now: {litres: low, top: 50}})).action, 'rescue');
});

test('it skips, saying why, when it cannot plan', () => {
    assert.deepStrictEqual(step({model: undefined}), {skip: 'no model'});
    assert.deepStrictEqual(step({model: {...model, charge: undefined}}), {skip: 'no model'});
    assert.deepStrictEqual(step({now: {top: 50}}), {skip: 'no reading'});
    const few = new Map([...prices].slice(0, MIN_HORIZON - 1));
    assert.deepStrictEqual(step({prices: few}), {skip: 'no prices'});
    // The horizon stops at the first slot without a price.
    const gap = new Map(prices); gap.delete(S0 + 40);
    assert.strictEqual(entry(step({prices: gap})).horizon, 40);
});

test('stored heat is litres of 40 °C water', () => {
    assert.ok(Math.abs(120 * KWH_PER_LITRE - 4.186) < 0.01);
    assert.strictEqual(entry(step()).at, new Date(S0 * SLOT_MS).toISOString());
});

test('ownDeviceId finds this app\'s device by its pairing id, not another app\'s', () => {
    const devices = {
        a: {driverId: 'homey:app:other.app:x', data: {id: '10.0.0.5#hotwater'}},
        b: {driverId: 'homey:app:com.nibe.local:nibe_s', data: {id: '10.0.0.5#heating'}},
        c: {driverId: 'homey:app:com.nibe.local:nibe_s', data: {id: '10.0.0.5#hotwater'}},
    };
    assert.strictEqual(ownDeviceId(devices, 'com.nibe.local', '10.0.0.5#hotwater'), 'c');
    assert.strictEqual(ownDeviceId(devices, 'com.nibe.local', '10.0.0.9#hotwater'), undefined);
});
