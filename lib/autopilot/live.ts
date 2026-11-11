/** Autopilot heating, live test build: shift-only. The owner's heat curve and offset keep the
 *  house's level; Autopilot only moves heat in time (more before expensive hours, less during
 *  them) by feeding BT1 (5217) a little colder or warmer than the real outdoor temperature.
 *
 *  Why shift-only first: the comfort bias (trim.ts) rests on the house model's steady level,
 *  which the +6 run has not confirmed (tasks/todo.md, 2026-11-11). Price shifting does not: with
 *  `pump = {lever}` the planner takes the curve as holding the temperature and only plans the
 *  shift (planner.ts `pumpHeat`), and comfort is the house's own 24 h mean, not the setpoint.
 *
 *  A maintainer's dev build: switched by the app setting `autopilotLive.<heating device id>`
 *  ('off' | 'shift'), with no owner UI. Design: docs/autopilot-plan.md §4.1, §7.2, §7.6. */
import {ActuatorOutput, PumpThresholds, fedValue} from './actuator';
import {HouseParams} from './model';
import {ForecastBias, OutdoorReading, realOutdoor} from './outdoor';
import {ForecastSlot, Plan, planShift} from './planner';
import {Limits} from './presets';
import {slotOf} from './prices';

export type LiveMode = 'off' | 'shift';
export const liveSettingName = (deviceId: string) => `autopilotLive.${deviceId}`;
export function liveMode(value: unknown): LiveMode {
    return value === 'shift' ? 'shift' : 'off';
}

/** The test's limits: a small, symmetric shift (±3 K of fed outdoor, ~0.35 kW on the S1155),
 *  coasts of at most 3 h, and indoor within ±0.5 K of where the curve keeps it. Price influence
 *  as Save some; no weather feed-forward (the sun term is part of what is unproven). */
export const LIVE_LIMITS: Limits = {
    lower: 0.5, upper: 0.5, margin: 0.39, forecastTrust: 0, maxCoastH: 3, preheatLeadTau: 0.3,
    maxBias: 3, maxCoastBias: 3, comfortWeight: 1.4,
};

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

export type StopReason = 'mode_off' | 'no_model' | 'immersion_only' | 'spa_on' | 'room_control' | 'no_outdoor'
    | 'feed_failed';

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
    /** A device warning, or undefined to clear it. */
    warn(message?: string): void;
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

    constructor(private readonly hooks: FeedHooks) {}

    get running() { return !this.stopped; }
    get state() { return {bias: this.bias, target: this.target, fed: this.lastFed?.fed, stopped: this.stopState}; }

    start() {
        if (!this.stopped) return;
        this.stopped = false;
        this.stopState = undefined;
        this.failures = 0;
        // Replan (and so re-check every guard) before the first write, even within a slot.
        this.plannedSlot = undefined;
        this.warn(undefined);
        this.hooks.log('Autopilot heating (shift-only test): started.');
        this.schedule(0);
    }

    /** Stop feeding and hand BT1 back: one last feed of the real outdoor temperature, so the
     *  pump does not hold a shifted value for the ~5 min a write lasts. */
    async stop(reason: StopReason = 'mode_off') {
        if (this.stopped && this.stopState) return;
        const wasRunning = !this.stopped;
        this.stopped = true;
        this.stopState = reason;
        if (this.timer) this.hooks.clearTimeout(this.timer);
        this.timer = undefined;
        if (this.work) await this.work.catch(() => undefined);
        this.hooks.feeding(false);
        if (wasRunning && this.real?.value !== undefined) {
            await Promise.race([this.hooks.write(this.real.value), this.hooks.sleep(5000)])
                .catch((error: any) => this.hooks.log('Autopilot heating: the last neutral feed failed:', error?.message ?? error));
        }
        this.bias = 0;
        this.hooks.log(`Autopilot heating: stopped (${reason}).`);
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

    /** One 30 s cycle: replan when a new slot started, then feed and verify. */
    async cycle() {
        if (this.stopped) return;
        if (this.hooks.mode() !== 'shift') return this.halt('mode_off');
        const now = this.hooks.now();
        const slot = slotOf(now);
        if (slot !== this.plannedSlot) await this.replan(slot);
        if (this.stopped) return;

        const o = this.hooks.outdoor();
        this.real = realOutdoor({now, feeding: true, sensor: o.sensor, forecast: o.forecast, localHour: o.localHour,
            bias: o.bias, degradedSince: this.degradedSince});
        this.degradedSince = this.real.degradedSince;
        if (this.real.value === undefined || this.real.goNeutral) return this.halt('no_outdoor');

        const want = cycleBias(this.target, this.facts.addHeat);
        const out = fedValue({real: this.real.value, bias: want, previousBias: this.slotBias, maxBias: LIVE_LIMITS.maxBias,
            maxCoastBias: LIVE_LIMITS.maxCoastBias, auto: this.facts.mode === 0, thresholds: this.facts.thresholds});
        const ok = await this.feed(out.fed);
        if (ok) {
            this.failures = 0;
            this.bias = out.bias;
            this.lastFed = out;
            this.hooks.feeding(true);
            this.warn(undefined);
        } else if (++this.failures >= MAX_FAILED_CYCLES) {
            this.warn('Autopilot heating stopped: the pump did not take the outdoor temperature (menu 7.5.9.2?).');
            return this.halt('feed_failed');
        }
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

    private async replan(slot: number) {
        this.plannedSlot = slot;
        this.facts = await this.hooks.pump();
        const input = this.hooks.plan(slot);
        const stop = stopReason(this.facts, input !== undefined);
        if (stop) return this.halt(stop);
        this.slotBias = this.bias;
        // `input.curve` is the curve's view of what the pump saw (history `bt1`), our feed included.
        const plan = planLive({...input!, bias: this.bias, previous: this.previous});
        this.target = plan.biases[0];
        this.previous = plan.biases.slice(1);
        this.hooks.record({slot, bias: this.bias, fed: this.lastFed?.fed, real: this.real?.value, source: this.real?.source,
            clamped: this.lastFed?.clamped ?? [], planned: plan.biases.slice(0, 8), reason: plan.reason});
    }

    private warn(message?: string) {
        if (message === undefined && !this.warned) return;
        this.warned = message !== undefined;
        this.hooks.warn(message);
    }

    private async halt(reason: StopReason) {
        if (this.stopped) return;
        this.hooks.record({slot: slotOf(this.hooks.now()), bias: this.bias, clamped: [], planned: [], stopped: reason});
        if (reason !== 'mode_off' && reason !== 'feed_failed')
            this.warn(`Autopilot heating stopped: ${reason.replace(/_/g, ' ')}.`);
        // Not awaited inside the cycle that is itself `work`: stop() waits for `work`.
        const stopping = this.stop(reason);
        if (!this.work) await stopping;
    }
}
