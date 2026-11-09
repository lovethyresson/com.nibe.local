/** Solar surplus for hot water: what is exported now, and what is expected to be exported per
 *  slot ahead. Pure: the fetching is in hotwater-shadow.ts. Design:
 *  docs/autopilot-hot-water.md §4.4.
 *
 *  Surplus is measured where it ends up, at the grid meter: what the house exports after its own
 *  use and after a home battery has taken its share. So the tank only ever gets what would
 *  otherwise have been sold. Planned surplus is learned the same way, from the grid meter's export
 *  over the last two weeks against the sun that was forecast for it, so it needs no panel size,
 *  orientation or inverter model. */

import {InsightsLog} from './hotwater-insights';

const HOUR = 3_600_000;
/** An hour counts as sunny from this much sun on the ground, W/m²: below it exports are noise or a
 *  battery selling, not the sun. */
export const SUNNY_GHI = 50;
/** Sunny hours needed before the fit is trusted: two weeks of winter has fewer, and then no
 *  surplus is planned, only the live reading counts. */
export const MIN_SUNNY_HOURS = 20;
/** Live readings averaged before a surplus counts (one a minute), so a passing cloud or a kettle
 *  does not start or skip a charge. */
export const LIVE_WINDOW = 10;
/** Readings within the window needed: a minute or two may fail to arrive. */
export const LIVE_MIN_READINGS = 8;

/** Open-Meteo's sun on the ground, hourly: the last two weeks for the fit, two days ahead for the
 *  plan. The location is rounded to 2 decimals (~1 km) before it leaves the Homey. */
export function irradianceUrl(latitude: number, longitude: number): string {
    const round = (v: number) => (Math.round(v * 100) / 100).toFixed(2);
    return 'https://api.open-meteo.com/v1/forecast'
        + `?latitude=${round(latitude)}&longitude=${round(longitude)}`
        + '&hourly=shortwave_radiation&models=metno_seamless'
        + '&past_days=14&forecast_days=2&timezone=GMT&timeformat=unixtime';
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

/** A cumulative kWh meter's Insights → hour start (ms) → kWh exported in that hour. Insights keeps
 *  bucket means, so the step between two consecutive means is the energy of one bucket. A meter
 *  reset or a gap gives a step that is not counted. */
export function hourlyExport(log: InsightsLog | undefined): Map<number, number> {
    const out = new Map<number, number>();
    const step = log?.step ?? 0;
    if (!(step > 0) || step > HOUR) return out;
    const points = (log?.values ?? [])
        .map(({t, v}) => ({t: Date.parse(t), v}))
        .filter((p): p is {t: number; v: number} => Number.isFinite(p.t) && typeof p.v === 'number' && Number.isFinite(p.v))
        .sort((a, b) => a.t - b.t);
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        if (b.t - a.t !== step || b.v < a.v) continue;
        const hour = Math.floor((a.t + step) / HOUR) * HOUR;
        out.set(hour, (out.get(hour) ?? 0) + (b.v - a.v));
    }
    return out;
}

/** Export, kW, against the sun on the ground: `a` kW per W/m², less what the house uses (`b` < 0
 *  in a house that uses some of its sun itself). */
export interface SurplusFit {
    a: number;
    b: number;
    hours: number;
}

/** Least squares over the sunny hours both maps have. Undefined when there are too few, or when
 *  more sun does not mean more export (no panels, or every kWh goes to a battery or the house). */
export function fitSurplus(ghi: Map<number, number>, exported: Map<number, number>): SurplusFit | undefined {
    const pairs: [number, number][] = [];
    for (const [hour, g] of ghi) {
        const e = exported.get(hour);
        if (g >= SUNNY_GHI && e !== undefined) pairs.push([g, e]);
    }
    if (pairs.length < MIN_SUNNY_HOURS) return undefined;
    const n = pairs.length;
    const mx = pairs.reduce((s, [x]) => s + x, 0) / n, my = pairs.reduce((s, [, y]) => s + y, 0) / n;
    const sxx = pairs.reduce((s, [x]) => s + (x - mx) ** 2, 0), sxy = pairs.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0);
    if (!(sxx > 0)) return undefined;
    const a = sxy / sxx;
    if (!(a > 0)) return undefined;
    return {a, b: my - a * mx, hours: n};
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

/** What is exported now that the sun made, W, from Homey Energy's live report: the grid meter's
 *  export, but never more than the generators produce, so a battery selling at night is not
 *  taken for sun. Undefined without a grid meter (no `totalCumulative`). */
export function liveSurplusW(report: any): number | undefined {
    const grid = report?.totalCumulative?.W;
    if (typeof grid !== 'number' || !Number.isFinite(grid)) return undefined;
    const generated = Math.abs(Number(report?.totalGenerated?.W) || 0);
    return Math.min(Math.max(0, -grid), generated);
}

/** The mean of the last `LIVE_WINDOW` minutes' readings, kW, or undefined while too few arrived. */
export function liveSurplusKw(readings: {at: number; w: number}[], now: number): number | undefined {
    const recent = readings.filter((r) => r.at > now - LIVE_WINDOW * 60_000 && r.at <= now);
    if (recent.length < LIVE_MIN_READINGS) return undefined;
    return recent.reduce((s, r) => s + r.w, 0) / recent.length / 1000;
}

/** The grid meter Homey Energy counts: of the devices that declare themselves cumulative with an
 *  export meter, the one whose power is closest to the live report's grid figure. A home can have
 *  two (a P1 dongle and a battery's own grid sensor) that measure the same connection, and adding
 *  them would count every exported kWh twice. */
export function gridMeter(devices: Record<string, any>, report: any): {id: string; exported: string} | undefined {
    const grid = Number(report?.totalCumulative?.W);
    let best: {id: string; exported: string; off: number} | undefined;
    for (const [id, d] of Object.entries(devices ?? {})) {
        const energy = d?.energyObj ?? d?.energy;
        const exported = energy?.cumulativeExportedCapability;
        if (!energy?.cumulative || typeof exported !== 'string') continue;
        const w = Number(energy?.W ?? d?.capabilitiesObj?.measure_power?.value);
        const off = Number.isFinite(grid) && Number.isFinite(w) ? Math.abs(w - grid) : Infinity;
        if (!best || off < best.off) best = {id, exported, off};
    }
    return best && {id: best.id, exported: best.exported};
}

/** Whether the home has a generator (solar) device at all: without one, export is a battery's. */
export function hasGenerator(devices: Record<string, any>): boolean {
    return Object.values(devices ?? {}).some((d) => (d?.energyObj ?? d?.energy)?.generator === true);
}
