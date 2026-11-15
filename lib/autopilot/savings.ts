/** The Autopilot savings widget's data (widgets/savings), read from the meter and the prices so an
 *  owner can check it (autopilot-plan.md §11 keeps the modelled figure for later).
 *
 *  Each day's hours are split into the cheapest, middle and most expensive third by that day's
 *  price, and the function's kWh are summed per third. The days before Autopilot first ran live are
 *  the baseline, frozen once found: how the heat pump used electricity on its own, as the share in
 *  the most expensive third and as its price paid against the day's average (the ratio). An
 *  Autopilot day's saving is what its kWh would have cost at the baseline's ratio, minus what they
 *  cost. Those add up into the last 7 days, this month and this year. Pure; the device gathers the
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
    /** Hot water: litres of 40 °C water drawn that day, when the tank model knows the whole day. */
    litres?: number;
    /** Hot water: each charge's place in the day's prices, 0 the cheapest hour and 1 the most
     *  expensive (the mean over its hours). */
    charges?: number[];
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
    live?: number, withCharges = false): SavingsDay | undefined {
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
    const day: SavingsDay = {date, tiers: tiers.map(round) as [number, number, number], cost: round(cost), mean: round(mean), live};
    if (withCharges) {
        const rank = new Map(ranked.map((at, i) => [at, ranked.length > 1 ? i / (ranked.length - 1) : 0]));
        day.charges = chargeRanks(hours, use, rank);
    }
    return day;
}

/** Today so far: the hours that have a reading, each placed in its third by today's whole price
 *  list, and the average over those hours only, so a morning of cheap hours is not compared with
 *  an evening it has not had. Undefined before the first reading or without today's prices. */
export function partialDay(date: string, hours: number[], use: Map<number, number>, prices: Map<number, number>,
    live?: number, withCharges = false): SavingsDay | undefined {
    const priced = hours.filter((at) => prices.has(at));
    if (priced.length < hours.length) return undefined;
    const sofar = priced.filter((at) => use.has(at));
    if (!sofar.length) return undefined;
    const ranked = [...priced].sort((a, b) => prices.get(a)! - prices.get(b)! || a - b);
    const tiers: [number, number, number] = [0, 0, 0];
    let cost = 0;
    ranked.forEach((at, i) => {
        const kwh = use.get(at) ?? 0;
        tiers[Math.min(2, Math.floor(i * 3 / ranked.length))] += kwh;
        cost += kwh * prices.get(at)!;
    });
    const mean = sofar.reduce((s, at) => s + prices.get(at)!, 0) / sofar.length;
    const day: SavingsDay = {date, tiers: tiers.map(round) as [number, number, number], cost: round(cost), mean: round(mean), live};
    if (withCharges) {
        const rank = new Map(ranked.map((at, i) => [at, ranked.length > 1 ? i / (ranked.length - 1) : 0]));
        day.charges = chargeRanks(sofar, use, rank);
    }
    return day;
}

/** kWh in an hour from which the tank counts as being charged: a compressor charge draws 1–2 kW,
 *  a tank standing still next to nothing. */
export const CHARGE_KWH = 0.4;

/** The charges in a day: runs of consecutive charging hours, each placed at the mean price rank
 *  of its hours. */
export function chargeRanks(hours: number[], use: Map<number, number>, rank: Map<number, number>): number[] {
    const out: number[] = [];
    let run: number[] = [];
    for (const at of [...hours, NaN]) {
        if ((use.get(at) ?? 0) >= CHARGE_KWH) { run.push(rank.get(at)!); continue; }
        if (run.length) out.push(round(run.reduce((a, b) => a + b, 0) / run.length));
        run = [];
    }
    return out;
}

/** Days kept: a year and a month, so "this year" adds up from the ledger. About 100 bytes a day. */
export const LEDGER_DAYS = 400;

/** The stored days with fresh ones merged in, one per date, oldest first. */
export function mergeDays(stored: SavingsDay[], fresh: SavingsDay[]): SavingsDay[] {
    const byDate = new Map(stored.map((d) => [d.date, d]));
    for (const d of fresh) byDate.set(d.date, d);
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-LEDGER_DAYS);
}

/** A day counts as Autopilot's when it ran live most of the day. */
export const isAutopilotDay = (d: SavingsDay) => d.live !== undefined && d.live >= 0.8;

/** A set of days in one figure: kWh, its most expensive third's share, and the price paid against
 *  the days' average (each day's average weighted by its kWh). */
export interface Totals {
    days: number;
    kwh: number;
    /** Share of kWh in the cheapest, middle and most expensive third. */
    shares: [number, number, number];
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
    const third = (i: number) => used.reduce((s, d) => s + d.tiers[i], 0) / kwh;
    return {days: used.length, kwh, shares: [third(0), third(1), third(2)], dearShare: dear / kwh, paid: cost / kwh, mean: flat / kwh};
}

/** How the function used electricity before Autopilot first ran live. Frozen once found. */
export interface Baseline {
    /** Days it is made of; 0 when there were none, and the day's average stands in (ratio 1). */
    days: number;
    /** Share of kWh in the most expensive third of the hours. */
    dearShare?: number;
    /** Price paid against the day's average: above 1 when use leaned to the expensive hours. */
    ratio: number;
    /** Share of kWh in the cheapest, middle and most expensive third, and kWh a day. */
    shares?: [number, number, number];
    kwhPerDay?: number;
}

/** Days before Autopilot first ran live that the baseline uses, at most. */
export const BASELINE_DAYS = 28;
/** Days a baseline needs, else none is made from them. */
export const BASELINE_MIN_DAYS = 3;

/** The baseline from the days before `firstLiveDate` (local date), or undefined with too few. */
export function baselineOf(days: SavingsDay[], firstLiveDate: string): Baseline | undefined {
    const before = days.filter((d) => d.date < firstLiveDate).slice(-BASELINE_DAYS);
    const t = totals(before);
    if (!t || t.days < BASELINE_MIN_DAYS) return undefined;
    return {days: t.days, dearShare: round(t.dearShare), ratio: round(t.paid / t.mean), shares: t.shares.map(round) as [number, number, number],
        kwhPerDay: round(t.kwh / t.days)};
}

/** What a day saved against the baseline, in money: its kWh at the baseline's ratio to the day's
 *  average, minus what they cost. Negative when it cost more. */
export function daySaving(d: SavingsDay, base: Baseline): number {
    const kwh = d.tiers[0] + d.tiers[1] + d.tiers[2];
    return kwh * d.mean * base.ratio - d.cost;
}

/** The days that count as Autopilot's savings: whole days after the one it first ran live, that it ran. */
export const savingDays = (days: SavingsDay[], firstLiveDate: string) =>
    days.filter((d) => d.date > firstLiveDate && isAutopilotDay(d));

/** Savings over the last 7 days, this calendar month and this calendar year, as of `today` (local date). */
export function periodSavings(days: SavingsDay[], firstLiveDate: string, base: Baseline, today: string):
    {week: number; month: number; year: number; days: number} {
    const counted = savingDays(days, firstLiveDate);
    const weekFrom = shiftDate(today, -7);
    const sum = (keep: (d: SavingsDay) => boolean) => counted.filter(keep).reduce((s, d) => s + daySaving(d, base), 0);
    return {
        week: sum((d) => d.date >= weekFrom),
        month: sum((d) => d.date.slice(0, 7) === today.slice(0, 7)),
        year: sum((d) => d.date.slice(0, 4) === today.slice(0, 4)),
        days: counted.length,
    };
}

export type Translate = (key: string, tokens?: Record<string, string | number>) => string;

/** One row of the before-and-with comparison: the share of kWh in each third, and kWh a day. */
export interface SplitRow {
    label: string;
    shares: [number, number, number];
    perDay: string;
}

/** Hot water: one day of the last seven, and the share of its heat in its cheapest third of
 *  hours. No share: no record, or no heat that day; drawn as an empty ring. */
export interface ShareDay {
    label: string;
    share?: number;
}

/** Hot water: where the last seven days' heat went, by price third. */
export interface SharePicture {
    title: string;
    /** The cheap share, "80 %"; left out while the headline already is today's share. */
    value?: string;
    note?: string;
    /** kWh in the cheapest, middle and most expensive third. */
    tiers: [number, number, number];
    /** "9.6 kWh cheap" and "1.6 middle · 0.8 expensive", under the bar. */
    cheap: string;
    rest: string;
    days: ShareDay[];
}

export interface SavingsData {
    title: string;
    /** The "Experimental" mark, shown quietly like the Autopilot widget's. */
    badge?: string;
    status?: string;
    /** The status's one figure: money saved this month, or the price paid against the average. */
    value?: string;
    /** Saved (good) or cost more (bad). Before Autopilot the figure is the baseline: neutral. */
    tone?: 'good' | 'bad' | 'neutral';
    reason?: string;
    detail?: string;
    /** Small figures side by side under the hero number, e.g. the last 7 days and this year. */
    stats?: {label: string; value: string}[];
    /** Heating: before and with Autopilot, as the share of kWh in each third of the day's hours. */
    split?: SplitRow[];
    /** Under `value`, quieter: the month the figure is for. */
    valueNote?: string;
    /** Hot water: the week's charges, each a dot at its place in its day's prices. */
    share?: SharePicture;
    /** Hot water: what one shower cost, before and with Autopilot. */
    shower?: {title: string; before?: {label: string; value: string}; now?: {label: string; value: string; note?: string}};
    legend?: Record<string, string>;
    footnote?: string;
    empty?: string;
    /** The first read is running: the widget holds the chart's place. */
    loading?: boolean;
}

/** Days the comparison and the charge chart look back over. */
export const RECENT_DAYS = 14;
export const CHARGE_DAYS = 7;
/** Less heat than this in a day or a week says nothing about when it was used. */
const MIN_KWH = 0.05;
/** Litres of 40 °C water in one shower: a long one, so the figure is not a rounding error. */
export const SHOWER_LITRES = 80;

/** What the widget is given besides the days. */
export interface SavingsContext {
    role: 'heating' | 'hotwater';
    /** Local date Autopilot first ran live; undefined while it never has. */
    firstLiveDate?: string;
    /** Today so far, counted with the complete days when Autopilot ran it. */
    sofar?: SavingsDay;
    /** Autopilot runs Live now: on its first day, today counts even before its hours are all known. */
    liveNow?: boolean;
    /** The frozen baseline, once found. */
    baseline?: Baseline;
    /** Today, local date. */
    today: string;
    /** A short weekday for a date. */
    label: (date: string) => string;
    /** The month's name for a date, as it reads in a sentence ("November", "november"). */
    month: (date: string) => string;
    /** A price per kWh. */
    price: (v: number) => string;
    /** A sum of money. */
    money: (v: number) => string;
    badge?: string;
}

/** The widget's text and pictures. */
export function savingsData(title: string, stored: SavingsDay[], t: Translate, c: SavingsContext): SavingsData {
    const days = c.sofar ? [...stored.filter((d) => d.date !== c.sofar!.date), c.sofar] : stored;
    const recent = days.slice(-RECENT_DAYS);
    if (!recent.length) return {title, empty: t('empty')};
    const pct = (v: number) => Math.round(v * 100);
    const perDay = (kwh: number) => t('per_day', {kwh: kwh < 10 ? kwh.toFixed(1) : Math.round(kwh)});
    const base: Baseline = c.baseline ?? {days: 0, ratio: 1};
    const counted = c.firstLiveDate ? savingDays(recent, c.firstLiveDate) : [];
    // The first day: today so far counts while Autopilot runs Live, though its early hours predate the record.
    if (!counted.length && c.sofar && c.liveNow && c.firstLiveDate && c.firstLiveDate <= c.today) counted.push(c.sofar);
    const onlyToday = counted.length === 1 && counted[0] === c.sofar;
    const ap = totals(counted);
    const before = c.firstLiveDate ? undefined : totals(stored.slice(-RECENT_DAYS));
    // The pictures carry the comparison; the text is the headline, one number, and what a picture cannot say.
    const pictures: Partial<SavingsData> = {legend: {cheap: t('cheap'), middle: t('middle'), dear: t('dear')}};
    if (c.role === 'heating') {
        const rows: SplitRow[] = [];
        if (!before && base.shares) rows.push({label: t('row_before_days', {days: base.days}), shares: base.shares, perDay: perDay(base.kwhPerDay ?? 0)});
        if (before) rows.push({label: t('row_so_far_days', {days: before.days}), shares: before.shares, perDay: perDay(before.kwh / before.days)});
        if (ap) rows.push({label: onlyToday ? t('row_today') : t('row_with_days', {days: ap.days}), shares: ap.shares,
            perDay: onlyToday ? t('kwh_so_far', {kwh: ap.kwh.toFixed(1)}) : perDay(ap.kwh / ap.days)});
        if (rows.length) pictures.split = rows;
    } else {
        // Always the last seven days ending today, so the week fills up instead of starting squeezed.
        const byDate = new Map(days.map((d) => [d.date, d]));
        const dates = Array.from({length: CHARGE_DAYS}, (_, k) => shiftDate(c.today, k - CHARGE_DAYS + 1));
        const sum = (d?: SavingsDay) => (d ? d.tiers[0] + d.tiers[1] + d.tiers[2] : 0);
        const tiers = dates.reduce<[number, number, number]>((a, date) => {
            const d = byDate.get(date);
            return d ? [a[0] + d.tiers[0], a[1] + d.tiers[1], a[2] + d.tiers[2]] : a;
        }, [0, 0, 0]);
        const total = tiers[0] + tiers[1] + tiers[2];
        if (total >= MIN_KWH) pictures.share = {title: t('charges_title'),
            ...onlyToday ? {} : {value: `${pct(tiers[0] / total)} %`, note: t('share_note')},
            tiers: [round(tiers[0]), round(tiers[1]), round(tiers[2])],
            cheap: t('share_cheap', {kwh: tiers[0].toFixed(1)}),
            rest: t('share_rest', {middle: tiers[1].toFixed(1), expensive: tiers[2].toFixed(1)}),
            days: dates.map((date) => {
                const d = byDate.get(date);
                return {label: c.label(date), ...sum(d) >= MIN_KWH ? {share: round(d!.tiers[0] / sum(d))} : {}};
            })};
        const whole = counted.filter((d) => d !== c.sofar);
        const shower = (list: SavingsDay[], extra: (d: SavingsDay) => number) => {
            const known = list.filter((d) => (d.litres ?? 0) > 0);
            const litres = known.reduce((s, d) => s + d.litres!, 0);
            return litres > 0 ? known.reduce((s, d) => s + d.cost + extra(d), 0) / litres * SHOWER_LITRES : undefined;
        };
        const now = shower(whole.length ? whole : stored.slice(-RECENT_DAYS), () => 0);
        // Before: the same water at the baseline's pattern, at today's prices.
        const was = whole.length && base.days ? shower(whole, (d) => daySaving(d, base)) : undefined;
        if (now !== undefined) pictures.shower = {title: t('shower', {litres: SHOWER_LITRES}),
            before: was === undefined ? undefined : {label: t('row_before'), value: c.price(was)},
            now: {label: whole.length ? t('row_with') : t('row_so_far'), value: c.price(now),
                note: was === undefined ? undefined : signed(Math.round((now / was - 1) * 100)) + ' %'}};
    }
    // Before Autopilot: the starting point, as the share of use Autopilot will move.
    if (!c.firstLiveDate) return {title, badge: c.badge, ...pictures, status: t('status_start'), tone: 'neutral',
        value: before ? `${pct(before.dearShare)} %` : undefined, valueNote: before ? t('in_expensive') : undefined};
    // Only today so far: kronor come out once the expensive hours have passed with less use, so a
    // morning reads about zero however well the day goes. The share in the cheapest hours does not.
    if (onlyToday && ap) return {title, badge: c.badge, ...pictures, status: t(`status_${c.role}`),
        value: `${pct(ap.shares[0])} %`, valueNote: t('in_cheapest_today'),
        tone: base.shares && ap.shares[0] < base.shares[0] ? 'neutral' : 'good'};
    const sums = periodSavings(days, c.firstLiveDate, base, c.today);
    if (!sums.days) return {title, badge: c.badge, ...pictures, status: t(`status_${c.role}`), reason: t('first_day')};
    return {
        title, badge: c.badge, ...pictures,
        status: t(`status_${c.role}`),
        value: c.money(sums.month),
        valueNote: c.month(c.today),
        tone: sums.month >= 0 ? 'good' : 'bad',
        stats: [{label: t('stat_week'), value: c.money(sums.week)}, {label: t('stat_year'), value: c.money(sums.year)}],
    };
}

function signed(v: number): string {
    return `${v > 0 ? '+' : v < 0 ? '\u2212' : ''}${Math.abs(v)}`;
}

function shiftDate(date: string, days: number): string {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
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

/** When Autopilot first ran live, for a device that ran it before this was recorded: walk back
 *  from the first live mark while the hours say live, with gaps of up to two hours bridged. */
export function firstLiveFrom(markAt: number, live: (at: number) => boolean | undefined): number {
    let first = Math.floor(markAt / HOUR) * HOUR, at = first - HOUR, gap = 0;
    while (gap <= 2) {
        const v = live(at);
        if (v === true) { first = at; gap = 0; } else gap++;
        at -= HOUR;
        if (markAt - at > 400 * 24 * HOUR) break;
    }
    return first;
}

/** Money as the owner writes it: the language's digits, and a currency written as letters after the
 *  number ("2.79 kr", "2,79 kr."), whatever side the language's own format puts it. Symbols keep
 *  their place ("€2.79", "2,79 €"). An unknown code is written after the number as it is. */
export function moneyText(v: number, digits: number, language: string, currency: string): string {
    const plain = (n: number) => new Intl.NumberFormat(language, {minimumFractionDigits: digits, maximumFractionDigits: digits}).format(n);
    if (!/^[A-Z]{3}$/.test(currency)) return `${plain(v)} ${currency}`.trim();
    try {
        const parts = new Intl.NumberFormat(language, {style: 'currency', currency, currencyDisplay: 'narrowSymbol',
            minimumFractionDigits: digits, maximumFractionDigits: digits}).formatToParts(v);
        const symbol = parts.find((p) => p.type === 'currency')?.value ?? currency;
        if (!/^[\p{L}.]+$/u.test(symbol)) return parts.map((p) => p.value).join('');
        return `${plain(v)} ${symbol}`;
    } catch {
        return `${plain(v)} ${currency}`;
    }
}
