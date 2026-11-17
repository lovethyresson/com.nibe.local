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
    prices: Map<number, number>): EnergyChart {
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
            if (hour.price !== undefined) cost += v * hour.price;
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

/** Today's use up to now. Insights' hours (`hourlyUse`) arrive with the hourly refresh, so they end
 *  an hour or two back; the rest comes from the meter itself. `seam` is Insights' last point (the
 *  meter's mean over that hour, so about its middle); `meterNow` the meter now; `live` what the
 *  meter added in each hour since the app started (hour start, ms). The hours after the seam take
 *  their live kWh, and whatever the meter added since the seam beyond those (the half hour after
 *  the seam, or hours from before a restart) goes to the hour after the seam, or to this hour. So
 *  the total is the meter's own, as Homey Energy shows it. */
export function withLiveHours(insights: Map<number, number>, seam: {at: number; v: number} | undefined,
    meterNow: number, live: Map<number, number>, now = Date.now()): Map<number, number> {
    const out = new Map(insights);
    if (!seam) {
        for (const [at, v] of live) if (!out.has(at)) out.set(at, v);
        return out;
    }
    let after = 0;
    for (const [at, v] of live) if (at > seam.at) { out.set(at, v); after += v; }
    const rest = meterNow - seam.v - after;
    // Never past the hour now: Insights' last point can be this hour's, still filling.
    const to = Math.min(seam.at + HOUR, Math.floor(now / HOUR) * HOUR);
    // A meter set back by hand, or a seam not read from this meter: nothing to add.
    if (rest > 0 && rest < 30) out.set(to, (out.get(to) ?? 0) + rest);
    return out;
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
