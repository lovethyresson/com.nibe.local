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
