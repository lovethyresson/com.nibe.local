/** The Day plan dashboard widget's data (widgets/day_plan): one pump's whole plan over today,
 *  00:00 to 24:00 local, in three lanes: the price, hot water's charges and heating's shift. It is
 *  the plan round (orchestrator.ts) drawn, with Main's status line as its headline. Pure: the Main
 *  device gathers the two Autopilot widgets' data and this lays them on one time axis. Strings
 *  arrive translated, so the widget needs no locales. */
import {Axis, ChargeBand, ShiftBar, WidgetData, niceAxis, shiftBars, symmetricAxis} from './widget';

export interface DayPlanData {
    title: string;
    /** Main's status line: what runs next and why. */
    status?: string;
    chips: string[];
    badge?: string;
    /** The price per slot, where known. */
    prices: (number | undefined)[];
    /** First slot that is the plan rather than the past. */
    now?: number;
    ticks: {at: number; label: string}[];
    scale?: {price?: Axis; shift?: Axis};
    /** Hot water's planned charges; undefined while hot water has no Autopilot. */
    bands?: ChargeBand[];
    /** Heating's shift an hour at a time, positive when it heats more; undefined while heating
     *  has no Autopilot. */
    bars?: ShiftBar[];
    lanes: {price: string; hotwater?: string; heating?: string};
    legend: Record<string, string>;
    /** One quiet line under a lane that has nothing in it. */
    quiet?: {hotwater?: string; heating?: string};
    loading?: boolean;
    empty?: string;
}

export type Translate = (key: string, tokens?: Record<string, string | number>) => string;

/** Today's plan from the two Autopilot widgets' data (`kind: 'none'` or missing when that
 *  function has no Autopilot). `heatingPrices` fills the price lane where hot water has none:
 *  heating's forecast, from `now` on. `t` reads keys under `autopilot.day_plan`, `w` under
 *  `autopilot.widget`. Pure. */
export function dayPlanData(input: {title: string; status?: string; hotwater?: WidgetData; heating?: WidgetData;
    heatingPrices?: (number | undefined)[]; ticks: {at: number; label: string}[]; n: number; now: number;
    t: Translate; w: Translate}): DayPlanData {
    const {t, w, n, now} = input;
    const hot = input.hotwater?.kind === 'hotwater' ? input.hotwater : undefined;
    const heat = input.heating?.kind === 'heating' ? input.heating : undefined;
    const base = {title: input.title, chips: [] as string[], prices: [], ticks: input.ticks,
        lanes: {price: w('axis_price')}, legend: {}};
    if (!hot && !heat) return {...base, empty: t('off')};
    const test = [hot, heat].filter(Boolean).every((d) => d!.test);
    const chips = test ? [w('test')] : [];
    const loading = [hot, heat].filter(Boolean).every((d) => d!.loading);
    const fromHot = hot?.slots.map((s) => s.price) ?? [];
    const prices = Array.from({length: n}, (_, k) => fromHot[k] ?? input.heatingPrices?.[k]);
    const known = prices.filter((p): p is number => p !== undefined);
    // Heat up reads up: a bar above the line is a pre-heat, below it an ease-off. The heating
    // widget's offset is what the pump is sent (fed − real), the other way round.
    const bars = heat ? shiftBars(heat.slots).map((b) => ({...b, value: -b.value + 0})) : undefined;
    const bands = hot ? hot.bands ?? [] : undefined;
    const solar = !!bands?.some((b) => b.solar > 0);
    return {
        ...base, status: input.status, chips, badge: w('experimental'), prices, now, loading: loading || undefined,
        scale: {price: known.length ? niceAxis(Math.min(0, ...known), Math.max(0, ...known), {steps: [0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100]}) : undefined,
            shift: bars ? symmetricAxis(bars.map((b) => b.value)) : undefined},
        bands, bars,
        lanes: {price: w('axis_price'), hotwater: hot ? t('lane_hotwater') : undefined, heating: heat ? t('lane_heating') : undefined},
        legend: {price: w('price'), grid: hot ? w('charge_grid') : '', solar: solar ? w('charge_solar') : '',
            more: heat ? t('more') : '', less: heat ? t('less') : ''},
        quiet: {hotwater: hot && !hot.loading && !bands!.some((b) => b.to > now) ? t('no_charge') : undefined,
            heating: heat && !heat.loading && !bars!.some((b) => b.to > now) ? t('no_shift') : undefined},
    };
}
