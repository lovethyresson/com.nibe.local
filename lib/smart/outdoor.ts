/** The real outdoor temperature, which input 1 stops showing once the app feeds BT1. Pure.
 *  Design: docs/smart-heating-plan.md §4.2. M0.3 found no physical-BT1 copy while feeding, so
 *  the sources are the wired sensor (only while not feeding), a Homey sensor, and the forecast
 *  corrected by what the wired sensor taught it. */

export type OutdoorSource = 'wired' | 'sensor' | 'forecast';

/** After this long on the forecast alone, stop feeding so the wired sensor takes over. */
export const DEGRADED_LIMIT_MS = 6 * 60 * 60 * 1000;
/** EMA weight once an hour has enough samples; the first ones are a plain mean. */
const BIAS_ALPHA = 0.05;

/** `wired − forecast` per local hour of day: the forecast grid point is not the owner's wall. */
export interface ForecastBias {
    mean: number[];
    count: number[];
}

export function newForecastBias(): ForecastBias {
    return {mean: new Array(24).fill(0), count: new Array(24).fill(0)};
}

/** Learn from one slot while not feeding, when the wired reading is the real one. */
export function learnForecastBias(bias: ForecastBias, localHour: number, wired: number, forecast: number): ForecastBias {
    if (!Number.isFinite(wired) || !Number.isFinite(forecast) || localHour < 0 || localHour > 23) return bias;
    const h = Math.floor(localHour);
    const mean = [...bias.mean];
    const count = [...bias.count];
    count[h] += 1;
    const alpha = Math.max(1 / count[h], BIAS_ALPHA);
    mean[h] += alpha * (wired - forecast - mean[h]);
    return {mean, count};
}

/** The correction for an hour; an hour never seen borrows the mean of the hours that were. */
export function forecastCorrection(bias: ForecastBias, localHour: number): number {
    const h = Math.floor(localHour);
    if (bias.count[h] > 0) return bias.mean[h];
    const seen = bias.mean.filter((_, i) => bias.count[i] > 0);
    return seen.length ? seen.reduce((a, b) => a + b, 0) / seen.length : 0;
}

export interface OutdoorInput {
    now: number;
    /** True while the app feeds BT1, which makes input 1 show the app's own value. */
    feeding: boolean;
    /** Input 1. */
    wired?: number;
    /** The Homey outdoor sensor the owner picked, already checked for freshness. */
    sensor?: number;
    /** Open-Meteo's temperature for now. */
    forecast?: number;
    localHour: number;
    bias: ForecastBias;
    /** When the forecast became the only source, carried between calls. */
    degradedSince?: number;
}

export interface OutdoorReading {
    value?: number;
    source?: OutdoorSource;
    degradedSince?: number;
    /** Stop feeding: no trustworthy source, or the forecast alone for too long. */
    goNeutral: boolean;
}

export function realOutdoor(input: OutdoorInput): OutdoorReading {
    const finite = (v?: number): v is number => typeof v === 'number' && Number.isFinite(v);
    if (!input.feeding && finite(input.wired)) return {value: input.wired, source: 'wired', goNeutral: false};
    if (finite(input.sensor)) return {value: input.sensor, source: 'sensor', goNeutral: false};
    if (finite(input.forecast)) {
        const degradedSince = input.feeding ? input.degradedSince ?? input.now : undefined;
        return {
            value: input.forecast + forecastCorrection(input.bias, input.localHour),
            source: 'forecast',
            degradedSince,
            goNeutral: degradedSince !== undefined && input.now - degradedSince >= DEGRADED_LIMIT_MS,
        };
    }
    return {goNeutral: input.feeding};
}
