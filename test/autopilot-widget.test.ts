import {test} from 'node:test';
import assert from 'node:assert/strict';
import {heatingSlots, ticks} from '../lib/autopilot/widget';

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
