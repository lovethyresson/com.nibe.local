import {test} from 'node:test';
import assert from 'node:assert/strict';
import {addDay, chargeCosts, costCheckData, costDay, dayTotals, fillActual, overShare, weekDates, COST_CHECK_DAYS} from '../lib/autopilot/cost-check';

const H = 3_600_000;
const from = Date.UTC(2026, 10, 16, 6); // 07:00 Stockholm
const until = Date.UTC(2026, 10, 16, 23); // local midnight
const t = (key: string, tokens?: Record<string, string | number>) => tokens ? `${key}(${Object.values(tokens).join(',')})` : key;
const money = (v: number) => v.toFixed(2);

test('costDay sums planned costs into hours from the first hour to midnight', () => {
    const d = costDay('2026-11-16', from + 20 * 60_000, until, [{at: from + 10 * 60_000, cost: 1}, {at: from + 50 * 60_000, cost: 2},
        {at: from + 3 * H, cost: 4}, {at: until, cost: 99}, {at: from - H, cost: 99}]);
    assert.equal(d.from, from);
    assert.equal(d.expected.length, 17);
    assert.equal(d.expected[0], 3);
    assert.equal(d.expected[3], 4);
    assert.equal(dayTotals(d).expected, 7);
    assert.ok(d.actual.every((v) => v === null));
});

test('chargeCosts spreads a charge over its slots, across an hour edge', () => {
    const d = costDay('d', from, until, chargeCosts([{at: from + 30 * 60_000, minutes: 60, cost: 4}], 15 * 60_000));
    assert.deepEqual(d.expected.slice(0, 2), [2, 2]);
});

test('addDay keeps the first plan of a day and the newest days', () => {
    const a = costDay('2026-11-16', from, until, [{at: from, cost: 1}]);
    const b = costDay('2026-11-16', from, until, [{at: from, cost: 5}]);
    const l = addDay(addDay([], a), b);
    assert.equal(l.length, 1);
    assert.equal(l[0].expected[0], 1);
    let many: ReturnType<typeof addDay> = [];
    for (let i = 1; i <= 12; i++) many = addDay(many, {...a, date: `2026-11-${String(i).padStart(2, '0')}`});
    assert.equal(many.length, COST_CHECK_DAYS);
    assert.equal(many[0].date, '2026-11-05');
});

test('fillActual fills ended hours with a reading and a price, and closes a full day', () => {
    const d = costDay('2026-11-16', from, from + 2 * H, [{at: from, cost: 1}, {at: from + H, cost: 1}]);
    const use = new Map([[from, 0.5], [from + H, 1]]);
    const prices = new Map([[from, 2], [from + H, 3]]);
    const one = fillActual([d], use, prices, from + 1.5 * H);
    assert.deepEqual(one[0].actual, [1, null]);
    assert.equal(one[0].done, undefined);
    assert.equal(fillActual(one, use, prices, from + 1.5 * H), one, 'same array when nothing changes');
    const two = fillActual(one, use, prices, from + 3 * H);
    assert.deepEqual(two[0].actual, [1, 3]);
    assert.equal(two[0].done, true);
    const s = dayTotals(two[0]);
    assert.equal(s.actual, 4);
    assert.equal(s.complete, true);
});

test('fillActual closes a day two days after it ended, gaps and all', () => {
    const d = costDay('2026-11-16', from, from + 2 * H, [{at: from, cost: 1}]);
    const out = fillActual([d], new Map(), new Map(), from + 2 * H + 49 * H);
    assert.equal(out[0].done, true);
    assert.equal(dayTotals(out[0]).complete, false);
});

test('pace compares only the hours that have a reading', () => {
    const d = {...costDay('2026-11-16', from, from + 4 * H, [0, 1, 2, 3].map((k) => ({at: from + k * H, cost: 1}))), actual: [1.5, null, null, null]};
    const s = dayTotals(d);
    assert.equal(s.expectedKnown, 1);
    const data = costCheckData('T', [{label: 'Hot water', days: [d]}], '2026-11-16', from + 2 * H, t, money, (x) => x);
    const row = data.rows![0];
    assert.equal(row.tone, 'ahead');
    assert.equal(row.sofar, '1.50');
    assert.equal(row.expected, '4.00');
    assert.equal(row.mark, 0.25);
    assert.equal(data.total, undefined, 'no "both" line with one function');
});

test('the day list is this week, Monday to Sunday, and shows a past day only when complete', () => {
    const day = (date: string, exp: number, act: number | null) => ({date, from, until: from + H, expected: [exp], actual: [act], done: true});
    // 2026-11-18 is a Wednesday: Sunday the 15th is last week and stays out.
    const heating = [day('2026-11-15', 50, 80), day('2026-11-16', 10, 11), day('2026-11-17', 10, 9), {...day('2026-11-18', 10, null), done: undefined}];
    const hotwater = [day('2026-11-16', 2, 2.2), day('2026-11-17', 2, null)];
    const data = costCheckData('T', [{label: 'Heating', days: heating}, {label: 'Hot water', days: hotwater}], '2026-11-18', from, t, money, (x) => x);
    assert.deepEqual(data.days!.rows.map((r) => [r.label, r.expected, r.actual, r.diff, r.tone]), [
        ['2026-11-16', '12.00', '13.20', '+10 %', 'over'],
        ['2026-11-17', '12.00', '–', '', 'even'],
        ['2026-11-18', '10.00', '0.00', 'today', 'today'],
        ['2026-11-19', '–', '–', '', 'later'],
        ['2026-11-20', '–', '–', '', 'later'],
        ['2026-11-21', '–', '–', '', 'later'],
        ['2026-11-22', '–', '–', '', 'later'],
    ]);
    assert.equal(data.total!.expected, '10.00');
    assert.equal(data.rows![1].note, 'no_plan_today');
    assert.equal(data.rows![0].mark, undefined, 'no mark before the first reading');
    // Heating's week: Monday and Tuesday (20 planned, 20 spent); last Sunday's +60 % left out.
    assert.equal(data.rows![0].note, 'week(±0 %)');
});

test('a Monday has no finished day this week: the bar says only how today goes', () => {
    const last = {date: '2026-11-15', from, until: from + H, expected: [10], actual: [20], done: true};
    const today = {...costDay('2026-11-16', from, from + 2 * H, [{at: from, cost: 1}, {at: from + H, cost: 1}]), actual: [1, null]};
    const data = costCheckData('T', [{label: 'Heating', days: [last, today]}], '2026-11-16', from + 2 * H, t, money, (x) => x);
    assert.equal(data.rows![0].note, 'pace_even');
    assert.equal(costCheckData('T', [{label: 'Heating', days: [{...today, actual: [null, null]}]}], '2026-11-16', from, t, money, (x) => x).rows![0].note,
        'first_day', 'nothing before today at all: the first full day is still to come');
    const open = {...last, actual: [null], done: undefined};
    assert.equal(costCheckData('T', [{label: 'Heating', days: [open, {...today, actual: [null, null]}]}], '2026-11-16', from, t, money, (x) => x).rows![0].note,
        'first_day', 'yesterday still waiting for its last hours: still no finished day');
});

test('weekDates runs Monday to Sunday, across a month', () => {
    assert.deepEqual(weekDates('2026-11-30'), ['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05', '2026-12-06']);
    assert.equal(weekDates('2026-11-29')[0], '2026-11-23');
});

test('no plans yet: one line', () => {
    assert.equal(costCheckData('T', [{label: 'Heating', days: []}], '2026-11-16', from, t, money, (x) => x).empty, 'empty');
    assert.equal(overShare(0, 3), undefined);
});
