/** The Overview widget's data (widgets/overview): one heat pump at a glance. A ring of today's use
 *  by the day's price thirds (as Energy today and the savings widgets rank them), the month's
 *  savings beside it (the savings widgets' own figures, added up), one row per function device, and
 *  at most two lines that need the owner. Pure: the device gathers the figures, already worded. */

export type OverviewKind = 'heating' | 'hotwater' | 'pool' | 'cooling';
export const OVERVIEW_KINDS: OverviewKind[] = ['heating', 'hotwater', 'pool', 'cooling'];

/** A small bar under a row: a temperature on its range, or the tank's fill. */
export type OverviewBar =
    | {type: 'range'; min: number; max: number; value: number; set?: number; lo?: number; hi?: number}
    | {type: 'fill'; value: number; max: number};

export interface OverviewRow {
    kind: OverviewKind;
    name: string;
    state?: string;
    value?: string;
    /** Not running: the value is a dash, drawn quieter. */
    muted?: boolean;
    bar?: OverviewBar;
}

export interface OverviewLine {
    tone: 'bad' | 'warn';
    text: string;
}

export interface OverviewData {
    title: string;
    chip?: string;
    /** The chip as an outline: the heat pump is not answering. */
    chipQuiet?: boolean;
    empty?: string;
    loading?: boolean;
    /** Today's kWh in the cheapest, middle and most expensive third of the day's hours, and the
     *  cheap share in the middle ("69 %") with its word under it. */
    ring?: {tiers: [number, number, number]; centre: string; label: string};
    /** The headline beside the ring: savings this month, or what today cost before there are any. */
    hero?: {value: string; label: string; good?: boolean};
    /** One quieter line under the headline. */
    line?: string;
    rows: OverviewRow[];
    attention: OverviewLine[];
}

/** At most this many attention lines. */
export const MAX_LINES = 2;

export interface OverviewInput {
    title: string;
    /** Autopilot runs on at least one function. */
    autopilot: boolean;
    /** The heat pump is not answering: the reason, worded. */
    offline?: string;
    /** The pump's alarm, worded; undefined with none standing. */
    alarm?: string;
    /** The function devices' warnings, in row order: problems before advice. */
    warnings: {text: string; advice?: boolean}[];
    /** Today's kWh per price third; undefined before the meters and prices are read. */
    tiers?: [number, number, number];
    /** Energy today's cheap share (0–1), so both show the same percentage; the tiers' own when absent. */
    cheapShare?: number;
    /** What today cost so far, worded as Energy today shows it. */
    spent?: string;
    /** This month's savings, worded, the month's name, and whether it is a saving (not a loss);
     *  undefined while there are none to show. */
    saved?: {value: string; month: string; good?: boolean};
    rows: OverviewRow[];
}

export type Translate = (key: string, tokens?: Record<string, string | number>) => string;

export function overviewData(i: OverviewInput, t: Translate): OverviewData {
    const attention: OverviewLine[] = [
        ...i.offline ? [{tone: 'bad' as const, text: i.offline}] : [],
        ...i.alarm ? [{tone: 'bad' as const, text: i.alarm}] : [],
        ...i.warnings.filter((w) => !w.advice).map((w) => ({tone: 'bad' as const, text: w.text})),
        ...i.warnings.filter((w) => w.advice).map((w) => ({tone: 'warn' as const, text: w.text})),
    ];
    // The same text from two devices (a pump-wide problem) is one line.
    const lines = attention.filter((l, k) => attention.findIndex((m) => m.text === l.text) === k).slice(0, MAX_LINES);
    const chip = i.offline ? {chip: t('offline'), chipQuiet: true} : i.autopilot ? {chip: 'Autopilot'} : {};
    const total = i.tiers ? i.tiers[0] + i.tiers[1] + i.tiers[2] : 0;
    const ring = i.tiers && total > 0
        ? {tiers: i.tiers, centre: `${Math.round((i.cheapShare ?? i.tiers[0] / total) * 100)} %`, label: t('cheap')} : undefined;
    const hero = i.saved
        ? {value: i.saved.value, label: t('saved_month', {month: i.saved.month}), good: i.saved.good !== false}
        : i.spent ? {value: i.spent, label: t('spent')} : undefined;
    const line = i.saved && i.spent ? t('spent_line', {cost: i.spent}) : undefined;
    return {title: i.title, ...chip, ...ring ? {ring} : {}, ...hero ? {hero} : {}, ...line ? {line} : {},
        rows: i.rows, attention: lines};
}

/** The kWh in each third of the day's hours, ranked by price as the savings widgets rank them
 *  (savings.ts savingsDay): the cheapest third first. `use` and `prices` by hour start. */
export function priceThirds(hours: number[], use: (at: number) => number, prices: Map<number, number>): [number, number, number] | undefined {
    const priced = hours.filter((at) => prices.has(at));
    if (!priced.length) return undefined;
    const ranked = [...priced].sort((a, b) => prices.get(a)! - prices.get(b)! || a - b);
    const tiers: [number, number, number] = [0, 0, 0];
    ranked.forEach((at, k) => { tiers[Math.min(2, Math.floor(k * 3 / ranked.length))] += use(at); });
    return tiers;
}
