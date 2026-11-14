/** The household's day type: working, free or away. Set by the owner on the Main device or by a
 *  Flow, and held until changed. Household state, not a pump's, so it is one app setting for the
 *  home, and Away is the home's one Away: hot water keeps only its safety net and heating goes to
 *  its Away temperature. Design: docs/autopilot-hot-water.md §4.2.
 *
 *  Away is a trip, not a kind of day: a Flow that sets working or free every night (from a
 *  calendar or a holiday variable) must not end it. While away such a Flow only updates `base`,
 *  the type the home goes back to when Away is turned off.
 *
 *  Each change is kept with its time, so the learner can file every past slot under the type in
 *  force then. Without the log a week of free days set on Monday would be learned as working. */

import {DAY_TYPES, DayType, LocalClock} from './hotwater-learner';

export const DAY_TYPE_SETTING = 'autopilotDayType';
export const DAY_TYPE_CAPABILITY = 'day_type_NIBE';
/** The day type where neither the owner nor a Flow set one and no clock is at hand. With one,
 *  the calendar decides (`calendarDayType`). */
export const DEFAULT_DAY_TYPE: DayType = 'working';

/** The calendar's day type: Saturday and Sunday are free, the rest working. The default wherever
 *  nothing was set (maintainer, 2026-11-14): before, every day was working until the owner set
 *  one, so a home without a day-type Flow learned one profile for all days, and one whose Flow
 *  started on a Tuesday had every earlier weekend filed as working. Measured that day on the
 *  maintainer's tank, 31 days: weekends 25.9 kWh of hot water heat a day, weekdays 12.7; a
 *  weekend's heat goes in 06–12 (48 %), almost none 18–24 (4 %, weekdays 23 %). */
export function calendarDayType(clock: LocalClock, t: number): DayType {
    const day = new Date(`${clock(t).date}T12:00:00Z`).getUTCDay();
    return day === 0 || day === 6 ? 'free' : 'working';
}
/** Changes kept: years of a type set every day. */
const KEEP = 1000;

/** A change. `auto`: from here the calendar decides again (Away ended in a home that had set
 *  no type); `type` is then only a placeholder. */
export interface DayTypeChange {
    at: number;
    type: DayType;
    auto?: true;
}

export interface DayTypeState {
    /** The type last set. Under the calendar (no change, or the last one `auto`) a placeholder:
     *  read the type in force with `dayTypeAt`. */
    type: DayType;
    /** Every change, oldest first. */
    log: DayTypeChange[];
    /** While away: the working or free type the home goes back to. */
    base?: DayType;
}

export const isDayType = (v: unknown): v is DayType => (DAY_TYPES as readonly unknown[]).includes(v);

/** The stored state, or undefined when the owner never set one (every day is then one type). */
export function readDayType(stored: unknown): DayTypeState | undefined {
    const s = stored as DayTypeState | undefined;
    if (!s || !isDayType(s.type)) return undefined;
    const log: DayTypeChange[] = Array.isArray(s.log) ? s.log.filter((e) => Number.isFinite(e?.at) && isDayType(e?.type))
        .map((e) => ({at: e.at, type: e.type, ...e.auto === true ? {auto: true as const} : {}})) : [];
    return {type: s.type, log, ...isDayType(s.base) && s.base !== 'away' ? {base: s.base} : {}};
}

/** The state after setting `type` at `at`. Setting the type already in force changes nothing.
 *  With `keepAway`, a working or free type set while away only becomes the type to go back to. */
/** Whether a type was set and holds: a change logged, the last not handing back to the calendar. */
export function typeSet(state: DayTypeState | undefined): boolean {
    const last = state?.log[state.log.length - 1];
    return !!last && !last.auto;
}

export function recordDayType(state: DayTypeState | undefined, type: DayType, at: number, keepAway = false): DayTypeState {
    if (keepAway && state?.type === 'away' && type !== 'away') return state.base === type ? state : {...state, base: type};
    if (state?.type === type && typeSet(state)) return state;
    // Away remembers a set type to go back to; under the calendar there is none, and it goes back to the calendar.
    const base = type === 'away' && state && state.type !== 'away' && typeSet(state) ? {base: state.type} : {};
    return {type, log: [...(state?.log ?? []), {at, type}].slice(-KEEP), ...base};
}

/** Away on or off: on records away, off goes back to the type Away interrupted, or to the
 *  calendar when none was set. Unchanged when Away already is as asked. */
export function setAway(state: DayTypeState | undefined, on: boolean, at: number): DayTypeState | undefined {
    if (on) return recordDayType(state, 'away', at);
    if (state?.type !== 'away') return state;
    if (state.base) return recordDayType(state, state.base, at);
    return {type: DEFAULT_DAY_TYPE, log: [...state.log, {at, type: DEFAULT_DAY_TYPE, auto: true as const}].slice(-KEEP)};
}

/** The type in force at `t`: the last change at or before it, or, before the first and after one
 *  handing back, the calendar's (`clock`; the default without one). */
export function dayTypeAt(state: DayTypeState | undefined, t: number, clock?: LocalClock): DayType {
    let found: DayTypeChange | undefined;
    for (const e of state?.log ?? []) {
        if (e.at > t) break;
        found = e;
    }
    if (found && !found.auto) return found.type;
    return clock ? calendarDayType(clock, t) : DEFAULT_DAY_TYPE;
}
