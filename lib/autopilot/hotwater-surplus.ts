/** Solar surplus for hot water: what is exported now, and what is expected to be exported per
 *  slot ahead. Pure: the fetching is in hotwater-shadow.ts. Design:
 *  docs/autopilot-hot-water.md §4.4.
 *
 *  Surplus is measured where it ends up, at the grid meter: what the house exports after its own
 *  use and after a home battery has taken its share. So the tank only ever gets what would
 *  otherwise have been sold. Planned surplus is learned the same way, from the grid meter's export
 *  over the last three months against the sun that was forecast for it, so it needs no panel size,
 *  orientation or inverter model. */

import {InsightsLog} from './hotwater-insights';

const HOUR = 3_600_000;
/** An hour counts as sunny from this much sun on the ground, W/m²: below it exports are noise or a
 *  battery selling, not the sun. */
export const SUNNY_GHI = 50;
/** Sunny hours needed before the fit is trusted. Three months back nearly always has them; a meter
 *  added to Homey in winter may not, and then no surplus is planned, only the live reading counts. */
export const MIN_SUNNY_HOURS = 20;
/** Older hours count less in the fit, halving every this many days: low winter sun lands on tilted
 *  panels differently from summer sun, so last week says more about tomorrow than August does. */
export const FIT_HALF_LIFE_DAYS = 30;
/** Live readings averaged before a surplus counts (one a minute), so a passing cloud or a kettle
 *  does not start or skip a charge. */
export const LIVE_WINDOW = 10;
/** Readings within the window needed: a minute or two may fail to arrive. */
export const LIVE_MIN_READINGS = 8;

/** Open-Meteo's sun on the ground, hourly: the last three months for the fit (Insights keeps the
 *  meter that long), two days ahead for the plan. The location is rounded to 2 decimals (~1 km) before it leaves the Homey. */
export function irradianceUrl(latitude: number, longitude: number): string {
    const round = (v: number) => (Math.round(v * 100) / 100).toFixed(2);
    return 'https://api.open-meteo.com/v1/forecast'
        + `?latitude=${round(latitude)}&longitude=${round(longitude)}`
        + '&hourly=shortwave_radiation&models=metno_seamless'
        + '&past_days=92&forecast_days=2&timezone=GMT&timeformat=unixtime';
}

/** Hour start (ms) → mean W/m² over that hour. Open-Meteo reports radiation at the hour's end. */
export function hourlyGhi(response: any): Map<number, number> {
    const times: unknown[] = Array.isArray(response?.hourly?.time) ? response.hourly.time : [];
    const values: unknown[] = Array.isArray(response?.hourly?.shortwave_radiation) ? response.hourly.shortwave_radiation : [];
    const out = new Map<number, number>();
    times.forEach((t, i) => {
        const end = Number(t) * 1000, v = values[i];
        if (Number.isFinite(end) && typeof v === 'number' && Number.isFinite(v)) out.set(end - HOUR, Math.max(0, v));
    });
    return out;
}

/** Energy exported over a whole number of hours from `start` (ms). */
export interface ExportBucket {
    start: number;
    hours: number;
    kwh: number;
}

/** A cumulative kWh meter's Insights → the energy of each bucket. Insights keeps bucket means, so
 *  the step between two consecutive means is the energy of one bucket, centred half a bucket later.
 *  A meter reset or a gap gives a step that is not counted. Hourly buckets reach 14 days back,
 *  coarser ones (several hours) about three months. */
export function exportBuckets(log: InsightsLog | undefined): ExportBucket[] {
    const step = log?.step ?? 0;
    if (!(step > 0) || (step > HOUR && step % HOUR) || (step < HOUR && HOUR % step)) return [];
    const points = (log?.values ?? [])
        .map(({t, v}) => ({t: Date.parse(t), v}))
        .filter((p): p is {t: number; v: number} => Number.isFinite(p.t) && typeof p.v === 'number' && Number.isFinite(p.v))
        .sort((a, b) => a.t - b.t);
    const out: ExportBucket[] = [];
    const hourly = new Map<number, number>();
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        if (b.t - a.t !== step || b.v < a.v) continue;
        if (step <= HOUR) {
            // Finer than an hour: summed into the hour it falls in.
            const hour = Math.floor((a.t + step) / HOUR) * HOUR;
            hourly.set(hour, (hourly.get(hour) ?? 0) + (b.v - a.v));
        } else out.push({start: Math.floor((a.t + step / 2 + HOUR / 2) / HOUR) * HOUR, hours: step / HOUR, kwh: b.v - a.v});
    }
    for (const [start, kwh] of hourly) out.push({start, hours: 1, kwh});
    return out.sort((a, b) => a.start - b.start);
}

/** Buckets from several resolutions of one log, finest first: a coarser bucket is kept only where
 *  no finer one covers its time. */
export function mergeBuckets(resolutions: ExportBucket[][]): ExportBucket[] {
    const out: ExportBucket[] = [];
    let coveredFrom = Infinity;
    for (const buckets of resolutions) {
        const kept = buckets.filter((b) => b.start + b.hours * HOUR <= coveredFrom);
        out.push(...kept);
        if (kept.length) coveredFrom = Math.min(coveredFrom, ...kept.map((b) => b.start));
    }
    return out.sort((a, b) => a.start - b.start);
}

/** Hour start (ms) → kWh exported in that hour, from the hourly buckets. */
export function hourlyExport(log: InsightsLog | undefined): Map<number, number> {
    return new Map(exportBuckets(log).filter((b) => b.hours === 1).map((b) => [b.start, b.kwh]));
}

/** The most exported in one hour, kW, or undefined without hourly data: the evidence setup shows. */
export function peakExportKw(buckets: ExportBucket[]): number | undefined {
    const hourly = buckets.filter((b) => b.hours === 1).map((b) => b.kwh);
    return hourly.length ? Math.max(...hourly) : undefined;
}

/** Export, kW, against the sun on the ground: `a` kW per W/m², less what the house uses (`b` < 0
 *  in a house that uses some of its sun itself). */
export interface SurplusFit {
    a: number;
    b: number;
    hours: number;
}

/** Weighted least squares of export against sun, export = a × sun + b per hour, over the buckets
 *  whose every hour had sun (an hourly bucket is one hour; a 6-hour bucket counts only on a day
 *  sunny all through it, so night export, a battery selling, never enters). Older buckets weigh
 *  less (`FIT_HALF_LIFE_DAYS`). Undefined when there are too few sunny hours, or when more sun does
 *  not mean more export (no panels, or every kWh goes to a battery or the house). */
export function fitSurplus(ghi: Map<number, number>, buckets: ExportBucket[], now = Date.now()): SurplusFit | undefined {
    let sxx = 0, sxn = 0, snn = 0, sxy = 0, sny = 0, hours = 0;
    for (const bucket of buckets) {
        let x = 0;
        let sunny = true;
        for (let h = 0; h < bucket.hours && sunny; h++) {
            const g = ghi.get(bucket.start + h * HOUR);
            if (g === undefined || g < SUNNY_GHI) sunny = false;
            else x += g;
        }
        if (!sunny) continue;
        const n = bucket.hours, y = bucket.kwh;
        const w = 0.5 ** (Math.max(0, now - bucket.start) / (FIT_HALF_LIFE_DAYS * 24 * HOUR));
        sxx += w * x * x; sxn += w * x * n; snn += w * n * n; sxy += w * x * y; sny += w * n * y;
        hours += n;
    }
    if (hours < MIN_SUNNY_HOURS) return undefined;
    const det = sxx * snn - sxn * sxn;
    if (!(det > 1e-9 * sxx * snn)) return undefined;
    const a = (sxy * snn - sxn * sny) / det;
    if (!(a > 0)) return undefined;
    return {a, b: (sxx * sny - sxn * sxy) / det, hours};
}

/** Whether the forecast has sun at `ms`: only then is live export the sun's. With none, export is a
 *  battery selling, and it is not surplus. Needs only the grid meter and the weather already
 *  fetched, no battery or inverter device (maintainer, 2026-11-14). */
export function sunNow(ghi: Map<number, number>, ms: number): boolean {
    const g = ghi.get(Math.floor(ms / HOUR) * HOUR);
    return g !== undefined && g >= SUNNY_GHI;
}

/** Expected export per slot, kW: the hour's forecast sun through the fit; 0 where there is no sun
 *  forecast or no fit. */
export function surplusForecast(fit: SurplusFit | undefined, ghi: Map<number, number>, slotStarts: number[]): number[] {
    return slotStarts.map((ms) => {
        const g = ghi.get(Math.floor(ms / HOUR) * HOUR);
        if (!fit || g === undefined || g < SUNNY_GHI) return 0;
        return Math.max(0, fit.a * g + fit.b);
    });
}

/** What is exported now, W, from Homey Energy's live report: the grid meter's export and nothing
 *  else. What an inverter makes says nothing about what is left: a battery, the house or a car can
 *  take all of it (maintainer, 2026-11-14). Undefined without a grid meter (no `totalCumulative`). */
export function liveSurplusW(report: any): number | undefined {
    const grid = report?.totalCumulative?.W;
    if (typeof grid !== 'number' || !Number.isFinite(grid)) return undefined;
    return Math.max(0, -grid);
}

/** The mean of the last `LIVE_WINDOW` minutes' readings, kW, or undefined while too few arrived. */
export function liveSurplusKw(readings: {at: number; w: number}[], now: number): number | undefined {
    const recent = readings.filter((r) => r.at > now - LIVE_WINDOW * 60_000 && r.at <= now);
    if (recent.length < LIVE_MIN_READINGS) return undefined;
    return recent.reduce((s, r) => s + r.w, 0) / recent.length / 1000;
}

/** The grid meters Homey Energy can count: devices that declare themselves cumulative with an
 *  export meter, closest to the live report's grid figure first. A home can have two (a P1 dongle
 *  and a battery's own grid sensor) that measure the same connection, and adding them would count
 *  every exported kWh twice, so only one is ever used. */
export function gridMeters(devices: Record<string, any>, report: any): {id: string; name: string; exported: string; w?: number}[] {
    const grid = Number(report?.totalCumulative?.W);
    return Object.entries(devices ?? {}).flatMap(([id, d]) => {
        const energy = d?.energyObj ?? d?.energy;
        const exported = energy?.cumulativeExportedCapability;
        if (!energy?.cumulative || typeof exported !== 'string') return [];
        const w = Number(energy?.W ?? d?.capabilitiesObj?.measure_power?.value);
        return [{id, name: String(d?.name ?? id), exported, w: Number.isFinite(w) ? w : undefined,
            off: Number.isFinite(grid) && Number.isFinite(w) ? Math.abs(w - grid) : Infinity}];
    }).sort((a, b) => a.off - b.off).map(({off, ...meter}) => meter);
}

/** The grid meter surplus reads: the owner's choice from setup while it still qualifies, else the
 *  one closest to Homey Energy's own grid figure. */
export function gridMeter(devices: Record<string, any>, report: any, preferred?: string): {id: string; exported: string} | undefined {
    const meters = gridMeters(devices, report);
    const meter = meters.find((m) => m.id === preferred) ?? meters[0];
    return meter && {id: meter.id, exported: meter.exported};
}

/** Devices Homey Energy counts as making power (solar inverters). Never used to decide surplus,
 *  which is the grid meter's alone; setup shows them so the owner sees their panels were found. */
export function solarDevices(devices: Record<string, any>): {id: string; name: string; w?: number}[] {
    return Object.entries(devices ?? {}).flatMap(([id, d]) => {
        if ((d?.energyObj ?? d?.energy)?.generator !== true) return [];
        const w = Number(d?.capabilitiesObj?.measure_power?.value ?? (d?.energyObj ?? d?.energy)?.W);
        return [{id, name: String(d?.name ?? id), w: Number.isFinite(w) ? Math.abs(w) : undefined}];
    });
}
