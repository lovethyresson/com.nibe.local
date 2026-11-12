/** Autopilot heating, shift-only. The owner's heat curve and offset keep the
 *  house's level; Autopilot only moves heat in time (more before expensive hours, less during
 *  them) by feeding BT1 (5217) a little colder or warmer than the real outdoor temperature.
 *
 *  Why shift-only first: the comfort bias (trim.ts) rests on the house model's steady level,
 *  which the +6 run has not confirmed (tasks/todo.md, 2026-11-11). Price shifting does not: with
 *  `pump = {lever}` the planner takes the curve as holding the temperature and only plans the
 *  shift (planner.ts `pumpHeat`), and comfort is the house's own 24 h mean, not the setpoint.
 *
 *  Switched by the pump-wide device setting `priceHeating` (Price control): `test` plans and reports
 *  without writing, `autopilot` feeds. Design: docs/autopilot-plan.md §4.1, §7.2, §7.6, §10.0. */
import {ActuatorOutput, PumpThresholds, fedValue} from './actuator';
import {HouseParams} from './model';
import {ForecastBias, OutdoorReading, realOutdoor} from './outdoor';
import {ForecastSlot, Plan, planShift} from './planner';
import {Limits, PresetId} from './presets';
import {slotOf} from './prices';

/** `test` plans and reports without writing; `live` feeds BT1; `paused` is a live feed the owner
 *  paused (Flow), which hands BT1 back until it resumes. */
export type LiveMode = 'off' | 'test' | 'live' | 'paused';
/** The heating Price control value (`priceHeating`) as a feed mode. */
export function liveMode(priceHeating: unknown): LiveMode {
    return priceHeating === 'autopilot' ? 'live' : priceHeating === 'test' ? 'test' : 'off';
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
}

/** The shift-only plan: the curve holds the house (no comfort bias), sun left out. */
export function planLive(input: ShiftInput, limits: Limits = LIVE_LIMITS): Plan {
    const forecast = input.forecast.map((s) => ({te: s.te, sun: 0, price: s.price}));
    return planShift(input.house, input.mean, {ti: input.ti, tm: input.tm, curve: input.curve, bias: input.bias},
        forecast, limits, {lever: input.lever}, input.previous);
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
}

/** Why the feed is not feeding. `mode_off` and `feed_failed` end it (the owner turns it on again,
 *  or re-verifies); the rest are waits it re-checks every slot (`no_outdoor` every cycle) and
 *  leaves by itself. */
export type StopReason = 'mode_off' | 'feed_failed' | 'no_model' | 'immersion_only' | 'spa_on' | 'room_control'
    | 'no_outdoor' | 'paused';

/** Reasons the feed must not run at all; undefined when it may. */
export function stopReason(facts: PumpFacts, haveModel: boolean): StopReason | undefined {
    if (!haveModel) return 'no_model';
    if (facts.mode === 2) return 'immersion_only';
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
    /** The model and forecast for the slot about to start; undefined without them. */
    plan(slot: number): ShiftInput | undefined;
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
    log(...args: any[]): void;
    /** One record per slot for the shadow log. */
    record(entry: LiveEntry): void;
    setTimeout(fn: () => void, ms: number): any;
    clearTimeout(timer: any): void;
    sleep(ms: number): Promise<void>;
    now(): number;
}

export interface LiveEntry {
    slot: number;
    bias: number;
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
    private plan?: {slot: number; biases: number[]; forecast: ForecastSlot[]; reason?: string};

    constructor(private readonly hooks: FeedHooks) {}

    get running() { return !this.stopped; }
    get state(): FeedSnapshot {
        return {mode: this.stopped ? 'off' : this.hooks.mode(), bias: this.bias, target: this.target, fed: this.lastFed?.fed,
            real: this.real?.value, stopped: this.stopState, slot: this.plan?.slot, biases: this.plan?.biases,
            forecast: this.plan?.forecast, planReason: this.plan?.reason};
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

    /** Stop and hand BT1 back: one last feed of the real outdoor temperature, so the pump does
     *  not hold a shifted value for the ~5 min a write lasts. */
    async stop(reason: StopReason = 'mode_off') {
        if (this.stopped && this.stopState) return;
        this.stopped = true;
        this.stopState = reason;
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
                .finally(() => { this.work = null; this.schedule(FEED_EVERY_MS); });
        }, ms);
    }

    /** One 30 s cycle: replan when a new slot started, then feed and verify (live) or only work
     *  out what it would feed (test). */
    async cycle() {
        if (this.stopped) return;
        const mode = this.hooks.mode();
        if (mode === 'off') return this.halt('mode_off');
        if (mode === 'paused') return this.idle('paused');
        // Resumed: plan now rather than at the next slot.
        if (this.stopState === 'paused') this.plannedSlot = undefined;
        const now = this.hooks.now();
        const slot = slotOf(now);
        if (slot !== this.plannedSlot) {
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

        const want = cycleBias(this.target, this.facts.addHeat);
        const out = fedValue({real: this.real.value, bias: want, previousBias: this.slotBias, maxBias: this.limits.maxBias,
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
        this.limits = this.hooks.limits();
        const input = this.hooks.plan(slot);
        const wait = stopReason(this.facts, input !== undefined);
        if (wait) return wait;
        this.slotBias = this.bias;
        // `input.curve` is the curve's view of what the pump saw (history `bt1`), our feed included.
        const plan = planLive({...input!, bias: this.bias, previous: this.previous}, this.limits);
        this.target = plan.biases[0];
        this.previous = plan.biases.slice(1);
        this.plan = {slot, biases: plan.biases, forecast: input!.forecast, reason: plan.reason};
        this.hooks.record({slot, bias: this.bias, fed: this.lastFed?.fed, real: this.real?.value, source: this.real?.source,
            clamped: this.lastFed?.clamped ?? [], planned: plan.biases.slice(0, 8), reason: plan.reason});
        this.hooks.changed();
        return undefined;
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
        this.bias = 0;
        this.target = 0;
        this.plan = undefined;
        this.hooks.record({slot: slotOf(this.hooks.now()), bias: 0, clamped: [], planned: [], stopped: reason});
        if (reason !== 'paused') this.warn(reason);
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
