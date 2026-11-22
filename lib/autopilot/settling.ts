/** Autopilot heating's first weeks, shown to the owner, in four steps. Pure.
 *
 *  1. Learning: the house model learns (collector.ts `readyAt`). The trim already holds the level.
 *  2. Settling: the trim brings the house to the thermostat (below).
 *  3. Calibrating: the heat curve advice (curve-advice.ts) changes the offset or asks the owner to,
 *     then `CHECK_DAYS` in a row holding the thermostat end it. A curve that already fits ends it
 *     at once.
 *  4. Saving: price shifting. Until then the feed holds the level without shifting
 *     (live.ts `holdShift`), so the house reaching the thermostat and the curve's check are
 *     never mixed up with a shift, and what the owner is told each morning is the level alone.
 *
 *  Settling. When Autopilot heating starts, room-sensor control is off and the owner's heat curve holds the
 *  house alone, often some way from the thermostat. The setpoint trim (setpoint.ts) closes that gap
 *  at the house's own pace: a day or two for a light house, more than a week for a heavy one
 *  (the S1155's 115 h, 2026-11-22). Until then indoor can sit up to about 1 °C off, which reads as
 *  "Autopilot is getting it wrong" unless the owner can see it moving the right way.
 *
 *  So each morning the day before is scored: its indoor mean against the thermostat. A timeline
 *  message says it, and the Getting started widget draws the days. Two days in a row within
 *  `SETTLED_K` is settled. A day whose setpoint moved (Away, the owner's thermostat) is skipped:
 *  its mean is no reading of the level. A new thermostat starts it over. After `MAX_DAYS` it
 *  stops and calibrating starts: a curve that far off is what the curve advice is for. */

/** A day's mean this close to the setpoint counts as holding it, K. */
export const SETTLED_K = 0.2;
/** Days in a row that settle it. */
export const SETTLED_DAYS = 2;
/** Days scored before it stops on its own. */
export const MAX_DAYS = 21;
/** A day needs this share of its quarter-hours read to be scored. */
export const MIN_COVERAGE = 0.75;
/** A setpoint that moved more than this within the day skips the day, K. */
export const SETPOINT_MOVED_K = 0.2;
/** Days in a row holding the thermostat after a curve change that end calibrating. */
export const CHECK_DAYS = 3;
/** Days the owner has to change the curve offset they were asked to before Autopilot goes on
 *  without it: the trim covers the difference meanwhile. */
export const ASK_WAIT_DAYS = 7;
/** Days calibrating waits for a verdict, or for its check, before it ends on its own. */
export const CALIBRATE_MAX_DAYS = 14;

export type Step = 'learning' | 'settling' | 'calibrating' | 'saving';

export interface SettleDay {
    /** Local date. */
    date: string;
    /** Indoor mean, °C, one decimal. */
    mean: number;
    /** The thermostat that day, °C. */
    setpoint: number;
}

export interface SettleState {
    /** The local date Autopilot heating started; the first scored day is the next one. */
    start: string;
    days: SettleDay[];
    /** The last date scored or skipped, so each day is looked at once. */
    checked?: string;
    /** Set when it ended: settled on that date, or stopped after MAX_DAYS. */
    settled?: string;
    stopped?: string;
    /** The date settling started over on a new thermostat. */
    restarted?: string;
    /** Step 3, from the date settling ended. `days` are the days scored since a curve change. */
    calibrating?: Calibrating;
    /** Step 4: the date it started, and whether the curve already fit. */
    live?: string;
    fits?: boolean;
}

export interface Calibrating {
    start: string;
    days: CheckDay[];
    checked?: string;
}

export interface CheckDay extends SettleDay {
    ok: boolean;
}

/** What the heat curve advice says, as local dates. */
export interface CurveView {
    /** The latest verdict is that the curve fits. */
    fits: boolean;
    /** The date the offset last changed, by anyone. */
    changed?: string;
    /** The date the owner was asked to change it. */
    asked?: string;
}

/** A day's readings as the collector gives them. */
export interface DayReading {
    date: string;
    mean?: number;
    /** Quarter-hours with an indoor reading, of 96 (92 or 100 on a clock change). */
    slots: number;
    setMin?: number;
    setMax?: number;
}

export type SettleEvent =
    | {kind: 'progress'; day: SettleDay; previous?: SettleDay}
    | {kind: 'settled'; day: SettleDay}
    | {kind: 'stopped'; day: SettleDay};

export type LiveReason = 'fits' | 'steady' | 'asked' | 'timeout';

export function settleDone(state: SettleState | undefined): boolean {
    return !!state && (state.settled !== undefined || state.stopped !== undefined);
}

/** Score one finished day. Returns the new state and what to tell, or no event when the day is
 *  skipped (before the start, too few readings, a moved setpoint) or it has already ended. */
export function scoreDay(state: SettleState, reading: DayReading): {state: SettleState; event?: SettleEvent} {
    if (settleDone(state) || reading.date <= state.start || (state.checked && reading.date <= state.checked))
        return {state};
    const checked = {...state, checked: reading.date};
    const moved = reading.setMin === undefined || reading.setMax === undefined
        || reading.setMax - reading.setMin > SETPOINT_MOVED_K;
    if (reading.mean === undefined || !Number.isFinite(reading.mean) || reading.slots < 96 * MIN_COVERAGE || moved)
        return {state: checked};
    const day: SettleDay = {date: reading.date, mean: round1(reading.mean), setpoint: round1(reading.setMax!)};
    let previous: SettleDay | undefined = state.days[state.days.length - 1];
    // A new thermostat: the days so far were heading somewhere else, so settling starts over.
    if (previous && Math.abs(previous.setpoint - day.setpoint) > SETPOINT_MOVED_K) {
        return {state: {...checked, days: [day], restarted: day.date}, event: {kind: 'progress', day}};
    }
    const days = [...state.days, day];
    const recent = days.slice(-SETTLED_DAYS);
    if (recent.length === SETTLED_DAYS && recent.every((d) => Math.abs(d.mean - d.setpoint) <= SETTLED_K + 1e-9))
        return {state: {...checked, days, settled: day.date, calibrating: {start: day.date, days: []}}, event: {kind: 'settled', day}};
    // The trim could not close it: a curve far off is calibrating's to fix.
    if (days.length >= MAX_DAYS) {
        return {state: {...checked, days, stopped: day.date, calibrating: {start: day.date, days: []}}, event: {kind: 'stopped', day}};
    }
    return {state: {...checked, days}, event: {kind: 'progress', day, ...previous ? {previous} : {}}};
}

/** Where the owner is. `ready`: the house model has met its readiness test. */
export function stepOf(state: SettleState | undefined, ready: boolean): Step {
    if (state?.live) return 'saving';
    if (!ready) return 'learning';
    return settleDone(state) ? 'calibrating' : 'settling';
}

/** Days in a row holding the thermostat at the end of the check. */
export function streak(days: CheckDay[]): number {
    let n = 0;
    for (let k = days.length - 1; k >= 0 && days[k].ok; k--) n++;
    return n;
}

/** Step 3, one finished day: a curve that fits ends it; after a change, `CHECK_DAYS` in a row
 *  holding the thermostat do; an owner who has not changed the offset within `ASK_WAIT_DAYS`, or
 *  no verdict within `CALIBRATE_MAX_DAYS`, end it too. */
export function calibrateDay(state: SettleState, reading: DayReading, curve: CurveView):
    {state: SettleState; event?: {kind: 'live'; reason: LiveReason}} {
    const end = settleDone(state) ? state.settled ?? state.stopped! : undefined;
    if (end === undefined || state.live || reading.date <= end) return {state};
    const cal: Calibrating = state.calibrating ?? {start: end, days: []};
    if (cal.checked && reading.date <= cal.checked) return {state};
    const next: Calibrating = {...cal, checked: reading.date};
    const live = (reason: LiveReason, c = next) =>
        ({state: {...state, calibrating: c, live: reading.date, ...reason === 'fits' ? {fits: true} : {}}, event: {kind: 'live' as const, reason}});
    // Only a change since Autopilot heating started is calibrating's: an older one is the curve it learned on.
    const changed = curve.changed !== undefined && curve.changed > state.start ? curve.changed : undefined;
    if (!changed && curve.fits) return live('fits');
    if (changed) {
        const keep = {state: {...state, calibrating: next}};
        if (reading.date <= changed) return keep;
        const moved = reading.setMin === undefined || reading.setMax === undefined || reading.setMax - reading.setMin > SETPOINT_MOVED_K;
        if (reading.mean !== undefined && Number.isFinite(reading.mean) && reading.slots >= 96 * MIN_COVERAGE && !moved) {
            const day = {date: reading.date, mean: round1(reading.mean), setpoint: round1(reading.setMax!)};
            const days = [...cal.days, {...day, ok: Math.abs(day.mean - day.setpoint) <= SETTLED_K + 1e-9}];
            next.days = days;
            if (streak(days) >= CHECK_DAYS) return live('steady', next);
        }
        return daysBetween(changed, reading.date) >= CALIBRATE_MAX_DAYS ? live('timeout') : {state: {...state, calibrating: next}};
    }
    if (curve.asked && daysBetween(curve.asked, reading.date) >= ASK_WAIT_DAYS) return live('asked');
    if (daysBetween(cal.start, reading.date) >= CALIBRATE_MAX_DAYS) return live('timeout');
    return {state: {...state, calibrating: next}};
}

/** Whole days from one local date to another. */
export function daysBetween(from: string, to: string): number {
    return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

/** The stored state, or undefined when there is none worth keeping. */
export function readSettle(raw: unknown): SettleState | undefined {
    const r = raw as Partial<SettleState> | null | undefined;
    if (!r || typeof r.start !== 'string') return undefined;
    const days = Array.isArray(r.days) ? r.days.filter((d) => d && typeof d.date === 'string'
        && Number.isFinite(d.mean) && Number.isFinite(d.setpoint)) : [];
    const cal = r.calibrating;
    const calibrating = cal && typeof cal.start === 'string' ? {start: cal.start,
        days: Array.isArray(cal.days) ? cal.days.filter((d) => d && typeof d.date === 'string' && Number.isFinite(d.mean)
            && Number.isFinite(d.setpoint)).map((d) => ({...d, ok: !!d.ok})) : [],
        ...typeof cal.checked === 'string' ? {checked: cal.checked} : {}} : undefined;
    const text = (k: 'checked' | 'settled' | 'stopped' | 'restarted' | 'live') => (typeof r[k] === 'string' ? {[k]: r[k]} : {});
    return {start: r.start, days, ...text('checked'), ...text('settled'), ...text('stopped'), ...text('restarted'),
        ...calibrating ? {calibrating} : {}, ...text('live'), ...r.fits === true ? {fits: true} : {}};
}

/** The change from the day before, one decimal, and its direction. */
export function change(day: SettleDay, previous?: SettleDay): {delta: number; dir: 'up' | 'down' | 'same'} | undefined {
    if (!previous) return undefined;
    const delta = round1(day.mean - previous.mean);
    return {delta: Math.abs(delta), dir: delta > 0 ? 'up' : delta < 0 ? 'down' : 'same'};
}

const round1 = (v: number) => Math.round(v * 10) / 10;
