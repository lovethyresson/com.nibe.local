/** Heating's comfort promise, day by day: how long indoor stayed within the range around the
 *  thermostat, how far it strayed, and the day's weather (outdoor swing and sun), so a windy or
 *  sunny day can be judged afterwards. Kept 14 days on the Heating device. Pure. */

export interface ComfortDay {
    /** Local date. */
    date: string;
    /** Quarter-hour slots counted, and those outside [comfort − lower, comfort + upper]. */
    slots: number;
    outside: number;
    /** Sum of |indoor − comfort| over the slots, K, for the mean. */
    offSum: number;
    /** Furthest below and above comfort, K (positive numbers). */
    maxBelow: number;
    maxAbove: number;
    /** The range the day was planned in (the last slot's), K. */
    lower: number;
    upper: number;
    /** Outdoor at its lowest and highest, °C, and the sun summed over the slots (W/m² × slots). */
    teMin?: number;
    teMax?: number;
    sun: number;
}

export const COMFORT_DAYS_KEPT = 14;

export interface ComfortSlot {
    date: string;
    ti: number;
    comfort: number;
    lower: number;
    upper: number;
    te?: number;
    sun?: number;
}

/** The log with one slot added: to today's day, or a new day when the date moves on. */
export function addComfortSlot(days: ComfortDay[], s: ComfortSlot, keep = COMFORT_DAYS_KEPT): ComfortDay[] {
    if (!Number.isFinite(s.ti) || !Number.isFinite(s.comfort)) return days;
    const last = days[days.length - 1];
    const day: ComfortDay = last?.date === s.date ? {...last}
        : {date: s.date, slots: 0, outside: 0, offSum: 0, maxBelow: 0, maxAbove: 0, lower: s.lower, upper: s.upper, sun: 0};
    const off = s.ti - s.comfort;
    day.slots += 1;
    if (s.ti < s.comfort - s.lower - 1e-9 || s.ti > s.comfort + s.upper + 1e-9) day.outside += 1;
    day.offSum += Math.abs(off);
    day.maxBelow = Math.max(day.maxBelow, -off);
    day.maxAbove = Math.max(day.maxAbove, off);
    day.lower = s.lower;
    day.upper = s.upper;
    if (Number.isFinite(s.te)) {
        day.teMin = day.teMin === undefined ? s.te : Math.min(day.teMin, s.te!);
        day.teMax = day.teMax === undefined ? s.te : Math.max(day.teMax, s.te!);
    }
    if (Number.isFinite(s.sun) && s.sun! > 0) day.sun += s.sun!;
    const rest = last?.date === s.date ? days.slice(0, -1) : days;
    return [...rest, day].slice(-keep);
}

/** A day in plain terms: hours counted and hours in range (whole quarters, rounded down to the
 *  half hour shown), the mean distance from comfort and the furthest either way. */
export function comfortSummary(day: ComfortDay): {hours: number; inRange: number; meanOff: number; maxBelow: number; maxAbove: number} {
    const round1 = (v: number) => Math.round(v * 10) / 10;
    return {hours: round1(day.slots / 4), inRange: round1((day.slots - day.outside) / 4),
        meanOff: day.slots ? Math.round(day.offSum / day.slots * 100) / 100 : 0,
        maxBelow: round1(day.maxBelow), maxAbove: round1(day.maxAbove)};
}

/** A stored log, keeping only well-formed days. */
export function readComfortDays(stored: unknown): ComfortDay[] {
    if (!Array.isArray(stored)) return [];
    return stored.filter((d) => d && typeof d.date === 'string' && Number.isFinite(d.slots) && Number.isFinite(d.outside))
        .slice(-COMFORT_DAYS_KEPT);
}
