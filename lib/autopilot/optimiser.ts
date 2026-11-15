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
import {CURVE_TAU_H} from './actuator';
import {comfortBias} from './trim';

const SLOT_H = 0.25;
export const TI_POINTS = 30;
export const TM_POINTS = 40;
export const LEVELS = 7;
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
    return (ti, tm, te, q, sun) => {
        const P = q / SLOT_H;
        const b1 = (p.heatLoss * te + (1 - p.f) * P + sun + p.gains) / p.ci;
        const b2 = p.f * P / p.cm;
        return [e11 * ti + e12 * tm + g11 * b1 + g12 * b2, e21 * ti + e22 * tm + g21 * b1 + g22 * b2];
    };
}

/** The shift levels: the deepest coast to the largest pre-heat, 0 among them. */
export function shiftLevels(limits: Limits): number[] {
    const down = limits.maxCoastBias;
    const up = limits.maxBias;
    return [-down, -2 * down / 3, -down / 3, 0, up / 3, 2 * up / 3, up];
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
        const solved = await solve(input, pump, planner, {now, started, budget, defer});
        return solved ?? fallback('timeout');
    } catch (error) {
        return fallback('error', (error as Error)?.message ?? String(error));
    }
}

async function solve(input: OptimiserInput, pump: PumpCurve, planner: Plan,
                     clock: {now: () => number; started: number; budget: number; defer: () => Promise<void>}): Promise<OptimiserResult | undefined> {
    const {house, comfort, state, forecast, limits} = input;
    const n = forecast.length;
    const levels = limits.maxBias === 0 && limits.maxCoastBias === 0 ? [0] : shiftLevels(limits);
    const L = levels.length;
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
    const tiStep = tiGrid[1] - tiGrid[0];
    const tmStep = tmGrid[1] - tmGrid[0];
    const states = TI_POINTS * TM_POINTS * L;
    const at = (i: number, j: number, l: number) => (l * TM_POINTS + j) * TI_POINTS + i;
    const step = houseStepper(house);
    const startLevel = nearest(levels, state.bias - held[0]);

    /** Value at a continuous (ti, tm), bilinear within level `l`, clamped to the grid. */
    const value = (V: Float64Array, ti: number, tm: number, l: number) => {
        const x = Math.min(TI_POINTS - 1.000001, Math.max(0, (ti - tiGrid[0]) / tiStep));
        const y = Math.min(TM_POINTS - 1.000001, Math.max(0, (tm - tmGrid[0]) / tmStep));
        const i = Math.floor(x), j = Math.floor(y);
        const u = x - i, v = y - j;
        const base = at(i, j, l);
        return (1 - u) * (1 - v) * V[base] + u * (1 - v) * V[base + 1]
            + (1 - u) * v * V[base + TI_POINTS] + u * v * V[base + TI_POINTS + 1];
    };

    /** One slot of the DP's model: heat, its electricity and the next air and mass. */
    const transition = (k: number, ti: number, tm: number, from: number, to: number) => {
        const slot = forecast[k];
        const shift = levels[from] + CURVE_ALPHA * (levels[to] - levels[from]);
        const curve = slot.te - held[k] - shift;
        const heat = slot.busy ? 0 : pumpHeat(house, comfort, slot.te, curve, pump, ti);
        const electricity = heat / slotCop(pump, curve, slot.te).cop;
        const sun = solarGain(house, {te: slot.te, q: heat, sun: slot.sun, sunE: slot.sunE, sunW: slot.sunW});
        const [ti2, tm2] = step(ti, tm, slot.te, heat, sun);
        const below = Math.max(0, lo[k] - ti2), above = Math.max(0, ti2 - hi[k]);
        const cost = slot.price * electricity
            + owedRate * house.heatLoss * SLOT_H * Math.max(0, comfort - ti2)
            + wBand * (below * below + above * above)
            + wRamp * Math.abs(levels[to] - levels[from]);
        return {cost, ti: ti2, tm: tm2};
    };

    // Terminal: stored heat short of comfort's steady state, bought back like owed heat.
    let V = new Float64Array(states);
    for (let l = 0; l < L; l++) for (let j = 0; j < TM_POINTS; j++) for (let i = 0; i < TI_POINTS; i++) {
        const short = house.ci * (reference.ti[n - 1] - tiGrid[i]) + house.cm * (reference.tm[n - 1] - tmGrid[j]);
        V[at(i, j, l)] = owedRate * Math.max(0, short);
    }
    const policy = new Int8Array(n * states);
    for (let k = n - 1; k >= 0; k--) {
        const next = V;
        V = new Float64Array(states);
        for (let l = 0; l < L; l++) {
            for (let j = 0; j < TM_POINTS; j++) for (let i = 0; i < TI_POINTS; i++) {
                let best = Infinity;
                let choice = l;
                for (let to = Math.max(0, l - 1); to <= Math.min(L - 1, l + 1); to++) {
                    const t = transition(k, tiGrid[i], tmGrid[j], l, to);
                    const total = t.cost + value(next, t.ti, t.tm, to);
                    if (total < best) { best = total; choice = to; }
                }
                V[at(i, j, l)] = best;
                policy[k * states + at(i, j, l)] = choice;
            }
        }
        if (clock.now() - clock.started > clock.budget) return undefined;
        await clock.defer();
        if (clock.now() - clock.started > clock.budget) return undefined;
    }

    // Forward: follow the policy from where the house is, at the nearest grid point.
    const shift: number[] = [];
    let ti = state.ti, tm = state.tm, l = startLevel;
    for (let k = 0; k < n; k++) {
        const i = Math.min(TI_POINTS - 1, Math.max(0, Math.round((ti - tiGrid[0]) / tiStep)));
        const j = Math.min(TM_POINTS - 1, Math.max(0, Math.round((tm - tmGrid[0]) / tmStep)));
        const to = policy[k * states + at(i, j, l)];
        const t = transition(k, ti, tm, l, to);
        ti = t.ti; tm = t.tm; l = to;
        shift.push(levels[to]);
    }
    const biases = shift.map((s, k) => s + held[k]);
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
