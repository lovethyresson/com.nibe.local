/** The comfort bias: what to feed BT1, beyond the real outdoor temperature, for the pump's own
 *  curve to hold comfort. Pure. Design: docs/autopilot-plan.md §7.3 step 1, tasks/todo.md slice 5.
 *
 *  Autopilot requires room-sensor control off, and without it the curve alone does not hold
 *  comfort: on the S1155 room-off run (2026-11-04…07) indoor drifted ~1.5 K with the weather at
 *  every offset tried. Autopilot replaces the room loop, so holding comfort is its base job and
 *  price shifting is planned on top of this bias.
 *
 *  The pump delivers about `heatPerSupplyK × (supply − indoor)` (planner.ts `pumpHeat`; on the
 *  S1155 that predicts indoor 6 h and 24 h ahead as well as the heat meter does, 0.33/0.47 K
 *  against 0.30/0.46 K RMS). Holding `comfort` at outdoor `te` needs `H·(comfort − te) − gains`,
 *  so the supply that holds it is `comfort + that / heatPerSupplyK`, and the learned curve says
 *  what it must see for that supply. The bias is the real outdoor temperature minus that.
 *
 *  No sun here: easing off ahead of sun is the planner's call, made against the forecast and the
 *  profile's trust in it. */
import type {HouseParams} from './model';
import type {PumpCurve} from './planner';
import {curveInputFor} from './curve';

/** Past these the comfort bias is a model gone wrong, not a house: the feed is held there. */
export const COMFORT_BIAS_RANGE = [-25, 30] as const;

/** Bias that holds `comfort` at `te`, K (pre-heat positive). 0 without a learned curve and
 *  emission, or planning shift-only, where the planner assumes the curve holds comfort by itself. */
export function comfortBias(house: HouseParams, pump: PumpCurve | undefined, comfort: number, te: number): number {
    if (!pump?.supply || pump.shiftOnly || !(pump.heatPerSupplyK! > 0) || !Number.isFinite(te)) return 0;
    const needed = Math.max(0, house.heatLoss * (comfort - te) - house.gains);
    const x = curveInputFor(pump.supply, comfort + needed / pump.heatPerSupplyK!);
    if (x === undefined) return 0;
    return Math.min(COMFORT_BIAS_RANGE[1], Math.max(COMFORT_BIAS_RANGE[0], te - x));
}
