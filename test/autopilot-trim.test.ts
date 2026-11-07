import {test} from 'node:test';
import assert from 'node:assert/strict';
import {COMFORT_BIAS_RANGE, comfortBias} from '../lib/autopilot/trim';
import {curveInputFor, fitSupplyCurve, supplyAt} from '../lib/autopilot/curve';
import {simulate, steadyState} from '../lib/autopilot/planner';
import {fedValue} from '../lib/autopilot/actuator';
import {RADIATOR_HOUSE} from './autopilot-house-sim';

const line = (a: number, slope: number, lo = -15, hi = 25, floor = -Infinity) =>
    fitSupplyCurve(Array.from({length: 300}, (_, i) => {
        const x = lo + (hi - lo) * i / 299;
        return {x, supply: Math.max(floor, a - slope * x)};
    }))!;

test('the curve\'s inverse finds what it must see for a supply, and stops at a floor', () => {
    const curve = line(40, 0.5);
    for (const x of [-12, -3, 0, 7.5, 20]) assert.ok(Math.abs(curveInputFor(curve, supplyAt(curve, x))! - x) < 0.05, `${x}`);
    // Beyond the learned range the end segments carry on.
    assert.ok(Math.abs(curveInputFor(curve, 50)! - -20) < 0.3);
    // On min supply any warmer x gives the same: the inverse stops where the floor starts (within
    // a knot, which the smoothing rounds the kink to).
    const floored = line(40, 0.5, -15, 40, 25);
    assert.ok(Math.abs(curveInputFor(floored, 20)! - 30) <= 2 + 1e-9, `${curveInputFor(floored, 20)}`);
});

test('the comfort bias makes the pump\'s own curve hold comfort', () => {
    const house = RADIATOR_HOUSE;
    const pump = {supply: line(36, 0.5), heatPerSupplyK: 0.25};
    const comfort = 21;
    for (const te of [-10, 0, 8]) {
        const held = comfortBias(house, pump, comfort, te);
        const start = steadyState(house, comfort, te, pump);
        assert.equal(start.bias, held);
        const sim = simulate(house, comfort, start, Array.from({length: 96}, () => ({te, sun: 0, price: 1})),
            new Array(96).fill(held), pump);
        assert.ok(Math.abs(sim.ti.at(-1)! - comfort) < 0.05, `${te}: ${sim.ti.at(-1)}`);
        // Without it, the curve alone drifts away from comfort.
        const bare = simulate(house, comfort, start, Array.from({length: 96}, () => ({te, sun: 0, price: 1})),
            new Array(96).fill(0), pump);
        if (Math.abs(held) > 1) assert.ok(Math.abs(bare.ti.at(-1)! - comfort) > 0.3, `${te}: ${bare.ti.at(-1)}`);
    }
    // Colder needs more: the bias grows as the curve falls short.
    assert.ok(comfortBias(house, pump, comfort, -10) > comfortBias(house, pump, comfort, 8));
});

test('without a learned curve and emission the curve is assumed to hold comfort', () => {
    assert.equal(comfortBias(RADIATOR_HOUSE, {lever: 0.1}, 21, 0), 0);
    assert.equal(comfortBias(RADIATOR_HOUSE, undefined, 21, 0), 0);
});

test('a comfort bias past what a house can need is held at the range', () => {
    const flat = {supply: line(25.5, 0.01), heatPerSupplyK: 0.25};
    assert.equal(comfortBias(RADIATOR_HOUSE, flat, 21, -10), COMFORT_BIAS_RANGE[1]);
});

test('the profile\'s limits are on the shift from the comfort bias', () => {
    const out = fedValue({real: 0, bias: 12, previousBias: 12, comfortBias: 10, maxBias: 1, maxCoastBias: 1,
        auto: false, thresholds: {}});
    assert.equal(out.bias, 11);
    assert.deepEqual(out.clamped, ['max_bias']);
    const held = fedValue({real: 0, bias: 10, previousBias: 10, comfortBias: 10, maxBias: 0, maxCoastBias: 0,
        auto: false, thresholds: {}});
    assert.equal(held.bias, 10);
    assert.deepEqual(held.clamped, []);
});
