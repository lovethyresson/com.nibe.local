/** The Heating performance widget's data (widgets/energy, named Energy today until 2026-11): the heat
 *  pump's electricity per hour today, split by function (and Main's idle use), against the hour's price,
 *  and three numbers: kWh so far, what it cost, and the share used in the day's cheapest hours. Under it,
 *  what Autopilot sent as the outdoor temperature (BT1) and what the house did indoors, so an owner sees
 *  the shift and the electricity follow the price. Pure; the device gathers the inputs. */
import {Axis, niceAxis, WidgetSlot} from './widget';
import {RESET_SHARE, moneyText} from './savings';

/** The devices whose use is shown, in stacking order (bottom first): the functions, then Main's
 *  idle use, so the total matches the pump's devices in Homey Energy. */
export const ENERGY_ROLES = ['heating', 'hotwater', 'main'] as const;
export type EnergyRole = typeof ENERGY_ROLES[number];

export interface EnergyHour {
    /** kWh per function in the hour; missing where its meter has no reading (yet). */
    use: Partial<Record<EnergyRole, number>>;
    /** Price per kWh, all costs in, as Homey Energy has it. */
    price?: number;
}

export interface EnergyChart {
    hours: EnergyHour[];
    kwh: number;
    cost: number;
    /** Share of the kWh used in the cheapest third of the day's hours, 0–1; undefined with no use. */
    cheapShare?: number;
    kwhAxis: {max: number; gridlines: number[]};
    priceAxis: {max: number; gridlines: number[]; decimals: number};
}

/** `hours` are the day's hour starts (ms, local day: 23, 24 or 25 of them); `use` the meters'
 *  hourly kWh by hour start; `prices` the day's hourly prices. */
export function energyChart(hours: number[], use: Partial<Record<EnergyRole, Map<number, number>>>,
    prices: Map<number, number>, bySlot: {slots?: Partial<Record<EnergyRole, Map<number, number>>>; prices?: Map<number, number>} = {}): EnergyChart {
    // The day's prices in thirds, as the savings widgets rank them.
    const ranked = hours.filter((at) => prices.has(at)).sort((a, b) => prices.get(a)! - prices.get(b)!);
    const cheap = new Set(ranked.slice(0, Math.ceil(ranked.length / 3)));
    let kwh = 0, cost = 0, inCheap = 0;
    const out = hours.map((at): EnergyHour => {
        const hour: EnergyHour = {use: {}, ...prices.has(at) ? {price: prices.get(at)} : {}};
        for (const role of ENERGY_ROLES) {
            const v = use[role]?.get(at);
            if (v === undefined) continue;
            hour.use[role] = v;
            kwh += v;
            // Each 15-minute slot at its own price, as Homey Energy counts it; the rest of the
            // hour (read from Insights) at the hour's mean.
            let rest = v;
            const slots = bySlot.slots?.[role];
            if (slots && bySlot.prices) for (let s = at; s < at + 3_600_000; s += 900_000) {
                const kwh = slots.get(s), price = bySlot.prices.get(s);
                if (kwh !== undefined && price !== undefined) { cost += kwh * price; rest -= kwh; }
            }
            if (hour.price !== undefined) cost += Math.max(0, rest) * hour.price;
            if (cheap.has(at)) inCheap += v;
        }
        return hour;
    });
    const peak = Math.max(0, ...out.map((h) => ENERGY_ROLES.reduce((s, r) => s + (h.use[r] ?? 0), 0)));
    const kwhAxis = niceAxis(0, Math.max(1, peak), {steps: [0.5, 1, 2, 5]});
    const priceAxis = niceAxis(0, Math.max(0.5, ...[...prices.values()]), {maxIntervals: 3});
    return {hours: out, kwh: round(kwh, 1), cost: round(cost, 2), ...kwh > 0 ? {cheapShare: round(inCheap / kwh, 3)} : {},
        kwhAxis: {max: kwhAxis.hi, gridlines: kwhAxis.ticks}, priceAxis: {max: priceAxis.hi, gridlines: priceAxis.ticks, decimals: priceAxis.decimals}};
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

const HOUR = 3_600_000;

/** What is known of one function's meter (kWh, cumulative). */
export interface MeterReads {
    /** Insights' hourly points, oldest first: each the meter's mean over the hour from `at`, so
     *  about its value at the hour's middle. Read hourly, so they end an hour or two back. */
    points: {at: number; v: number}[];
    /** The meter at the first 15-minute boundary the app has seen run: every slot from here on is
     *  in `slots`, whole. */
    liveFrom?: {at: number; v: number};
    /** kWh the meter added in each 15-minute slot (slot start, ms) since the app started. */
    slots: Map<number, number>;
    meterNow: number;
}

/** A function's use today, up to now, in the day's hours (`hours`: their starts, ms), and the part of
 *  it known per 15-minute slot. Since the app's first whole slot the meter itself is counted, slot by
 *  slot, so the hours start at midnight and end now, as Homey Energy counts them. Before that,
 *  Insights' hours (middle to middle of the hour), bridged to the first whole slot; the hours read
 *  that way only begin at 23:30 when the app started after midnight. */
export function useToday(m: MeterReads, hours: number[], now = Date.now()): {use: Map<number, number>; slots: Map<number, number>} {
    const use = new Map<number, number>(), slots = new Map<number, number>();
    const first = hours[0], end = hours[hours.length - 1] + HOUR;
    const hourOf = (at: number) => { let h: number | undefined; for (const x of hours) if (x <= at) h = x; return h; };
    const add = (at: number, kwh: number, slot?: number) => {
        if (at < first || at >= end || !(kwh >= 0)) return;
        const h = hourOf(at)!;
        use.set(h, (use.get(h) ?? 0) + kwh);
        if (slot !== undefined) slots.set(slot, (slots.get(slot) ?? 0) + kwh);
    };
    const from = m.liveFrom?.at ?? Infinity;
    for (const [at, kwh] of m.slots) if (at >= from) add(at, kwh, at);
    // Before the first whole slot: Insights' hours that end by then, each mean to the next.
    const cut = Math.min(from, now);
    let last: {end: number; v: number} | undefined;
    // Only a rise past the highest reading is use, as in savings.ts `hourlyUse`: a meter that
    // stepped back (restored from a backup) and catches up later is not an hour's use.
    let high = -Infinity;
    for (let i = 0; i < m.points.length; i++) {
        const p = m.points[i], prev = m.points[i - 1];
        if (p.at + HOUR / 2 > cut) break;
        if (p.v < high * (1 - RESET_SHARE)) high = -Infinity;
        if (prev && p.at - prev.at === HOUR) {
            const kwh = p.v - Math.max(prev.v, high);
            if (kwh >= 0 && kwh < 30) add(p.at, kwh);
        }
        high = Math.max(high, p.v);
        last = {end: p.at + HOUR / 2, v: high};
    }
    // The stretch between: Insights' last middle to the first whole slot, or to now.
    if (last) {
        const to = m.liveFrom ?? {at: now, v: m.meterNow - [...m.slots.values()].reduce((a, b) => a + b, 0)};
        const kwh = to.v - last.v;
        if (kwh > 0 && kwh < 30 * Math.max(1, (to.at - last.end) / HOUR)) add(Math.max(last.end, to.at - 1), kwh);
    }
    // Still in the first slot: what it added so far.
    if (!m.liveFrom) for (const [at, kwh] of m.slots) add(at, kwh);
    return {use, slots};
}

/** The heating graph under the electricity chart, per 15-minute slot of today (index = slot from local
 *  midnight; a clock-change day has 92 or 100). `offset` is BT1 as sent minus the real outdoor
 *  temperature (positive = sent warmer, so it heats less), recorded before `planFrom` and Autopilot's
 *  plan from it; `indoor` the recorded reading, before `planFrom` only; `expected` the plan's indoor
 *  from `planFrom` on. */
export interface HeatingGraph {
    offset?: (number | null)[];
    indoor?: (number | null)[];
    expected?: (number | null)[];
    /** The thermostat, drawn as a dashed line on the indoor strip. */
    setpoint?: number;
    /** The first slot that is plan, not record. */
    planFrom: number;
    shiftAxis?: Axis;
    indoorAxis?: Axis;
}

/** The graph's series from heating's slots (widget.ts `heatingSlots`: the past, then the plan from
 *  `now`). The shift is left out where nothing was ever sent today and nothing is planned, so an owner
 *  without Autopilot heating sees no flat line; indoor where there is no reading; expected without a plan. */
export function heatingSeries(slots: WidgetSlot[], now: number, setpoint?: number): HeatingGraph {
    const offset = slots.map((s) => (s.offset === undefined ? null : s.offset));
    const indoor = slots.map((s, k) => (k < now && s.indoor !== undefined ? s.indoor : null));
    const shifts = offset.filter((v): v is number => v !== null);
    const expected = slots.map((s, k) => (k >= now && s.indoor !== undefined ? s.indoor : null));
    const readings = indoor.filter((v): v is number => v !== null);
    const planned = expected.filter((v): v is number => v !== null);
    const out: HeatingGraph = {planFrom: now, ...Number.isFinite(setpoint) ? {setpoint} : {}};
    if (shifts.some((v) => v !== 0)) {
        const m = Math.max(...shifts.map(Math.abs));
        out.offset = offset;
        // Labelled at its ends and 0 only, so a finer step fits the bars to the card.
        out.shiftAxis = niceAxis(-m, m, {include: [0], steps: [1, 2, 5, 10], maxIntervals: 6});
    }
    if (planned.length) out.expected = expected;
    if (readings.length || planned.length) {
        const span = [...readings, ...planned, ...out.setpoint === undefined ? [] : [out.setpoint]];
        if (readings.length) out.indoor = indoor;
        out.indoorAxis = niceAxis(Math.min(...span) - 0.2, Math.max(...span) + 0.2, {minSpan: 0.6, steps: [0.5, 1, 2, 5], maxIntervals: 3});
    }
    return out;
}

/** Currencies whose unit is worth about a quarter of a euro or less: a day's cost is written in whole
 *  units ("149 kr"). The rest round to 10 cents ("€5.30"), about the same step in money. */
const SMALL_UNIT = new Set(['SEK', 'NOK', 'DKK', 'ISK', 'CZK', 'PLN', 'HUF', 'RON', 'JPY', 'ZAR']);

/** A day's cost as an owner reads a bill, not to the öre. */
export function dayCostText(v: number, language: string, currency: string): string {
    const code = currency.toUpperCase();
    if (SMALL_UNIT.has(code) || !/^[A-Z]{3}$/.test(code)) return moneyText(Math.round(v), 0, language, currency);
    return moneyText(Math.round(v * 10) / 10, 2, language, currency);
}

/** Everything the widget draws, translated. Without `chart` it shows `empty`, or the loading state. */
export interface EnergyWidgetData {
    title: string;
    /** The card's heading. */
    heading?: string;
    badge?: string;
    empty?: string;
    loading?: boolean;
    chart?: EnergyChart;
    /** The three numbers, each a value and its label. */
    numbers?: {value: string; label: string; good?: boolean}[];
    /** Now in hours from midnight, at its 15-minute slot (14.75 is 14:45), the hours to label, and the legend. */
    now?: number;
    ticks?: {at: number; label: string}[];
    legend?: {heating: string; hotwater: string; main: string; price: string; offset?: string; indoor?: string; expected?: string};
    axes?: {kwh: string; price: string; offset?: string; indoor?: string};
    /** The heating graph's series; absent without a Heating device. */
    heating?: HeatingGraph;
}
