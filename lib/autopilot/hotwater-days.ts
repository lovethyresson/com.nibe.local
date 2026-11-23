/** One compact record per local day of the hot water slots: what each hour read and cost, and
 *  the day's safety facts. The 15-minute log is kept 28 days; these are kept a year, so a replay
 *  or a per-weekday forecast has more than Insights' 14 days of hourly readings. Pure: the file
 *  is the caller's. Plan: tasks/hotwater-improvement-plan.md step 1.1, 1.4.
 *
 *  Raw readings only, no derived draw: the learner's formula can change, and a record that holds
 *  what was read can be re-scored with it. */

import type {DayType} from './hotwater-learner';

/** Records kept: about a year. */
export const DAYS_KEPT = 400;

/** One slot as read. */
export interface DaySample {
    at: number;
    date: string;
    hour: number;
    dayType?: DayType;
    litres?: number;
    /** Hot water heat produced, the kWh counter. */
    produced?: number;
    top?: number;
    /** Buy price per kWh this slot. */
    price?: number;
    reserveLitres?: number;
}

/** Per hour: litres at its first and last slot, the produced counter at both, the lowest top,
 *  and the mean buy price. Null: no slot read in that hour. */
export type HourRecord = [l0: number | null, l1: number | null, p0: number | null, p1: number | null,
    topMin: number | null, price: number | null];

export interface DayRecord {
    date: string;
    /** The day type in force for most of the day's slots, as the owner set it (or the calendar's
     *  weekend before they did). */
    dt?: DayType;
    hours: (HourRecord | null)[];
    /** Runs Autopilot started, and runs the pump started itself. */
    starts: {autopilot: number; pump: number};
    /** Runs started with the tank under the owner's minimum, and rescues the day's cap refused. */
    rescues: number;
    refused: number;
    /** Minutes the tank was under the owner's minimum. */
    underMin: number;
    /** Slots read: under 96 the day was not watched all through (a restart, the first day). */
    slots: number;
    /** The evening as forecast that morning, kWh: what the plan used (the day type's) and the
     *  per-weekday challenger (plan step 5.1), each mean and P80. Scored against `hours`. */
    eve?: EveningForecast;
    /** The evening as forecast at 16:00 by the day type's profile and by the two challengers that
     *  need the day so far (plan steps 5.2 and 5.3). Scored against `hours`. */
    late?: LateEvening;
}

export interface LateEvening {
    /** kWh drawn MORNING_FROM–MORNING_TO, as read by 16:00. */
    morning: number;
    base: number;
    baseP80: number;
    /** Morning state (5.2): high morning or not, and that state's evening. */
    morn?: {high: boolean; days: number; mean: number; p80: number};
    /** Days like today (5.3). */
    similar?: {days: number; mean: number; p80: number};
}

export interface EveningForecast {
    base: number;
    baseP80: number;
    mean: number;
    p80: number;
}

interface HourAcc {l0?: number; l1?: number; p0?: number; p1?: number; top?: number; priceSum: number; priceN: number}

export interface DayAcc {
    date: string;
    hours: (HourAcc | undefined)[];
    types: Partial<Record<DayType, number>>;
    starts: {autopilot: number; pump: number};
    rescues: number;
    refused: number;
    underMin: number;
    slots: number;
    eve?: EveningForecast;
    late?: LateEvening;
}

const finite = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const r = (v: number | undefined, d: number) => (finite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

export function emptyDay(date: string): DayAcc {
    return {date, hours: new Array(24).fill(undefined), types: {}, starts: {autopilot: 0, pump: 0}, rescues: 0, refused: 0,
        underMin: 0, slots: 0};
}

/** The day after one slot, and the finished record when the slot starts a new day. */
export function daySample(acc: DayAcc | undefined, s: DaySample, slotMinutes = 15): {acc: DayAcc; done?: DayRecord} {
    const done = acc && acc.date !== s.date ? dayRecord(acc) : undefined;
    const day = acc && acc.date === s.date ? acc : emptyDay(s.date);
    const h = day.hours[s.hour] ??= {priceSum: 0, priceN: 0};
    if (finite(s.litres)) {
        h.l0 ??= s.litres;
        h.l1 = s.litres;
    }
    if (finite(s.produced)) {
        h.p0 ??= s.produced;
        h.p1 = s.produced;
    }
    if (finite(s.top) && !(s.top >= (h.top ?? Infinity))) h.top = s.top;
    if (finite(s.price)) {
        h.priceSum += s.price;
        h.priceN++;
    }
    if (s.dayType) day.types[s.dayType] = (day.types[s.dayType] ?? 0) + 1;
    if (finite(s.litres) && finite(s.reserveLitres) && s.reserveLitres > 0 && s.litres < s.reserveLitres) day.underMin += slotMinutes;
    day.slots++;
    return {acc: day, ...done ? {done} : {}};
}

export function dayRecord(acc: DayAcc): DayRecord {
    const dt = (Object.entries(acc.types) as [DayType, number][]).sort((a, b) => b[1] - a[1])[0]?.[0];
    return {date: acc.date, ...dt ? {dt} : {},
        hours: acc.hours.map((h) => (h ? [r(h.l0, 0), r(h.l1, 0), r(h.p0, 2), r(h.p1, 2), r(h.top, 1),
            h.priceN ? r(h.priceSum / h.priceN, 3) : null] : null)),
        starts: acc.starts, rescues: acc.rescues, refused: acc.refused, underMin: acc.underMin, slots: acc.slots,
        ...acc.eve ? {eve: acc.eve} : {}, ...acc.late ? {late: acc.late} : {}};
}
