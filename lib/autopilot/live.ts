/** Autopilot heating, shift-only. The owner's heat curve and offset keep the
 *  house's level; Autopilot only moves heat in time (more before expensive hours, less during
 *  them) by feeding BT1 (5217) a little colder or warmer than the real outdoor temperature.
 *
 *  Why shift-only first: the comfort bias (trim.ts) rests on the house model's steady level,
 *  which the +6 run has not confirmed (tasks/todo.md, 2026-11-11). Price shifting does not: with
 *  `pump = {lever}` the planner takes the curve as holding the temperature and only plans the
 *  shift (planner.ts `pumpHeat`). Comfort is the thermostat (since 2026-11-14; the house's own 24 h
 *  mean without one): the band is setpoint ± range, and a learned trim (setpoint.ts) makes "no
 *  shift" really hold it.
 *
 *  Switched by heating's Smart mode (smart-mode.ts): `test` plans and reports without writing,
 *  `autopilot` feeds. Design: docs/autopilot-plan.md §4.1, §7.2, §7.6, §10.0. */
import {ActuatorOutput, PumpThresholds, RAMP_K_PER_SLOT, fedValue} from './actuator';
import {HouseParams, envelopeTau} from './model';
import {ForecastBias, OutdoorReading, realOutdoor} from './outdoor';
import {COP, Comfort, ForecastSlot, Plan, PumpCurve, planShift, simulate} from './planner';
import {CopModel} from './cop';
import {SupplyCurve, curveInputFor} from './curve';
import {effectivePrice} from './solar-surplus';
import {Limits, PresetId} from './presets';
import {SLOT_MS, slotOf} from './prices';
import {TrimState, nextTrim} from './setpoint';

/** `test` plans and reports without writing; `live` feeds BT1. */
export type LiveMode = 'off' | 'test' | 'live';
/** Heating's Smart mode as a feed mode. */
export function liveMode(smartMode: unknown): LiveMode {
    return smartMode === 'autopilot' ? 'live' : smartMode === 'test' ? 'test' : 'off';
}

/** Save some money's limits: a small, symmetric shift (±3 K of fed outdoor, ~0.35 kW on the
 *  S1155), coasts of at most 3 h, and indoor within ±0.5 K of where the curve keeps it. No weather
 *  feed-forward (the sun term is part of what is unproven). */
export const LIVE_LIMITS: Limits = {
    lower: 0.5, upper: 0.5, margin: 0.39, forecastTrust: 0, maxCoastH: 3, preheatLeadTau: 0.3,
    maxBias: 3, maxCoastBias: 3, comfortWeight: 1.4,
};

/** The owner's profile is an indoor tolerance (maintainer, 2026-11-12): Comfort ±0.5 °C, Save
 *  ±3 °C, I'd rather freeze ±6 °C around the house's usual level. The outdoor shift, coast length
 *  and price spread follow from it, sized like Ngenic's ±10 K and beyond; the tolerance, not the
 *  shift, is the owner's promise. Lower comfort weights let the wider profiles use their room. */
export const PROFILE_LIMITS: Record<PresetId, Limits> = {
    comfortable: {...LIVE_LIMITS, lower: 0.5, upper: 0.5, margin: 0.2, maxCoastH: 6, maxBias: 10, maxCoastBias: 10},
    save_some: {...LIVE_LIMITS, lower: 3, upper: 3, margin: 0.1, maxCoastH: 12, maxBias: 15, maxCoastBias: 15, comfortWeight: 1.2},
    save_most: {...LIVE_LIMITS, lower: 6, upper: 6, margin: 0, maxCoastH: 24, maxBias: 20, maxCoastBias: 20, comfortWeight: 1},
};
export const DEFAULT_PROFILE: PresetId = 'comfortable';
export function profileLimits(profile: unknown): Limits {
    return PROFILE_LIMITS[profile as PresetId] ?? PROFILE_LIMITS[DEFAULT_PROFILE];
}

/** The ranges setup explains, in order. */
export const RANGE_IDS = ['comfortable', 'save_some', 'save_most'] as const;
/** What setup's range step says of each range, from the live limits themselves: how far indoor
 *  may move (°C), the comfort weight (the house cools only when a peak costs more than this many
 *  times the coming hours' average, the price of buying the heat back), and the longest ease-off (h). */
export function rangeFacts(): Record<typeof RANGE_IDS[number], {band: number; weight: number; coast: number}> {
    const of = (id: PresetId) => ({band: PROFILE_LIMITS[id].lower, weight: PROFILE_LIMITS[id].comfortWeight, coast: PROFILE_LIMITS[id].maxCoastH});
    return {comfortable: of('comfortable'), save_some: of('save_some'), save_most: of('save_most')};
}

/** The Custom range: the owner sets the live limits themselves, in Heating setup's Comfort range
 *  step (Repair), kept on the Heating device. Each value, its range and step, its unit, and the
 *  limit it sets. Values outside the range are clamped; a missing one is Comfort's. Unproven
 *  combinations: the planner was tuned on the three ranges only. */
export const CUSTOM_SETTINGS = {
    custom_coldest: {limit: 'lower', min: 0, max: 6, step: 0.5, unit: '°C'},
    custom_warmest: {limit: 'upper', min: 0, max: 6, step: 0.5, unit: '°C'},
    /** The expensive hour must cost at least this many times the cheap one: 1 + margin. */
    custom_price_ratio: {limit: 'margin', min: 1, max: 3, step: 0.05, unit: '×'},
    custom_coast_hours: {limit: 'maxCoastH', min: 0, max: 24, step: 1, unit: 'h'},
    custom_preheat_shift: {limit: 'maxBias', min: 0, max: 20, step: 1, unit: '°C'},
    custom_coast_shift: {limit: 'maxCoastBias', min: 0, max: 20, step: 1, unit: '°C'},
    custom_comfort_weight: {limit: 'comfortWeight', min: 0.5, max: 3, step: 0.1, unit: ''},
    custom_preheat_lead: {limit: 'preheatLeadTau', min: 0, max: 1, step: 0.05, unit: ''},
} as const;

/** The Custom values as setup shows and edits them: the stored ones, clamped, with Comfort's
 *  for any not set. Pure. */
export function customValues(stored: Partial<Record<CustomSettingId, unknown>> | null | undefined): Record<CustomSettingId, number> {
    return limitsAsCustom(customLimits(stored ?? {}));
}

/** What each standard range sets, in the Custom fields' terms: shown under each field. Pure. */
export function customPresets(): Record<typeof RANGE_IDS[number], Record<CustomSettingId, number>> {
    return {comfortable: limitsAsCustom(PROFILE_LIMITS.comfortable), save_some: limitsAsCustom(PROFILE_LIMITS.save_some),
        save_most: limitsAsCustom(PROFILE_LIMITS.save_most)};
}

function limitsAsCustom(limits: Limits): Record<CustomSettingId, number> {
    const out = {} as Record<CustomSettingId, number>;
    for (const [id, spec] of Object.entries(CUSTOM_SETTINGS) as [CustomSettingId, typeof CUSTOM_SETTINGS[CustomSettingId]][]) {
        const v = (limits as any)[spec.limit] as number;
        out[id] = Math.round((spec.limit === 'margin' ? 1 + v : v) * 100) / 100;
    }
    return out;
}
export type CustomSettingId = keyof typeof CUSTOM_SETTINGS;

/** The limits the Custom range plans with, from the device's settings. Pure. */
export function customLimits(settings: Partial<Record<CustomSettingId, unknown>>): Limits {
    const out: Limits = {...PROFILE_LIMITS.comfortable};
    for (const [id, spec] of Object.entries(CUSTOM_SETTINGS) as [CustomSettingId, typeof CUSTOM_SETTINGS[CustomSettingId]][]) {
        const raw = Number(settings[id]);
        if (!Number.isFinite(raw)) continue;
        const v = Math.min(spec.max, Math.max(spec.min, raw));
        (out as any)[spec.limit] = spec.limit === 'margin' ? v - 1 : v;
    }
    return out;
}

/** The limits for a range id, or the Custom range's from `settings`. Pure. */
export function rangeLimits(range: unknown, settings: Partial<Record<CustomSettingId, unknown>>): Limits {
    return range === 'custom' ? customLimits(settings) : profileLimits(range);
}

export const FEED_EVERY_MS = 30_000;
/** Input 1 must show the fed value within this many reads, this far apart (dev/probe-bt1.mjs). */
export const VERIFY_TRIES = 4;
export const VERIFY_GAP_MS = 750;
/** Failed feed cycles in a row before the feed stops (§7.2 `lever_error`). */
export const MAX_FAILED_CYCLES = 3;

/** The plan's indoor reference: the house's mean over the last 24 h, from slots that have one. */
export function indoorMean(values: number[]): number | undefined {
    const ok = values.filter(Number.isFinite);
    return ok.length >= 48 ? ok.reduce((a, b) => a + b, 0) / ok.length : undefined;
}

export interface ShiftInput {
    house: HouseParams;
    /** kW of heat per K of fed outdoor (HouseFit.lever). */
    lever: number;
    /** Indoor now, and the 24 h mean the shift is planned around. */
    ti: number;
    tm: number;
    mean: number;
    /** The curve's filtered view of BT1 and the bias in force. */
    curve: number;
    bias: number;
    forecast: ForecastSlot[];
    /** The previous plan from this slot on: the warm start. */
    previous?: number[];
    /** The learned heat curve and kW of heat per K of supply (house.ts `pumpFromHistory`): with
     *  both, a shift moves heat along the curve's real shape, not the lever's straight line. */
    supply?: SupplyCurve;
    heatPerSupplyK?: number;
    /** The setpoint per slot when it changes inside the horizon (Away ending, `setpointPath`);
     *  otherwise the plan aims at `mean` throughout. */
    comfort?: Comfort;
    /** The learned COP once trusted (cop.ts): heat priced at the supply each slot runs at. */
    cop?: CopModel;
}

/** When Away ends by itself: the time, and the setpoint the house is back at then. */
export interface AwayReturn {
    at: number;
    setpoint: number;
}

/** The longest warm-up looked for, slots: four days. A house that needs longer starts then. */
export const MAX_WARMUP_SLOTS = 4 * 96;

/** Slack on the warm-up estimate: the plan still picks cheap hours inside it, which a warm-up
 *  flat out from the first slot does not. */
export const WARMUP_MARGIN = 1.15;

/** Slots the house needs to warm from now to `target` with the most pre-heat the limits allow,
 *  ramped from the bias in force as the feed ramps, from the model; the last forecast slot is held
 *  past the horizon. The plan before the return aims at Away's setpoint, so the pre-heat alone has
 *  to lift it. With `WARMUP_MARGIN`; `MAX_WARMUP_SLOTS` when it never gets there. */
export function warmUpSlots(input: ShiftInput, limits: Limits, setpoint: number, target: number): number {
    if (input.ti >= target || !input.forecast.length) return 0;
    const last = input.forecast[input.forecast.length - 1];
    const forecast = Array.from({length: MAX_WARMUP_SLOTS}, (_, k) => input.forecast[k] ?? last);
    const biases = forecast.map((_, k) => Math.min(limits.maxBias, input.bias + RAMP_K_PER_SLOT * (k + 1)));
    const sim = simulate(input.house, setpoint, {ti: input.ti, tm: input.tm, curve: input.curve, bias: input.bias}, forecast,
        biases, livePump(input));
    const k = sim.ti.findIndex((t) => t >= target);
    return k < 0 ? MAX_WARMUP_SLOTS : Math.min(MAX_WARMUP_SLOTS, Math.ceil((k + 1) * WARMUP_MARGIN));
}

/** The setpoint per slot from `slot` on: `setpoint` (Away's) until the return, the home's from
 *  the first slot that ends at or after it, since the plan's indoor path is each slot's end.
 *
 *  One number while the return is beyond the horizon and further off than the warm-up needs
 *  (`lead`, slots, `warmUpSlots`). A slab house can need longer than the 24–36 h horizon: then the
 *  step is placed at the horizon's last slot, and the plan warms as hard as it may until the real
 *  return comes into view. */
export function setpointPath(setpoint: number, slot: number, n: number, back: AwayReturn | undefined, lead = 0): Comfort {
    if (!back || !Number.isFinite(back.at) || !Number.isFinite(back.setpoint) || n <= 0) return setpoint;
    let from = Math.max(0, Math.ceil(back.at / SLOT_MS) - slot - 1);
    if (from >= n) {
        if (from - lead > 0) return setpoint;
        from = n - 1;
    }
    // The owner gave the time: from it on, the setpoint is a promise (planner `FIRM_WEIGHT`).
    return {setpoints: Array.from({length: n}, (_, k) => (k >= from ? back.setpoint : setpoint)), firmFrom: from};
}

/** How far live plans trust forecast sun, per profile, once the sun term has earned it (house.ts
 *  `sunReady`): the same discount as the shadow's `limitsFor`. Before that, 0. */
export const SUN_TRUST: Record<PresetId, number> = {comfortable: 0.58, save_some: 0.74, save_most: 0.9};
export function sunTrust(profile: unknown): number {
    return SUN_TRUST[profile as PresetId] ?? SUN_TRUST[DEFAULT_PROFILE];
}

/** How the plan models the pump: along the learned curve once it and the emission exist, else
 *  the lever's straight line. */
export function livePump(input: ShiftInput): PumpCurve {
    return input.supply && input.heatPerSupplyK! > 0
        ? {supply: input.supply, heatPerSupplyK: input.heatPerSupplyK, shiftOnly: true, ...(input.cop ? {cop: input.cop} : {})}
        : {lever: input.lever};
}

/** The deepest coast that still does something, K: where the learned curve's supply falls to the
 *  indoor temperature, the pump delivers nothing, so easing off further gains nothing. It comes
 *  from the owner's own curve, so no curve has to change (S1155, curve 5 offset +6: a fed 29 °C,
 *  where an 80 °C feed stopped the compressor on 2026-11-13). Only as far as the curve has been
 *  learned: past its last knot the shape is a guess, and a guessed shape mispredicts the cooling. */
export function curveCoastDepth(input: ShiftInput): number | undefined {
    if (!input.supply || !(input.heatPerSupplyK! > 0) || !input.forecast.length) return undefined;
    const stop = curveInputFor(input.supply, input.mean);
    if (stop === undefined) return undefined;
    const reach = Math.min(stop, input.supply.knots[input.supply.knots.length - 1]);
    return Math.floor(reach - input.forecast[0].te);
}

/** The profile's limits with the coast deepened to what the curve needs, never made shallower:
 *  the profile's indoor tolerance, which the planner holds, is the owner's promise, not the shift. */
export function liveLimits(limits: Limits, input: ShiftInput): Limits {
    const depth = curveCoastDepth(input);
    return depth !== undefined && depth > limits.maxCoastBias ? {...limits, maxCoastBias: depth} : limits;
}

/** What the plan aims at from `slot` on: the setpoint, stepping up to the home's at Away's end
 *  with the lead the house needs (`warmUpSlots`, `setpointPath`). `warming`: the warm-up for this
 *  return has started, and holds. Without that the lead shrinks as the house warms, the step
 *  leaves the horizon, the plan coasts, and the warm-up starts over: it arrived 0.4 K short. */
export function planComfort(input: ShiftInput, limits: Limits, setpoint: number, slot: number, back: AwayReturn | undefined,
    warming = false): Comfort {
    const lead = !back ? 0 : warming ? Infinity : warmUpSlots(input, limits, setpoint, back.setpoint);
    return setpointPath(setpoint, slot, input.forecast.length, back, lead);
}

/** Whether a plan's comfort is warming for a return (a step in view). */
export function warmingUp(comfort: Comfort | undefined): boolean {
    return typeof comfort === 'object' && !Array.isArray(comfort);
}

/** The shift-only plan: the curve holds the house (no comfort bias). Forecast sun counts at
 *  `trust`, 0 until the sun term has proven itself on sunny days. */
export function planLive(input: ShiftInput, limits: Limits = LIVE_LIMITS, trust = 0): Plan {
    const forecast = input.forecast.map((s) => ({te: s.te, sun: s.sun * trust, sunE: (s.sunE ?? 0) * trust,
        sunW: (s.sunW ?? 0) * trust, price: s.price, busy: s.busy}));
    return planShift(input.house, input.comfort ?? input.mean, {ti: input.ti, tm: input.tm, curve: input.curve, bias: input.bias},
        forecast, limits, livePump(input), input.previous);
}

/** The forecast with the slots hot water has the compressor marked busy. */
export function withHotwater(forecast: ForecastSlot[], busy: boolean[] | undefined): ForecastSlot[] {
    return busy?.some(Boolean) ? forecast.map((s, k) => (busy[k] ? {...s, busy: true} : s)) : forecast;
}

/** The extra heat a pre-heat on surplus is sized for, K of shift: the electricity it takes is what
 *  the surplus has to cover for a slot to count as solar. */
export const SURPLUS_SHIFT_K = 2;

/** The forecast with each slot's price lowered by the solar surplus left for heating: the share of
 *  a pre-heat's extra draw the surplus covers is priced at what an export earns. Prices stay a
 *  number per slot, so the planner stays linear. */
export function surplusPrices(forecast: ForecastSlot[], from: number, surplus: Map<number, number> | undefined,
    leverKwPerK: number): ForecastSlot[] {
    if (!surplus) return forecast;
    const drawKw = leverKwPerK * SURPLUS_SHIFT_K / COP;
    return forecast.map((s, k) => {
        const kw = surplus.get(from + k);
        if (!kw || kw <= 0) return s;
        return {...s, price: effectivePrice(s.price, s.spot ?? 0, kw, drawKw).price};
    });
}

/** What the pump says, read when a slot is planned. */
export interface PumpFacts {
    /** 237: 0 Auto, 1 Manual, 2 immersion heater only. */
    mode?: number;
    thresholds: PumpThresholds;
    /** Smart price adaption on for heating: its master switch and its heating part both on. */
    spaHeating?: boolean;
    /** Room-sensor control for the zone (2978): any non-zero is on. */
    roomControl?: number;
    /** The immersion heater is running (1029). */
    addHeat?: boolean;
    /** The pump is cooling (priority 1028 = 60): heating has nothing to shift. */
    cooling?: boolean;
}

/** Why the feed is not feeding. `mode_off` and `feed_failed` end it (the owner turns it on again,
 *  or re-verifies); the rest are waits it re-checks every slot (`no_outdoor` every cycle) and
 *  leaves by itself. */
export type StopReason = 'mode_off' | 'feed_failed' | 'no_model' | 'immersion_only' | 'spa_on' | 'room_control'
    | 'no_outdoor' | 'cooling';

/** Reasons the feed must not run at all; undefined when it may. */
export function stopReason(facts: PumpFacts, haveModel: boolean): StopReason | undefined {
    if (!haveModel) return 'no_model';
    if (facts.mode === 2) return 'immersion_only';
    if (facts.cooling) return 'cooling';
    if (facts.spaHeating) return 'spa_on';
    if (facts.roomControl !== undefined && facts.roomControl !== 0) return 'room_control';
    return undefined;
}

/** The bias to feed this cycle: the plan's, never a pre-heat while the immersion heater runs
 *  (§7.2: pre-heating then only buys heat at COP 1). */
export function cycleBias(planned: number, addHeat: boolean | undefined): number {
    return addHeat && planned > 0 ? 0 : planned;
}

/** Everything the feed needs from the rest of the app, read when used. */
export interface FeedHooks {
    mode(): LiveMode;
    /** The owner's profile, read each slot. */
    limits(): Limits;
    /** How far forecast sun counts in the plan, read each slot: 0 until it has earned it. */
    sunTrust(): number;
    /** Comfort range Off: feed the real outdoor temperature, unshifted, and plan nothing. The
     *  pump stays on the sensor Autopilot uses rather than going back to its own BT1. */
    neutral(): boolean;
    /** The model and forecast for the slot about to start; undefined without them. */
    plan(slot: number): ShiftInput | undefined;
    /** The house's 24 h indoor mean, for the trim while there is no plan (the model learning);
     *  undefined with under 12 h of readings. */
    indoorMean?(slot: number): number | undefined;
    /** The thermostat setpoint the house is steered to (setpoint.ts), or undefined to leave the
     *  level to the curve. */
    setpoint?(): number | undefined;
    /** Away with an end time: when it ends and the setpoint it goes back to. */
    awayReturn?(): AwayReturn | undefined;
    /** The return whose warm-up has started, kept across restarts (`warmingFor`). */
    loadWarming?(): number | undefined;
    saveWarming?(at: number | undefined): void;
    /** The setpoint trim's integral, kept across restarts. */
    loadTrim?(): TrimState;
    saveTrim?(state: TrimState): void;
    pump(): Promise<PumpFacts>;
    /** The outdoor sensor's live reading (already checked for freshness) and the corrected
     *  forecast for now; the feed never uses input 1, which shows its own value. */
    outdoor(): {sensor?: number; forecast?: number; localHour: number; bias: ForecastBias};
    /** Write 5217 (°C). */
    write(celsius: number): Promise<void>;
    /** Read input 1 (°C), or undefined. */
    readBack(): Promise<number | undefined>;
    /** The feed's state changed: tell the collector whether slots are now fed by us. */
    feeding(on: boolean): void;
    /** A device warning for a reason the feed stopped or waits, or undefined to clear it. */
    warn(reason?: StopReason): void;
    /** Something the owner sees changed: bias, plan, or the reason it is (not) feeding. */
    changed(): void;
    /** After each cycle (every 30 s while it runs): the plan's Flow triggers look at it here. */
    tick?(): void;
    log(...args: any[]): void;
    /** One record per slot for the shadow log. */
    record(entry: LiveEntry): void;
    /** Each new plan: its first slot, the forecast it used (prices) and the heat it plans per slot,
     *  kWh. Plan vs actual (cost-check.ts) keeps the day's first. */
    planned?(slot: number, forecast: ForecastSlot[], heat: number[]): void;
    setTimeout(fn: () => void, ms: number): any;
    clearTimeout(timer: any): void;
    sleep(ms: number): Promise<void>;
    now(): number;
}

export interface LiveEntry {
    slot: number;
    bias: number;
    /** The setpoint trim inside `bias`, and the setpoint it steers to. */
    trim?: number;
    setpoint?: number;
    fed?: number;
    real?: number;
    source?: string;
    clamped: string[];
    planned: number[];
    reason?: string;
    stopped?: StopReason;
}

/** What the owner-facing status reads: the plan from this slot on, and its forecast. */
export interface FeedSnapshot {
    mode: LiveMode;
    bias: number;
    target: number;
    /** The part of the bias that steers the house to the setpoint, and that setpoint. */
    trim?: number;
    setpoint?: number;
    fed?: number;
    real?: number;
    /** Why it is not feeding (a wait or an end), undefined while it feeds or test-runs. */
    stopped?: StopReason;
    /** The slot `plan` starts at, the biases planned from it on, and that slot's forecast. */
    slot?: number;
    biases?: number[];
    forecast?: ForecastSlot[];
    /** Why the plan shifts nothing, when it does not (planner `Plan.reason`). */
    planReason?: string;
    /** The indoor temperature the plan expects at the end of each of its slots. */
    indoor?: number[];
    /** Comfort range Off: fed unshifted. */
    neutral?: boolean;
    /** The plan counts forecast sun (the sun term has earned it). */
    sunTrusted?: boolean;
    /** Away ends at this time inside the plan, and the plan warms the house for it. */
    back?: number;
    /** No plan yet (the model learning): it feeds the trim alone, to hold the setpoint. */
    learning?: boolean;
}

/** The 30 s BT1 feed and the 15-min shift planner, on the Heating device. */
export class HeatingFeed {
    private timer: any;
    private work: Promise<void> | null = null;
    private stopped = true;
    private bias = 0;
    private target = 0;
    private previous?: number[];
    private plannedSlot?: number;
    private failures = 0;
    private degradedSince?: number;
    private real?: OutdoorReading;
    private facts: PumpFacts = {thresholds: {}};
    private lastFed?: ActuatorOutput;
    private stopState?: StopReason = 'mode_off';
    /** The bias in force when the slot began: the ramp (2 K per slot) counts from here. */
    private slotBias = 0;
    /** Whether this feed set the device warning, so it clears only its own. */
    private warned = false;
    /** Whether the pump holds a value we wrote, so going idle or stopping hands it back. */
    private holding = false;
    private limits: Limits = LIVE_LIMITS;
    private plan?: {slot: number; biases: number[]; forecast: ForecastSlot[]; reason?: string; indoor?: number[]; back?: number};
    private neutral = false;
    /** The setpoint trim in force (setpoint.ts), the setpoint it steers to, and the slot it last moved. */
    private trim = 0;
    private setpoint?: number;
    private trimSlot?: number;
    private trimState?: TrimState;
    /** Feeding the trim alone while the model learns (`replan`). */
    private learning = false;
    /** The return (Away's end, ms) whose warm-up has started: it holds until that return, and
     *  across a restart, where the warmer house would otherwise get a shorter lead and coast. */
    private warmingFor?: number;
    private warmingLoaded = false;
    private warming(): number | undefined {
        if (!this.warmingLoaded) {
            this.warmingLoaded = true;
            this.warmingFor ??= this.hooks.loadWarming?.();
        }
        return this.warmingFor;
    }

    constructor(private readonly hooks: FeedHooks) {}

    get running() { return !this.stopped; }
    get state(): FeedSnapshot {
        return {mode: this.stopped ? 'off' : this.hooks.mode(), bias: this.bias, target: this.target, fed: this.lastFed?.fed,
            real: this.real?.value, stopped: this.stopState, slot: this.plan?.slot, biases: this.plan?.biases,
            forecast: this.plan?.forecast, planReason: this.plan?.reason, indoor: this.plan?.indoor, neutral: this.neutral || undefined,
            sunTrusted: this.hooks.sunTrust() > 0 || undefined, trim: this.trim || undefined, setpoint: this.setpoint,
            back: this.plan?.back, learning: this.learning || undefined};
    }

    start() {
        if (!this.stopped) return;
        this.stopped = false;
        this.stopState = undefined;
        this.failures = 0;
        // Replan (and so re-check every guard) before the first write, even within a slot.
        this.plannedSlot = undefined;
        this.warn(undefined);
        this.hooks.log('Autopilot heating: started.');
        this.schedule(0);
    }

    /** Plan again shortly rather than at the next slot: an owner's change (Comfort range,
     *  thermostat, Away) should show in the plan and the widget now. Delayed so Homey has stored
     *  the new value before the plan reads it. During a cycle the next one (30 s) replans. */
    replanSoon(ms = 2000) {
        if (this.stopped) return;
        this.plannedSlot = undefined;
        if (this.work) return;
        if (this.timer) this.hooks.clearTimeout(this.timer);
        this.schedule(ms);
    }

    /** Stop and hand BT1 back: one last feed of the real outdoor temperature, so the pump does
     *  not hold a shifted value for the ~5 min a write lasts. */
    async stop(reason: StopReason = 'mode_off') {
        if (this.stopped && this.stopState) return;
        this.stopped = true;
        this.stopState = reason;
        this.learning = false;
        if (this.timer) this.hooks.clearTimeout(this.timer);
        this.timer = undefined;
        if (this.work) await this.work.catch(() => undefined);
        await this.handBack();
        this.bias = 0;
        this.target = 0;
        this.plan = undefined;
        this.hooks.log(`Autopilot heating: stopped (${reason}).`);
        this.hooks.changed();
    }

    /** Feed the real outdoor once if the pump holds our value, and stop counting slots as fed. */
    private async handBack() {
        this.hooks.feeding(false);
        if (!this.holding) return;
        this.holding = false;
        if (this.real?.value === undefined) return;
        await Promise.race([this.hooks.write(this.real.value), this.hooks.sleep(5000)])
            .catch((error: any) => this.hooks.log('Autopilot heating: the last neutral feed failed:', error?.message ?? error));
    }

    private schedule(ms: number) {
        if (this.stopped) return;
        this.timer = this.hooks.setTimeout(() => {
            if (this.work) { this.schedule(FEED_EVERY_MS); return; }
            this.work = this.cycle()
                .catch((error: any) => this.hooks.log('Autopilot heating:', error?.message ?? error))
                .finally(() => {
                    this.work = null;
                    try { this.hooks.tick?.(); } catch (error: any) { this.hooks.log('Autopilot heating:', error?.message ?? error); }
                    this.schedule(FEED_EVERY_MS);
                });
        }, ms);
    }

    /** One 30 s cycle: replan when a new slot started, then feed and verify (live) or only work
     *  out what it would feed (test). */
    async cycle() {
        if (this.stopped) return;
        const mode = this.hooks.mode();
        if (mode === 'off') return this.halt('mode_off');
        const now = this.hooks.now();
        const slot = slotOf(now);
        const neutral = this.hooks.neutral();
        if (neutral !== this.neutral) {
            this.neutral = neutral;
            // Into Off: drop the plan. Out of it: plan now rather than at the next slot.
            this.plannedSlot = undefined;
            this.target = 0;
            this.slotBias = 0;
            this.plan = undefined;
            this.hooks.changed();
        }
        if (neutral) {
            // No plan: the real outdoor temperature, fed as it is. The pump's guards still hold
            // (SPA, room control, immersion only), re-checked each slot; learning does not stop it.
            if (slot !== this.plannedSlot) {
                this.plannedSlot = slot;
                this.facts = await this.hooks.pump();
                const wait = stopReason(this.facts, true);
                if (wait) return this.idle(wait);
            } else if (this.stopState && this.stopState !== 'no_outdoor') {
                return;
            }
        } else if (slot !== this.plannedSlot || this.stopState === 'no_model') {
            // Without a model, retry each cycle: the first fit and the weather land minutes after a start.
            this.plannedSlot = slot;
            const wait = await this.replan(slot);
            if (wait) return this.idle(wait);
        } else if (this.stopState && this.stopState !== 'no_outdoor') {
            return; // waiting for the next slot's re-check
        }

        const o = this.hooks.outdoor();
        this.real = realOutdoor({now, feeding: true, sensor: o.sensor, forecast: o.forecast, localHour: o.localHour,
            bias: o.bias, degradedSince: this.degradedSince});
        this.degradedSince = this.real.degradedSince;
        if (this.real.value === undefined || this.real.goNeutral) return this.idle('no_outdoor');

        // The trim holds the setpoint and is never a pre-heat to drop: the immersion rule is the shift's.
        const trim = this.neutral ? 0 : this.trim;
        const want = cycleBias(this.target, this.facts.addHeat) + trim;
        const out = fedValue({real: this.real.value, bias: want, comfortBias: trim, previousBias: this.slotBias, maxBias: this.limits.maxBias,
            maxCoastBias: this.limits.maxCoastBias, auto: this.facts.mode === 0, thresholds: this.facts.thresholds});
        const was = {bias: this.bias, stopped: this.stopState};
        if (mode === 'test') {
            if (this.holding) await this.handBack();
            this.settle(out);
        } else if (await this.feed(out.fed)) {
            this.holding = true;
            this.failures = 0;
            this.hooks.feeding(true);
            this.settle(out);
        } else if (++this.failures >= MAX_FAILED_CYCLES) {
            return this.halt('feed_failed');
        }
        if (was.bias !== this.bias || was.stopped !== this.stopState) this.hooks.changed();
    }

    private settle(out: ActuatorOutput) {
        this.bias = out.bias;
        this.lastFed = out;
        this.stopState = undefined;
        this.warn(undefined);
    }

    /** Write and check that input 1 follows. Never throws. */
    private async feed(celsius: number): Promise<boolean> {
        try {
            await this.hooks.write(celsius);
            for (let i = 0; i < VERIFY_TRIES; i++) {
                await this.hooks.sleep(VERIFY_GAP_MS);
                const seen = await this.hooks.readBack();
                if (seen !== undefined && Math.abs(seen - celsius) < 0.05) return true;
            }
        } catch (error: any) {
            this.hooks.log('Autopilot heating: feed failed:', error?.message ?? error);
        }
        return false;
    }

    /** Plan the slot; returns why it must wait instead, if it must. */
    private async replan(slot: number): Promise<StopReason | undefined> {
        this.facts = await this.hooks.pump();
        const input = this.hooks.plan(slot);
        this.limits = input ? liveLimits(this.hooks.limits(), input) : this.hooks.limits();
        if (!input) return this.learn(slot);
        this.learning = false;
        const wait = stopReason(this.facts, true);
        if (wait) return wait;
        this.slotBias = this.bias;
        // `input.curve` is the curve's view of what the pump saw (history `bt1`), our feed included.
        this.steer(slot, input.mean, input.house);
        // The planner aims at the thermostat (setpoint.ts): its band is setpoint ± range and its
        // expected path heads there. It plans the shift; the learned trim is under it.
        // Away with an end time: the setpoint steps back up there, and the plan warms ahead of it.
        const back = this.setpoint === undefined ? undefined : this.hooks.awayReturn?.();
        const comfort = this.setpoint === undefined ? undefined
            : planComfort(input!, this.limits, this.setpoint, slot, back, back !== undefined && this.warming() === back.at);
        const warming = warmingUp(comfort) ? back!.at : undefined;
        if (warming !== this.warmingFor) this.hooks.saveWarming?.(warming);
        this.warmingFor = warming;
        const plan = planLive({...input!, mean: this.setpoint ?? input!.mean, comfort, bias: this.bias - this.trim, previous: this.previous},
            this.limits, this.hooks.sunTrust());
        this.target = plan.biases[0];
        this.previous = plan.biases.slice(1);
        this.plan = {slot, biases: plan.biases, forecast: input!.forecast, reason: plan.reason, indoor: plan.plan.ti,
            back: warmingUp(comfort) ? back!.at : undefined};
        this.hooks.record({slot, bias: this.bias, trim: this.trim, setpoint: this.setpoint, fed: this.lastFed?.fed, real: this.real?.value,
            source: this.real?.source, clamped: this.lastFed?.clamped ?? [], planned: plan.biases.slice(0, 8), reason: plan.reason});
        this.hooks.planned?.(slot, input!.forecast, plan.plan.heat);
        this.hooks.changed();
        return undefined;
    }

    /** No plan yet: the model is learning. Room-sensor control is off from the day Autopilot is
     *  chosen, so the trim holds the setpoint from then, alone, with no price shift: otherwise the
     *  owner's curve, never set while that control held the house, would hold it alone for the
     *  days of learning (setpoint.ts). The pump's guards hold as with a plan. Waits without a
     *  setpoint or 12 h of indoor readings. */
    private async learn(slot: number): Promise<StopReason | undefined> {
        this.learning = false;
        const wait = stopReason(this.facts, true);
        if (wait) return wait;
        const mean = this.hooks.indoorMean?.(slot);
        if (mean === undefined) return 'no_model';
        this.slotBias = this.bias;
        this.steer(slot, mean, undefined);
        if (this.setpoint === undefined) return 'no_model';
        this.learning = true;
        this.target = 0;
        this.previous = undefined;
        this.plan = undefined;
        this.hooks.record({slot, bias: this.bias, trim: this.trim, setpoint: this.setpoint, fed: this.lastFed?.fed, real: this.real?.value,
            source: this.real?.source, clamped: this.lastFed?.clamped ?? [], planned: [], reason: 'learning'});
        this.hooks.changed();
        return undefined;
    }

    /** Move the trim for this slot (setpoint.ts). Live learns; Simulated holds the learned part.
     *  At most an hour counts, so a restart or a pause does not land as one big step. The learned
     *  part is stored when it moves; the recovery history lives in memory. */
    private steer(slot: number, mean: number, house: HouseParams | undefined) {
        const setpoint = this.hooks.setpoint?.();
        this.setpoint = setpoint !== undefined && Number.isFinite(setpoint) ? setpoint : undefined;
        if (this.setpoint === undefined) { this.trim = 0; return; }
        this.trimState ??= this.hooks.loadTrim?.() ?? {integral: 0};
        const hours = this.trimSlot === undefined ? 0 : Math.min(1, Math.max(0, (slot - this.trimSlot) * 0.25));
        // While learning the house's time constant is not known yet: the default's (setpoint.ts).
        const next = nextTrim(this.trimState, {setpoint: this.setpoint, mean, hours,
            integrate: this.hooks.mode() === 'live', tauHours: house && envelopeTau(house)});
        this.trimSlot = slot;
        this.trim = Math.round(next.trim * 10) / 10;
        const moved = next.state.integral !== this.trimState.integral;
        this.trimState = next.state;
        if (moved) this.hooks.saveTrim?.({integral: next.state.integral});
    }

    private warn(reason?: StopReason) {
        if (reason === undefined && !this.warned) return;
        this.warned = reason !== undefined;
        this.hooks.warn(reason);
    }

    /** Not feeding for a reason that clears by itself: hand BT1 back, keep checking. */
    private async idle(reason: StopReason) {
        if (this.stopState === reason) return;
        const first = this.stopState === undefined;
        this.stopState = reason;
        this.learning = false;
        this.bias = 0;
        this.target = 0;
        this.plan = undefined;
        this.hooks.record({slot: slotOf(this.hooks.now()), bias: 0, clamped: [], planned: [], stopped: reason});
        this.warn(reason);
        if (first || this.holding) this.hooks.log(`Autopilot heating: waiting (${reason}).`);
        await this.handBack();
        this.hooks.changed();
    }

    /** End the feed: the setting turned off, or the pump stopped taking the value. */
    private async halt(reason: StopReason) {
        if (this.stopped) return;
        this.hooks.record({slot: slotOf(this.hooks.now()), bias: this.bias, clamped: [], planned: [], stopped: reason});
        if (reason === 'feed_failed') this.warn(reason);
        // Not awaited inside the cycle that is itself `work`: stop() waits for `work`.
        const stopping = this.stop(reason);
        if (!this.work) await stopping;
    }
}
