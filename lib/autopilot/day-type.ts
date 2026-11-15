/** The household's day type and Away. Both are household state, not a pump's, so they are one
 *  app setting for the home, set on the Main device or by a Flow and held until changed.
 *
 *  The day type is working or a day off. Away is a separate on/off for a trip: while it is on,
 *  hot water keeps only its safety net and heating goes to its Away temperature, and the day type
 *  is left as it was. A Flow that sets working or free every night (from a calendar or a holiday
 *  variable) therefore never ends a trip. Design: docs/autopilot-hot-water.md §4.2.
 *
 *  Each change of either is kept with its time, so the learner can file every past slot under
 *  the kind of day in force then (`dayTypeAt`: away while Away was on, else the day type).
 *  Without the log a week of free days set on Monday would be learned as working. */

import {DayType, LocalClock} from './hotwater-learner';

/** The two day types the owner sets. The learner's `DayType` adds `away`, which only Away gives. */
export type HomeDayType = 'working' | 'free';
export const HOME_DAY_TYPES = ['working', 'free'] as const;

export const DAY_TYPE_SETTING = 'autopilotDayType';
export const DAY_TYPE_CAPABILITY = 'day_type_NIBE';
/** The day type where neither the owner nor a Flow set one and no clock is at hand. With one,
 *  the calendar decides (`calendarDayType`). */
export const DEFAULT_DAY_TYPE: HomeDayType = 'working';

/** The calendar's day type: Saturday and Sunday are free, the rest working. The default wherever
 *  nothing was set (maintainer, 2026-11-14): before, every day was working until the owner set
 *  one, so a home without a day-type Flow learned one profile for all days, and one whose Flow
 *  started on a Tuesday had every earlier weekend filed as working. Measured that day on the
 *  maintainer's tank, 31 days: weekends 25.9 kWh of hot water heat a day, weekdays 12.7; a
 *  weekend's heat goes in 06–12 (48 %), almost none 18–24 (4 %, weekdays 23 %). */
export function calendarDayType(clock: LocalClock, t: number): HomeDayType {
    const day = new Date(`${clock(t).date}T12:00:00Z`).getUTCDay();
    return day === 0 || day === 6 ? 'free' : 'working';
}
/** Changes kept: years of a type set every day. */
const KEEP = 1000;

/** A day type set. */
export interface DayTypeChange {
    at: number;
    type: HomeDayType;
}

/** Away turned on or off. */
export interface AwayChange {
    at: number;
    on: boolean;
}

export interface DayTypeState {
    /** The type last set. Under the calendar (nothing set) a placeholder: read the type in force
     *  with `dayTypeAt`. */
    type: HomeDayType;
    /** Every day type set, oldest first. */
    log: DayTypeChange[];
    /** Every Away change, oldest first. */
    away?: AwayChange[];
}

export const isDayType = (v: unknown): v is HomeDayType => (HOME_DAY_TYPES as readonly unknown[]).includes(v);

/** The stored state, or undefined when none is stored. */
export function readDayType(stored: unknown): DayTypeState | undefined {
    const s = stored as DayTypeState | undefined;
    if (!s || !isDayType(s.type)) return undefined;
    const log: DayTypeChange[] = Array.isArray(s.log) ? s.log.filter((e) => Number.isFinite(e?.at) && isDayType(e?.type))
        .map((e) => ({at: e.at, type: e.type})) : [];
    const away: AwayChange[] = Array.isArray(s.away) ? s.away.filter((e) => Number.isFinite(e?.at) && typeof e?.on === 'boolean')
        .map((e) => ({at: e.at, on: e.on})) : [];
    return {type: s.type, log, ...away.length ? {away} : {}};
}

/** Whether a type was set: a change logged. Otherwise the calendar decides. */
export function typeSet(state: DayTypeState | undefined): boolean {
    return !!state?.log.length;
}

/** The state after setting `type` at `at`. Setting the type already in force changes nothing.
 *  Away is left as it is. */
export function recordDayType(state: DayTypeState | undefined, type: HomeDayType, at: number): DayTypeState {
    if (state?.type === type && typeSet(state)) return state;
    return {...state, type, log: [...(state?.log ?? []), {at, type}].slice(-KEEP)};
}

/** Whether Away is on now. */
export function awayOn(state: DayTypeState | undefined): boolean {
    return state?.away?.[state.away.length - 1]?.on === true;
}

/** The state after turning Away on or off at `at`. Unchanged when Away already is as asked. */
export function recordAway(state: DayTypeState | undefined, on: boolean, at: number): DayTypeState {
    const base: DayTypeState = state ?? {type: DEFAULT_DAY_TYPE, log: []};
    if (awayOn(base) === on) return base;
    return {...base, away: [...(base.away ?? []), {at, on}].slice(-KEEP)};
}

/** Whether Away was on at `t`. */
export function awayAt(state: DayTypeState | undefined, t: number): boolean {
    let on = false;
    for (const e of state?.away ?? []) {
        if (e.at > t) break;
        on = e.on;
    }
    return on;
}

/** The kind of day at `t`, as the learner files it: away while Away was on; else the last day
 *  type set at or before `t`, or, before the first, the calendar's (`clock`; the default without
 *  one). */
export function dayTypeAt(state: DayTypeState | undefined, t: number, clock?: LocalClock): DayType {
    if (awayAt(state, t)) return 'away';
    return homeDayTypeAt(state, t, clock);
}

/** The day type at `t`, ignoring Away: what the Main device shows. */
export function homeDayTypeAt(state: DayTypeState | undefined, t: number, clock?: LocalClock): HomeDayType {
    let found: DayTypeChange | undefined;
    for (const e of state?.log ?? []) {
        if (e.at > t) break;
        found = e;
    }
    if (found) return found.type;
    return clock ? calendarDayType(clock, t) : DEFAULT_DAY_TYPE;
}
