/** The Gateway's price history: how far each past day's prices spread between its cheap and
 *  expensive hours, for the last year in the owner's own price zone (Homey Energy keeps past days,
 *  docs/external-io.md). The savings projection weights the rest of the year by it, so a winter of
 *  big price swings is not projected at an autumn's pace, wherever the owner is.
 *
 *  A day's spread is the mean spot price of its most expensive third of hours minus its cheapest
 *  third: what moving a kWh across the day can save. Spot, not the owner's all-in price: a cost
 *  formula scales every month alike, which the projection's ratio cancels, and a changed formula
 *  then leaves the history valid.
 *
 *  Filled once, newest first, one day at a time at background priority through the Gateway (its
 *  energy lane paces the calls), and kept in the app's settings; after that, one new day a day.
 *  A change of price zone starts it again. */

import {DayPrices, SLOT_MS, normalisePrices} from './autopilot/prices';
import {PRIORITY, gatewayFor} from './gateway';
import {pricesFor} from './gateway-prices';

/** Days back the history reaches: a year and a month, so every month has a past. */
export const HISTORY_DAYS = 400;
/** Days a month needs before its spread is trusted. */
export const MONTH_MIN_DAYS = 10;
/** A failed fill waits this long before it is tried again. */
export const RETRY_MS = 60 * 60_000;
/** Days saved at a time while filling, so a restart keeps most of the work. */
const SAVE_EVERY = 10;
export const SETTING = 'autopilotPriceSpreads';

export interface SpreadStore {
    /** Homey Energy's price zone the days were read in. */
    zone?: string;
    /** Local date → spread, in the zone's currency per kWh. */
    days: Record<string, number>;
}

/** The spread of one day's prices: the mean of the hourly spot prices in its most expensive third
 *  minus its cheapest third. Hourly, so a quarter-hour day and an hourly one (Homey Energy before
 *  October 2025) read alike. Undefined with fewer than 20 hours. */
export function daySpread(prices: DayPrices): number | undefined {
    const hours = new Map<number, {sum: number; n: number}>();
    for (const s of prices.slots) {
        const hour = Math.floor(s.slot * SLOT_MS / 3_600_000);
        const h = hours.get(hour) ?? {sum: 0, n: 0};
        hours.set(hour, {sum: h.sum + s.spot, n: h.n + 1});
    }
    if (hours.size < 20) return undefined;
    const sorted = [...hours.values()].map((h) => h.sum / h.n).sort((a, b) => a - b);
    const third = Math.floor(sorted.length / 3);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.round((mean(sorted.slice(-third)) - mean(sorted.slice(0, third))) * 10_000) / 10_000;
}

/** The mean spread of each calendar month (index 0 = January), or undefined until every month has
 *  MONTH_MIN_DAYS days. */
export function monthSpreads(days: Record<string, number>): number[] | undefined {
    const sum = new Array(12).fill(0), n = new Array(12).fill(0);
    for (const [date, spread] of Object.entries(days)) {
        const m = Number(date.slice(5, 7)) - 1;
        if (!(m >= 0 && m < 12) || !Number.isFinite(spread)) continue;
        sum[m] += spread;
        n[m]++;
    }
    if (n.some((c) => c < MONTH_MIN_DAYS)) return undefined;
    return sum.map((s, m) => Math.round(s / n[m] * 10_000) / 10_000);
}

/** The dates the history should have and lacks, newest first: yesterday back HISTORY_DAYS. */
export function missingDates(store: SpreadStore, today: string): string[] {
    const out: string[] = [];
    const [y, m, d] = today.split('-').map(Number);
    for (let k = 1; k <= HISTORY_DAYS; k++) {
        const date = new Date(Date.UTC(y, m - 1, d - k)).toISOString().slice(0, 10);
        if (store.days[date] === undefined) out.push(date);
    }
    return out;
}

export interface PriceHistoryDeps {
    /** Homey Energy's answer for a date, through the Gateway at background priority. */
    fetchDay(date: string): Promise<any>;
    load(): SpreadStore | undefined;
    save(store: SpreadStore): void;
    today(): string;
    now(): number;
    log(...args: any[]): void;
}

export class PriceHistory {
    private filling?: Promise<void>;
    private failedAt = -Infinity;
    private filledFor?: string;
    private lastError?: string;

    constructor(private readonly deps: PriceHistoryDeps) {}

    /** Each month's spread, or undefined while the history is filling. Starts or continues the fill
     *  in the background; never waits for it and never throws. */
    spreads(): number[] | undefined {
        const store = this.store();
        const today = this.deps.today();
        if (!this.filling && this.filledFor !== today && this.deps.now() - this.failedAt > RETRY_MS) {
            this.filling = this.fill(today).finally(() => { this.filling = undefined; });
        }
        return monthSpreads(store.days);
    }

    private store(): SpreadStore {
        const kept = this.deps.load();
        return kept && typeof kept.days === 'object' && kept.days ? kept : {days: {}};
    }

    private async fill(today: string): Promise<void> {
        let store = this.store();
        const missing = missingDates(store, today);
        let unsaved = 0;
        try {
            for (const date of missing) {
                const response = await this.deps.fetchDay(date);
                const zone = typeof response?.zoneId === 'string' ? response.zoneId : undefined;
                if (zone && store.zone && zone !== store.zone) {
                    // A new price zone: last zone's days say nothing about this one.
                    this.deps.log(`Price history: zone changed from ${store.zone} to ${zone}; read again.`);
                    store = {zone, days: {}};
                    this.deps.save(store);
                    return this.fill(today);
                }
                if (zone) store.zone = zone;
                const spread = daySpread(normalisePrices(response, undefined));
                // A day Homey has no prices for is marked, so it is not asked for again every day.
                store.days[date] = spread ?? NaN;
                if (++unsaved >= SAVE_EVERY) { this.save(store, today); unsaved = 0; }
            }
            this.save(store, today);
            this.filledFor = today;
            if (missing.length > 1) {
                const months = monthSpreads(store.days);
                this.deps.log(`Price history: ${Object.values(store.days).filter(Number.isFinite).length} days in ${store.zone ?? 'an unknown zone'}`
                    + (months ? `, spread per month ${months.map((v) => v.toFixed(2)).join(' ')}.` : ', not every month yet.'));
            }
        } catch (error: any) {
            this.save(store, today);
            this.failedAt = this.deps.now();
            // Once per reason, not every hour it is tried again.
            const why = String(error?.message ?? error);
            if (why !== this.lastError) this.deps.log('Price history: fill paused:', why);
            this.lastError = why;
        }
    }

    /** Save, dropping days older than the history reaches. NaN is kept as null in settings. */
    private save(store: SpreadStore, today: string) {
        const oldest = missingDates({days: {}}, today).pop()!;
        const days: Record<string, number> = {};
        for (const [date, v] of Object.entries(store.days)) if (date >= oldest) days[date] = v;
        store.days = days;
        this.deps.save(store);
    }
}

/** One price history per app process, through its Gateway. */
let shared: PriceHistory | undefined;

export function priceHistoryFor(homey: any, today: () => string, log: (...args: any[]) => void): PriceHistory {
    shared ??= new PriceHistory({
        fetchDay: async (date) => {
            // Without dynamic prices in Homey Energy there is nothing to read; asked again hourly.
            if (!(await pricesFor(homey).info()).dynamic) throw new Error('no dynamic prices in Homey Energy');
            return gatewayFor(homey).call((api) => api.energy.fetchDynamicElectricityPrices({date}), PRIORITY.background);
        },
        load: () => {
            const kept = homey.settings.get(SETTING) as SpreadStore | null;
            if (!kept?.days) return undefined;
            // Settings keep NaN as null: a day known to have no prices.
            for (const date of Object.keys(kept.days)) if (kept.days[date] === null) kept.days[date] = NaN;
            return kept;
        },
        save: (store) => homey.settings.set(SETTING, store),
        today,
        now: () => Date.now(),
        log,
    });
    return shared;
}
