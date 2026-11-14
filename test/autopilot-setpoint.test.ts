import {test} from 'node:test';
import assert from 'node:assert';
import {GAIN_RANGE, TRIM_KI, TRIM_RANGE, nextTrim, readTrim, trimGain} from '../lib/autopilot/setpoint';

const base = {setpoint: 21, mean: 21, heatLoss: 0.227, lever: 0.117, hours: 0.25, integrate: true};

test('the gain is the model\'s heat loss per K of shift, within a plausible range', () => {
    assert.ok(Math.abs(trimGain(0.227, 0.117) - 1.94) < 0.01, 'the S1155: about 2 K of BT1 per K indoors');
    assert.equal(trimGain(1, 0.01), GAIN_RANGE[1]);
    assert.equal(trimGain(0.01, 1), GAIN_RANGE[0]);
    assert.equal(trimGain(0.2, 0), GAIN_RANGE[0], 'no lever yet: the gentlest gain');
});

test('at the setpoint the trim is just what it has learned', () => {
    assert.deepEqual(nextTrim({integral: -3}, base), {trim: -3, state: {integral: -3}});
});

test('too warm eases off, too cold pre-heats, and the integral follows the error', () => {
    const warm = nextTrim({integral: 0}, {...base, mean: 22});
    assert.ok(warm.trim < 0 && warm.state.integral < 0);
    const cold = nextTrim({integral: 0}, {...base, mean: 20, hours: 1});
    assert.ok(cold.trim > 0);
    assert.ok(Math.abs(cold.state.integral - TRIM_KI) < 1e-9, 'one hour of 1 K adds Ki');
});

test('the integral only moves while live', () => {
    assert.equal(nextTrim({integral: 1}, {...base, mean: 20, integrate: false}).state.integral, 1);
});

test('the trim never passes its range, and the integral does not wind up beyond it', () => {
    let state = {integral: 0};
    let trim = 0;
    for (let i = 0; i < 2000; i++) ({trim, state} = nextTrim(state, {...base, mean: 20.1, hours: 1}));
    assert.ok(trim <= TRIM_RANGE && state.integral <= TRIM_RANGE);
    assert.equal(nextTrim({integral: 0}, {...base, mean: 10}).trim, TRIM_RANGE, 'a big error is clamped');
});

test('a stored trim reads back, and anything else reads as none', () => {
    assert.deepEqual(readTrim({integral: -2.5}), {integral: -2.5});
    assert.deepEqual(readTrim(null), {integral: 0});
    assert.deepEqual(readTrim({integral: 99}), {integral: TRIM_RANGE});
});

test('Away is another setpoint: the jump neither winds the integral up nor waits a day to act', () => {
    // A week away at 16 °C from 21: far beyond the widest range, so indoor now counts, and no learning.
    const away = nextTrim({integral: -1.5}, {...base, setpoint: 16, mean: 21, ti: 21, band: 6, hours: 1});
    assert.equal(away.state.integral, -1.5, 'what the curve needs at home is kept');
    // Home again: the house is at 16.5, the day's mean still 18. Indoor now drives it, hard.
    const home = nextTrim(away.state, {...base, setpoint: 21, mean: 18, ti: 16.5, band: 0.5, hours: 1});
    assert.ok(home.trim > nextTrim(away.state, {...base, setpoint: 21, mean: 18, hours: 1}).trim, 'faster than the lagging mean');
    assert.equal(home.state.integral, -1.5);
});

test('within the comfort range the shift is not mistaken for an error', () => {
    // Pre-heated to 21.4 on purpose with a ±0.5 range: the day's mean (21) says all is well.
    assert.equal(nextTrim({integral: 0}, {...base, ti: 21.4, band: 0.5}).trim, 0);
});
