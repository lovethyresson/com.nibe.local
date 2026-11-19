import {test} from 'node:test';
import assert from 'node:assert';
import {DEFAULT_TAU_H, MAX_ERROR, RECOVERY_H, SETTLE_H, TRIM_KP, TRIM_RANGE, TRIM_SPEED, TrimState, nextTrim, readTrim}
    from '../lib/autopilot/setpoint';

const base = {setpoint: 21, mean: 21, hours: 0.25, integrate: true, tauHours: 96};

test('at the setpoint the trim is just what it has learned', () => {
    assert.equal(nextTrim({integral: -3}, base).trim, -3);
    assert.equal(nextTrim({integral: -3}, base).state.integral, -3);
});

test('below the setpoint it warms at once, and learns the rest at the house\'s own speed', () => {
    const cold = nextTrim({integral: 0}, {...base, mean: 20.5, hours: 1});
    const learned = 0.5 * TRIM_SPEED / 96;
    assert.ok(Math.abs(cold.state.integral - learned) < 1e-9, 'an hour of 0.5 K adds speed / τ × 0.5');
    assert.ok(Math.abs(cold.trim - (learned + TRIM_KP * 0.5)) < 1e-9, 'plus the proportional part');
    assert.ok(nextTrim({integral: 0}, {...base, mean: 21.5, hours: 1}).trim < 0, 'above it eases off');
});

test('a heavy house learns more slowly than a light one', () => {
    const light = nextTrim({integral: 0}, {...base, mean: 20.5, hours: 1, tauHours: 48}).state.integral;
    const heavy = nextTrim({integral: 0}, {...base, mean: 20.5, hours: 1, tauHours: 240}).state.integral;
    assert.ok(light > 4 * heavy, `${light} vs ${heavy}`);
    // Without a time constant a default is used, never a division by nothing.
    const unknown = nextTrim({integral: 0}, {...base, mean: 20.5, hours: 1, tauHours: undefined}).state.integral;
    assert.ok(Math.abs(unknown - 0.5 * TRIM_SPEED / DEFAULT_TAU_H) < 1e-9);
});

test('while the house is already recovering the learned part waits', () => {
    // Six hours ago it was 0.6 K below; now 0.3 K: catching up, so nothing more is added.
    let state: TrimState = {integral: 1};
    state = nextTrim(state, {...base, mean: 20.4, hours: 0.25}).state;
    for (let h = 0; h < RECOVERY_H * 4; h++) state = nextTrim(state, {...base, mean: 20.4 + 0.3 * h / (RECOVERY_H * 4), hours: 0.25}).state;
    const before = state.integral;
    const now = nextTrim(state, {...base, mean: 20.7, hours: 0.25});
    assert.equal(now.state.integral, before);
    assert.ok(now.trim > before, 'the proportional part still pushes');
    // Still 0.6 K below after six hours: not recovering, it learns.
    let stuck: TrimState = {integral: 1};
    for (let h = 0; h <= RECOVERY_H * 4; h++) stuck = nextTrim(stuck, {...base, mean: 20.4, hours: 0.25}).state;
    assert.ok(stuck.integral > 1);
});

test('a jump of the setpoint (Away) holds the trim still instead of chasing it', () => {
    const before = nextTrim({integral: 0.8}, {...base, mean: 20.8});
    const away = nextTrim(before.state, {...base, setpoint: 16, mean: 20.8, hours: 1});
    assert.equal(away.trim, before.trim);
    assert.equal(away.state.integral, before.state.integral);
    // Back at the old setpoint it holds a day longer (the mean still holds Away), then moves again.
    let state = away.state;
    for (let h = 0; h < SETTLE_H; h++) state = nextTrim(state, {...base, mean: 20.5, hours: 1}).state;
    assert.notEqual(nextTrim(state, {...base, mean: 20.5, hours: 1}).trim, before.trim);
});

test('far from the setpoint it still steers, no faster than at MAX_ERROR', () => {
    // A curve set 4 K low: the house sits 3 K under. It used to hold still here, for good.
    const far = nextTrim({integral: 0}, {...base, mean: 18, hours: 1});
    const edge = nextTrim({integral: 0}, {...base, mean: 21 - MAX_ERROR, hours: 1});
    assert.ok(far.trim > 0);
    assert.deepEqual(far, edge);
});

test('Simulated shows the trim but learns nothing', () => {
    const shown = nextTrim({integral: 1}, {...base, mean: 20.5, hours: 1, integrate: false});
    assert.equal(shown.state.integral, 1);
    assert.equal(shown.trim, 1 + TRIM_KP * 0.5);
});

test('the trim never passes its range', () => {
    let state: TrimState = {integral: 0};
    for (let i = 0; i < 5000; i++) state = nextTrim(state, {...base, mean: 19.5, hours: 1, tauHours: 12}).state;
    assert.equal(state.integral, TRIM_RANGE);
    assert.equal(nextTrim(state, {...base, mean: 19.5}).trim, TRIM_RANGE);
});

test('a stored trim reads back, and anything else reads as none', () => {
    assert.deepEqual(readTrim({integral: -2.5}), {integral: -2.5});
    assert.deepEqual(readTrim(null), {integral: 0});
    assert.deepEqual(readTrim({integral: 99}), {integral: TRIM_RANGE});
});

test('after the setpoint changes the trim waits a day, so the old target\'s hours do not read as an error', () => {
    // Back from Away: the setpoint returns to 21 while the 24 h mean still holds the away days.
    let state: TrimState = nextTrim({integral: 0.5}, {...base, setpoint: 16, mean: 16.2}).state;
    const held = nextTrim(state, {...base, mean: 16.2}).trim;
    for (let h = 0; h < SETTLE_H * 4 - 1; h++) {
        const next = nextTrim(state, {...base, mean: 19.5 + h * 0.01, hours: 0.25});
        assert.equal(next.trim, held, `still holding after ${h / 4} h`);
        state = next.state;
    }
    // A day later it steers again.
    assert.notEqual(nextTrim(state, {...base, mean: 20.6, hours: 0.5}).trim, held);
    // A small change (the owner nudging 0.1 K) is no jump.
    const nudged = nextTrim({integral: 0, setpoint: 21}, {...base, setpoint: 21.1, mean: 20.8});
    assert.ok(nudged.trim > 0);
});
