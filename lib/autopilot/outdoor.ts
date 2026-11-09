/** The real outdoor temperature, which input 1 stops showing once the app feeds BT1. Pure.
 *  Design: docs/autopilot-plan.md §4.2. M0.3 found no physical-BT1 copy while feeding, so
 *  the sources are, in order: the Homey sensor the owner picked, the wired sensor (only while
 *  not feeding), and the forecast corrected by what the real readings taught it. */

export type OutdoorSource = 'wired' | 'sensor' | 'forecast';

/** After this long on the forecast alone, stop feeding so the wired sensor takes over. */
export const DEGRADED_LIMIT_MS = 6 * 60 * 60 * 1000;
/** EMA weight once an hour has enough samples; the first ones are a plain mean. */
const BIAS_ALPHA = 0.05;

/** `real − forecast` per local hour of day: the forecast grid point is not the owner's wall. */
export interface ForecastBias {
    mean: number[];
    count: number[];
}

export function newForecastBias(): ForecastBias {
    return {mean: new Array(24).fill(0), count: new Array(24).fill(0)};
}

/** Learn from one slot with a real reading: the owner's sensor, or input 1 while not fed. */
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
    if (finite(input.sensor)) return {value: input.sensor, source: 'sensor', goNeutral: false};
    if (!input.feeding && finite(input.wired)) return {value: input.wired, source: 'wired', goNeutral: false};
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

/** Input 1 further than this from what the wired sensor is expected to read is a fed BT1, not
 *  the weather: a probe, a Flow card, another app. Unfed, the S1155's input 1 stays within 2.1 K
 *  of the expectation (`wiredExpected`); a fed offset worth testing is ≥ 5 K. */
export const FED_OUTDOOR_K = 3;

/** The wired BT1 against the owner's sensor (S1155, 2026-11-04…07): the sensor through a
 *  first-order lag of ~5.5 h, plus a fixed offset (+2.3 K there: a wall-mounted sensor reads
 *  warm). Compared with the sensor directly, input 1 lagged by up to 6 K on a falling evening,
 *  which flagged most cold nights as fed. */
export const WIRED_TAU_H = 5.5;
/** The offset is the median over this many recent slots, robust to the odd fed stretch. */
const WIRED_OFFSET_SLOTS = 7 * 96;

export interface WiredModel {
    /** The reference outdoor temperature through the wired sensor's lag, at the last slot. */
    lag: number;
    /** Median of input 1 minus `lag`, K. */
    offset: number;
}

/** Steps the lag over slots of reference outdoor `te` and input 1 `bt1`, oldest first, by the
 *  time since the previous row (`slot` numbers; consecutive when absent). A missing `te`, or a
 *  gap longer than the lag itself, restarts it. Undefined until a lag and an offset exist. */
export function wiredModel(rows: {slot?: number; te: number; bt1: number}[], slotH = 0.25, tauH = WIRED_TAU_H): WiredModel | undefined {
    let lag: number | undefined;
    let last: number | undefined;
    const diffs: number[] = [];
    rows.forEach((r, i) => {
        const slot = r.slot ?? i;
        const steps = last === undefined ? 1 : slot - last;
        last = slot;
        if (!Number.isFinite(r.te) || steps * slotH > tauH) lag = undefined;
        if (!Number.isFinite(r.te)) return;
        lag = lag === undefined ? r.te : r.te + (lag - r.te) * Math.exp(-steps * slotH / tauH);
        if (Number.isFinite(r.bt1)) diffs.push(r.bt1 - lag);
    });
    if (lag === undefined || diffs.length === 0) return undefined;
    const recent = diffs.slice(-WIRED_OFFSET_SLOTS).sort((x, y) => x - y);
    return {lag, offset: recent[recent.length >> 1]};
}

/** What input 1 should read this slot when nothing feeds it, from the model after the previous
 *  slot and this slot's reference outdoor temperature. */
export function wiredExpected(model: WiredModel, te: number, slotH = 0.25, tauH = WIRED_TAU_H): number {
    return te + (model.lag - te) * Math.exp(-slotH / tauH) + model.offset;
}

export interface RecordedOutdoor {
    value: number;
    source: 'sensor' | 'wired' | 'forecast' | 'none';
    /** Input 1 disagreed with the reference: BT1 was fed from elsewhere. */
    fed: boolean;
}

/** What a history slot records as outdoor: the owner's sensor, else the pump's wired reading
 *  unless it was fed, else the corrected forecast. `sensor` and `forecast` are slot means. With a
 *  `model` of the wired sensor, fed is judged against what it should read (`wiredExpected`);
 *  without one, against the reference itself. */
export function recordedOutdoor(wired: number, sensor?: number, forecast?: number, model?: WiredModel): RecordedOutdoor {
    const finite = (v?: number): v is number => typeof v === 'number' && Number.isFinite(v);
    const reference = finite(sensor) ? sensor : forecast;
    const expected = finite(reference) && model ? wiredExpected(model, reference) : reference;
    const fed = finite(wired) && finite(expected) && Math.abs(wired - expected) > FED_OUTDOOR_K;
    if (finite(sensor)) return {value: sensor, source: 'sensor', fed};
    if (finite(wired) && !fed) return {value: wired, source: 'wired', fed};
    if (finite(forecast)) return {value: forecast, source: 'forecast', fed};
    return {value: NaN, source: 'none', fed};
}

/** A sensor reading fit to stand for outdoor: present, recent, and in an outdoor range. A
 *  capability timestamp is the last *change*, and outdoor air changes by 0.1 K within the hour. */
export const SENSOR_STALE_MS = 2 * 60 * 60 * 1000;
export function usableSensor(r: {value: number | null; available: boolean; updatedAt: number | null} | undefined,
                             now: number): number | undefined {
    if (!r || !r.available || typeof r.value !== 'number' || !Number.isFinite(r.value)) return undefined;
    if (r.value < -50 || r.value > 50) return undefined;
    if (r.updatedAt !== null && now - r.updatedAt > SENSOR_STALE_MS) return undefined;
    return r.value;
}

/** Which outdoor source a history slot's `te` came from, as one number the history can hold
 *  (field `tesrc`). The house model learns its heat loss and gains against one source: the Hue
 *  sensor read 2.4 K below the wired BT1 at night and 1.1 K above it in morning sun, so a fit
 *  across the switch learned a different house (todo.md, 2026-11-09). A sensor is told apart by
 *  a hash of its device and capability, so picking another sensor counts as a change too. */
export const SOURCE_CODE = {wired: 1, forecast: 2, sensorUnknown: 3} as const;
const SENSOR_BASE = 1000;

/** FNV-1a, folded below 2^23 so the code stays exact in a Float32. */
function sensorHash(id: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
    return h % 0x7fff00;
}

export function outdoorSourceCode(source: RecordedOutdoor['source'], sensorId?: string): number {
    if (source === 'wired') return SOURCE_CODE.wired;
    if (source === 'forecast') return SOURCE_CODE.forecast;
    if (source === 'sensor') return sensorId ? SENSOR_BASE + sensorHash(sensorId) : SOURCE_CODE.sensorUnknown;
    return NaN;
}

export type SourceKind = 'wired' | 'sensor' | 'other';

export function sourceKind(code: number): SourceKind {
    if (code === SOURCE_CODE.wired) return 'wired';
    if (code === SOURCE_CODE.sensorUnknown || code >= SENSOR_BASE) return 'sensor';
    return 'other';
}

/** A source has to hold this long before it counts as a change: the wired BT1 standing in for a
 *  sensor that missed a slot or three (2026-11-03, 11-07) is a fallback, not a new source. */
export const SOURCE_CHANGE_SLOTS = 16;

const sameSource = (a: number, b: number) => sourceKind(a) === sourceKind(b)
    && (sourceKind(a) === 'wired' || a === b || a === SOURCE_CODE.sensorUnknown || b === SOURCE_CODE.sensorUnknown);

/** Index into `codes` (oldest first) where the current outdoor source began: where the last
 *  change between the wired BT1, one sensor and another started, once the new source had held
 *  for `SOURCE_CHANGE_SLOTS`. The forecast and missing slots are fallbacks within a run, not a
 *  change: the forecast is corrected toward whichever source is real. A sensor of unknown
 *  identity (slots from before `tesrc` was recorded) matches the next known one, since nothing
 *  recorded a switch. */
export function currentSourceStart(codes: number[]): number {
    let start = 0;
    let current: number | undefined;
    let candidate: {code: number; at: number; held: number} | undefined;
    codes.forEach((code, i) => {
        if (sourceKind(code) === 'other') return;
        if (current === undefined || sameSource(code, current)) {
            if (current === undefined || current === SOURCE_CODE.sensorUnknown) current = code;
            candidate = undefined;
            return;
        }
        if (!candidate || !sameSource(code, candidate.code)) candidate = {code, at: i, held: 0};
        if (candidate.code === SOURCE_CODE.sensorUnknown) candidate.code = code;
        if (++candidate.held >= SOURCE_CHANGE_SLOTS) {
            start = candidate.at;
            current = candidate.code;
            candidate = undefined;
        }
    });
    return start;
}
