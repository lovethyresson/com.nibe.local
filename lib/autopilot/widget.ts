/** The Autopilot dashboard widget's data (widgets/autopilot): what one function's Autopilot is
 *  doing and, for heating, indoor temperature against the BT1 offset over today, 00:00 to 24:00:
 *  measured behind "now", the plan's expectation after it. Pure; the device gathers the inputs and
 *  the widget only draws. Strings arrive translated, so the widget needs no locales. */
import {FeedSnapshot} from './live';
import {SHIFT_K} from './heating-status';

export type Translate = (key: string, tokens?: Record<string, string | number>) => string;


/** One 15-min slot. Heating: indoor °C and the BT1 offset (fed − real, K; below 0 the pump sees
 *  it colder and heats more). Hot water: the price, the expected solar surplus (kW), and, where a
 *  charge is planned, the share of it the surplus covers (0–1). */
export interface WidgetSlot {
    indoor?: number;
    offset?: number;
    price?: number;
    surplus?: number;
    charge?: number;
    /** Hot water: the tank was charging in this slot (one already behind now). */
    ran?: true;
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
    /** Slots `from` up to this one already ran: drawn muted. Missing when none did. */
    doneTo?: number;
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
    /** One line under the chart on how to read it. */
    hint?: string;
    /** Heating: the indoor temperature it steers for now, worded, shown under `indoorNow`. */
    aim?: string;
    /** Starting: the plan is being made. The chart keeps its place with a placeholder. */
    loading?: boolean;
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
    // Stepped from the chart's start, which is local midnight: 00:00, 06:00, 12:00, 18:00.
    const out: {at: number; label: string}[] = [];
    for (let k = 0; k < slots; k += everyH * 4) out.push({at: k, label: clock(start + k * 15 * 60_000)});
    return out;
}

/** Today in local time as slots: its first slot and how many it has (96, or 92/100 on the day the
 *  clocks change). Both widget charts show exactly this day. */
export function todaySlots(slot: number, dayOf: (ms: number) => string, slotMs = 15 * 60_000): {from: number; n: number} {
    const today = dayOf(slot * slotMs);
    let from = slot;
    while (from > slot - 104 && dayOf((from - 1) * slotMs) === today) from--;
    let to = slot + 1;
    while (to < from + 104 && dayOf(to * slotMs) === today) to++;
    return {from, n: to - from};
}

const tenth = (v: number) => Math.round(v * 10) / 10 + 0;

/** The heating chart: the recorded past up to `slot`, then the feed's plan from `slot` on (the plan
 *  was made at its own slot, so it is read from where now is). */
export function heatingSlots(past: {indoor?: number; offset?: number}[], state: FeedSnapshot | undefined, slot: number,
    ahead: number): WidgetSlot[] {
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

/** The indoor temperature Autopilot heating steers for now, °C. In a pre-heat or an ease-off: the
 *  expected indoor where that run of the plan ends, the level it is heating up to or letting the
 *  house fall to. Otherwise the thermostat it holds. `now` is the first planned slot. Pure. */
export function aimingFor(slots: WidgetSlot[], now: number, setpoint?: number): number | undefined {
    const sign = (s?: WidgetSlot) => s?.offset === undefined || Math.abs(s.offset) < SHIFT_K ? 0 : Math.sign(s.offset);
    const run = sign(slots[now]);
    if (run !== 0) {
        let k = now;
        while (k + 1 < slots.length && sign(slots[k + 1]) === run) k++;
        const end = slots[k]?.indoor;
        if (end !== undefined) return end;
    }
    return setpoint;
}

/** The shift axis: as far below 0 as above, so 0 sits in the middle and a bar reads as heating
 *  more or easing off at a glance. Pure. */
export function symmetricAxis(values: number[]): Axis {
    const m = Math.max(0.25, ...values.map((v) => Math.abs(v)).filter(Number.isFinite));
    return niceAxis(-m, m, {include: [0], steps: [0.25, 0.5, 1, 2, 5, 10]});
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

/** Runs of consecutive charge slots, done or planned, each labelled from its first slot's start
 *  to its last slot's end. A charge running now is one band: its done part, then its planned
 *  rest. `from` is the chart's first slot start (ms). */
export function chargeBands(slots: WidgetSlot[], from: number, clock: (ms: number) => string,
    label: (start: string, end: string) => string, slotMs = 15 * 60_000): ChargeBand[] {
    const bands: ChargeBand[] = [];
    let open: {from: number; solar: number[]; doneTo?: number} | undefined;
    const close = (to: number) => {
        if (!open) return;
        const share = open.solar.length ? open.solar.reduce((a, b) => a + b, 0) / open.solar.length : 0;
        bands.push({from: open.from, to, solar: Math.round(share * 100) / 100,
            label: label(clock(from + open.from * slotMs), clock(from + to * slotMs)),
            ...open.doneTo !== undefined ? {doneTo: open.doneTo} : {}});
        open = undefined;
    };
    slots.forEach((s, k) => {
        const planned = typeof s.charge === 'number';
        if (!planned && !s.ran) return close(k);
        // Done after planned would be a new charge: a band of its own.
        if (s.ran && !planned && open && open.doneTo !== k) close(k);
        open ??= {from: k, solar: []};
        if (s.ran && !planned) open.doneTo = k + 1;
        else open.solar.push(s.charge ?? 0);
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
