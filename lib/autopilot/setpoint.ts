/** Autopilot heating holds the thermostat setpoint. Pure.
 *
 *  Autopilot requires room-sensor control off, and without it the curve alone does not hold
 *  comfort: on the S1155 room-off run (2026-11-04…07) indoor drifted ~1.5 K with the weather.
 *  Autopilot replaces the room loop, so it steers the house to the setpoint itself, by adding a
 *  slow "trim" to what it feeds BT1, under the price shift (live.ts). The shift moves heat in
 *  time around the house's level; the trim moves that level to the setpoint.
 *
 *  Why closed loop: the model's gain (heat per K of shift against heat loss) is good, but its
 *  steady level was ~1 K off on the S1155 (tasks/todo.md 2026-11-11), so a model-only trim
 *  (trim.ts `comfortBias`) would hold the wrong temperature. A PI on the measured indoor
 *  temperature corrects whatever the model gets wrong.
 *
 *  The error is the setpoint against the house's 24 h mean: the price shift moves indoor up and
 *  down within the comfort range on purpose, and a day's mean sees through that, so the trim does
 *  not fight the shift. Past the range, indoor now counts instead (a setpoint jump, Away). The
 *  integral moves only while live (in Simulation the pump is not steered, so it would wind up
 *  against a house it cannot move) and only near the setpoint. Away is just another setpoint. */

/** Past this the trim is a model or sensor gone wrong, not a house: the feed is held there. */
export const TRIM_RANGE = 10;
/** K of BT1 per K of indoor, from the model, clamped to what a house plausibly needs. */
export const GAIN_RANGE = [0.5, 3] as const;
/** The integral's rate, K of trim per K of error per hour: closes a 1 K error over ~4 days,
 *  slower than the S1155's ~5 day time constant would let it overshoot. */
export const TRIM_KI = 0.02;
/** The integral learns only this close to the setpoint, K: it holds what the curve gets wrong at
 *  the goal, so a jump (Away and back) neither winds it up nor teaches it the transient. */
export const INTEGRATE_WITHIN = 1;
/** Past the comfort range by this much, K, indoor is off for real, not shifted on purpose: the
 *  trim reads indoor now instead of the day's mean, which lags a setpoint jump by most of a day. */
export const FAST_MARGIN = 0.5;

export interface TrimState {
    /** The integral part, K. */
    integral: number;
}

export interface TrimInput {
    setpoint: number;
    /** The house's indoor mean over the last 24 h, and indoor now. */
    mean: number;
    ti?: number;
    /** How far the price shift may move indoor from the goal on purpose, K (the comfort range). */
    band?: number;
    /** Heat loss, kW per K, and kW of heat per K of BT1 shift: their ratio is the proportional gain. */
    heatLoss: number;
    lever: number;
    /** Hours since the trim last moved (one 15-min slot is 0.25). */
    hours: number;
    /** Live: the integral moves. Simulation: it is held, and only shown. */
    integrate: boolean;
}

/** The proportional gain: how much BT1 shift holds one more K indoors, by the model. */
export function trimGain(heatLoss: number, lever: number): number {
    const g = lever > 0 ? heatLoss / lever : GAIN_RANGE[0];
    return Math.min(GAIN_RANGE[1], Math.max(GAIN_RANGE[0], Number.isFinite(g) ? g : GAIN_RANGE[0]));
}

/** The trim for this slot (K, positive pre-heats: fed colder) and the state to keep. The
 *  integral stops where the total would pass the range, so it never winds up beyond it. */
export function nextTrim(state: TrimState, input: TrimInput): {trim: number; state: TrimState} {
    const now = input.ti !== undefined && Number.isFinite(input.ti) ? input.setpoint - input.ti : undefined;
    const far = now !== undefined && Math.abs(now) > (input.band ?? 0) + FAST_MARGIN;
    const error = far ? now! : input.setpoint - input.mean;
    if (!Number.isFinite(error)) return {trim: clamp(state.integral), state};
    const p = trimGain(input.heatLoss, input.lever) * error;
    let integral = state.integral;
    if (input.integrate && Math.abs(error) <= INTEGRATE_WITHIN) {
        const next = integral + TRIM_KI * error * Math.max(0, input.hours);
        // Anti-windup: integrate only while the total stays in range, or toward it.
        if (Math.abs(p + next) <= TRIM_RANGE || Math.abs(next) < Math.abs(integral)) integral = clamp(next);
    }
    return {trim: clamp(p + integral), state: {integral}};
}

export function readTrim(raw: unknown): TrimState {
    const v = Number((raw as any)?.integral);
    return {integral: Number.isFinite(v) ? clamp(v) : 0};
}

function clamp(v: number): number {
    return Math.min(TRIM_RANGE, Math.max(-TRIM_RANGE, v));
}
