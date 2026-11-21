import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FORECAST_MAX_AGE_MS, HISTORY_MAX_AGE_MS, LOCATION_MAX_AGE_MS, RETRY_MS, WeatherBook} from '../lib/gateway-weather';

const HOUR = 3_600_000;

/** Open-Meteo's shape: unix seconds, radiation at the hour's end. */
function series(fromMs: number, hours: number, w: number) {
    return {hourly: {time: Array.from({length: hours}, (_, k) => (fromMs + (k + 1) * HOUR) / 1000),
        shortwave_radiation: Array.from({length: hours}, () => w)}};
}

function harness(opts: {chosen?: any; homey?: any; down?: boolean} = {}) {
    let now = Date.parse('2026-11-20T12:00:00Z');
    const calls: string[] = [];
    let down = !!opts.down;
    const book = new WeatherBook({
        homeyLocation: async () => { calls.push('location'); return {value: opts.homey ?? {latitude: 59.33, longitude: 18.07}}; },
        chosenPlace: () => opts.chosen ?? null,
        getJson: async (url, name) => {
            calls.push(name);
            if (down) throw new Error('503');
            return url.includes('past_days=92') ? series(now - 92 * 24 * HOUR, 48, 100) : series(now - HOUR, 4, 300);
        },
        now: () => now,
    });
    return {book, calls, advance: (ms: number) => { now += ms; }, setDown: (v: boolean) => { down = v; }};
}

test('heating and solar asking at once cause one location, one forecast and one history fetch', async () => {
    const h = harness();
    await Promise.all([h.book.forecast(), h.book.ghi(), h.book.forecast(), h.book.ghi()]);
    assert.equal(h.calls.filter((c) => c === 'location').length, 1);
    assert.equal(h.calls.filter((c) => c === 'open-meteo forecast').length, 1);
    assert.equal(h.calls.filter((c) => c === 'open-meteo irradiance').length, 1);
});

test('the sun ahead comes from the hourly forecast, laid over the daily history', async () => {
    const h = harness();
    const ghi = (await h.book.ghi())!;
    assert.equal([...ghi.values()].filter((w) => w === 300).length, 4, 'forecast hours');
    assert.ok([...ghi.values()].filter((w) => w === 100).length > 0, 'history hours');
});

test('age rules: forecast hourly, history daily, the Homey location daily', async () => {
    const h = harness();
    await h.book.ghi();
    h.advance(FORECAST_MAX_AGE_MS + 1);
    await h.book.ghi();
    assert.equal(h.calls.filter((c) => c === 'open-meteo forecast').length, 2);
    assert.equal(h.calls.filter((c) => c === 'open-meteo irradiance').length, 1);
    h.advance(HISTORY_MAX_AGE_MS);
    await h.book.ghi();
    assert.equal(h.calls.filter((c) => c === 'open-meteo irradiance').length, 2);
    assert.ok(LOCATION_MAX_AGE_MS >= HISTORY_MAX_AGE_MS);
});

test('the Homey location first, a chosen place without one, and no location means no fetch', async () => {
    const place = {name: 'Kiruna', region: '', latitude: 67.86, longitude: 20.23};
    assert.equal((await harness({chosen: place}).book.location())?.source, 'homey');
    const chosen = harness({chosen: place, homey: {}});
    assert.deepEqual(await chosen.book.location(), {latitude: 67.86, longitude: 20.23, source: 'chosen'});
    const nowhere = harness({homey: {}});
    assert.equal(await nowhere.book.forecast(), undefined);
    assert.ok(!nowhere.calls.includes('open-meteo forecast'));
});

test('a service that is down is asked again after 15 minutes, and the last answer is kept meanwhile', async () => {
    const h = harness();
    const first = await h.book.forecast();
    h.advance(FORECAST_MAX_AGE_MS + 1);
    h.setDown(true);
    assert.deepEqual(await h.book.forecast(), first, 'the last forecast, not nothing');
    await h.book.forecast();
    assert.equal(h.calls.filter((c) => c === 'open-meteo forecast').length, 2, 'not asked again at once');
    h.advance(RETRY_MS + 1);
    h.setDown(false);
    await h.book.forecast();
    assert.equal(h.calls.filter((c) => c === 'open-meteo forecast').length, 3);
});

test('a forecast kept through an outage keeps the time it was fetched, so its age shows', async () => {
    const h = harness();
    await h.book.forecast();
    const fetchedAt = h.book.forecastAt();
    h.advance(FORECAST_MAX_AGE_MS + 1);
    h.setDown(true);
    await h.book.forecast();
    assert.equal(h.book.forecastAt(), fetchedAt);
});

test('the season is fetched once a month; an answer without days is a failure retried soon, not kept', async () => {
    let answer: any = {error: true, reason: 'down for maintenance'};
    let now = Date.parse('2026-11-20T12:00:00Z');
    const calls: string[] = [];
    const book = new WeatherBook({
        homeyLocation: async () => ({value: {latitude: 59.33, longitude: 18.07}}),
        chosenPlace: () => null,
        getJson: async (url, name) => { calls.push(name); return answer; },
        now: () => now,
    });
    assert.equal(await book.seasonDays('2026-11-20'), undefined);
    answer = {daily: {time: ['2025-01-01'], temperature_2m_mean: [-2]}};
    now += RETRY_MS + 1;
    assert.equal((await book.seasonDays('2026-11-20'))?.get('2025-01-01'), -2, 'asked again after the retry wait');
    now += 7 * 24 * HOUR;
    await book.seasonDays('2026-11-20');
    assert.equal(calls.filter((c) => c === 'open-meteo archive').length, 2, 'kept for the month');
});
