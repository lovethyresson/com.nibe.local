/** M2 shadow: the whole controller runs, but nothing is fed. Pure. Design:
 *  docs/autopilot-plan.md §7.5.
 *
 *  Every slot plans all three presets from the house as it is, and records what each would have
 *  fed and where it expected indoor to go. Each preset keeps its own would-be history (the bias
 *  in force, the curve's filtered view of what was fed, the rest of its last plan), so its feeds
 *  read as the sequence it would really have sent, ramps and coasts included, although the house
 *  it plans from is the one doing nothing. That is the evidence for the preset table (§7.4) and
 *  for the gain far from the real outdoor temperature (§7.4, M0 measured ±5 K only), before
 *  anything is fed.
 *
 *  Comfort is the setpoint. Each preset plans a shift on top of the comfort bias (trim.ts), the
 *  feed that holds comfort with room-sensor control off, which Autopilot requires. "Doing
 *  nothing" is the pump as it is: its curve on the wired BT1, which trails the real outdoor
 *  temperature (outdoor.ts `WIRED_TAU_H`). */
import {HouseParams} from './model';
import {ForecastSlot, PlanState, PumpCurve, planShift, simulate} from './planner';
import {PRESETS, PresetId, limitsFor} from './presets';
import {ClampReason, PumpThresholds, curveInput, fedValue} from './actuator';
import {History} from './history';
import {WIRED_TAU_H, WiredModel, wiredModel} from './outdoor';

export const SHADOW_PRESETS: PresetId[] = ['comfortable', 'save_some', 'save_most'];
/** 24 h: today's prices and, after 13:00, tomorrow's. */
export const HORIZON = 96;
/** The slots ahead the log keeps a prediction for: 1 h and 6 h. */
export const AHEAD = [4, 24] as const;

/** The wired BT1 against the recorded outdoor temperature over the history (outdoor.ts). */
export function wiredOf(history: History): WiredModel | undefined {
    return wiredModel(history.range().map((slot) => {
        const v = history.get(slot)!;
        return {slot, te: v.te, bt1: v.bt1};
    }));
}

/** The curve's filtered view of input 1 after the last slot (§4.5), from the last 4 h. */
export function curveViewOf(history: History): number | undefined {
    let x: number | undefined;
    for (const slot of history.range().slice(-16)) {
        const bt1 = history.get(slot)!.bt1;
        if (Number.isFinite(bt1)) x = x === undefined ? bt1 : curveInput(x, bt1);
    }
    return x;
}

/** What each preset carries from one slot to the next. */
export interface PresetMemory {
    bias: number;
    /** The curve's filtered view of what this preset fed (§4.5). */
    curve: number;
    /** Its last plan from the next slot on, the next plan's warm start. */
    plan: number[];
}

export type ShadowMemory = Partial<Record<PresetId, PresetMemory>>;

export interface ShadowInput {
    house: HouseParams;
    /** How a bias moves heat (planner.ts `PumpCurve`); the house's heat loss per K when not yet measured. */
    pump?: PumpCurve;
    /** Air and mass now. */
    ti: number;
    tm: number;
    comfort: number;
    /** The real outdoor temperature now. */
    real: number;
    /** Operating mode Auto (237 = 0). */
    auto: boolean;
    thresholds: PumpThresholds;
    /** From the next slot on; sun not yet discounted by any preset's trust. */
    forecast: ForecastSlot[];
    memory: ShadowMemory;
    /** Slots since the previous step, for the ramp and the warm start. */
    slots?: number;
    /** The wired BT1 model and the curve's view of input 1 now: what doing nothing feeds. Without
     *  them, doing nothing is the curve on the real outdoor temperature. */
    wired?: WiredModel;
    curveNow?: number;
}

export interface PresetEntry {
    /** Bias and fed value for the next slot, after the actuator's clamps. */
    bias: number;
    /** Of that bias, what holds comfort (trim.ts); the rest is the preset's shift. */
    comfortBias: number;
    fed: number;
    clamped: ClampReason[];
    reason?: string;
    /** Indoor the plan expects 1 h and 6 h ahead. */
    ahead: number[];
    /** Share of the horizon's cost at equal comfort the plan saves (planner.ts `fairCost`). */
    saving: number;
}

export interface ShadowOutput {
    presets: Partial<Record<PresetId, PresetEntry>>;
    /** Indoor doing nothing is expected to reach 1 h and 6 h ahead; set against what the house
     *  then does, this is the model's live error, forecast error included. */
    baseline: number[];
    memory: ShadowMemory;
}

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

export function shadowStep(input: ShadowInput): ShadowOutput {
    const forecast = input.forecast.slice(0, HORIZON);
    const steps = Math.max(1, input.slots ?? 1);
    const out: ShadowOutput = {presets: {}, baseline: [], memory: {}};
    const pump = input.pump ?? {};
    for (const id of SHADOW_PRESETS) {
        const limits = limitsFor(PRESETS[id]);
        const previous = input.memory[id] ?? {bias: 0, curve: input.curveNow ?? input.real, plan: []};
        const trust = limits.forecastTrust;
        const discounted = forecast.map((s) => ({...s, sun: s.sun * trust,
            sunE: (s.sunE ?? 0) * trust, sunW: (s.sunW ?? 0) * trust}));
        const state: PlanState = {ti: input.ti, tm: input.tm, curve: previous.curve, bias: previous.bias};
        const plan = planShift(input.house, input.comfort, state, discounted, limits, pump,
            previous.plan.slice(steps - 1));
        const applied = fedValue({real: input.real, bias: plan.biases[0], previousBias: previous.bias,
            comfortBias: plan.comfort[0], maxBias: limits.maxBias, maxCoastBias: limits.maxCoastBias, auto: input.auto, thresholds: input.thresholds, slots: steps});
        out.presets[id] = {
            bias: applied.bias, comfortBias: round(plan.comfort[0], 1), fed: applied.fed, clamped: applied.clamped, reason: plan.reason,
            ahead: AHEAD.map((k) => round(plan.plan.ti[k - 1] ?? NaN)),
            saving: round(1 - plan.fairCost / plan.baselineFairCost, 4),
        };
        out.memory[id] = {bias: applied.bias, curve: curveInput(previous.curve, applied.fed), plan: plan.biases.slice(1)};
    }
    // What the house is really doing: nothing fed, the curve on the wired BT1 (the forecast
    // through the sensor's lag, plus its offset), the forecast's sun in full.
    let lag = input.wired?.lag;
    const unfed = forecast.map((s) => {
        if (!input.wired || lag === undefined) return 0;
        lag = s.te + (lag - s.te) * Math.exp(-0.25 / WIRED_TAU_H);
        return s.te - (lag + input.wired.offset);
    });
    const nothing = simulate(input.house, input.comfort, {ti: input.ti, tm: input.tm, curve: input.curveNow ?? input.real, bias: 0},
        forecast, unfed, pump);
    out.baseline = AHEAD.map((k) => round(nothing.ti[k - 1] ?? NaN));
    return out;
}

/** The forecast from `from` on, as long as there is weather for it: outdoor corrected by what
 *  the wired sensor taught (outdoor.ts), and the price where known, else the last one known
 *  (flat: no shifting on a guess), else 1. */
export function shadowForecast(from: number, weather: Map<number, {te: number; gtiS: number; gtiE: number; gtiW: number}>,
                               prices: Map<number, {price: number}>, correction: (slot: number) => number,
                               n = HORIZON): ForecastSlot[] {
    const out: ForecastSlot[] = [];
    let price = [...prices.entries()].filter(([s]) => s < from).sort((a, b) => b[0] - a[0])[0]?.[1].price ?? 1;
    for (let k = 0; k < n; k++) {
        const w = weather.get(from + k);
        if (!w || ![w.te, w.gtiS, w.gtiE, w.gtiW].every(Number.isFinite)) break;
        price = prices.get(from + k)?.price ?? price;
        out.push({te: w.te + correction(from + k), sun: w.gtiS, sunE: w.gtiE, sunW: w.gtiW, price});
    }
    return out;
}
