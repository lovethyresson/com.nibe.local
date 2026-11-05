import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PRESETS, limitsFor, presetOf} from '../lib/autopilot/presets';
import {curveInput, fedValue} from '../lib/autopilot/actuator';
import {comfortReference, estimateLever, owedHeat, planShift, simulate, startingPoint, steadyState, ForecastSlot} from '../lib/autopilot/planner';
import {RADIATOR_HOUSE, SLAB_HOUSE, WEST_HOUSE, SIM_START_SLOT, simSun} from './autopilot-house-sim';
import energyPrices from './fixtures/energy-prices-se3-2026-10-30.json';

test('presets set the table\'s coast caps and bias limits', () => {
    const c = limitsFor(PRESETS.comfortable);
    const s = limitsFor(PRESETS.save_some);
    const m = limitsFor(PRESETS.save_most);
    assert.deepEqual([c.maxBias, s.maxBias, m.maxBias], [6, 12, 20]);
    assert.deepEqual([c.maxCoastBias, s.maxCoastBias, m.maxCoastBias], [4.5, 9, 15]);
    assert.ok(c.maxCoastH <= 2.4 && s.maxCoastH <= 5 && m.maxCoastH === 8);
    assert.equal(m.lower + m.upper, 6); // the 6 K swing
    assert.ok(Math.abs(c.margin - 0.6) < 1e-9 && Math.abs(m.margin - 0.1) < 1e-9);
    assert.ok(Math.abs(limitsFor({...PRESETS.save_some, weather: 0.5}).forecastTrust - 0.5) < 1e-9);
    assert.ok(Math.abs(m.forecastTrust - 0.9) < 1e-9);
});

test('Custom at zero is trim only, and extremes stay in range', () => {
    const zero = limitsFor({coldest: 0, warmest: 0, price: 0, weather: 0, stored: 0});
    assert.deepEqual(zero, {lower: 0, upper: 0, margin: Infinity, forecastTrust: 0, maxCoastH: 0, preheatLeadTau: 0, maxBias: 0,
        maxCoastBias: 0, comfortWeight: 2});
    const wild = limitsFor({coldest: 9, warmest: -1, price: 2, weather: 2, stored: 2});
    assert.deepEqual([wild.lower, wild.upper, wild.maxBias, wild.maxCoastBias, wild.margin], [5, 0, 20, 15, 0.1]);
});

test('settings round-trip to their preset, anything else is Custom', () => {
    for (const id of ['comfortable', 'save_some', 'save_most'] as const) assert.equal(presetOf({...PRESETS[id]}), id);
    assert.equal(presetOf({...PRESETS.save_some, price: 0.7}), 'custom');
});

const base = {real: 0, bias: 0, previousBias: 0, maxBias: 12, maxCoastBias: 12, auto: true,
    thresholds: {stopHeating: 17, startCooling: 25, stopAddHeat: -10}};

test('fed = real − bias, limited by the profile and the ramp', () => {
    assert.deepEqual(fedValue({...base, bias: 1.5}), {fed: -1.5, bias: 1.5, clamped: []});
    assert.deepEqual(fedValue({...base, bias: -9}), {fed: 2, bias: -2, clamped: ['ramp']});
    assert.deepEqual(fedValue({...base, bias: -30, previousBias: -11}), {fed: 12, bias: -12, clamped: ['max_bias']});
    assert.deepEqual(fedValue({...base, bias: -9, slots: 3}).bias, -6);
    // The coast side has its own, smaller limit.
    assert.deepEqual(fedValue({...base, maxCoastBias: 9, bias: -12, previousBias: -10}).bias, -9);
    assert.deepEqual(fedValue({...base, real: 10, maxCoastBias: 9, bias: 12, previousBias: 10}).bias, 12);
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
            assert.ok(plan.biases.every((b) => b <= limits.maxBias && b >= -limits.maxCoastBias));
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

test('a replan starts where the pump is, so a coast survives replanning', () => {
    const limits = limitsFor(PRESETS.save_most);
    assert.deepEqual(startingPoint(-9, 6, limits), [-7, -5, -3, -1, 0, 0]);
    assert.deepEqual(startingPoint(-9, 4, limits, [-12, -14, -10, 0]), [-11, -13, -11, -9]);
    const start = steadyState(RADIATOR_HOUSE, 21, 2);
    const coasting = {...start, bias: -10};
    const plan = planShift(RADIATOR_HOUSE, 21, coasting, peaked.slice(66), limits, {}, new Array(30).fill(-10));
    assert.ok(Math.abs(plan.biases[0] - -10) <= 2, `jumped to ${plan.biases[0]}`);
});

test('warmth above doing nothing earns nothing, colder is owed per degree-hour', () => {
    const house = RADIATOR_HOUSE;
    const reference = simulate(house, 21, steadyState(house, 21, 2), day.slice(0, 8), new Array(8).fill(0));
    const warmer = {...reference, ti: reference.ti.map((t) => t + 1), tm: reference.tm.map((t) => t + 1)};
    const colder = {...reference, ti: reference.ti.map((t) => t - 1), tm: reference.tm};
    assert.equal(owedHeat(house, warmer, reference), 0);
    assert.ok(Math.abs(owedHeat(house, colder, reference) - (house.heatLoss * 0.25 * 8 + house.ci)) < 1e-9);
});

test('a weaker lever moves less heat for the same bias', () => {
    const start = steadyState(RADIATOR_HOUSE, 21, 2);
    const bias = new Array(16).fill(-10);
    const heat = (lever?: number) => simulate(RADIATOR_HOUSE, 21, start, day.slice(0, 16), bias, {lever})
        .heat.reduce((a, b) => a + b, 0);
    const full = simulate(RADIATOR_HOUSE, 21, start, day.slice(0, 16), new Array(16).fill(0)).heat.reduce((a, b) => a + b, 0);
    assert.ok(full - heat(0.45 * RADIATOR_HOUSE.heatLoss) < full - heat());
});

test('the lever is heat per K of calculated supply above indoor, times the supply gain', () => {
    const hours = Array.from({length: 14}, (_, i) => ({tcalc: 35 + i, ti: 22, heatKw: 0.26 * (13 + i)}));
    assert.ok(Math.abs(estimateLever(hours, 0.5)! - 0.13) < 1e-9);
    assert.equal(estimateLever(hours.slice(0, 5), 0.5), undefined);
});

/** One October day from midnight UTC at a flat price: 2 °C, clear, sun on the walls. */
const sunnyDay: ForecastSlot[] = Array.from({length: 96}, (_, k) => ({te: 2, price: 2, ...simSun(SIM_START_SLOT + k, 1)}));
const overshoot = (ti: number[], comfort: number) => ti.reduce((a, t) => a + Math.max(0, t - comfort) * 0.25, 0);
const rms = (ti: number[], comfort: number) => Math.sqrt(ti.reduce((a, t) => a + (t - comfort) ** 2, 0) / ti.length);
const shortfall = (ti: number[], comfort: number) => ti.reduce((a, t) => a + Math.max(0, comfort - t) * 0.25, 0);

test('ahead of sun it eases off: less heat, less overshoot, at a flat price', () => {
    for (const house of [RADIATOR_HOUSE, WEST_HOUSE]) {
        const plan = planShift(house, 21, steadyState(house, 21, 2), sunnyDay, limitsFor(PRESETS.save_some), {lever: 0.45 * house.heatLoss});
        assert.ok(plan.biases.some((b) => b < 0), 'no coast');
        assert.ok(plan.plan.cost < plan.baseline.cost);
        assert.ok(overshoot(plan.plan.ti, 21) < overshoot(plan.baseline.ti, 21));
        // Steadier overall: the dip ahead of the sun is smaller than the overshoot it saves.
        assert.ok(rms(plan.plan.ti, 21) < 0.6 * rms(plan.baseline.ti, 21), `${rms(plan.plan.ti, 21)} vs ${rms(plan.baseline.ti, 21)}`);
        assert.ok(Math.min(...plan.plan.ti) > 21 - limitsFor(PRESETS.save_some).lower);
    }
    // The west house's sun is in the afternoon, so its coast is later than the even house's.
    const firstCoast = (house: typeof RADIATOR_HOUSE) => planShift(house, 21, steadyState(house, 21, 2), sunnyDay,
        limitsFor(PRESETS.save_some), {lever: 0.45 * house.heatLoss}).biases.findIndex((b) => b <= -6);
    assert.ok(firstCoast(WEST_HOUSE) > firstCoast(RADIATOR_HOUSE), `${firstCoast(WEST_HOUSE)} vs ${firstCoast(RADIATOR_HOUSE)}`);
});

test('ahead of a cold front, a profile that values comfort warms early; one that values money need not', () => {
    const front: ForecastSlot[] = Array.from({length: 96}, (_, k) => ({te: k < 40 ? 5 : -10, sun: 0, price: 2}));
    const start = steadyState(SLAB_HOUSE, 21, 5);
    const comfortable = planShift(SLAB_HOUSE, 21, start, front, limitsFor(PRESETS.comfortable));
    assert.ok(comfortable.biases.slice(0, 40).some((b) => b > 0), 'no pre-heat');
    assert.ok(shortfall(comfortable.plan.ti, 21) < shortfall(comfortable.baseline.ti, 21));
    const most = planShift(SLAB_HOUSE, 21, start, front, limitsFor(PRESETS.save_most));
    assert.ok(most.plan.cost <= comfortable.plan.cost + 1e-9);
});

test('comfort is the setpoint, and the end owes the steady mass at the last outdoor temperature', () => {
    const ref = comfortReference(RADIATOR_HOUSE, 21, [{te: 5, sun: 0, price: 1}, {te: -5, sun: 0, price: 1}]);
    assert.deepEqual(ref.ti, [21, 21]);
    assert.equal(ref.tm[1], steadyState(RADIATOR_HOUSE, 21, -5).tm);
});
