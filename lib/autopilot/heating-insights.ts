/** Autopilot heating's starting history: the app's own Homey Insights, read once per Heating
 *  device through `homey-api` (`homey:manager:api`) and resampled to the 15-minute slots the
 *  house model learns from. An owner who had the app before turning Autopilot on gets a fit on
 *  the first day instead of after five days of "learning". Pure apart from `fetchHeatingInsights`.
 *  Design: docs/autopilot-plan.md §5.4. */
import {FIELDS, FLAG, Field, History} from './history';
import {InsightsLog} from './hotwater-insights';
import {SLOT_MS} from './prices';
import {outdoorSourceCode} from './outdoor';
import {WeatherSlot} from './weather';

const HOUR = 60 * 60 * 1000;

/** Finest first. `last24Hours` has 5-minute buckets, `last14Days` hourly ones (`last7Days` is
 *  hourly too, so it adds nothing). Coarser resolutions are not read: a 6-hour mean says nothing
 *  about how fast the house moves, and two weeks of slots the model can't use would only widen
 *  its parameter uncertainty while it predicts through them (model.ts `ekfStep`). */
export const BACKFILL_RESOLUTIONS = ['last24Hours', 'last14Days'] as const;
/** A bucket longer than this is dropped whatever resolution it came from. */
export const MAX_STEP_MS = HOUR;

/** Means over the slot. `sensor` is the owner's outdoor sensor, `bt1` input 1. */
const MEANS = ['ti', 'bt1', 'sensor', 'tsup', 'tret', 'tcalc', 'tbrine', 'hz', 'dm', 'pw'] as const;
/** Counters: their value at the slot's end. */
const COUNTERS = ['qmeter', 'emeter'] as const;
/** Settings: the value in force at the slot's end, held, never interpolated. */
const SETTINGS = ['hcurve', 'hoffset', 'supmin', 'supmax', 'tset', 'roomctl'] as const;

export type BackfillField = typeof MEANS[number] | typeof COUNTERS[number] | typeof SETTINGS[number];
export const BACKFILL_FIELDS: readonly BackfillField[] = [...MEANS, ...COUNTERS, ...SETTINGS];

/** One log per resolution, finest first, per field. */
export type BackfillLogs = Partial<Record<BackfillField, InsightsLog[]>>;

interface Bucket {
    /** Middle of the bucket, ms: a mean stands for that moment. */
    c: number;
    start: number;
    step: number;
    v: number;
}

/** A log's buckets in time order. Booleans count as 0/1. A log without `step` takes the shortest
 *  gap between its buckets; one longer than `MAX_STEP_MS` is dropped. */
export function bucketsOf(log: InsightsLog | undefined): Bucket[] {
    const raw = (log?.values ?? []).map(({t, v}) => ({t: Date.parse(t), v: typeof v === 'boolean' ? Number(v) : v}))
        .filter((p): p is {t: number; v: number} => Number.isFinite(p.t) && typeof p.v === 'number' && Number.isFinite(p.v))
        .sort((a, b) => a.t - b.t);
    let step = log?.step ?? 0;
    if (!(step > 0)) for (let i = 1; i < raw.length; i++) {
        const gap = raw[i].t - raw[i - 1].t;
        if (gap > 0 && (!(step > 0) || gap < step)) step = gap;
    }
    if (!(step > 0) || step > MAX_STEP_MS) return [];
    return raw.map((p) => ({c: p.t + step / 2, start: p.t, step, v: p.v}));
}

/** Index of the last bucket whose middle is at or before `t`, or -1. */
function lastAtOrBefore(buckets: Bucket[], t: number): number {
    let lo = 0, hi = buckets.length - 1, found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (buckets[mid].c <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
}

/** Straight line between the two neighbouring buckets around `t`, never across a missing one. */
function between(buckets: Bucket[], t: number): number | undefined {
    const i = lastAtOrBefore(buckets, t);
    if (i < 0) return undefined;
    const a = buckets[i];
    if (a.c === t) return a.v;
    const b = buckets[i + 1];
    if (!b || b.c - a.c > 1.5 * a.step) return undefined;
    return a.v + (b.v - a.v) * (t - a.c) / (b.c - a.c);
}

interface Read {
    v: number;
    /** The bucket length it came from; longer than a slot means interpolated. */
    step: number;
}

/** A slot mean: the buckets inside the slot when they are a slot or shorter (measured), else
 *  the line between the hourly means around the slot's middle (interpolated). */
function meanIn(resolutions: Bucket[][], start: number): Read | undefined {
    for (const buckets of resolutions) {
        if (!buckets.length) continue;
        const step = buckets[0].step;
        if (step <= SLOT_MS) {
            const inside = buckets.filter((b) => b.c >= start && b.c < start + SLOT_MS);
            if (inside.length) return {v: inside.reduce((a, b) => a + b.v, 0) / inside.length, step};
        } else {
            const v = between(buckets, start + SLOT_MS / 2);
            if (v !== undefined) return {v, step};
        }
    }
    return undefined;
}

/** A counter at the slot's end: a bucket mean of a steadily rising counter is its value at the
 *  bucket's middle, so the line between two middles is the counter in between. */
function counterAt(resolutions: Bucket[][], end: number): Read | undefined {
    for (const buckets of resolutions) {
        const v = between(buckets, end);
        if (v !== undefined) return {v, step: buckets[0].step};
    }
    return undefined;
}

/** A setting in force just before the slot's end: the bucket holding that moment. */
function settingAt(resolutions: Bucket[][], end: number): number | undefined {
    for (const buckets of resolutions) {
        const b = buckets.find((x) => x.start <= end - 1 && end - 1 < x.start + x.step);
        if (b) return b.v;
    }
    return undefined;
}

export interface BackfillSlot {
    slot: number;
    values: Record<Field, number>;
}

/** Insights → history slots in `[from, until)`, each flagged `backfill`, and `hourly` when any
 *  mean or counter in it was interpolated from buckets longer than a slot. Outdoor follows the
 *  collector's own order (outdoor.ts `recordedOutdoor`): the owner's sensor (`sensorId` its
 *  device/capability, so `tesrc` matches what the collector records for it), else input 1 as the
 *  wired sensor. Input 1 is taken as unfed: these slots come before the app collected anything,
 *  so the app never fed BT1 in them. A slot with neither indoor nor outdoor is left out. */
export function slotsFromInsights(logs: BackfillLogs, from: number, until: number, sensorId?: string): BackfillSlot[] {
    const series = Object.fromEntries(BACKFILL_FIELDS.map((f) => [f, (logs[f] ?? []).map(bucketsOf)])) as Record<BackfillField, Bucket[][]>;
    const out: BackfillSlot[] = [];
    for (let slot = from; slot < until; slot++) {
        const start = slot * SLOT_MS, end = start + SLOT_MS;
        const values = Object.fromEntries(FIELDS.map((f) => [f, NaN])) as Record<Field, number>;
        let step = 0;
        const read: Partial<Record<BackfillField, number>> = {};
        for (const f of MEANS) {
            const r = meanIn(series[f], start);
            if (r) { read[f] = r.v; step = Math.max(step, r.step); }
        }
        for (const f of COUNTERS) {
            const r = counterAt(series[f], end);
            if (r) { read[f] = r.v; step = Math.max(step, r.step); }
        }
        for (const f of SETTINGS) {
            const v = settingAt(series[f], end);
            if (v !== undefined) read[f] = v;
        }
        const ti = read.ti ?? NaN, bt1 = read.bt1 ?? NaN, sensor = read.sensor ?? NaN;
        if (!Number.isFinite(ti) && !Number.isFinite(bt1) && !Number.isFinite(sensor)) continue;
        for (const f of [...MEANS, ...COUNTERS, ...SETTINGS]) {
            if (f === 'bt1' || f === 'sensor' || read[f] === undefined) continue;
            values[f as Field] = read[f]!;
        }
        values.bt1 = bt1;
        let flags: number = FLAG.backfill;
        if (Number.isFinite(sensor)) {
            values.te = sensor;
            values.tesrc = outdoorSourceCode('sensor', sensorId);
            flags |= FLAG.sensorOutdoor;
        } else if (Number.isFinite(bt1)) {
            values.te = bt1;
            values.tesrc = outdoorSourceCode('wired');
        }
        if (step > SLOT_MS) flags |= FLAG.hourly;
        values.flags = flags;
        // Not polls: a backfilled slot has no coverage to report.
        values.coverage = NaN;
        out.push({slot, values});
    }
    return out;
}

/** Weather for backfilled slots, from Open-Meteo's recent past: the sun on each wall is what
 *  separates sun from heat loss, and without it every backfilled day reads as overcast. A slot
 *  with no outdoor reading at all takes the forecast's temperature, corrected as the collector
 *  corrects it live (`correction`), and is flagged so. */
export function withWeather(slots: BackfillSlot[], weather: Map<number, WeatherSlot>,
                            correction: (slot: number) => number = () => 0): BackfillSlot[] {
    return slots.map(({slot, values}) => {
        const w = weather.get(slot);
        if (!w) return {slot, values};
        const v = {...values, gtiS: w.gtiS, gtiE: w.gtiE, gtiW: w.gtiW, ghi: w.ghi, wind: w.wind, rh: w.rh, cloud: w.cloud};
        if (!Number.isFinite(v.te) && Number.isFinite(w.te)) {
            v.te = w.te + correction(slot);
            v.tesrc = outdoorSourceCode('forecast');
            v.flags |= FLAG.forecastOutdoor;
        }
        return {slot, values: v};
    });
}

/** The slots a backfill may fill: everything before the first stored slot (or the open slot
 *  `now`, when nothing is stored) that still fits the ring behind the newest one, so a
 *  backfilled slot can never land on a measured slot's place. Undefined when there is none. */
export function backfillWindow(history: History, now: number): {from: number; until: number} | undefined {
    const range = history.range();
    const until = Math.min(range[0] ?? now, now);
    const from = Math.max(1, (range[range.length - 1] ?? now) - history.capacity + 1);
    return from < until ? {from, until} : undefined;
}

/** Puts the slots that still fall in the window (it is read again here: polling went on while
 *  Insights was read) and returns how many went in. A measured slot is never replaced. */
export function insertBackfill(history: History, slots: BackfillSlot[], now: number): number {
    const window = backfillWindow(history, now);
    if (!window) return 0;
    let put = 0;
    for (const {slot, values} of slots) {
        if (slot < window.from || slot >= window.until || history.get(slot)) continue;
        history.put(slot, values);
        put++;
    }
    return put;
}

/** Where each field's log lives: a capability id on a Homey device. */
export interface LogSource {
    deviceId: string;
    capabilityId: string;
}

/** The Homey device for each field's capability. The Heating device first; another device of
 *  the same pump only for a capability named after its register (`meter_kwh_NIBE.i1577_…`), which
 *  means the same reading wherever it sits. A plain `measure_temperature` on Hot water is the tank,
 *  not the room. With no device carrying it, Heating is asked anyway: a log outlives its
 *  capability. `sensor` is the owner's outdoor sensor, on whatever device it is. */
export function backfillSources(devices: Record<string, any>, ownId: string, pumpIds: string[],
                                capabilities: Partial<Record<BackfillField, string>>,
                                sensor?: LogSource): Partial<Record<BackfillField, LogSource>> {
    const carries = (id: string, cap: string) => Array.isArray(devices?.[id]?.capabilities) && devices[id].capabilities.includes(cap);
    const out: Partial<Record<BackfillField, LogSource>> = {};
    for (const [field, cap] of Object.entries(capabilities) as [BackfillField, string][]) {
        if (!cap || field === 'sensor') continue;
        const other = cap.includes('.') ? pumpIds.find((id) => id !== ownId && carries(id, cap)) : undefined;
        out[field] = {deviceId: carries(ownId, cap) || !other ? ownId : other, capabilityId: cap};
    }
    if (sensor?.deviceId && sensor.capabilityId) out.sensor = sensor;
    return out;
}

/** Every resolution of every field's log. A missing or failing log is left out; a refusal for
 *  asking too fast is retried once after a longer wait. `pause` runs between requests: the Homey
 *  rate-limits Insights (§5.4). */
export async function fetchHeatingInsights(api: any, sources: Partial<Record<BackfillField, LogSource>>,
                                           pause: (ms: number) => Promise<void> = async () => {}): Promise<BackfillLogs> {
    const logs: BackfillLogs = {};
    for (const [field, source] of Object.entries(sources) as [BackfillField, LogSource][]) {
        const uri = `homey:device:${source.deviceId}`;
        logs[field] = [];
        for (const resolution of BACKFILL_RESOLUTIONS) {
            const get = () => api.insights.getLogEntries({uri, id: `${uri}:${source.capabilityId}`, resolution, $timeout: 20_000});
            const log = await get().catch(async (error: any) => {
                if (!/too many/i.test(String(error?.message ?? error))) return undefined;
                await pause(20_000);
                return get().catch(() => undefined);
            });
            logs[field]!.push(log ?? {});
            await pause(2_000);
        }
    }
    return logs;
}

/** Whether any request came back: when none did, Insights could not be read at all (a refusal,
 *  a timeout), which is worth another try, unlike logs that exist but hold nothing yet. */
export function anyLogRead(logs: BackfillLogs): boolean {
    return Object.values(logs).some((perResolution) => perResolution?.some((log) => Array.isArray(log.values)));
}

/** Days of slots a backfill put in, for the log and the stored marker. */
export function backfillSummary(slots: BackfillSlot[]): {slots: number; hourly: number; days: number} {
    const hourly = slots.filter((s) => s.values.flags & FLAG.hourly).length;
    return {slots: slots.length, hourly, days: Math.round(slots.length / 96 * 10) / 10};
}
