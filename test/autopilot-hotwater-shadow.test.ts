import {test} from 'node:test';
import assert from 'node:assert';
import {HotwaterModel, KWH_PER_LITRE, localClock} from '../lib/autopilot/hotwater-learner';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {COAST_HOURS, DAILY_HOUR, EXTEND_MIN_K, extendTarget, chargedSlots, nextCharge, trackedReason, DailyPlan, MIN_HORIZON, ShadowEntry, coastLitres, againstPlan, movedFrom, offPlanCharge, planChanges, planUpdateText, autopilotCharge, chargeLine, chargeText, chargeTokens, dailyPlan, dailyPlanText, hotwaterShadowStep, hotwaterStatusText, ownDeviceId, resumePlan, pumpCharge, recapLines, summary} from '../lib/autopilot/hotwater-shadow';
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
    return [S0 + k, {price: h < 6 ? 1.2 : h >= 16 && h < 21 ? 3.3 : 2.7}];
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
const strings = (lang: string, area: string) => JSON.parse(readFileSync(join(__dirname, '..', '.homeycompose', 'locales', `${lang}.json`), 'utf8')).autopilot[area];
/** Homey's `__`: a dotted key, `__token__` placeholders. */
const translator = (lang: string, area = 'hotwater_daily') => (key: string, tokens: Record<string, string | number> = {}) => {
    const text = key.split('.').reduce((node: any, part) => node?.[part], strings(lang, area));
    assert.strictEqual(typeof text, 'string', `${lang}: missing autopilot.${area}.${key}`);
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
    const text = dailyPlanText(d, translator('en'), hhmm, kr, true);
    // One short paragraph (2026-11-23): when, what it costs, the tank now. No line breaks.
    assert.ok(text.startsWith(`Hot water today: heats at ${hhmm(c.at)}`), text);
    assert.match(text, new RegExp(`about ${d.cost.toFixed(2)} kr\\. 120 L now\\. Simulated\\. No changes made to your heat pump\\.$`));
    assert.ok(!text.includes('\n'), 'one paragraph');
    assert.doesNotMatch(text, /__\w+__/, 'every token filled');
    assert.match(dailyPlanText(d, translator('en'), hhmm, kr, false, 2), /Since yesterday morning it also heated 2 times outside the plan\.$/);
    assert.match(dailyPlanText(d, translator('en'), hhmm, kr, false, 1), /also heated once outside the plan\.$/);
});

test('a charge that has to reach into dearer hours is not called cheap', () => {
    // Cheap only 07:00–09:00, after the 06:00 shower, with a tank near the floor: the charge for
    // the shower is bought at 2.70 before it. Timed for the use, not cheap.
    const late = new Map(Array.from({length: 96}, (_, k) => [S0 + k, {price: k >= 28 && k < 36 ? 1.2 : 2.7}]));
    const c = dailyOf({prices: late, now: {litres: 45, top: 47}}).charges[0];
    assert.ok(new Date(c.at).getUTCHours() < 6, 'before the shower');
    assert.strictEqual(c.reason, 'before_use');
    assert.ok(c.price > 1.2 * 1.02, `bought at ${c.price}`);
});

test('each slot\'s draws follow its own day type when the input gives one (the calendar\'s weekend)', () => {
    const plain = step();
    const byDay = step({dayTypeOf: (ms) => ms < T0 + 6 * 3_600_000 ? 'working' : 'away'});
    assert.ok(!('skip' in plain) && !('skip' in byDay));
    const coast = (o: any) => o.entry.coast as number[];
    assert.deepStrictEqual(coast(byDay).slice(0, 5), coast(plain).slice(0, 5), 'the same day until 06:00');
    assert.ok(coast(byDay)[7] > coast(plain)[7], 'no draws once the next day type has none');
});

test('the morning plan names a safety-net charge, a running one and a quiet day', () => {
    assert.strictEqual(dailyOf({now: {litres: 20, top: 40}}).charges[0].reason, 'reserve');
    // 2026-11-14 16:00: under the safety net with a hot top (no rescue), an evening's use ahead
    // and cheap hours only after it; the charge starts at the price peak and read "Cheapest hours".
    const evening = new Map(Array.from({length: 48}, (_, k) => [S0 + 64 + k, {price: k < 20 ? 3.3 : 1.9}]));
    const peak = dailyOf({slot: S0 + 64, prices: evening, now: {litres: 30, top: 47}}).charges[0];
    assert.ok(peak.price > 3, 'bought in the peak, before the evening use');
    assert.strictEqual(peak.reason, 'before_use', 'cheaper hours come later: timed for the use, not cheap');
    assert.strictEqual(dailyOf({now: {litres: 60, top: 44, powerW: 2000, stopC: 48}}).charges[0].reason, 'running');
    const full = dailyOf({model: {...model, profiles: {any: {days: 30, hours: hours.map(() => 0), p80: hours.map(() => 0), daily: 0, dailyP80: 0}}},
        now: {litres: 176, top: 58}});
    assert.strictEqual(full.charges.length, 0);
    assert.strictEqual(dailyPlanText(full, translator('en'), hhmm, kr, false), 'Hot water today: no heating needed. 176 L now.');
});

test('the morning plan reads in all six languages, with every token filled', () => {
    const plans = [dailyOf({dayType: 'free'}), dailyOf({dayType: 'away'}), dailyOf({now: {litres: 20, top: 40}}),
        dailyOf({now: {litres: 60, top: 44, powerW: 2000, stopC: 48}})];
    plans.push({...plans[0], charges: [{...plans[0].charges[0], reason: 'surplus', surplusShare: 0.8},
        {...plans[0].charges[0], reason: 'before_use'}]});
    for (const lang of LANGS) for (const d of plans) {
        const text = dailyPlanText(d, translator(lang), hhmm, kr, true);
        assert.doesNotMatch(text, /__\w+__/, `${lang}: ${text}`);
    }
    const two = dailyPlanText(plans[4], translator('en'), hhmm, kr, false);
    assert.match(two, /heats at \d\d:\d\d and \d\d:\d\d, about/, 'two times, one list');
    // Once tomorrow's prices are out, a charge after midnight says so, and so does the horizon.
    const late = dailyOf({prices: new Map(Array.from({length: 192}, (_, k) => [S0 + k, {price: (k % 96) < 24 ? 1.9 : 2.7}]))});
    const lateText = dailyPlanText(late, translator('en'), hhmm, kr, false);
    assert.doesNotMatch(lateText, /__\w+__/);
    for (const lang of LANGS) assert.doesNotMatch(dailyPlanText(late, translator(lang), hhmm, kr, true), /__\w+__/);
    assert.ok(DAILY_HOUR >= 5 && DAILY_HOUR <= 9, 'a morning hour');
});

/** Money as the widgets write it, for the tests. */
const kr = (v: number) => `${v.toFixed(2)} kr`;

const charge = (over: Partial<Parameters<typeof autopilotCharge>[0]> = {}, morning?: Parameters<typeof autopilotCharge>[1]) => {
    const out = autopilotCharge({slot: S0, prices, model, tank, clock, now: {litres: 120, top: 50}, ...over}, morning);
    assert.ok(!('skip' in out), `skipped: ${'skip' in out ? out.skip : ''}`);
    return out as Exclude<ReturnType<typeof autopilotCharge>, {skip: string}>;
};

test('a charge message has a short reason and a detailed one with the numbers', () => {
    // At the cheap night slot, with the morning-plan charge there: cheapest hours, as planned.
    const morning = dailyOf({model: lightModel, dayType: 'working'});
    const slot = morning.charges[0].at / SLOT_MS;
    // The morning's tank, run forward to the planned start (planner's own stored heat there).
    const e = charge({slot, model: lightModel, dayType: 'working', now: {litres: 45, top: 47}}, morning);
    assert.strictEqual(e.by, 'autopilot');
    assert.strictEqual(e.plan, 'as_planned');
    const {reason, detailedReason} = chargeText(e, translator('en', 'hotwater_charge'), hhmm, kr);
    assert.match(reason, /^(Cheapest hours|In time for use)$/);
    assert.match(detailedReason, new RegExp(`^To ${e.targetC} °C in about \\d+ (h|min)( \\d+ min)?, at \\d\\.\\d\\d kr/kWh\\. Today's average: \\d\\.\\d\\d kr\\. As planned\\.$`));
});

test('a safety-net start says why, and nothing is reported while the planner waits', () => {
    const e = charge({now: {litres: 20, top: 40}});
    assert.strictEqual(e.reason, 'reserve');
    assert.strictEqual(e.plan, undefined, 'no morning plan to compare with');
    const {detailedReason} = chargeText(e, translator('en', 'hotwater_charge'), hhmm, kr);
    assert.match(detailedReason, /down to 20 L, below your 40 L minimum\. Heating to/);
    const waits = autopilotCharge({slot: S0 + 40, prices, model, tank, clock, now: {litres: 150, top: 55}});
    assert.deepStrictEqual(waits, {skip: 'no start'});
});

test('a start is as planned within 45 min, moved within 3 h, else unplanned', () => {
    const morning = dailyOf();
    const planned = morning.charges[0].at;
    assert.deepStrictEqual(againstPlan(planned + 30 * 60_000, morning), {plan: 'as_planned'});
    assert.deepStrictEqual(againstPlan(planned + 2 * 3_600_000, morning), {plan: 'moved', plannedAt: planned});
    assert.deepStrictEqual(againstPlan(planned + 2 * 3_600_000, morning, false), {plan: 'unplanned', early: true}, 'a safety net or the pump is never the plan moved');
    assert.deepStrictEqual(againstPlan(planned + 12 * 3_600_000, {...morning, charges: [morning.charges[0]]}), {plan: 'unplanned'});
    assert.deepStrictEqual(againstPlan(planned), {});
    assert.deepStrictEqual(againstPlan(planned - 5 * 3_600_000, {...morning, charges: [morning.charges[0]]}), {plan: 'unplanned', early: true},
        'ahead of every planned charge: the tank ran low sooner');
    assert.deepStrictEqual(againstPlan(planned + 3.5 * 3_600_000, {...morning, charges: [{...morning.charges[0], at: planned - 3_600_000},
        {...morning.charges[0], at: planned + 7 * 3_600_000}]}), {plan: 'unplanned', early: true}, 'a nearer past charge does not hide the one to come');
    const past = {...morning, charges: [{...morning.charges[0], at: planned - 7 * 3_600_000}]};
    assert.deepStrictEqual(againstPlan(planned, past), {plan: 'unplanned'}, 'after a planned charge that did not run');
    const ranThen = {at: planned - 7 * 3_600_000 + 10 * 60_000, by: 'autopilot', reason: 'cheap', reserveLitres: 40} as const;
    assert.deepStrictEqual(againstPlan(planned, past, true, [ranThen]), {plan: 'unplanned', early: true}, 'it ran, so the tank ran low sooner');
    assert.deepStrictEqual(againstPlan(planned, past, true, [{...ranThen, at: planned - 9 * 3_600_000, plannedAt: planned - 7 * 3_600_000}]),
        {plan: 'unplanned', early: true}, 'a start moved from it counts as it');
    assert.deepStrictEqual(againstPlan(planned, {...morning, charges: []}), {plan: 'unplanned', early: true});
    const text = chargeText({...charge({now: {litres: 20, top: 40}}), plan: 'moved', plannedAt: planned},
        translator('en', 'hotwater_charge'), hhmm, kr).detailedReason;
    assert.match(text, new RegExp(`Moved from ${hhmm(planned)}\\.$`));
});

test('an early off-plan start for use or under the minimum says more was used than expected; the rest keep "Not planned"', () => {
    const t = translator('en', 'hotwater_charge');
    const early = {...charge({now: {litres: 20, top: 40}}), reason: 'before_use' as const, plan: 'unplanned' as const, early: true as const};
    assert.match(chargeText(early, t, hhmm, kr).detailedReason, /More hot water used than expected\.$/);
    assert.match(chargeText({...early, reason: 'reserve' as const}, t, hhmm, kr).detailedReason,
        /below your 40 L minimum\..* More hot water used than expected\.$/);
    assert.deepStrictEqual(recapLines([early], t, hhmm, false, () => '2026-11-25', '2026-11-25').at(-1)!.endsWith('More used than expected.'), true);
    for (const e of [{...early, early: undefined}, {...early, reason: 'surplus' as const},
        {...pumpCharge(T0, {litres: 50, top: 41, stopC: 48}, 40), plan: 'unplanned' as const, early: true as const}]) {
        assert.match(chargeText(e, t, hhmm, kr).detailedReason, /Not planned\.$/, `${e.by} ${e.reason} ${e.early}`);
    }
});

test('the pump\'s own charge is reported as the pump\'s, with the stop it runs to', () => {
    const t = translator('en', 'hotwater_charge');
    const own = pumpCharge(T0, {litres: 50, top: 41, stopC: 48, largeStopC: 58}, 40);
    assert.strictEqual(own.targetC, 48);
    assert.match(chargeText(own, t, hhmm, kr).detailedReason, /Started by your heat pump at 41 °C\. Runs to 48 °C/);
    const boost = pumpCharge(T0, {litres: 50, top: 41, more: true, stopC: 48, largeStopC: 58}, 40);
    assert.strictEqual(boost.targetC, 58);
    assert.match(chargeText(boost, t, hhmm, kr).detailedReason, /More hot water is on, so your heat pump runs to 58 °C/);
    assert.match(chargeLine(boost, t, hhmm, kr, true), /^Heating hot water · Started by your heat pump\n/);
    assert.match(chargeLine(charge({now: {litres: 20, top: 40}}), t, hhmm, kr, true), /^Simulated: would heat hot water · Below minimum\n/);
    const atPlan = {...own, plan: 'as_planned' as const};
    assert.match(chargeText(atPlan, t, hhmm, kr).detailedReason, /Autopilot planned to heat then too\.$/);
    assert.match(chargeText({...charge({now: {litres: 20, top: 40}}), minutes: 60}, t, hhmm, kr).detailedReason, /about 1 h\./);
});

test('the morning recap tells yesterday and today apart, oldest first', () => {
    const H = 3_600_000, t = translator('en', 'hotwater_charge');
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    // The morning of 10 Nov: a safety-net would-start yesterday 09:30, the pump at 18:30, a
    // would-start at 03:45 today, the pump's own at 03:00 today. Given out of order.
    const today = T0 + 24 * H;
    const events = [
        {...charge({now: {litres: 20, top: 40}}), at: today + 3.75 * H, plan: 'as_planned' as const},
        {...pumpCharge(T0 + 18.5 * H, {litres: 50, top: 41, stopC: 48}, 40), plan: 'unplanned' as const},
        {...pumpCharge(today + 3 * H, {litres: 70, top: 47, more: true, largeStopC: 58}, 40), plan: 'as_planned' as const},
        {...charge({now: {litres: 20, top: 40}}), at: T0 + 9.5 * H, plan: 'unplanned' as const},
    ];
    const target = events[0].targetC;
    assert.deepStrictEqual(recapLines(events, t, hhmm, true, day, day(today)), [
        'Yesterday:',
        `09:30 would have heated to ${target} °C: Below minimum. Not planned.`,
        '18:30 to 48 °C: Started by your heat pump. Not planned.',
        'Last night:',
        '03:00 to 58 °C: Started by your heat pump. Planned then too.',
        `03:45 would have heated to ${target} °C: Below minimum. As planned.`,
    ]);
    // A missed morning: the older day says its date.
    assert.strictEqual(recapLines([events[1]], t, hhmm, true, day, day(today + 48 * H))[0], `${day(T0)}:`);
    assert.deepStrictEqual(recapLines([], t, hhmm, true, day, day(today)), []);
    // The recap goes to the log; the timeline says only how many runs were outside the plan.
    const text = dailyPlanText(dailyOf(), translator('en'), hhmm, kr, true, 1);
    assert.match(text, /^Hot water today: .* Since yesterday morning it also heated once outside the plan\. Simulated\./);
    assert.doesNotMatch(dailyPlanText(dailyOf(), translator('en'), hhmm, kr, true), /Today:/, 'no heading without a recap');
});

test('charge messages read in all six languages, with every token filled', () => {
    const morning = dailyOf();
    const base = charge({now: {litres: 20, top: 40}});
    const events = [base, {...base, reason: 'cheap' as const, plan: 'moved' as const, plannedAt: morning.charges[0].at},
        {...base, reason: 'surplus' as const, surplusShare: 0.8, plan: 'as_planned' as const},
        {...base, reason: 'before_use' as const, minutes: 45, plan: 'unplanned' as const},
        pumpCharge(T0, {litres: 50, top: 41, stopC: 48}, 40), pumpCharge(T0, {litres: 50, top: 41, more: true, largeStopC: 58}, 40)];
    for (const lang of LANGS) {
        const t = translator(lang, 'hotwater_charge');
        for (const e of events) for (const shadow of [true, false])
            assert.doesNotMatch(chargeLine(e, t, hhmm, kr, shadow), /__\w+__|undefined|NaN/, `${lang}: ${JSON.stringify(e)}`);
        assert.doesNotMatch(recapLines(events, t, hhmm, true, (ms) => new Date(ms).toISOString().slice(0, 10), '2026-11-10').join('\n'), /__\w+__|undefined|NaN/);
    }
});

const HOUR = 3_600_000;
const fact = (h: number, targetC: number, price: number, reason: 'cheap' | 'before_use' = 'cheap') =>
    ({at: T0 + h * HOUR, targetC, minutes: 60, price, surplusShare: 0, cost: price * 2, reason});
const planOf = (charges: ReturnType<typeof fact>[], untilH: number): DailyPlan => ({
    date: '2026-11-09', reserveLitres: 40, nowLitres: 100, charges, meanPrice: 2.5,
    cost: charges.reduce((x, c) => x + c.cost, 0), until: T0 + untilH * HOUR, chargeDates: [], untilDate: untilH > 24 ? '2026-11-10' : '2026-11-09'});
const whenOf = (ms: number, at = false) => (ms >= T0 + 24 * HOUR ? (at ? 'tomorrow at ' : 'tomorrow ') : at ? 'at ' : '') + hhmm(ms);

test('a replan tells same, resized, moved, dropped and added apart', () => {
    const before = planOf([fact(14, 53, 2.21), fact(17, 50, 2.6), fact(20, 50, 3.4)], 24);
    const after = planOf([fact(14.25, 45, 2.21), fact(19, 50, 2.5), fact(27.75, 60, 1.62)], 48);
    const kinds = planChanges(before, after, T0 + 13.5 * HOUR).map((c) => `${c.kind} ${hhmm((c.now ?? c.was)!.at)}`);
    // 14:00 → 14:15 is the same charge, 8 K smaller; 17:00 → 19:00 moved; 20:00 has nothing near: dropped.
    assert.deepStrictEqual(kinds, ['resized 14:15', 'moved 19:00', 'dropped 20:00', 'added 03:45']);
    // Charges already behind `from` are not news.
    assert.deepStrictEqual(planChanges(before, planOf([fact(17, 50, 2.6), fact(20, 50, 3.4)], 24), T0 + 15 * HOUR), []);
});

test('the update explains each change by the prices, and stays quiet about new hours alone', () => {
    const t = translator('en', 'hotwater_update');
    const before = planOf([fact(14, 53, 2.21)], 24);
    const after = planOf([fact(14, 45, 2.21), fact(27.75, 60, 1.62)], 48);
    const text = planUpdateText(before, after, T0 + 13.5 * HOUR, t, whenOf, kr, true)!;
    assert.strictEqual(text, ['Hot water plan updated with new prices.',
        'Hot water 14:00 changed: 45 °C instead of 53 °C. Hot water tomorrow at 03:45 covers the rest, at 1.62 kr/kWh.',
        'Added: hot water tomorrow 03:45 to 60 °C at 1.62 kr/kWh (Cheapest hours), in newly priced hours.',
        'Expected cost 7.66 kr.',
        'Simulated. No changes made to your heat pump.'].join('\n'));
    // Only a charge in the newly priced hours: the next morning and the charge message tell it.
    assert.strictEqual(planUpdateText(before, planOf([fact(14, 53, 2.21), fact(27.75, 60, 1.62)], 48),
        T0 + 13.5 * HOUR, t, whenOf, kr, true), undefined);
    // Revised prices: the move says what the old hours cost now.
    const moved = planUpdateText(planOf([fact(14, 53, 2.21)], 24), planOf([fact(16, 52, 2.66)], 24),
        T0 + 13.5 * HOUR, t, whenOf, kr, false, () => 3.9)!;
    assert.match(moved, /^Hot water plan updated after a price change\.\nHot water moved from 14:00 to 16:00: 14:00 now costs 3\.90 kr\/kWh instead of 2\.21 kr\. Heats to 52 °C at 2\.66 kr\/kWh\./);
    // Dropped with nothing taking over: the tank covers it.
    assert.match(planUpdateText(planOf([fact(20, 50, 3.4)], 24), planOf([], 24), T0 + 13.5 * HOUR, t, whenOf, kr, false)!,
        /Hot water 20:00 cancelled\. Not needed\./);
});

test('plan updates read in all six languages, with every token filled', () => {
    const before = planOf([fact(14, 53, 2.21), fact(17, 50, 2.6), fact(20, 50, 3.4), fact(22, 48, 2.3)], 24);
    const after = planOf([fact(14.25, 45, 2.21), fact(19, 50, 2.5), fact(22, 55, 2.3), fact(27.75, 60, 1.62)], 48);
    // 14:00 and 22:00 resized, 17:00 moved to 19:00, 20:00 dropped, 03:45 added.
    assert.deepStrictEqual(planChanges(before, after, T0 + 13.5 * HOUR).map((c) => c.kind), ['resized', 'moved', 'dropped', 'resized', 'added']);
    for (const lang of LANGS) for (const priceNow of [undefined, () => 3.9]) {
        const text = planUpdateText(before, after, T0 + 13.5 * HOUR, translator(lang, 'hotwater_update'), whenOf, kr, true, priceNow)!;
        assert.doesNotMatch(text, /__\w+__|undefined|NaN/, `${lang}: ${text}`);
        assert.strictEqual(text.split('\n').length, 8, `${lang}: title, five changes, cost, test run`);
    }
});

test('each log line predicts the litres ahead if nothing charges: falling, hourly, 12 h', () => {
    const e = entry(step());
    assert.strictEqual(e.coast?.length, COAST_HOURS);
    assert.ok(e.coast!.every((v, i) => v <= (i ? e.coast![i - 1] : 120)), `never rises: ${e.coast}`);
    assert.ok(e.coast!.at(-1)! < 120, 'draws and loss take something over 12 h');
});

test('the no-charge prediction is draws plus standing loss, and stops at empty', () => {
    const loss = {base: 0, perKwh: 0, samples: 0};
    const perLitre = 4.186 * 30 / 3600;
    // 10 L of heat drawn per hour, no loss: 100 L → 90, 80, …
    const draws = Array(16).fill(10 * perLitre / 4);
    assert.deepStrictEqual(coastLitres(100 * perLitre, draws, loss, 4), [90, 80, 70, 60]);
    assert.deepStrictEqual(coastLitres(15 * perLitre, draws, loss, 3), [5, 0, 0]);
    // A short horizon gives fewer hours, never a made-up one.
    assert.strictEqual(coastLitres(100 * perLitre, draws.slice(0, 6), loss).length, 1);
});

/** Wording that shows the key and its tokens, so a test reads which line was chosen. */
const keys = (key: string, tokens?: Record<string, string | number>) =>
    tokens ? `${key}(${Object.entries(tokens).map(([k, v]) => `${k}=${v}`).join(',')})` : key;

test('the step gives the next charge with its reason, and where the known prices end', () => {
    const out = step();
    assert.ok('entry' in out);
    assert.ok(out.next, 'a charge is planned');
    assert.strictEqual(out.next!.at, Date.parse(out.entry.next!.at));
    assert.ok(['cheap', 'before_use'].includes(out.next!.reason), out.next!.reason);
    assert.strictEqual(out.until, T0 + 96 * SLOT_MS);
});

test('a running charge is not the next charge', () => {
    const out = step({now: {litres: 60, top: 44, powerW: 2000, stopC: 48}});
    assert.ok('entry' in out);
    assert.ok(!out.next || out.next.reason !== 'running');
});

test('the "Autopilot now" line says the next charge, when it starts now, and what it waits for', () => {
    const next = {at: T0 + 3 * 3_600_000, targetC: 52, minutes: 60, price: 1.9, surplusShare: 0, cost: 3, reason: 'cheap' as const};
    const planned = {state: 'planned' as const, next, until: T0 + 86_400_000, now: T0};
    assert.strictEqual(hotwaterStatusText(planned, keys, hhmm, false),
        'hotwater_status.next(time=03:00,target=52,reason=hotwater_charge.reason.cheap)');
    assert.match(hotwaterStatusText({...planned, now: next.at}, keys, hhmm, false), /^hotwater_status\.starting/);
    assert.strictEqual(hotwaterStatusText({...planned, next: undefined}, keys, hhmm, false), 'hotwater_status.none(until=00:00)');
    assert.strictEqual(hotwaterStatusText({state: 'charging', reason: 'pump'}, keys, hhmm, false),
        'hotwater_status.charging_reason(reason=hotwater_charge.reason.pump)');
    assert.strictEqual(hotwaterStatusText({state: 'charging'}, keys, hhmm, false), 'hotwater_status.charging');
    assert.strictEqual(hotwaterStatusText({state: 'learning'}, keys, hhmm, true), 'hotwater_status.test(text=hotwater_status.learning)');
});

test('every "Autopilot now" key is worded in all six languages', () => {
    const used = ['learning', 'no_prices', 'charging', 'charging_reason', 'starting', 'next', 'none', 'test'];
    for (const lang of ['en', 'sv', 'de', 'nl', 'no', 'da']) {
        const status = JSON.parse(readFileSync(join(__dirname, '..', '.homeycompose', 'locales', `${lang}.json`), 'utf8')).autopilot.hotwater_status;
        for (const key of used) assert.ok(typeof status?.[key] === 'string' && status[key].length, `${lang}: ${key}`);
    }
});

test('a restart resumes the plan in force and the recap, and remembers the morning message went out', () => {
    const d = dailyPlan({slot: S0, prices, model, tank, clock, now: {litres: 120, top: 50}});
    assert.ok(!('skip' in d));
    const plan = d as DailyPlan;
    const e = {...pumpCharge(T0 + 3_600_000, {litres: 50, top: 45, stopC: 48}, 40, plan)};
    const saved = {dailySent: plan.date, plan, events: [e]};
    assert.deepStrictEqual(resumePlan(saved, T0 + 2 * 3_600_000), saved);
    // Past the prices it was made over, the plan is no longer the one in force; the recap stays.
    const later = resumePlan(saved, plan.until + 1);
    assert.strictEqual(later?.plan, undefined);
    assert.strictEqual(later?.dailySent, plan.date);
    // A charge older than two days is no longer recap.
    assert.deepStrictEqual(resumePlan(saved, e.at + 3 * 86_400_000)?.events, []);
    assert.strictEqual(resumePlan(undefined, T0), undefined);
});

/** 2026-11-15: a free day after an evening charge. The tank is near its 58 °C ceiling all night,
 *  so the cheap night has no room for the day's charge, which waits for the morning's use. */
const freeHours = Array.from({length: 24}, (_, h) => h >= 8 && h <= 10 ? 1.5 : h >= 17 && h <= 21 ? 1.5 : 0);
const freeModel: HotwaterModel = {...model, profiles: {any: {days: 30, hours: freeHours, p80: freeHours.map((v) => v * 1.3), daily: 12, dailyP80: 15}}};
const sunday = new Map(Array.from({length: 96}, (_, k) => {
    const h = Math.floor(k / 4);
    return [S0 + k, {price: h < 7 ? 1.0 : h < 9 ? 1.7 : h < 13 ? 1.3 : 2.2}];
}));

test('a charge after cheaper hours the tank had no room for says so, not "in time for use"', () => {
    const c = dailyOf({model: freeModel, prices: sunday, now: {litres: 222, top: 52}}).charges[0];
    assert.ok(new Date(c.at).getUTCHours() >= 9, `charge at ${hhmm(c.at)}, after the full night`);
    assert.strictEqual(c.reason, 'room');
    for (const lang of LANGS) assert.notStrictEqual(translator(lang, 'hotwater_charge')(`reason.${c.reason}`), '');
});

test('room and loss are tracked as before_use, the taxonomy\'s value', () => {
    assert.strictEqual(trackedReason('room'), 'before_use');
    assert.strictEqual(trackedReason('loss'), 'before_use');
    assert.strictEqual(trackedReason('cheap'), 'cheap');
});

test('a charge that waits past cheaper hours it had room for says the heat would have waited', () => {
    // Use only in the evening, a leaky tank and a midday price barely over the night's: heat made
    // at night would stand all day, so the plan waits although the tank had room.
    const evening = Array.from({length: 24}, (_, h) => h >= 18 && h <= 20 ? 2 : 0);
    const leaky: HotwaterModel = {...model, loss: {base: 0.05, perKwh: 0.08, samples: 50},
        profiles: {any: {days: 30, hours: evening, p80: evening, daily: 6, dailyP80: 6}}};
    const flat = new Map(Array.from({length: 96}, (_, k) => [S0 + k, {price: Math.floor(k / 4) < 6 ? 1.0 : Math.floor(k / 4) < 16 ? 1.1 : 3}]));
    const c = dailyOf({model: leaky, prices: flat, now: {litres: 60, top: 46}}).charges[0];
    assert.ok(new Date(c.at).getUTCHours() >= 6, `charge at ${hhmm(c.at)}, after the cheap night`);
    assert.strictEqual(c.reason, 'loss');
});

test('the widget\'s next charge skips a planned one that never started, and keeps one that is running', () => {
    const at = (h: number, m = 0) => Date.UTC(2026, 10, 15, h, m);
    const charges = [{at: at(10, 45), minutes: 75}, {at: at(22), minutes: 60}];
    // 11:05, the 10:45 charge did not start (a safety-net charge filled the tank at 10:10).
    assert.strictEqual(nextCharge(charges, at(11, 5), false)?.at, at(22));
    // 11:05 and the tank is charging: the 10:45 charge is running.
    assert.strictEqual(nextCharge(charges, at(11, 5), true)?.at, at(10, 45));
    // 10:50, inside its first slot: still the next one.
    assert.strictEqual(nextCharge(charges, at(10, 50), false)?.at, at(10, 45));
    // 10:35, charging, and a plan made mid-charge starts at 10:45: that charge is the one running.
    const running = nextCharge(charges, at(10, 35), true)!;
    assert.ok(running.at === at(10, 45) && running.at > at(10, 35), 'the status says charging now, not next at 10:45');
});

test('chargedSlots reads the charges from the heat counter, after `since`', () => {
    const t0 = Date.UTC(2026, 10, 15, 9, 0);
    const q = 15 * 60_000;
    // Quarter-hour readings: 1.5 kWh a quarter (6 kWh/h, the tank's rate) from 09:15 to 10:00.
    const quarters = [0, 0, 1.5, 3, 4.5, 4.5].map((p, k) => ({t: t0 + k * q, produced: p}));
    assert.deepStrictEqual(chargedSlots(quarters, 0, 6), [1, 2, 3].map((k) => slotOf(t0) + k));
    assert.deepStrictEqual(chargedSlots(quarters, t0 + 2 * q, 6), [slotOf(t0) + 2, slotOf(t0) + 3]);
});

test('chargedSlots times a slow near-full charge by its electricity, not its heat', () => {
    // Hourly: 13:15–15:45 at a steady 2.3 kW, while a near-full tank takes in only 2 kWh/h of heat.
    const h = 3_600_000, t = (hh: number, mm: number) => Date.UTC(2026, 10, 15, hh, mm);
    const used = [0, 0, 0.575, 2.875, 5.175, 5.75, 5.75], produced = used.map((u) => u * 0.87);
    const points = used.map((u, k) => ({t: t(11, 30) + k * h, used: u, produced: produced[k]}));
    const got = chargedSlots(points, 0, 6, 2.3);
    assert.deepStrictEqual([got[0], got[got.length - 1] + 1].map((slot) => new Date(slot * SLOT_MS).toISOString().slice(11, 16)),
        ['13:15', '15:45']);
});

test('chargedSlots places a part hour against the full hour beside it (Insights keeps today hourly)', () => {
    // 2026-11-15, hourly buckets: a charge 10:15–12:15 at 6 kWh/h, then quiet. 09:30–10:30 holds a
    // quarter of an hour of it, 10:30–11:30 all of it, 11:30–12:30 three quarters.
    const h = 3_600_000, t = (hh: number, mm: number) => Date.UTC(2026, 10, 15, hh, mm);
    const produced = [0, 1.5, 7.5, 12, 12];
    const points = produced.map((p, k) => ({t: t(9, 30) + k * h, produced: p}));
    const got = chargedSlots(points, 0, 6);
    assert.deepStrictEqual([got[0], got[got.length - 1] + 1].map((slot) => new Date(slot * SLOT_MS).toISOString().slice(11, 16)),
        ['10:15', '12:15']);
    assert.strictEqual(got.length, 8, 'continuous');
    assert.deepStrictEqual(chargedSlots([{t: t(9, 0), produced: 0}, {t: t(15, 0), produced: 20}], 0, 6), [], 'six hours apart: too vague');
});

test('a running charge is raised while cheap hours go on and use follows; not when cheap comes later', () => {
    // 00:00 now, a charge to 48 °C running (More hot water, Large stop 48). Cheap until 04:00,
    // expensive after, the evening's use ahead.
    const cheapNow = new Map(Array.from({length: 96}, (_, k) => [S0 + k, {price: k < 16 ? 1.0 : 3.3}]));
    const running = {litres: 110, top: 46, powerW: 2300, more: true, largeStopC: 48, stopC: 48};
    const raise = extendTarget({slot: S0, prices: cheapNow, model, tank, clock, now: running});
    assert.ok(raise, 'extended');
    assert.ok(raise!.targetC >= 48 + EXTEND_MIN_K && raise!.targetC <= 60, `to ${raise!.targetC}`);
    assert.ok(raise!.saves > 0);
    // Expensive now, cheap from 04:00: let the charge end and buy the rest later.
    const cheapLater = new Map(Array.from({length: 96}, (_, k) => [S0 + k, {price: k < 16 ? 3.3 : 1.0}]));
    assert.strictEqual(extendTarget({slot: S0, prices: cheapLater, model, tank, clock, now: running}), undefined);
    // Not a More hot water charge (the pump's own, to its demand mode's stop): never touched.
    assert.strictEqual(extendTarget({slot: S0, prices: cheapNow, model, tank, clock, now: {...running, more: false}}), undefined);
    // Nothing running.
    assert.strictEqual(extendTarget({slot: S0, prices: cheapNow, model, tank, clock, now: {...running, powerW: 0}}), undefined);
});

test('an extension never passes the highest target (the learned compressor ceiling)', () => {
    const cheapNow = new Map(Array.from({length: 96}, (_, k) => [S0 + k, {price: k < 16 ? 1.0 : 3.3}]));
    const running = {litres: 110, top: 46, powerW: 2300, more: true, largeStopC: 48, stopC: 48};
    const capped = extendTarget({slot: S0, prices: cheapNow, model, tank, clock, now: running, maxC: 50});
    assert.ok(!capped || capped.targetC <= 50, `to ${capped?.targetC}`);
    assert.strictEqual(extendTarget({slot: S0, prices: cheapNow, model, tank, clock, now: running, maxC: 48.5}), undefined, 'no room under the ceiling');
});

// 2026-11-16: 130 L went at 17:15–17:45, ahead of the usual 18–21 showers. The plan still expected
// those on top, saw the tank run out by 20:00 and charged at 19:15, the day's most expensive hour.
test('a draw that came early is not expected again at its usual hour', async () => {
    const {drawnEarly} = await import('../lib/autopilot/hotwater-shadow');
    const at = T0 + 19 * 3_600_000;
    // Readings a slot apart from 16:00: steady at 214 L, a big draw 17:00–17:45, then 60 L.
    const litres = (ms: number) => ms < T0 + 17 * 3_600_000 ? 214 : ms >= T0 + 17.75 * 3_600_000 ? 60 : 214 - 154 * (ms - (T0 + 17 * 3_600_000)) / (0.75 * 3_600_000);
    const points = [];
    for (let ms = T0 + 16 * 3_600_000; ms <= at; ms += SLOT_MS) points.push({t: ms, litres: litres(ms), produced: 100, used: 30, top: 50});
    const early = drawnEarly(points, model, at, clock, () => model.profiles.any);
    // 154 L drawn, of which the profile planned 1.5 kWh (hour 18) in the window.
    assert.ok(Math.abs(early - (154 * KWH_PER_LITRE - 1.5)) < 0.6, `early ${early}`);
    // Evening prices: 19–21 dearest, the night cheap. Without the credit it starts now, with it it waits.
    const evening = new Map(Array.from({length: 48}, (_, k) => [slotOf(at) + k, {price: k < 8 ? 3.3 : 1.2}]));
    const base = {slot: slotOf(at), prices: evening, now: {litres: 60, top: 50}};
    assert.strictEqual(entry(step(base)).action, 'start');
    assert.strictEqual(entry(step({...base, early})).action, 'wait');
    // Nothing drawn early: nothing credited.
    assert.strictEqual(drawnEarly(points.map((p) => ({...p, litres: 214})), model, at, clock, () => model.profiles.any), 0);
});

test('the widgets take the running charge the plan did not have, and mark only a solar one', () => {
    const at = Date.parse('2026-11-24T12:00:00Z');
    const e = {by: 'autopilot', at, reason: 'surplus', minutes: 60, surplusShare: 0.9, plan: 'unplanned', reserveLitres: 40} as any;
    assert.deepEqual(offPlanCharge(e, true, at + 10 * 60_000), {at, minutes: 60, reason: 'surplus', surplusShare: 0.9, targetC: undefined, solar: true});
    assert.equal(offPlanCharge(e, false, at + 10 * 60_000), undefined, 'not charging: nothing runs');
    assert.equal(offPlanCharge(e, true, at + 70 * 60_000)?.minutes, 75, 'still running past its plan: it holds to the next slot');
    assert.equal(offPlanCharge(e, true, at + 25 * 3_600_000), undefined, 'a day-old start stands in for nothing');
    assert.equal(offPlanCharge({...e, plan: 'as_planned'}, true, at), undefined, 'the plan has it');
    assert.equal(offPlanCharge({...e, shadow: true}, true, at), undefined, 'a test run writes nothing');
    assert.equal(offPlanCharge({...e, reason: 'before_use', plan: 'moved'}, true, at)?.solar, false, 'moved for use: shown, not marked');
    assert.equal(offPlanCharge({...e, by: 'pump'}, true, at)?.solar, false, 'the pump started it: shown, not marked');
});

test('a moved charge takes its planned start off the widgets for the day', () => {
    const at = Date.parse('2026-11-24T19:00:00Z'), plannedAt = Date.parse('2026-11-24T22:00:00Z');
    const e = {by: 'autopilot', at, reason: 'before_use', minutes: 90, plan: 'moved', plannedAt, reserveLitres: 40} as any;
    assert.equal(movedFrom(e, at + 3 * 3_600_000), plannedAt);
    assert.equal(movedFrom({...e, plan: 'unplanned'}, at), undefined);
    assert.equal(movedFrom(e, at + 25 * 3_600_000), undefined, 'tomorrow the plan is new');
});

test('chargeTokens gives the trigger its target and price, the slot price for a pump charge', () => {
    const text = {reason: 'R', detailedReason: 'D'};
    const auto = chargeTokens({at: 0, by: 'autopilot', reason: 'cheap', targetC: 55, price: 0.84321, reserveLitres: 60}, text, 2);
    assert.deepStrictEqual(auto, {reason: 'R', detailed_reason: 'D', autopilot: true, target_temperature: 55, price: 0.843});
    const pump = chargeTokens({at: 0, by: 'pump', reason: 'pump', targetC: 50.04, reserveLitres: 60}, text, 1.2);
    assert.deepStrictEqual([pump.autopilot, pump.target_temperature, pump.price], [false, 50, 1.2]);
    const unknown = chargeTokens({at: 0, by: 'pump', reason: 'pump', reserveLitres: 60}, text);
    assert.deepStrictEqual([unknown.target_temperature, unknown.price], [null, null]);
});
