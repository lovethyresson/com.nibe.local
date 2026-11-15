import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BUDGET_MS, DP_PRESET, houseStepper, optimise, shadowOptimise, shiftLevels} from '../lib/autopilot/optimiser';
import {ForecastSlot, planShift, steadyState} from '../lib/autopilot/planner';
import {stepHouse} from '../lib/autopilot/model';
import {PRESETS, limitsFor} from '../lib/autopilot/presets';
import {RADIATOR_HOUSE, SLAB_HOUSE} from './autopilot-house-sim';

const peaked: ForecastSlot[] = Array.from({length: 96}, (_, k) => ({te: 2, sun: 0, price: k >= 66 && k < 78 ? 3 : 1}));
const sync = {defer: async () => {}};

test('the precomputed step is the house model\'s exact step', () => {
    for (const house of [RADIATOR_HOUSE, SLAB_HOUSE]) {
        const step = houseStepper(house);
        const [ti, tm] = step(20.5, 22, -3, 0.6, 0.15);
        const [eti, etm] = stepHouse(house, 20.5, 22, {te: -3, q: 0.6, sun: 0.15 / house.sun, sunE: 0, sunW: 0});
        assert.ok(Math.abs(ti - eti) < 1e-9 && Math.abs(tm - etm) < 1e-9);
    }
    const levels = shiftLevels(limitsFor(PRESETS.save_most));
    assert.equal(levels.length, 7);
    assert.ok(levels.includes(0) && levels[0] < 0 && levels[6] > 0);
});

test('matches the planner on a simple case: nothing at a flat price, a coast through the peak', async () => {
    for (const house of [RADIATOR_HOUSE, SLAB_HOUSE]) {
        const start = steadyState(house, 21, 2);
        for (const id of ['comfortable', 'save_some', 'save_most'] as const) {
            const limits = limitsFor(PRESETS[id]);
            const flat = await optimise({house, comfort: 21, state: start, forecast: peaked.map((s) => ({...s, price: 1})), limits}, sync);
            assert.equal(flat.fallback, undefined);
            assert.ok(flat.shift.every((s) => s === 0), `${id}: shifted at a flat price`);
            assert.deepEqual(flat.shift, flat.planner.shift);

            const r = await optimise({house, comfort: 21, state: start, forecast: peaked, limits}, sync);
            const inPeak = r.shift.slice(66, 78);
            const plannerPeak = r.planner.shift.slice(66, 78);
            assert.ok(inPeak.every((b) => b <= 0) && inPeak.some((b) => b < 0), `${id}: no coast through the peak`);
            assert.ok(plannerPeak.some((b) => b < 0), 'and the planner coasts there too');
            // Both save against doing nothing; the DP within a few percent of the planner or better.
            assert.ok(r.fairCost < r.baselineFairCost && r.plannerFairCost < r.baselineFairCost);
            assert.ok(r.fairCost <= r.plannerFairCost * 1.02, `${id}: DP ${r.fairCost} vs planner ${r.plannerFairCost}`);
        }
    }
});

test('respects the comfort bounds', async () => {
    // A brutal evening peak: worth coasting through as deep as the band allows, never past it.
    const brutal = peaked.map((s, k) => ({...s, price: k >= 60 && k < 84 ? 20 : 1}));
    for (const house of [RADIATOR_HOUSE, SLAB_HOUSE]) {
        const start = steadyState(house, 21, 2);
        for (const id of ['comfortable', 'save_some', 'save_most'] as const) {
            const limits = limitsFor(PRESETS[id]);
            const r = await optimise({house, comfort: 21, state: start, forecast: brutal, limits}, sync);
            const lo = 21 - limits.lower, hi = 21 + limits.upper;
            r.plan.ti.forEach((t, k) => {
                assert.ok(t >= Math.min(lo, r.planner.baseline.ti[k]) - 0.15, `${id} slot ${k}: ${t} below the band`);
                assert.ok(t <= Math.max(hi, r.planner.baseline.ti[k]) + 0.15, `${id} slot ${k}: ${t} above the band`);
            });
            assert.ok(r.shift.every((s) => s <= limits.maxBias + 1e-9 && s >= -limits.maxCoastBias - 1e-9));
        }
    }
});

test('falls back to the planner when the solve runs out of time or throws', async () => {
    const house = RADIATOR_HOUSE;
    const start = steadyState(house, 21, 2);
    const limits = limitsFor(PRESETS.save_some);
    // A clock that jumps 2 s every time it is read: the budget runs out a few steps in.
    let t = 0;
    const slow = await optimise({house, comfort: 21, state: start, forecast: peaked, limits},
        {...sync, now: () => (t += 2000)});
    assert.equal(slow.fallback, 'timeout');
    assert.deepEqual(slow.biases, slow.planner.biases);
    assert.equal(slow.fairCost, slow.plannerFairCost);
    assert.equal(BUDGET_MS, 5000);

    let reads = 0;
    const broken = await optimise({house, comfort: 21, state: start, forecast: peaked, limits},
        {defer: async () => { if (++reads === 3) throw new Error('boom'); }});
    assert.equal(broken.fallback, 'error');
    assert.equal(broken.error, 'boom');
    assert.deepEqual(broken.biases, broken.planner.biases);
});

test('it yields between time steps, so the app stays responsive', async () => {
    let yields = 0;
    const r = await optimise({house: SLAB_HOUSE, comfort: 21, state: steadyState(SLAB_HOUSE, 21, 2), forecast: peaked,
        limits: limitsFor(PRESETS.save_some)}, {defer: () => { yields++; return new Promise((resolve) => setImmediate(resolve)); }});
    assert.equal(r.fallback, undefined);
    assert.equal(yields, peaked.length);
    assert.ok(r.ms < BUDGET_MS);
});

test('in shadow it plans the default preset from the preset\'s own state and logs both predicted costs', async () => {
    const house = RADIATOR_HOUSE;
    const start = steadyState(house, 21, 2);
    const entry = await shadowOptimise({house, ti: start.ti, tm: start.tm, comfort: 21, forecast: peaked, curveNow: start.curve,
        memory: {bias: 0, curve: start.curve, plan: []}}, sync);
    assert.equal(entry.preset, DP_PRESET);
    assert.equal(entry.fallback, undefined);
    assert.equal(entry.ahead.length, 2);
    assert.ok(entry.cost <= entry.planner * 1.02 && entry.planner < entry.baseline, JSON.stringify(entry));
    // The planner it compares with is the shadow's own plan for that preset.
    const own = planShift(house, 21, {...start, bias: 0}, peaked, limitsFor(PRESETS[DP_PRESET]));
    assert.ok(Math.abs(entry.planner - own.fairCost) < 1e-3);
});
