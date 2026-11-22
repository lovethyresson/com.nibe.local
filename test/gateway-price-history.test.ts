import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MONTH_MIN_DAYS, MonthStore, PriceHistory, REFRESH_MS, RETRY_MS, chartsZone, hoursSpread, monthSpreads} from '../lib/gateway-price-history';
import {seasonWeight, yearOutlook, SavingsDay} from '../lib/autopilot/savings';

const DAY = 86_400;

/** Energy-Charts' answer: quarter-hours from `from` for `days` days, priced `price(month, hour)`. */
function series(from: string, days: number, price: (month: number, hour: number) => number | null) {
    const t0 = Date.parse(`${from}T00:00:00Z`) / 1000;
    const unix_seconds: number[] = [], prices: (number | null)[] = [];
    for (let s = t0; s < t0 + days * DAY; s += 900) {
        const at = new Date(s * 1000);
        unix_seconds.push(s);
        prices.push(price(at.getUTCMonth(), at.getUTCHours()));
    }
    return {unix_seconds, price: prices};
}

test('a day\'s spread is its expensive third\'s mean minus its cheap third\'s', () => {
    const steps = Array.from({length: 24}, (_, h) => (h < 8 ? 50 : h < 16 ? 100 : 200));
    assert.equal(hoursSpread(steps), 150);
    assert.equal(hoursSpread(steps.slice(0, 19)), undefined, 'too few hours');
});

test('a year of quarter-hours gives each month\'s spread; a short year gives none', () => {
    // Afternoons and evenings cost 10 per month number more than the morning: January 10, December 120.
    const year = series('2025-11-22', 365, (m, h) => (h < 12 ? 0 : 10 * (m + 1)));
    const months = monthSpreads(year.unix_seconds, year.price, 'UTC')!;
    assert.equal(months.length, 12);
    assert.deepEqual(months, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
    const short = series('2026-01-01', 300, () => 1);
    assert.equal(monthSpreads(short.unix_seconds, short.price, 'UTC'), undefined);
    // Missing prices leave a month short of days.
    const holes = series('2025-11-22', 365, (m, h) => (m === 6 && h > 2 ? null : h));
    assert.equal(monthSpreads(holes.unix_seconds, holes.price, 'UTC'), undefined);
    assert.ok(MONTH_MIN_DAYS <= 28);
});

test('Homey Energy\'s zone maps to Energy-Charts\', the owner\'s choice first', () => {
    assert.equal(chartsZone({userConfigured: {zoneId: '10Y1001A1001A46L'}, autoConfigured: {zoneId: '10YNL----------L'}}), 'SE3');
    assert.equal(chartsZone({autoConfigured: {zoneId: '10YNO-2--------T'}}), 'NO2');
    assert.equal(chartsZone({userConfigured: {zoneId: 'unknown'}}), undefined);
    assert.equal(chartsZone(undefined), undefined);
});

test('the year is read once, sends only the zone and dates, and again a month later', async () => {
    let saved: MonthStore | undefined;
    let now = Date.parse('2026-11-22T12:00:00Z');
    const asked: string[] = [];
    const history = new PriceHistory({
        zone: async () => ({userConfigured: {zoneId: '10YDK-1--------W'}}),
        fetchYear: async (zone, start, end) => {
            asked.push(`${zone} ${start} ${end}`);
            return series(start, 365, (m, h) => (h < 12 ? 0 : 1));
        },
        load: () => saved,
        save: (store) => { saved = store; },
        timeZone: () => 'Europe/Copenhagen',
        now: () => now,
        log: () => {},
    });
    assert.equal(history.spreads(), undefined, 'nothing until read');
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(asked, ['DK1 2025-11-22 2026-11-21']);
    assert.equal(saved!.zone, 'DK1');
    assert.equal(history.spreads()!.length, 12);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(asked.length, 1, 'kept: not read again');
    now += REFRESH_MS + 1;
    history.spreads();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(asked.length, 2, 'a month on: read again');
});

test('a failed read keeps the last months and waits before trying again', async () => {
    let now = 0;
    let calls = 0;
    const kept: MonthStore = {zone: 'NL', at: -REFRESH_MS - 1, months: new Array(12).fill(5)};
    const history = new PriceHistory({
        zone: async () => ({userConfigured: {zoneId: '10YNL----------L'}}),
        fetchYear: async () => { calls++; throw new Error('HTTP 429'); },
        load: () => kept,
        save: () => assert.fail('nothing to save'),
        timeZone: () => 'UTC',
        now: () => now,
        log: () => {},
    });
    assert.equal(history.spreads()![0], 5);
    await new Promise((r) => setTimeout(r, 10));
    history.spreads();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls, 1, 'not again at once');
    now += RETRY_MS + 1;
    history.spreads();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls, 2);
});

test('a month of big price swings weighs more in the year\'s projection', () => {
    const spread = [3, 3, 2, 1, 1, 1, 1, 1, 1, 1, 2, 3];
    assert.equal(seasonWeight('2027-01-10', 'hotwater', undefined, spread), 3);
    assert.equal(seasonWeight('2027-01-10', 'heating', [18], spread), 54);
    assert.equal(seasonWeight('2027-07-10', 'hotwater'), 1, 'without a history: the season alone');
    // Hot water saving 1 a day through a November of spread 2: December at spread 3 is projected
    // at 1.5 a day, not 1.
    const days: SavingsDay[] = Array.from({length: 20}, (_, k) => ({date: `2027-11-${String(k + 1).padStart(2, '0')}`,
        tiers: [1, 0, 0], cost: 1, mean: 2, live: 1}));
    const base = {days: 10, ratio: 1};
    const flat = yearOutlook(days, '2027-11-01', base, '2027-11-21', 'hotwater')!;
    const swung = yearOutlook(days, '2027-11-01', base, '2027-11-21', 'hotwater', undefined, spread)!;
    assert.ok(swung.rest > flat.rest, `${swung.rest} should be above ${flat.rest}`);
});
