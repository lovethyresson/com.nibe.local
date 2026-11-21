import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {SavingsDay, moneyText, seasonWeight, yearOutlook, partialDay, baselineOf, dayHours, daySaving, firstLiveFrom, hourlyPrices, hourlyUse, liveAt, liveShare, mergeDays, periodSavings, savingsData, savingsDay, savingsLive, totals} from '../lib/autopilot/savings';
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
    price: (v: number) => `${v.toFixed(2)} kr`, money: (v: number) => `${Math.round(v)} kr`, dayMonth: (d: string) => d.slice(5), ...over});
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

/** A test season: heating degree-days per day for each month (any shape will do; season.ts makes
 *  the real one from the owner's location). */
const SEASON = [18, 18, 15.4, 10.5, 5.6, 1.3, 0, 0, 4.1, 9.4, 13.4, 16.6];
/** A week with Autopilot, 15–21 Nov, as `after`: the projection needs seven whole days. */
const week = Array.from({length: 7}, (_, k) => day(`2026-11-${15 + k}`, [6, 3, 1], 1.5, 12, 1));

test('the widget shows the year: saved so far, the rest by season, the estimate, and the shift against before', () => {
    const b = baselineOf(before, '2026-11-14')!;
    const d = savingsData('Heating', [...before, ...week], translator('en'), ctx({today: '2026-11-22', firstLiveDate: '2026-11-14', baseline: b, season: SEASON}));
    assert.equal(d.status, 'Heating savings');
    // Seven November days (13.4 each); ahead: 8 November days and December's 31 × 16.6.
    const saved = week.reduce((s, x) => s + daySaving(x, b), 0);
    const rest = saved / (7 * 13.4) * (8 * 13.4 + 31 * 16.6);
    assert.equal(d.value, `~${Math.round(saved + rest)} kr`);
    assert.equal(d.valueNote, 'estimated for 2026 · from 11-14');
    assert.equal(d.tone, 'good');
    assert.deepEqual(d.year, {share: d.year!.share, good: true, savedLabel: 'Saved so far', saved: `${Math.round(saved)} kr`,
        restLabel: 'Rest of the year, by season', rest: `~${Math.round(rest)} kr`});
    assert.ok(Math.abs(d.year!.share - d.yearSaved! / d.yearValue!) < 1e-9);
    assert.equal(d.stats, undefined, 'the year bar says it');
    // No season for the location yet: no projection, never a guessed one.
    const noSeason = savingsData('Heating', [...before, ...week], translator('en'), ctx({today: '2026-11-22', firstLiveDate: '2026-11-14', baseline: b}));
    assert.equal(noSeason.year, undefined);
    assert.equal(noSeason.valueNote, 'November');
    // Under seven whole days: no projection yet, the month as before.
    const young = savingsData('Heating', [...before, ...after], translator('en'), ctx({firstLiveDate: '2026-11-14', baseline: b}));
    assert.equal(young.year, undefined);
    assert.equal(young.valueNote, 'November');
    assert.deepEqual(d.split!.map((r) => [r.label, r.shares.map((v) => Math.round(v * 100)), r.perDay]),
        [['Before Autopilot · 3 days', [30, 30, 40], '10 kWh a day'], ['With Autopilot · 7 days', [60, 30, 10], '10 kWh a day']]);
    // Costing more says so in the expensive colour.
    const worse = savingsData('Heating', [...before, day('2026-11-15', [1, 3, 6], 1.5, 18, 1)], translator('en'),
        ctx({firstLiveDate: '2026-11-14', baseline: baselineOf(before, '2026-11-14')}));
    assert.equal(worse.tone, 'bad');
});

test('before Autopilot the widget shows the starting point: the share Autopilot will move', () => {
    const d = savingsData('Heating', before, translator('en'), ctx());
    assert.equal(d.status, 'Your starting point');
    assert.equal(d.tone, 'neutral');
    assert.equal(d.value, '40 %');
    assert.equal(d.valueNote, 'in the most expensive hours');
});
test('started today: the share of today\'s use in the cheapest hours, against the starting point', () => {
    const b = baselineOf(before, '2026-11-14')!;
    const sofar = day('2026-11-20', [3, 1, 0.5], 1.5, 5.4, 1);
    const d = savingsData('Heating', before, translator('en'), ctx({firstLiveDate: '2026-11-19', baseline: b, sofar}));
    assert.equal(d.status, 'Heating savings');
    assert.equal(d.value, '67 %', '3 of 4.5 kWh in the cheapest hours');
    assert.equal(d.valueNote, 'in the cheapest hours today');
    assert.equal(d.tone, 'good');
    assert.deepEqual(d.split!.map((r) => r.label), ['Before Autopilot · 3 days', 'Today so far']);
    assert.equal(d.split![1].perDay, '4.5 kWh so far');
    // No reading yet today: a line until there is.
    const none = savingsData('Heating', before, translator('en'), ctx({firstLiveDate: '2026-11-19'}));
    assert.equal(none.reason, "Savings appear after Autopilot's first full day.");
});

test('today so far ranks the hours with a reading against today\'s whole price list', () => {
    const use = new Map(hours24.slice(0, 8).map((at) => [at, 1]));
    const d = partialDay('2026-11-15', hours24, use, prices, 1)!;
    assert.deepEqual(d.tiers, [8, 0, 0], 'the cheapest third is the day\'s 8 cheapest hours: 00–08');
    assert.ok(Math.abs(d.mean - (6 * 1 + 2 * 2) / 8) < 0.001, 'the average is over the hours so far');
    assert.equal(partialDay('2026-11-15', hours24, new Map(), prices), undefined);
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

test('hot water: a shower now and the old way at the same prices, priced from litres', () => {
    const b = baselineOf(before, '2026-11-14')!;
    const withWater = after.map((d) => ({...d, litres: 200}));
    const d = savingsData('Hot water', [...before, ...withWater], translator('en'),
        ctx({role: 'hotwater', firstLiveDate: '2026-11-14', baseline: b}));
    assert.equal(d.split, undefined);
    assert.equal(d.shower!.title, 'Per shower (80 L)');
    assert.equal(d.shower!.now!.value, '4.80 kr', '12 kr for 200 L: 4.80 kr per 80 L');
    assert.equal(d.shower!.before!.value, '6.40 kr', 'the same water at the old pattern: 16 kr');
    assert.equal(d.shower!.now!.note, '\u221225 %');
    assert.equal((d as any).share, undefined, 'no share of heat in the cheapest hours for hot water');
    assert.equal(d.status, 'Hot water savings');
    const w = savingsData('Hot water', [...before, ...week.map((x) => ({...x, litres: 200}))], translator('en'),
        ctx({role: 'hotwater', today: '2026-11-22', firstLiveDate: '2026-11-14', baseline: b}));
    assert.equal(w.valueNote, 'estimated for 2026 · from 11-14');
    assert.equal(w.year!.restLabel, 'Rest of the year', 'every day weighs the same for hot water');
    // Seven days' saving, and the same pace for the 39 days left after today.
    const saved = week.reduce((a, x) => a + daySaving(x, b), 0);
    assert.equal(w.value, `~${Math.round(saved + saved / 7 * 39)} kr`);
});

test('hot water heated in cheap hours but less efficiently is not counted as a saving it is not', () => {
    // Before: 10 kWh for 200 L, 0.05 kWh a litre. Autopilot: 15 kWh for the same 200 L, all cheap
    // (0.9 a kWh), as a hotter tank or the immersion heater would.
    const withLitres = before.map((d) => ({...d, litres: 200}));
    const b = baselineOf(withLitres, '2026-11-14')!;
    assert.ok(Math.abs(b.kwhPerLitre! - 0.05) < 1e-9);
    const hot = {...day('2026-11-15', [12, 2, 1], 1.5, 13.5, 1), litres: 200};
    // The old way: 200 L × 0.05 × 1.5 × 16/15 = 16 kr, against 13.5 paid: 2.5 kr, not the 10.5 kr
    // its own 15 kWh at the old ratio would claim.
    assert.ok(Math.abs(daySaving(hot, b) - 2.5) < 0.01);
    assert.ok(Math.abs(daySaving({...hot, litres: undefined}, b) - 10.5) < 0.01, 'without litres, its own kWh');
});

test('hot water before its first full day: a line, not a share of cheap hours', () => {
    const sofar = {...day('2026-11-20', [2, 0.5, 0], 1.5, 3, undefined), charges: [0.1]};
    const d = savingsData('Hot water', before, translator('en'),
        ctx({role: 'hotwater', firstLiveDate: '2026-11-20', baseline: baselineOf(before, '2026-11-20'), sofar, liveNow: true}));
    assert.equal(d.reason, "Savings appear after Autopilot's first full day.");
    assert.equal(d.value, undefined);
});

test('money is written with the currency after the number when it is letters, symbols where the language puts them', () => {
    assert.equal(moneyText(2.79, 2, 'en', 'SEK'), '2.79 kr');
    assert.equal(moneyText(2.79, 2, 'sv', 'SEK'), '2,79 kr');
    assert.equal(moneyText(2.79, 2, 'en', 'EUR'), '€2.79');
    assert.equal(moneyText(2.79, 2, 'de', 'EUR').replace(/\s/g, ' '), '2,79 €', 'Intl keeps its own non-breaking space');
    assert.equal(moneyText(17, 0, 'en', ''), '17');
});


test('hot water not running Autopilot, no live day: no kronor, a reason, and the shower cost as the last 7 days', () => {
    const days = after.map((x) => ({...x, live: 0, litres: 200}));
    const d = savingsData('Hot water', [...before, ...days], translator('en'),
        ctx({role: 'hotwater', firstLiveDate: '2026-11-14', baseline: baselineOf(before, '2026-11-14')!, liveNow: false}));
    assert.equal(d.value, undefined);
    assert.equal(d.stats, undefined);
    assert.equal(d.reason, "Autopilot isn't running. Savings count on the days it runs.");
    assert.equal(d.shower!.now!.label, 'Last 7 days');
    assert.equal(d.shower!.before, undefined);
});

test('the first live day before any use: the first-day line, not 0 kr; the shower cost is the last 7 days', () => {
    const sofar = day('2026-11-20', [0, 0, 0], 1.5, 3, 1);
    const d = savingsData('Hot water', before.map((x) => ({...x, litres: 200})), translator('en'),
        ctx({role: 'hotwater', firstLiveDate: '2026-11-19', baseline: baselineOf(before, '2026-11-19'), sofar, liveNow: true}));
    assert.equal(d.value, undefined);
    assert.equal(d.reason, "Savings appear after Autopilot's first full day.");
    assert.equal(d.shower!.now!.label, 'Last 7 days');
});

test('heating counts from the hour it first shifts heat: learning hours are the starting point', () => {
    const ready = 100 * HOUR;
    // Learning: BT1 fed (the trim holds the thermostat temperature), Smart mode on, yet not a saving.
    assert.equal(savingsLive(99 * HOUR, ready, true, true), false);
    assert.equal(savingsLive(100 * HOUR, ready, true, true), true);
    assert.equal(savingsLive(101 * HOUR, ready, true, false), false, 'BT1 not shown: not live');
    // Still learning: nothing counts.
    assert.equal(savingsLive(500 * HOUR, Infinity, true, true), false);
    // Hot water has no learning phase.
    assert.equal(savingsLive(5 * HOUR, -Infinity, true, undefined), true);
    // The first live hour walks back no further than the first shift.
    const fed = (at: number) => savingsLive(at, ready, undefined, true);
    assert.equal(firstLiveFrom(Math.max(90 * HOUR, ready), fed), ready);
});

test('the year ahead: heating by season, hot water at a flat pace, and nothing past 31 December', () => {
    const base = {days: 3, ratio: 1};
    // Six winter weeks, 4 kr a day each: January and the first half of February.
    const winter: SavingsDay[] = [];
    for (let k = 0; k < 45; k++) {
        const date = new Date(Date.UTC(2027, 0, 1 + k)).toISOString().slice(0, 10);
        winter.push(day(date, [10, 0, 0], 1.4, 10, 1));
    }
    const heat = yearOutlook(winter, '2026-11-14', base, '2027-02-14', 'heating', SEASON)!;
    const water = yearOutlook(winter, '2026-11-14', base, '2027-02-14', 'hotwater')!;
    assert.ok(Math.abs(heat.saved - 180) < 1e-6 && Math.abs(water.saved - 180) < 1e-6);
    assert.ok(Math.abs(water.rest - 4 * 320) < 1e-6, 'hot water: 320 days left at 4 kr');
    assert.ok(heat.rest < water.rest / 2, `heating's rest weighs the mild months less: ${heat.rest}`);
    const last = yearOutlook(winter, '2026-11-14', base, '2027-12-31', 'heating', SEASON);
    assert.equal(last?.rest, 0, 'the last day: nothing ahead');
    // A summer start: heating's days so far weigh nothing, so there is no pace to project.
    const summer = Array.from({length: 8}, (_, k) => day(`2027-07-0${k + 1}`, [1, 0, 0], 1.4, 1, 1));
    assert.equal(yearOutlook(summer, '2027-07-01', base, '2027-07-09', 'heating', SEASON), undefined);
    assert.equal(seasonWeight('2027-07-10', 'hotwater'), 1);
    assert.equal(seasonWeight('2027-01-10', 'heating', SEASON), 18);
    assert.ok(Number.isNaN(seasonWeight('2027-01-10', 'heating')), 'no season: no weight');
});
