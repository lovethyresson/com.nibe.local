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

import {DAY_TYPES, DayType} from './hotwater-learner';

export const DAY_TYPE_SETTING = 'autopilotDayType';
export const DAY_TYPE_CAPABILITY = 'day_type_NIBE';
/** There is always a day type: until the owner first sets one, every day is a working day. */
export const DEFAULT_DAY_TYPE: DayType = 'working';
/** Changes kept: years of a type set every day. */
const KEEP = 1000;

export interface DayTypeState {
    type: DayType;
    /** Every change, oldest first. */
    log: {at: number; type: DayType}[];
    /** While away: the working or free type the home goes back to. */
    base?: DayType;
}

export const isDayType = (v: unknown): v is DayType => (DAY_TYPES as readonly unknown[]).includes(v);

/** The stored state, or undefined when the owner never set one (every day is then one type). */
export function readDayType(stored: unknown): DayTypeState | undefined {
    const s = stored as DayTypeState | undefined;
    if (!s || !isDayType(s.type)) return undefined;
    const log = Array.isArray(s.log) ? s.log.filter((e) => Number.isFinite(e?.at) && isDayType(e?.type)) : [];
    return {type: s.type, log, ...isDayType(s.base) && s.base !== 'away' ? {base: s.base} : {}};
}

/** The state after setting `type` at `at`. Setting the type already in force changes nothing.
 *  With `keepAway`, a working or free type set while away only becomes the type to go back to. */
export function recordDayType(state: DayTypeState | undefined, type: DayType, at: number, keepAway = false): DayTypeState {
    if (keepAway && state?.type === 'away' && type !== 'away') return state.base === type ? state : {...state, base: type};
    if (state?.type === type) return state;
    const base = type === 'away' && state && state.type !== 'away' ? {base: state.type} : {};
    return {type, log: [...(state?.log ?? []), {at, type}].slice(-KEEP), ...base};
}

/** Away on or off: on records away, off goes back to the type Away interrupted (working when
 *  there was none). Unchanged when Away already is as asked. */
export function setAway(state: DayTypeState | undefined, on: boolean, at: number): DayTypeState | undefined {
    if (on) return recordDayType(state, 'away', at);
    if (state?.type !== 'away') return state;
    return recordDayType(state, state.base ?? 'working', at);
}

/** The type in force at `t`: before the first one was set, the default. */
export function dayTypeAt(state: DayTypeState | undefined, t: number): DayType {
    let found: DayType = DEFAULT_DAY_TYPE;
    for (const e of state?.log ?? []) {
        if (e.at > t) break;
        found = e.type;
    }
    return found;
}
