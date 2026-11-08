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

import {ChargeModel, DayProfile, KWH_PER_LITRE, StandingLoss, copAt, lossAt} from './hotwater-learner';

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
    /** Heat that must always be left, kWh. */
    reserve: number;
    /** Lowest and highest charge target, °C (doc §4.2: derived, not asked). */
    minC: number;
    maxC: number;
    /** Smallest charge worth starting; MIN_CHARGE_KWH by default. */
    minChargeKwh?: number;
}

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

/** The draw to plan for over a horizon: each slot takes a quarter of its local hour's profile. */
export function drawsFor(profiles: (DayProfile | undefined)[], hours: number[], blend = DRAW_QUANTILE_BLEND): number[] {
    return hours.map((h, k) => {
        const p = profiles[k];
        const mean = p && Number.isFinite(p.hours[h]) ? p.hours[h] : 0;
        const p80 = p && Number.isFinite(p.p80[h]) ? Math.max(mean, p.p80[h]) : mean;
        return (mean + blend * (p80 - mean)) * SLOT_H;
    });
}

/** Effective price of a kWh of electricity: surplus first, then the grid. */
function effective(slot: PlanSlot, kw: number): {price: number; surplus: number} {
    const surplus = kw > 0 ? Math.min(1, Math.max(0, slot.surplusKw ?? 0) / kw) : 0;
    return {price: surplus * (slot.exportPrice ?? 0) + (1 - surplus) * slot.price, surplus};
}

export function plan(input: PlanInput): Plan {
    const {slots, tank, charge, loss, reserve} = input;
    const n = slots.length;
    const top = heatAt(tank, input.maxC);
    const levels = Math.max(2, Math.round(top / STEP_KWH) + 1);
    const heatPerSlot = charge.heatPerHour * SLOT_H;
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
    const kw = charge.heatPerHour / Math.max(1, charge.cop);
    /** Cost of each choice in slot k from stored heat `kwh`, with or without a charge running. */
    const choices = (k: number, c: number, kwh: number, cap = top) => {
        const slot = slots[k], v = values[k + 1];
        const lost = lossAt(loss, kwh) * SLOT_H;
        const idleAfter = Math.max(0, kwh - slot.draw - lost);
        const idle = Math.max(0, floor - idleAfter) * SHORTFALL_KR_PER_KWH + value(v, 0, idleAfter);
        let heat = INF, q = 0, el = 0;
        if ((c === 1 || !slot.reserved) && kwh < cap - 1e-9) {
            q = Math.min(heatPerSlot, cap - kwh);
            const after = Math.max(0, kwh + q - slot.draw - lost);
            el = q / copAt(charge, tempOf(tank, kwh + q));
            heat = el * effective(slot, kw).price + (c === 0 ? START_KR : 0)
                + Math.max(0, floor - after) * SHORTFALL_KR_PER_KWH + value(v, 1, after);
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
        const heat = choice.heat < INF && (runningTop !== undefined || choice.heat <= choice.idle);
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
    const startNow = !input.charging && first?.start === 0
        && (first.heat >= (input.minChargeKwh ?? MIN_CHARGE_KWH) || input.stored < reserve);
    return {charges, stored, cost, shortfall, startNow};
}

/** Litres of 40 °C water → kWh, for the reserve setting. */
export const reserveKwh = (litres: number) => litres * KWH_PER_LITRE;
