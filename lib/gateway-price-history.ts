/** How far spot prices swing between cheap and expensive hours in each calendar month, in the
 *  owner's own price zone over the last year. The savings projection weights the rest of the year by
 *  it, so a winter of big price swings is not projected at an autumn's pace, wherever the owner is.
 *
 *  A day's spread is the mean spot price of its most expensive third of hours minus its cheapest
 *  third: what moving a kWh across the day can save. A month's is the mean of its days. Only the
 *  months' sizes relative to each other matter (the projection's pace cancels the unit), so the
 *  source's EUR/MWh is used as it comes.
 *
 *  The year comes from Energy-Charts (Fraunhofer ISE, api.energy-charts.info) in one request
 *  through the Gateway's web lane, at background priority, about once a month. Only the price zone
 *  is sent. The zone is the one the owner chose in Homey Energy. Twelve numbers are kept in the
 *  app's settings; the prices themselves are not. docs/external-io.md. */

import {PRIORITY, gatewayFor} from './gateway';
import {localDate} from './autopilot/prices';
import {getJson} from './web';

/** Days a month needs before its spread is trusted. */
export const MONTH_MIN_DAYS = 10;
/** The year is read again after this long, so the months stay the last twelve. */
export const REFRESH_MS = 30 * 24 * 3_600_000;
/** A failed read waits this long before it is tried again. */
export const RETRY_MS = 6 * 3_600_000;
export const SETTING = 'autopilotPriceMonths';
/** The 1.5.x test builds' day-by-day history, read from Homey Energy; dropped on first use. */
const OLD_SETTING = 'autopilotPriceSpreads';

export interface MonthStore {
    /** Energy-Charts' bidding zone the months were read for. */
    zone: string;
    /** When they were read (ms). */
    at: number;
    /** Each month's spread, January first. */
    months: number[];
}

/** Homey Energy's zones (ENTSO-E area codes) as Energy-Charts names them. */
const ZONES: Record<string, string> = {
    '10Y1001A1001A44P': 'SE1', '10Y1001A1001A45N': 'SE2', '10Y1001A1001A46L': 'SE3', '10Y1001A1001A47J': 'SE4',
    '10YNO-1--------2': 'NO1', '10YNO-2--------T': 'NO2', '10YNO-3--------J': 'NO3', '10YNO-4--------9': 'NO4',
    '10Y1001A1001A48H': 'NO5', '10YDK-1--------W': 'DK1', '10YDK-2--------M': 'DK2', '10YNL----------L': 'NL',
    '10Y1001A1001A82H': 'DE-LU', '10YBE----------2': 'BE', '10YFI-1--------U': 'FI', '10YAT-APG------L': 'AT',
    '10YFR-RTE------C': 'FR', '10YPL-AREA-----S': 'PL', '10YCH-SWISSGRIDZ': 'CH', '10Y1001A1001A39I': 'EE',
    '10YLV-1001A00074': 'LV', '10YLT-1001A0008Q': 'LT',
};

/** The Energy-Charts zone for Homey Energy's zone answer, or undefined when it has none we know.
 *  The owner's own choice first, then the one Homey picked. */
export function chartsZone(answer: any): string | undefined {
    for (const z of [answer?.userConfigured, answer?.autoConfigured]) {
        const zone = ZONES[z?.zoneId];
        if (zone) return zone;
    }
    return undefined;
}

/** The spread of one day's hourly means: its most expensive third's mean minus its cheapest
 *  third's. Undefined with fewer than 20 hours. */
export function hoursSpread(hourly: number[]): number | undefined {
    if (hourly.length < 20) return undefined;
    const sorted = [...hourly].sort((a, b) => a - b);
    const third = Math.floor(sorted.length / 3);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    return mean(sorted.slice(-third)) - mean(sorted.slice(0, third));
}

/** Each month's mean daily spread from Energy-Charts' series (seconds, price per interval), with
 *  days in the owner's time zone; undefined until every month has MONTH_MIN_DAYS days. */
export function monthSpreads(seconds: number[], prices: (number | null)[], timeZone: string): number[] | undefined {
    const days = new Map<string, Map<number, {sum: number; n: number}>>();
    seconds.forEach((s, k) => {
        const price = prices[k];
        if (typeof price !== 'number' || !Number.isFinite(price)) return;
        const date = localDate(s * 1000, timeZone);
        const hours = days.get(date) ?? new Map();
        const hour = Math.floor(s / 3600);
        const h = hours.get(hour) ?? {sum: 0, n: 0};
        hours.set(hour, {sum: h.sum + price, n: h.n + 1});
        days.set(date, hours);
    });
    const sum = new Array(12).fill(0), n = new Array(12).fill(0);
    for (const [date, hours] of days) {
        const spread = hoursSpread([...hours.values()].map((h) => h.sum / h.n));
        if (spread === undefined) continue;
        const m = Number(date.slice(5, 7)) - 1;
        sum[m] += spread;
        n[m]++;
    }
    if (n.some((c) => c < MONTH_MIN_DAYS)) return undefined;
    return sum.map((s, m) => Math.round(s / n[m] * 100) / 100);
}

export interface PriceHistoryDeps {
    /** Homey Energy's zone answer (`getDynamicPricesElectricityZone`). */
    zone(): Promise<any>;
    /** Energy-Charts' day-ahead prices for a zone and a date span (YYYY-MM-DD, inclusive). */
    fetchYear(zone: string, start: string, end: string): Promise<any>;
    load(): MonthStore | undefined;
    save(store: MonthStore): void;
    timeZone(): string;
    now(): number;
    log(...args: any[]): void;
}

export class PriceHistory {
    private reading?: Promise<void>;
    private failedAt = -Infinity;
    private lastError?: string;

    constructor(private readonly deps: PriceHistoryDeps) {}

    /** Each month's spread, or undefined until known. Starts a read in the background when the
     *  months are missing or a month old; never waits for it and never throws. */
    spreads(): number[] | undefined {
        const kept = this.deps.load();
        const now = this.deps.now();
        if (!this.reading && (!kept || now - kept.at > REFRESH_MS) && now - this.failedAt > RETRY_MS) {
            this.reading = this.read().finally(() => { this.reading = undefined; });
        }
        return kept?.months;
    }

    private async read(): Promise<void> {
        try {
            const zone = chartsZone(await this.deps.zone());
            if (!zone) throw new Error('no price zone in Homey Energy that Energy-Charts has');
            const timeZone = this.deps.timeZone();
            const now = this.deps.now();
            // The last 365 whole days, so each month appears once.
            const answer = await this.deps.fetchYear(zone, localDate(now, timeZone, -365), localDate(now, timeZone, -1));
            const months = monthSpreads(answer?.unix_seconds ?? [], answer?.price ?? [], timeZone);
            if (!months) throw new Error(`Energy-Charts had too few days for ${zone}`);
            this.deps.save({zone, at: now, months});
            this.deps.log(`Price history: ${zone}, spread per month ${months.map((v) => v.toFixed(0)).join(' ')} EUR/MWh.`);
            this.lastError = undefined;
        } catch (error: any) {
            this.failedAt = this.deps.now();
            // Once per reason, not every time it is tried again.
            const why = String(error?.message ?? error);
            if (why !== this.lastError) this.deps.log('Price history: not read:', why);
            this.lastError = why;
        }
    }
}

/** One price history per app process, through its Gateway. */
let shared: PriceHistory | undefined;

export function priceHistoryFor(homey: any, log: (...args: any[]) => void): PriceHistory {
    if (!shared) {
        if (homey.settings.get(OLD_SETTING) != null) homey.settings.unset(OLD_SETTING);
        shared = new PriceHistory({
            zone: () => gatewayFor(homey).call((api) => api.energy.getDynamicPricesElectricityZone(), PRIORITY.background),
            fetchYear: (zone, start, end) => gatewayFor(homey).web('energy-charts price',
                () => getJson(`https://api.energy-charts.info/price?bzn=${encodeURIComponent(zone)}&start=${start}&end=${end}`, 60_000),
                PRIORITY.background),
            load: () => {
                const kept = homey.settings.get(SETTING) as MonthStore | null;
                return kept && Array.isArray(kept.months) && kept.months.length === 12 ? kept : undefined;
            },
            save: (store) => homey.settings.set(SETTING, store),
            timeZone: () => homey.clock.getTimezone(),
            now: () => Date.now(),
            log,
        });
    }
    return shared;
}
