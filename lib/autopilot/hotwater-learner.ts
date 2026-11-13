/** Hot water learner: what a household draws, by hour and day type, what the tank loses standing,
 *  and what a charge delivers. Pure: the caller supplies the tank readings and the local clock.
 *  Design: docs/autopilot-hot-water.md §4.1.
 *
 *  Everything is in kWh of heat. The tank's state is the litres estimate (`lib/hotwater.ts`):
 *  litres of 40 °C water, which is heat above a 10 °C inlet at 30 K a litre. */

/** kWh of heat in one litre of 40 °C water made from a 10 °C inlet: 4.186 kJ/(kg·K) × 30 K. */
export const KWH_PER_LITRE = 4.186 * 30 / 3600;

/** Day types the owner sets on the main device (by a Flow or by hand). No day type set means the
 *  day is only pooled. */
export type DayType = 'working' | 'free' | 'away';
export const DAY_TYPES = ['working', 'free', 'away'] as const;

/** One reading of the tank, at any spacing: 15-min history, hourly or 6-hourly Insights. */
export interface TankPoint {
    /** ms; for an Insights bucket, its middle (a bucket holds the mean over its span). */
    t: number;
    /** Litres of 40 °C water; 0 means the top is below 40 °C, so the state is unknown. */
    litres?: number | null;
    /** Hot water heat produced, a kWh counter. */
    produced?: number | null;
    /** Hot water electricity, a kWh counter (the allocator's per-function meter). */
    used?: number | null;
    /** Tank top (BT7), °C. */
    top?: number | null;
    dayType?: DayType;
}

/** Heat leaving the tank between two readings, and what a charge put in. */
export interface Interval {
    start: number;
    hours: number;
    /** kWh heat drawn: fall in stored heat + produced − standing loss. NaN when not knowable. */
    draw: number;
    /** kWh heat produced. */
    produced: number;
    /** kWh electricity, NaN when the counter is missing. */
    used: number;
    /** Stored heat at the start, kWh. */
    stored: number;
    top?: number;
    dayType?: DayType;
}

/** kWh heat lost per hour as a function of stored heat. */
export interface StandingLoss {
    /** kWh/h with the tank empty (stored 0). */
    base: number;
    /** Extra kWh/h per kWh stored. */
    perKwh: number;
    samples: number;
}

export interface ChargeModel {
    /** kWh heat per full hour of charging. */
    heatPerHour: number;
    /** Heat over electricity, over all charges. */
    cop: number;
    /** COP change per K of tank top, when the charges spread enough to tell; else 0. */
    copPerK: number;
    /** Mean tank top over the charges, °C: where `cop` applies. */
    atTop: number;
    samples: number;
}

export interface DayProfile {
    /** Weighted days behind it. */
    days: number;
    /** kWh heat drawn per local hour, weighted mean. */
    hours: number[];
    /** 80th percentile per local hour: what the floor plans for. */
    p80: number[];
    /** kWh heat drawn per day, weighted mean and 80th percentile. */
    daily: number;
    dailyP80: number;
}

export interface HotwaterModel {
    loss: StandingLoss;
    charge?: ChargeModel;
    /** `any` pools every day that was not away; the day types lean on it while they are young. */
    profiles: Partial<Record<'any' | 'working' | 'free', DayProfile>>;
    /** Local dates left out as away: marked away, or drawing next to nothing. */
    away: string[];
    /** Local dates with a full day of readings. */
    days: number;
}

/** Local date and hour of an instant. */
export type LocalClock = (ms: number) => {date: string; hour: number};

export function localClock(timeZone: string): LocalClock {
    const format = new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', hourCycle: 'h23'});
    return (ms) => {
        const parts = Object.fromEntries(format.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
        return {date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24};
    };
}

const HOUR = 3_600_000;
/** A counter step above this per hour is a reset or a glitch, not heat. */
const MAX_KWH_PER_HOUR = 15;
/** Below this, nothing was charging. */
const QUIET_KWH_PER_HOUR = 0.05;
/** Assumed until the tank has shown its own: 0.1 kWh/h full (S1155, BT7 −0.6 K/h), half that empty. */
export const DEFAULT_LOSS: StandingLoss = {base: 0.05, perKwh: 0.005, samples: 0};
export const HALF_LIFE_DAYS = 21;
/** A day type leans on `any` until it has this many (weighted) days of its own: the prior fills
 *  the shortfall, so a type with enough days is its own and is not pulled toward the mix. */
const SHRINK_DAYS = 5;
/** A day drawing less than this share of the typical day, not marked away, counts as away. */
const AWAY_SHARE = 0.15;

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const stored = (p: TankPoint) => finite(p.litres) && p.litres > 0 ? p.litres * KWH_PER_LITRE : NaN;

export function lossAt(loss: StandingLoss, storedKwh: number): number {
    return Math.max(0, loss.base + loss.perKwh * (Number.isFinite(storedKwh) ? storedKwh : 0));
}

/** Consecutive readings → intervals. Readings must be in time order. */
export function intervals(points: TankPoint[], loss: StandingLoss = DEFAULT_LOSS): Interval[] {
    const out: Interval[] = [];
    for (let k = 1; k < points.length; k++) {
        const a = points[k - 1], b = points[k];
        const hours = (b.t - a.t) / HOUR;
        if (!(hours > 0) || hours > 6.5) continue;
        const produced = finite(a.produced) && finite(b.produced) ? b.produced - a.produced : NaN;
        if (!(produced >= 0 && produced <= MAX_KWH_PER_HOUR * hours)) continue;
        const usedStep = finite(a.used) && finite(b.used) ? b.used - a.used : NaN;
        const used = usedStep >= 0 && usedStep <= MAX_KWH_PER_HOUR * hours ? usedStep : NaN;
        const s0 = stored(a), s1 = stored(b);
        const draw = Number.isFinite(s0) && Number.isFinite(s1)
            ? Math.max(0, s0 - s1 + produced - lossAt(loss, (s0 + s1) / 2) * hours) : NaN;
        out.push({start: a.t, hours, draw, produced, used, stored: s0,
            top: finite(a.top) ? a.top : undefined, dayType: a.dayType});
    }
    return out;
}

const quantile = (values: number[], q: number) => {
    if (!values.length) return NaN;
    const sorted = [...values].sort((x, y) => x - y);
    const at = (sorted.length - 1) * q, lo = Math.floor(at);
    return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (at - lo);
};

function weightedQuantile(values: number[], weights: number[], q: number): number {
    const order = values.map((v, i) => [v, weights[i]] as const).sort((x, y) => x[0] - y[0]);
    const total = order.reduce((s, [, w]) => s + w, 0);
    if (!(total > 0)) return NaN;
    let run = 0;
    for (const [v, w] of order) { run += w; if (run >= q * total) return v; }
    return order[order.length - 1][0];
}

/** Standing loss from quiet night hours: no charge, and the slowest falls, which are the ones
 *  without a draw. Fitted against stored heat from the slow quarter of each half of the range. */
export function learnLoss(points: TankPoint[], clock: LocalClock): StandingLoss {
    const quiet: {stored: number; rate: number}[] = [];
    for (const i of intervals(points, {base: 0, perKwh: 0, samples: 0})) {
        if (i.hours > 1.01 || !Number.isFinite(i.draw) || i.produced > QUIET_KWH_PER_HOUR * i.hours) continue;
        const hour = clock(i.start).hour;
        if (hour > 5) continue;
        quiet.push({stored: i.stored, rate: i.draw / i.hours});
    }
    if (quiet.length < 6) return DEFAULT_LOSS;
    const middle = quantile(quiet.map((q) => q.stored), 0.5);
    const halves = [quiet.filter((q) => q.stored < middle), quiet.filter((q) => q.stored >= middle)]
        .filter((h) => h.length >= 3)
        .map((h) => ({stored: quantile(h.map((q) => q.stored), 0.5), rate: quantile(h.map((q) => q.rate), 0.25)}));
    if (halves.length === 2 && halves[1].stored - halves[0].stored > 1) {
        const perKwh = Math.max(0, (halves[1].rate - halves[0].rate) / (halves[1].stored - halves[0].stored));
        return {base: Math.max(0, halves[0].rate - perKwh * halves[0].stored), perKwh, samples: quiet.length};
    }
    const rate = quantile(quiet.map((q) => q.rate), 0.25);
    return {base: Math.max(0, rate), perKwh: 0, samples: quiet.length};
}

/** Charge rate from hours spent charging the whole hour, COP from every charging interval. */
export function learnCharge(spans: Interval[]): ChargeModel | undefined {
    const charging = spans.filter((i) => i.produced > 0.5 * i.hours);
    if (charging.length < 3) return undefined;
    const hourly = charging.filter((i) => i.hours <= 1.01).map((i) => i.produced / i.hours);
    const peak = quantile(hourly, 0.9);
    const full = hourly.filter((r) => r >= 0.7 * peak);
    const withEl = charging.filter((i) => Number.isFinite(i.used) && i.used > 0);
    const heat = withEl.reduce((s, i) => s + i.produced, 0), el = withEl.reduce((s, i) => s + i.used, 0);
    if (!(el > 0)) return undefined;
    const cop = heat / el;
    const tops = withEl.filter((i) => finite(i.top));
    const atTop = tops.length ? tops.reduce((s, i) => s + i.top!, 0) / tops.length : NaN;
    let copPerK = 0;
    if (tops.length >= 6 && quantile(tops.map((i) => i.top!), 0.9) - quantile(tops.map((i) => i.top!), 0.1) >= 5) {
        // Least squares of each interval's COP on its tank top, weighted by its heat.
        const w = tops.map((i) => i.produced), x = tops.map((i) => i.top!), y = tops.map((i) => i.produced / i.used);
        const sw = w.reduce((s, v) => s + v, 0);
        const mx = x.reduce((s, v, k) => s + v * w[k], 0) / sw, my = y.reduce((s, v, k) => s + v * w[k], 0) / sw;
        const sxx = x.reduce((s, v, k) => s + w[k] * (v - mx) ** 2, 0);
        const sxy = x.reduce((s, v, k) => s + w[k] * (v - mx) * (y[k] - my), 0);
        // Only a falling COP is physical; a rising one is noise from mixed charge lengths.
        if (sxx > 0) copPerK = Math.min(0, sxy / sxx);
    }
    return {heatPerHour: full.length ? quantile(full, 0.5) : quantile(charging.map((i) => i.produced / i.hours), 0.5),
        cop, copPerK, atTop, samples: charging.length};
}

/** COP of a charge whose tank top ends near `top`. */
export function copAt(charge: ChargeModel, top: number): number {
    if (!Number.isFinite(charge.atTop) || !charge.copPerK) return charge.cop;
    return Math.max(1, charge.cop + charge.copPerK * (top - charge.atTop));
}

interface Day {
    date: string;
    /** Newest instant in it, for the age weight. */
    t: number;
    hoursCovered: number;
    draw: number;
    /** Per local hour; undefined when any reading was coarser than an hour. */
    byHour?: number[];
    dayType?: DayType;
}

function days(spans: Interval[], clock: LocalClock): Day[] {
    const map = new Map<string, Day & {votes: Map<DayType, number>}>();
    for (const i of spans) {
        if (!Number.isFinite(i.draw)) continue;
        // Spread the interval over the hours it covers, so a 6-hour bucket lands on its own day(s).
        const steps = Math.max(1, Math.round(i.hours));
        for (let k = 0; k < steps; k++) {
            const t = i.start + (k + 0.5) * (i.hours / steps) * HOUR;
            const {date, hour} = clock(t);
            let day = map.get(date);
            if (!day) map.set(date, day = {date, t, hoursCovered: 0, draw: 0, byHour: new Array(24).fill(0), votes: new Map()});
            day.t = Math.max(day.t, t);
            day.hoursCovered += i.hours / steps;
            day.draw += i.draw / steps;
            if (i.hours > 1.01) day.byHour = undefined;
            else if (day.byHour) day.byHour[hour] += i.draw / steps;
            if (i.dayType) day.votes.set(i.dayType, (day.votes.get(i.dayType) ?? 0) + i.hours / steps);
        }
    }
    return [...map.values()].filter((d) => d.hoursCovered >= 22).map(({votes, ...day}) => {
        const top = [...votes].sort((x, y) => y[1] - x[1])[0];
        return {...day, dayType: top?.[0]};
    }).sort((x, y) => x.t - y.t);
}

function profileOf(list: Day[], weight: (d: Day) => number, prior?: DayProfile): DayProfile | undefined {
    if (!list.length && !prior) return undefined;
    const w = list.map(weight);
    const total = w.reduce((s, v) => s + v, 0);
    const shaped = list.map((d, k) => [d, w[k]] as const).filter(([d]) => d.byHour);
    const shapeTotal = shaped.reduce((s, [, v]) => s + v, 0);
    const blend = (own: number, ownWeight: number, from: number | undefined) => {
        const k = Math.max(0, SHRINK_DAYS - ownWeight);
        return prior && k > 0 && from !== undefined && Number.isFinite(from) ? (own * ownWeight + from * k) / (ownWeight + k) : own;
    };
    const daily = total > 0 ? list.reduce((s, d, k) => s + d.draw * w[k], 0) / total : NaN;
    const dailyP80 = total > 0 ? weightedQuantile(list.map((d) => d.draw), w, 0.8) : NaN;
    const hours: number[] = [], p80: number[] = [];
    for (let h = 0; h < 24; h++) {
        const own = shapeTotal > 0 ? shaped.reduce((s, [d, v]) => s + d.byHour![h] * v, 0) / shapeTotal : NaN;
        const ownP80 = shapeTotal > 0 ? weightedQuantile(shaped.map(([d]) => d.byHour![h]), shaped.map(([, v]) => v), 0.8) : NaN;
        hours.push(Number.isFinite(own) ? blend(own, shapeTotal, prior?.hours[h]) : prior?.hours[h] ?? NaN);
        p80.push(Number.isFinite(ownP80) ? blend(ownP80, shapeTotal, prior?.p80[h]) : prior?.p80[h] ?? NaN);
    }
    return {days: total,
        hours, p80,
        daily: Number.isFinite(daily) ? blend(daily, total, prior?.daily) : prior?.daily ?? NaN,
        dailyP80: Number.isFinite(dailyP80) ? blend(dailyP80, total, prior?.dailyP80) : prior?.dailyP80 ?? NaN};
}

/** What setup asks a home with under STARTER_DAYS of history (docs/autopilot-hot-water.md §4.6). */
export interface Household {
    /** People living there. */
    people: number;
    /** Usual morning shower on a working day, local hour. */
    morningHour: number;
    /** When a free day's main use is. */
    freeDay: 'morning' | 'daytime' | 'evening';
}

/** Below this many days of history, setup asks about the household. */
export const STARTER_DAYS = 14;
/** kWh heat a person draws on a working day: about 70 L of 40 °C water. Free days 1.5×. */
const KWH_PER_PERSON = 2.5;
const FREE_DAY_FACTOR = 1.5;
/** A heavy day against a typical one, and an hour's 80th percentile against its mean, until
 *  the home's own days say otherwise. */
const STARTER_P80_DAY = 1.35;
const STARTER_P80_HOUR = 1.6;

/** Clamps what setup stored into a household, or undefined when it is not one. */
export function readHousehold(raw: any): Household | undefined {
    const people = Math.round(Number(raw?.people)), morningHour = Math.round(Number(raw?.morningHour));
    if (!(people >= 1 && people <= 12) || !(morningHour >= 0 && morningHour <= 23)) return undefined;
    const freeDay = raw?.freeDay === 'morning' || raw?.freeDay === 'daytime' ? raw.freeDay : 'evening';
    return {people, morningHour, freeDay};
}

/** A starting day profile from the household's answers: the day's heat placed at the given
 *  times. A prior, not a model: the learner leans on it only until the home has SHRINK_DAYS of
 *  its own days of each type. */
export function starterProfiles(h: Household): {any: DayProfile; working: DayProfile; free: DayProfile} {
    /** Shares of the day per local hour, from (hour, weight) peaks plus a little spread over waking hours. */
    const shape = (peaks: [number, number][]) => {
        const w = new Array(24).fill(0);
        for (let hour = 7; hour < 23; hour++) w[hour] = 0.15 / 16;
        for (const [hour, weight] of peaks) w[((hour % 24) + 24) % 24] += weight;
        const total = w.reduce((a, b) => a + b, 0);
        return w.map((v) => v / total);
    };
    const m = h.morningHour;
    const profile = (daily: number, shares: number[]): DayProfile => ({
        days: 0, daily, dailyP80: daily * STARTER_P80_DAY,
        hours: shares.map((x) => x * daily), p80: shares.map((x) => x * daily * STARTER_P80_HOUR),
    });
    const workDaily = h.people * KWH_PER_PERSON, freeDaily = workDaily * FREE_DAY_FACTOR;
    const working = profile(workDaily, shape([[m, 0.35], [m + 1, 0.15], [18, 0.1], [19, 0.1], [20, 0.1], [21, 0.05]]));
    const freePeaks: Record<Household['freeDay'], [number, number][]> = {
        morning: [[m + 2, 0.3], [m + 3, 0.2], [19, 0.15], [20, 0.1]],
        daytime: [[11, 0.15], [12, 0.15], [13, 0.1], [14, 0.1], [19, 0.15], [20, 0.1]],
        evening: [[m + 2, 0.15], [18, 0.15], [19, 0.2], [20, 0.15], [21, 0.1]],
    };
    const free = profile(freeDaily, shape(freePeaks[h.freeDay]));
    // The pooled day is five working days to two free ones.
    const any: DayProfile = {
        days: 0, daily: (5 * workDaily + 2 * freeDaily) / 7, dailyP80: (5 * working.dailyP80 + 2 * free.dailyP80) / 7,
        hours: working.hours.map((v, k) => (5 * v + 2 * free.hours[k]) / 7),
        p80: working.p80.map((v, k) => (5 * v + 2 * free.p80[k]) / 7),
    };
    return {any, working, free};
}

/** Learns from readings in time order. `now` sets the age weights. `household`, when setup asked
 *  it, is the prior a young history leans on. */
export function learn(points: TankPoint[], clock: LocalClock, now: number, halfLifeDays = HALF_LIFE_DAYS,
                      household?: Household): HotwaterModel {
    const loss = learnLoss(points, clock);
    const spans = intervals(points, loss);
    const all = days(spans, clock);
    const weight = (d: Day) => 0.5 ** (Math.max(0, now - d.t) / 86_400_000 / halfLifeDays);
    const present = all.filter((d) => d.dayType !== 'away');
    const typical = weightedQuantile(present.map((d) => d.draw), present.map(weight), 0.5);
    const away = all.filter((d) => d.dayType === 'away' || (!d.dayType && Number.isFinite(typical) && d.draw < AWAY_SHARE * typical));
    const kept = present.filter((d) => !away.includes(d));
    const start = household && starterProfiles(household);
    const any = profileOf(kept, weight, start?.any);
    const profiles: HotwaterModel['profiles'] = {};
    if (any) profiles.any = any;
    for (const type of ['working', 'free'] as const) {
        const own = kept.filter((d) => d.dayType === type);
        // With a household the type has its own prior (a free day draws more, at other hours);
        // without one it leans on the pooled day.
        if (own.length || start) profiles[type] = profileOf(own, weight, start?.[type] ?? any);
    }
    return {loss, charge: learnCharge(spans), profiles, away: away.map((d) => d.date), days: all.length};
}

/** The profile to plan a day with: its type's, else the pooled one. */
export function profileFor(model: HotwaterModel, dayType: DayType | undefined): DayProfile | undefined {
    if (dayType === 'away') return undefined;
    return (dayType && model.profiles[dayType]) || model.profiles.any;
}
