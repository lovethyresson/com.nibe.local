/** Autopilot heating's first weeks, shown to the owner. Pure.
 *
 *  When Autopilot heating starts, room-sensor control is off and the owner's heat curve holds the
 *  house alone, often some way from the thermostat. The setpoint trim (setpoint.ts) closes that gap
 *  at the house's own pace: a day or two for a light house, more than a week for a heavy one
 *  (the S1155's 115 h, 2026-11-22). Until then indoor can sit up to about 1 °C off, which reads as
 *  "Autopilot is getting it wrong" unless the owner can see it moving the right way.
 *
 *  So each morning the day before is scored: its indoor mean against the thermostat. A timeline
 *  message says it, and the Getting started widget draws the days. Two days in a row within
 *  `SETTLED_K` is settled: one last message, and the widget says so. A day whose setpoint moved
 *  (Away, the owner's thermostat) is skipped: its mean is no reading of the level. After
 *  `MAX_DAYS` it stops; the heat curve advice (curve-advice.ts) covers a curve that stays off. */

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
    const previous = state.days[state.days.length - 1];
    const days = [...state.days, day];
    const recent = days.slice(-SETTLED_DAYS);
    if (recent.length === SETTLED_DAYS && recent.every((d) => Math.abs(d.mean - d.setpoint) <= SETTLED_K + 1e-9))
        return {state: {...checked, days, settled: day.date}, event: {kind: 'settled', day}};
    if (days.length >= MAX_DAYS) return {state: {...checked, days, stopped: day.date}, event: {kind: 'stopped', day}};
    return {state: {...checked, days}, event: {kind: 'progress', day, ...previous ? {previous} : {}}};
}

/** The stored state, or undefined when there is none worth keeping. */
export function readSettle(raw: unknown): SettleState | undefined {
    const r = raw as Partial<SettleState> | null | undefined;
    if (!r || typeof r.start !== 'string') return undefined;
    const days = Array.isArray(r.days) ? r.days.filter((d) => d && typeof d.date === 'string'
        && Number.isFinite(d.mean) && Number.isFinite(d.setpoint)) : [];
    return {start: r.start, days, ...typeof r.checked === 'string' ? {checked: r.checked} : {},
        ...typeof r.settled === 'string' ? {settled: r.settled} : {}, ...typeof r.stopped === 'string' ? {stopped: r.stopped} : {}};
}

/** The change from the day before, one decimal, and its direction. */
export function change(day: SettleDay, previous?: SettleDay): {delta: number; dir: 'up' | 'down' | 'same'} | undefined {
    if (!previous) return undefined;
    const delta = round1(day.mean - previous.mean);
    return {delta: Math.abs(delta), dir: delta > 0 ? 'up' : delta < 0 ? 'down' : 'same'};
}

const round1 = (v: number) => Math.round(v * 10) / 10;
