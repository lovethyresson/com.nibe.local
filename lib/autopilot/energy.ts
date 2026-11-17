/** The Energy today widget's data (widgets/energy): the heat pump's electricity per hour today,
 *  split by function, against the hour's price, and three numbers: kWh so far, what it cost, and
 *  the share used in the day's cheapest hours. Pure; the device gathers the inputs. */
import {niceAxis} from './widget';

/** The functions whose use is shown, in stacking order (bottom first). */
export const ENERGY_ROLES = ['heating', 'hotwater'] as const;
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
    for (let i = 0; i < m.points.length; i++) {
        const p = m.points[i], prev = m.points[i - 1];
        if (p.at + HOUR / 2 > cut) break;
        if (prev && p.at - prev.at === HOUR) {
            const kwh = p.v - prev.v;
            if (kwh >= 0 && kwh < 30) add(p.at, kwh);
        }
        last = {end: p.at + HOUR / 2, v: p.v};
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

/** Everything the widget draws, translated. Without `chart` it shows `empty`, or the loading state. */
export interface EnergyWidgetData {
    title: string;
    badge?: string;
    empty?: string;
    loading?: boolean;
    chart?: EnergyChart;
    /** The three numbers, each a value and its label. */
    numbers?: {value: string; label: string; good?: boolean}[];
    /** The hour now (index), the hours to label, and the legend. */
    now?: number;
    ticks?: {at: number; label: string}[];
    legend?: {heating: string; hotwater: string; price: string};
    axes?: {kwh: string; price: string};
}
