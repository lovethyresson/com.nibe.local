/** Autopilot's analytics vocabulary: the bounded values its events carry, and the edge and daily
 *  bookkeeping behind them. Pure, so every bucket and every edge is a test. What is sent, and
 *  why: docs/analytics.md; the names are the cross-app contract in docs/analytics-taxonomy.md.
 *
 *  Never a reading, a setpoint, an amount or a time: a ratio against the home's own expectation,
 *  a bucket, a boolean or a small count. */
import type {SmartMode} from './smart-mode';
import type {StopReason} from './live';

/** Smart mode as analytics names it: the internal `test` is "Simulation" to the owner. */
export type AnalyticsSmartMode = 'off' | 'spa' | 'simulation' | 'autopilot';
export function analyticsSmartMode(mode: SmartMode): AnalyticsSmartMode {
    return mode === 'test' ? 'simulation' : mode;
}

/** "Always keep at least", litres → `off` / `20` / `40` / `60` / `other`. */
export function reserveBucket(litres: number): string {
    if (litres === 0) return 'off';
    return litres === 20 || litres === 40 || litres === 60 ? String(litres) : 'other';
}

/** A ratio against the home's own expectation (1 = as expected). Undefined for no ratio. */
export function ratioBucket(ratio: number): string | undefined {
    if (!Number.isFinite(ratio) || ratio < 0) return undefined;
    return ratio < 0.5 ? '<0.5' : ratio < 0.8 ? '0.5-0.8' : ratio <= 1.25 ? '0.8-1.25' : ratio <= 2 ? '1.25-2' : '>2';
}

/** A mean absolute temperature difference, K. */
export function kelvinBucket(k: number): string | undefined {
    if (!Number.isFinite(k) || k < 0) return undefined;
    return k < 0.3 ? '<0.3' : k < 0.7 ? '0.3-0.7' : k <= 1.5 ? '0.7-1.5' : '>1.5';
}

/** The share of the day's charging that ran on solar surplus, 0..1. */
export function solarShareBucket(share: number): string | undefined {
    if (!Number.isFinite(share) || share < 0) return undefined;
    return share === 0 ? '0' : share < 0.5 ? '<50%' : '>=50%';
}

/** Why Autopilot could not act, for `Blocked Autopilot`. */
export type BlockedBy = 'spa_on' | 'hot_water_off' | 'smart_control' | 'daily_limit' | 'no_prices'
    | 'room_control' | 'immersion_only' | 'cooling' | 'no_outdoor' | 'feed_failed';

/** Hot water's lever skips (hotwater-lever.ts `LeverSkip`) that block a planned start. The others
 *  (tank hot enough, a register that did not read) are not a block worth counting. */
const LEVER_BLOCKS: Record<string, BlockedBy> = {
    'hot water off': 'hot_water_off', 'smart price adaption': 'spa_on', 'smart control': 'smart_control', 'daily limit': 'daily_limit',
};
export function leverBlock(skip: string): BlockedBy | undefined {
    return LEVER_BLOCKS[skip];
}

/** Heating's stop reasons (live.ts) that block the feed. `mode_off` is the owner's choice and
 *  `no_model` is learning (its own state): neither is a block. */
export function heatingBlock(stopped: StopReason | undefined): BlockedBy | undefined {
    return stopped === 'mode_off' || stopped === 'no_model' ? undefined : stopped;
}

/** An edge trigger: `changed(v)` is true when `v` differs from the last value it saw, the first
 *  value included. Anything on a poll loop or a slot timer goes through one. */
export class Edge<T> {
    private seen = false;
    private last?: T;
    changed(value: T): boolean {
        if (this.seen && this.last === value) return false;
        this.seen = true;
        this.last = value;
        return true;
    }
    get value(): T | undefined {
        return this.last;
    }
}

/** The tank since the last morning message: its lowest volume and top, and whether it went under
 *  the safety net. Kept in the plan's store record, so a restart keeps the day. */
export interface TankDay {
    /** When the window started, ms: the last morning message, or the first slot seen. */
    from: number;
    minLitres?: number;
    minTop?: number;
    belowNet?: true;
}

/** The day after one slot's reading; the same object when nothing changed (no store write). */
export function tankDayUpdate(day: TankDay, now: {litres?: number; top?: number}, reserveLitres: number): TankDay {
    let next = day;
    const set = (patch: Partial<TankDay>) => { next = {...next, ...patch}; };
    if (Number.isFinite(now.litres) && !(now.litres! >= (day.minLitres ?? Infinity))) set({minLitres: Math.round(now.litres!)});
    if (Number.isFinite(now.top) && !(now.top! >= (day.minTop ?? Infinity))) set({minTop: Math.round(now.top! * 10) / 10});
    if (!day.belowNet && reserveLitres > 0 && Number.isFinite(now.litres) && now.litres! < reserveLitres) set({belowNet: true});
    return next;
}

/** A day is scored only when this much of it was watched: a restart or a first start must not
 *  report part of a day as the whole. */
export const SCORED_MIN_HOURS = 20;
/** Below this tank top, °C, the day "ran cold": a shower then is lukewarm. */
export const COLD_TOP_C = 40;

/** A charge as the hot water day score reads it (hotwater-shadow.ts `ChargeEvent`). */
export interface ScoredCharge {
    by: 'autopilot' | 'pump';
    /** Mean buy price over the run, per kWh; undefined when not known. */
    price?: number;
    surplusShare?: number;
}

export interface HotwaterDayInput {
    day: TankDay;
    now: number;
    charges: ScoredCharge[];
    /** Yesterday's learned draw and what the profile expected for its day type, kWh. */
    drawKwh?: number;
    expectedKwh?: number;
    /** Mean buy price over the window, per kWh. */
    dayMeanPrice?: number;
    simulation: boolean;
}

/** `Scored Autopilot Day` for hot water: ratios and counts only. Undefined when the window is too
 *  short to be a day. */
export function hotwaterDayScore(i: HotwaterDayInput): Record<string, string | number | boolean> | undefined {
    if (i.now - i.day.from < SCORED_MIN_HOURS * 3_600_000) return undefined;
    const out: Record<string, string | number | boolean> = {
        role: 'hotwater',
        fell_below_net: i.day.belowNet === true,
        ran_cold: i.day.minTop !== undefined && i.day.minTop < COLD_TOP_C,
        charges_autopilot: i.charges.filter((c) => c.by === 'autopilot').length,
        charges_device: i.charges.filter((c) => c.by === 'pump').length,
        simulation: i.simulation,
    };
    const use = i.drawKwh !== undefined && i.expectedKwh! > 0 ? ratioBucket(i.drawKwh / i.expectedKwh!) : undefined;
    if (use) out.use_vs_expected = use;
    const priced = i.charges.filter((c) => Number.isFinite(c.price));
    if (priced.length && i.dayMeanPrice! > 0) {
        const paid = ratioBucket(priced.reduce((sum, c) => sum + c.price!, 0) / priced.length / i.dayMeanPrice!);
        if (paid) out.price_vs_day_mean = paid;
    }
    if (i.charges.length) {
        const solar = solarShareBucket(i.charges.reduce((sum, c) => sum + (c.surplusShare ?? 0), 0) / i.charges.length);
        if (solar) out.solar_share = solar;
    }
    return out;
}

/** Slots a day must have been scored in: the same 20 h. */
const SCORED_MIN_SLOTS = SCORED_MIN_HOURS * 4;
/** The slots ahead the forecast error is taken at: 6 h. */
export const FORECAST_SLOTS = 24;

/** Heating's day, slot by slot: how far indoor was from comfort, how long outside the comfort
 *  range, and how far the 6 h indoor prediction missed. Kept in memory; a day with a restart in
 *  it is too short to score and is dropped. */
export class HeatingDay {
    private date?: string;
    private slots = new Set<number>();
    private offSum = 0;
    private outside = 0;
    private errors: number[] = [];
    private simulation = false;
    /** Indoor predicted for a slot, by slot. */
    private predicted = new Map<number, number>();

    /** The plan made at `slot` expects `indoor` at `slot + FORECAST_SLOTS`. */
    predict(slot: number, indoor: number) {
        if (Number.isFinite(indoor) && !this.predicted.has(slot + FORECAST_SLOTS)) this.predicted.set(slot + FORECAST_SLOTS, indoor);
    }

    /** One slot's indoor against comfort and the range [comfort − lower, comfort + upper]. Returns
     *  the finished day's score when `date` (local) starts a new day. One reading per slot counts. */
    observe(o: {slot: number; date: string; ti: number; comfort: number; lower: number; upper: number; simulation: boolean}):
        Record<string, string | number | boolean> | undefined {
        let done: Record<string, string | number | boolean> | undefined;
        if (this.date !== o.date) {
            done = this.score();
            this.date = o.date;
            this.slots.clear();
            this.offSum = 0;
            this.outside = 0;
            this.errors = [];
            this.simulation = false;
        }
        if (!Number.isFinite(o.ti) || !Number.isFinite(o.comfort) || this.slots.has(o.slot)) return done;
        this.slots.add(o.slot);
        this.offSum += Math.abs(o.ti - o.comfort);
        if (o.ti < o.comfort - o.lower || o.ti > o.comfort + o.upper) this.outside++;
        this.simulation ||= o.simulation;
        const p = this.predicted.get(o.slot);
        if (p !== undefined) this.errors.push(Math.abs(o.ti - p));
        for (const slot of this.predicted.keys()) if (slot <= o.slot) this.predicted.delete(slot);
        return done;
    }

    private score(): Record<string, string | number | boolean> | undefined {
        if (this.slots.size < SCORED_MIN_SLOTS) return undefined;
        const out: Record<string, string | number | boolean> = {
            role: 'heating',
            indoor_off_target: kelvinBucket(this.offSum / this.slots.size)!,
            hours_outside_range: Math.round(this.outside / 4),
            simulation: this.simulation,
        };
        const error = this.errors.length ? kelvinBucket(this.errors.reduce((a, b) => a + b, 0) / this.errors.length) : undefined;
        if (error) out.forecast_error = error;
        return out;
    }
}

/** `Changed Day Type`'s source. */
export type DayTypeSource = 'flow' | 'device' | 'away';
