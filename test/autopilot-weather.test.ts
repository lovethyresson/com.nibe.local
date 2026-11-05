import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {openMeteoUrl, placeSearchUrl, placesFrom, weatherLocation, weatherSlots} from '../lib/autopilot/weather';
import {slotOf} from '../lib/autopilot/prices';
import {WALLS, sunPosition, wallIrradiance} from '../lib/autopilot/solar';

const live = JSON.parse(readFileSync(join(__dirname, 'fixtures/open-meteo-2026-11-01.json'), 'utf8'));

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
        global_tilted_irradiance: [0, 0, 0], direct_normal_irradiance: [0, 0, 0], diffuse_radiation: [0, 0, 0]};
    assert.equal(weatherSlots({hourly}).length, 0);
    assert.deepEqual(weatherSlots({error: true}), []);
    assert.deepEqual(weatherSlots(null), []);
});

test('the sun stands south at solar noon, at 90° − latitude at the equinox', () => {
    // 2026-03-20 ~12:00 solar time at 18° E is ~10:50 UTC (4 min per degree, plus the equation of time).
    const noon = sunPosition(Date.UTC(2026, 2, 20, 10, 55), 59.37, 17.92);
    assert.ok(Math.abs(noon.azimuth / (Math.PI / 180) - 180) < 3);
    assert.ok(Math.abs(noon.altitude / (Math.PI / 180) - (90 - 59.37)) < 1);
    const morning = sunPosition(Date.UTC(2026, 5, 21, 4, 0), 59.37, 17.92);
    assert.ok(morning.azimuth / (Math.PI / 180) < 90, 'midsummer 06 local: north of east');
});

test('a wall gets the beam only while the sun is in front of it', () => {
    const morning = sunPosition(Date.UTC(2026, 9, 31, 8, 0), 59.37, 17.92);
    const afternoon = sunPosition(Date.UTC(2026, 9, 31, 13, 0), 59.37, 17.92);
    const at = (pos: typeof morning, wall: number) => wallIrradiance(600, 50, 200, pos, wall);
    assert.ok(at(morning, WALLS.east) > at(morning, WALLS.west));
    assert.ok(at(afternoon, WALLS.west) > at(afternoon, WALLS.east));
    // Behind the wall, only diffuse and the ground's reflection: 50/2 + 0.2·200/2.
    assert.ok(Math.abs(at(morning, WALLS.west) - 45) < 1e-9);
    const night = sunPosition(Date.UTC(2026, 9, 31, 23, 0), 59.37, 17.92);
    assert.equal(wallIrradiance(600, 0, 0, night, WALLS.south), 0);
});

test('the east and west walls follow the forecast, south stays Open-Meteo\'s own', () => {
    const slots = weatherSlots(live);
    assert.ok(slots.every((s) => Number.isFinite(s.gtiE) && Number.isFinite(s.gtiW) && s.gtiE >= 0 && s.gtiW >= 0));
    const sunny = slots.filter((s) => s.gtiS > 100);
    if (sunny.length) assert.ok(sunny.some((s) => s.gtiE !== s.gtiW));
    // Without coordinates there is no sun to place: the walls are missing, so the slot is too.
    assert.equal(weatherSlots({...live, latitude: undefined}).length, 0);
});

test('a place search keeps only the name, region and rounded coordinates', () => {
    assert.match(placeSearchUrl(' Sollentuna ', 'sv'), /name=Sollentuna&count=8&language=sv/);
    const places = placesFrom({results: [
        {name: 'Sollentuna', latitude: 59.42804, longitude: 17.95093, admin1: 'Stockholms län', country: 'Sverige'},
        {name: 'Broken', latitude: null, longitude: 1},
    ]});
    assert.deepEqual(places, [{name: 'Sollentuna', region: 'Stockholms län, Sverige', latitude: 59.43, longitude: 17.95}]);
    assert.deepEqual(placesFrom({}), []);
});

test('the Homey\'s location wins, a chosen place stands in, and 0,0 is no location', () => {
    const chosen = {name: 'Sollentuna', region: '', latitude: 59.43, longitude: 17.95};
    assert.equal(weatherLocation({latitude: 59.4, longitude: 17.9}, chosen)?.source, 'homey');
    assert.deepEqual(weatherLocation({latitude: 0, longitude: 0}, chosen), {latitude: 59.43, longitude: 17.95, source: 'chosen'});
    assert.equal(weatherLocation(undefined, chosen)?.source, 'chosen');
    assert.equal(weatherLocation(undefined, null), undefined);
});
