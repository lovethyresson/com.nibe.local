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
    /** Immersion heater hours for hot water (1069), a counter; and the charge sensor (BT6), °C.
     *  Only the compressor ceiling reads them (hotwater-ceiling.ts). */
    aux?: number | null;
    charge?: number | null;
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
    /** Stored heat at the start and the end, kWh (NaN when the top was under 40 °C). */
    stored: number;
    storedEnd: number;
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
    /** kWh of heat the tank gains per full hour of charging, at `atStored` (with `perKwh`), else
     *  overall. Measured in the tank (the litres estimate), never from the pump's heat counter. */
    heatPerHour: number;
    /** How the tank's gain changes per kWh already stored (≤ 0): a fuller tank takes heat slower,
     *  so a top-up of a warm tank takes far longer than a charge from cold. */
    perKwh?: number;
    atStored?: number;
    /** The pump's heat counter (1575) per full hour of charging. It runs at about this rate
     *  whenever the compressor makes hot water, whatever reaches the tank, so it measures how long
     *  a charge ran, not what it stored (docs/hot-water-heat-accounting.md). */
    producedPerHour?: number;
    /** kW of electricity while charging. */
    kw?: number;
    /** Heat the tank gained over electricity, over all charges. */
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
    /** The last RECENT_DAYS full days, oldest first: what the widget's week chart draws. */
    recent?: DayDraw[];
    /** Working-day evenings per weekday (1 = Monday … 5 = Friday): a challenger to the day type's
     *  evening, logged but not planned with until a replay shows it pays (plan step 5.1). */
    evenings?: Partial<Record<number, WeekdayEvening>>;
}

/** Local hours of "the evening", [from, to). */
export const EVENING_FROM = 16;
export const EVENING_TO = 23;
/** A weekday leans on the working-day evening until it has this many (weighted) days of its own. */
const WEEKDAY_SHRINK = 6;

/** kWh heat drawn over a working day's evening, for one weekday: shrunk toward every working
 *  evening until the weekday has WEEKDAY_SHRINK days of its own. */
export interface WeekdayEvening {
    days: number;
    mean: number;
    p80: number;
}

/** One full day's hot water use. */
export interface DayDraw {
    /** Local date, YYYY-MM-DD. */
    date: string;
    /** kWh heat drawn. */
    draw: number;
    dayType?: DayType;
    /** Left out of learning as away. */
    away?: boolean;
    /** Hours of the day whose draw is known, when not a full day: `draw` is then a lower bound. */
    partial?: number;
}

/** Hours of known draw that make a full day. */
const FULL_DAY_HOURS = 22;

/** Full days the model keeps for the week chart: four weeks, so a typical working day and day off
 *  each have a few days behind them. */
export const RECENT_DAYS = 28;

/** Local date, hour and minute of an instant. */
export type LocalClock = (ms: number) => {date: string; hour: number; minute?: number};

export function localClock(timeZone: string): LocalClock {
    const format = new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
    return (ms) => {
        const parts = Object.fromEntries(format.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
        return {date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, minute: Number(parts.minute)};
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

/** Heat a charge put into the tank over an interval: how long it ran, from the heat counter, times
 *  the tank's own rate. Without a tank-measured model, the heat counter itself. */
export function tankHeatIn(produced: number, hours: number, storedMid: number, charge?: ChargeModel): number {
    if (!charge?.producedPerHour || !(produced > 0)) return produced;
    const running = Math.min(hours, produced / charge.producedPerHour);
    return running * chargeRate(charge, storedMid);
}

/** The tank's modelled rate, as a share of the counter's, at or above which a charge's heat in
 *  is trusted for working out a draw (`intervals`). */
const TRUSTED_RATE = 0.8;

/** Consecutive readings → intervals. Readings must be in time order. With a charge model, the
 *  heat a charge put in is the tank's (`tankHeatIn`), so heat the counter books but the tank
 *  never got is not taken for water drawn; an interval spent mostly charging near full counts only a fall. */
export function intervals(points: TankPoint[], loss: StandingLoss = DEFAULT_LOSS, charge?: ChargeModel): Interval[] {
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
        // An interval the tank spent mostly charging while nearly full shows a draw only as a fall:
        // there the tank takes a small, fast-falling fraction of what the counter books, and no rate
        // line follows it closely enough (2026-11-15: 3.4 kWh/h modelled where the tank took 0.7,
        // 40–75 L an hour of phantom draws). Below that, where the tank takes about all the counter
        // books, the heat in is trusted, so a shower during a charge from a low tank still counts.
        const full = charge?.producedPerHour;
        const charging = full !== undefined && produced >= 0.5 * full * hours
            && chargeRate(charge!, (s0 + s1) / 2) < TRUSTED_RATE * full;
        const heatIn = charging ? 0 : tankHeatIn(produced, hours, (s0 + s1) / 2, charge);
        const draw = Number.isFinite(s0) && Number.isFinite(s1)
            ? Math.max(0, s0 - s1 + heatIn - (charging ? 0 : lossAt(loss, (s0 + s1) / 2) * hours)) : NaN;
        out.push({start: a.t, hours, draw, produced, used, stored: s0, storedEnd: s1,
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

/** The slowest a tank is taken to gain while charging, kWh/h: keeps a nearly full tank's rate from
 *  reaching zero, which no plan could then reason about. */
export const MIN_TANK_RATE = 0.3;

/** kWh/h the tank gains while charging with `storedKwh` in it. */
export function chargeRate(charge: ChargeModel, storedKwh: number): number {
    if (!charge.perKwh || charge.atStored === undefined || !Number.isFinite(storedKwh)) return charge.heatPerHour;
    const rate = charge.heatPerHour + charge.perKwh * (storedKwh - charge.atStored);
    // Never more than the compressor's output: the counter's rate is the most it can be.
    return Math.max(MIN_TANK_RATE, Math.min(charge.producedPerHour ?? Infinity, rate));
}

/** kWh/h under the fitted line past which an hour of charging counts as a draw, not the tank. */
const DRAW_RESIDUAL = 1;
/** An hour of charging counts toward the tank's rate when the counter ran at least this share of
 *  its full rate: near full the compressor slows, and at a half those hours never reached the fit,
 *  which then saw only the fast, emptier hours and read a flat rate (2026-11-15: 6.7 kWh/h at any
 *  fill, where the tank took 0.7 near full, the rest booked as 40–75 L an hour of phantom draws). */
const RAN_SHARE = 0.2;

/** The tank's rate against heat stored, from the upper end of the gains at each fill: a draw only
 *  ever lowers an hour's gain, so the most an hour gained at a given fill is the tank. The gains
 *  are cut into up to four bins by fill, each bin's upper quartile taken, and a falling line fitted
 *  through those. Too few gains or too narrow a spread of fills: one rate, as `fitRate`. */
function fitEnvelope(gains: {x: number; y: number}[]) {
    const sorted = [...gains].sort((a, b) => a.x - b.x);
    const bins = Math.min(4, Math.floor(sorted.length / 2));
    if (bins < 2) return fitRate(gains);
    const points = Array.from({length: bins}, (_, b) => {
        const part = sorted.slice(Math.floor(b * sorted.length / bins), Math.floor((b + 1) * sorted.length / bins));
        return {x: quantile(part.map((g) => g.x), 0.5), y: quantile(part.map((g) => g.y), 0.75)};
    });
    if (points[points.length - 1].x - points[0].x < 1) return fitRate(gains);
    const mx = points.reduce((s, p) => s + p.x, 0) / points.length, my = points.reduce((s, p) => s + p.y, 0) / points.length;
    const sxx = points.reduce((s, p) => s + (p.x - mx) ** 2, 0);
    const perKwh = sxx > 0 ? Math.min(0, points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / sxx) : 0;
    return {heatPerHour: my, perKwh, atStored: mx, at: (x: number) => my + perKwh * (x - mx)};
}

/** Tank gain against heat stored: a falling line where the fills spread enough to tell, else one
 *  rate for every fill. */
function fitRate(gains: {x: number; y: number}[]) {
    const mx = gains.reduce((s, g) => s + g.x, 0) / gains.length, my = gains.reduce((s, g) => s + g.y, 0) / gains.length;
    const sxx = gains.reduce((s, g) => s + (g.x - mx) ** 2, 0);
    const spread = quantile(gains.map((g) => g.x), 0.9) - quantile(gains.map((g) => g.x), 0.1);
    // Only a falling rate is physical.
    const perKwh = gains.length >= 6 && spread >= 2 && sxx > 0
        ? Math.min(0, gains.reduce((s, g) => s + (g.x - mx) * (g.y - my), 0) / sxx) : 0;
    const heatPerHour = perKwh ? my : quantile(gains.map((g) => g.y), 0.5);
    return {heatPerHour, perKwh, atStored: mx, at: (x: number) => heatPerHour + perKwh * (x - mx)};
}

/** What a charge delivers, learned from whole hours of charging: how long it ran from the heat
 *  counter, what the tank gained from the litres estimate (as a line in the heat already stored),
 *  and the electricity it took. Hours with a draw large enough to empty the tank faster than it
 *  filled are left out of the rate. */
export function learnCharge(spans: Interval[]): ChargeModel | undefined {
    const charging = spans.filter((i) => i.produced > 0.5 * i.hours);
    if (charging.length < 3) return undefined;
    const hourly = charging.filter((i) => i.hours <= 1.01).map((i) => i.produced / i.hours);
    // Hours inside a charge, with charging on both sides, ran throughout; the hour a charge
    // started or stopped in reads slow. Without longer charges, the fastest hours stand in.
    const isCharging = (i?: Interval) => i !== undefined && i.produced > 0.5 * i.hours;
    const inside = spans.filter((i, k) => i.hours <= 1.01 && isCharging(i)
        && isCharging(spans[k - 1]) && spans[k - 1].start + spans[k - 1].hours * HOUR === i.start
        && isCharging(spans[k + 1]) && i.start + i.hours * HOUR === spans[k + 1].start).map((i) => i.produced / i.hours);
    // No hour runs faster than the full rate, so the fast end of all hours bounds it from below: a
    // tank whose inside hours are all near full, where the compressor slows, reads its full rate
    // from the hours that started a charge.
    const fastest = hourly.length ? quantile(hourly, 0.9) : quantile(charging.map((i) => i.produced / i.hours), 0.9);
    const producedPerHour = inside.length >= 3 ? Math.max(quantile(inside, 0.5), fastest) : fastest;
    const full = charging.filter((i) => i.hours <= 1.01 && i.produced / i.hours >= 0.8 * producedPerHour);
    const withEl = full.filter((i) => Number.isFinite(i.used) && i.used > 0);
    const runHours = withEl.reduce((s, i) => s + Math.min(i.hours, i.produced / producedPerHour), 0);
    if (!(runHours > 0)) return undefined;
    const kw = withEl.reduce((s, i) => s + i.used, 0) / runHours;
    // Tank gain per running hour, against the heat stored mid-hour.
    // Per hour the charge actually ran, so a charge that ends mid-hour at its stop still counts.
    const ran = spans.filter((i) => i.hours <= 1.01 && i.produced / i.hours >= RAN_SHARE * producedPerHour);
    const gains = ran.filter((i) => Number.isFinite(i.stored) && Number.isFinite(i.storedEnd) && i.storedEnd >= i.stored)
        .map((i) => ({x: (i.stored + i.storedEnd) / 2, y: (i.storedEnd - i.stored) / Math.min(i.hours, i.produced / producedPerHour)}));
    if (gains.length < 3) return undefined;
    const tops = full.filter((i) => finite(i.top));
    const atTop = tops.length ? tops.reduce((s, i) => s + i.top!, 0) / tops.length : NaN;
    // The line runs along the upper end of the gains at each fill; hours well under it had a draw.
    const line = fitEnvelope(gains);
    const near = gains.filter((g) => g.y >= line.at(g.x) - DRAW_RESIDUAL);
    const kept = near.length >= 3 ? near : gains;
    const tank = kept.reduce((s, g) => s + g.y, 0) / kept.length;
    return {heatPerHour: line.heatPerHour, perKwh: line.perKwh, atStored: line.atStored, producedPerHour, kw,
        cop: Math.max(0.5, tank / kw), copPerK: 0, atTop, samples: kept.length};
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
    /** Per local hour, from the hourly readings; undefined when the day had none. */
    byHour?: number[];
    /** Hours of known hourly draw behind each local hour (0–1): an hour the tank was under 40 °C,
     *  or read only in a coarser bucket, is unknown, and the day's other hours still count. */
    known?: number[];
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
            if (!day) map.set(date, day = {date, t, hoursCovered: 0, draw: 0, votes: new Map()});
            day.t = Math.max(day.t, t);
            day.hoursCovered += i.hours / steps;
            day.draw += i.draw / steps;
            if (i.hours <= 1.01) {
                (day.byHour ??= new Array(24).fill(0))[hour] += i.draw / steps;
                (day.known ??= new Array(24).fill(0))[hour] += i.hours / steps;
            }
            if (i.dayType) day.votes.set(i.dayType, (day.votes.get(i.dayType) ?? 0) + i.hours / steps);
        }
    }
    return [...map.values()].map(({votes, ...day}) => {
        const top = [...votes].sort((x, y) => y[1] - x[1])[0];
        return {...day, dayType: top?.[0]};
    }).sort((x, y) => x.t - y.t);
}

/** An hour counts toward a day's shape when this much of it was read hourly. */
const KNOWN_HOUR = 0.99;

/** The day type's profile: its daily total from full days (`list`), its hour shape from every
 *  day with hourly readings (`shapes`, part days included), each hour from the days that hour is
 *  known on. Until 2026-11-21 an hour shape took full days only, and a full day needed 22 known
 *  hours: a tank left under 40 °C overnight dropped the whole day (9–13 Nov on the S1155: 15–21
 *  known hours each), and with too few full days a type's shape leans on the pooled one. */
function profileOf(list: Day[], weight: (d: Day) => number, prior?: DayProfile, shapes: Day[] = list): DayProfile | undefined {
    if (!list.length && !shapes.length && !prior) return undefined;
    const w = list.map(weight);
    const total = w.reduce((s, v) => s + v, 0);
    const shapedAll = shapes.filter((d) => d.byHour && d.known).map((d) => [d, weight(d)] as const);
    const blend = (own: number, ownWeight: number, from: number | undefined) => {
        const k = Math.max(0, SHRINK_DAYS - ownWeight);
        return prior && k > 0 && from !== undefined && Number.isFinite(from) ? (own * ownWeight + from * k) / (ownWeight + k) : own;
    };
    const daily = total > 0 ? list.reduce((s, d, k) => s + d.draw * w[k], 0) / total : NaN;
    const dailyP80 = total > 0 ? weightedQuantile(list.map((d) => d.draw), w, 0.8) : NaN;
    const hours: number[] = [], p80: number[] = [];
    for (let h = 0; h < 24; h++) {
        const shaped = shapedAll.filter(([d]) => d.known![h] >= KNOWN_HOUR);
        const shapeTotal = shaped.reduce((s, [, v]) => s + v, 0);
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
    // Charges first: what they put into the tank is what tells a draw from a charge's lost heat.
    const charge = learnCharge(intervals(points, loss));
    const spans = intervals(points, loss, charge);
    // A day the tank ran low for a while (top under 40 °C: the draw is not knowable) is not a
    // full day: it is left out of learning, and shown as "at least" in the week chart.
    const every = days(spans, clock);
    const all = every.filter((d) => d.hoursCovered >= FULL_DAY_HOURS);
    const weight = (d: Day) => 0.5 ** (Math.max(0, now - d.t) / 86_400_000 / halfLifeDays);
    const present = all.filter((d) => d.dayType !== 'away');
    const typical = weightedQuantile(present.map((d) => d.draw), present.map(weight), 0.5);
    const away = all.filter((d) => d.dayType === 'away' || (!d.dayType && Number.isFinite(typical) && d.draw < AWAY_SHARE * typical));
    const kept = present.filter((d) => !away.includes(d));
    // Part days give hour shapes, never totals: a day short of readings is short of draw too.
    const shapeDays = every.filter((d) => d.dayType !== 'away' && !away.some((a) => a.date === d.date));
    const start = household && starterProfiles(household);
    const any = profileOf(kept, weight, start?.any, shapeDays);
    const profiles: HotwaterModel['profiles'] = {};
    if (any) profiles.any = any;
    for (const type of ['working', 'free'] as const) {
        const own = kept.filter((d) => d.dayType === type);
        // With a household the type has its own prior (a free day draws more, at other hours);
        // without one it leans on the pooled day.
        const ownShapes = shapeDays.filter((d) => d.dayType === type);
        if (own.length || ownShapes.length || start) profiles[type] = profileOf(own, weight, start?.[type] ?? any, ownShapes);
    }
    const evenings = weekdayEvenings(shapeDays.filter((d) => d.dayType === 'working'), weight);
    const today = clock(now).date;
    const recent = every.filter((d) => d.date < today).slice(-RECENT_DAYS).map((d): DayDraw => ({date: d.date,
        draw: Math.round(d.draw * 100) / 100, ...(d.dayType ? {dayType: d.dayType} : {}),
        ...(away.includes(d) ? {away: true} : {}),
        ...(d.hoursCovered < FULL_DAY_HOURS ? {partial: Math.round(d.hoursCovered * 10) / 10} : {})}));
    return {loss, charge, profiles, away: away.map((d) => d.date), days: all.length, recent, ...evenings ? {evenings} : {}};
}

/** The weekday of a local date, 0 = Sunday. */
export const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** Per weekday, the evening draw of working days whose every evening hour was read. */
function weekdayEvenings(days: Day[], weight: (d: Day) => number): HotwaterModel['evenings'] {
    const known = days.filter((d) => d.byHour && d.known && d.known.slice(EVENING_FROM, EVENING_TO).every((k) => k >= KNOWN_HOUR));
    if (!known.length) return undefined;
    const evening = (d: Day) => d.byHour!.slice(EVENING_FROM, EVENING_TO).reduce((a, b) => a + b, 0);
    const all = known.map((d) => [evening(d), weight(d)] as const);
    const total = all.reduce((s, [, w]) => s + w, 0);
    const refMean = all.reduce((s, [v, w]) => s + v * w, 0) / total;
    const refP80 = weightedQuantile(all.map(([v]) => v), all.map(([, w]) => w), 0.8);
    const out: NonNullable<HotwaterModel['evenings']> = {};
    for (let wd = 1; wd <= 5; wd++) {
        const own = known.filter((d) => weekdayOf(d.date) === wd).map((d) => [evening(d), weight(d)] as const);
        const n = own.reduce((s, [, w]) => s + w, 0);
        const k = Math.max(0, WEEKDAY_SHRINK - n);
        const mean = n > 0 ? own.reduce((s, [v, w]) => s + v * w, 0) / n : refMean;
        const p80 = n > 0 ? weightedQuantile(own.map(([v]) => v), own.map(([, w]) => w), 0.8) : refP80;
        const r = (v: number) => Math.round(v * 100) / 100;
        out[wd] = {days: r(n), mean: r((mean * n + refMean * k) / (n + k)), p80: r((p80 * n + refP80 * k) / (n + k))};
    }
    return out;
}

/** The profile to plan a day with: its type's, else the pooled one. */
export function profileFor(model: HotwaterModel, dayType: DayType | undefined): DayProfile | undefined {
    if (dayType === 'away') return undefined;
    return (dayType && model.profiles[dayType]) || model.profiles.any;
}
