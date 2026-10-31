import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    DEGRADED_LIMIT_MS, forecastCorrection, learnForecastBias, newForecastBias, realOutdoor,
} from '../lib/smart/outdoor';

const now = 1_800_000_000_000;

test('the wired sensor is the real outdoor temperature only while not feeding', () => {
    const bias = newForecastBias();
    assert.deepEqual(realOutdoor({now, feeding: false, wired: 3, sensor: 4, forecast: 5, localHour: 12, bias}),
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
