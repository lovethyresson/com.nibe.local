/** The predictive optimiser: dynamic programming over the house's air and mass. Shadow only: its
 *  plan is logged beside the planner's, never fed. Design: docs/autopilot-plan.md §13.
 *
 *  The planner (planner.ts) moves the bias 1 K at a time where it pays most, on a linear picture
 *  of the house. That is fast and close, but greedy: it can't see that a deep coast now is worth
 *  less than two shallow ones once the COP is convex, or that the band binds three hours on. The
 *  DP solves the whole horizon instead, over a grid of indoor and mass temperatures, so its
 *  plan says how much the greedy search leaves on the table (the ship gate in §13).
 *
 *  - State: air `ti` (30 points over the band), mass `tm` (40 points), and the shift level in
 *    force (one of 7, from the deepest coast to the largest pre-heat). The level is state so the
 *    ramp term and the curve's lag can be priced: the curve sees a slot's feed through its 49 min
 *    filter (§4.5), taken here as the previous level blended with the new one.
 *  - Moves: hold the level or step to a neighbour each slot.
 *  - Cost per slot: price × electricity, at the learned COP once trusted (cop.ts); the planner's
 *    owed heat for each degree-hour below comfort (so both chase the same objective); a steep
 *    quadratic outside the band (§13's w_low and w_high); a small cost per level changed
 *    (w_ramp); and at the end the stored heat short of comfort, as the planner counts it.
 *  - The plan found is re-simulated through the planner's exact model (`simulate`) and scored
 *    with its `fairCost`, so the two predicted costs in the shadow log are measured alike.
 *
 *  It yields between time steps (`setImmediate` by default) and gives up after 5 s, returning
 *  the planner's plan. Pure apart from that clock. */
import {HouseParams, solarGain} from './model';
import {DEFAULT_PRESET, Limits, PRESETS, PresetId, limitsFor} from './presets';
import type {PresetMemory} from './shadow';
import {
    ForecastSlot, Plan, PlanState, PumpCurve, Simulation, buyBackCop, comfortReference, fairCost, marginals, planShift,
    pumpHeat, simulate, slotCop,
} from './planner';
import {CURVE_TAU_H, RAMP_K_PER_SLOT} from './actuator';
import {comfortBias} from './trim';

const SLOT_H = 0.25;
export const TI_POINTS = 40;
export const TM_POINTS = 40;
/** Slots per decision: an hour. */
export const STEP_SLOTS = 4;
export const LEVELS = 7;
/** Points over what the curve sees, beyond the real outdoor temperature. */
export const D_POINTS = 12;
export const BUDGET_MS = 5000;
/** Share of a new feed the curve has taken in after one slot (§4.5). */
const CURVE_ALPHA = 1 - Math.exp(-SLOT_H / CURVE_TAU_H);
/** Per K² per slot outside the band, as a multiple of the horizon's mean price: steep enough to
 *  act as the band's wall, smooth enough for the grid. */
const W_BAND = 20;
/** Per level changed, as a multiple of the mean price: breaks ties toward a steady feed. */
const W_RAMP = 0.002;

export interface OptimiserInput {
    house: HouseParams;
    comfort: number;
    state: PlanState;
    forecast: ForecastSlot[];
    limits: Limits;
    pump?: PumpCurve;
    /** The planner's previous plan, its warm start: the fallback plans exactly as it would. */
    previous?: number[];
}

export interface OptimiserOptions {
    budgetMs?: number;
    now?: () => number;
    /** Yields between time steps; `setImmediate` in the app. */
    defer?: () => Promise<void>;
    /** Shift levels each side of 0 (bench experiments); 3 by default. */
    perSide?: number;
}

export interface OptimiserResult {
    /** What the DP would feed as bias, slot by slot (the planner's when it fell back). */
    biases: number[];
    shift: number[];
    plan: Simulation;
    /** Cost at equal comfort of the DP's plan, the planner's, and doing nothing (planner.ts `fairCost`). */
    fairCost: number;
    plannerFairCost: number;
    baselineFairCost: number;
    /** The planner's plan, for the comparison and as the fallback. */
    planner: Plan;
    ms: number;
    fallback?: 'timeout' | 'error';
    error?: string;
}

const defaultDefer = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The house's exact step as a linear map, precomputed once: the matrix exponential depends only
 *  on the parameters, so a step is two 2×2 products (model.ts `stepHouse`, without its per-call
 *  expm). */
export function houseStepper(p: HouseParams): (ti: number, tm: number, te: number, q: number, sun: number) => [number, number] {
    const {inputs, step} = houseLinear(p);
    return (ti, tm, te, q, sun) => {
        const [b1, b2] = inputs(te, q, sun);
        return step(ti, tm, b1, b2);
    };
}

/** The step split in two: the slot's inputs as `b`, then the linear map, so a solve can work out
 *  `b` once for every air and mass point that shares it. */
export function houseLinear(p: HouseParams): {inputs: (te: number, q: number, sun: number) => [number, number];
    step: (ti: number, tm: number, b1: number, b2: number) => [number, number];
    /** [e11, e12, e21, e22, g11, g12, g21, g22]: next = E·[ti, tm] + G·b. */
    coefficients: number[]} {
    const a11 = -(1 / p.rim + p.heatLoss) / p.ci, a12 = 1 / (p.rim * p.ci);
    const a21 = 1 / (p.rim * p.cm), a22 = -1 / (p.rim * p.cm);
    const s = (a11 + a22) / 2;
    const d = Math.sqrt(Math.max(0, ((a11 - a22) / 2) ** 2 + a12 * a21));
    const es = Math.exp(s * SLOT_H);
    const ch = Math.cosh(d * SLOT_H);
    const sh = d > 1e-12 ? Math.sinh(d * SLOT_H) / d : SLOT_H;
    const e11 = es * (ch + sh * (a11 - s)), e12 = es * sh * a12;
    const e21 = es * sh * a21, e22 = es * (ch + sh * (a22 - s));
    const det = a11 * a22 - a12 * a21;
    // Γ = A⁻¹(E − I), applied to b = [b1, b2].
    const m11 = e11 - 1, m12 = e12, m21 = e21, m22 = e22 - 1;
    const g11 = (a22 * m11 - a12 * m21) / det, g12 = (a22 * m12 - a12 * m22) / det;
    const g21 = (-a21 * m11 + a11 * m21) / det, g22 = (-a21 * m12 + a11 * m22) / det;
    return {
        inputs: (te, q, sun) => {
            const P = q / SLOT_H;
            return [(p.heatLoss * te + (1 - p.f) * P + sun + p.gains) / p.ci, p.f * P / p.cm];
        },
        step: (ti, tm, b1, b2) => [e11 * ti + e12 * tm + g11 * b1 + g12 * b2, e21 * ti + e22 * tm + g21 * b1 + g22 * b2],
        coefficients: [e11, e12, e21, e22, g11, g12, g21, g22],
    };
}

/** The shift levels: the deepest coast to the largest pre-heat, 0 among them. */
export function shiftLevels(limits: Limits, perSide = (LEVELS - 1) / 2): number[] {
    const side = (max: number) => Array.from({length: perSide}, (_, i) => max * (i + 1) / perSide);
    return [...side(limits.maxCoastBias).reverse().map((v) => -v), 0, ...side(limits.maxBias)];
}

const grid = (lo: number, hi: number, n: number) => Array.from({length: n}, (_, i) => lo + (hi - lo) * i / (n - 1));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export async function optimise(input: OptimiserInput, options: OptimiserOptions = {}): Promise<OptimiserResult> {
    const now = options.now ?? Date.now;
    const started = now();
    const budget = options.budgetMs ?? BUDGET_MS;
    const defer = options.defer ?? defaultDefer;
    const pump = input.pump ?? {};
    const planner = planShift(input.house, input.comfort, input.state, input.forecast, input.limits, pump, input.previous);
    const fallback = (why: 'timeout' | 'error', error?: string): OptimiserResult => ({
        biases: planner.biases, shift: planner.shift, plan: planner.plan, fairCost: planner.fairCost,
        plannerFairCost: planner.fairCost, baselineFairCost: planner.baselineFairCost, planner, ms: now() - started,
        fallback: why, ...(error ? {error} : {}),
    });
    try {
        const solved = await solve(input, pump, planner, {now, started, budget, defer, perSide: options.perSide});
        return solved ?? fallback('timeout');
    } catch (error) {
        return fallback('error', (error as Error)?.message ?? String(error));
    }
}

async function solve(input: OptimiserInput, pump: PumpCurve, planner: Plan,
                     clock: {now: () => number; started: number; budget: number; defer: () => Promise<void>; perSide?: number}): Promise<OptimiserResult | undefined> {
    const {house, comfort, state, forecast, limits} = input;
    const n = forecast.length;
    const levels = limits.maxBias === 0 && limits.maxCoastBias === 0 ? [0] : shiftLevels(limits, clock.perSide);
    const A = levels.length;
    const held = forecast.map((s) => comfortBias(house, pump, comfort, s.te));
    const baseline = planner.baseline;
    const prices = forecast.map((s) => s.price);
    const meanPrice = mean(prices);
    const reference = comfortReference(house, comfort, forecast);
    const cop = buyBackCop(baseline, marginals(pump, baseline, forecast));
    const owedRate = limits.comfortWeight * meanPrice / cop;
    const lo = baseline.ti.map((t) => Math.min(t, comfort - limits.lower));
    const hi = baseline.ti.map((t) => Math.max(t, comfort + limits.upper));
    const wBand = W_BAND * meanPrice;
    const wRamp = W_RAMP * meanPrice;

    const tiGrid = grid(Math.min(...lo, state.ti) - 0.5, Math.max(...hi, state.ti) + 0.5, TI_POINTS);
    const tmLo = Math.min(...baseline.tm, state.tm) - limits.lower - 1;
    const tmHi = Math.max(...baseline.tm, state.tm) + limits.upper + 1;
    const tmGrid = grid(tmLo, tmHi, TM_POINTS);
    // What the curve sees, as the real outdoor temperature minus its view: d' = (1 − α)(d + Δte) + α·bias,
    // exactly the curve's filter (actuator.ts `curveInput`) the planner's `simulate` runs. Before
    // the first slot it is te₀ − the curve's view now.
    const d0 = forecast[0].te - state.curve;
    const biasLo = Math.min(...held) - limits.maxCoastBias;
    const biasHi = Math.max(...held) + limits.maxBias;
    const dGrid = grid(Math.min(biasLo, d0) - 1, Math.max(biasHi, d0) + 1, D_POINTS);
    const tiStep = tiGrid[1] - tiGrid[0];
    const tmStep = tmGrid[1] - tmGrid[0];
    const dStep = dGrid[1] - dGrid[0];
    const plane = TI_POINTS * TM_POINTS;
    const states = plane * D_POINTS;
    const at = (i: number, j: number, c: number) => c * plane + j * TI_POINTS + i;
    const linear = houseLinear(house);
    // Heat follows indoor only when the pump is modelled on it (planner.ts `pumpHeat`); otherwise a
    // slot's heat, electricity and house inputs are shared by every air and mass point.
    const byIndoor = !!(pump.supply && pump.heatPerSupplyK !== undefined && !pump.shiftOnly);
    const dTe = forecast.map((s, k) => (k === 0 ? 0 : s.te - forecast[k - 1].te));

    /** Value at a continuous (ti, tm, d), trilinear, clamped to the grid. */
    const value = (V: Float32Array, ti: number, tm: number, d: number) => {
        const x = Math.min(TI_POINTS - 1.000001, Math.max(0, (ti - tiGrid[0]) / tiStep));
        const y = Math.min(TM_POINTS - 1.000001, Math.max(0, (tm - tmGrid[0]) / tmStep));
        const z = Math.min(D_POINTS - 1.000001, Math.max(0, (d - dGrid[0]) / dStep));
        const i = Math.floor(x), j = Math.floor(y), c = Math.floor(z);
        const u = x - i, v = y - j, w = z - c;
        const b0 = at(i, j, c), b1 = b0 + plane;
        const layer = (b: number) => (1 - u) * (1 - v) * V[b] + u * (1 - v) * V[b + 1]
            + (1 - u) * v * V[b + TI_POINTS] + u * v * V[b + TI_POINTS + 1];
        return (1 - w) * layer(b0) + w * layer(b1);
    };

    /** One slot of the DP's model: the feed's effect on what the curve sees, heat, electricity and
     *  the next air and mass. Heat depends on air only when the pump is modelled on it, so the rest
     *  is shared across the air and mass grid. */
    const pumpStep = (k: number, d: number, a: number, fed?: number) => {
        const slot = forecast[k];
        const bias = fed ?? held[k] + levels[a];
        const d2 = (1 - CURVE_ALPHA) * (d + dTe[k]) + CURVE_ALPHA * bias;
        const curve = slot.te - d2;
        return {d: d2, curve, ramp: wRamp * Math.abs(bias - d)};
    };
    /** The slot's electricity cost and house inputs for a feed the curve sees as `curve`. */
    const slotInputs = (k: number, curve: number, ti: number) => {
        const slot = forecast[k];
        const heat = slot.busy ? 0 : pumpHeat(house, comfort, slot.te, curve, pump, ti);
        const electricity = heat / slotCop(pump, curve, slot.te).cop;
        const sun = solarGain(house, {te: slot.te, q: heat, sun: slot.sun, sunE: slot.sunE, sunW: slot.sunW});
        const [b1, b2] = linear.inputs(slot.te, heat, sun);
        return {paid: slot.price * electricity, b1, b2};
    };
    const houseStep = (k: number, ti: number, tm: number, u: {paid: number; b1: number; b2: number}) => {
        const [ti2, tm2] = linear.step(ti, tm, u.b1, u.b2);
        const below = Math.max(0, lo[k] - ti2), above = Math.max(0, ti2 - hi[k]);
        const cost = u.paid
            + owedRate * house.heatLoss * SLOT_H * Math.max(0, comfort - ti2)
            + wBand * (below * below + above * above);
        return {cost, ti: ti2, tm: tm2};
    };

    // Decisions every STEP_SLOTS slots, each simulated slot by slot. At one decision a slot, a
    // slot's feed moves indoor ~0.02 K, an order of magnitude under the grid's spacing, and the
    // interpolation's own error decided the plan: on a real day its plan cost more than the greedy
    // planner's on the DP's own objective. An hour's move is large enough for the grid to see.
    const decisions = Math.ceil(n / STEP_SLOTS);
    /** A decision's slots from what the curve sees `d`, feeding level `a`: each slot's paid
     *  electricity and house inputs, the ramp cost, and what the curve sees after. */
    const pumpRun = (t: number, d: number, a: number, ti?: number, from?: number) => {
        const slots: {k: number; paid: number; b1: number; b2: number; bias: number}[] = [];
        let ramp = 0;
        let bias = from;
        for (let k = t * STEP_SLOTS; k < Math.min(n, (t + 1) * STEP_SLOTS); k++) {
            // With the bias in force known (the forward pass), the feed ramps toward the level as
            // the actuator will send it (actuator.ts `fedValue`, RAMP_K_PER_SLOT).
            if (bias !== undefined) {
                const want = held[k] + levels[a];
                bias = Math.max(bias - RAMP_K_PER_SLOT, Math.min(bias + RAMP_K_PER_SLOT, want));
            }
            const p = pumpStep(k, d, a, bias);
            ramp += p.ramp;
            d = p.d;
            slots.push({k, ...slotInputs(k, p.curve, ti ?? NaN), bias: bias ?? held[k] + levels[a]});
        }
        return {slots, ramp, d};
    };

    // Terminal: stored heat short of comfort's steady state, bought back like owed heat.
    const values: Float32Array[] = new Array(decisions + 1);
    values[decisions] = new Float32Array(states);
    for (let c = 0; c < D_POINTS; c++) for (let j = 0; j < TM_POINTS; j++) for (let i = 0; i < TI_POINTS; i++) {
        const short = house.ci * (reference.ti[n - 1] - tiGrid[i]) + house.cm * (reference.tm[n - 1] - tmGrid[j]);
        values[decisions][at(i, j, c)] = owedRate * Math.max(0, short);
    }
    const [e11, e12, e21, e22, g11, g12, g21, g22] = linear.coefficients;
    const owedPerK = owedRate * house.heatLoss * SLOT_H;
    for (let t = decisions - 1; t >= 0; t--) {
        const next = values[t + 1];
        const V = new Float32Array(states).fill(Infinity);
        for (let c = 0; c < D_POINTS; c++) {
            for (let a = 0; a < A; a++) {
                const shared = byIndoor ? undefined : pumpRun(t, dGrid[c], a);
                const end = shared ?? pumpRun(t, dGrid[c], a, comfort);
                // What the curve sees after the decision is the same for every air and mass point.
                const z = Math.min(D_POINTS - 1.000001, Math.max(0, (end.d - dGrid[0]) / dStep));
                const cz = Math.floor(z), w = z - cz;
                const l0 = cz * plane, l1 = l0 + plane;
                for (let j = 0; j < TM_POINTS; j++) {
                    for (let i = 0; i < TI_POINTS; i++) {
                        let ti = tiGrid[i], tm = tmGrid[j];
                        const run = shared ?? pumpRun(t, dGrid[c], a, ti);
                        let total = run.ramp;
                        for (const u of run.slots) {
                            const ti2 = e11 * ti + e12 * tm + g11 * u.b1 + g12 * u.b2;
                            tm = e21 * ti + e22 * tm + g21 * u.b1 + g22 * u.b2;
                            ti = ti2;
                            const below = ti < lo[u.k] ? lo[u.k] - ti : 0, above = ti > hi[u.k] ? ti - hi[u.k] : 0;
                            total += u.paid + wBand * (below * below + above * above) + (ti < comfort ? owedPerK * (comfort - ti) : 0);
                        }
                        let x = (ti - tiGrid[0]) / tiStep, y = (tm - tmGrid[0]) / tmStep;
                        x = x < 0 ? 0 : x > TI_POINTS - 1.000001 ? TI_POINTS - 1.000001 : x;
                        y = y < 0 ? 0 : y > TM_POINTS - 1.000001 ? TM_POINTS - 1.000001 : y;
                        const xi = x | 0, yj = y | 0, fx = x - xi, fy = y - yj;
                        const o = yj * TI_POINTS + xi;
                        const q00 = (1 - fx) * (1 - fy), q10 = fx * (1 - fy), q01 = (1 - fx) * fy, q11 = fx * fy;
                        const v0 = q00 * next[l0 + o] + q10 * next[l0 + o + 1] + q01 * next[l0 + o + TI_POINTS] + q11 * next[l0 + o + TI_POINTS + 1];
                        const v1 = q00 * next[l1 + o] + q10 * next[l1 + o + 1] + q01 * next[l1 + o + TI_POINTS] + q11 * next[l1 + o + TI_POINTS + 1];
                        total += (1 - w) * v0 + w * v1;
                        const s = c * plane + j * TI_POINTS + i;
                        if (total < V[s]) V[s] = total;
                    }
                }
            }
        }
        values[t] = V;
        if (clock.now() - clock.started > clock.budget) return undefined;
        await clock.defer();
        if (clock.now() - clock.started > clock.budget) return undefined;
    }

    // Forward from where the house, the curve and the feed really are, choosing each decision
    // against the stored values (one decision of lookahead), so the plan is not tied to the grid's
    // points. Each candidate is ramped from the bias in force, as the actuator will send it: the
    // values above assume a level is reached at once, and a plan fed through the 2 K a slot ramp
    // without this lost 1.4 points against the greedy planner on real days (dev/evaluate-cop.mjs).
    const biases: number[] = [];
    let ti = state.ti, tm = state.tm, d = d0, fed = state.bias;
    for (let t = 0; t < decisions; t++) {
        let best = Infinity;
        let pick: {d: number; ti: number; tm: number; fed: number[]} | undefined;
        for (let a = 0; a < A; a++) {
            const run = pumpRun(t, d, a, ti, fed);
            let x = ti, y = tm, total = run.ramp;
            for (const u of run.slots) {
                const t2 = houseStep(u.k, x, y, u);
                total += t2.cost;
                x = t2.ti; y = t2.tm;
            }
            total += value(values[t + 1], x, y, run.d);
            if (total < best) { best = total; pick = {d: run.d, ti: x, tm: y, fed: run.slots.map((u) => u.bias)}; }
        }
        biases.push(...pick!.fed);
        ({d, ti, tm} = pick!);
        fed = pick!.fed[pick!.fed.length - 1];
    }
    const shift = biases.map((b, k) => b - held[k]);
    const plan = simulate(house, comfort, state, forecast, biases, pump);
    const fair = fairCost(house, plan, reference, meanPrice, limits.comfortWeight, cop);
    const done = {plannerFairCost: planner.fairCost, baselineFairCost: planner.baselineFairCost, planner, ms: clock.now() - clock.started};
    // The grid's own error can find a "saving" the exact model doesn't confirm (a few K of coast at
    // a flat price): as in the planner, a plan that doesn't beat doing nothing is doing nothing.
    if (fair >= planner.baselineFairCost)
        return {biases: held, shift: new Array(n).fill(0), plan: baseline, fairCost: planner.baselineFairCost, ...done};
    return {biases, shift, plan, fairCost: fair, ...done};
}

function nearest(levels: number[], value: number): number {
    let best = 0;
    for (let l = 1; l < levels.length; l++) if (Math.abs(levels[l] - value) < Math.abs(levels[best] - value)) best = l;
    return best;
}

// ---- shadow ----

/** The preset the DP runs beside in shadow: one is enough to compare, and the default is the
 *  one most owners run. */
export const DP_PRESET: PresetId = DEFAULT_PRESET;

/** One shadow log entry: the DP's next feed and what it and the planner predict the horizon costs. */
export interface DpEntry {
    preset: PresetId;
    /** The DP's bias and shift for the next slot, K. Never fed. */
    bias: number;
    shift: number;
    /** Indoor its plan expects 1 h and 6 h ahead. */
    ahead: number[];
    /** Predicted cost at equal comfort over the horizon: the DP's, the planner's and doing nothing's. */
    cost: number;
    planner: number;
    baseline: number;
    ms: number;
    fallback?: 'timeout' | 'error';
    error?: string;
}

export interface ShadowDpInput {
    house: HouseParams;
    pump?: PumpCurve;
    ti: number;
    tm: number;
    comfort: number;
    /** From the next slot on, sun not yet discounted. */
    forecast: ForecastSlot[];
    /** The preset's memory before this slot's shadow step (shadow.ts), so the planner the DP is
     *  compared with plans exactly as the shadow's preset just did. */
    memory?: PresetMemory;
    /** The curve's view of input 1 now, for a preset with no memory yet. */
    curveNow: number;
    slots?: number;
}

const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/** The DP for the shadow's preset, from the same state and forecast the preset planned from. */
export async function shadowOptimise(input: ShadowDpInput, options: OptimiserOptions = {}): Promise<DpEntry> {
    const limits = limitsFor(PRESETS[DP_PRESET]);
    const trust = limits.forecastTrust;
    const forecast = input.forecast.map((s) => ({...s, sun: s.sun * trust, sunE: (s.sunE ?? 0) * trust, sunW: (s.sunW ?? 0) * trust}));
    const memory = input.memory ?? {bias: 0, curve: input.curveNow, plan: []};
    const steps = Math.max(1, input.slots ?? 1);
    const r = await optimise({house: input.house, comfort: input.comfort, state: {ti: input.ti, tm: input.tm, curve: memory.curve,
        bias: memory.bias}, forecast, limits, pump: input.pump, previous: memory.plan.slice(steps - 1)}, options);
    return {
        preset: DP_PRESET, bias: round(r.biases[0], 1), shift: round(r.shift[0], 1),
        ahead: [4, 24].map((k) => round(r.plan.ti[k - 1] ?? NaN, 2)),
        cost: round(r.fairCost), planner: round(r.plannerFairCost), baseline: round(r.baselineFairCost), ms: r.ms,
        ...(r.fallback ? {fallback: r.fallback} : {}), ...(r.error ? {error: r.error} : {}),
    };
}
