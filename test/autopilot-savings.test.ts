import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {SavingsDay, dayHours, hourlyPrices, hourlyUse, isAutopilotDay, liveAt, liveShare, mergeDays, savingsData, savingsDay, totals} from '../lib/autopilot/savings';
import {localDate} from '../lib/autopilot/prices';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 15); // a UTC midnight
const iso = (ms: number) => new Date(ms).toISOString();

test('hourly use comes from neighbouring hourly means of the meter, gaps and resets left out', () => {
    const points = [
        {t: iso(T0), v: 100}, {t: iso(T0 + HOUR), v: 101.5}, {t: iso(T0 + 2 * HOUR), v: 103},
        {t: iso(T0 + 3 * HOUR), v: null}, {t: iso(T0 + 4 * HOUR), v: 104},
        {t: iso(T0 + 5 * HOUR), v: 50}, // a reset
        {t: iso(T0 + 7 * HOUR), v: 52}, // two hours on: a gap
    ];
    const use = hourlyUse(points);
    assert.deepEqual([...use], [[T0 + HOUR, 1.5], [T0 + 2 * HOUR, 1.5]]);
});

test('an hour\'s price is the mean of its quarter-hour slots', () => {
    const slots = [0, 1, 2, 3, 4].map((k) => ({slot: T0 / (15 * 60_000) + k, price: k < 4 ? k : 10}));
    const prices = hourlyPrices(slots, 15 * 60_000);
    assert.equal(prices.get(T0), 1.5);
    assert.equal(prices.get(T0 + HOUR), 10);
});

const hours24 = Array.from({length: 24}, (_, h) => T0 + h * HOUR);
const priceOf = (h: number) => (h >= 16 && h < 20 ? 3 : h < 6 ? 1 : 2);
const prices = new Map(hours24.map((at, h) => [at, priceOf(h)]));

test('a day sums its kWh into the cheapest, middle and dearest third of its hours', () => {
    const flat = new Map(hours24.map((at) => [at, 1]));
    const d = savingsDay('2026-11-15', hours24, flat, prices)!;
    assert.deepEqual(d.tiers, [8, 8, 8]);
    assert.ok(Math.abs(d.mean - (6 * 1 + 14 * 2 + 4 * 3) / 24) < 0.001);
    assert.ok(Math.abs(d.cost - d.mean * 24) < 0.02, 'a flat use pays the average');
    // All the use in the dearest four hours: all of it in the dearest third.
    const peak = new Map(hours24.map((at, h) => [at, h >= 16 && h < 20 ? 6 : 0]));
    assert.deepEqual(savingsDay('2026-11-15', hours24, peak, prices)!.tiers, [0, 0, 24]);
});

test('a day with holes is not written: its missing kWh would land in no third', () => {
    const holes = new Map(hours24.slice(0, 20).map((at) => [at, 1]));
    assert.equal(savingsDay('2026-11-15', hours24, holes, prices), undefined);
    const unpriced = new Map([...prices].slice(0, 23));
    assert.equal(savingsDay('2026-11-15', hours24, new Map(hours24.map((at) => [at, 1])), unpriced), undefined);
});

test('a local day has 23, 24 or 25 hours', () => {
    const sthlm = (ms: number) => localDate(ms, 'Europe/Stockholm');
    assert.equal(dayHours('2026-11-15', sthlm).length, 24);
    assert.equal(dayHours('2026-03-29', sthlm).length, 23);
    assert.equal(dayHours('2026-10-25', sthlm).length, 25);
    assert.equal(sthlm(dayHours('2026-11-15', sthlm)[0]), '2026-11-15');
});

test('live hours come from the mode marks, unknown before the first', () => {
    const marks = [{at: T0 + 10 * HOUR, live: false}, {at: T0 + 12 * HOUR, live: true}];
    assert.equal(liveAt(marks, T0), undefined);
    assert.equal(liveAt(marks, T0 + 11 * HOUR), false);
    assert.equal(liveAt(marks, T0 + 23 * HOUR), true);
    assert.equal(liveShare(hours24, (at) => liveAt(marks, at)), undefined, 'known for under three quarters of the day');
    assert.equal(liveShare(hours24, (at) => liveAt(marks, at) ?? false), 12 / 24);
});

const day = (date: string, tiers: [number, number, number], mean: number, cost: number, live?: number): SavingsDay =>
    ({date, tiers, mean, cost, live});

test('totals weigh each day\'s average by its kWh, so a big day counts as much as it used', () => {
    const t = totals([day('2026-11-01', [2, 2, 6], 2, 22), day('2026-11-02', [6, 3, 1], 1, 8)])!;
    assert.equal(t.kwh, 20);
    assert.equal(t.dearShare, 7 / 20);
    assert.equal(t.paid, 30 / 20);
    assert.equal(t.mean, (10 * 2 + 10 * 1) / 20);
});

const strings = (lang: string) => JSON.parse(readFileSync(join(__dirname, '..', '.homeycompose', 'locales', `${lang}.json`), 'utf8')).autopilot.savings;
const translator = (lang: string) => (key: string, tokens: Record<string, string | number> = {}) => {
    const text = strings(lang)[key];
    assert.equal(typeof text, 'string', `${lang}: missing autopilot.savings.${key}`);
    return Object.entries(tokens).reduce((out: string, [name, value]) => out.split(`__${name}__`).join(String(value)), text);
};

test('the widget says what Autopilot days paid against the average, and the dearest share both ways', () => {
    const before = [day('2026-11-10', [3, 3, 4], 1.5, 16, 0), day('2026-11-11', [3, 3, 4], 1.5, 16, 0)];
    const after = [day('2026-11-15', [6, 3, 1], 1.5, 12, 1)];
    const d = savingsData('Heating', [...before, ...after], translator('en'), (date) => date.slice(8), (v) => `${v.toFixed(2)} kr`, 'Experimental');
    assert.equal(d.status, 'Price per kWh');
    assert.equal(d.value, '\u221220 %');
    assert.equal(d.tone, 'good');
    assert.equal(d.reason, 'Paid 1.20 kr per kWh, average 1.50 kr · 1 day');
    assert.equal(d.detail, 'Most expensive hours: 10 % with Autopilot, 40 % without');
    assert.equal(d.badge, 'Experimental');
    assert.deepEqual(d.bars!.map((b) => b.autopilot), [false, false, true]);
    assert.ok(isAutopilotDay(after[0]));
    // Paying over the average with Autopilot says so in the dear colour.
    const dear = savingsData('Heating', [day('2026-11-15', [1, 3, 6], 1.5, 18, 1)], translator('en'), String, String);
    assert.equal(dear.value, '+20 %');
    assert.equal(dear.tone, 'bad');
});

test('before Autopilot the figure is the baseline, shown without a verdict', () => {
    const d = savingsData('Heating', [day('2026-11-10', [3, 3, 4], 1.5, 16, 0)], translator('en'), String, String);
    assert.equal(d.status, 'Before Autopilot');
    assert.equal(d.tone, 'neutral');
    assert.equal(d.detail, 'Most expensive hours: 40 % of use');
    // A day switched on halfway is neither, and an unknown day counts for neither side.
    const mixed = savingsData('Heating', [day('2026-11-12', [1, 1, 1], 1, 3, 0.5), day('2026-11-13', [1, 1, 1], 1, 3)],
        translator('en'), String, String);
    // Nothing sorted (no record of the Smart mode yet): the days as they are, with no verdict.
    assert.equal(mixed.status, 'Price per kWh');
    assert.equal(mixed.tone, 'neutral');
    assert.match(mixed.reason!, /· 2 days$/);
});

test('no days yet: one line', () => {
    assert.deepEqual(savingsData('Heating', [], translator('en'), String, String), {title: 'Heating', empty: strings('en').empty});
});

test('every savings string is in all six languages, with the same tokens', () => {
    const en = strings('en');
    for (const lang of ['sv', 'nl', 'de', 'no', 'da']) {
        const other = strings(lang);
        assert.deepEqual(Object.keys(other).sort(), Object.keys(en).sort(), lang);
        for (const key of Object.keys(en)) {
            const tokens = (s: string) => (s.match(/__\w+__/g) ?? []).sort();
            assert.deepEqual(tokens(other[key]), tokens(en[key]), `${lang}.${key}`);
        }
    }
});

test('merged days keep one per date, newest wins, oldest first', () => {
    const merged = mergeDays([day('2026-11-02', [1, 1, 1], 1, 3), day('2026-11-01', [1, 1, 1], 1, 3)],
        [day('2026-11-02', [2, 2, 2], 1, 6)]);
    assert.deepEqual(merged.map((d) => [d.date, d.cost]), [['2026-11-01', 3], ['2026-11-02', 6]]);
});

test('the baseline counts every day the ledger keeps without Autopilot, past the chart\'s 14', () => {
    const old = Array.from({length: 10}, (_, i) => day(`2026-10-${String(10 + i).padStart(2, '0')}`, [3, 3, 4], 1.5, 16, 0));
    const live = Array.from({length: 14}, (_, i) => day(`2026-11-${String(1 + i).padStart(2, '0')}`, [6, 3, 1], 1.5, 12, 1));
    const d = savingsData('Heating', [...old, ...live], translator('en'), String, String);
    assert.equal(d.bars!.length, 14);
    assert.equal(d.detail, 'Most expensive hours: 10 % with Autopilot, 40 % without');
});

test('a local day is found in any time zone', () => {
    for (const zone of ['Pacific/Auckland', 'Asia/Kolkata', 'America/Los_Angeles', 'Europe/Stockholm']) {
        const hours = dayHours('2026-11-15', (ms) => localDate(ms, zone));
        assert.ok(hours.length >= 24 && hours.length <= 25, `${zone}: ${hours.length}`);
    }
});
