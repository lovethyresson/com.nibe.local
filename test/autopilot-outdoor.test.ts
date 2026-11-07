import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    DEGRADED_LIMIT_MS, SENSOR_STALE_MS, forecastCorrection, learnForecastBias, newForecastBias, realOutdoor,
    WIRED_TAU_H, recordedOutdoor, usableSensor, wiredExpected, wiredModel,
} from '../lib/autopilot/outdoor';

const now = 1_800_000_000_000;

test('the owner\'s sensor comes first, the wired sensor only while not feeding', () => {
    const bias = newForecastBias();
    assert.deepEqual(realOutdoor({now, feeding: false, wired: 3, sensor: 4, forecast: 5, localHour: 12, bias}),
        {value: 4, source: 'sensor', goNeutral: false});
    assert.deepEqual(realOutdoor({now, feeding: false, wired: 3, forecast: 5, localHour: 12, bias}),
        {value: 3, source: 'wired', goNeutral: false});
    assert.deepEqual(realOutdoor({now, feeding: true, wired: -10, sensor: 4, forecast: 5, localHour: 12, bias}),
        {value: 4, source: 'sensor', goNeutral: false});
});

test('the forecast is corrected per hour by what the wired sensor taught it', () => {
    let bias = newForecastBias();
    for (let i = 0; i < 10; i++) bias = learnForecastBias(bias, 3, -4, -2); // a cold hollow at night
    bias = learnForecastBias(bias, 14, 6, 5);
    assert.equal(forecastCorrection(bias, 3), -2);
    assert.equal(forecastCorrection(bias, 14), 1);
    assert.equal(forecastCorrection(bias, 20), -0.5); // unseen hour: mean of the seen ones
    assert.equal(forecastCorrection(newForecastBias(), 20), 0);
    const reading = realOutdoor({now, feeding: true, forecast: -2, localHour: 3, bias});
    assert.equal(reading.value, -4);
    assert.equal(reading.source, 'forecast');
});

test('learning settles into a moving average after the first samples', () => {
    let bias = newForecastBias();
    for (let i = 0; i < 100; i++) bias = learnForecastBias(bias, 5, 1, 0);
    for (let i = 0; i < 20; i++) bias = learnForecastBias(bias, 5, 3, 0);
    const c = forecastCorrection(bias, 5);
    assert.ok(c > 2 && c < 3, `${c}`);
    assert.equal(learnForecastBias(bias, 5, NaN, 0), bias);
});

test('six hours on the forecast alone while feeding sends the controller neutral', () => {
    const bias = newForecastBias();
    const first = realOutdoor({now, feeding: true, forecast: 2, localHour: 9, bias});
    assert.equal(first.degradedSince, now);
    assert.equal(first.goNeutral, false);
    const later = realOutdoor({now: now + DEGRADED_LIMIT_MS, feeding: true, forecast: 2, localHour: 15, bias,
        degradedSince: first.degradedSince});
    assert.equal(later.goNeutral, true);
    const notFeeding = realOutdoor({now: now + DEGRADED_LIMIT_MS, feeding: false, forecast: 2, localHour: 15, bias,
        degradedSince: now});
    assert.equal(notFeeding.goNeutral, false);
    assert.equal(notFeeding.degradedSince, undefined);
});

test('no source at all goes neutral while feeding', () => {
    assert.deepEqual(realOutdoor({now, feeding: true, localHour: 0, bias: newForecastBias()}), {goNeutral: true});
    assert.deepEqual(realOutdoor({now, feeding: false, localHour: 0, bias: newForecastBias()}), {goNeutral: false});
});

test('history records the sensor, else an unfed input 1, else the forecast', () => {
    // 2026-11-02: a probe fed 3.6 °C; the Hue sensor out front read 7.2, the forecast 7.3.
    assert.deepEqual(recordedOutdoor(3.6, 7.2, 7.3), {value: 7.2, source: 'sensor', fed: true});
    assert.deepEqual(recordedOutdoor(3.6, undefined, 7.3), {value: 7.3, source: 'forecast', fed: true});
    assert.deepEqual(recordedOutdoor(5.6, undefined, 7.3), {value: 5.6, source: 'wired', fed: false});
    assert.deepEqual(recordedOutdoor(7.0, 7.2, 7.3), {value: 7.2, source: 'sensor', fed: false});
    assert.deepEqual(recordedOutdoor(3.6), {value: 3.6, source: 'wired', fed: false});
    assert.equal(recordedOutdoor(NaN).source, 'none');
});

test('a sensor stands for outdoor only when present, recent and in range', () => {
    const r = {value: 7.2, available: true, updatedAt: now - 60_000};
    assert.equal(usableSensor(r, now), 7.2);
    assert.equal(usableSensor({...r, updatedAt: null}, now), 7.2);
    assert.equal(usableSensor({...r, available: false}, now), undefined);
    assert.equal(usableSensor({...r, updatedAt: now - SENSOR_STALE_MS - 1}, now), undefined);
    assert.equal(usableSensor({...r, value: 85}, now), undefined);
    assert.equal(usableSensor(undefined, now), undefined);
});

test('the wired BT1 trails the sensor, and a slot is fed only when it leaves that', () => {
    // A sensor stepping 5 → −3 °C: the wired reading follows over hours, 2.3 K warm.
    const rows = [...Array.from({length: 96}, () => ({te: 5, bt1: 7.3})),
        ...Array.from({length: 8}, (_, k) => ({te: -3, bt1: -3 + (5 - -3) * Math.exp(-(k + 1) * 0.25 / WIRED_TAU_H) + 2.3}))];
    const model = wiredModel(rows)!;
    assert.ok(Math.abs(model.offset - 2.3) < 0.05, `${model.offset}`);
    const next = -3 + (model.lag - -3) * Math.exp(-0.25 / WIRED_TAU_H) + 2.3;
    assert.ok(Math.abs(wiredExpected(model, -3) - next) < 0.05);
    // Two hours into the drop input 1 is still ~5.6 K above the sensor: not fed.
    assert.equal(recordedOutdoor(next, -3, undefined, model).fed, false);
    assert.equal(recordedOutdoor(next, -3).fed, true, 'against the sensor alone it looked fed');
    // A real feed 6 K off what the wired sensor should read is.
    assert.equal(recordedOutdoor(next - 6, -3, undefined, model).fed, true);

    // A gap in the history decays the lag for the time it lasted, not for one slot.
    const before = wiredModel([{slot: 0, te: 5, bt1: 5}, {slot: 1, te: 5, bt1: 5}])!;
    const gap = wiredModel([{slot: 0, te: 5, bt1: 5}, {slot: 1, te: 5, bt1: 5}, {slot: 9, te: -3, bt1: 5}])!;
    assert.ok(Math.abs(before.lag - 5) < 1e-9);
    assert.ok(Math.abs(gap.lag - (-3 + 8 * Math.exp(-8 * 0.25 / WIRED_TAU_H))) < 1e-9, `${gap.lag}`);
    // Longer than the lag itself: it starts over from the reading.
    assert.equal(wiredModel([{slot: 0, te: 5, bt1: 5}, {slot: 40, te: -3, bt1: -1}])!.lag, -3);
});
