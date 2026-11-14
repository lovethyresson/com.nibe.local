/** Autopilot heating holds the thermostat setpoint. Pure.
 *
 *  Autopilot requires room-sensor control off, and without it the curve alone does not hold
 *  comfort: on the S1155 room-off run (2026-11-04…07) indoor drifted ~1.5 K with the weather.
 *  Autopilot replaces the room loop. The price planner plans around the thermostat (live.ts): its
 *  comfort band is setpoint ± the comfort range, heat below the setpoint is owed, and its
 *  expected indoor path heads for the setpoint. Its shift-only model assumes that feeding the real
 *  outdoor temperature holds the setpoint; on a real house it holds whatever level the curve
 *  gives. The trim here is that difference, learned from measured indoor temperature and fed
 *  under the planner's shift, so "no shift" really does hold the setpoint.
 *
 *  Why learned, not modelled: the model's steady level was ~1 K off on the S1155 (tasks/todo.md
 *  2026-11-11), so a model-only trim (trim.ts `comfortBias`) would hold the wrong temperature.
 *
 *  The error is the setpoint against the house's 24 h mean: the planner moves indoor within the
 *  comfort range on purpose, and a day's mean sees through that. The trim learns only while live
 *  (in Simulated the pump is not steered, so it would wind up against a house it cannot move) and
 *  only within 1 K of the setpoint, so a jump such as Away and back neither winds it up nor
 *  teaches it the transient: the planner does the steering, the trim the level. */

/** Past this the trim is a model or sensor gone wrong, not a house: the feed is held there. */
export const TRIM_RANGE = 10;
/** K of trim per K of error per hour: closes a level error over a few days, slower than the
 *  S1155's ~5 day time constant would let it overshoot. */
export const TRIM_KI = 0.02;
/** The trim learns only this close to the setpoint, K. */
export const INTEGRATE_WITHIN = 1;

export interface TrimState {
    /** The learned trim, K (positive pre-heats: fed colder). */
    integral: number;
}

export interface TrimInput {
    setpoint: number;
    /** The house's indoor mean over the last 24 h. */
    mean: number;
    /** Hours since the trim last moved (one 15-min slot is 0.25). */
    hours: number;
    /** Live: the trim learns. Simulated: it is held, and only shown. */
    integrate: boolean;
}

/** The trim for this slot and the state to keep. */
export function nextTrim(state: TrimState, input: TrimInput): {trim: number; state: TrimState} {
    const error = input.setpoint - input.mean;
    let integral = state.integral;
    if (input.integrate && Number.isFinite(error) && Math.abs(error) <= INTEGRATE_WITHIN)
        integral = clamp(integral + TRIM_KI * error * Math.max(0, input.hours));
    return {trim: clamp(integral), state: {integral}};
}

export function readTrim(raw: unknown): TrimState {
    const v = Number((raw as any)?.integral);
    return {integral: Number.isFinite(v) ? clamp(v) : 0};
}

function clamp(v: number): number {
    return Math.min(TRIM_RANGE, Math.max(-TRIM_RANGE, v));
}
