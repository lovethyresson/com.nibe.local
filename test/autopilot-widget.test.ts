import {test} from 'node:test';
import assert from 'node:assert/strict';
import {aimingFor, chargeBands, symmetricAxis, formatDuration, heatingSlots, niceAxis, shiftBars, stripLead, ticks, todaySlots} from '../lib/autopilot/widget';
import {dayKind, hotwaterWeek, useRuns} from '../lib/autopilot/hotwater-use';
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

test('hour ticks every 6 h from the chart\'s midnight', () => {
    const start = Date.parse('2026-11-14T00:00:00Z');
    const marks = ticks(start, 96, (ms) => String(new Date(ms).getUTCHours()));
    assert.deepEqual(marks.map((m) => m.label), ['0', '6', '12', '18']);
    assert.deepEqual(marks.map((m) => m.at), [0, 24, 48, 72]);
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

test('axes use round gridlines, and a tick is never rounded away from its line', () => {
    assert.deepEqual(niceAxis(0, 1.35), {lo: 0, hi: 1.5, ticks: [0, 0.5, 1, 1.5], decimals: 1});
    assert.deepEqual(niceAxis(0, 0.5).ticks, [0, 0.25, 0.5], 'a quarter shows as 0.25, not 0.3');
    assert.equal(niceAxis(0, 0.5).decimals, 2);
    assert.deepEqual(niceAxis(0, 2.8).ticks, [0, 1, 2, 3], 'a dear price keeps to four intervals');
    const indoor = niceAxis(20.4 - 0.3, 22 + 0.3, {minSpan: 2, steps: [0.5, 1, 2, 5]});
    assert.deepEqual(indoor.ticks, [20, 21, 22, 23], 'indoor labels are whole degrees, not 21.3');
    assert.ok(indoor.ticks.every((v) => v >= indoor.lo && v <= indoor.hi));
});

test('the shift axis always holds 0 and is at least half a degree tall', () => {
    const calm = niceAxis(0, 0, {include: [0], minSpan: 0.5, steps: [0.25, 0.5, 1, 2, 5]});
    assert.ok(calm.hi - calm.lo >= 0.5 && calm.ticks.includes(0));
    const dip = niceAxis(-1.5, 0, {include: [0], minSpan: 0.5, steps: [0.25, 0.5, 1, 2, 5]});
    assert.deepEqual([dip.lo, dip.hi], [-1.5, 0], 'half-degree steps, and 0 is a real zero');
    assert.ok(dip.ticks.includes(0));
});

test('durations are hours and minutes, as in the timeline', () => {
    const say = (key: string, tokens: Record<string, number>) => `${key}:${Object.values(tokens).join(',')}`;
    assert.equal(formatDuration(45, say), 'duration_min:45');
    assert.equal(formatDuration(130, say), 'duration:2,10');
    assert.equal(formatDuration(180, say), 'duration_h:3');
    assert.equal(formatDuration(59.6, say), 'duration_h:1', 'rounded first');
});

test('the charts show today, local midnight to midnight', () => {
    const slotMs = 15 * 60_000;
    const slot = Date.parse('2026-11-14T16:10:00Z') / slotMs | 0;
    const utc = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const day = todaySlots(slot, utc);
    assert.equal(day.n, 96);
    assert.equal(new Date(day.from * slotMs).toISOString(), '2026-11-14T00:00:00.000Z');
    // An hour ahead of UTC: the day starts an hour earlier in UTC terms.
    const plus1 = (ms: number) => utc(ms + 3_600_000);
    assert.equal(new Date(todaySlots(slot, plus1).from * slotMs).toISOString(), '2026-11-13T23:00:00.000Z');
    // The day the clocks go forward in Stockholm has 23 hours.
    const sthlm = (ms: number) => new Date(ms).toLocaleDateString('sv-SE', {timeZone: 'Europe/Stockholm'});
    const spring = Date.parse('2026-03-29T12:00:00Z') / slotMs | 0;
    assert.equal(todaySlots(spring, sthlm).n, 92);
    const autumn = Date.parse('2026-10-25T12:00:00Z') / slotMs | 0;
    assert.equal(todaySlots(autumn, sthlm).n, 100);
});

test('a planned charge is one labelled band, with the share the sun covers', () => {
    const hour = 3_600_000;
    const from = Date.parse('2026-11-14T20:00:00Z');
    const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);
    const slots = Array.from({length: 24}, (_, k) => (k >= 8 && k < 17 ? {charge: k < 12 ? 1 : 0} : {}));
    const bands = chargeBands(slots, from, clock, (a, b) => `${a} to ${b}`);
    assert.equal(bands.length, 1);
    assert.deepEqual([bands[0].from, bands[0].to], [8, 17]);
    assert.equal(bands[0].label, '22:00 to 00:15', 'start of the first slot to the end of the last');
    assert.equal(bands[0].solar, 0.44, 'four of nine slots on the surplus');
    const two = chargeBands([{charge: 0}, {}, {charge: 0}], from, clock, (a, b) => `${a}-${b}`);
    assert.equal(two.length, 2);
    assert.equal(hour, 3_600_000);
});

test('charges already done are bands too; a running charge is one band, its done part first', () => {
    const from = Date.parse('2026-11-15T00:00:00Z');
    const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);
    const ran = {ran: true as const};
    const slots = [{}, ran, ran, {}, ran, ran, {charge: 0}, {charge: 0.5}, {}, ran, {charge: 0}];
    const bands = chargeBands(slots, from, clock, (a, b) => `${a}-${b}`);
    assert.deepEqual(bands.map((b) => [b.from, b.to, b.doneTo]), [[1, 3, 3], [4, 8, 6], [9, 11, 10]]);
    assert.equal(bands[1].label, '01:00-02:00', 'one label from the start of what ran to the end of the plan');
    assert.equal(bands[1].solar, 0.25, 'the solar share is the planned part\'s');
    assert.equal(chargeBands([{charge: 0}, ran], from, clock, (a, b) => a + b).length, 2, 'done after planned is another charge');
});

test('a reason loses the word the status already says', () => {
    assert.equal(stripLead('Holding. No changes planned', ['Holding']), 'No changes planned');
    assert.equal(stripLead('Holding · easing off at 19:00', ['Holding']), 'Easing off at 19:00');
    assert.equal(stripLead('Easing off until 18:00: prices peak', ['Easing off']), 'Until 18:00: prices peak',
        'the tile says the status as the reason\'s first words; the widget shows it once');
    assert.equal(stripLead('Offline', ['Off']), 'Offline', 'a lead is a whole word');
    assert.equal(stripLead('Simulated: Holding. Prices are too even to shift', ['Simulated', 'Holding']), 'Prices are too even to shift');
    assert.equal(stripLead('Until 19:00. Prices peak 17–19', ['Easing off']), 'Until 19:00. Prices peak 17–19', 'nothing to strip');
    assert.equal(stripLead('Holding.', ['Holding']), '', 'only the lead: nothing left');
    assert.equal(stripLead('Håller. Inget att vinna', ['Håller']), 'Inget att vinna');
    assert.equal(stripLead('Anything', ['a(b']), 'Anything', 'a lead with regex characters is safe');
});

test('the shift is one bar an hour: the mean of its slots, none for a calm hour', () => {
    const slots = [{offset: 2}, {offset: 2}, {offset: 1}, {offset: 1}, {offset: 0}, {offset: 0}, {offset: 0}, {offset: 0},
        {offset: -1}, {}, {offset: -2}, {}, {}, {}, {}, {}, {offset: 0.3}, {offset: -0.3}, {offset: 0}, {offset: 0}];
    assert.deepEqual(shiftBars(slots), [
        {at: 0, to: 4, value: 1.5},
        {at: 8, to: 12, value: -1.5},
    ], 'a calm hour, an hour with no value and an hour that averages 0 have no bar');
    assert.deepEqual(shiftBars([{offset: 1}, {offset: 1}], 4), [{at: 0, to: 2, value: 1}], 'a short last hour is a short bar');
    assert.deepEqual(shiftBars([]), []);
});

test('the widget aims for where the pre-heat ends, and for the thermostat while holding', () => {
    const past = [{indoor: 21.3, offset: -10}, {indoor: 22.4, offset: -10}];
    const plan = [{indoor: 22.4, offset: -10}, {indoor: 22.5, offset: -10}, {indoor: 22.6, offset: -10}, {indoor: 22.6, offset: 8}];
    assert.equal(aimingFor([...past, ...plan], 2, 22.5), 22.6, 'the expected indoor at the end of the pre-heat');
    assert.equal(aimingFor([...past, ...plan], 5, 22.5), 22.6, 'an ease-off is a run of its own');
    assert.equal(aimingFor([...past, {indoor: 22.4, offset: 0.1}], 2, 22.5), 22.5, 'holding: the thermostat');
    assert.equal(aimingFor([...past, {offset: -10}], 2, 22.5), 22.5, 'no expected line yet: the thermostat');
    assert.equal(aimingFor([], 0, undefined), undefined);
});

test('the shift axis is symmetric, so 0 sits in the middle', () => {
    for (const shifts of [[-10, 0, -2], [0, 3], [0], [-0.1]]) {
        const a = symmetricAxis(shifts);
        assert.equal(a.lo, -a.hi, `${shifts}: ${a.lo}..${a.hi}`);
        assert.ok(a.ticks.includes(0));
        assert.ok(a.hi >= Math.max(...shifts.map(Math.abs)));
    }
    assert.deepEqual(symmetricAxis([-10, -2]).ticks, [-10, -5, 0, 5, 10]);
});

test('the day\'s use is told as runs of hours: a shower over the hour is one line, a trickle is none', () => {
    const u = undefined;
    // 2026-11-15: 46 L at 09 and 126 at 10 (one shower), then 20–30 L an hour of noise while the
    // tank charged, and 60 L at 16.
    assert.deepStrictEqual(useRuns([2, 2, u, 2, 2, 2, 2, 2, 6, 46, 126, 20, 25, 28, 25, 4, 60, 5]),
        [{hour: 9, litres: 170}, {hour: 16, litres: 60}]);
});
