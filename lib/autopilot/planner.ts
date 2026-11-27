/** Planner v1: price shifting and weather feed-forward through the outdoor bias. Pure.
 *  Design: docs/autopilot-plan.md §7.3.
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
 *  - Electricity = heat / COP. With a trusted COP model (cop.ts) and the learned curve, each slot's
 *    heat is priced at the COP of the supply its bias gives, so a pre-heat pays for the warmer
 *    supply it needs; without them, at the constant `COP`. */
import {HouseParams, stepHouse} from './model';
import {Limits} from './presets';
import {CURVE_TAU_H, RAMP_K_PER_SLOT, curveInput} from './actuator';
import {SupplyCurve, supplyAt} from './curve';
import {comfortBias} from './trim';
import {COP_FALLBACK, CopModel, copAt} from './cop';

/** The COP heat is priced at without a trusted model. */
export const COP = COP_FALLBACK;
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
    /** What an exported kWh earns (spot), where known: the price of electricity the solar surplus
     *  covers (live.ts `surplusPrices`). */
    spot?: number;
    /** The compressor is planned on hot water: the house gets no heat from the pump this slot,
     *  whatever is fed (hot water always goes first). */
    busy?: boolean;
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
    /** The COP each slot's heat was priced at, and the supply it ran at (NaN without a curve). */
    cop: number[];
    supply: number[];
    cost: number;
    curveEnd: number;
}

export interface PumpCurve {
    /** kW of heat per K of bias, once the curve has caught up. Default: the house's heat loss. */
    lever?: number;
    /** The learned heat curve and kW of heat per K of supply; together they replace `lever`. */
    supply?: SupplyCurve;
    heatPerSupplyK?: number;
    /** Shift-only: the curve is taken to hold comfort at no bias, and a bias moves heat along the
     *  learned curve's real shape (steeper or flat where it is) rather than its local slope. No
     *  comfort bias (trim.ts). Live heating plans this way (live.ts). */
    shiftOnly?: boolean;
    /** The learned COP (cop.ts); used only when trusted and with the learned curve, which gives
     *  the supply a slot runs at. */
    cop?: CopModel;
}

/** Whether heat is priced by the learned COP rather than the constant. */
export function pricesByCop(pump: PumpCurve): boolean {
    return pump.cop?.trusted === true && pump.supply !== undefined;
}

/** The COP and supply of a slot whose curve sees `curve`. */
export function slotCop(pump: PumpCurve, curve: number, te: number): {cop: number; supply: number} {
    if (!pricesByCop(pump)) return {cop: COP, supply: pump.supply ? supplyAt(pump.supply, curve) : NaN};
    const supply = supplyAt(pump.supply!, curve);
    return {cop: copAt(pump.cop!, supply, te), supply};
}

/** kWh of electricity per extra kWh of heat in a slot that delivers `heat` kWh at `cop` and
 *  `supply`. More heat needs a warmer supply, which lowers the COP of all of the slot's heat, not
 *  only the extra: that is the price of a pre-heat the constant COP hid. At least 1/COP. */
export function marginalElectricity(pump: PumpCurve, heat: number, cop: number, supply: number, te: number): number {
    if (!pricesByCop(pump) || !(pump.heatPerSupplyK! > 0) || !Number.isFinite(supply)) return 1 / cop;
    const dCop = copAt(pump.cop!, supply + 0.5, te) - copAt(pump.cop!, supply - 0.5, te);
    // K of supply per extra kWh in the slot.
    const supplyPerKwh = 1 / (pump.heatPerSupplyK! * SLOT_H);
    return Math.max(1 / cop, 1 / cop - heat / cop ** 2 * dCop * supplyPerKwh);
}

/** Heat this slot, kWh, between off and the pump's design output.
 *
 *  With a learned curve and emission, and indoor `ti` known: what the pump really delivers,
 *  `heatPerSupplyK × (supply − ti)` at the supply its curve gives for what it has seen (`curve`).
 *  That does not hold comfort by itself; the comfort bias (trim.ts) is what makes it.
 *
 *  Otherwise: what holds comfort at `te`, moved by the bias the curve has seen so far
 *  (`te − curve`). That assumes the curve holds comfort, which only a room loop makes true. */
export function pumpHeat(house: HouseParams, comfort: number, te: number, curve: number, pump: PumpCurve = {}, ti?: number): number {
    const max = house.heatLoss * (comfort - DESIGN_OUTDOOR);
    let P: number;
    if (pump.supply && pump.heatPerSupplyK !== undefined && ti !== undefined && !pump.shiftOnly) {
        P = pump.heatPerSupplyK * (supplyAt(pump.supply, curve) - ti);
    } else {
        const moved = pump.supply && pump.heatPerSupplyK !== undefined
            ? pump.heatPerSupplyK * (supplyAt(pump.supply, curve) - supplyAt(pump.supply, te))
            : (pump.lever ?? house.heatLoss) * (te - curve);
        P = house.heatLoss * (comfort - te) - house.gains + moved;
    }
    return Math.min(max, Math.max(0, P)) * SLOT_H;
}

/** A setpoint per slot, and where it becomes a promise: Away ending at a time the owner gave
 *  (live.ts `setpointPath`). The plan should arrive at the setpoint there, not weigh it against
 *  the price: the profile's own weight (1.0 at Save more, which Away plans with) never pays for a
 *  warm-up whose heat partly leaks away before the return, and degree-hours alone barely see
 *  "0.4 K short for an hour". So at `firmFrom` each kelvin short costs the whole house's heat
 *  capacity, and heat owed from then on, `FIRM_WEIGHT` times what cures it. Among the ways to
 *  arrive, the cheapest still wins. */
export interface SetpointPath {
    setpoints: number[];
    firmFrom?: number;
}
/** The setpoint per slot: one number for the whole horizon, or a path. A path shorter than the
 *  horizon holds its last value. */
export type Comfort = number | number[] | SetpointPath;
export const FIRM_WEIGHT = 10;
export function comfortAt(comfort: Comfort, k: number): number {
    if (typeof comfort === 'number') return comfort;
    const path = Array.isArray(comfort) ? comfort : comfort.setpoints;
    return path[Math.min(k, path.length - 1)];
}

export function simulate(house: HouseParams, comfort: Comfort, state: PlanState, forecast: ForecastSlot[],
                         biases: number[], pump: PumpCurve = {}): Simulation {
    let {ti, tm, curve} = state;
    const out: Simulation = {ti: [], tm: [], heat: [], cop: [], supply: [], cost: 0, curveEnd: curve};
    // While hot water has the compressor the house gets nothing, and the pump does not make it up
    // afterwards: it delivers what its curve asks for, no more. On the S1155 its degree minutes
    // held still through all 44 hot water runs since 2026-10-31, and the 2 h after each brought
    // back 2 % of the heat missed (with Autopilot's shift steady). Until 2026-11-27 the plan
    // assumed it all came back, so it expected the house warmer than it got and planned nothing
    // to cover a run. Making it up is the plan's job, through the same lever as any shift: a
    // pre-heat before the run, or warmth owed bought back after, whatever the pump does itself.
    // Measured indoor starts every replan, so a pump that does catch up shows it, and the plan
    // buys less.
    forecast.forEach((slot, k) => {
        const c = comfortAt(comfort, k);
        curve = curveInput(curve, slot.te - biases[k], SLOT_H, CURVE_TAU_H);
        const heat = slot.busy ? 0 : pumpHeat(house, c, slot.te, curve, pump, ti);
        [ti, tm] = stepHouse(house, ti, tm, {te: slot.te, q: heat, sun: slot.sun, sunE: slot.sunE, sunW: slot.sunW});
        out.ti.push(ti);
        out.tm.push(tm);
        out.heat.push(heat);
        const priced = slotCop(pump, curve, slot.te);
        out.cop.push(priced.cop);
        out.supply.push(priced.supply);
        out.cost += heat / priced.cop * slot.price;
    });
    out.curveEnd = curve;
    return out;
}

/** Air and mass when comfort has been held at outdoor `te` for long, and the curve's view and
 *  bias that held it: the comfort bias, with a pump that needs one (trim.ts). */
export function steadyState(house: HouseParams, comfort: number, te: number, pump?: PumpCurve): PlanState {
    const P = pumpHeat(house, comfort, te, te) / SLOT_H;
    const bias = comfortBias(house, pump, comfort, te);
    return {ti: comfort, tm: comfort + house.f * P * house.rim, curve: te - bias, bias};
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export interface Plan {
    /** What to feed, as bias on the real outdoor temperature: `comfort + shift`, slot by slot. */
    biases: number[];
    /** The bias that holds comfort (trim.ts), 0 where the pump is assumed to hold it itself. */
    comfort: number[];
    /** The price and weather shift the search chose on top of it. */
    shift: number[];
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

export function comfortReference(house: HouseParams, comfort: Comfort, forecast: ForecastSlot[]): Reference {
    const n = forecast.length;
    const end = steadyState(house, comfortAt(comfort, n - 1), forecast[n - 1].te);
    return {ti: forecast.map((_, k) => comfortAt(comfort, k)), tm: forecast.map(() => end.tm)};
}

/** Electricity bought, plus the warmth a plan leaves owing, bought back at the horizon's mean
 *  price times `weight`: degree-hours below comfort (H·Δt each) and stored heat short at the
 *  end. Running the house colder therefore saves nothing here; only buying the same comfort at
 *  cheaper hours does. A weight above 1 values comfort above its price, which is what makes a
 *  pre-heat ahead of a cold front worth buying. */
export function fairCost(house: HouseParams, sim: Simulation, reference: Reference, meanPrice: number,
                         weight: number | number[] = 1, firm?: number, cop = COP): number {
    return sim.cost + owedHeat(house, sim, reference, weight, firm) / cop * meanPrice;
}

/** kWh charged per kelvin the air is short of the setpoint at a promised slot (`SetpointPath`). */
export function firmPenalty(house: HouseParams): number {
    return FIRM_WEIGHT * (house.ci + house.cm);
}

/** Electricity per extra kWh of heat in each slot of a simulation (`marginalElectricity`). */
export function marginals(pump: PumpCurve, sim: Simulation, forecast: ForecastSlot[]): number[] {
    return sim.heat.map((q, k) => marginalElectricity(pump, q, sim.cop[k], sim.supply[k], forecast[k].te));
}

/** The COP owed heat is bought back at: the heat-weighted mean of the marginal rates, so heat
 *  saved and heat owed are valued alike. At the average COP instead, every coast looked like a
 *  saving at a flat price, since the heat it saves costs the marginal rate. The constant `COP`
 *  without a trusted model. */
export function buyBackCop(sim: Simulation, marginal: number[]): number {
    const heat = sim.heat.reduce((a, b) => a + b, 0);
    const electricity = sim.heat.reduce((a, q, k) => a + q * marginal[k], 0);
    return heat > 0 && electricity > 0 ? heat / electricity : COP;
}

/** kWh of heat a plan leaves owing: each degree-hour colder than the reference (H·Δt), plus
 *  stored heat short at the end. Warmth above the reference counts for nothing and offsets
 *  nothing: a pre-heat is worth only what it carries into a coast. Letting surplus offset
 *  deficits (equal *average* comfort) made the closed-loop planner hold 24.5 °C all morning to
 *  pay for a cool evening, and crediting surplus outright made heat at any cheaper-than-mean hour
 *  look like a saving. */
export function owedHeat(house: HouseParams, sim: Reference, reference: Reference, weight: number | number[] = 1,
                         firm?: number): number {
    const n = sim.ti.length;
    const w = (k: number) => (typeof weight === 'number' ? weight : weight[k]);
    let owed = w(n - 1) * Math.max(0, house.ci * (reference.ti[n - 1] - sim.ti[n - 1]) + house.cm * (reference.tm[n - 1] - sim.tm[n - 1]));
    for (let k = 0; k < n; k++) owed += w(k) * house.heatLoss * SLOT_H * Math.max(0, reference.ti[k] - sim.ti[k]);
    if (firm !== undefined && firm < n) owed += firmPenalty(house) * Math.max(0, reference.ti[firm] - sim.ti[firm]);
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
 *  can't, while easing off ahead of sun saves outright and passes.
 *
 *  `comfort` may be a path: a setpoint that steps up (Away ending) is owed from the slot it
 *  steps, so the search warms the house ahead of it on the cheapest hours that still carry the
 *  heat there. The band's ceiling before the step is the setpoint still to come, or that
 *  pre-heat would be outside it. */
export function planShift(house: HouseParams, comfort: Comfort, state: PlanState, forecast: ForecastSlot[],
                          limits: Limits, pump: PumpCurve = {}, previous?: number[], maxMoves = 2000): Plan {
    const n = forecast.length;
    const zero = new Array(n).fill(0);
    const c = forecast.map((_, k) => comfortAt(comfort, k));
    // The highest setpoint from each slot on: what the house may be warmed towards there.
    const ahead = [...c];
    for (let k = n - 2; k >= 0; k--) ahead[k] = Math.max(c[k], ahead[k + 1]);
    // "Doing nothing" is holding comfort: the comfort bias every slot. The search works on the
    // shift on top of it, which is what the profile's limits, ramp and coast cap govern.
    const held = forecast.map((s, k) => comfortBias(house, pump, c[k], s.te));
    const total = (shift: number[]) => shift.map((b, k) => b + held[k]);
    const baseline = simulate(house, c, state, forecast, held, pump);
    const prices = forecast.map((s) => s.price);
    const meanPrice = mean(prices);
    const reference = comfortReference(house, c, forecast);
    // Heat owed is worth the profile's weight, and the firm weight from a promised return on.
    const firmFrom = typeof comfort === 'object' && !Array.isArray(comfort) ? comfort.firmFrom ?? n : n;
    const firm = firmFrom < n ? firmFrom : undefined;
    const weight = forecast.map((_, k) => (k >= firmFrom ? Math.max(FIRM_WEIGHT, limits.comfortWeight) : limits.comfortWeight));
    // Electricity per extra kWh of heat in each slot, at doing nothing's supply: with a learned COP
    // a warmer supply costs more than its own heat (`marginalElectricity`). Owed heat is bought
    // back at the same rate, so plan and baseline are scored alike.
    const marginal = marginals(pump, baseline, forecast);
    const cop = buyBackCop(baseline, marginal);
    const baselineFair = fairCost(house, baseline, reference, meanPrice, weight, firm, cop);
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    const thin = !(hi > lo * (1 + limits.margin)) || hi <= 0;
    const nothing = (reason: Plan['reason']): Plan => ({biases: held, comfort: held, shift: zero, plan: baseline, baseline,
        fairCost: baselineFair, baselineFairCost: baselineFair, reason: reason === 'no_gain' && thin ? 'spread_below_margin' : reason});
    if (limits.maxBias === 0) return nothing('no_room');

    // Unit-bias responses: indoor, mass and heat m slots after a step at j. Hot water's hours are
    // absolute, so a step whose response reaches one gets its own response with those slots busy:
    // a pre-heat into a charge delivers nothing there (simulate), and a linear picture that
    // credited it overshot the real plan out of its band (2026-11-27). Steps clear of every
    // charge share the plain one.
    const unit = [1, ...new Array(n - 1).fill(0)];
    const flatHeld = new Array(n).fill(held[0]);
    const responseWith = (busyAt: (m: number) => boolean) => {
        const flat = forecast.map((f, m) => ({...f, te: forecast[0].te, busy: busyAt(m)}));
        const r0 = simulate(house, c[0], state, flat, flatHeld, pump);
        const r1 = simulate(house, c[0], state, flat, unit.map((u) => u + held[0]), pump);
        return {ti: r1.ti.map((v, m) => v - r0.ti[m]), tm: r1.tm.map((v, m) => v - r0.tm[m]), q: r1.heat.map((v, m) => v - r0.heat[m])};
    };
    const plain = responseWith(() => false);
    const rq = plain.q;
    // A bias moves heat for a few hours (the curve's lag, then the house's pull on emission):
    // past that the response is noise, and pricing it would only cost time.
    const peak = Math.max(...rq.map(Math.abs));
    let reach = n;
    while (reach > 1 && Math.abs(rq[reach - 1]) < 1e-3 * peak) reach--;
    const responses = new Map<number, typeof plain>();
    const R = (j: number) => {
        let r = responses.get(j);
        if (!r) responses.set(j, r = forecast.slice(j, j + reach).some((f) => f.busy) ? responseWith((m) => forecast[j + m]?.busy === true) : plain);
        return r;
    };
    const moved = rq.reduce((a, b) => a + Math.abs(b), 0);
    // Per unit bias at j: electricity cost, and heat owed (H·Δt per degree-hour, plus stored heat
    // at the end). The objective is cost + mean price × max(0, owed) (`fairCost`).
    const costGrad = prices.map((_, j) => {
        let g = 0;
        const q = R(j).q;
        for (let k = j; k < n; k++) g += prices[k] * marginal[k] * q[k - j];
        return g;
    });
    // With a learned COP a slot's electricity is convex in its heat: each K of supply a pre-heat
    // adds lowers the COP of all of the slot's heat. A fixed rate per slot misses that (with flat
    // weather every slot's rate is the same and the penalty cancels), so each move is priced by
    // the exact change at the heat the plan has reached so far. Supply moves with heat along the
    // emission (`heatPerSupplyK`); without a trusted COP the fixed gradient is exact.
    const convex = pricesByCop(pump) && pump.heatPerSupplyK! > 0;
    const heatNow = [...baseline.heat];
    const electricityAt = (k: number, heat: number) => {
        const q = Math.max(0, heat);
        if (q === 0) return 0;
        const supply = baseline.supply[k] + (q - baseline.heat[k]) / (pump.heatPerSupplyK! * SLOT_H);
        return q / copAt(pump.cop!, supply, forecast[k].te);
    };
    const electricityChange = (j: number, step: number) => {
        if (!convex) return step * costGrad[j];
        let d = 0;
        const q = R(j).q;
        for (let k = j; k < Math.min(n, j + reach); k++) {
            if (q[k - j] === 0) continue;
            d += prices[k] * (electricityAt(k, heatNow[k] + step * q[k - j]) - electricityAt(k, heatNow[k]));
        }
        return d;
    };
    // The weight is per slot, inside `owedChange`.
    const owedValue = meanPrice / cop;
    // A move must win at least half the margin on the heat it moves, so a thin spread isn't chased.
    const threshold = (Number.isFinite(limits.margin) ? limits.margin : 1) / 2 * meanPrice / cop * moved;

    const floor = baseline.ti.map((t, k) => Math.min(t, c[k] - limits.lower));
    const ceiling = baseline.ti.map((t, k) => Math.max(t, ahead[k] + limits.upper));
    const maxCoast = Math.round(limits.maxCoastH / SLOT_H);
    // Start where the pump is: the previous plan, shifted by the slots since, else a ramp from the
    // bias in force back to zero. Starting from zero everywhere looks free but isn't: the ramp
    // forces each replan to climb back, so a closed loop never got a coast deeper than −6 K.
    // The ramp and warm start are on the shift: the bias in force and the previous plan, less
    // the comfort bias under them.
    const shiftNow = state.bias - held[0];
    const biases = startingPoint(shiftNow, n, limits, previous?.map((b, k) => b - (held[k] ?? held[n - 1])));
    const ti = [...baseline.ti];
    const tm = [...baseline.tm];
    biases.forEach((b, j) => {
        if (!b) return;
        const r = R(j);
        for (let k = j; k < n; k++) { ti[k] += b * r.ti[k - j]; tm[k] += b * r.tm[k - j]; }
    });
    const endShort = (dti: number, dtm: number) =>
        Math.max(0, house.ci * (reference.ti[n - 1] - ti[n - 1] - dti) + house.cm * (reference.tm[n - 1] - tm[n - 1] - dtm));
    /** Change in weighted heat owed if the bias at j moves by `step`. */
    const owedChange = (j: number, step: number) => {
        const {ti: rti, tm: rtm} = R(j);
        let d = weight[n - 1] * (endShort(step * rti[n - 1 - j], step * rtm[n - 1 - j]) - endShort(0, 0));
        for (let k = j; k < n; k++) {
            const gap = reference.ti[k] - ti[k];
            d += weight[k] * house.heatLoss * SLOT_H * (Math.max(0, gap - step * rti[k - j]) - Math.max(0, gap));
        }
        if (firm !== undefined && firm >= j) {
            const gap = reference.ti[firm] - ti[firm];
            d += firmPenalty(house) * (Math.max(0, gap - step * rti[firm - j]) - Math.max(0, gap));
        }
        return d;
    };

    const shapeOk = (j: number, value: number) => {
        if (value > limits.maxBias + 1e-9 || value < -limits.maxCoastBias - 1e-9) return false;
        const before = j === 0 ? shiftNow : biases[j - 1];
        if (Math.abs(value - before) > RAMP_K_PER_SLOT + 1e-9) return false;
        if (j + 1 < n && Math.abs(biases[j + 1] - value) > RAMP_K_PER_SLOT + 1e-9) return false;
        // The coast cap limits living on stored heat, so only slots below comfort count: easing
        // off while sun holds the house above it draws on nothing.
        if (value < 0 && ti[j] < c[j]) {
            const drawing = (k: number) => biases[k] < 0 && ti[k] < c[k];
            let run = 1;
            for (let k = j - 1; k >= 0 && drawing(k); k--) run++;
            for (let k = j + 1; k < n && drawing(k); k++) run++;
            if (run > maxCoast) return false;
        }
        return true;
    };
    const bandOk = (j: number, step: number) => {
        const rti = R(j).ti;
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
                const electricity = electricityChange(j, step);
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
        const r = R(best.j);
        for (let k = best.j; k < n; k++) heatNow[k] += best.step * r.q[k - best.j];
        for (let k = best.j; k < n; k++) { ti[k] += best.step * r.ti[k - best.j]; tm[k] += best.step * r.tm[k - best.j]; }
    }

    if (biases.every((b) => b === 0)) return nothing('no_gain');
    // From a warm start the search can end still holding a bias; an unchanged start is still a plan.

    const plan = simulate(house, c, state, forecast, total(biases), pump);
    // Clamps (pump at zero or flat out) break the linear picture; keep the band regardless.
    if (plan.ti.some((t, k) => t < floor[k] - 0.1 || t > ceiling[k] + 0.1)) return nothing('no_gain');
    const fair = fairCost(house, plan, reference, meanPrice, weight, firm, cop);
    if (fair >= baselineFair) return nothing('no_gain');
    return {biases: total(biases), comfort: held, shift: biases, plan, baseline, fairCost: fair, baselineFairCost: baselineFair};
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
        let want = Math.max(-limits.maxCoastBias, Math.min(limits.maxBias, previous?.[k] ?? 0));
        want = Math.max(last - RAMP_K_PER_SLOT, Math.min(last + RAMP_K_PER_SLOT, want));
        if (want < 0 && run >= maxCoast) want = Math.min(0, last + RAMP_K_PER_SLOT);
        run = want < 0 ? run + 1 : 0;
        out[k] = Math.round(want);
        last = out[k];
    }
    return out;
}
