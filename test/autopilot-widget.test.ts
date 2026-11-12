import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PROFILE_LIMITS} from '../lib/autopilot/live';
import {hoursToDrop, houseLines, plannedShifts, ticks} from '../lib/autopilot/widget';
import {RADIATOR_HOUSE} from './autopilot-house-sim';

const t = (key: string, tokens?: Record<string, string | number>) =>
    key + (tokens ? `(${Object.entries(tokens).map(([k, v]) => `${k}=${v}`).join(',')})` : '');

test('a house cools faster the colder it is outside', () => {
    const mild = hoursToDrop(RADIATOR_HOUSE, 1, 21, 5)!;
    const cold = hoursToDrop(RADIATOR_HOUSE, 1, 21, -15)!;
    assert.ok(cold < mild, `${cold} h at -15 °C, ${mild} h at 5 °C`);
    assert.ok(hoursToDrop(RADIATOR_HOUSE, 3, 21, 0)! > hoursToDrop(RADIATOR_HOUSE, 1, 21, 0)!);
});

test('the house lines say how fast it cools at today\'s and the coldest outdoor temperature, and how long it may ease off', () => {
    const lines = houseLines(RADIATOR_HOUSE, t, {from: 21, outdoor: 4.6, coldest: -3.2, limits: PROFILE_LIMITS.save_some,
        rangeTitle: 'Save'});
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^house\.cools\(out=5,h=\d+(\.5)?\)$/);
    assert.match(lines[1], /^house\.cools\(out=-3,/);
    assert.match(lines[2], /^house\.coast\(range=Save,h=\d+/);
    const coast = Number(/h=([\d.]+)/.exec(lines[2])![1]);
    assert.ok(coast <= PROFILE_LIMITS.save_some.maxCoastH, 'never longer than the range allows');
    assert.equal(houseLines(RADIATOR_HOUSE, t, {from: 21, outdoor: 4, coldest: 4.2, limits: PROFILE_LIMITS.comfortable,
        rangeTitle: 'Comfort'}).length, 2, 'the same temperature twice is said once');
    assert.deepEqual(houseLines(undefined, t, {from: 21, outdoor: 4, limits: PROFILE_LIMITS.comfortable, rangeTitle: 'C'}), [],
        'nothing before the first fit');
});

test('the chart reads the plan from now, not from the slot it was made in', () => {
    const shifts = plannedShifts({mode: 'live', bias: 0, target: 0, slot: 100, biases: [0, -1, -2.04, 1]}, 101, 4);
    assert.deepEqual(shifts, [-1, -2, 1, undefined]);
    assert.deepEqual(plannedShifts({mode: 'off', bias: 0, target: 0}, 101, 2), [undefined, undefined]);
});

test('hour ticks every 6 h, at their slot', () => {
    const hour = 3_600_000;
    const start = 1000 * 24 * hour + 5 * hour; // 05:00 UTC
    const marks = ticks(start, 96, (ms) => String(new Date(ms).getUTCHours()));
    assert.deepEqual(marks.map((m) => m.label), ['6', '12', '18', '0']);
    assert.equal(marks[0].at, 4, '06:00 is four slots after 05:00');
});
