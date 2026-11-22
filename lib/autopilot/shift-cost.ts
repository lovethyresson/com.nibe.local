/** What heating's shifts cost in electricity, from the house model: the same day twice, once with
 *  the BT1 Autopilot fed and once with its average feed held steady (the old way: the same comfort,
 *  nothing moved between hours). The meter gives the day's real use; the model gives only the
 *  difference, so its error in the level of use does not enter the saving.
 *
 *  The difference has two parts:
 *  - per hour, the electricity the shift added or took away, including the lower COP of a warmer
 *    supply (planner.ts `slotCop`);
 *  - at the end, the heat the shifted day left in the house beyond the steady one (air and mass),
 *    as electricity: a pre-heat that leaks away shows up here as heat the old way still has, and a
 *    house heated ahead of tomorrow's expensive morning as heat the old way would have to buy.
 *
 *  Pure; the collector gathers the slots (collector.ts `shiftEffect`). Design: savings.ts. */

import {HouseParams} from './model';
import {PumpCurve, simulate} from './planner';
import {SLOT_MS} from './prices';

export interface ShiftSlot {
    slot: number;
    /** Outdoor °C, and BT1 as the pump saw it. */
    te: number;
    bt1: number;
    /** Indoor °C, where read. */
    ti: number;
    /** Hot water had the compressor (history `dhw` ≥ 0.5). */
    busy: boolean;
    /** Autopilot was feeding BT1 this slot, shifting heat. */
    fed: boolean;
}

export interface ShiftEffect {
    /** kWh of electricity the shift added in each hour (hour start, ms); negative where it saved. */
    hours: Map<number, number>;
    /** kWh of electricity the heat left in the house at the end is worth beyond the steady day's:
     *  positive when the shifted day ends warmer. */
    carry: number;
}

/** Slots a day may miss and still be compared: a reconnect, a late poll. */
export const SHIFT_MISSING = 4;

/** The shift's effect over `slots` (consecutive), or undefined when no slot was fed, the slots
 *  are not consecutive, or indoor was never read. */
export function shiftEffect(house: HouseParams, pump: PumpCurve, slots: ShiftSlot[]): ShiftEffect | undefined {
    if (!slots.length || !slots.some((s) => s.fed)) return undefined;
    if (slots.some((s, k) => k > 0 && s.slot !== slots[k - 1].slot + 1)) return undefined;
    const indoor = slots.map((s) => s.ti).filter(Number.isFinite);
    if (!indoor.length) return undefined;
    const comfort = indoor.reduce((a, b) => a + b, 0) / indoor.length;
    const ti = Number.isFinite(slots[0].ti) ? slots[0].ti : comfort;
    // What the pump fed against the real outdoor: the old way keeps the unfed slots as they were and
    // holds the fed ones at their average, so the comfort Autopilot kept stays and only the moving goes.
    const real = slots.map((s) => s.te - s.bt1);
    const fed = slots.filter((s) => s.fed).map((s) => s.te - s.bt1);
    const steady = fed.reduce((a, b) => a + b, 0) / fed.length;
    const old = slots.map((s, k) => (s.fed ? steady : real[k]));
    const forecast = slots.map((s) => ({te: s.te, sun: 0, price: 0, busy: s.busy}));
    // Both start from the same house and the curve's view of the first slot as it really was.
    const state = {ti, tm: ti, curve: slots[0].bt1, bias: real[0]};
    const shifted = simulate(house, comfort, state, forecast, real, pump);
    const kept = simulate(house, comfort, state, forecast, old, pump);
    const hours = new Map<number, number>();
    slots.forEach((s, k) => {
        const hour = Math.floor(s.slot * SLOT_MS / 3_600_000) * 3_600_000;
        const extra = shifted.heat[k] / shifted.cop[k] - kept.heat[k] / kept.cop[k];
        hours.set(hour, (hours.get(hour) ?? 0) + extra);
    });
    const n = slots.length - 1;
    const stored = house.ci * (shifted.ti[n] - kept.ti[n]) + house.cm * (shifted.tm[n] - kept.tm[n]);
    const cop = kept.heat.reduce((a, b) => a + b, 0) / kept.heat.reduce((a, h, k) => a + h / kept.cop[k], 0);
    return {hours, carry: stored / (Number.isFinite(cop) && cop > 0 ? cop : shifted.cop[n])};
}

/** What the day would have cost the old way: each hour's metered kWh less what the shift added, at
 *  that hour's price, and the heat left over at the day's average price. Undefined without an
 *  effect for every metered hour. */
export function oldWayCost(effect: ShiftEffect, use: Map<number, number>, prices: Map<number, number>, hours: number[],
    mean: number): number | undefined {
    let cost = 0;
    for (const at of hours) {
        const kwh = use.get(at);
        const price = prices.get(at);
        if (kwh === undefined || price === undefined) continue;
        cost += Math.max(0, kwh - (effect.hours.get(at) ?? 0)) * price;
    }
    return Math.round((cost + effect.carry * mean) * 1000) / 1000;
}
