/** Planner v1: price shifting through the outdoor bias. Pure. Design: docs/smart-heating-plan.md
 *  §7.3 (trim is left out until it runs against a live house; this is the shift).
 *
 *  It minimises the cost at equal comfort (`fairCost`) inside the profile's band, so a plan
 *  that saves only by running the house cooler is worth nothing to it: that is not price
 *  shifting (§11).
 *
 *  Assumptions to replace with measurements:
 *  - The pump's curve is tuned to the house, so feeding outdoor `f` delivers
 *    `H·(comfort − f) − gains` kW. The real curve is learned from 1017 later.
 *  - Electricity = heat / COP with a constant COP. The COP model is M5. */
import {HouseParams, stepHouse} from './model';
import {Limits} from './presets';
import {CURVE_TAU_H, RAMP_K_PER_SLOT, curveInput} from './actuator';

export const COP = 3;
/** The pump's heat ceiling as the outdoor temperature its curve is designed for. */
export const DESIGN_OUTDOOR = -20;
const SLOT_H = 0.25;
const STEP_K = 1;

export interface ForecastSlot {
    te: number;
    sun: number;
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

export function pumpHeat(house: HouseParams, comfort: number, curve: number): number {
    const max = house.heatLoss * (comfort - DESIGN_OUTDOOR);
    return Math.min(max, Math.max(0, house.heatLoss * (comfort - curve) - house.gains)) * SLOT_H;
}

export function simulate(house: HouseParams, comfort: number, state: PlanState, forecast: ForecastSlot[],
                         biases: number[]): Simulation {
    let {ti, tm, curve} = state;
    const out: Simulation = {ti: [], tm: [], heat: [], cost: 0, curveEnd: curve};
    forecast.forEach((slot, k) => {
        curve = curveInput(curve, slot.te - biases[k], SLOT_H, CURVE_TAU_H);
        const heat = pumpHeat(house, comfort, curve);
        [ti, tm] = stepHouse(house, ti, tm, {te: slot.te, q: heat, sun: slot.sun});
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
    const P = pumpHeat(house, comfort, te) / SLOT_H;
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
    /** Why nothing shifted, when nothing did. */
    reason?: 'spread_below_margin' | 'no_gain' | 'no_room';
}

/** Electricity bought, plus the warmth a plan leaves owing, bought back at the horizon's mean
 *  price: degree-hours below the reference (H·Δt each) and stored heat short at the end. Running
 *  the house colder therefore saves nothing here; only buying the same comfort at cheaper hours
 *  does. The reference is doing nothing from the steady state at comfort, not from now, so a
 *  pre-heat already made is credited rather than raising the bar for the next replan. */
export function fairCost(house: HouseParams, sim: Simulation, reference: Simulation, meanPrice: number): number {
    const n = sim.ti.length;
    let owed = house.ci * (reference.ti[n - 1] - sim.ti[n - 1]) + house.cm * (reference.tm[n - 1] - sim.tm[n - 1]);
    for (let k = 0; k < n; k++) owed += house.heatLoss * SLOT_H * (reference.ti[k] - sim.ti[k]);
    return sim.cost + owed / COP * meanPrice;
}

/** Shift heat between slots through the bias, minimising the cost at equal comfort.
 *
 *  While the pump's output is between zero and its ceiling, the house and curve are linear in
 *  the bias, so one impulse response gives every slot's effect on that cost and on indoor. A
 *  greedy search then moves the bias 1 K at a time where it pays most, inside the band, the
 *  bias limit, the ramp and the coast cap. The result is re-simulated in full, clamps included,
 *  and dropped if it leaves the band. */
export function planShift(house: HouseParams, comfort: number, state: PlanState, forecast: ForecastSlot[],
                          limits: Limits, maxMoves = 2000): Plan {
    const n = forecast.length;
    const zero = new Array(n).fill(0);
    const baseline = simulate(house, comfort, state, forecast, zero);
    const prices = forecast.map((s) => s.price);
    const meanPrice = mean(prices);
    const reference = simulate(house, comfort, steadyState(house, comfort, forecast[0].te), forecast, zero);
    const baselineFair = fairCost(house, baseline, reference, meanPrice);
    const nothing = (reason: Plan['reason']): Plan =>
        ({biases: zero, plan: baseline, baseline, fairCost: baselineFair, baselineFairCost: baselineFair, reason});
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    if (limits.maxBias === 0) return nothing('no_room');
    if (!(hi > lo * (1 + limits.margin)) || hi <= 0) return nothing('spread_below_margin');

    // Unit-bias responses at slot 0: indoor, mass and heat m slots later.
    const unit = [1, ...new Array(n - 1).fill(0)];
    const flat = forecast.map((f) => ({...f, te: forecast[0].te}));
    const r0 = simulate(house, comfort, state, flat, zero);
    const r1 = simulate(house, comfort, state, flat, unit);
    const rti = r1.ti.map((v, m) => v - r0.ti[m]);
    const rtm = r1.tm.map((v, m) => v - r0.tm[m]);
    const rq = r1.heat.map((v, m) => v - r0.heat[m]);
    const moved = rq.reduce((a, b) => a + Math.abs(b), 0);
    // d(fair cost)/d(bias at j).
    const gradient = prices.map((_, j) => {
        let g = 0;
        for (let k = j; k < n; k++) g += prices[k] / COP * rq[k - j] - meanPrice / COP * house.heatLoss * SLOT_H * rti[k - j];
        return g - meanPrice / COP * (house.ci * rti[n - 1 - j] + house.cm * rtm[n - 1 - j]);
    });
    // A move must win at least half the margin on the heat it moves, so a thin spread isn't chased.
    const threshold = (Number.isFinite(limits.margin) ? limits.margin : 1) / 2 * meanPrice / COP * moved;

    const floor = baseline.ti.map((t) => Math.min(t, comfort - limits.lower));
    const ceiling = baseline.ti.map((t) => Math.max(t, comfort + limits.upper));
    const maxCoast = Math.round(limits.maxCoastH / SLOT_H);
    const ti = [...baseline.ti];
    const biases = [...zero];

    const shapeOk = (j: number, value: number) => {
        if (Math.abs(value) > limits.maxBias + 1e-9) return false;
        const before = j === 0 ? state.bias : biases[j - 1];
        if (Math.abs(value - before) > RAMP_K_PER_SLOT + 1e-9) return false;
        if (j + 1 < n && Math.abs(biases[j + 1] - value) > RAMP_K_PER_SLOT + 1e-9) return false;
        if (value < 0) {
            let run = 1;
            for (let k = j - 1; k >= 0 && biases[k] < 0; k--) run++;
            for (let k = j + 1; k < n && biases[k] < 0; k++) run++;
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
                const gain = -step * gradient[j];
                if (gain <= threshold || (best && gain <= best.gain)) continue;
                if (!shapeOk(j, biases[j] + step) || !bandOk(j, step)) continue;
                best = {j, step, gain};
            }
        }
        if (!best) break;
        biases[best.j] += best.step;
        for (let k = best.j; k < n; k++) ti[k] += best.step * rti[k - best.j];
    }

    if (biases.every((b) => b === 0)) return nothing('no_gain');
    const plan = simulate(house, comfort, state, forecast, biases);
    // Clamps (pump at zero or flat out) break the linear picture; keep the band regardless.
    if (plan.ti.some((t, k) => t < floor[k] - 0.1 || t > ceiling[k] + 0.1)) return nothing('no_gain');
    const fair = fairCost(house, plan, reference, meanPrice);
    if (fair >= baselineFair) return nothing('no_gain');
    return {biases, plan, baseline, fairCost: fair, baselineFairCost: baselineFair};
}
