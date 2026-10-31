import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {openMeteoUrl, weatherSlots} from '../lib/smart/weather';
import {slotOf} from '../lib/smart/prices';

const live = JSON.parse(readFileSync(join(__dirname, 'fixtures/open-meteo-2026-10-30.json'), 'utf8'));

test('the request rounds the location to 2 decimals and asks for south-wall irradiance', () => {
    const url = openMeteoUrl(59.371234, 17.92456);
    assert.match(url, /latitude=59\.37&longitude=17\.92&/);
    assert.match(url, /global_tilted_irradiance/);
    assert.match(url, /tilt=90&azimuth=0/);
    assert.doesNotMatch(url, /59\.371/);
});

test('a live forecast becomes quarter-hour slots: instants interpolated, radiation held', () => {
    const slots = weatherSlots(live);
    const h = live.hourly;
    assert.equal(slots.length, (h.time.length - 1) * 4);
    assert.equal(slots[0].slot, slotOf(h.time[0] * 1000));
    assert.equal(slots[0].te, h.temperature_2m[0]);
    assert.ok(Math.abs(slots[2].te - (h.temperature_2m[0] + h.temperature_2m[1]) / 2) < 1e-9);
    for (let q = 0; q < 4; q++) assert.equal(slots[30 * 4 + q].gtiS, h.global_tilted_irradiance[31]);
});

test('missing values drop the slot, and a broken response gives nothing', () => {
    const t = 1793232000;
    const hourly = {time: [t, t + 3600, t + 7200], temperature_2m: [1, null, 3], wind_speed_10m: [1, 1, 1],
        relative_humidity_2m: [90, 90, 90], cloud_cover: [50, 50, 50], shortwave_radiation: [0, 0, 0],
        global_tilted_irradiance: [0, 0, 0]};
    assert.equal(weatherSlots({hourly}).length, 0);
    assert.deepEqual(weatherSlots({error: true}), []);
    assert.deepEqual(weatherSlots(null), []);
});
