import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HISTORY_DAYS, MONTH_MIN_DAYS, PriceHistory, SpreadStore, daySpread, missingDates, monthSpreads} from '../lib/gateway-price-history';
import {seasonWeight, yearOutlook, SavingsDay} from '../lib/autopilot/savings';

const HOUR = 3_600_000;

/** Homey Energy's answer for a UTC day: `hourly(h)` per hour, as four quarter-hours or one hour. */
function answer(date: string, hourly: (h: number) => number, quarters = true, zoneId = 'SE3') {
    const t0 = Date.parse(`${date}T00:00:00Z`);
    const step = quarters ? HOUR / 4 : HOUR;
    const pricesPerInterval = Array.from({length: 24 * HOUR / step}, (_, k) => ({
        periodStart: new Date(t0 + k * step).toISOString(), periodEnd: new Date(t0 + (k + 1) * step).toISOString(),
        value: hourly(Math.floor(k * step / HOUR)),
    }));
    return {zoneId, pricesPerInterval};
}

test('a day\'s spread is its expensive third\'s mean minus its cheap third\'s, hourly', async () => {
    const {normalisePrices} = await import('../lib/autopilot/prices');
    const steps = (h: number) => (h < 8 ? 0.5 : h < 16 ? 1 : 2);
    assert.equal(daySpread(normalisePrices(answer('2026-01-10', steps), undefined)), 1.5);
    assert.equal(daySpread(normalisePrices(answer('2024-01-10', steps, false), undefined)), 1.5, 'an hourly day reads alike');
    assert.equal(daySpread({slots: [], costsApplied: false}), undefined);
});

test('months are trusted only once every one has enough days', () => {
    const days: Record<string, number> = {};
    for (let m = 1; m <= 12; m++) for (let d = 1; d <= MONTH_MIN_DAYS; d++) days[`2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`] = m;
    assert.deepEqual(monthSpreads(days), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    delete days['2026-07-01'];
    assert.equal(monthSpreads(days), undefined);
    days['2026-07-01'] = NaN; // a day Homey had no prices for counts as nothing
    assert.equal(monthSpreads(days), undefined);
});

test('the history asks for the missing days newest first, a year and a month back', () => {
    const missing = missingDates({days: {'2026-11-21': 1}}, '2026-11-22');
    assert.equal(missing[0], '2026-11-20');
    assert.equal(missing.length, HISTORY_DAYS - 1);
});

test('the fill reads every missing day once, saves them, and starts over when the zone changes', async () => {
    let saved: SpreadStore | undefined;
    const asked: string[] = [];
    let zone = 'SE3';
    const history = new PriceHistory({
        fetchDay: async (date) => { asked.push(date); return answer(date, (h) => (h < 12 ? 1 : 2), true, zone); },
        load: () => saved && JSON.parse(JSON.stringify(saved)),
        save: (store) => { saved = JSON.parse(JSON.stringify(store)); },
        today: () => '2026-11-22',
        now: () => 0,
        log: () => {},
    });
    assert.equal(history.spreads(), undefined, 'nothing until filled');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(asked.length, HISTORY_DAYS);
    assert.equal(saved!.zone, 'SE3');
    assert.equal(Object.keys(saved!.days).length, HISTORY_DAYS);
    assert.equal(history.spreads()!.length, 12);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(asked.length, HISTORY_DAYS, 'filled for today: not asked again');
    // A moved Homey: the next day's fill finds another zone and reads the year again.
    zone = 'NL';
    const next = new PriceHistory({
        fetchDay: async (date) => { asked.push(date); return answer(date, () => 1, true, zone); },
        load: () => saved && JSON.parse(JSON.stringify(saved)),
        save: (store) => { saved = JSON.parse(JSON.stringify(store)); },
        today: () => '2026-11-23',
        now: () => 0,
        log: () => {},
    });
    next.spreads();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(saved!.zone, 'NL');
    assert.equal(Object.keys(saved!.days).length, HISTORY_DAYS);
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

test('a slow day is skipped, and only a run of failures pauses the fill', async () => {
    let saved: SpreadStore | undefined;
    let calls = 0;
    const history = new PriceHistory({
        fetchDay: async (date) => {
            calls++;
            if (date === '2026-11-20') throw new Error('Timeout after 30000ms');
            if (date < '2026-11-01') throw new Error('Timeout after 30000ms');
            return answer(date, (h) => (h < 12 ? 1 : 2));
        },
        load: () => saved && JSON.parse(JSON.stringify(saved)),
        save: (store) => { saved = JSON.parse(JSON.stringify(store)); },
        today: () => '2026-11-22',
        now: () => 0,
        log: () => {},
    });
    history.spreads();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(saved!.days['2026-11-21'], 1);
    assert.equal(saved!.days['2026-11-20'], undefined, 'skipped, asked again next time');
    assert.equal(saved!.days['2026-11-19'] !== undefined, true, 'the fill went on past it');
    assert.equal(calls, 21 + 3, 'paused after three failures in a row');
});
