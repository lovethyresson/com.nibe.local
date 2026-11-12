/** The house model run over the stored history, plus the lifecycle checks that need more than
 *  one fit: readiness (§6.4) and drift (§6.2, §9). Pure.
 *
 *  The model is refitted from the whole history rather than stepped one slot at a time: heat for
 *  a slot is only known once 1577 steps again, which can be several slots later, and a refit
 *  needs no filter state to persist or migrate. 28 days is ~2,700 slots, cheap enough hourly. */
import {FLAG, History, outdoorSource} from './history';
import {currentSourceStart} from './outdoor';
import {heatPerSlot} from './heat';
import {
    BuildEra, HeatingSystem, HouseParams, ModelSlot, envelopeTau, fitSeries, predictionRmse, rlsHouse, sunScore, toModelSlots,
} from './model';
import {PumpCurve, estimateLever} from './planner';
import {DEFAULT_GAIN, SupplyCurve, curvePoints, fitSupplyCurve, gainBetween} from './curve';

const DAY_SLOTS = 96;
/** A day counts toward readiness when this many of its slots taught the model something. */
export const VALID_DAY_USABLE = 48;

export interface HouseAnswers {
    system: HeatingSystem;
    era: BuildEra;
}

export interface HouseFit {
    params?: HouseParams;
    /** Stage 1's heat loss, kW/K, when plausible. */
    firstOrderHeatLoss?: number;
    /** 6 h open-loop error over the last 7 days, K. */
    rmse: number;
    windows: number;
    slots: number;
    usable: number;
    /** Days with at least VALID_DAY_USABLE usable slots and some space heating. */
    validDays: number;
    /** kW of heat per K of bias near the last outdoor temperature, when enough clean hours
     *  exist; for the log. The planner takes `pump`. */
    lever?: number;
    /** The learned heat curve (curve.ts), once it has the points. */
    curve?: SupplyCurve;
    /** What the planner moves heat with (planner.ts `PumpCurve`). */
    pump?: PumpCurve;
    /** Sunny 6 h windows of the last 7 days, predicted with and without the sun term. */
    sun?: {windows: number; rmseOn: number; rmseOff: number};
    /** The filter's air and mass at the last slot it saw: where a plan starts (shadow.ts). */
    state?: {slot: number; ti: number; tm: number};
}

/** Whole hours of steady space heating (no hot water, every slot read) for `estimateLever`. */
export function heatingHours(history: History): {heatKw: number; tcalc: number; ti: number}[] {
    const slots = history.range();
    const heat = heatPerSlot(slots.map((slot) => {
        const v = history.get(slot)!;
        return {slot, qmeter: v.qmeter, hz: v.hz, dhw: v.dhw};
    }));
    const hours: {heatKw: number; tcalc: number; ti: number}[] = [];
    for (let i = 0; i + 4 <= slots.length; i += 4) {
        const block = slots.slice(i, i + 4);
        if (block[3] !== block[0] + 3) continue;
        const values = block.map((s) => history.get(s)!);
        if (values.some((v, k) => !(v.dhw < 0.05) || (v.flags & FLAG.partial) || !heat.has(block[k]))) continue;
        const mean = (f: 'tcalc' | 'ti') => values.reduce((a, v) => a + v[f], 0) / 4;
        hours.push({heatKw: block.reduce((a, s) => a + heat.get(s)!, 0), tcalc: mean('tcalc'), ti: mean('ti')});
    }
    return hours;
}

/** Days a new outdoor source needs before the fit drops what came before it. On the maintainer's
 *  history (2026-11-09) a fit over the 7 days since the sensor was picked was unidentifiable even
 *  with the forecast as outdoor (6 h error 0.44–0.51 K against 0.30 K over all 10 days), so a
 *  short run is worse than a mixed one. 14 days is a guess past that, not yet measured. */
export const SOURCE_RUN_DAYS = 14;

/** The slots the house model learns from: those since the outdoor source last changed
 *  (outdoor.ts `currentSourceStart`), once that run is long enough to fit on its own; until then
 *  all of them. */
export function currentSourceSlots(history: History): number[] {
    const slots = history.range();
    const start = currentSourceStart(slots.map((s) => outdoorSource(history.get(s)!)));
    return slots.length - start >= SOURCE_RUN_DAYS * DAY_SLOTS ? slots.slice(start) : slots;
}

export function modelSlotsFromHistory(history: History): ModelSlot[] {
    const rows = currentSourceSlots(history).map((slot) => ({slot, ...history.get(slot)!}));
    const heat = heatPerSlot(rows.map((r) => ({slot: r.slot, qmeter: r.qmeter, hz: r.hz, dhw: r.dhw})));
    return toModelSlots(rows.map((r) => ({slot: r.slot, ti: r.ti, te: r.te, gtiS: r.gtiS, gtiE: r.gtiE, gtiW: r.gtiW, dhw: r.dhw,
        partial: (r.flags & FLAG.partial) !== 0, q: heat.get(r.slot)})));
}

export function validDays(slots: ModelSlot[]): number {
    const days = new Map<number, {usable: number; heat: number}>();
    for (const s of slots) {
        const day = Math.floor(s.slot / DAY_SLOTS);
        const d = days.get(day) ?? {usable: 0, heat: 0};
        if (s.usable) d.usable++;
        d.heat += s.inputs.q;
        days.set(day, d);
    }
    return [...days.values()].filter((d) => d.usable >= VALID_DAY_USABLE && d.heat > 0).length;
}

export function fitHouse(slots: ModelSlot[], answers: HouseAnswers, lever?: number,
                         curve?: {supply?: SupplyCurve; heatPerSupplyK?: number}): HouseFit {
    // Stage 2 starts after up to 3 days of stage 1, but never waits for more data than exists.
    const warmupSlots = Math.max(1, Math.min(3 * DAY_SLOTS, slots.length));
    const fit = fitSeries(slots, answers.system, answers.era, {warmupSlots});
    const recent = slots.slice(-7 * DAY_SLOTS);
    const quality = fit.params ? predictionRmse(fit.params, recent, fit.states) : {rmse: NaN, windows: 0};
    const sun = fit.params ? sunScore(fit.params, recent, fit.states) : undefined;
    // The last slot the filter corrected: slots after it wait for 1577 to step, so it ran them
    // with no heat, which leaves its state there too cold.
    const lastUsable = [...slots].reverse().find((s) => s.usable && fit.states.has(s.slot));
    const last = lastUsable && ([lastUsable.slot, fit.states.get(lastUsable.slot)!] as const);
    return {
        params: fit.params,
        firstOrderHeatLoss: rlsHouse(fit.rls)?.heatLoss,
        rmse: quality.rmse,
        windows: quality.windows,
        slots: slots.length,
        usable: slots.filter((s) => s.usable).length,
        validDays: validDays(slots),
        sun,
        lever,
        curve: curve?.supply,
        pump: curve?.supply && curve.heatPerSupplyK !== undefined
            ? {supply: curve.supply, heatPerSupplyK: curve.heatPerSupplyK} : lever !== undefined ? {lever} : undefined,
        state: fit.params && last ? {slot: last[0], ti: last[1][0], tm: last[1][1]} : undefined,
    };
}

/** The heat curve and how much heat a K of supply moves, from one history, plus the lever for
 *  the log: that heat times the curve's slope 5 K either side of the last outdoor temperature. */
export function pumpFromHistory(history: History): {supply?: SupplyCurve; heatPerSupplyK?: number; lever?: number} {
    const heatPerSupplyK = estimateLever(heatingHours(history), 1);
    const supply = fitSupplyCurve(curvePoints(history));
    const te = [...history.range()].reverse().map((s) => history.get(s)!.te).find(Number.isFinite);
    const gain = supply && te !== undefined ? (gainBetween(supply, te - 5, te) + gainBetween(supply, te, te + 5)) / 2 : DEFAULT_GAIN;
    return {supply, heatPerSupplyK, lever: heatPerSupplyK === undefined ? undefined : heatPerSupplyK * gain};
}

/** The whole hourly job: model slots, fit, heat curve and lever from one history. */
export function fitHistory(history: History, answers: HouseAnswers): HouseFit {
    const pump = pumpFromHistory(history);
    return fitHouse(modelSlotsFromHistory(history), answers, pump.lever, pump);
}

// ---- lifecycle across fits ----

/** One fit kept per day, for readiness and drift. */
export interface DailyFit {
    day: number;
    heatLoss: number;
    tau: number;
    rmse: number;
    /** kW through all walls' windows at 500 W/m², and the day's sunny-window score. */
    sun?: number;
    sunWindows?: number;
    sunOn?: number;
    sunOff?: number;
}

export const KEEP_DAYS = 30;

/** Replace or append today's entry. */
export function recordDailyFit(log: DailyFit[], day: number, fit: HouseFit): DailyFit[] {
    if (!fit.params) return log;
    const p = fit.params;
    const entry: DailyFit = {day, heatLoss: p.heatLoss, tau: envelopeTau(p), rmse: fit.rmse, sun: (p.sun + p.sunE + p.sunW) * 500,
        ...(fit.sun && fit.sun.windows ? {sunWindows: fit.sun.windows, sunOn: fit.sun.rmseOn, sunOff: fit.sun.rmseOff} : {})};
    return [...log.filter((d) => d.day !== day), entry].sort((a, b) => a.day - b.day).slice(-KEEP_DAYS);
}

export const READY_RMSE = 0.35;
export const READY_DAYS = 5;
export const TAU_STABLE = 0.15;

export interface Readiness {
    ready: boolean;
    /** What is still missing, for the log and later the insights label. */
    missing: ('accuracy' | 'days' | 'stability')[];
}

/** §6.4: 6 h RMSE under 0.35 K, at least 5 valid days, τ within 15 % over the last 3 days. */
export function readiness(fit: HouseFit, log: DailyFit[]): Readiness {
    const missing: Readiness['missing'] = [];
    if (!(fit.rmse < READY_RMSE) || fit.windows < 8) missing.push('accuracy');
    if (fit.validDays < READY_DAYS) missing.push('days');
    const last = log.slice(-3);
    const stable = last.length === 3 && Math.max(...last.map((d) => d.tau)) / Math.min(...last.map((d) => d.tau)) - 1 <= TAU_STABLE;
    if (!stable) missing.push('stability');
    return {ready: missing.length === 0, missing};
}

/** Days on which the sun term predicted sunny windows better than leaving it out, before live
 *  plans may count on forecast sun; and how far the fitted sun may move across the last three days
 *  (looser than τ's 15 %: on 2026-11 data it swung 0.1–1.1 kW and is the slowest term to settle). */
export const SUN_DAYS = 5;
export const SUN_WINDOWS_PER_DAY = 3;
export const SUN_STABLE = 0.3;

/** Whether the sun term has earned a place in live plans (solar plan §2). */
export function sunReady(log: DailyFit[]): boolean {
    const better = log.filter((d) => (d.sunWindows ?? 0) >= SUN_WINDOWS_PER_DAY && d.sunOn! < d.sunOff!).length;
    const last = log.slice(-3).map((d) => d.sun ?? NaN);
    const stable = last.length === 3 && last.every((v) => v > 0) && Math.max(...last) / Math.min(...last) - 1 <= SUN_STABLE;
    return better >= SUN_DAYS && stable;
}

export const DRIFT_PER_DAY = 0.2;

/** §6.2: heat loss or τ moving more than 20 % a day, three days running, on consecutive days. */
export function drifting(log: DailyFit[]): boolean {
    const last = log.slice(-4);
    if (last.length < 4 || last.some((d, i) => i > 0 && d.day !== last[i - 1].day + 1)) return false;
    const moved = (key: 'heatLoss' | 'tau') => last.slice(1).every((d, i) => Math.abs(d[key] / last[i][key] - 1) > DRIFT_PER_DAY);
    return moved('heatLoss') || moved('tau');
}
