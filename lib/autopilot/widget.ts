/** The Autopilot dashboard widget's data (widgets/autopilot): what one function's Autopilot is
 *  doing and, for heating, indoor temperature against the BT1 offset from 12 h back to 12 h ahead:
 *  measured behind "now", the plan's expectation after it. Pure; the device gathers the inputs and
 *  the widget only draws. Strings arrive translated, so the widget needs no locales. */
import {FeedSnapshot} from './live';

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

/** A chart axis: round gridlines from `lo` to `hi`, and how many decimals their labels need. */
export interface Axis {
    lo: number;
    hi: number;
    ticks: number[];
    decimals: number;
}

/** A planned hot water charge as a labelled band under the chart: slots `from` up to `to`, the
 *  share of it the solar surplus covers (0–1), and its text, such as "22:00 to 00:10". */
export interface ChargeBand {
    from: number;
    to: number;
    solar: number;
    label: string;
}

/** An hour of the outdoor shift as one bar: slots `at` up to `to`, the shift (K) averaged over them. */
export interface ShiftBar {
    at: number;
    to: number;
    value: number;
}

export interface WidgetData {
    kind: 'heating' | 'hotwater' | 'none';
    title: string;
    status?: string;
    reason?: string;
    test?: boolean;
    chips: string[];
    /** The "Experimental" mark: shown last, quietly. */
    badge?: string;
    /** Round gridlines for the left and right axes. */
    scale?: {left?: Axis; right?: Axis};
    /** Planned charges (hot water). */
    bands?: ChargeBand[];
    /** Where the next local day starts, and its word ("Today", "Tomorrow"). */
    dayBreak?: {at: number; label: string};
    /** One line under the chart on how to read it. */
    hint?: string;
    /** Heating: the shift as hourly bars. */
    bars?: ShiftBar[];
    /** A second, quieter line under the reason. */
    detail?: string;
    slots: WidgetSlot[];
    /** Index of the first slot that is a plan rather than a measurement (heating). */
    now?: number;
    ticks: {at: number; label: string}[];
    legend: Record<string, string>;
    /** Axis titles, left and right (heating). */
    axes?: {left: string; right: string};
    /** Indoor temperature now, °C (heating), shown beside the status. */
    indoorNow?: number;
    footnote?: string;
    empty?: string;
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

const NICE_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
const trim = (v: number) => Math.round(v * 1e6) / 1e6 + 0;

/** Round gridlines for a value range: a step from `steps` that keeps at most `maxIntervals`
 *  intervals, the range widened to whole steps, `include` always inside it, and at least
 *  `minSpan` tall. A middle tick is never rounded away from its gridline. */
export function niceAxis(min: number, max: number, options: {include?: number[]; minSpan?: number; maxIntervals?: number;
    steps?: number[]} = {}): Axis {
    const {include = [], minSpan = 0, maxIntervals = 4, steps = NICE_STEPS} = options;
    let lo = Math.min(min, ...include), hi = Math.max(max, ...include);
    if (hi - lo < minSpan) {
        if (hi > 0) hi = Math.max(hi, lo + minSpan);
        else if (lo < 0) lo = Math.min(lo, hi - minSpan);
        else { lo = -minSpan; hi = minSpan; }
    }
    const eps = 1e-9;
    const step = steps.find((s) => Math.ceil(hi / s - eps) - Math.floor(lo / s + eps) <= maxIntervals) ?? steps[steps.length - 1];
    lo = trim(Math.floor(lo / step + eps) * step);
    hi = trim(Math.ceil(hi / step - eps) * step);
    const ticks: number[] = [];
    for (let v = lo; v <= hi + eps; v += step) ticks.push(trim(v));
    const decimals = Math.min(2, Math.max(0, ...ticks.map((v) => (String(v).split('.')[1] ?? '').length)));
    return {lo, hi, ticks, decimals};
}

/** "2 h 10 min", "45 min" or "3 h", from the owner's duration strings. */
export function formatDuration(minutes: number, say: (key: 'duration' | 'duration_min' | 'duration_h', tokens: Record<string, number>) => string): string {
    const m = Math.round(minutes);
    if (m < 60) return say('duration_min', {m});
    return m % 60 ? say('duration', {h: Math.floor(m / 60), m: m % 60}) : say('duration_h', {h: m / 60});
}

/** The first slot, after the first, that starts a new local day: the chart's midnight. */
export function dayBreakSlot(start: number, slots: number, dayOf: (ms: number) => string, slotMs = 15 * 60_000): number | undefined {
    for (let k = 1; k < slots; k++)
        if (dayOf(start + k * slotMs) !== dayOf(start + (k - 1) * slotMs)) return k;
    return undefined;
}

/** Runs of consecutive planned-charge slots, each labelled from its first slot's start to its last
 *  slot's end. `from` is the chart's first slot start (ms). */
export function chargeBands(slots: WidgetSlot[], from: number, clock: (ms: number) => string,
    label: (start: string, end: string) => string, slotMs = 15 * 60_000): ChargeBand[] {
    const bands: ChargeBand[] = [];
    let open: {from: number; solar: number[]} | undefined;
    const close = (to: number) => {
        if (!open) return;
        const share = open.solar.reduce((a, b) => a + b, 0) / open.solar.length;
        bands.push({from: open.from, to, solar: Math.round(share * 100) / 100,
            label: label(clock(from + open.from * slotMs), clock(from + to * slotMs))});
        open = undefined;
    };
    slots.forEach((s, k) => {
        if (typeof s.charge === 'number') { open ??= {from: k, solar: []}; open.solar.push(s.charge); } else close(k);
    });
    close(slots.length);
    return bands;
}

/** A reason without the word the status already says: "Holding. Nothing to gain" under
 *  "Holding" becomes "Nothing to gain". Leads are removed with their ". ", ": " or " · ". */
export function stripLead(text: string, leads: string[]): string {
    let out = text;
    for (let again = true; again;) {
        again = false;
        for (const lead of leads) {
            if (!lead) continue;
            const re = new RegExp(`^${lead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[.:·]\\s*`, 'i');
            if (re.test(out)) { out = out.replace(re, ''); again = true; }
        }
    }
    return out ? out[0].toUpperCase() + out.slice(1) : out;
}

/** The outdoor shift as bars, one per `per` slots (an hour): the mean of the slots that have a
 *  value, to a tenth. A run with no value, or a mean of 0, has no bar. The plan and the past never
 *  share a bar as long as `per` divides the slot where now is. */
export function shiftBars(slots: WidgetSlot[], per = 4): ShiftBar[] {
    const bars: ShiftBar[] = [];
    for (let at = 0; at < slots.length; at += per) {
        const values = slots.slice(at, at + per).flatMap((s) => (s.offset === undefined ? [] : [s.offset]));
        if (!values.length) continue;
        const value = tenth(values.reduce((a, b) => a + b, 0) / values.length);
        if (value !== 0) bars.push({at, to: Math.min(at + per, slots.length), value});
    }
    return bars;
}
