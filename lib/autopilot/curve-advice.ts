/** Heat curve advice: the setpoint trim's learned part, read as a heat curve setting. Pure.
 *
 *  The trim (setpoint.ts) learns how far the owner's heat curve is from holding the setpoint, as K
 *  of fed outdoor temperature. Once it is steady, that is a curve offset to set on the heat pump
 *  (register 30, "set value for heating (curve offset)" in menu 1.1.1 with room-sensor control
 *  off), so the heat pump holds the setpoint on its own whenever Autopilot does not steer: Homey
 *  down, the app restarting, the feed stopped. NIBE's own tip is the same split: a room that is
 *  constantly too warm or cold is the offset (1.1.1); one that changes with the weather is the
 *  slope (1.30.1, register 26). Both from the S-series installer manuals (S1155 IHB EN 2425-2,
 *  SMO S40 2515-3, VVM S320 2235-3, S735 2220-1).
 *
 *  Only the offset is ever written (the owner's Setup choice): it moves the curve by the same
 *  amount in all weather. A slope that is off is advice only, since a curve number changes the
 *  heat differently in every kind of weather. */

/** The curve offset's range on the pump (all the manuals above: −10 – 10). */
export const OFFSET_RANGE = [-10, 10] as const;
/** At most this many offset steps in one change. */
export const MAX_STEPS = 3;
/** Days the model has been ready before the first advice: a week of the trim at the house's pace. */
export const READY_DAYS_BEFORE = 7;
/** The trim's learned part counts as steady when its daily values over this many days stay within
 *  `STEADY_K`, K of fed outdoor. */
export const STEADY_DAYS = 3;
export const STEADY_K = 0.4;
/** Supply K per offset step before the curve fit has measured it (curve.ts `offsetGain`): NIBE's
 *  example, "+2 steps increases the supply temperature by 5 °C". The S1155 measured 1.53, so this
 *  errs towards fewer steps; the trim covers the rest, and the fit measures the real gain once the
 *  offset has moved. */
export const DEFAULT_STEP_K = 2.5;
/** Days between Autopilot's own changes, and between repeating the same advice. */
export const REPEAT_DAYS = 30;
/** Days on a curve the owner changed before advice reads it: the trim's integral settles at the
 *  house's pace, so three steady days alone can be a half-settled trim. */
export const OWNER_SETTLE_DAYS = 7;
/** The slope is off when the learned part moves this many K per K of outdoor temperature, over a
 *  spread of at least `SLOPE_SPREAD_K` of daily outdoor means. */
export const SLOPE_K_PER_K = 0.15;
export const SLOPE_SPREAD_K = 5;
/** Days of samples kept. */
export const KEEP_DAYS = 21;

/** One day: the trim's learned part (K of fed outdoor, positive warms) and the day's mean outdoor. */
export interface CurveSample {
    day: number;
    integral: number;
    te: number;
}

/** What the owner chose in Heating setup: Autopilot changes the offset, or tells them to. */
export type CurveChoice = 'auto' | 'self';

export interface CurveStore {
    choice: CurveChoice;
    samples: CurveSample[];
    /** The last offset change Autopilot made, kept for Undo. */
    adjusted?: {day: number; at: number; from: number; to: number};
    /** The day Autopilot last wrote the offset, a change or an Undo: its month's wait counts from
     *  here. Kept through Undo, which clears `adjusted`. */
    wrote?: number;
    /** The offset last seen on the pump, so a change made while Homey was off still counts. */
    offset?: number;
    /** The day the offset last changed, by anyone: samples before it describe the old curve. */
    changed?: number;
    /** The last advice told, so the same advice is not repeated for `REPEAT_DAYS`. */
    told?: {day: number; to?: number; slope?: Slope};
}

export type Slope = 'steeper' | 'flatter';

export interface Advice {
    from: number;
    to: number;
    /** The supply change the offset is for, K. */
    supplyK: number;
    /** The learned part this advice reads, K of fed outdoor. */
    integral: number;
    slope?: Slope;
}

export function readCurveStore(raw: unknown): CurveStore {
    const r = (raw ?? {}) as Partial<CurveStore>;
    const samples = Array.isArray(r.samples) ? r.samples.filter((s) =>
        s && Number.isFinite(s.day) && Number.isFinite(s.integral) && Number.isFinite(s.te)) : [];
    return {
        // Setup asks; anyone who has not answered is only told, never written for.
        choice: r.choice === 'auto' ? 'auto' : 'self',
        samples,
        ...r.adjusted && Number.isFinite(r.adjusted.from) && Number.isFinite(r.adjusted.to) ? {adjusted: r.adjusted} : {},
        ...Number.isFinite(r.changed) ? {changed: r.changed} : {},
        // Before `wrote` existed, Autopilot's own change was dated by `adjusted`.
        ...Number.isFinite(r.wrote) ? {wrote: r.wrote} : Number.isFinite(r.adjusted?.day) ? {wrote: r.adjusted!.day} : {},
        ...Number.isFinite(r.offset) ? {offset: r.offset} : {},
        ...r.told && Number.isFinite(r.told.day) ? {told: r.told} : {},
    };
}

/** Today's sample in, one per day (the latest of the day wins), the last `KEEP_DAYS` kept. */
export function addSample(samples: CurveSample[], sample: CurveSample): CurveSample[] {
    return [...samples.filter((s) => s.day !== sample.day && s.day > sample.day - KEEP_DAYS), sample]
        .sort((a, b) => a.day - b.day);
}

export interface AdviceInput {
    today: number;
    samples: CurveSample[];
    /** Days since the house model became ready; undefined while it learns. */
    readyDays?: number;
    /** The curve offset (register 30) now. */
    offset?: number;
    /** Supply K per K of outdoor where the house has been lately (curve.ts `gainBetween`). */
    curveGain?: number;
    /** Supply K per offset step, when the curve fit has measured it. */
    stepK?: number;
    /** The day the offset last changed, by anyone: only samples after it describe this curve. */
    changed?: number;
    /** The day Autopilot itself last wrote the offset (`CurveStore.wrote`): it changes it at most
     *  once a month. A change by the owner does not wait the month (2026-11-21: the owner's own +6
     *  on 14 Nov held the advice until 14 Dec), only `OWNER_SETTLE_DAYS` on the new curve. */
    wrote?: number;
}

/** The advice for today, or undefined when there is none yet (or none needed). */
export function curveAdvice(input: AdviceInput): Advice | undefined {
    const {today, readyDays, offset, curveGain} = input;
    if (readyDays === undefined || readyDays < READY_DAYS_BEFORE) return undefined;
    if (input.wrote !== undefined && today - input.wrote < REPEAT_DAYS) return undefined;
    if (input.changed !== undefined && today - input.changed < OWNER_SETTLE_DAYS) return undefined;
    if (offset === undefined || !Number.isFinite(offset) || curveGain === undefined || !(curveGain > 0)) return undefined;
    // Only what the curve as it now is has seen.
    const since = input.samples.filter((s) => input.changed === undefined || s.day > input.changed);
    const recent = since.filter((s) => s.day > today - STEADY_DAYS);
    if (recent.length < STEADY_DAYS) return undefined;
    const values = recent.map((s) => s.integral);
    if (Math.max(...values) - Math.min(...values) > STEADY_K) return undefined;
    const integral = values.reduce((a, b) => a + b, 0) / values.length;
    // Positive learned part: the house needs more heat than the curve gives, a higher offset.
    const supplyK = integral * curveGain;
    const stepK = input.stepK !== undefined && input.stepK > 0 ? input.stepK : DEFAULT_STEP_K;
    const steps = Math.max(-MAX_STEPS, Math.min(MAX_STEPS, Math.round(supplyK / stepK)));
    const to = Math.max(OFFSET_RANGE[0], Math.min(OFFSET_RANGE[1], offset + steps));
    const slope = slopeOf(since);
    if (to === offset && !slope) return undefined;
    return {from: offset, to, supplyK, integral, ...slope ? {slope} : {}};
}

/** Whether the learned part grows with the cold (curve too flat: steeper) or with the warmth
 *  (too steep: flatter), from a least-squares line through the daily samples. */
export function slopeOf(samples: CurveSample[]): Slope | undefined {
    if (samples.length < STEADY_DAYS * 2) return undefined;
    const te = samples.map((s) => s.te);
    if (Math.max(...te) - Math.min(...te) < SLOPE_SPREAD_K) return undefined;
    const mx = te.reduce((a, b) => a + b, 0) / te.length;
    const my = samples.reduce((a, s) => a + s.integral, 0) / samples.length;
    let sxy = 0, sxx = 0;
    for (const s of samples) { sxy += (s.te - mx) * (s.integral - my); sxx += (s.te - mx) ** 2; }
    const b = sxy / sxx;
    if (Math.abs(b) < SLOPE_K_PER_K) return undefined;
    return b < 0 ? 'steeper' : 'flatter';
}

/** Whether this advice is news: not told in the last `REPEAT_DAYS`, or different from then. */
export function isNews(advice: Advice, told: CurveStore['told'], today: number): boolean {
    if (!told || today - told.day >= REPEAT_DAYS) return true;
    return told.to !== advice.to || told.slope !== advice.slope;
}

/** How much the trim's learned part moves when the offset changes by `steps`: the curve now gives
 *  that much more heat itself, so the trim gives that much less, K of fed outdoor. Without it the
 *  two would correct the same error for a day and the house would run warm. */
export function trimShiftFor(steps: number, curveGain: number | undefined, stepK: number | undefined): number {
    if (!Number.isFinite(steps) || steps === 0 || curveGain === undefined || !(curveGain > 0)) return 0;
    const k = stepK !== undefined && stepK > 0 ? stepK : DEFAULT_STEP_K;
    return -steps * k / curveGain;
}
