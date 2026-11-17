/** Hot water planner: when to charge the tank and how hot, over the prices that are known. Pure.
 *  Design: docs/autopilot-hot-water.md §4.2, autopilot-plan.md §2.1.
 *
 *  A dynamic programme over 15-minute slots. The state is the heat stored in the tank and whether
 *  a charge is running; a charge, once started, runs until it stops, because the pump will not
 *  end one early (697 = 0 does not stop a charge in progress). So a plan is a set of runs, and
 *  each run's target temperature is the tank temperature its stored heat reaches: that is what
 *  the Large stop (62) is set to before the run starts.
 *
 *  Draws come from the learned profile, planned halfway between the mean and the 80th percentile
 *  (`drawsFor`), loss and COP from the learned models. Settled by the back-test
 *  (dev/evaluate-hot-water.mjs, docs/autopilot-hot-water.md §5): a margin above the reserve
 *  kept the tank hot for nothing, and replanning every slot without a smallest charge turned
 *  forecast error into many short charges at peak prices. Only the next
 *  action is ever taken; the plan is redone every slot. */

import {ChargeModel, DayProfile, KWH_PER_LITRE, StandingLoss, chargeRate, copAt, lossAt} from './hotwater-learner';

export const SLOT_H = 0.25;
/** kWh of resolution in stored heat. */
const STEP_KWH = 0.1;
/** Per kWh of heat below the floor: large enough that only an impossible plan pays it. */
const SHORTFALL_KR_PER_KWH = 50;
/** Per charge started: keeps a plan from splitting one charge into many for a few öre. */
export const START_KR = 1;
/** Smallest charge worth starting, kWh heat, unless the reserve is already breached. */
export const MIN_CHARGE_KWH = 4;

export interface TankSpec {
    /** Water volume, litres. */
    litres: number;
    /** Cold-water inlet, °C. */
    inletC: number;
}

export interface PlanSlot {
    /** Price per kWh of electricity bought in this slot. */
    price: number;
    /** Expected export (surplus) in this slot, kW, if known. */
    surplusKw?: number;
    /** What an exported kWh earns in this slot; defaults to 0. */
    exportPrice?: number;
    /** Draw planned for this slot, kWh heat. */
    draw: number;
    /** The orchestrator's reserved slots: no charge may start here (autopilot-plan.md §2.1). */
    reserved?: boolean;
}

export interface PlanInput {
    slots: PlanSlot[];
    /** Heat stored now, kWh (litres of 40 °C water × KWH_PER_LITRE). */
    stored: number;
    /** A charge is running now (it will run on until it reaches the Large stop). */
    charging: boolean;
    /** The Large stop in force now, °C: where a running charge ends. */
    runningTargetC?: number;
    tank: TankSpec;
    charge: ChargeModel;
    loss: StandingLoss;
    /** Heat that must always be left, kWh: the owner's "always keep at least" setting
     *  (`reserveKwh(DEFAULT_RESERVE_LITRES)` by default; 0 = off, the pump's own start
     *  temperature is then the only safety net). */
    reserve: number;
    /** Tank top now, °C. While it is at least `minC` the reserve counts as still there, whatever
     *  the estimate says: after a big draw the estimate keeps falling for hours as the tank
     *  settles, with no water drawn (measured 2026-11-08: 71 → 52 L in 3 h, top 52 → 49 °C),
     *  and a floor that trusted it would buy a charge at any price for nothing. */
    topC?: number;
    /** Lowest and highest charge target, °C (doc §4.2: derived, not asked). */
    minC: number;
    maxC: number;
    /** Smallest charge worth starting; MIN_CHARGE_KWH by default. */
    minChargeKwh?: number;
    /** The last plan had a charge starting in this slot. If this plan still charges within
     *  `DUE_SLOTS`, it starts now: a replan that keeps pushing a due charge back, because the
     *  draws it waits for are late, ends up charging after them (2026-11-15). */
    due?: boolean;
}

/** How far a due charge may have moved and still start on time. */
export const DUE_SLOTS = 4;

export interface PlannedCharge {
    /** Slot index into `slots`. */
    start: number;
    /** First slot after the run. */
    end: number;
    targetC: number;
    heat: number;
    electricity: number;
    cost: number;
    /** Share of the run's electricity bought at the export price. */
    surplusShare: number;
}

export interface Plan {
    charges: PlannedCharge[];
    /** Stored heat at the start of each slot and after the last. */
    stored: number[];
    cost: number;
    /** kWh heat below the floor anywhere in the plan; > 0 means it could not be helped. */
    shortfall: number;
    /** Start a charge in the first slot. */
    startNow: boolean;
    /** That start is the safety net, not the price: the tank is under the reserve and its top
     *  does not vouch for it. */
    rescue: boolean;
}

/** kWh of heat in the tank when all of it is at `c` °C. */
export function heatAt(tank: TankSpec, c: number): number {
    return tank.litres * Math.max(0, c - tank.inletC) * 4.186 / 3600;
}

/** Tank temperature that holds `kwh` evenly. */
export function tempOf(tank: TankSpec, kwh: number): number {
    return tank.inletC + kwh * 3600 / 4.186 / tank.litres;
}

/** Share of the way from the mean draw to the 80th percentile that a plan counts on. */
export const DRAW_QUANTILE_BLEND = 0.5;

/** Per local hour, the draw a day is planned with: the hours give the shape, the day totals the
 *  amount. The hours alone over-forecast twice over. Each hour's draw is clipped at 0, so reading
 *  noise only ever adds (measured 2026-11-13: hourly means summing to 21.8 kWh against a 13.9 kWh
 *  mean day). And a busy-day figure per hour, summed, plans a day busy in every hour at once
 *  (42 kWh against a 21.4 kWh busy day). So the mean hours are scaled to the mean day, and the
 *  hours' busy-day excess to the busy day's: the planned day is `daily + blend × (dailyP80 −
 *  daily)`, placed where draws happen and leaning to the hours that vary. Unchanged when the
 *  day totals are unknown. */
export function plannedHours(p: DayProfile, blend = DRAW_QUANTILE_BLEND): number[] {
    const mean = p.hours.map((v) => Number.isFinite(v) ? Math.max(0, v) : 0);
    const excess = p.p80.map((v, h) => Number.isFinite(v) ? Math.max(0, v - mean[h]) : 0);
    const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0);
    const meanSum = sum(mean), excessSum = sum(excess);
    const meanScale = Number.isFinite(p.daily) && meanSum > 0 ? Math.max(0, p.daily) / meanSum : 1;
    const busy = Number.isFinite(p.daily) && Number.isFinite(p.dailyP80) ? Math.max(0, p.dailyP80 - p.daily) : NaN;
    const excessScale = Number.isFinite(busy) ? (excessSum > 0 ? busy / excessSum : 0) : 1;
    return mean.map((v, h) => v * meanScale + blend * excess[h] * excessScale);
}

/** The draw to plan for over a horizon. With `quarters` (each slot's quarter of its local hour,
 *  0–3) the hour's whole draw lands in its first slot: a shower takes 100 L in ten minutes, and a
 *  plan that spreads it over the hour lets the tank run down to the last litre just before it
 *  (2026-11-15: the 10:45 charge was still ahead when 170 L went at 10:00). A horizon that starts
 *  mid-hour keeps the part of that hour still to come. Without `quarters`, a quarter per slot. */
export function drawsFor(profiles: (DayProfile | undefined)[], hours: number[], blend = DRAW_QUANTILE_BLEND,
    quarters?: number[]): number[] {
    const planned = new Map<DayProfile, number[]>();
    return hours.map((h, k) => {
        const p = profiles[k];
        if (!p) return 0;
        let byHour = planned.get(p);
        if (!byHour) planned.set(p, byHour = plannedHours(p, blend));
        if (!quarters) return byHour[h] * SLOT_H;
        const q = Math.max(0, Math.min(3, quarters[k] ?? 0));
        if (k === 0) return byHour[h] * (4 - q) * SLOT_H;
        return q === 0 ? byHour[h] : 0;
    });
}

/** How far a draw may come early and still be the draw the profile expects later: an evening
 *  shower taken an hour before its usual time is that shower, not another one. */
export const EARLY_DRAW_HOURS = 3;

/** The draws ahead less what was drawn early: `early` (kWh heat drawn in the last
 *  EARLY_DRAW_HOURS beyond what was planned for them) comes off the draws planned for the next
 *  EARLY_DRAW_HOURS, nearest first. Without it, a shower taken early is counted twice, once in the
 *  tank and once more at its usual hour, and the plan buys a charge at the evening's peak for
 *  water nobody draws (2026-11-16: 130 L at 17:15–17:45, then a charge at 19:15 for the 18–21
 *  draws it still expected). Draws past the window are left alone: a big draw does not mean
 *  tomorrow's shower is skipped. */
export function creditEarly(draws: number[], early: number, slots = EARLY_DRAW_HOURS / SLOT_H): number[] {
    let left = Number.isFinite(early) ? Math.max(0, early) : 0;
    return draws.map((d, k) => {
        if (k >= slots || left <= 0) return d;
        const take = Math.min(d, left);
        left -= take;
        return d - take;
    });
}

/** Effective price of a kWh of electricity: surplus first, then the grid. */
function effective(slot: PlanSlot, kw: number): {price: number; surplus: number} {
    const surplus = kw > 0 ? Math.min(1, Math.max(0, slot.surplusKw ?? 0) / kw) : 0;
    return {price: surplus * (slot.exportPrice ?? 0) + (1 - surplus) * slot.price, surplus};
}

export function plan(input: PlanInput): Plan {
    const {slots, tank, charge, loss, reserve} = input;
    // Under the reserve: charge now at any price (the owner's safety net), unless a hot top
    // vouches for the water (see `topC`) and the estimate is only settling.
    const vouched = input.topC !== undefined && input.topC >= input.minC;
    const rescue = !input.charging && input.stored < reserve && !vouched;
    const n = slots.length;
    const top = heatAt(tank, input.maxC);
    const levels = Math.max(2, Math.round(top / STEP_KWH) + 1);
    /** Heat a slot of charging adds from `kwh` stored, and the electricity it takes: at the tank's
     *  own rate, which falls as it fills, so a plan runs as long as a real charge does. */
    const step = (kwh: number, cap: number) => {
        const full = chargeRate(charge, kwh) * SLOT_H;
        const q = Math.max(0, Math.min(full, cap - kwh));
        const el = charge.kw !== undefined ? charge.kw * SLOT_H * (full > 0 ? q / full : 0)
            : q / copAt(charge, tempOf(tank, kwh + q));
        return {q, el};
    };
    const minRunHeat = heatAt(tank, input.minC);

    const floor = reserve;

    // Heat left at the end is worth what it would cost to make at the horizon's typical price.
    const meanPrice = slots.reduce((s, x) => s + x.price, 0) / Math.max(1, n);
    const terminal = (kwh: number) => -kwh * meanPrice / Math.max(1, charge.cop) * 0.9;

    // V[k][c][s]: cost from slot k on, c = charging (0/1), s = stored level. Read between levels
    // by interpolation, so a slot's standing loss (a few hundredths of a kWh) is not rounded away
    // and the forward pass, which follows the real stored heat, sees the same values.
    const INF = Number.POSITIVE_INFINITY;
    const values: Float64Array[] = new Array(n + 1);
    values[n] = new Float64Array(2 * levels);
    for (let s = 0; s < levels; s++) values[n][s] = values[n][levels + s] = terminal(s * STEP_KWH);
    const value = (v: Float64Array, c: number, kwh: number) => {
        const x = Math.max(0, Math.min(levels - 1, kwh / STEP_KWH)), lo = Math.floor(x), hi = Math.min(levels - 1, lo + 1);
        return v[c * levels + lo] + (v[c * levels + hi] - v[c * levels + lo]) * (x - lo);
    };
    const kw = charge.kw ?? charge.heatPerHour / Math.max(1, charge.cop);
    /** Heat a draw takes below the floor (all of an unmet draw when the floor is 0). Standing
     *  loss is left out: a tank resting at the floor is not worth a charge at any price to
     *  replace a few hundredths of a kWh, and the rescue handles one that is really under it. */
    const below = (kwh: number, draw: number) => Math.max(0, Math.min(kwh, floor) - (kwh - draw));
    /** Cost of each choice in slot k from stored heat `kwh`, with or without a charge running. */
    const choices = (k: number, c: number, kwh: number, cap = top) => {
        const slot = slots[k], v = values[k + 1];
        const lost = lossAt(loss, kwh) * SLOT_H;
        const idleAfter = Math.max(0, kwh - slot.draw - lost);
        const idle = below(kwh, slot.draw) * SHORTFALL_KR_PER_KWH + value(v, 0, idleAfter);
        let heat = INF, q = 0, el = 0;
        if ((c === 1 || !slot.reserved) && kwh < cap - 1e-9) {
            ({q, el} = step(kwh, cap));
            const after = Math.max(0, kwh + q - slot.draw - lost);
            // A charge that reaches the top has reached its stop: the pump ends it there. Without
            // this a plan could hold a full tank "charging" for hours, topping up its standing
            // loss for öre, to skip the price of a new start (2026-11-15: a 17 h 45 min charge).
            const ends = kwh + q >= cap - STEP_KWH;
            heat = el * effective(slot, kw).price + (c === 0 ? START_KR : 0)
                + below(kwh + q, slot.draw) * SHORTFALL_KR_PER_KWH + value(v, ends ? 0 : 1, after);
        }
        // A running charge stops only at its target, which is at least the lowest allowed one.
        const mayStop = c === 0 || kwh >= minRunHeat - 1e-9 || heat === INF;
        return {idle: mayStop ? idle : INF, heat, q, el};
    };
    for (let k = n - 1; k >= 0; k--) {
        const now = values[k] = new Float64Array(2 * levels);
        for (let c = 0; c < 2; c++) for (let s = 0; s < levels; s++) {
            const {idle, heat} = choices(k, c, s * STEP_KWH);
            now[c * levels + s] = Math.min(idle, heat);
        }
    }

    // Forward: follow the decisions from the real state.
    const stored: number[] = [];
    const charges: PlannedCharge[] = [];
    let kwh = Math.max(0, input.stored), c = input.charging ? 1 : 0, cost = 0, shortfall = 0;
    let open: PlannedCharge | undefined;
    // A charge already running ends at the Large stop in force, whatever the plan would prefer.
    let runningTop = input.charging && input.runningTargetC !== undefined ? heatAt(tank, input.runningTargetC) : undefined;
    for (let k = 0; k < n; k++) {
        stored.push(kwh);
        const slot = slots[k];
        const lost = lossAt(loss, kwh) * SLOT_H;
        const choice = choices(k, c, kwh, runningTop ?? top);
        const heat = choice.heat < INF
            && (runningTop !== undefined || (k === 0 && rescue) || choice.heat <= choice.idle);
        if (heat) {
            const {q, el} = choice;
            const {price, surplus} = effective(slot, kw);
            if (!open) {
                open = {start: k, end: k + 1, targetC: 0, heat: 0, electricity: 0, cost: 0, surplusShare: 0};
                charges.push(open);
            }
            open.end = k + 1;
            open.heat += q;
            open.surplusShare = (open.surplusShare * open.electricity + surplus * el) / (open.electricity + el);
            open.electricity += el;
            open.cost += el * price;
            cost += el * price + (c === 0 ? START_KR : 0);
            kwh += q;
            open.targetC = tempOf(tank, kwh);
            c = 1;
            // The pump ends a running charge at its stop; it does not hold the tank there, topping
            // up each draw. Anything after that is a new charge, priced and started as one.
            if (kwh >= (runningTop ?? top) - STEP_KWH) {
                c = 0;
                open = undefined;
                runningTop = undefined;
            }
        } else {
            c = 0;
            open = undefined;
            runningTop = undefined;
        }
        kwh = Math.max(0, kwh - slot.draw - lost);
        shortfall += Math.max(0, floor - kwh);
    }
    stored.push(kwh);
    for (const ch of charges) ch.targetC = Math.min(input.maxC, Math.max(input.minC, Math.round(ch.targetC)));
    // A top-up smaller than this waits for the next round, which plans a proper charge: replanning
    // every slot otherwise turns forecast error into many short, mostly expensive, charges.
    const first = charges[0];
    const startNow = !input.charging && first !== undefined
        && (first.start === 0 || (input.due === true && first.start <= DUE_SLOTS))
        && (first.heat >= (input.minChargeKwh ?? MIN_CHARGE_KWH) || (rescue && first.start === 0));
    return {charges, stored, cost, shortfall, startNow, rescue};
}

/** The "always keep at least" default, litres of 40 °C water: about one shower. On by default,
 *  because a household wants the hot water guaranteed more than the last few öre (2026-11-08). */
export const DEFAULT_RESERVE_LITRES = 40;

/** Litres of 40 °C water → kWh, for the reserve setting. */
export const reserveKwh = (litres: number) => litres * KWH_PER_LITRE;
