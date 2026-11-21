/** The heating season where the heat pump is: heating degree-days per day for each month, from the
 *  last three full years of daily mean outdoor temperature at the Homey's location (Open-Meteo's
 *  weather archive). It weights the rest of the year in the heating savings estimate, so a winter
 *  pace is not projected over the summer, for any owner's climate. Pure; the fetch is the weather
 *  book's (gateway-weather.ts). */

/** Full calendar years of history the curve is the mean of. */
export const SEASON_YEARS = 3;
/** Above this outdoor temperature a house needs no heat, when the heat pump's own "stop heating"
 *  temperature (register 184) can't be read. */
export const DEFAULT_BASE_C = 17;

/** Open-Meteo's archive URL for the last `SEASON_YEARS` full years before `today` (YYYY-MM-DD). */
export function seasonUrl(latitude: number, longitude: number, today: string): string {
    const round = (v: number) => (Math.round(v * 100) / 100).toFixed(2);
    const last = Number(today.slice(0, 4)) - 1;
    return 'https://archive-api.open-meteo.com/v1/archive'
        + `?latitude=${round(latitude)}&longitude=${round(longitude)}`
        + `&start_date=${last - SEASON_YEARS + 1}-01-01&end_date=${last}-12-31`
        + '&daily=temperature_2m_mean&timezone=auto';
}

/** Date → daily mean temperature, from the archive's answer; days without a value left out. */
export function dailyMeans(response: any): Map<string, number> {
    const time = response?.daily?.time, mean = response?.daily?.temperature_2m_mean;
    const out = new Map<string, number>();
    if (!Array.isArray(time) || !Array.isArray(mean)) return out;
    time.forEach((date: unknown, k: number) => {
        const v = mean[k];
        if (typeof date === 'string' && typeof v === 'number' && Number.isFinite(v)) out.set(date, v);
    });
    return out;
}

/** Heating degree-days per day for each month (index 0 = January): the mean over the days of that
 *  month in the history of max(0, base − mean). Undefined unless every month has at least 20 days. */
export function seasonCurve(daily: Map<string, number>, baseC: number): number[] | undefined {
    const sum = new Array(12).fill(0), n = new Array(12).fill(0);
    for (const [date, mean] of daily) {
        const m = Number(date.slice(5, 7)) - 1;
        if (!(m >= 0 && m < 12)) continue;
        sum[m] += Math.max(0, baseC - mean);
        n[m]++;
    }
    if (n.some((c) => c < 20)) return undefined;
    return sum.map((s, m) => Math.round(s / n[m] * 1000) / 1000);
}
