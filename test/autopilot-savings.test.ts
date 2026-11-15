import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {SavingsDay, moneyText, baselineOf, dayHours, daySaving, firstLiveFrom, hourlyPrices, hourlyUse, liveAt, liveShare, mergeDays, periodSavings, savingsData, savingsDay, totals} from '../lib/autopilot/savings';
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

const ctx = (over: Partial<Parameters<typeof savingsData>[3]> = {}) => ({role: 'heating' as const, today: '2026-11-20', label: (d: string) => d.slice(8), month: () => 'November',
    price: (v: number) => `${v.toFixed(2)} kr`, money: (v: number) => `${Math.round(v)} kr`, badge: 'Experimental', ...over});
/** Before: 10 kWh a day, 40 % in the most expensive third, paying 1.6 against an average of 1.5. */
const before = ['2026-11-10', '2026-11-11', '2026-11-12'].map((date) => day(date, [3, 3, 4], 1.5, 16, 0));
/** With Autopilot: the same 10 kWh, 10 % in the most expensive third, paying 1.2. */
const after = ['2026-11-15', '2026-11-16', '2026-11-17'].map((date) => day(date, [6, 3, 1], 1.5, 12, 1));

test('the baseline is the days before Autopilot first ran live, as the price paid against the average', () => {
    const b = baselineOf([...before, ...after], '2026-11-14')!;
    assert.equal(b.days, 3);
    assert.equal(b.dearShare, 0.4);
    assert.ok(Math.abs(b.ratio - 16 / 15) < 0.001);
    assert.equal(baselineOf(before.slice(0, 2), '2026-11-14'), undefined, 'two days are too few');
});

test('a day saves what its kWh would have cost at the baseline\'s ratio, minus what they cost', () => {
    const b = baselineOf(before, '2026-11-14')!;
    assert.ok(Math.abs(daySaving(after[0], b) - 4) < 0.01, '10 kWh at 1.6 against 1.2: 4 kr');
    assert.ok(Math.abs(daySaving(after[0], {days: 0, ratio: 1}) - 3) < 0.01, 'with no baseline, against the average: 3 kr');
});

test('savings add up over the last 7 days, the month and the year, from the day after Autopilot started', () => {
    const b = baselineOf(before, '2026-11-14')!;
    const startDay = day('2026-11-14', [6, 3, 1], 1.5, 12, 0.4);
    const october = day('2026-10-20', [6, 3, 1], 1.5, 12, 1);
    const sums = periodSavings([october, ...before, startDay, ...after], '2026-10-01', b, '2026-11-20');
    assert.equal(sums.days, 4, 'the half day and the days without Autopilot do not count');
    assert.ok(Math.abs(sums.week - 12) < 0.05);
    assert.ok(Math.abs(sums.month - 12) < 0.05);
    assert.ok(Math.abs(sums.year - 16) < 0.05);
});

test('the widget shows money saved this month, the other periods and the shift against before', () => {
    const d = savingsData('Heating', [...before, ...after], translator('en'), ctx({firstLiveDate: '2026-11-14', baseline: baselineOf(before, '2026-11-14')}));
    assert.equal(d.status, 'Heating savings');
    assert.equal(d.valueNote, 'November');
    assert.equal(d.value, '12 kr');
    assert.equal(d.tone, 'good');
    assert.equal(d.reason, 'Last 7 days 12 kr · this year 12 kr');
    assert.equal(d.footnote, 'Compared with how your heat pump used electricity in the 3 days before Autopilot.');
    assert.deepEqual(d.split!.map((r) => [r.label, r.shares.map((v) => Math.round(v * 100)), r.perDay]),
        [['Before Autopilot', [30, 30, 40], '10 kWh a day'], ['With Autopilot', [60, 30, 10], '10 kWh a day']]);
    assert.equal(d.detail, undefined, 'heating has no charge line');
    // Costing more says so in the expensive colour.
    const worse = savingsData('Heating', [...before, day('2026-11-15', [1, 3, 6], 1.5, 18, 1)], translator('en'),
        ctx({firstLiveDate: '2026-11-14', baseline: baselineOf(before, '2026-11-14')}));
    assert.equal(worse.tone, 'bad');
});

test('before Autopilot the widget shows the figures it will be measured against, with no verdict', () => {
    const d = savingsData('Heating', before, translator('en'), ctx());
    assert.equal(d.status, 'Before Autopilot');
    assert.equal(d.tone, 'neutral');
    assert.equal(d.value, '+7 %');
    assert.equal(d.reason, 'Paid 1.60 kr per kWh, average 1.50 kr · 3 days');
    assert.equal(d.footnote, 'Savings count from the day Autopilot first runs Live.');
});

test('started today: a line until the first full day; with no days before it, against the average', () => {
    const d = savingsData('Heating', before, translator('en'), ctx({firstLiveDate: '2026-11-19'}));
    assert.equal(d.status, 'Autopilot is running');
    assert.equal(d.reason, 'Savings show after its first full day.');
    assert.equal(d.footnote, 'Compared with using the same kWh evenly over each day.');
});

test('no days yet: one line', () => {
    assert.deepEqual(savingsData('Heating', [], translator('en'), ctx()), {title: 'Heating', empty: strings('en').empty});
});

test('a device that ran Autopilot before it was recorded: first live is where the live hours began', () => {
    const mark = T0 + 30 * HOUR;
    const live = (at: number) => at >= T0 + 10 * HOUR ? (at === T0 + 20 * HOUR ? false : true) : false;
    assert.equal(firstLiveFrom(mark, live), T0 + 10 * HOUR, 'a one-hour gap is bridged');
    assert.equal(firstLiveFrom(mark + 15 * 60_000, () => undefined), mark, 'nothing known before the mark: the mark');
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

test('a local day is found in any time zone', () => {
    for (const zone of ['Pacific/Auckland', 'Asia/Kolkata', 'America/Los_Angeles', 'Europe/Stockholm']) {
        const hours = dayHours('2026-11-15', (ms) => localDate(ms, zone));
        assert.ok(hours.length >= 24 && hours.length <= 25, `${zone}: ${hours.length}`);
    }
});

test('hot water: charges are runs of charging hours, placed at their hours\' price rank', () => {
    const use = new Map(hours24.map((at, h) => [at, h >= 2 && h < 4 ? 1.8 : h === 17 ? 1.5 : 0.05]));
    const d = savingsDay('2026-11-15', hours24, use, prices, 1, true)!;
    assert.equal(d.charges!.length, 2);
    assert.ok(d.charges![0] < 0.2, `night charge at ${d.charges![0]}`);
    assert.ok(d.charges![1] > 2 / 3, `the 17:00 charge in the most expensive third, at ${d.charges![1]}`);
});

test('hot water: what a shower cost before and with Autopilot, and how many charges hit cheap hours', () => {
    const b = baselineOf(before, '2026-11-14')!;
    const withWater = after.map((d, i) => ({...d, litres: 200, charges: i === 0 ? [0.1, 0.9] : [0.05]}));
    const d = savingsData('Hot water', [...before, ...withWater], translator('en'),
        ctx({role: 'hotwater', firstLiveDate: '2026-11-14', baseline: b}));
    assert.equal(d.split, undefined);
    assert.equal(d.shower!.title, 'Per shower (80 L)');
    assert.equal(d.shower!.now!.value, '4.80 kr', '12 kr for 200 L: 4.80 kr per 80 L');
    assert.equal(d.shower!.before!.value, '6.40 kr', 'the same water at the old pattern: 16 kr');
    assert.equal(d.shower!.now!.note, '\u221225 %');
    assert.equal(d.detail, '3 of 4 charges in the cheapest hours this week');
    assert.equal(d.charges!.days.length, 3, 'only days with charge data: the days before carry none');
});
test('hot water names the total and the month, and the tiles are per shower', () => {
    const b = baselineOf(before, '2026-11-14')!;
    const d = savingsData('Hot water', [...before, ...after.map((x) => ({...x, litres: 200}))], translator('en'),
        ctx({role: 'hotwater', firstLiveDate: '2026-11-14', baseline: b}));
    assert.equal(d.status, 'Hot water savings');
    assert.equal(d.valueNote, 'November');
    assert.equal(d.shower!.title, 'Per shower (80 L)');
});

test('money is written with the currency after the number when it is letters, symbols where the language puts them', () => {
    assert.equal(moneyText(2.79, 2, 'en', 'SEK'), '2.79 kr');
    assert.equal(moneyText(2.79, 2, 'sv', 'SEK'), '2,79 kr');
    assert.equal(moneyText(2.79, 2, 'en', 'EUR'), '€2.79');
    assert.equal(moneyText(2.79, 2, 'de', 'EUR').replace(/\s/g, ' '), '2,79 €', 'Intl keeps its own non-breaking space');
    assert.equal(moneyText(17, 0, 'en', ''), '17');
});
