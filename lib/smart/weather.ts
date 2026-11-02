/** Open-Meteo forecast → 15-minute UTC slots. Pure: the collector does the fetching.
 *  Design: docs/smart-heating-plan.md §5.3. Weather data by Open-Meteo.com (CC BY 4.0). */
import {SLOT_MS, slotOf} from './prices';
import {WALLS, sunPosition, wallIrradiance} from './solar';

export const WEATHER_STALE_MS = 24 * 60 * 60 * 1000;

export interface WeatherSlot {
    slot: number;
    /** Outdoor °C. */
    te: number;
    /** Irradiance on a south-facing wall, W/m² (Open-Meteo's own). */
    gtiS: number;
    /** East- and west-facing walls, W/m², computed in solar.ts. */
    gtiE: number;
    gtiW: number;
    /** Global horizontal irradiance, W/m². */
    ghi: number;
    /** Wind m/s, relative humidity %, cloud cover %. */
    wind: number;
    rh: number;
    cloud: number;
}

const HOURLY = ['temperature_2m', 'wind_speed_10m', 'relative_humidity_2m', 'cloud_cover',
    'shortwave_radiation', 'global_tilted_irradiance', 'direct_normal_irradiance', 'diffuse_radiation'];

/** The location is rounded to 2 decimals (~1 km) before it leaves the Homey. */
export function openMeteoUrl(latitude: number, longitude: number): string {
    const round = (v: number) => (Math.round(v * 100) / 100).toFixed(2);
    return 'https://api.open-meteo.com/v1/forecast'
        + `?latitude=${round(latitude)}&longitude=${round(longitude)}`
        + `&hourly=${HOURLY.join(',')}&tilt=90&azimuth=0&models=metno_seamless`
        + '&past_days=1&forecast_days=3&timezone=GMT&timeformat=unixtime&wind_speed_unit=ms';
}

/** Where the weather is for: the Homey's own location, else a place the owner searched for in
 *  Setup (app setting `smartLocation`). */
export interface Place {
    name: string;
    /** County and country, to tell two places of one name apart. */
    region: string;
    latitude: number;
    longitude: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Open-Meteo's place search. Only the typed name leaves the Homey. */
export function placeSearchUrl(query: string, language = 'en'): string {
    return 'https://geocoding-api.open-meteo.com/v1/search'
        + `?name=${encodeURIComponent(query.trim())}&count=8&language=${encodeURIComponent(language)}&format=json`;
}

/** Search results → places, coordinates rounded to 2 decimals (~1 km), as the forecast uses them. */
export function placesFrom(response: any): Place[] {
    const results: any[] = Array.isArray(response?.results) ? response.results : [];
    return results.filter((r) => typeof r?.name === 'string' && Number.isFinite(r.latitude) && Number.isFinite(r.longitude))
        .map((r) => ({name: r.name, region: [r.admin1, r.country].filter((x) => typeof x === 'string' && x).join(', '),
            latitude: round2(r.latitude), longitude: round2(r.longitude)}));
}

/** The Homey's location if it has one, else the chosen place, else none. */
export function weatherLocation(homey: any, chosen: any): {latitude: number; longitude: number; source: 'homey' | 'chosen'} | undefined {
    const valid = (v: any) => typeof v?.latitude === 'number' && typeof v?.longitude === 'number'
        && Math.abs(v.latitude) <= 90 && Math.abs(v.longitude) <= 180 && !(v.latitude === 0 && v.longitude === 0);
    if (valid(homey)) return {latitude: homey.latitude, longitude: homey.longitude, source: 'homey'};
    if (valid(chosen)) return {latitude: chosen.latitude, longitude: chosen.longitude, source: 'chosen'};
    return undefined;
}

/** Hourly values → slots. Temperature, wind and humidity are instants and are interpolated
 *  linearly. Radiation is Open-Meteo's mean over the *preceding* hour, so each slot in that hour
 *  takes it as is, but the walls' share of the direct beam is worked out for each slot's own
 *  midpoint, since the sun moves 4° an hour across an east or west wall. A missing value leaves
 *  the slot out rather than inventing one. The response's own coordinates place the sun. */
export function weatherSlots(response: any): WeatherSlot[] {
    const hourly = response?.hourly;
    const times: unknown[] = Array.isArray(hourly?.time) ? hourly.time : [];
    const series = (name: string): (number | null)[] => times.map((_, i) => {
        const v = hourly?.[name]?.[i];
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
    });
    const [te, wind, rh, cloud, ghi, gti, dni, dhi] = HOURLY.map(series);
    const latitude = Number(response?.latitude), longitude = Number(response?.longitude);
    const located = Number.isFinite(latitude) && Number.isFinite(longitude);
    const out: WeatherSlot[] = [];
    for (let i = 0; i + 1 < times.length; i++) {
        const t0 = Number(times[i]) * 1000, t1 = Number(times[i + 1]) * 1000;
        if (!Number.isFinite(t0) || t1 - t0 !== 4 * SLOT_MS) continue;
        for (let q = 0; q < 4; q++) {
            const f = q / 4;
            const lerp = (s: (number | null)[]) =>
                s[i] === null || s[i + 1] === null ? null : s[i]! + (s[i + 1]! - s[i]!) * f;
            // Radiation for [t0, t1) is reported at t1.
            const wall = (facing: number) => {
                if (!located || dni[i + 1] === null || dhi[i + 1] === null || ghi[i + 1] === null) return null;
                const sun = sunPosition(t0 + (q + 0.5) * SLOT_MS, latitude, longitude);
                return wallIrradiance(dni[i + 1]!, dhi[i + 1]!, ghi[i + 1]!, sun, facing);
            };
            const values = {te: lerp(te), wind: lerp(wind), rh: lerp(rh), cloud: lerp(cloud),
                ghi: ghi[i + 1], gtiS: gti[i + 1], gtiE: wall(WALLS.east), gtiW: wall(WALLS.west)};
            if (Object.values(values).some((v) => v === null)) continue;
            out.push({slot: slotOf(t0) + q, ...values} as WeatherSlot);
        }
    }
    return out;
}
