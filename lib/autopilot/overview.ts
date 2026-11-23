/** The Overview widget's data (widgets/overview): one heat pump at a glance, in three levels
 *  (2026-11-23, after the owner found the ring-and-savings card unclear about what mattered):
 *  1. what needs the owner (a band: offline, an alarm, a warning) and what the pump does now;
 *  2. a tile per function: indoor temperature against target, hot water litres and the next run;
 *  3. quiet facts: power now, today so far and by midnight, the month's savings, the price paid
 *     against the market's.
 *  Pure: the device gathers the figures, already worded. */

export type OverviewKind = 'heating' | 'hotwater' | 'pool' | 'cooling';
export const OVERVIEW_KINDS: OverviewKind[] = ['heating', 'hotwater', 'pool', 'cooling'];
export type NowKind = OverviewKind | 'idle';

export interface OverviewTile {
    kind: OverviewKind;
    label: string;
    value?: string;
    sub?: string;
}

/** A quiet line in the facts list; `good` marks a saving (the one coloured value). */
export interface OverviewFact {
    label: string;
    value: string;
    good?: boolean;
}

export interface OverviewAlert {
    tone: 'bad' | 'warn';
    title: string;
    text?: string;
}

export interface OverviewNow {
    kind: NowKind;
    title: string;
    sub?: string;
}

export interface OverviewData {
    title: string;
    /** The day type, only when it is not a working day. */
    chip?: string;
    empty?: string;
    loading?: boolean;
    alert?: OverviewAlert;
    now?: OverviewNow & {quiet?: boolean};
    tiles: OverviewTile[];
    facts: OverviewFact[];
    /** The pump is not answering: tiles and facts are the last readings, drawn faded. */
    stale?: boolean;
}

export interface OverviewInput {
    title: string;
    dayType?: string;
    /** The heat pump is not answering: the reason, worded. */
    offline?: string;
    /** The pump's alarm, worded; undefined with none standing. */
    alarm?: string;
    /** The function devices' warnings: problems before advice. */
    warnings: {text: string; advice: boolean}[];
    now?: OverviewNow;
    tiles: OverviewTile[];
    facts: OverviewFact[];
}

export type Translate = (key: string, tokens?: Record<string, string | number>) => string;

/** A warning's first sentence as the band's title, the rest under it. */
export function splitWarning(text: string): {title: string; text?: string} {
    const at = text.search(/[.!?]\s/);
    if (at < 0) return {title: text.replace(/[.]$/, '')};
    return {title: text.slice(0, at), text: text.slice(at + 2).trim() || undefined};
}

export function overviewData(i: OverviewInput, t: Translate): OverviewData {
    const chip = i.dayType ? {chip: i.dayType} : {};
    // One band, the most serious first: no answer, then an alarm, then a problem, then advice.
    const warning = i.warnings.find((w) => !w.advice) ?? i.warnings[0];
    const alert: OverviewAlert | undefined = i.offline ? {tone: 'bad', title: t('offline_title'), text: i.offline}
        : i.alarm ? {tone: 'bad', title: t('alarm_title'), text: i.alarm}
            // A device warning is something to do, not a fault: amber, as the design has it.
            : warning ? {tone: 'warn', ...splitWarning(warning.text)} : undefined;
    // Offline, the band says it all: no activity line, and the rest is the last readings.
    const now = i.offline || !i.now ? undefined : {...i.now, ...alert ? {quiet: true} : {}};
    return {title: i.title, ...chip, ...alert ? {alert} : {}, ...now ? {now} : {}, tiles: i.tiles, facts: i.facts,
        ...i.offline ? {stale: true} : {}};
}

const HOUR_MS = 3_600_000;

/** What the day plans still expect after the current hour: their cost, and the kWh at each hour's
 *  price. A plan's `expected` counts hours from its own `from` (cost-check.ts), not from midnight. */
export function plannedAhead(plans: {from: number; expected: number[]}[], nowHour: number,
                             priceAt: (hourStart: number) => number | undefined): {kwh: number; cost: number} {
    let kwh = 0, cost = 0;
    for (const p of plans) p.expected.forEach((expected, h) => {
        const ms = p.from + h * HOUR_MS;
        if (ms <= nowHour || !(expected > 0)) return;
        cost += expected;
        const price = priceAt(ms);
        if (price !== undefined && price > 0) kwh += expected / price;
    });
    return {kwh, cost};
}
