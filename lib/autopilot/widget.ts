/** The Autopilot dashboard widget's data (widgets/autopilot): what one function's Autopilot is
 *  doing, its next 24 h, and for heating the house in plain terms. Pure; the device gathers the
 *  inputs and the widget only draws. Strings arrive translated, so the widget needs no locales. */
import {coolDown} from './insights';
import {Limits} from './presets';
import {HouseParams} from './model';
import {FeedSnapshot} from './live';

export type Translate = (key: string, tokens?: Record<string, string | number>) => string;

export const WIDGET_SLOTS = 96;

/** One 15-min slot of the chart: the price, and for heating the planned shift (+ more heat). */
export interface WidgetSlot {
    price?: number;
    shift?: number;
    charge?: boolean;
}

export interface WidgetData {
    kind: 'heating' | 'hotwater' | 'none';
    title: string;
    status?: string;
    reason?: string;
    test?: boolean;
    chips: string[];
    /** Slot start of `slots[0]`, ms, and hour labels to put under the chart. */
    start?: number;
    slots: WidgetSlot[];
    ticks: {at: number; label: string}[];
    legend: {price: string; more?: string; less?: string; charge?: string};
    chartTitle: string;
    houseTitle?: string;
    house: string[];
    footnote?: string;
    empty?: string;
}

/** Hours until indoor falls `drop` °C with the heating off, from steady at `from` with `outdoor`
 *  outside; undefined past `maxH`. */
export function hoursToDrop(p: HouseParams, drop: number, from: number, outdoor: number, maxH = 48): number | undefined {
    const curve = coolDown(p, maxH, from, outdoor);
    const k = curve.findIndex((t) => t <= from - drop);
    return k < 0 ? undefined : k / 4;
}

const round = (h: number) => (h < 3 ? Math.round(h * 2) / 2 : Math.round(h));

/** The house sentences: how fast it cools at today's outdoor temperature (and the coldest ahead,
 *  when that differs), and how long the chosen range lets Autopilot ease off. */
export function houseLines(p: HouseParams | undefined, t: Translate, a: {from: number; outdoor?: number; coldest?: number;
    limits: Limits; rangeTitle: string}): string[] {
    if (!p) return [];
    const lines: string[] = [];
    const temps = [a.outdoor, a.coldest].filter((v): v is number => v !== undefined && Number.isFinite(v))
        .map((v) => Math.round(v));
    for (const outdoor of [...new Set(temps)]) {
        const h = hoursToDrop(p, 1, a.from, outdoor);
        lines.push(h === undefined ? t('house.cools_slow', {out: outdoor}) : t('house.cools', {out: outdoor, h: round(h)}));
    }
    if (temps.length) {
        const drop = hoursToDrop(p, a.limits.lower, a.from, temps[0]);
        const coast = Math.min(a.limits.maxCoastH, drop ?? Infinity);
        lines.push(t('house.coast', {range: a.rangeTitle, h: round(coast)}));
    }
    return lines;
}

/** Hour labels every 6 h on the chart, local time. */
export function ticks(start: number, slots: number, clock: (ms: number) => string, everyH = 6): {at: number; label: string}[] {
    const out: {at: number; label: string}[] = [];
    const hour = 3_600_000;
    for (let at = Math.ceil(start / (everyH * hour)) * everyH * hour; at < start + slots * 15 * 60_000; at += everyH * hour)
        out.push({at: (at - start) / (15 * 60_000), label: clock(at)});
    return out;
}

/** The planned shift per slot from `slot` on, read from the feed's plan (which starts at its own
 *  slot); undefined past the plan. */
export function plannedShifts(state: FeedSnapshot, slot: number, n: number): (number | undefined)[] {
    const from = state.slot === undefined ? undefined : slot - state.slot;
    return Array.from({length: n}, (_, k) => {
        if (from === undefined || !state.biases) return undefined;
        const b = state.biases[from + k];
        return b === undefined ? undefined : Math.round(b * 10) / 10;
    });
}
