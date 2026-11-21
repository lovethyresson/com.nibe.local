/** Away's end time: the home is away until then, and Autopilot heating warms the house so it is
 *  back at the thermostat's temperature by that time (live.ts `setpointPath`). One app setting
 *  for the home, like the day type (day-type.ts), kept apart from it so hot water's state is not
 *  touched. Pure. Design: docs/autopilot-plan.md §19.2. */

import {dateFormat, localeDate, localeTime} from '../intl';

export const AWAY_UNTIL_SETTING = 'autopilotAwayUntil';

/** The stored end time, or undefined when Away has none. */
export function readAwayUntil(stored: unknown): number | undefined {
    const v = Number(stored);
    return stored !== null && stored !== undefined && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Whether Away should end now: it has an end time and that time has come. */
export function awayEnded(until: number | undefined, now: number): boolean {
    return until !== undefined && now >= until;
}

/** When Away ends, as the owner reads it: the time today, "Thu 18:00" within the week,
 *  "22 Nov 18:00" beyond it. 24-hour time; weekday and month in the owner's language. */
export function awayUntilLabel(until: number, now: number, timeZone: string, language = 'en'): string {
    const time = localeTime(until, 'sv-SE', {timeZone, hour: '2-digit', minute: '2-digit'});
    const date = (t: number) => localeDate(t, 'en-CA', {timeZone});
    if (date(until) === date(now)) return time;
    const day = until - now < 6 * 86_400_000
        ? localeDate(until, language, {timeZone, weekday: 'short'})
        : localeDate(until, language, {timeZone, day: 'numeric', month: 'short'});
    return `${day} ${time}`;
}

/** A Flow card's date (`dd-mm-yyyy`) and time (`HH:mm`), read in the home's time zone, as ms.
 *  Undefined when either does not parse. */
export function localDateTime(date: unknown, time: unknown, timeZone: string): number | undefined {
    const d = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(String(date ?? '').trim());
    const t = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? '').trim());
    if (!d || !t) return undefined;
    const [day, month, year, hour, minute] = [Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2])];
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return undefined;
    const wall = Date.UTC(year, month - 1, day, hour, minute);
    if (new Date(wall).getUTCDate() !== day) return undefined;
    // The zone's offset at that wall time: guess, then correct once more across a DST change.
    let ms = wall - offset(wall, timeZone);
    ms = wall - offset(ms, timeZone);
    return ms;
}

/** The zone's offset from UTC at `ms`, ms. */
function offset(ms: number, timeZone: string): number {
    const parts = Object.fromEntries(dateFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'})
        .formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
    const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24,
        Number(parts.minute), Number(parts.second));
    return local - Math.floor(ms / 1000) * 1000;
}
