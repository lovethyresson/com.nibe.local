/** The Hot water tank widget's chart (widgets/hotwater_tank): the tank over today, read behind now
 *  and planned from now, the use per hour against the forecast, and the charges. Pure; the device
 *  gathers the inputs and translates, the widget only draws. */
import {TankView} from './hotwater-shadow';
import {ChargeBand, niceAxis} from './widget';

export interface TankSlot {
    /** Litres of 40 °C water read (behind now) and planned (from now). */
    read?: number;
    plan?: number;
    /** A charge planned in this slot, with its share from solar surplus (0–1). */
    charge?: number;
    /** The tank charged in this slot. */
    ran?: true;
    /** Today's price in thirds: 0 cheapest, 2 most expensive. Missing without a price. */
    tier?: 0 | 1 | 2;
}

export interface TankHour {
    /** Litres of 40 °C water drawn in the hour; missing where it could not be read. */
    drawn?: number;
    /** Litres the plan expects in the hour. */
    forecast: number;
}

export interface TankChart {
    slots: TankSlot[];
    hours: TankHour[];
    /** Top of the litres axis, and its gridlines. */
    max: number;
    gridlines: number[];
    /** Drawn today so far and the day's forecast, litres. */
    used: number;
    expected: number;
}

const tierOf = (prices: (number | undefined)[]) => {
    const ranked = prices.map((p, k) => [p, k] as const).filter(([p]) => p !== undefined).sort((a, b) => a[0]! - b[0]!);
    const tiers: (0 | 1 | 2 | undefined)[] = new Array(prices.length).fill(undefined);
    ranked.forEach(([, k], i) => { tiers[k] = Math.min(2, Math.floor(i * 3 / ranked.length)) as 0 | 1 | 2; });
    return tiers;
};

/** The chart for a day of slots, `now` the index of the slot now. */
export function tankChart(view: TankView, now: number): TankChart {
    const tiers = tierOf(view.slots.map((s) => s.price));
    const slots = view.slots.map((s, k): TankSlot => ({
        ...k <= now && view.read[k] !== undefined ? {read: view.read[k]} : {},
        ...k >= now && view.plan[k] !== undefined ? {plan: view.plan[k]} : {},
        ...s.charge !== undefined ? {charge: s.charge} : {},
        ...s.ran ? {ran: true as const} : {},
        ...tiers[k] !== undefined ? {tier: tiers[k]} : {},
    }));
    // The plan starts at the slot it was made in; until the next step that can be a slot behind.
    // Draw it from now with the reading now, so the two lines meet.
    if (slots[now] && slots[now].read !== undefined) slots[now].plan = slots[now].read;
    const nowHour = Math.floor(now / 4);
    const hours = view.forecast.map((forecast, h): TankHour => ({
        forecast, ...h <= nowHour && view.drawn[h] !== undefined ? {drawn: view.drawn[h]} : {}}));
    const litres = slots.flatMap((s) => [s.read ?? 0, s.plan ?? 0]);
    const axis = niceAxis(0, Math.max(100, ...litres), {steps: [25, 50, 100, 200]});
    const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0));
    return {slots, hours, max: axis.hi, gridlines: axis.ticks,
        used: sum(hours.flatMap((h) => h.drawn === undefined ? [] : [h.drawn])), expected: sum(view.forecast)};
}

/** Everything the widget draws, translated. Without `slots` it shows `empty`, or the loading state. */
export interface TankWidgetData extends Partial<TankChart> {
    title: string;
    badge?: string;
    test?: boolean;
    loading?: boolean;
    empty?: string;
    status?: string;
    reason?: string;
    now?: number;
    bands?: ChargeBand[];
    reserve?: number;
    ticks?: {at: number; label: string}[];
    legend?: Record<string, string>;
    axis?: string;
}
