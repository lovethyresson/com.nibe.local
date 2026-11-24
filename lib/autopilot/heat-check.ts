/** The daily heat check: the house model's heat loss against the heat meter. Pure. Logged only.
 *
 *  The model is fitted on how indoor temperature moves (house.ts `fitHouse`). Indoor alone cannot
 *  tell more heat loss with more free gains from less of both, and on the S1155 (2026-11-16…18)
 *  the fit settled about 10 % low: the plan expected less heat than the meter delivered, Plan vs
 *  actual ran 13–16 % low, and the house sat below target.
 *
 *  Adding the model's two equations (air and mass) gives a balance for any stretch of time:
 *
 *      heat in + (gains + sun) × hours − heat loss × Σ(indoor − outdoor) × Δt = heat stored
 *
 *  with heat stored = Ci × change of air temperature + Cm × change of mass temperature. Over a day
 *  the heat in is the meter's (1577, hot water taken out), so the balance gives the heat loss the
 *  meter supports, with the model's own gains, sun and capacities. When the last `CHECK_DAYS`
 *  complete days disagree with the model by more than `CHECK_TOLERANCE` together, it gives the
 *  meter's heat loss.
 *
 *  From 2026-11-08 to 11-24 the plan used that heat loss in place of the fitted one. It was
 *  dropped on 2026-11-24 (tasks/drift-analysis-2026-11-24.md):
 *  - it flipped on and off between hourly fits, moving the plan's heat loss about 7 % each way;
 *  - with it, a 5-day open-loop prediction erred by 1.42 K rms, against 0.98 K without
 *    (dev/fit-stability.mjs);
 *  - predicting a day's metered heat from the days before, it missed by 9.7 % against 9.6 % for
 *    the fitted heat loss (dev/energy-window.mjs). The day's own weather and use dominate.
 *  It stays for the "Autopilot model:" log line, as the meter's view of the fit. */
import {HouseParams, ModelSlot, solarGain} from './model';

const DAY_SLOTS = 96;
const SLOT_H = 0.25;
/** Complete days the check looks at, newest first. */
export const CHECK_DAYS = 3;
/** The model's heat for those days may be this far off the meter's before it is corrected. */
export const CHECK_TOLERANCE = 0.05;
/** A day counts with at least this many slots of indoor and outdoor known. */
export const MIN_DAY_SLOTS = 92;
/** Indoor above outdoor, summed over the days, K·h: below this the heat loss is not measurable
 *  (a mild spell, when heat is mostly gains and sun). 5 K on average over 3 days. */
export const MIN_DEGREE_HOURS = CHECK_DAYS * 24 * 5;
/** A balance outside this share of the fitted heat loss is a meter or sensor fault, not a house. */
export const PLAUSIBLE = [0.5, 2] as const;

export interface HeatCheckDay {
    /** Day number (slot ÷ 96). */
    day: number;
    /** kWh the meter delivered and the model says the house needed. */
    metered: number;
    modelled: number;
}

export interface HeatCheck {
    days: HeatCheckDay[];
    /** Metered over modelled heat, all days together. */
    ratio?: number;
    /** The heat loss the meter supports, kW/K; set when it differs by more than the tolerance. */
    heatLoss?: number;
    /** Why there is no correction, when there is none. */
    skip?: 'days' | 'mild' | 'agrees' | 'implausible';
}

export interface DaySums {day: number; metered: number; degreeHours: number; free: number; stored: number}

/** The check over the newest complete days of `slots`, with `states` the filter's [air, mass] per
 *  slot. The current (unfinished) day is left out. */
export function heatCheck(p: HouseParams, slots: ModelSlot[], states: Map<number, [number, number]>): HeatCheck {
    const byDay = new Map<number, ModelSlot[]>();
    for (const s of slots) {
        const day = Math.floor(s.slot / DAY_SLOTS);
        (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(s);
    }
    const newest = Math.max(...byDay.keys());
    const sums: DaySums[] = [];
    for (const day of [...byDay.keys()].sort((a, b) => b - a)) {
        if (day >= newest || sums.length >= CHECK_DAYS) continue;
        const d = daySums(p, day, byDay.get(day)!, states);
        if (d) sums.push(d);
    }
    const days = sums.map((d) => ({day: d.day, metered: round(d.metered), modelled: round(p.heatLoss * d.degreeHours - d.free + d.stored)}));
    if (sums.length < CHECK_DAYS) return {days, skip: 'days'};
    const total = (k: keyof DaySums) => sums.reduce((a, d) => a + d[k], 0);
    const metered = total('metered'), degreeHours = total('degreeHours'), free = total('free'), stored = total('stored');
    const modelled = p.heatLoss * degreeHours - free + stored;
    const ratio = modelled > 0 ? metered / modelled : undefined;
    if (degreeHours < MIN_DEGREE_HOURS || ratio === undefined) return {days, ratio, skip: 'mild'};
    if (Math.abs(ratio - 1) <= CHECK_TOLERANCE) return {days, ratio, skip: 'agrees'};
    const heatLoss = (metered + free - stored) / degreeHours;
    if (!(heatLoss >= PLAUSIBLE[0] * p.heatLoss && heatLoss <= PLAUSIBLE[1] * p.heatLoss)) return {days, ratio, skip: 'implausible'};
    return {days, ratio, heatLoss};
}

export function daySums(p: HouseParams, day: number, slots: ModelSlot[], states: Map<number, [number, number]>): DaySums | undefined {
    const known = slots.filter((s) => Number.isFinite(s.ti) && Number.isFinite(s.inputs.te) && Number.isFinite(s.inputs.q));
    const first = DAY_SLOTS * day, last = first + DAY_SLOTS - 1;
    const start = states.get(first - 1) ?? states.get(first), end = states.get(last);
    if (known.length < MIN_DAY_SLOTS || !start || !end) return undefined;
    // Missing slots are filled by the day's mean, so a short gap does not shorten the day.
    const scale = DAY_SLOTS / known.length;
    let metered = 0, degreeHours = 0, free = 0;
    for (const s of known) {
        metered += s.inputs.q;
        degreeHours += (s.ti - s.inputs.te) * SLOT_H;
        free += (p.gains + solarGain(p, s.inputs)) * SLOT_H;
    }
    const stored = p.ci * (end[0] - start[0]) + p.cm * (end[1] - start[1]);
    return {day, metered: metered * scale, degreeHours: degreeHours * scale, free: free * scale, stored};
}

function round(v: number): number {
    return Math.round(v * 10) / 10;
}
