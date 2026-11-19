/** Autopilot heating holds the thermostat setpoint. Pure.
 *
 *  Autopilot requires room-sensor control off, and without it the curve alone does not hold
 *  comfort: on the S1155 room-off run (2026-11-04…07) indoor drifted ~1.5 K with the weather.
 *  Autopilot replaces the room loop. The price planner plans around the thermostat (live.ts): its
 *  comfort band is setpoint ± the comfort range, heat below the setpoint is owed, and its
 *  expected indoor path heads for the setpoint. Its shift-only model assumes that feeding the real
 *  outdoor temperature holds the setpoint; on a real house it holds whatever level the curve
 *  gives. The trim here is that difference, from measured indoor temperature, fed under the
 *  planner's shift, so "no shift" really does hold the setpoint.
 *
 *  Why measured, not modelled: the model's steady level was ~1 K off on the S1155 (tasks/todo.md
 *  2026-11-11), so a model-only trim (trim.ts `comfortBias`) would hold the wrong temperature.
 *
 *  The error is the setpoint against the house's 24 h mean: the planner moves indoor within the
 *  comfort range on purpose, and a day's mean sees through that. The trim is a PI controller on
 *  that error (2026-11-19, after the S1155 held 21.9–22.2 °C against 22.5 for days with the old
 *  integral-only trim):
 *  - Proportional: `TRIM_KP` K of trim per K of error, at once. What the old trim lacked: on a
 *    light house it was slow, and on a heavy one the house's lag carried it past the target.
 *  - Integral: the rest, learned at `TRIM_SPEED` divided by the house's own time constant, so a
 *    heavy house is corrected more slowly than a light one. It pauses while the error is already
 *    shrinking (`RECOVERY_H`): the house is catching up, and adding more would overshoot.
 *  - After the setpoint changes (Away starting or ending, the owner's thermostat) the trim holds
 *    still for `SETTLE_H`: the 24 h mean still holds the old target's hours, and read as an error
 *    it would add warmth to a house the planner has already brought there. Beyond `HOLD_BEYOND`
 *    of error it holds still too. The planner does the jump, the trim the level.
 *  Chosen on 200 simulated houses (light to slab-heavy, curves 40 % too flat to 20 % too steep,
 *  model numbers off by up to 40 %, cold spells and ±7 K weather swings, ±0.2 K sensor noise):
 *  better than the integral-only trim on 194–200 of them and worse on none
 *  (dev/simulate-trim.ts). The gain starts to misbehave at 5; 2 leaves that margin.
 *
 *  The integral learns only while live (in Simulated the pump is not steered, so it would wind up
 *  against a house it cannot move); the proportional part is shown either way. */

/** Past this the trim is a model or sensor gone wrong, not a house: the feed is held there. */
export const TRIM_RANGE = 10;
/** K of trim per K of 24 h mean error, applied at once. */
export const TRIM_KP = 2;
/** The integral closes an error in about 1/TRIM_SPEED of the house's time constant. */
export const TRIM_SPEED = 4;
/** The time constant used when the house's is unknown, and the range one is trusted in, hours. */
export const DEFAULT_TAU_H = 72;
export const TAU_RANGE_H = [12, 14 * 24] as const;
/** Further than this from the setpoint the trim holds still, K. */
export const HOLD_BEYOND = 2;
/** A setpoint change of more than `SETPOINT_STEP` holds the trim still this long, hours. */
export const SETTLE_H = 24;
export const SETPOINT_STEP = 0.2;
/** The error is compared with this many hours ago: smaller by `RECOVERING_K` means recovering. */
export const RECOVERY_H = 6;
export const RECOVERING_K = 0.02;

export interface TrimState {
    /** The learned part of the trim, K (positive pre-heats: fed colder). Kept across restarts. */
    integral: number;
    /** Recent errors with their age, hours, for the recovery test. In memory only. */
    recent?: {error: number; age: number}[];
    /** The trim last given, held while the error is beyond `HOLD_BEYOND`. In memory only. */
    last?: number;
    /** The setpoint last seen, and hours left holding still after it changed. In memory only. */
    setpoint?: number;
    settling?: number;
}

export interface TrimInput {
    setpoint: number;
    /** The house's indoor mean over the last 24 h. */
    mean: number;
    /** Hours since the trim last moved (one 15-min slot is 0.25). */
    hours: number;
    /** Live: the trim learns. Simulated: the learned part is held, and the trim only shown. */
    integrate: boolean;
    /** The house's envelope time constant, hours (model.ts `envelopeTau`); a default without one. */
    tauHours?: number;
}

/** The trim for this slot and the state to keep. */
export function nextTrim(state: TrimState, input: TrimInput): {trim: number; state: TrimState} {
    const error = input.setpoint - input.mean;
    const hours = Math.max(0, Number.isFinite(input.hours) ? input.hours : 0);
    const changed = state.setpoint !== undefined && Math.abs(input.setpoint - state.setpoint) > SETPOINT_STEP;
    const settling = changed ? SETTLE_H : Math.max(0, (state.settling ?? 0) - hours);
    if (!Number.isFinite(error) || Math.abs(error) > HOLD_BEYOND || settling > 0) {
        // A jump, a new setpoint, or no mean: hold what was given. The recovery history starts over.
        const held = state.last ?? clamp(state.integral);
        return {trim: held, state: {integral: state.integral, recent: [], last: held, setpoint: input.setpoint, settling}};
    }
    const aged = (state.recent ?? []).map((r) => ({error: r.error, age: r.age + hours}));
    const before = [...aged].reverse().find((r) => r.age >= RECOVERY_H);
    const recovering = before !== undefined && Math.abs(error) < Math.abs(before.error) - RECOVERING_K;
    let integral = state.integral;
    if (input.integrate && !recovering) integral = clamp(integral + error * hours * TRIM_SPEED / tau(input.tauHours));
    const trim = clamp(integral + TRIM_KP * error);
    // Keep the readings younger than the window and the youngest one past it.
    const recent = [...aged.filter((r) => r.age < RECOVERY_H), ...before ? [before] : [], {error, age: 0}]
        .sort((a, b) => b.age - a.age);
    return {trim, state: {integral, recent, last: trim, setpoint: input.setpoint, settling: 0}};
}

function tau(hours: number | undefined): number {
    if (hours === undefined || !Number.isFinite(hours)) return DEFAULT_TAU_H;
    return Math.min(TAU_RANGE_H[1], Math.max(TAU_RANGE_H[0], hours));
}

export function readTrim(raw: unknown): TrimState {
    const v = Number((raw as any)?.integral);
    return {integral: Number.isFinite(v) ? clamp(v) : 0};
}

function clamp(v: number): number {
    return Math.min(TRIM_RANGE, Math.max(-TRIM_RANGE, v));
}
