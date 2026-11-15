/** The Hot water use widget's data (widgets/hotwater_use): the hot water Autopilot expects today,
 *  against the last six days and a typical day of each type. Pure; the device gathers the inputs
 *  and the widget only draws. Strings arrive translated. */
import {DayDraw, DayType, HALF_LIFE_DAYS, KWH_PER_LITRE} from './hotwater-learner';
import {DEFAULT_DAY_TYPE} from './day-type';

/** A day in the week chart: the day type in force that day, exactly as set. */
export type DayKind = DayType;

export interface WeekBar {
    /** Weekday, short, in the owner's language. */
    label: string;
    kind: DayKind;
    /** Litres of 40 °C water drawn; for today, what Autopilot expects. Missing: no full day read. */
    litres?: number;
    today?: boolean;
    /** Part of the day's use is not known (the tank ran low): `litres` is a lower bound. */
    atLeast?: boolean;
    /** Today only: litres used so far, drawn as the bar's filled part. */
    used?: number;
}

export interface HotwaterUseData {
    title: string;
    /** Today's expected use, and the day type with its typical day. */
    status?: string;
    reason?: string;
    bars?: WeekBar[];
    /** A typical day of each type over the last four weeks, litres. */
    typical?: {working?: number; free?: number};
    legend?: Record<string, string>;
    /** Today in a few lines: the use, the charges, the tank now and the next charge. */
    today?: {title: string; rows: TodayRow[]};
    empty?: string;
}

/** One line of the day: when, what, and how much. `kind` picks the dot. */
export interface TodayRow {
    time: string;
    kind: 'use' | 'charge' | 'now' | 'next';
    text: string;
    value?: string;
}

/** An hour that used less than this is no line of its own and joins no other, litres: what the
 *  tank reads while it charges is noise of 10–60 L an hour, and at 10 L it joined the 10:00
 *  shower and the afternoon into one 390 L line (2026-11-15). */
const QUIET_LITRES = 30;
/** A run of hours that used less than this in all is not worth a line, litres. */
const USE_ROW_LITRES = 30;

/** The day's use as runs of hours, each with its first hour and its litres: an hour of use
 *  joins the one before it, so a shower that crosses the hour is one line. Pure. */
export function useRuns(drawn: (number | undefined)[]): {hour: number; litres: number}[] {
    const out: {hour: number; litres: number}[] = [];
    let open: {hour: number; litres: number} | undefined;
    drawn.forEach((v, hour) => {
        if (v === undefined || v < QUIET_LITRES) { open = undefined; return; }
        if (open) open.litres += v;
        else out.push(open = {hour, litres: v});
    });
    return out.filter((r) => r.litres >= USE_ROW_LITRES).map((r) => ({hour: r.hour, litres: Math.round(r.litres / 5) * 5}));
}

/** Days the week chart shows: today and the six before it. */
export const WEEK_DAYS = 7;

const shiftDate = (date: string, days: number) => {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
};
const litresOf = (kwh: number) => Math.round(kwh / KWH_PER_LITRE / 5) * 5;

export function dayKind(dayType: DayType = DEFAULT_DAY_TYPE, away?: boolean): DayKind {
    return away ? 'away' : dayType;
}

/** The week chart's bars and typical days, from the learned full days. `weekday` labels a local
 *  date. Strings are the caller's. */
export function hotwaterWeek(usage: {recent: DayDraw[]; today: string; dayType?: DayType; expected?: number},
    weekday: (date: string) => string): {bars: WeekBar[]; typical: {working?: number; free?: number}} {
    const byDate = new Map(usage.recent.map((d) => [d.date, d]));
    const bars: WeekBar[] = [];
    for (let k = 1 - WEEK_DAYS; k <= 0; k++) {
        const date = shiftDate(usage.today, k);
        if (k === 0) {
            bars.push({label: weekday(date), kind: dayKind(usage.dayType), today: true,
                litres: usage.expected === undefined ? undefined : litresOf(usage.expected)});
            continue;
        }
        const day = byDate.get(date);
        bars.push({label: weekday(date), kind: dayKind(day?.dayType, day?.away),
            litres: day ? litresOf(day.draw) : undefined, ...(day?.partial !== undefined ? {atLeast: true} : {})});
    }
    // Recent days weigh more, as in learning.
    const typical: {working?: number; free?: number} = {};
    const todayMs = Date.parse(`${usage.today}T12:00:00Z`);
    for (const kind of ['working', 'free'] as const) {
        let sum = 0, weights = 0;
        for (const d of usage.recent) {
            if (d.partial !== undefined || dayKind(d.dayType, d.away) !== kind) continue;
            const w = 0.5 ** ((todayMs - Date.parse(`${d.date}T12:00:00Z`)) / 86_400_000 / HALF_LIFE_DAYS);
            sum += d.draw * w; weights += w;
        }
        if (weights > 0) typical[kind] = litresOf(sum / weights);
    }
    return {bars, typical};
}
