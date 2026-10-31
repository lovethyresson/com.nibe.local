import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PRESETS, limitsFor, presetOf} from '../lib/smart/presets';
import {curveInput, fedValue} from '../lib/smart/actuator';
import {planShift, simulate, steadyState, ForecastSlot} from '../lib/smart/planner';
import {RADIATOR_HOUSE, SLAB_HOUSE} from './smart-house-sim';
import energyPrices from './fixtures/energy-prices-se3-2026-10-30.json';

test('presets set the table\'s coast caps and bias limits', () => {
    const c = limitsFor(PRESETS.comfortable);
    const s = limitsFor(PRESETS.save_some);
    const m = limitsFor(PRESETS.save_most);
    assert.deepEqual([c.maxBias, s.maxBias, m.maxBias], [6, 12, 20]);
    assert.ok(c.maxCoastH <= 2.4 && s.maxCoastH <= 5 && m.maxCoastH === 8);
    assert.equal(m.lower + m.upper, 6); // the 6 K swing
    assert.ok(Math.abs(c.margin - 0.6) < 1e-9 && Math.abs(m.margin - 0.1) < 1e-9);
    assert.ok(Math.abs(limitsFor({...PRESETS.save_some, weather: 0.5}).forecastTrust - 0.5) < 1e-9);
    assert.ok(Math.abs(m.forecastTrust - 0.9) < 1e-9);
});

test('Custom at zero is trim only, and extremes stay in range', () => {
    const zero = limitsFor({coldest: 0, warmest: 0, price: 0, weather: 0, stored: 0});
    assert.deepEqual(zero, {lower: 0, upper: 0, margin: Infinity, forecastTrust: 0, maxCoastH: 0, preheatLeadTau: 0, maxBias: 0});
    const wild = limitsFor({coldest: 9, warmest: -1, price: 2, weather: 2, stored: 2});
    assert.deepEqual([wild.lower, wild.upper, wild.maxBias, wild.margin], [5, 0, 20, 0.1]);
});

test('settings round-trip to their preset, anything else is Custom', () => {
    for (const id of ['comfortable', 'save_some', 'save_most'] as const) assert.equal(presetOf({...PRESETS[id]}), id);
    assert.equal(presetOf({...PRESETS.save_some, price: 0.7}), 'custom');
});

const base = {real: 0, bias: 0, previousBias: 0, maxBias: 12, auto: true,
    thresholds: {stopHeating: 17, startCooling: 25, stopAddHeat: -10}};

test('fed = real − bias, limited by the profile and the ramp', () => {
    assert.deepEqual(fedValue({...base, bias: 1.5}), {fed: -1.5, bias: 1.5, clamped: []});
    assert.deepEqual(fedValue({...base, bias: -9}), {fed: 2, bias: -2, clamped: ['ramp']});
    assert.deepEqual(fedValue({...base, bias: -30, previousBias: -11}), {fed: 12, bias: -12, clamped: ['max_bias']});
    assert.deepEqual(fedValue({...base, bias: -9, slots: 3}).bias, -6);
});

test('a coast never feeds warm enough to stop heating', () => {
    const out = fedValue({...base, real: 10, bias: -12, previousBias: -12});
    assert.equal(out.fed, 16);
    assert.deepEqual(out.clamped, ['stop_heating']);
    // In Manual the thresholds do nothing, so nothing is clamped.
    assert.equal(fedValue({...base, auto: false, real: 10, bias: -12, previousBias: -12}).fed, 22);
});

test('a day already past the stop limit passes through unbiased', () => {
    assert.deepEqual(fedValue({...base, real: 16.5, bias: 4, previousBias: 4}), {fed: 16.5, bias: 0, clamped: ['pass_through']});
});

test('a pre-heat never unlocks the immersion heater', () => {
    const out = fedValue({...base, real: -6, bias: 8, previousBias: 8});
    assert.equal(out.fed, -9);
    assert.deepEqual(out.clamped, ['add_heat']);
    // Already colder than the limit for real: add heat is allowed anyway, nothing to protect.
    assert.equal(fedValue({...base, real: -12, bias: 2}).fed, -14);
});

test('the curve follows the fed value with the measured 49 min lag', () => {
    let f = 0;
    for (let k = 0; k < 4; k++) f = curveInput(f, -10);
    assert.ok(Math.abs(f - -10 * (1 - Math.exp(-60 / 49))) < 1e-9);
});

/** A real SE3 day (2026-10-30) at the maintainer's all-in formula, flat 2 °C, no sun. */
const day: ForecastSlot[] = (energyPrices as any).pricesPerInterval
    .map((p: any) => ({price: (p.value + 0.609) * 1.25, te: 2, sun: 0}));
const peaked: ForecastSlot[] = day.map((s, k) => ({...s, price: k >= 64 && k < 80 ? 4 : 1}));

test('the planner buys the same comfort cheaper, inside each preset\'s band', () => {
    for (const house of [RADIATOR_HOUSE, SLAB_HOUSE]) {
        const start = steadyState(house, 21, 2);
        let previous = 0;
        for (const id of ['comfortable', 'save_some', 'save_most'] as const) {
            const limits = limitsFor(PRESETS[id]);
            const plan = planShift(house, 21, start, peaked, limits);
            assert.ok(plan.fairCost < plan.baselineFairCost, `${id}: no saving`);
            assert.ok(plan.plan.ti.every((t, k) => t >= Math.min(21 - limits.lower, plan.baseline.ti[k]) - 0.1
                && t <= Math.max(21 + limits.upper, plan.baseline.ti[k]) + 0.1), `${id}: left the band`);
            assert.ok(plan.biases.every((b) => Math.abs(b) <= limits.maxBias));
            const saving = 1 - plan.fairCost / plan.baselineFairCost;
            assert.ok(saving >= previous - 1e-9, `${id} saved less than a tighter preset`);
            previous = saving;
        }
    }
});

test('it coasts through the expensive block and pre-heats or recovers in cheap slots', () => {
    const plan = planShift(RADIATOR_HOUSE, 21, steadyState(RADIATOR_HOUSE, 21, 2), peaked, limitsFor(PRESETS.save_most));
    const inPeak = plan.biases.slice(66, 78);
    assert.ok(inPeak.some((b) => b < 0) && inPeak.every((b) => b <= 0));
    assert.ok(plan.biases.slice(40, 64).some((b) => b > 0) || plan.biases.slice(80).some((b) => b > 0));
});

test('a flat price, a thin spread or zero room shifts nothing', () => {
    const start = steadyState(RADIATOR_HOUSE, 21, 2);
    const flat = day.map((s) => ({...s, price: 2}));
    assert.equal(planShift(RADIATOR_HOUSE, 21, start, flat, limitsFor(PRESETS.save_most)).reason, 'spread_below_margin');
    const thin = day.map((s, k) => ({...s, price: k % 2 ? 2.4 : 2}));
    assert.equal(planShift(RADIATOR_HOUSE, 21, start, thin, limitsFor(PRESETS.comfortable)).reason, 'spread_below_margin');
    const none = limitsFor({coldest: 0, warmest: 0, price: 0, weather: 0, stored: 0});
    assert.equal(planShift(RADIATOR_HOUSE, 21, start, peaked, none).reason, 'no_room');
});

test('negative prices pull heat in', () => {
    const negative = day.map((s, k) => ({...s, price: k >= 8 && k < 24 ? -0.5 : 2}));
    const plan = planShift(SLAB_HOUSE, 21, steadyState(SLAB_HOUSE, 21, 2), negative, limitsFor(PRESETS.save_some));
    const heatIn = (sim: {heat: number[]}) => sim.heat.slice(8, 24).reduce((a, b) => a + b, 0);
    assert.ok(heatIn(plan.plan) > heatIn(plan.baseline));
});

test('doing nothing from steady state holds comfort, so the reference is honest', () => {
    const sim = simulate(RADIATOR_HOUSE, 21, steadyState(RADIATOR_HOUSE, 21, 2), day, new Array(day.length).fill(0));
    assert.ok(sim.ti.every((t) => Math.abs(t - 21) < 0.01));
});
