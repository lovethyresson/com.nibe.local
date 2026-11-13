/** Slice 4: solar surplus, the live lever and the day type. */
import {test} from 'node:test';
import assert from 'node:assert';
import {HotwaterModel, localClock} from '../lib/autopilot/hotwater-learner';
import {dailyPlan, hotwaterShadowStep} from '../lib/autopilot/hotwater-shadow';
import {slotOf} from '../lib/autopilot/prices';
import {
    LIVE_MIN_READINGS, MIN_SUNNY_HOURS, SUNNY_GHI, fitSurplus, gridMeter, hasGenerator, hourlyExport, hourlyGhi,
    liveSurplusKw, liveSurplusW, surplusForecast,
} from '../lib/autopilot/hotwater-surplus';
import {BELOW_TARGET_K, DEMAND_LARGE, DEMAND_SMART, MAX_STARTS_PER_DAY, MAX_STOP_WRITES_PER_DAY, countFor, leverDecision} from '../lib/autopilot/hotwater-lever';
import {dayTypeAt, readDayType, recordDayType} from '../lib/autopilot/day-type';
import {DAY_TYPE_CAPABILITY, allRoles, capabilitySyncPlan, extraCapabilities, extraCapabilityOptions, possibleExtraCapabilities} from '../lib/roles';
import {sProfile} from '../drivers/nibe_s/profile';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 5, 9); // a June midnight, UTC

// ---- Surplus ----

test('Open-Meteo radiation is the mean over the hour before its timestamp', () => {
    const ghi = hourlyGhi({hourly: {time: [T0 / 1000 + 3600, T0 / 1000 + 7200], shortwave_radiation: [120, null]}});
    assert.deepStrictEqual([...ghi], [[T0, 120]]);
});

test('a cumulative meter becomes kWh per hour; a reset or a gap is not counted', () => {
    const step = 15 * 60_000;
    const at = (k: number) => new Date(T0 + k * step).toISOString();
    const values = [{t: at(0), v: 10}, {t: at(1), v: 10.5}, {t: at(2), v: 11}, {t: at(3), v: 11.5}, {t: at(4), v: 12},
        {t: at(5), v: 1}, {t: at(7), v: 3}];
    const hourly = hourlyExport({step, values});
    assert.strictEqual(hourly.get(T0), 1.5);
    assert.strictEqual(hourly.get(T0 + HOUR), 0.5, 'the reset (12 → 1) and the gap (5 → 7) are left out');
    assert.strictEqual(hourlyExport({step: 6 * HOUR, values}).size, 0, 'too coarse to place in an hour');
});

test('the fit recovers export against sun, and refuses without enough sunny hours or a rising line', () => {
    const ghi = new Map<number, number>(), exported = new Map<number, number>();
    for (let h = 0; h < 40; h++) {
        const g = 100 + 20 * h;
        ghi.set(T0 + h * HOUR, g);
        exported.set(T0 + h * HOUR, 0.006 * g - 0.8);
    }
    ghi.set(T0 + 50 * HOUR, 10); exported.set(T0 + 50 * HOUR, 3); // a battery selling at night: ignored
    const fit = fitSurplus(ghi, exported)!;
    assert.ok(Math.abs(fit.a - 0.006) < 1e-9 && Math.abs(fit.b + 0.8) < 1e-9, JSON.stringify(fit));
    assert.strictEqual(fit.hours, 40);
    const few = new Map([...ghi].slice(0, MIN_SUNNY_HOURS - 1));
    assert.strictEqual(fitSurplus(few, exported), undefined);
    const flat = new Map([...exported].map(([k]) => [k, 0]));
    assert.strictEqual(fitSurplus(ghi, flat), undefined, 'more sun, no more export: no panels to plan with');
    const ahead = surplusForecast(fit, new Map([[T0, 800], [T0 + HOUR, SUNNY_GHI - 1]]), [T0 + 15 * 60_000, T0 + HOUR, T0 + 2 * HOUR]);
    assert.deepStrictEqual(ahead.map((v) => Math.round(v * 100) / 100), [4, 0, 0]);
});

test('live surplus is the export the sun made: a battery selling or no grid meter is none', () => {
    assert.strictEqual(liveSurplusW({totalCumulative: {W: -2500}, totalGenerated: {W: 4000}}), 2500);
    assert.strictEqual(liveSurplusW({totalCumulative: {W: -2500}, totalGenerated: {W: 0}}), 0, 'a battery exporting at night');
    assert.strictEqual(liveSurplusW({totalCumulative: {W: -2500}, totalGenerated: {W: -1500}}), 1500, 'either sign of generation');
    assert.strictEqual(liveSurplusW({totalCumulative: {W: 800}, totalGenerated: {W: 3000}}), 0, 'importing');
    assert.strictEqual(liveSurplusW({totalGenerated: {W: 3000}}), undefined);
    const now = T0 + HOUR;
    const readings = Array.from({length: LIVE_MIN_READINGS}, (_, k) => ({at: now - k * 60_000, w: 2000}));
    assert.strictEqual(liveSurplusKw(readings, now), 2);
    assert.strictEqual(liveSurplusKw(readings.slice(1), now), undefined, 'too few readings yet');
});

test('the grid meter is the one Homey Energy counts; a home without a generator has no surplus', () => {
    const devices = {
        dongle: {energyObj: {cumulative: true, cumulativeExportedCapability: 'meter_power.exported', W: -314}},
        battery: {energyObj: {homeBattery: true, W: -2534}},
        sensor: {energyObj: {cumulative: true, cumulativeExportedCapability: 'meter_power.exported', W: -1199}},
        panels: {energyObj: {generator: true, W: 0}},
    };
    assert.deepStrictEqual(gridMeter(devices, {totalCumulative: {W: -327}}), {id: 'dongle', exported: 'meter_power.exported'});
    assert.ok(hasGenerator(devices));
    assert.ok(!hasGenerator({dongle: devices.dongle}));
    assert.strictEqual(gridMeter({battery: devices.battery}, {}), undefined);
});

// ---- The planner with surplus ----

const clock = localClock('UTC');
const S0 = slotOf(T0);
const tank = {litres: 176, inletC: 10};
const hours = Array.from({length: 24}, (_, h) => h === 6 ? 1.6 : h >= 18 && h <= 21 ? 1.5 : 0);
const model: HotwaterModel = {
    loss: {base: 0.03, perKwh: 0.01, samples: 50},
    charge: {heatPerHour: 6, cop: 2.9, copPerK: -0.02, atTop: 48, samples: 50},
    profiles: {any: {days: 30, hours, p80: hours.map((v) => v * 1.3), daily: 7.6, dailyP80: 10},
        working: {days: 20, hours, p80: hours.map((v) => v * 1.3), daily: 7.6, dailyP80: 10}},
    away: [], days: 30,
};
const prices = new Map(Array.from({length: 96}, (_, k) => [S0 + k, {price: 1.9, spot: 0.6}]));

test('flat prices and a sunny midday: the evening charge moves into the surplus', () => {
    const now = {litres: 150, top: 52};
    const input = {slot: S0 + 28, prices, model, tank, clock, now, dayType: 'working' as const};
    const surplus = new Map(Array.from({length: 96}, (_, k) => {
        const h = Math.floor(k / 4);
        return [S0 + k, h >= 10 && h < 15 ? 3 : 0];
    }));
    const sunny = dailyPlan({...input, surplus});
    assert.ok(!('skip' in sunny));
    const solar = sunny.charges.find((c) => c.reason === 'surplus');
    assert.ok(solar, `a surplus charge: ${JSON.stringify(sunny.charges)}`);
    const h = new Date(solar!.at).getUTCHours();
    assert.ok(h >= 10 && h < 15, `in the sun, at ${h}`);
    assert.ok(solar!.surplusShare >= 0.5);
    const dull = dailyPlan(input);
    assert.ok(!('skip' in dull) && !dull.charges.some((c) => c.reason === 'surplus'));
    assert.ok(sunny.cost < dull.cost, `surplus is cheaper: ${sunny.cost} against ${dull.cost}`);
});

test('surplus right now starts a charge when the tank has room', () => {
    const slot = S0 + 48; // 12:00
    const surplus = new Map([[slot, 3], [slot + 1, 3]]);
    const step = hotwaterShadowStep({slot, prices, model, tank, clock, now: {litres: 90, top: 46}, surplus});
    assert.ok('entry' in step);
    assert.strictEqual(step.entry.action, 'start');
    const none = hotwaterShadowStep({slot, prices, model, tank, clock, now: {litres: 90, top: 46}});
    assert.ok('entry' in none);
    assert.strictEqual(none.entry.action, 'wait');
});

// ---- The lever ----

const fresh = countFor(undefined, '2026-06-09');
const facts = {top: 44, largeStopC: 50, demandMode: 0, allowed: true, spaHotwater: false};

test('a start writes 62 to the planned temperature when it differs, then 697', () => {
    assert.deepStrictEqual(leverDecision(55, facts, fresh), {targetC: 55, writeStop: true});
    assert.deepStrictEqual(leverDecision(50.2, facts, fresh), {targetC: 50.2, writeStop: false}, 'within half a degree: no write');
});

test('in demand mode Large the owner\'s stop is never written: Autopilot chooses when only', () => {
    assert.deepStrictEqual(leverDecision(58, {...facts, demandMode: DEMAND_LARGE}, fresh), {targetC: 50, writeStop: false});
    assert.deepStrictEqual(leverDecision(58, {...facts, demandMode: DEMAND_LARGE, largeStopC: undefined}, fresh),
        {skip: 'no stop reading'});
});

test('the writes are capped per day; past the 62 cap a charge runs to the stop already set', () => {
    const stops = {...fresh, stops: MAX_STOP_WRITES_PER_DAY};
    assert.deepStrictEqual(leverDecision(58, facts, stops), {targetC: 50, writeStop: false});
    assert.deepStrictEqual(leverDecision(58, facts, {...fresh, starts: MAX_STARTS_PER_DAY}), {skip: 'daily limit'});
    assert.deepStrictEqual(countFor({date: '2026-06-08', starts: 3, stops: 3}, '2026-06-09'), fresh, 'a new day resets');
});

test('it stays out of the pump\'s way, and skips a charge that buys nothing', () => {
    assert.deepStrictEqual(leverDecision(55, {...facts, allowed: false}, fresh), {skip: 'hot water off'});
    assert.deepStrictEqual(leverDecision(55, {...facts, spaHotwater: true}, fresh), {skip: 'smart price adaption'});
    assert.deepStrictEqual(leverDecision(55, {...facts, demandMode: DEMAND_SMART}, fresh), {skip: 'smart control'});
    assert.deepStrictEqual(leverDecision(55, {...facts, top: undefined}, fresh), {skip: 'no tank reading'});
    assert.deepStrictEqual(leverDecision(55, {...facts, top: 55 - BELOW_TARGET_K + 0.5}, fresh), {skip: 'tank hot enough'});
});

// ---- The day type ----

test('the day type keeps its history, and every past moment has the type in force then', () => {
    let state = recordDayType(undefined, 'working', 1000);
    state = recordDayType(state, 'working', 2000);
    assert.strictEqual(state.log.length, 1, 'the same type again changes nothing');
    state = recordDayType(state, 'away', 5000);
    assert.strictEqual(state.type, 'away');
    assert.strictEqual(dayTypeAt(state, 500), undefined, 'before the first was set');
    assert.strictEqual(dayTypeAt(state, 4999), 'working');
    assert.strictEqual(dayTypeAt(state, 5000), 'away');
    assert.deepStrictEqual(readDayType({type: 'free', log: [{at: 1, type: 'free'}, {at: 'x', type: 'free'}, {at: 2, type: 'holiday'}]}),
        {type: 'free', log: [{at: 1, type: 'free'}]});
    assert.strictEqual(readDayType({type: 'holiday', log: []}), undefined);
    assert.strictEqual(readDayType(null), undefined);
});

test('the day type is on Main only, and only while Autopilot hot water is on', () => {
    for (const role of allRoles)
        assert.strictEqual(possibleExtraCapabilities(sProfile, role).includes(DAY_TYPE_CAPABILITY), role === 'main', role);
    assert.ok(!extraCapabilities(sProfile, 'main', null).includes(DAY_TYPE_CAPABILITY));
    assert.ok(extraCapabilities(sProfile, 'main', null, 'autopilot').includes(DAY_TYPE_CAPABILITY));
    assert.ok(!extraCapabilities(sProfile, 'hotwater', null, 'autopilot').includes(DAY_TYPE_CAPABILITY));
    assert.ok(extraCapabilityOptions('main', DAY_TYPE_CAPABILITY)?.title?.en);
    const off = capabilitySyncPlan(sProfile, 'main', null, [DAY_TYPE_CAPABILITY], 'off');
    assert.ok(off.toRemove.includes(DAY_TYPE_CAPABILITY), 'turning Autopilot off takes it away again');
    assert.ok(sProfile.compose.capabilities.includes(DAY_TYPE_CAPABILITY), 'in the compose superset');
});

test('Away is a trip: a nightly working/free Flow does not end it, and Away off goes back to the latest of them', async () => {
    const {setAway} = await import('../lib/autopilot/day-type');
    let state = recordDayType(undefined, 'free', 1000);
    state = setAway(state, true, 2000)!;
    assert.strictEqual(state.type, 'away');
    assert.strictEqual(state.base, 'free');
    state = recordDayType(state, 'working', 3000, true);
    assert.strictEqual(state.type, 'away', 'the nightly card keeps Away');
    assert.strictEqual(state.base, 'working');
    assert.strictEqual(dayTypeAt(state, 3500), 'away', 'not logged: the learner still files the day as away');
    state = setAway(state, false, 4000)!;
    assert.strictEqual(state.type, 'working');
    assert.strictEqual(state.base, undefined);
    assert.strictEqual(dayTypeAt(state, 4000), 'working');
    assert.strictEqual(setAway(state, false, 5000), state, 'off when not away changes nothing');
    assert.strictEqual(recordDayType(setAway(state, true, 6000)!, 'free', 7000).type, 'free', 'the Main picker, without keepAway, ends Away');
    assert.strictEqual(setAway(setAway(undefined, true, 1)!, false, 2)!.type, 'working', 'no type before Away: back to working');
    assert.deepStrictEqual(readDayType({type: 'away', log: [], base: 'free'})?.base, 'free');
    assert.strictEqual(readDayType({type: 'away', log: [], base: 'away'})?.base, undefined);
});
