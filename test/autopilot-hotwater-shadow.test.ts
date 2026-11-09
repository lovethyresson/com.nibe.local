import {test} from 'node:test';
import assert from 'node:assert';
import {HotwaterModel, KWH_PER_LITRE, localClock} from '../lib/autopilot/hotwater-learner';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DAILY_HOUR, MIN_HORIZON, ShadowEntry, dailyPlan, dailyPlanText, hotwaterShadowStep, ownDeviceId, summary} from '../lib/autopilot/hotwater-shadow';
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

const LANGS = ['en', 'sv', 'nl', 'de', 'no', 'da'];
const daily = (lang: string) => JSON.parse(readFileSync(join(__dirname, '..', '.homeycompose', 'locales', `${lang}.json`), 'utf8')).autopilot.hotwater_daily;
/** Homey's `__`: a dotted key, `__token__` placeholders. */
const translator = (lang: string) => (key: string, tokens: Record<string, string | number> = {}) => {
    const text = key.split('.').reduce((node: any, part) => node?.[part], daily(lang));
    assert.strictEqual(typeof text, 'string', `${lang}: missing autopilot.hotwater_daily.${key}`);
    return Object.entries(tokens).reduce((out: string, [name, value]) => out.split(`__${name}__`).join(String(value)), text);
};
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const dailyOf = (over: Partial<Parameters<typeof dailyPlan>[0]> = {}) => {
    const out = dailyPlan({slot: S0, prices, model, tank, clock, now: {litres: 120, top: 50}, ...over});
    assert.ok(!('skip' in out), 'planned');
    return out as Exclude<ReturnType<typeof dailyPlan>, {skip: string}>;
};

/** A lighter day, small enough for one night charge to hold it. */
const light = hours.map((v) => v * 0.6);
const lightModel: HotwaterModel = {...model, profiles: {working: {days: 30, hours: light, p80: light.map((v) => v * 1.3), daily: 4.6, dailyP80: 6}}};

test('the morning plan says what goes in (use, tank, safety net, prices) and what comes out', () => {
    const d = dailyOf({dayType: 'working', model: lightModel});
    assert.strictEqual(d.useLitres, Math.round(4.6 / KWH_PER_LITRE));
    assert.strictEqual(d.useLitresP80, Math.round(6 / KWH_PER_LITRE));
    assert.strictEqual(d.reserveLitres, 40);
    assert.ok(d.charges.length >= 1);
    const c = d.charges[0];
    assert.strictEqual(c.reason, 'cheap');
    assert.ok(new Date(c.at).getUTCHours() < 6, 'in the cheap night');
    assert.ok(c.price < d.meanPrice, `charge price ${c.price} under the day's mean ${d.meanPrice}`);
    const text = dailyPlanText(d, translator('en'), hhmm, 'kr', true);
    assert.match(text, /^Hot water today, a working day\n/);
    assert.match(text, new RegExp(`about ${d.useLitres} L of hot water, up to ${d.useLitresP80} L`));
    assert.match(text, /holds 120 L now and always keeps at least 40 L/);
    assert.match(text, new RegExp(`Charge to ${c.targetC} °C at ${hhmm(c.at)}, at ${c.price.toFixed(2)} kr/kWh \\(among the cheapest hours; the day averages ${d.meanPrice.toFixed(2)} kr\\)`));
    assert.match(text, /Prices are known until midnight tonight\.\nTest run: nothing is changed on the pump\.$/);
    assert.doesNotMatch(text, /__\w+__/, 'every token filled');
});

test('a charge that has to reach into dearer hours is not called cheap', () => {
    // The heavier day does not fit a 60 °C tank, so its one charge runs across the 06:00 shower
    // into the 2.70 hours: timed for the use, not the cheapest it could have bought.
    const c = dailyOf().charges[0];
    assert.strictEqual(c.reason, 'before_use');
    assert.ok(c.price > 1.9 * 1.02, `bought at ${c.price}`);
});

test('the morning plan names a safety-net charge, a running one and a quiet day', () => {
    assert.strictEqual(dailyOf({now: {litres: 20, top: 40}}).charges[0].reason, 'reserve');
    assert.strictEqual(dailyOf({now: {litres: 60, top: 44, powerW: 2000, stopC: 48}}).charges[0].reason, 'running');
    const full = dailyOf({model: {...model, profiles: {any: {days: 30, hours: hours.map(() => 0), p80: hours.map(() => 0), daily: 0, dailyP80: 0}}},
        now: {litres: 176, top: 58}});
    assert.strictEqual(full.charges.length, 0);
    assert.match(dailyPlanText(full, translator('en'), hhmm, 'kr', false), /No charge needed/);
    assert.match(dailyPlanText({...full, reserveLitres: 0}, translator('en'), hhmm, '', false), /No safety net is set/);
});

test('the morning plan reads in all six languages, with every token filled', () => {
    const plans = [dailyOf({dayType: 'free'}), dailyOf({dayType: 'away'}), dailyOf({now: {litres: 20, top: 40}}),
        dailyOf({now: {litres: 60, top: 44, powerW: 2000, stopC: 48}})];
    plans.push({...plans[0], charges: [{...plans[0].charges[0], reason: 'surplus', surplusShare: 0.8},
        {...plans[0].charges[0], reason: 'before_use'}]});
    for (const lang of LANGS) for (const d of plans) {
        const text = dailyPlanText(d, translator(lang), hhmm, 'kr', true);
        assert.doesNotMatch(text, /__\w+__/, `${lang}: ${text}`);
    }
    const mixed = dailyPlanText(plans[4], translator('en'), hhmm, 'kr', false);
    assert.match(mixed, /80 % from solar surplus/);
    assert.match(mixed, /in time for the use that follows/);
    // Once tomorrow's prices are out, a charge after midnight says so, and so does the horizon.
    const late = dailyOf({prices: new Map(Array.from({length: 192}, (_, k) => [S0 + k, {price: (k % 96) < 24 ? 1.9 : 2.7}]))});
    const lateText = dailyPlanText(late, translator('en'), hhmm, 'kr', false);
    assert.match(lateText, /known until midnight tomorrow/);
    for (const lang of LANGS) assert.doesNotMatch(dailyPlanText(late, translator(lang), hhmm, 'kr', true), /__\w+__/);
    assert.ok(DAILY_HOUR >= 5 && DAILY_HOUR <= 9, 'a morning hour');
});
