/** The Autopilot savings widget's data (widgets/savings): when a function used its electricity,
 *  read from the meter. Each day's hours are split into the cheapest, middle and dearest third
 *  by that day's price, and the function's kWh are summed per third. Autopilot works when its days
 *  move kWh out of the dearest third, and when the price paid per kWh sits under the day's average.
 *  No house model, no counterfactual: the meter and the prices, so an owner can check it
 *  (autopilot-plan.md §11 keeps the modelled figure for later). Pure; the device gathers the
 *  inputs and the widget only draws. Strings arrive translated. */

const HOUR = 3_600_000;

/** One complete local day of one function. */
export interface SavingsDay {
    /** Local date, 'YYYY-MM-DD'. */
    date: string;
    /** kWh used in the cheapest, middle and dearest third of the day's hours. */
    tiers: [number, number, number];
    /** What those kWh cost at each hour's price. */
    cost: number;
    /** The day's average price over its hours, unweighted: what a flat use would have paid. */
    mean: number;
    /** Share of the day's hours Autopilot ran live (0–1); missing where it is not known. */
    live?: number;
}

/** kWh per hour (hour start, ms) from Insights' hourly points of a cumulative meter. Each point is
 *  the meter's mean over its hour, so two neighbours differ by the use from the middle of one hour
 *  to the middle of the next; that is credited to the later hour. A gap, a reset or a jump no
 *  heat pump makes in an hour is left out. */
export function hourlyUse(points: {t: string; v: number | null}[]): Map<number, number> {
    const out = new Map<number, number>();
    let prev: {at: number; v: number} | undefined;
    for (const p of points) {
        const at = Date.parse(p.t);
        if (!Number.isFinite(at) || typeof p.v !== 'number' || !Number.isFinite(p.v)) { prev = undefined; continue; }
        if (prev && at - prev.at === HOUR) {
            const kwh = p.v - prev.v;
            if (kwh >= 0 && kwh < 30) out.set(at, kwh);
        }
        prev = {at, v: p.v};
    }
    return out;
}

/** Price per hour (hour start, ms): the mean of its 15-minute slots. */
export function hourlyPrices(slots: {slot: number; price: number}[], slotMs: number): Map<number, number> {
    const sums = new Map<number, {sum: number; n: number}>();
    for (const s of slots) {
        const at = Math.floor(s.slot * slotMs / HOUR) * HOUR;
        const e = sums.get(at) ?? {sum: 0, n: 0};
        e.sum += s.price; e.n += 1;
        sums.set(at, e);
    }
    return new Map([...sums].map(([at, e]) => [at, e.sum / e.n]));
}

/** A day from its hours. Every hour needs a price; up to two hours without a meter reading count
 *  as no use, and a day with more gaps is left out, since its missing kWh would land in no third. */
export function savingsDay(date: string, hours: number[], use: Map<number, number>, prices: Map<number, number>,
    live?: number): SavingsDay | undefined {
    const priced = hours.filter((at) => prices.has(at));
    if (priced.length < hours.length || hours.length < 20) return undefined;
    const metered = priced.filter((at) => use.has(at));
    if (metered.length < hours.length - 2) return undefined;
    const ranked = [...priced].sort((a, b) => prices.get(a)! - prices.get(b)! || a - b);
    const tiers: [number, number, number] = [0, 0, 0];
    let cost = 0;
    ranked.forEach((at, i) => {
        const kwh = use.get(at) ?? 0;
        tiers[Math.min(2, Math.floor(i * 3 / ranked.length))] += kwh;
        cost += kwh * prices.get(at)!;
    });
    const mean = priced.reduce((s, at) => s + prices.get(at)!, 0) / priced.length;
    return {date, tiers: tiers.map(round) as [number, number, number], cost: round(cost), mean: round(mean), live};
}

/** Days kept. The chart shows the last 14; the days without Autopilot are compared over all of
 *  these, so the comparison stays after two weeks of Autopilot. */
export const LEDGER_DAYS = 60;

/** The stored days with fresh ones merged in, one per date, oldest first. */
export function mergeDays(stored: SavingsDay[], fresh: SavingsDay[]): SavingsDay[] {
    const byDate = new Map(stored.map((d) => [d.date, d]));
    for (const d of fresh) byDate.set(d.date, d);
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-LEDGER_DAYS);
}

/** A day counts as Autopilot's when it ran live most of the day, and as one without when it hardly
 *  ran; a day it was switched on halfway counts as neither. */
export const isAutopilotDay = (d: SavingsDay) => d.live !== undefined && d.live >= 0.8;
export const isOtherDay = (d: SavingsDay) => d.live !== undefined && d.live <= 0.2;

/** A set of days in one figure: kWh, its dearest third's share, and the price paid against the
 *  days' average (at the same kWh per day). */
export interface Totals {
    days: number;
    kwh: number;
    dearShare: number;
    paid: number;
    mean: number;
}

export function totals(days: SavingsDay[]): Totals | undefined {
    const used = days.filter((d) => d.tiers[0] + d.tiers[1] + d.tiers[2] > 0);
    if (!used.length) return undefined;
    const kwh = used.reduce((s, d) => s + d.tiers[0] + d.tiers[1] + d.tiers[2], 0);
    const dear = used.reduce((s, d) => s + d.tiers[2], 0);
    const cost = used.reduce((s, d) => s + d.cost, 0);
    const flat = used.reduce((s, d) => s + (d.tiers[0] + d.tiers[1] + d.tiers[2]) * d.mean, 0);
    return {days: used.length, kwh, dearShare: dear / kwh, paid: cost / kwh, mean: flat / kwh};
}

export type Translate = (key: string, tokens?: Record<string, string | number>) => string;

export interface SavingsBar {
    /** Short day label, in the owner's language. */
    label: string;
    tiers: [number, number, number];
    autopilot: boolean;
}

export interface SavingsData {
    title: string;
    /** The "Experimental" mark, shown quietly like the Autopilot widget's. */
    badge?: string;
    /** "Price per kWh" with Autopilot, or "Before Autopilot". */
    status?: string;
    /** The price paid against the days' average, signed: "−20 %". */
    value?: string;
    /** Autopilot's days under the average (good) or over it. Before Autopilot the figure is the
     *  baseline and gets no colour (neutral). */
    tone?: 'good' | 'bad' | 'neutral';
    reason?: string;
    detail?: string;
    axis?: string;
    bars?: SavingsBar[];
    legend?: Record<string, string>;
    footnote?: string;
    empty?: string;
}

/** Days the chart shows. */
export const CHART_DAYS = 14;

/** The widget's text and bars. `label` turns a date into a short day label; `money` formats a price. */
export function savingsData(title: string, days: SavingsDay[], t: Translate, label: (date: string) => string,
    money: (v: number) => string, badge?: string): SavingsData {
    const shown = days.slice(-CHART_DAYS);
    if (!shown.length) return {title, empty: t('empty')};
    const ap = totals(shown.filter(isAutopilotDay));
    // The days without Autopilot are the baseline: all the ledger keeps, not only the chart's.
    const other = totals(days.filter(isOtherDay));
    const pct = (v: number) => Math.round(v * 100);
    // Nothing sorted yet (no record of the Smart mode before this version): the chart's days as they are.
    const focus = ap ?? other ?? totals(shown);
    const off = focus ? pct(focus.paid / focus.mean - 1) : 0;
    const reason = focus ? [t('paid', {paid: money(focus.paid), mean: money(focus.mean)}),
        focus.days === 1 ? t('days_one') : t('days', {days: focus.days})].join(' · ') : undefined;
    const detail = ap && other ? t('dear_both', {a: pct(ap.dearShare), b: pct(other.dearShare)})
        : focus ? t('dear_one', {a: pct(focus.dearShare)}) : undefined;
    return {
        title, badge,
        status: ap || !other ? t('status_autopilot') : t('status_before'),
        value: focus ? `${off > 0 ? '+' : off < 0 ? '\u2212' : ''}${Math.abs(off)} %` : undefined,
        tone: !focus ? undefined : !ap ? 'neutral' : off <= 0 ? 'good' : 'bad',
        reason, detail,
        axis: t('axis'),
        bars: shown.map((d) => ({label: label(d.date), tiers: d.tiers, autopilot: isAutopilotDay(d)})),
        legend: {cheap: t('cheap'), middle: t('middle'), dear: t('dear'), autopilot: t('autopilot_day')},
        footnote: t('footnote'),
    };
}

function round(v: number): number {
    return Math.round(v * 1000) / 1000;
}

/** The hour starts (ms) of local date `date`, by `localDateOf` (the owner's time zone): 23, 24 or
 *  25 of them. The search runs 36 h either side of UTC noon, so every UTC offset is covered. */
export function dayHours(date: string, localDateOf: (ms: number) => string): number[] {
    const noon = Date.parse(`${date}T12:00:00Z`);
    const out: number[] = [];
    for (let at = noon - 36 * HOUR; at <= noon + 36 * HOUR; at += HOUR) if (localDateOf(at) === date) out.push(at);
    return out;
}

/** A Smart mode change, as kept for this widget: when, and whether Autopilot then ran live. */
export interface ModeMark {
    at: number;
    live: boolean;
}

/** Whether Autopilot ran live in the hour starting `at`, from the marks (oldest first); undefined
 *  before the first. */
export function liveAt(marks: ModeMark[], at: number): boolean | undefined {
    let live: boolean | undefined;
    for (const m of marks) {
        if (m.at > at) break;
        live = m.live;
    }
    return live;
}

/** Share of `hours` Autopilot ran live, from what each hour says (undefined: not known). Known for
 *  fewer than three quarters of the hours: not known. */
export function liveShare(hours: number[], live: (at: number) => boolean | undefined): number | undefined {
    const known = hours.map(live).filter((v): v is boolean => v !== undefined);
    if (known.length < hours.length * 0.75) return undefined;
    return round(known.filter(Boolean).length / known.length);
}
