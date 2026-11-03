/** Planner v1: price shifting and weather feed-forward through the outdoor bias. Pure.
 *  Design: docs/smart-heating-plan.md §7.3.
 *
 *  It minimises the cost at equal comfort (`fairCost`) inside the profile's band, so a plan
 *  that saves only by running the house cooler is worth nothing to it: that is not price
 *  shifting (§11). Comfort is the setpoint, not what the curve would have done, so the same
 *  search also acts on the forecast: it eases off before sun that would overheat the house
 *  (free heat; warmth above comfort is worth nothing) and, at a profile that values comfort
 *  above its price, warms ahead of a cold front the curve would lag behind.
 *
 *  Assumptions to replace with measurements:
 *  - Doing nothing holds comfort: the curve delivers `H·(comfort − te) − gains` kW. A bias moves
 *    that through the curve's 49 min lag: with a learned curve (curve.ts) by `heatPerSupplyK`
 *    kW per K of supply it changes there, which follows the curve's slope where the feed lands
 *    (0.44 to 0.77 K per K on the S1155, §3.3); without one by `lever` kW per K of bias. A curve
 *    tuned to the house would make `lever = H`; on the S1155 it measured ~0.45·H.
 *  - Electricity = heat / COP with a constant COP. The COP model is M5. */
import {HouseParams, stepHouse} from './model';
import {Limits} from './presets';
import {CURVE_TAU_H, RAMP_K_PER_SLOT, curveInput} from './actuator';
import {SupplyCurve, supplyAt} from './curve';

export const COP = 3;
/** The pump's heat ceiling as the outdoor temperature its curve is designed for. */
export const DESIGN_OUTDOOR = -20;
const SLOT_H = 0.25;
const STEP_K = 1;

export interface ForecastSlot {
    te: number;
    /** Irradiance on the south, east and west walls, W/m² (model.ts `Inputs`). */
    sun: number;
    sunE?: number;
    sunW?: number;
    /** Price per kWh of electricity. */
    price: number;
}

export interface PlanState {
    ti: number;
    tm: number;
    /** The curve's filtered view of what was fed (§4.5). */
    curve: number;
    /** Bias applied last slot; the ramp starts here. */
    bias: number;
}

export interface Simulation {
    ti: number[];
    tm: number[];
    /** Heat delivered per slot, kWh. */
    heat: number[];
    cost: number;
    curveEnd: number;
}

export interface PumpCurve {
    /** kW of heat per K of bias, once the curve has caught up. Default: the house's heat loss. */
    lever?: number;
    /** The learned heat curve and kW of heat per K of supply; together they replace `lever`. */
    supply?: SupplyCurve;
    heatPerSupplyK?: number;
}

/** Heat this slot, kWh: what holds comfort at `te`, moved by the bias the curve has seen so far
 *  (`te − curve`), between off and the pump's design output. */
export function pumpHeat(house: HouseParams, comfort: number, te: number, curve: number, pump: PumpCurve = {}): number {
    const max = house.heatLoss * (comfort - DESIGN_OUTDOOR);
    const moved = pump.supply && pump.heatPerSupplyK !== undefined
        ? pump.heatPerSupplyK * (supplyAt(pump.supply, curve) - supplyAt(pump.supply, te))
        : (pump.lever ?? house.heatLoss) * (te - curve);
    const P = house.heatLoss * (comfort - te) - house.gains + moved;
    return Math.min(max, Math.max(0, P)) * SLOT_H;
}

export function simulate(house: HouseParams, comfort: number, state: PlanState, forecast: ForecastSlot[],
                         biases: number[], pump: PumpCurve = {}): Simulation {
    let {ti, tm, curve} = state;
    const out: Simulation = {ti: [], tm: [], heat: [], cost: 0, curveEnd: curve};
    forecast.forEach((slot, k) => {
        curve = curveInput(curve, slot.te - biases[k], SLOT_H, CURVE_TAU_H);
        const heat = pumpHeat(house, comfort, slot.te, curve, pump);
        [ti, tm] = stepHouse(house, ti, tm, {te: slot.te, q: heat, sun: slot.sun, sunE: slot.sunE, sunW: slot.sunW});
        out.ti.push(ti);
        out.tm.push(tm);
        out.heat.push(heat);
        out.cost += heat / COP * slot.price;
    });
    out.curveEnd = curve;
    return out;
}

/** Air and mass when the curve has held `comfort` at outdoor `te` for long. */
export function steadyState(house: HouseParams, comfort: number, te: number): PlanState {
    const P = pumpHeat(house, comfort, te, te) / SLOT_H;
    return {ti: comfort, tm: comfort + house.f * P * house.rim, curve: te, bias: 0};
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export interface Plan {
    biases: number[];
    plan: Simulation;
    baseline: Simulation;
    /** Cost at equal comfort of the plan and of doing nothing (see `planShift`). */
    fairCost: number;
    baselineFairCost: number;
    /** Why nothing moved, when nothing did. */
    reason?: 'spread_below_margin' | 'no_gain' | 'no_room';
}

/** What comfort means to the planner: air at the setpoint every slot, and at the end the mass
 *  the curve would hold there in steady state (no sun). It is the setpoint, not a simulation of
 *  doing nothing: that one counted the sun's overshoot as comfort, so easing off ahead of sun
 *  looked like making the house colder. It is not "from now" either: a reference starting at the
 *  current state ratcheted, each replan's bar rising with the last pre-heat. */
export type Reference = Pick<Simulation, 'ti' | 'tm'>;

export function comfortReference(house: HouseParams, comfort: number, forecast: ForecastSlot[]): Reference {
    const end = steadyState(house, comfort, forecast[forecast.length - 1].te);
    return {ti: forecast.map(() => comfort), tm: forecast.map(() => end.tm)};
}

/** Electricity bought, plus the warmth a plan leaves owing, bought back at the horizon's mean
 *  price times `weight`: degree-hours below comfort (H·Δt each) and stored heat short at the
 *  end. Running the house colder therefore saves nothing here; only buying the same comfort at
 *  cheaper hours does. A weight above 1 values comfort above its price, which is what makes a
 *  pre-heat ahead of a cold front worth buying. */
export function fairCost(house: HouseParams, sim: Simulation, reference: Reference, meanPrice: number, weight = 1): number {
    return sim.cost + weight * owedHeat(house, sim, reference) / COP * meanPrice;
}

/** kWh of heat a plan leaves owing: each degree-hour colder than the reference (H·Δt), plus
 *  stored heat short at the end. Warmth above the reference counts for nothing and offsets
 *  nothing: a pre-heat is worth only what it carries into a coast. Letting surplus offset
 *  deficits (equal *average* comfort) made the closed-loop planner hold 24.5 °C all morning to
 *  pay for a cool evening, and crediting surplus outright made heat at any cheaper-than-mean hour
 *  look like a saving. */
export function owedHeat(house: HouseParams, sim: Reference, reference: Reference): number {
    const n = sim.ti.length;
    let owed = Math.max(0, house.ci * (reference.ti[n - 1] - sim.ti[n - 1]) + house.cm * (reference.tm[n - 1] - sim.tm[n - 1]));
    for (let k = 0; k < n; k++) owed += house.heatLoss * SLOT_H * Math.max(0, reference.ti[k] - sim.ti[k]);
    return owed;
}

/** Shift heat between slots through the bias, minimising the cost at equal comfort.
 *
 *  While the pump's output is between zero and its ceiling, the house and curve are linear in
 *  the bias, so one impulse response gives every slot's effect on that cost and on indoor. A
 *  greedy search then moves the bias 1 K at a time where it pays most, inside the band, the
 *  bias limit, the ramp and the coast cap. The result is re-simulated in full, clamps included,
 *  and dropped if it leaves the band.
 *
 *  A spread below the margin doesn't stop the search, it only stops price shifting: each move
 *  must still beat half the margin on the heat it moves, which a pure arbitrage on a thin spread
 *  can't, while easing off ahead of sun saves outright and passes. */
export function planShift(house: HouseParams, comfort: number, state: PlanState, forecast: ForecastSlot[],
                          limits: Limits, pump: PumpCurve = {}, previous?: number[], maxMoves = 2000): Plan {
    const n = forecast.length;
    const zero = new Array(n).fill(0);
    const baseline = simulate(house, comfort, state, forecast, zero, pump);
    const prices = forecast.map((s) => s.price);
    const meanPrice = mean(prices);
    const reference = comfortReference(house, comfort, forecast);
    const weight = limits.comfortWeight;
    const baselineFair = fairCost(house, baseline, reference, meanPrice, weight);
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    const thin = !(hi > lo * (1 + limits.margin)) || hi <= 0;
    const nothing = (reason: Plan['reason']): Plan => ({biases: zero, plan: baseline, baseline,
        fairCost: baselineFair, baselineFairCost: baselineFair, reason: reason === 'no_gain' && thin ? 'spread_below_margin' : reason});
    if (limits.maxBias === 0) return nothing('no_room');

    // Unit-bias responses at slot 0: indoor, mass and heat m slots later.
    const unit = [1, ...new Array(n - 1).fill(0)];
    const flat = forecast.map((f) => ({...f, te: forecast[0].te}));
    const r0 = simulate(house, comfort, state, flat, zero, pump);
    const r1 = simulate(house, comfort, state, flat, unit, pump);
    const rti = r1.ti.map((v, m) => v - r0.ti[m]);
    const rtm = r1.tm.map((v, m) => v - r0.tm[m]);
    const rq = r1.heat.map((v, m) => v - r0.heat[m]);
    const moved = rq.reduce((a, b) => a + Math.abs(b), 0);
    // Per unit bias at j: electricity cost, and heat owed (H·Δt per degree-hour, plus stored heat
    // at the end). The objective is cost + mean price × max(0, owed) (`fairCost`).
    const costGrad = prices.map((_, j) => {
        let g = 0;
        for (let k = j; k < n; k++) g += prices[k] / COP * rq[k - j];
        return g;
    });
    const owedValue = weight * meanPrice / COP;
    // A move must win at least half the margin on the heat it moves, so a thin spread isn't chased.
    const threshold = (Number.isFinite(limits.margin) ? limits.margin : 1) / 2 * meanPrice / COP * moved;

    const floor = baseline.ti.map((t) => Math.min(t, comfort - limits.lower));
    const ceiling = baseline.ti.map((t) => Math.max(t, comfort + limits.upper));
    const maxCoast = Math.round(limits.maxCoastH / SLOT_H);
    // Start where the pump is: the previous plan, shifted by the slots since, else a ramp from the
    // bias in force back to zero. Starting from zero everywhere looks free but isn't: the ramp
    // forces each replan to climb back, so a closed loop never got a coast deeper than −6 K.
    const biases = startingPoint(state.bias, n, limits, previous);
    const ti = [...baseline.ti];
    const tm = [...baseline.tm];
    biases.forEach((b, j) => {
        if (!b) return;
        for (let k = j; k < n; k++) { ti[k] += b * rti[k - j]; tm[k] += b * rtm[k - j]; }
    });
    const endShort = (dti: number, dtm: number) =>
        Math.max(0, house.ci * (reference.ti[n - 1] - ti[n - 1] - dti) + house.cm * (reference.tm[n - 1] - tm[n - 1] - dtm));
    /** Change in heat owed if the bias at j moves by `step`. */
    const owedChange = (j: number, step: number) => {
        let d = endShort(step * rti[n - 1 - j], step * rtm[n - 1 - j]) - endShort(0, 0);
        for (let k = j; k < n; k++) {
            const gap = reference.ti[k] - ti[k];
            d += house.heatLoss * SLOT_H * (Math.max(0, gap - step * rti[k - j]) - Math.max(0, gap));
        }
        return d;
    };

    const shapeOk = (j: number, value: number) => {
        if (Math.abs(value) > limits.maxBias + 1e-9) return false;
        const before = j === 0 ? state.bias : biases[j - 1];
        if (Math.abs(value - before) > RAMP_K_PER_SLOT + 1e-9) return false;
        if (j + 1 < n && Math.abs(biases[j + 1] - value) > RAMP_K_PER_SLOT + 1e-9) return false;
        // The coast cap limits living on stored heat, so only slots below comfort count: easing
        // off while sun holds the house above it draws on nothing.
        if (value < 0 && ti[j] < comfort) {
            const drawing = (k: number) => biases[k] < 0 && ti[k] < comfort;
            let run = 1;
            for (let k = j - 1; k >= 0 && drawing(k); k--) run++;
            for (let k = j + 1; k < n && drawing(k); k++) run++;
            if (run > maxCoast) return false;
        }
        return true;
    };
    const bandOk = (j: number, step: number) => {
        for (let k = j; k < n; k++) {
            const t = ti[k] + step * rti[k - j];
            if (t < floor[k] - 1e-6 || t > ceiling[k] + 1e-6) return false;
        }
        return true;
    };

    for (let move = 0; move < maxMoves; move++) {
        let best: {j: number; step: number; gain: number} | undefined;
        for (let j = 0; j < n; j++) {
            for (const step of [-STEP_K, STEP_K]) {
                const electricity = step * costGrad[j];
                // Cheap bound first: owing can only add cost when warming (step > 0) is free of it.
                if (-electricity <= threshold && step < 0) continue;
                const gain = -(electricity + owedValue * owedChange(j, step));
                if (gain <= threshold || (best && gain <= best.gain)) continue;
                if (!shapeOk(j, biases[j] + step) || !bandOk(j, step)) continue;
                best = {j, step, gain};
            }
        }
        if (!best) break;
        biases[best.j] += best.step;
        for (let k = best.j; k < n; k++) { ti[k] += best.step * rti[k - best.j]; tm[k] += best.step * rtm[k - best.j]; }
    }

    if (biases.every((b) => b === 0)) return nothing('no_gain');
    // From a warm start the search can end still holding a bias; an unchanged start is still a plan.

    const plan = simulate(house, comfort, state, forecast, biases, pump);
    // Clamps (pump at zero or flat out) break the linear picture; keep the band regardless.
    if (plan.ti.some((t, k) => t < floor[k] - 0.1 || t > ceiling[k] + 0.1)) return nothing('no_gain');
    const fair = fairCost(house, plan, reference, meanPrice, weight);
    if (fair >= baselineFair) return nothing('no_gain');
    return {biases, plan, baseline, fairCost: fair, baselineFairCost: baselineFair};
}

/** The lever from history: hours of steady space heating (no hot water), heat against the
 *  calculated supply above indoor (1017 − ti), times the supply gain per K of fed outdoor
 *  (§4.5). Undefined with fewer than `minHours` usable hours. */
export function estimateLever(hours: {heatKw: number; tcalc: number; ti: number}[], supplyGain: number,
                              minHours = 12): number | undefined {
    const usable = hours.filter((h) => [h.heatKw, h.tcalc, h.ti].every(Number.isFinite) && h.tcalc - h.ti > 3);
    if (usable.length < minHours) return undefined;
    const sxx = usable.reduce((a, h) => a + (h.tcalc - h.ti) ** 2, 0);
    const sxy = usable.reduce((a, h) => a + (h.tcalc - h.ti) * h.heatKw, 0);
    return sxy / sxx * supplyGain;
}

/** A feasible schedule to search from: `previous` clipped to the limits and repaired to respect
 *  the ramp from `bias`, or a ramp from `bias` to zero. */
export function startingPoint(bias: number, n: number, limits: Limits, previous?: number[]): number[] {
    const out = new Array(n).fill(0);
    let last = bias;
    const maxCoast = Math.round(limits.maxCoastH / SLOT_H);
    let run = 0;
    for (let k = 0; k < n; k++) {
        let want = Math.max(-limits.maxBias, Math.min(limits.maxBias, previous?.[k] ?? 0));
        want = Math.max(last - RAMP_K_PER_SLOT, Math.min(last + RAMP_K_PER_SLOT, want));
        if (want < 0 && run >= maxCoast) want = Math.min(0, last + RAMP_K_PER_SLOT);
        run = want < 0 ? run + 1 : 0;
        out[k] = Math.round(want);
        last = out[k];
    }
    return out;
}
