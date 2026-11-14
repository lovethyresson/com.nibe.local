/** Slice 4: solar surplus, the live lever and the day type. */
import {test} from 'node:test';
import assert from 'node:assert';
import {HotwaterModel, localClock} from '../lib/autopilot/hotwater-learner';
import {dailyPlan, hotwaterShadowStep} from '../lib/autopilot/hotwater-shadow';
import {slotOf} from '../lib/autopilot/prices';
import {
    ExportBucket, LIVE_MIN_READINGS, MIN_SUNNY_HOURS, SUNNY_GHI, exportBuckets, fitSurplus, gridMeter, gridMeters, hourlyExport, hourlyGhi,
    mergeBuckets, peakExportKw, solarDevices,
    liveSurplusKw, liveSurplusW, sunNow, surplusForecast,
} from '../lib/autopilot/hotwater-surplus';
import {BELOW_TARGET_K, DEMAND_LARGE, DEMAND_SMART, MAX_STARTS_PER_DAY, MAX_STOP_WRITES_PER_DAY, countFor, leverDecision} from '../lib/autopilot/hotwater-lever';
import {dayTypeAt, readDayType, recordDayType} from '../lib/autopilot/day-type';
import {DAY_TYPE_CAPABILITY, allRoles, autopilotInputs, capabilitySyncPlan, changeReason, extraCapabilities, extraCapabilityOptions, possibleExtraCapabilities} from '../lib/roles';
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

test('coarse Insights buckets keep their span, and finer ones win where both cover a time', () => {
    const step = 6 * HOUR;
    const at = (k: number) => new Date(T0 + k * step).toISOString();
    const coarse = exportBuckets({step, values: [{t: at(0), v: 0}, {t: at(1), v: 6}, {t: at(2), v: 9}]});
    assert.deepStrictEqual(coarse, [{start: T0 + 3 * HOUR, hours: 6, kwh: 6}, {start: T0 + 9 * HOUR, hours: 6, kwh: 3}]);
    const fine = [{start: T0 + 12 * HOUR, hours: 1, kwh: 1}];
    assert.deepStrictEqual(mergeBuckets([fine, coarse]).map((b) => b.start), [T0 + 3 * HOUR, T0 + 12 * HOUR],
        'the 6-hour bucket overlapping the hourly data is dropped');
    assert.strictEqual(peakExportKw([...coarse, ...fine, {start: T0, hours: 1, kwh: 2.4}]), 2.4);
    assert.strictEqual(peakExportKw(coarse), undefined, 'no hourly data, no peak to show');
});

test('the fit recovers export against sun, and refuses without enough sunny hours or a rising line', () => {
    const ghi = new Map<number, number>();
    const buckets: ExportBucket[] = [];
    for (let h = 0; h < 40; h++) {
        const g = 100 + 20 * h;
        ghi.set(T0 + h * HOUR, g);
        buckets.push({start: T0 + h * HOUR, hours: 1, kwh: 0.006 * g - 0.8});
    }
    ghi.set(T0 + 50 * HOUR, 10); buckets.push({start: T0 + 50 * HOUR, hours: 1, kwh: 3}); // a battery selling at night: ignored
    const fit = fitSurplus(ghi, buckets, T0 + 60 * HOUR)!;
    assert.ok(Math.abs(fit.a - 0.006) < 1e-9 && Math.abs(fit.b + 0.8) < 1e-9, JSON.stringify(fit));
    assert.strictEqual(fit.hours, 40);
    assert.strictEqual(fitSurplus(ghi, buckets.slice(0, MIN_SUNNY_HOURS - 1)), undefined);
    assert.strictEqual(fitSurplus(ghi, buckets.map((b) => ({...b, kwh: 0}))), undefined, 'more sun, no more export: no panels to plan with');
    const ahead = surplusForecast(fit, new Map([[T0, 800], [T0 + HOUR, SUNNY_GHI - 1]]), [T0 + 15 * 60_000, T0 + HOUR, T0 + 2 * HOUR]);
    assert.deepStrictEqual(ahead.map((v) => Math.round(v * 100) / 100), [4, 0, 0]);
});

test('older, coarser history extends the fit: a 6-hour bucket counts only when sunny all through', () => {
    const ghi = new Map<number, number>();
    const buckets: ExportBucket[] = [];
    // Two weeks of winter: 5 sunny hours, too few on their own.
    const now = T0 + 90 * 24 * HOUR;
    for (let h = 0; h < 5; h++) {
        const t = now - 24 * HOUR + h * HOUR, g = 100 + 40 * h;
        ghi.set(t, g); buckets.push({start: t, hours: 1, kwh: 0.005 * g - 0.3});
    }
    assert.strictEqual(fitSurplus(ghi, buckets, now), undefined);
    // Autumn, 6-hour buckets: sunny all through on 4 days, one with a dark hour (left out).
    for (let d = 0; d < 5; d++) {
        const start = now - (60 - d) * 24 * HOUR;
        let kwh = 0;
        for (let h = 0; h < 6; h++) {
            const g = d === 4 && h === 5 ? 20 : 150 + 50 * h + 30 * d;
            ghi.set(start + h * HOUR, g); kwh += 0.005 * g - 0.3;
        }
        buckets.push({start, hours: 6, kwh: d === 4 ? kwh + 5 : kwh});
    }
    const fit = fitSurplus(ghi, buckets, now)!;
    assert.strictEqual(fit.hours, 29);
    assert.ok(Math.abs(fit.a - 0.005) < 1e-9 && Math.abs(fit.b + 0.3) < 1e-9, JSON.stringify(fit));
});

test('live surplus is the export the sun made: a battery selling or no grid meter is none', () => {
    assert.strictEqual(liveSurplusW({totalCumulative: {W: -2500}, totalGenerated: {W: 4000}}), 2500);
    assert.strictEqual(liveSurplusW({totalCumulative: {W: -2500}, totalGenerated: {W: 0}}), 2500, 'export is export, whatever the inverter says');
    assert.strictEqual(liveSurplusW({totalCumulative: {W: 6260}, totalGenerated: {W: 3423}}), 0, 'the sun all going into a battery is no surplus');
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
    assert.strictEqual(gridMeter({battery: devices.battery}, {}), undefined);
    assert.deepStrictEqual(gridMeter(devices, {totalCumulative: {W: -327}}, 'sensor'), {id: 'sensor', exported: 'meter_power.exported'},
        'the owner picked the other meter in setup');
    assert.deepStrictEqual(gridMeter(devices, {totalCumulative: {W: -327}}, 'gone'), {id: 'dongle', exported: 'meter_power.exported'});
    assert.deepStrictEqual(gridMeters(devices, {totalCumulative: {W: -327}}).map((m) => m.id), ['dongle', 'sensor']);
    assert.deepStrictEqual(solarDevices(devices), [{id: 'panels', name: 'panels', w: 0}]);
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
    assert.strictEqual(dayTypeAt(state, 500), 'working', 'before the first was set: there is always a day type');
    assert.strictEqual(dayTypeAt(undefined, 500), 'working', 'never set: working');
    assert.strictEqual(dayTypeAt(state, 4999), 'working');
    assert.strictEqual(dayTypeAt(state, 5000), 'away');
    assert.deepStrictEqual(readDayType({type: 'free', log: [{at: 1, type: 'free'}, {at: 'x', type: 'free'}, {at: 2, type: 'holiday'}]}),
        {type: 'free', log: [{at: 1, type: 'free'}]});
    assert.strictEqual(readDayType({type: 'holiday', log: []}), undefined);
    assert.strictEqual(readDayType(null), undefined);
});

test('where no day type was set, the calendar decides: weekends free; Away hands back to it', async () => {
    const {setAway, calendarDayType} = await import('../lib/autopilot/day-type');
    const {localClock} = await import('../lib/autopilot/hotwater-learner');
    const clock = localClock('Europe/Stockholm');
    const at = (iso: string) => Date.parse(iso);
    const fri = at('2026-11-13T22:30:00Z'), sat = at('2026-11-13T23:30:00Z'), mon = at('2026-11-16T08:00:00Z');
    assert.strictEqual(calendarDayType(clock, fri), 'working', 'Friday 23:30 local');
    assert.strictEqual(calendarDayType(clock, sat), 'free', 'Saturday 00:30 local, still Friday in UTC');
    assert.strictEqual(dayTypeAt(undefined, sat, clock), 'free');
    assert.strictEqual(dayTypeAt({type: 'working', log: []}, sat, clock), 'free', 'the stored placeholder is not a choice');
    assert.strictEqual(dayTypeAt(undefined, sat), 'working', 'without a clock: the default');
    // A Flow that starts setting the type on a Tuesday: the weekend before is the calendar's.
    const tue = at('2026-11-10T11:00:00Z');
    let state = recordDayType({type: 'working', log: []}, 'working', tue);
    assert.strictEqual(state.log.length, 1, 'setting working under the calendar is a choice, logged');
    assert.strictEqual(dayTypeAt(state, at('2026-11-08T10:00:00Z'), clock), 'free', 'the Sunday before');
    assert.strictEqual(dayTypeAt(state, sat, clock), 'working', 'after a choice, it holds until changed');
    // Away in a home under the calendar goes back to the calendar, not to working.
    let calendar = setAway({type: 'working', log: []}, true, fri)!;
    assert.strictEqual(calendar.base, undefined);
    calendar = setAway(calendar, false, sat)!;
    assert.strictEqual(dayTypeAt(calendar, sat + 1, clock), 'free');
    assert.strictEqual(dayTypeAt(calendar, mon, clock), 'working');
    assert.strictEqual(dayTypeAt(calendar, fri + 1, clock), 'away');
    assert.deepStrictEqual(readDayType(calendar)?.log.at(-1), {at: sat, type: 'working', auto: true});
    assert.strictEqual(recordDayType(calendar, 'working', mon).log.length, 3, 'working chosen after Away is a choice');
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
    assert.strictEqual(setAway(setAway(undefined, true, 1)!, false, 2)!.type, 'working', 'no type before Away: a placeholder');
    assert.deepStrictEqual(readDayType({type: 'away', log: [], base: 'free'})?.base, 'free');
    assert.strictEqual(readDayType({type: 'away', log: [], base: 'away'})?.base, undefined);
});

test('live export is the sun\'s only while the forecast has sun', () => {
    const hour = Date.UTC(2026, 10, 14, 9);
    const ghi = new Map([[hour, 180], [hour + 3_600_000, 0]]);
    assert.ok(sunNow(ghi, hour + 20 * 60_000));
    assert.ok(!sunNow(ghi, hour + 70 * 60_000), 'night: a battery selling');
    assert.ok(!sunNow(ghi, hour + 3 * 3_600_000), 'no forecast for the hour');
});

test('a running Autopilot keeps what it reads, whatever was ticked, and gives the owner\'s choice back when off', () => {
    const inputs = autopilotInputs(sProfile, 'hotwater', 'autopilot');
    const spec = sProfile.autopilotHotwater!;
    for (const name of [spec.tank.top, spec.tank.produced, spec.tank.used, spec.tank.litres]) assert.ok(inputs.includes(name), name);
    // The owner switched the whole hot water group and the energy pair off, but chose a tank.
    const selection = {groups: {hotwater: false, energy: false}, overrides: {}, hotwater: {tankId: 'custom', litres: 180}} as any;
    const on = capabilitySyncPlan(sProfile, 'hotwater', selection, [], 'autopilot').wanted;
    for (const name of [spec.tank.top, spec.tank.produced, spec.tank.used, spec.tank.litres, spec.power])
        assert.ok(on.includes(name), `${name} kept while Autopilot runs`);
    const test = capabilitySyncPlan(sProfile, 'hotwater', selection, [], 'test').wanted;
    assert.ok(test.includes(spec.tank.top), 'Simulation reads the same');
    const off = capabilitySyncPlan(sProfile, 'hotwater', selection, on, 'off');
    assert.ok(!off.wanted.includes(spec.tank.top) && off.toRemove.includes(spec.tank.top), 'off: the owner\'s choice is back');
    assert.deepStrictEqual(selection.overrides, {}, 'the stored selection is untouched');
    // Heating keeps what it acts on that lives on the Heating device; Main's readings stay Main's.
    const heat = autopilotInputs(sProfile, 'heating', 'autopilot');
    for (const name of ['measure_degree_minutes_NIBE.h11_degree_minutes', 'measure_temperature.i5_heating_supply', 'target_temperature'])
        assert.ok(heat.includes(name), name);
    assert.ok(!heat.includes('measure_frequency.i1046_compressor'), 'compressor speed is on Main');
    assert.deepStrictEqual(autopilotInputs(sProfile, 'hotwater', 'spa'), []);
});

test('What changes says why: Autopilot\'s own, what it acts on, what it takes over, and the owner\'s own', () => {
    const spec = sProfile.autopilotHotwater!;
    assert.equal(changeReason(sProfile, 'heating', 'autopilot_status_NIBE', true, 'autopilot'), 'autopilot');
    assert.equal(changeReason(sProfile, 'heating', 'autopilot_status_NIBE', false, 'off'), 'autopilot_off');
    assert.equal(changeReason(sProfile, 'heating', 'boolean_NIBE.h844_spa_heating_activated', false, 'autopilot'), 'autopilot_handles');
    assert.equal(changeReason(sProfile, 'heating', 'boolean_NIBE.h844_spa_heating_activated', true, 'off'), 'spa_back');
    assert.equal(changeReason(sProfile, 'hotwater', spec.tank.top, true, 'autopilot'), 'autopilot_uses');
    assert.equal(changeReason(sProfile, 'hotwater', spec.tank.top, true, 'off'), 'you_on', 'without Autopilot it is the owner\'s pick');
    assert.equal(changeReason(sProfile, 'hotwater', spec.tank.litres, true, 'autopilot'), 'tank');
    assert.equal(changeReason(sProfile, 'heating', 'measure_temperature.i5_heating_supply', false, 'off'), 'you_off');
});
