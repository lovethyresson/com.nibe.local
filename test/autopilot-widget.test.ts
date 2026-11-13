import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dayKind, heatingSlots, hotwaterWeek, ticks} from '../lib/autopilot/widget';
import {KWH_PER_LITRE, learn, localClock, TankPoint} from '../lib/autopilot/hotwater-learner';

test('the heating chart is the recorded past, then the plan read from now; offset is fed minus real', () => {
    const past = [{indoor: 21.04, offset: 0}, {indoor: 21.2, offset: -1.96}, {}];
    const state = {mode: 'live' as const, bias: 0, target: 0, slot: 100, biases: [0, 2, -3], indoor: [21.3, 21.5, 21.1]};
    const slots = heatingSlots(past, state, 101, 3);
    assert.deepEqual(slots, [
        {indoor: 21, offset: 0}, {indoor: 21.2, offset: -2}, {indoor: undefined, offset: undefined},
        {indoor: 21.5, offset: -2}, {indoor: 21.1, offset: 3}, {indoor: undefined, offset: undefined},
    ], 'pre-heating feeds BT1 colder: a negative offset');
    assert.deepEqual(heatingSlots([], undefined, 101, 2), [{}, {}], 'nothing ahead without a plan');
    assert.deepEqual(heatingSlots([], {mode: 'live', bias: 0, target: 0, neutral: true}, 101, 2).map((s) => s.offset), [0, 0],
        'Comfort range Off: 0 ahead');
});

test('hour ticks every 6 h, at their slot', () => {
    const hour = 3_600_000;
    const start = 1000 * 24 * hour + 5 * hour; // 05:00 UTC
    const marks = ticks(start, 96, (ms) => String(new Date(ms).getUTCHours()));
    assert.deepEqual(marks.map((m) => m.label), ['6', '12', '18', '0']);
    assert.equal(marks[0].at, 4, '06:00 is four slots after 05:00');
});

// 2026-11-13 is a Friday.
const kwh = (litres: number) => litres * KWH_PER_LITRE;

test('a day is its day type as set, working when none was given; away wins', () => {
    assert.equal(dayKind(), 'working');
    assert.equal(dayKind('working'), 'working');
    assert.equal(dayKind('free'), 'free');
    assert.equal(dayKind('away'), 'away');
    assert.equal(dayKind('working', true), 'away');
});

test('the week chart is the six days before today, then today as Autopilot expects it', () => {
    const recent = [
        {date: '2026-11-07', draw: kwh(500), dayType: 'free' as const},
        {date: '2026-11-08', draw: kwh(400), dayType: 'free' as const},
        {date: '2026-11-09', draw: kwh(300), dayType: 'working' as const},
        {date: '2026-11-10', draw: kwh(302)},
        // 11th missing: no full day read
        {date: '2026-11-12', draw: kwh(40), away: true},
    ];
    const week = hotwaterWeek({recent, today: '2026-11-13', dayType: 'working', expected: kwh(350)}, (date) => date.slice(8));
    assert.deepEqual(week.bars.map((b) => b.label), ['07', '08', '09', '10', '11', '12', '13']);
    assert.deepEqual(week.bars.map((b) => b.litres), [500, 400, 300, 300, undefined, 40, 350]);
    assert.deepEqual(week.bars.map((b) => b.kind), ['free', 'free', 'working', 'working', 'working', 'away', 'working'],
        'a Saturday is not guessed to be a day off: it is the type that was set');
    assert.equal(week.bars[6].today, true);
    assert.equal(week.typical.working, 300, 'away days are left out of a typical day');
    assert.ok(week.typical.free! > 440 && week.typical.free! < 455, 'the newer day off weighs less only by its age: Sat older than Sun');
});

test('with no learned days, no typical days and an empty week', () => {
    const week = hotwaterWeek({recent: [], today: '2026-11-13'}, (date) => date);
    assert.deepEqual(week.typical, {});
    assert.equal(week.bars.length, 7);
    assert.ok(week.bars.every((b) => b.litres === undefined));
});

test('learning keeps the recent full days for the week chart', () => {
    const clock = localClock('UTC');
    const start = Date.parse('2026-11-01T00:00:00Z');
    const points: TankPoint[] = [];
    // Hourly, a counter that never charges and a tank that draws 1 L of 40 °C water an hour.
    for (let h = 0; h <= 24 * 5; h++) points.push({t: start + h * 3_600_000, litres: 200 - h, produced: 0, top: 50});
    const model = learn(points, clock, points[points.length - 1].t);
    assert.ok(model.recent && model.recent.length >= 4, `kept ${model.recent?.length}`);
    assert.equal(model.recent![0].date, '2026-11-01');
    assert.ok(model.recent!.every((d) => Number.isFinite(d.draw)));
});

test('a day the tank ran low is drawn as at least, and left out of a typical day', () => {
    const recent = [
        {date: '2026-11-09', draw: kwh(300)},
        {date: '2026-11-10', draw: kwh(100), partial: 16},
    ];
    const week = hotwaterWeek({recent, today: '2026-11-13'}, (date) => date);
    const tue = week.bars.find((b) => b.label === '2026-11-10')!;
    assert.equal(tue.litres, 100);
    assert.equal(tue.atLeast, true);
    assert.equal(week.bars.find((b) => b.label === '2026-11-09')!.atLeast, undefined);
    assert.equal(week.typical.working, 300);
});
