/** The Autopilot dashboard widget's data (widgets/autopilot): what one function's Autopilot is
 *  doing and, for heating, indoor temperature against the BT1 offset from 12 h back to 12 h ahead:
 *  measured behind "now", the plan's expectation after it. Pure; the device gathers the inputs and
 *  the widget only draws. Strings arrive translated, so the widget needs no locales. */
import {FeedSnapshot} from './live';
import {DayDraw, DayType, HALF_LIFE_DAYS, KWH_PER_LITRE} from './hotwater-learner';
import {DEFAULT_DAY_TYPE} from './day-type';

export type Translate = (key: string, tokens?: Record<string, string | number>) => string;

/** Heating: 12 h back, 12 h ahead. Hot water: 24 h ahead. */
export const BACK_SLOTS = 48;
export const AHEAD_SLOTS = 48;
export const HOTWATER_SLOTS = 96;

/** One 15-min slot. Heating: indoor °C and the BT1 offset (fed − real, K; below 0 the pump sees
 *  it colder and heats more). Hot water: the price, the expected solar surplus (kW), and, where a
 *  charge is planned, the share of it the surplus covers (0–1). */
export interface WidgetSlot {
    indoor?: number;
    offset?: number;
    price?: number;
    surplus?: number;
    charge?: number;
}

export interface WidgetData {
    kind: 'heating' | 'hotwater' | 'none';
    title: string;
    status?: string;
    reason?: string;
    test?: boolean;
    chips: string[];
    slots: WidgetSlot[];
    /** Index of the first slot that is a plan rather than a measurement (heating). */
    now?: number;
    ticks: {at: number; label: string}[];
    legend: Record<string, string>;
    /** Axis titles, left and right (heating). */
    axes?: {left: string; right: string};
    /** The comfort temperature, drawn as a reference line on the indoor axis. */
    comfort?: number;
    /** Indoor temperature now, °C (heating), shown beside the status. */
    indoorNow?: number;
    footnote?: string;
    empty?: string;
    /** Hot water: use over the last week, below the plan. */
    week?: WeekData;
}

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
}

export interface WeekData {
    title: string;
    bars: WeekBar[];
    /** A typical day of each type over the last four weeks, litres. */
    typical: {working?: number; free?: number};
    legend: Record<string, string>;
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
    weekday: (date: string) => string): Pick<WeekData, 'bars' | 'typical'> {
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
    const typical: WeekData['typical'] = {};
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

/** Hour labels every `everyH` h, at their slot index from `start`, local time. */
export function ticks(start: number, slots: number, clock: (ms: number) => string, everyH = 6): {at: number; label: string}[] {
    const out: {at: number; label: string}[] = [];
    const hour = 3_600_000;
    for (let at = Math.ceil(start / (everyH * hour)) * everyH * hour; at < start + slots * 15 * 60_000; at += everyH * hour)
        out.push({at: (at - start) / (15 * 60_000), label: clock(at)});
    return out;
}

const tenth = (v: number) => Math.round(v * 10) / 10 + 0;

/** The heating chart: the recorded past up to `slot`, then the feed's plan from `slot` on (the plan
 *  was made at its own slot, so it is read from where now is). */
export function heatingSlots(past: {indoor?: number; offset?: number}[], state: FeedSnapshot | undefined, slot: number,
    ahead = AHEAD_SLOTS): WidgetSlot[] {
    const back = past.map((p) => ({indoor: p.indoor === undefined ? undefined : tenth(p.indoor),
        offset: p.offset === undefined ? undefined : tenth(p.offset)}));
    const from = state?.slot === undefined ? undefined : slot - state.slot;
    const next = Array.from({length: ahead}, (_, k): WidgetSlot => {
        if (from === undefined || !state) return {};
        const bias = state.biases?.[from + k];
        const indoor = state.indoor?.[from + k];
        return {indoor: indoor === undefined ? undefined : tenth(indoor), offset: bias === undefined ? undefined : tenth(-bias)};
    });
    // Comfort range Off, or no plan yet while feeding: the offset ahead is 0 as long as it feeds.
    if (state?.neutral) next.forEach((s) => { s.offset = 0; });
    return [...back, ...next];
}
