/** The heating season from the owner's location (season.ts). */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SEASON_YEARS, dailyMeans, seasonCurve, seasonUrl} from '../lib/autopilot/season';

test('the archive is asked for the last three full years at the location', () => {
    const url = seasonUrl(59.3293, 18.0686, '2026-11-21');
    assert.match(url, /^https:\/\/archive-api\.open-meteo\.com\/v1\/archive\?/);
    assert.match(url, /latitude=59\.33&longitude=18\.07/);
    assert.match(url, new RegExp(`start_date=${2025 - SEASON_YEARS + 1}-01-01&end_date=2025-12-31`));
    assert.match(url, /daily=temperature_2m_mean/);
});

test('daily means keep only days with a value', () => {
    const d = dailyMeans({daily: {time: ['2025-01-01', '2025-01-02', '2025-01-03'], temperature_2m_mean: [-3, null, 2.5]}});
    assert.deepEqual([...d], [['2025-01-01', -3], ['2025-01-03', 2.5]]);
    assert.equal(dailyMeans(undefined).size, 0);
});

test('the curve is each month\'s mean degree-days per day below the base; a short history makes none', () => {
    const days = new Map<string, number>();
    for (let m = 1; m <= 12; m++) for (let d = 1; d <= 28; d++)
        days.set(`2025-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, m === 7 ? 20 : m === 1 ? -3 : 10);
    const curve = seasonCurve(days, 17)!;
    assert.equal(curve[0], 20, 'January at −3 °C: 20 degree-days a day');
    assert.equal(curve[6], 0, 'July above the base: no heating');
    assert.equal(curve[3], 7);
    days.delete('2025-02-01'); for (let d = 2; d <= 10; d++) days.delete(`2025-02-${String(d).padStart(2, '0')}`);
    assert.equal(seasonCurve(days, 17), undefined, 'February with 18 days: not enough');
});
