/** Plan vs actual: what the morning plan expected a function's electricity to cost over the rest
 *  of the day, and what it did cost. Each Heating and Hot water device keeps its own ledger; the
 *  widget (widgets/cost_check) shows a pump's two side by side. Pure. */

const HOUR = 3_600_000;
/** Days kept, and how long a day may wait for its last hours' readings before it is closed. */
export const COST_CHECK_DAYS = 8;
const CLOSE_AFTER_MS = 2 * 24 * HOUR;

/** One day's check. Hours run from `from` (the plan's first hour) to `until` (local midnight). */
export interface CostDay {
    /** Local date, 'YYYY-MM-DD'. */
    date: string;
    from: number;
    until: number;
    /** What the plan expected each hour to cost. */
    expected: number[];
    /** What each hour cost: its electricity at its price; null until both are known. */
    actual: (number | null)[];
    /** No more hours will be filled: every one is known, or the day is too old to wait for. */
    done?: boolean;
}

/** A planned cost at a moment: a slot of the heating plan, or a slice of a hot water charge. */
export interface PlannedCost {
    at: number;
    cost: number;
}

/** The day's check as the plan left it: each planned cost summed into its hour, from the plan's
 *  first hour (rounded down) to `until`. Costs outside the window are left out. */
export function costDay(date: string, from: number, until: number, planned: PlannedCost[]): CostDay {
    const start = Math.floor(from / HOUR) * HOUR;
    const hours = Math.max(0, Math.ceil((until - start) / HOUR));
    const expected = new Array<number>(hours).fill(0);
    for (const p of planned) {
        const h = Math.floor((p.at - start) / HOUR);
        if (h >= 0 && h < hours && Number.isFinite(p.cost)) expected[h] += p.cost;
    }
    return {date, from: start, until, expected: expected.map(round), actual: new Array(hours).fill(null)};
}

/** A hot water charge spread evenly over its minutes, so a charge across an hour's edge is split. */
export function chargeCosts(charges: {at: number; minutes: number; cost: number}[], slotMs: number): PlannedCost[] {
    return charges.flatMap((c) => {
        const n = Math.max(1, Math.round(c.minutes * 60_000 / slotMs));
        return Array.from({length: n}, (_, k) => ({at: c.at + k * slotMs, cost: c.cost / n}));
    });
}

/** The ledger with `day` added, unless its date is already there: the first plan of a day is the
 *  one it is held to. The newest COST_CHECK_DAYS are kept. */
export function addDay(ledger: CostDay[], day: CostDay): CostDay[] {
    if (ledger.some((d) => d.date === day.date)) return ledger;
    return [...ledger, day].sort((a, b) => a.date.localeCompare(b.date)).slice(-COST_CHECK_DAYS);
}

/** Fill the hours that have both a reading (`use`, kWh by hour start) and a price (by hour start)
 *  and have ended. A day closes when every hour is known, or two days after it ended. The same
 *  array back when nothing changed. */
export function fillActual(ledger: CostDay[], use: Map<number, number>, prices: Map<number, number>, now: number): CostDay[] {
    let changed = false;
    const out = ledger.map((d) => {
        if (d.done) return d;
        let actual = d.actual;
        d.actual.forEach((v, h) => {
            const at = d.from + h * HOUR;
            if (v !== null || at + HOUR > now || !use.has(at) || !prices.has(at)) return;
            if (actual === d.actual) actual = [...d.actual];
            actual[h] = round(use.get(at)! * prices.get(at)!);
        });
        const done = actual.every((v) => v !== null) || now - d.until > CLOSE_AFTER_MS;
        if (actual === d.actual && !done) return d;
        changed = true;
        return {...d, actual, ...done ? {done: true} : {}};
    });
    return changed ? out : ledger;
}

/** A day's sums. `complete` when every hour is known; `expectedKnown` is what the plan expected
 *  over the hours that have a reading, the fair yardstick for `actual` while the day runs (the
 *  meter's hours come in an hour or two late). */
export function dayTotals(d: CostDay) {
    let expected = 0, actual = 0, expectedKnown = 0, known = 0;
    d.expected.forEach((v, h) => {
        expected += v;
        const a = d.actual[h];
        if (a === null || a === undefined) return;
        actual += a; expectedKnown += v; known++;
    });
    return {expected: round(expected), actual: round(actual), expectedKnown: round(expectedKnown), complete: known === d.actual.length};
}

/** What the widget draws. Every string comes in translated. */
export interface CostCheckData {
    title: string;
    badge?: string;
    empty?: string;
    rows?: {label: string; sofar: string; expected: string; fill: number; mark?: number; tone: 'ahead' | 'behind' | 'even'; note: string}[];
    total?: {label: string; sofar: string; expected: string};
    days?: {head: string[]; rows: {label: string; expected: string; actual: string; diff: string; tone: 'under' | 'over' | 'even' | 'today'}[]};
    footnote?: string;
}

/** A function's ledger, by name. */
export interface CostLedger {
    label: string;
    days: CostDay[];
}

/** Share over (+) or under (−) the plan, rounded to a whole percent; undefined without a plan. */
export function overShare(expected: number, actual: number): number | undefined {
    return expected > 0 ? Math.round((actual / expected - 1) * 100) : undefined;
}

export function costCheckData(title: string, ledgers: CostLedger[], today: string, now: number,
    t: (key: string, tokens?: Record<string, string | number>) => string, money: (v: number) => string,
    dayLabel: (date: string) => string, badge?: string): CostCheckData {
    const withDays = ledgers.filter((l) => l.days.length);
    if (!withDays.length) return {title, badge, empty: t('empty')};
    const pct = (v: number | undefined) => v === undefined ? '' : `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v)} %`;
    const rows = withDays.map((l) => {
        const day = l.days.find((d) => d.date === today);
        const past = l.days.filter((d) => d.date < today && d.done).map((d) => dayTotals(d)).filter((s) => s.complete);
        const week = past.length ? overShare(past.reduce((s, d) => s + d.expected, 0), past.reduce((s, d) => s + d.actual, 0)) : undefined;
        const weekNote = week === undefined ? t('first_day') : t('week', {share: pct(week)});
        if (!day) return {label: l.label, sofar: '–', expected: money(0), fill: 0, tone: 'even' as const, note: t('no_plan_today')};
        const s = dayTotals(day);
        const scale = Math.max(s.expected, s.actual, 1e-9);
        const gap = s.actual - s.expectedKnown;
        const tone = Math.abs(gap) <= Math.max(0.05 * s.expected, 0.2) ? 'even' as const : gap > 0 ? 'ahead' as const : 'behind' as const;
        return {label: l.label, sofar: money(s.actual), expected: money(s.expected), fill: round(s.actual / scale),
            mark: s.complete ? undefined : round(s.expectedKnown / scale), tone, note: `${t(`pace_${tone}`)} · ${weekNote}`};
    });
    const todays = withDays.map((l) => l.days.find((d) => d.date === today)).filter((d): d is CostDay => !!d).map((d) => dayTotals(d));
    const total = withDays.length > 1 && todays.length ? {label: t('both'),
        sofar: money(todays.reduce((s, d) => s + d.actual, 0)), expected: money(todays.reduce((s, d) => s + d.expected, 0))} : undefined;
    // The day list: each date with a plan, both functions summed, newest first. A past day shows
    // its result only once every function's hours are in.
    const dates = [...new Set(withDays.flatMap((l) => l.days.map((d) => d.date)))].sort().reverse().slice(0, 7);
    const dayRows = dates.map((date) => {
        const sums = withDays.map((l) => l.days.find((d) => d.date === date)).filter((d): d is CostDay => !!d).map((d) => dayTotals(d));
        const expected = sums.reduce((s, d) => s + d.expected, 0), actual = sums.reduce((s, d) => s + d.actual, 0);
        if (date === today) return {label: dayLabel(date), expected: money(expected), actual: money(actual), diff: t('today'), tone: 'today' as const};
        if (!sums.every((d) => d.complete)) return {label: dayLabel(date), expected: money(expected), actual: '–', diff: '', tone: 'even' as const};
        const share = overShare(expected, actual);
        return {label: dayLabel(date), expected: money(expected), actual: money(actual), diff: pct(share),
            tone: share === undefined || Math.abs(share) < 3 ? 'even' as const : share > 0 ? 'over' as const : 'under' as const};
    });
    return {title, badge, rows, total, days: {head: [t('plan'), t('actual')], rows: dayRows}, footnote: t('footnote')};
}

function round(v: number) {
    return Math.round(v * 1000) / 1000;
}
