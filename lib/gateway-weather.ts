/** The Gateway's weather book (docs/external-io.md, step 3): the location and Open-Meteo's
 *  weather, fetched once and shared. The heating collector and solar surplus each fetched the
 *  location, and solar fetched 92 days of irradiance every 3 hours on top of the forecast that
 *  already carries the same `shortwave_radiation`.
 *
 *  Age rules: the Homey's location for a day (a place chosen in Setup, used when the Homey has
 *  none, is read each time, so a change takes effect at once); the forecast for an hour; the irradiance history for a day. Two
 *  callers asking at once share one request. */

import {PRIORITY, gatewayFor} from './gateway';
import {getJson} from './web';
import {openMeteoUrl, weatherLocation} from './autopilot/weather';
import {hourlyGhi, irradianceUrl} from './autopilot/hotwater-surplus';
import {dailyMeans, seasonUrl} from './autopilot/season';

export const LOCATION_MAX_AGE_MS = 24 * 60 * 60_000;
export const FORECAST_MAX_AGE_MS = 60 * 60_000;
export const HISTORY_MAX_AGE_MS = 24 * 60 * 60_000;
/** The season's history is whole past years: it changes once a year. */
export const SEASON_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** A failed fetch is not asked again sooner than this (a forecast service that is down). */
export const RETRY_MS = 15 * 60_000;

export interface Location {latitude: number; longitude: number; source: 'homey' | 'chosen'}

export interface WeatherBookDeps {
    /** The Homey's own location, through the Gateway (`geolocation.getOptionLocation`). */
    homeyLocation(): Promise<any>;
    /** The place chosen in Setup (app setting), or null. */
    chosenPlace(): any;
    /** A web fetch through the Gateway; throws on failure. */
    getJson(url: string, name: string): Promise<any>;
    now(): number;
}

interface Kept<T> {at: number; value?: T; failedAt?: number; ask?: Promise<T | undefined>}

export class WeatherBook {
    private homeyPlace: Kept<any> = {at: -Infinity};
    private forecasts = new Map<string, Kept<any>>();
    private histories = new Map<string, Kept<Map<number, number>>>();
    private seasons = new Map<string, Kept<Map<string, number>>>();

    constructor(private readonly deps: WeatherBookDeps) {}

    /** Where the weather is for: the Homey's location, else a place chosen in Setup; undefined
     *  when there is neither. */
    async location(): Promise<Location | undefined> {
        const homey = await this.kept(this.homeyPlace, LOCATION_MAX_AGE_MS, () => this.deps.homeyLocation());
        return weatherLocation(homey?.value, this.deps.chosenPlace()) ?? undefined;
    }

    /** Open-Meteo's forecast for the location (1 day back, 3 ahead, every variable the collector
     *  reads, `shortwave_radiation` included); undefined without a location or a first answer. */
    async forecast(): Promise<any> {
        const at = await this.location();
        if (!at) return undefined;
        const url = openMeteoUrl(at.latitude, at.longitude);
        return this.kept(this.slot(this.forecasts, url), FORECAST_MAX_AGE_MS, () => this.deps.getJson(url, 'open-meteo forecast'));
    }

    /** When the forecast `forecast()` returns was fetched (ms), so staleness is judged on the data,
     *  not on when it was asked for; undefined before the first. */
    forecastAt(): number | undefined {
        const kept = [...this.forecasts.values()][0];
        return kept?.value !== undefined ? kept.at : undefined;
    }

    /** Sun on the ground, hour start (ms) → W/m²: the last 92 days (fetched daily) with the
     *  forecast's hours laid over them, so the hours ahead are an hour old at most. */
    async ghi(): Promise<Map<number, number> | undefined> {
        const at = await this.location();
        if (!at) return undefined;
        const url = irradianceUrl(at.latitude, at.longitude);
        const history = await this.kept(this.slot(this.histories, url), HISTORY_MAX_AGE_MS,
            async () => hourlyGhi(await this.deps.getJson(url, 'open-meteo irradiance')));
        const forecast = await this.forecast();
        if (!history && !forecast) return undefined;
        const merged = new Map(history ?? []);
        for (const [at, w] of hourlyGhi(forecast)) merged.set(at, w);
        return merged;
    }

    /** Daily mean outdoor temperature over the last full years at the location (season.ts), for
     *  the heating savings estimate; fetched at most monthly. Undefined without a location or an
     *  answer. */
    async seasonDays(today: string): Promise<Map<string, number> | undefined> {
        const at = await this.location();
        if (!at) return undefined;
        const url = seasonUrl(at.latitude, at.longitude, today);
        // An answer without days (an error body) is a failure, retried after RETRY_MS, never kept
        // as a month's season.
        const days = await this.kept(this.slot(this.seasons, url), SEASON_MAX_AGE_MS, async () => {
            const parsed = dailyMeans(await this.deps.getJson(url, 'open-meteo archive'));
            if (!parsed.size) throw new Error('open-meteo archive: no days');
            return parsed;
        });
        return days?.size ? days : undefined;
    }

    /** The past `days` of weather, for the one-off history backfill. Not kept. */
    async past(days: number): Promise<any> {
        const at = await this.location();
        return at ? this.deps.getJson(openMeteoUrl(at.latitude, at.longitude, days, 1), 'open-meteo past') : undefined;
    }

    /** Only the newest location's entry is kept: a moved Homey or a new chosen place drops the old. */
    private slot<T>(map: Map<string, Kept<T>>, key: string): Kept<T> {
        let kept = map.get(key);
        if (!kept) { map.clear(); kept = {at: -Infinity}; map.set(key, kept); }
        return kept;
    }

    private async kept<T>(kept: Kept<T>, maxAge: number, fetch: () => Promise<T>): Promise<T | undefined> {
        const now = this.deps.now();
        if (kept.value !== undefined && now - kept.at < maxAge) return kept.value;
        if (kept.failedAt !== undefined && now - kept.failedAt < RETRY_MS) return kept.value;
        kept.ask ??= fetch().then((value) => {
            kept.value = value;
            kept.at = this.deps.now();
            kept.failedAt = undefined;
            return value;
        }).catch(() => {
            kept.failedAt = this.deps.now();
            return kept.value;
        }).finally(() => { kept.ask = undefined; });
        return kept.ask;
    }
}

/** One weather book per app process, through its Gateway. */
let shared: WeatherBook | undefined;

export function weatherFor(homey: any, chosenSetting: string): WeatherBook {
    shared ??= new WeatherBook({
        homeyLocation: () => gatewayFor(homey).call((api) => api.geolocation.getOptionLocation(), PRIORITY.control),
        chosenPlace: () => homey.settings.get(chosenSetting),
        getJson: (url, name) => gatewayFor(homey).web(name, () => getJson(url)),
        now: () => Date.now(),
    });
    return shared;
}
