import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    BACKFILL_RESOLUTIONS, BackfillLogs, anyLogRead, backfillSources, backfillWindow, bucketsOf, fetchHeatingInsights, insertBackfill,
    slotsFromInsights, withWeather,
} from '../lib/autopilot/heating-insights';
import {FIELDS, FLAG, Field, History} from '../lib/autopilot/history';
import {SOURCE_CODE, currentSourceStart, outdoorSourceCode} from '../lib/autopilot/outdoor';
import {SLOT_MS} from '../lib/autopilot/prices';
import {WeatherSlot} from '../lib/autopilot/weather';
import {fitHistory, modelSlotsFromHistory} from '../lib/autopilot/house';
import {RADIATOR_HOUSE, SIM_START_SLOT, simulateHouse} from './autopilot-house-sim';

const HOUR = 3_600_000;
const FIVE = 5 * 60_000;
const T0 = Date.UTC(2026, 10, 1); // 00:00 UTC
const S0 = T0 / SLOT_MS;
const iso = (ms: number) => new Date(ms).toISOString();

/** What `api.insights.getLogEntries` returns: bucket starts as ISO strings, means as numbers,
 *  null where the log has nothing. */
const log = (step: number, from: number, values: (number | null | boolean)[]) =>
    ({step, values: values.map((v, k) => ({t: iso(from + k * step), v}))}) as any;

const empty = () => Object.fromEntries(FIELDS.map((f) => [f, NaN])) as Record<Field, number>;

test('buckets: means at the middle, booleans as 0/1, nulls skipped, a missing step taken from the gaps, coarse dropped', () => {
    const b = bucketsOf(log(HOUR, T0, [20, null, 21]));
    assert.deepEqual(b.map((x) => [x.c - T0, x.v]), [[HOUR / 2, 20], [2.5 * HOUR, 21]]);
    assert.deepEqual(bucketsOf(log(FIVE, T0, [true, false])).map((x) => x.v), [1, 0]);
    const noStep = {values: [{t: iso(T0), v: 1}, {t: iso(T0 + FIVE), v: 2}, {t: iso(T0 + 3 * FIVE), v: 3}]};
    assert.equal(bucketsOf(noStep)[0].step, FIVE);
    assert.deepEqual(bucketsOf(log(6 * HOUR, T0, [1, 2])), [], 'six-hour buckets say nothing about a slot');
    assert.deepEqual(bucketsOf(undefined), []);
});

test('five-minute buckets make a measured slot; hourly ones an interpolated one, flagged', () => {
    // 24 h of hourly indoor, the last 2 h also at 5 minutes.
    const hourly = log(HOUR, T0, Array.from({length: 24}, (_, h) => 20 + h * 0.1));
    const fine = log(FIVE, T0 + 22 * HOUR, Array.from({length: 24}, (_, k) => 30 + Math.floor(k / 3)));
    const slots = slotsFromInsights({ti: [fine, hourly], bt1: [undefined as any, log(HOUR, T0, Array(24).fill(1))]}, S0, S0 + 96);
    const at = (slot: number) => slots.find((s) => s.slot === slot)!.values;
    // 00:00–00:15: its middle lies before the first hourly middle, so no line yet.
    assert.equal(slots.find((s) => s.slot === S0), undefined, 'before the first middle there is no line');
    // 01:15–01:30: middle 01:22:30, between 00:30 (20.0) and 01:30 (20.1).
    assert.ok(Math.abs(at(S0 + 5).ti - (20 + 0.1 * (52.5 / 60))) < 1e-9);
    assert.ok(at(S0 + 5).flags & FLAG.hourly);
    assert.ok(at(S0 + 5).flags & FLAG.backfill);
    assert.ok(Number.isNaN(at(S0 + 5).coverage));
    // 22:00–22:15: three 5-minute buckets of 30 → measured, the finer resolution wins.
    assert.equal(at(S0 + 88).ti, 30);
    assert.equal(at(S0 + 89).ti, 31);
    assert.equal(at(S0 + 88).flags & FLAG.hourly, FLAG.hourly, 'bt1 here is still hourly');
    const onlyFine = slotsFromInsights({ti: [fine]}, S0 + 88, S0 + 96);
    assert.equal(onlyFine.length, 8);
    assert.ok(onlyFine.every((s) => !(s.values.flags & FLAG.hourly)), 'measured slots are not flagged hourly');
});

test('no line is drawn across a missing hour', () => {
    const slots = slotsFromInsights({ti: [log(HOUR, T0, [20, 20, null, null, 22, 22])]}, S0, S0 + 24);
    const ti = (slot: number) => slots.find((s) => s.slot === slot)?.values.ti;
    assert.equal(ti(S0 + 4), 20);
    assert.equal(ti(S0 + 8), undefined, 'the gap is left out');
    assert.equal(ti(S0 + 18), 22);
});

test('counters are read at the slot end, settings held, booleans as numbers', () => {
    const counter = log(HOUR, T0, [100, 104, 106]); // means = the counter at 00:30, 01:30, 02:30
    const curve = log(HOUR, T0, [5, 5, 6]);
    const room = log(HOUR, T0, [true, true, false]);
    const slots = slotsFromInsights({qmeter: [undefined as any, counter], hcurve: [curve], roomctl: [room], ti: [log(FIVE, T0, Array(36).fill(20))]},
        S0, S0 + 12);
    const at = (k: number) => slots.find((s) => s.slot === S0 + k)!.values;
    assert.equal(at(1).qmeter, 100, 'slot ending 00:30 is the first middle');
    assert.equal(at(3).qmeter, 102, 'slot ending 01:00: half way');
    assert.equal(at(5).qmeter, 104);
    assert.equal(at(9).qmeter, 106);
    assert.equal(at(7).hcurve, 5);
    assert.equal(at(8).hcurve, 6, '02:00–02:15 is in the bucket that says 6');
    assert.equal(at(3).roomctl, 1);
    assert.equal(at(9).roomctl, 0);
});

test('outdoor: the sensor when there is one, with its own source code; else input 1 as wired', () => {
    const bt1 = log(HOUR, T0, Array(6).fill(4));
    const sensor = log(HOUR, T0, [2, 2, 2, null, null, null]);
    const slots = slotsFromInsights({bt1: [bt1], sensor: [sensor]}, S0, S0 + 24, 'dev-9/measure_temperature');
    const at = (k: number) => slots.find((s) => s.slot === S0 + k)!.values;
    assert.equal(at(4).te, 2);
    assert.equal(at(4).bt1, 4, 'input 1 is kept for the heat curve');
    assert.equal(at(4).tesrc, outdoorSourceCode('sensor', 'dev-9/measure_temperature'));
    assert.ok(at(4).flags & FLAG.sensorOutdoor);
    assert.equal(at(16).te, 4);
    assert.equal(at(16).tesrc, SOURCE_CODE.wired);
    assert.equal(at(16).flags & FLAG.sensorOutdoor, 0);
    assert.equal(at(16).flags & FLAG.fedOutdoor, 0, 'before the app collected, it never fed BT1');
});

test('the outdoor source rule reads a backfilled sensor run as one with the polled run after it', () => {
    const id = 'dev-9/measure_temperature';
    const backfilled = slotsFromInsights({sensor: [log(HOUR, T0, Array(48).fill(3))], bt1: [log(HOUR, T0, Array(48).fill(5))]},
        S0, S0 + 190, id).map((s) => s.values.tesrc);
    const polled = Array(100).fill(outdoorSourceCode('sensor', id));
    assert.equal(currentSourceStart([...backfilled, ...polled]), 0, 'same sensor: no change at the seam');
    const wired = slotsFromInsights({bt1: [log(HOUR, T0, Array(48).fill(5))]}, S0, S0 + 190).map((s) => s.values.tesrc);
    assert.equal(currentSourceStart([...wired, ...polled]), wired.length, 'wired, then a sensor: the change is seen');
});

test('a slot with neither indoor nor outdoor is left out', () => {
    const slots = slotsFromInsights({hz: [log(HOUR, T0, [50, 50, 50])]}, S0, S0 + 12);
    assert.equal(slots.length, 0);
});

test('weather fills the sun; a slot with no outdoor reading takes the corrected forecast', () => {
    const slots = slotsFromInsights({ti: [log(HOUR, T0, [20, 20, 20])], bt1: [log(HOUR, T0, [5, 5, null])]}, S0, S0 + 12);
    const w = (slot: number): WeatherSlot => ({slot, te: 1, gtiS: 300, gtiE: 50, gtiW: 60, ghi: 200, wind: 3, rh: 80, cloud: 20});
    const weather = new Map(slots.map((s) => [s.slot, w(s.slot)]));
    const out = withWeather(slots, weather, () => 0.5);
    const at = (k: number) => out.find((s) => s.slot === S0 + k)!.values;
    assert.equal(at(2).gtiS, 300);
    assert.equal(at(2).te, 5, 'a real reading stays');
    assert.equal(at(8).te, 1.5);
    assert.equal(at(8).tesrc, SOURCE_CODE.forecast);
    assert.ok(at(8).flags & FLAG.forecastOutdoor);
});

test('the window ends at the first polled slot and never wraps onto a stored one', () => {
    const history = new History(100);
    assert.deepEqual(backfillWindow(history, 1000), {from: 901, until: 1000}, 'empty: up to the open slot');
    const v = empty();
    v.ti = 21;
    for (let s = 950; s < 990; s++) history.put(s, v);
    assert.deepEqual(backfillWindow(history, 990), {from: 890, until: 950});
    const slots = Array.from({length: 120}, (_, k) => ({slot: 870 + k, values: {...empty(), ti: 19, flags: FLAG.backfill}}));
    const put = insertBackfill(history, slots, 990);
    assert.equal(put, 60);
    assert.equal(history.get(889), undefined, 'outside the ring');
    assert.equal(history.get(890)!.ti, 19);
    for (let s = 950; s < 990; s++) assert.equal(history.get(s)!.ti, 21, 'measured slots stay');
    // Full: nothing left to fill.
    for (let s = 890; s < 990; s++) if (!history.get(s)) history.put(s, v);
    assert.equal(backfillWindow(history, 990), undefined);
    assert.equal(insertBackfill(history, slots, 990), 0);
});

test('the window is read again at insert time: a slot polled meanwhile is not overwritten', () => {
    const history = new History(100);
    const window = backfillWindow(history, 1000)!;
    const slots = Array.from({length: window.until - window.from}, (_, k) => ({slot: window.from + k, values: {...empty(), ti: 19}}));
    history.put(999, {...empty(), ti: 22}); // polled while Insights was read
    insertBackfill(history, slots, 1000);
    assert.equal(history.get(999)!.ti, 22);
    assert.equal(history.get(998)!.ti, 19);
});

test('sources: Heating first, a sibling only for a register-named capability, the sensor wherever it is', () => {
    const devices = {
        heat: {capabilities: ['measure_temperature', 'meter_kwh_NIBE.i1577_heating_produced']},
        main: {capabilities: ['measure_temperature', 'measure_frequency.i1046_compressor', 'measure_temperature.i1_outside']},
        water: {capabilities: ['measure_temperature']},
    };
    const sources = backfillSources(devices, 'heat', ['heat', 'main', 'water'], {
        ti: 'measure_temperature', qmeter: 'meter_kwh_NIBE.i1577_heating_produced', hz: 'measure_frequency.i1046_compressor',
        bt1: 'measure_temperature.i1_outside', tset: 'target_temperature',
    }, {deviceId: 'hue', capabilityId: 'measure_temperature'});
    assert.deepEqual(sources.ti, {deviceId: 'heat', capabilityId: 'measure_temperature'});
    assert.equal(sources.qmeter!.deviceId, 'heat');
    assert.equal(sources.hz!.deviceId, 'main');
    assert.equal(sources.bt1!.deviceId, 'main');
    assert.equal(sources.tset!.deviceId, 'heat', 'nobody carries it: Heating, whose log may outlive it');
    assert.deepEqual(sources.sensor, {deviceId: 'hue', capabilityId: 'measure_temperature'});
});

test('fetch: every resolution, finest first; a missing log left out; a rate limit retried once', async () => {
    const calls: any[] = [];
    const pauses: number[] = [];
    let refused = false;
    const api = {insights: {getLogEntries: async (args: any) => {
        calls.push(args);
        if (args.id.endsWith(':gone')) throw new Error('Not Found');
        if (args.id.endsWith(':busy') && !refused) { refused = true; throw new Error('Too Many Requests'); }
        return {step: HOUR, values: [{t: iso(T0), v: 1}]};
    }}};
    const logs = await fetchHeatingInsights(api, {ti: {deviceId: 'h', capabilityId: 'busy'}, hz: {deviceId: 'm', capabilityId: 'gone'}},
        async (ms) => { pauses.push(ms); });
    assert.deepEqual(calls[0], {uri: 'homey:device:h', id: 'homey:device:h:busy', resolution: 'last24Hours', $timeout: 20_000});
    assert.equal(calls.length, 2 * BACKFILL_RESOLUTIONS.length + 1);
    assert.ok(pauses.includes(20_000), 'waits longer before the retry');
    assert.equal(logs.ti!.length, BACKFILL_RESOLUTIONS.length);
    assert.ok(logs.ti!.every((l) => l.values?.length === 1));
    assert.deepEqual(logs.hz, BACKFILL_RESOLUTIONS.map(() => ({})));
    assert.equal(anyLogRead(logs), true);
    assert.equal(anyLogRead({hz: [{}, {}]}), false);
    assert.equal(anyLogRead({ti: [{values: []}]}), true, 'a log that holds nothing yet still answered');
});

/** A simulated house's slots as the Heating device's Insights would hold them: hourly means for
 *  14 days, 5-minute buckets for the last day. */
function insightsOf(days: number): {logs: BackfillLogs; weather: Map<number, WeatherSlot>} {
    const sim = simulateHouse(RADIATOR_HOUSE, {days, excitation: 0.4, seed: 7});
    const start = SIM_START_SLOT * SLOT_MS;
    let counter = 5000;
    const counterAtEnd: number[] = [];
    for (const s of sim) counterAtEnd.push(counter += s.inputs.q);
    const hourly = (f: (k: number) => number) => log(HOUR, start, Array.from({length: days * 24}, (_, h) => {
        const ks = [0, 1, 2, 3].map((q) => 4 * h + q);
        return ks.reduce((a, k) => a + f(k), 0) / 4;
    }));
    const lastDay = (days - 1) * 96;
    const fine = (f: (k: number) => number) => log(FIVE, start + lastDay * SLOT_MS,
        Array.from({length: 96 * 3}, (_, j) => f(lastDay + Math.floor(j / 3))));
    // A counter's 5-minute mean sits between the slot's start and end values.
    const counterMean = (k: number) => counterAtEnd[k] - sim[k].inputs.q / 2;
    const fields = {
        ti: (k: number) => sim[k].ti,
        bt1: (k: number) => sim[k].inputs.te,
        hz: (k: number) => (sim[k].inputs.q > 0 ? 50 : 0),
        qmeter: counterMean,
    };
    const logs = Object.fromEntries(Object.entries(fields).map(([name, f]) => [name, [fine(f), hourly(f)]])) as BackfillLogs;
    const weather = new Map(sim.map((s) => [s.slot, {slot: s.slot, te: s.inputs.te, gtiS: s.inputs.sun, gtiE: s.inputs.sunE ?? 0,
        gtiW: s.inputs.sunW ?? 0, ghi: 0, wind: 0, rh: 0, cloud: 0}]));
    return {logs, weather};
}

test('a simulated house backfilled from Insights fits on day one, and is scored on measured slots only', () => {
    const days = 14;
    const {logs, weather} = insightsOf(days);
    const history = new History();
    const now = SIM_START_SLOT + days * 96;
    const window = backfillWindow(history, now)!;
    const slots = withWeather(slotsFromInsights(logs, window.from, window.until), weather);
    assert.ok(insertBackfill(history, slots, now) > 13 * 96);
    const model = modelSlotsFromHistory(history);
    const interpolated = model.filter((s) => s.interpolated).length;
    assert.ok(interpolated > 12 * 96 && interpolated < 13 * 96 + 8, `about 13 days interpolated (${interpolated})`);
    const fit = fitHistory(history, {system: 'radiators', era: '1960_1979'});
    assert.ok(fit.validDays >= 13, `backfilled days count toward readiness (${fit.validDays})`);
    assert.ok(fit.params, 'a model on day one');
    const heatLoss = fit.params!.heatLoss;
    assert.ok(Math.abs(heatLoss / RADIATOR_HOUSE.heatLoss - 1) < 0.3, `heat loss ${heatLoss.toFixed(3)} near 0.18`);
    // Only the last day is measured: 6 h windows start every hour, so at most ~18 of them.
    assert.ok(fit.windows > 0 && fit.windows <= 19, `accuracy from measured slots only (${fit.windows} windows)`);
    assert.ok(fit.rmse < 0.35, `6 h error ${fit.rmse.toFixed(2)} K`);
});
