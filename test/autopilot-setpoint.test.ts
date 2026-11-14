import {test} from 'node:test';
import assert from 'node:assert';
import {INTEGRATE_WITHIN, TRIM_KI, TRIM_RANGE, nextTrim, readTrim} from '../lib/autopilot/setpoint';

const base = {setpoint: 21, mean: 21, hours: 0.25, integrate: true};

test('at the setpoint the trim is just what it has learned', () => {
    assert.deepEqual(nextTrim({integral: -3}, base), {trim: -3, state: {integral: -3}});
});

test('a house below the setpoint learns a pre-heat, above it an ease-off', () => {
    const cold = nextTrim({integral: 0}, {...base, mean: 20.5, hours: 1});
    assert.ok(Math.abs(cold.trim - TRIM_KI * 0.5) < 1e-9, 'an hour of 0.5 K adds Ki × 0.5');
    assert.ok(nextTrim({integral: 0}, {...base, mean: 21.5, hours: 1}).trim < 0);
});

test('the trim learns only while live, and only near the setpoint', () => {
    assert.equal(nextTrim({integral: 1}, {...base, mean: 20, integrate: false}).state.integral, 1, 'Simulated holds it');
    assert.equal(nextTrim({integral: 1}, {...base, mean: 21 - INTEGRATE_WITHIN - 0.5, hours: 1}).state.integral, 1,
        'far off (a setpoint jump, Away) is the planner\'s to close, not the trim\'s to learn');
});

test('the trim never passes its range', () => {
    let state = {integral: 0};
    for (let i = 0; i < 5000; i++) state = nextTrim(state, {...base, mean: 20.2, hours: 1}).state;
    assert.equal(state.integral, TRIM_RANGE);
});

test('a stored trim reads back, and anything else reads as none', () => {
    assert.deepEqual(readTrim({integral: -2.5}), {integral: -2.5});
    assert.deepEqual(readTrim(null), {integral: 0});
    assert.deepEqual(readTrim({integral: 99}), {integral: TRIM_RANGE});
});
