/** The orchestrator: one compressor, two plans. Design: docs/autopilot-plan.md §2.1, §7.6.
 *
 *  The pump runs heating and hot water one at a time (priority, 1028), so each Autopilot plans
 *  around the other. Hot water plans first; its charges reach heating as slots in which heating
 *  delivers nothing (`deliveryFree`), so heating pre-heats around them. Heating's pre-heats reach
 *  hot water as a price on top of those slots (`preheatAdders`), so a charge lands in one only
 *  when it must: to keep the reserve, or to meet a draw that comes before any slot outside one.
 *  The safety net (the rescue charge) wins over all of it: the hot water planner starts it
 *  whatever a slot costs or reserves.
 *
 *  It never writes to the pump. The pure functions below take plans and return slot sets; the
 *  per-host registry (`PumpRound`) holds the latest plan of each controller, which the devices
 *  publish after each replan. A bug here can make a plan worse, never a write wrong. */

import {SLOT_MS} from './prices';

/** A hot water charge in the plan in force, by start time and length. */
export interface PlannedCharge {
    at: number;
    minutes: number;
}

/** Heating's plan: the slot it starts at and the outdoor bias per slot (pre-heat positive,
 *  planner.ts). Live heating plans shift-only, so the bias is the price and weather shift. */
export interface HeatingPlan {
    slot: number;
    biases: number[];
}

/** A stretch of heating's plan: `preheat` heats ahead (bias above 0), `ease` eases off (below). */
export interface HeatingWindow {
    kind: 'preheat' | 'ease';
    /** First slot, and the slot after the last. */
    start: number;
    end: number;
}

/** Slots `from` … `from + n − 1` a charge holds the compressor in, slot by slot. */
export function deliveryFree(charges: PlannedCharge[], from: number, n: number): boolean[] {
    return Array.from({length: n}, (_, k) => charges.some((c) => (from + k) * SLOT_MS < c.at + c.minutes * 60_000
        && (from + k + 1) * SLOT_MS > c.at));
}

/** How long after a start heating may plan on hot water's stored charges, ms: hot water's
 *  first plan lands within a slot, so past this a missing plan is hot water not planning, and
 *  old charges would only mislead. */
export const SAVED_CHARGES_MS = 30 * 60_000;

/** The busy slots heating plans on while the round has no hot water plan: hot water's charges as
 *  it last published them, right after a start only (`SAVED_CHARGES_MS`); else none. Pure. */
export function savedBusy(saved: PlannedCharge[] | undefined, from: number, n: number, sinceStartMs: number): boolean[] | undefined {
    return saved && sinceStartMs < SAVED_CHARGES_MS ? deliveryFree(saved, from, n) : undefined;
}

/** Heating's pre-heat and ease-off stretches from slot `from` on, in time order. */
export function heatingWindows(plan: HeatingPlan, from: number): HeatingWindow[] {
    const out: HeatingWindow[] = [];
    plan.biases.forEach((bias, k) => {
        const slot = plan.slot + k;
        const kind = bias > 0 ? 'preheat' : bias < 0 ? 'ease' : undefined;
        if (slot < from || !kind) return;
        const last = out[out.length - 1];
        if (last && last.kind === kind && last.end === slot) last.end = slot + 1;
        else out.push({kind, start: slot, end: slot + 1});
    });
    return out;
}

/** The slots heating pre-heats in, from `from`, that hot water should keep its charges out of.
 *  The slots of hot water's own planned charges are left out: heating planned around those, and
 *  counting the bias it holds through them against the charge would push the charge out of the
 *  very slots heating made room for, and the two plans would chase each other. */
export function preheatSlots(plan: HeatingPlan, charges: PlannedCharge[], from: number): Set<number> {
    const out = new Set<number>();
    for (const w of heatingWindows(plan, from)) if (w.kind === 'preheat')
        for (let slot = w.start; slot < w.end; slot++) out.add(slot);
    const busy = deliveryFree(charges, from, plan.slot + plan.biases.length - from);
    busy.forEach((b, k) => { if (b) out.delete(from + k); });
    return out;
}

/** The smallest adder, per kWh: so a pre-heat slot still loses a tie on flat prices. */
const MIN_ADDER = 0.01;

/** Per slot of hot water's horizon, a price on top of each kWh charged there: the horizon's
 *  price spread inside a pre-heat, 0 elsewhere. With it, any slot outside a pre-heat is cheaper
 *  than any slot inside one, so price alone never puts a charge in a pre-heat; the reserve and a
 *  draw that cannot wait still can, since the planner's shortfall costs far more. §2.1's
 *  tie-break (hard floors before comfort before cost) in one number. */
export function preheatAdders(slots: number[], prices: number[], preheat: Set<number> | undefined): number[] {
    if (!preheat?.size || !slots.some((s) => preheat.has(s))) return slots.map(() => 0);
    const spread = Math.max(...prices) - Math.min(...prices);
    const adder = Math.max(MIN_ADDER, Number.isFinite(spread) ? spread : 0);
    return slots.map((s) => preheat.has(s) ? adder : 0);
}

/** One thing the pump does next, for Main's status line. */
export type StatusEvent =
    | {kind: 'hotwater'; at: number; now: boolean}
    | {kind: 'preheat' | 'ease'; at: number; until: number};

/** Up to two coming events, in time order: hot water's charges and heating's stretches. A charge
 *  running now comes first. Pure. */
export function statusEvents(charges: PlannedCharge[] | undefined, heating: HeatingPlan | undefined, now: number): StatusEvent[] {
    const slot = Math.floor(now / SLOT_MS);
    const events: StatusEvent[] = [];
    for (const c of charges ?? []) {
        const end = c.at + c.minutes * 60_000;
        if (end <= now) continue;
        events.push({kind: 'hotwater', at: Math.max(c.at, slot * SLOT_MS), now: c.at <= now});
    }
    if (heating) for (const w of heatingWindows(heating, slot))
        events.push({kind: w.kind, at: w.start * SLOT_MS, until: w.end * SLOT_MS});
    // A running charge first, then by start: a charge and a stretch starting together read
    // charge first, since the charge is what holds the compressor.
    const rank = (e: StatusEvent) => e.kind === 'hotwater' && e.now ? -1 : e.at;
    return events.sort((a, b) => rank(a) - rank(b) || (a.kind === 'hotwater' ? -1 : b.kind === 'hotwater' ? 1 : 0)).slice(0, 2);
}

export type Translate = (key: string, tokens?: Record<string, string | number>) => string;

/** What Main's status line reads. */
export interface MainStatus {
    events: StatusEvent[];
    /** The orchestrator failed this round: each controller plans on its own. */
    failed?: boolean;
    /** Every controller that published is a test run. */
    simulated?: boolean;
}

/** Main's status line, worded through `t` (keys under `autopilot.orchestrator`). `when` gives a
 *  local time ("tomorrow 06:00" when not today), `span` a stretch ("17–20"). Pure. */
export function mainStatusText(s: MainStatus, t: Translate, when: (ms: number) => string,
                               span: (from: number, to: number) => string): string {
    const phrase = (e: StatusEvent, form: 'first' | 'then') => e.kind === 'hotwater'
        ? e.now ? t(`${form}.hotwater_now`) : t(`${form}.hotwater`, {time: when(e.at)})
        : t(`${form}.${e.kind}`, {span: span(e.at, e.until)});
    const text = s.failed ? t('failed')
        : s.events.length ? s.events.map((e, i) => phrase(e, i ? 'then' : 'first')).join(', ')
            : t('none');
    return s.simulated ? t('test', {text}) : text;
}

/** A stretch as hours where it starts and ends on the hour ("17–20"), else as times
 *  ("16:45–20:00"). `time` gives a local HH:MM. Pure. */
export function spanText(from: number, to: number, time: (ms: number) => string): string {
    const a = time(from), b = time(to);
    return a.endsWith(':00') && b.endsWith(':00') ? `${a.slice(0, -3)}–${b.slice(0, -3)}` : `${a}–${b}`;
}

interface Published<T> {
    plan: T;
    simulated: boolean;
}

/** The plan round of one pump: the latest plan of each controller and what each must plan
 *  around. One per host, beside `autopilotOwners` (§7.6), never inside `PumpConnection`. Holds no
 *  model of a house or a tank. Every answer is computed under a guard: if it throws, the
 *  controllers plan with no reservations and Main says so (§2.1 "Failure and neutral"). */
export class PumpRound {
    private static rounds = new Map<string, PumpRound>();

    /** The round for `host`, made on first use. */
    static for(host: string): PumpRound {
        let round = PumpRound.rounds.get(host);
        if (!round) PumpRound.rounds.set(host, round = new PumpRound());
        return round;
    }

    private hotwater?: Published<PlannedCharge[]>;
    private heating?: Published<HeatingPlan>;
    private listeners = new Set<() => void>();
    private heatingListeners = new Set<() => void>();
    /** The answers whose last try threw; each is cleared by its next that works. */
    private failures = new Set<string>();

    /** Whether any answer failed its last try: a controller is planning on its own. */
    get failed(): boolean { return this.failures.size > 0; }

    /** Hot water's planned charges after a replan, or undefined when it stops. Heating hears of
     *  it when the slots it loses change, so it replans around them within the slot: §2.1's
     *  order, hot water first. */
    setHotwater(charges: PlannedCharge[] | undefined, simulated = false) {
        const before = JSON.stringify(this.hotwater?.plan);
        this.hotwater = charges && {plan: charges.map((c) => ({at: c.at, minutes: c.minutes})), simulated};
        if (JSON.stringify(this.hotwater?.plan) !== before) this.heatingListeners.forEach((fn) => fn());
        this.listeners.forEach((fn) => fn());
    }

    /** Heating's plan after a replan, or undefined when it stops. */
    setHeating(plan: HeatingPlan | undefined, simulated = false) {
        const next = plan && {slot: plan.slot, biases: [...plan.biases]};
        if (JSON.stringify(next) === JSON.stringify(this.heating?.plan) && simulated === this.heating?.simulated) return;
        this.heating = next && {plan: next, simulated};
        this.listeners.forEach((fn) => fn());
    }

    /** Called when anything Main shows changes. Returns the unsubscribe. */
    onChange(fn: () => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    /** Called when hot water's charges move: heating should replan. Returns the unsubscribe. */
    onCharges(fn: () => void): () => void {
        this.heatingListeners.add(fn);
        return () => this.heatingListeners.delete(fn);
    }

    /** For heating: per slot from `from`, whether a charge holds the compressor. */
    deliveryFree(from: number, n: number): boolean[] | undefined {
        return this.guard('deliveryFree', () => this.hotwater ? deliveryFree(this.hotwater.plan, from, n) : undefined);
    }

    /** For hot water: the slots from `from` heating pre-heats in, its charges' own left out. */
    preheat(from: number): Set<number> | undefined {
        return this.guard('preheat', () => this.heating ? preheatSlots(this.heating.plan, this.hotwater?.plan ?? [], from) : undefined);
    }

    /** What Main's status line reads at `now`, or undefined while no controller has a plan. */
    status(now: number): MainStatus | undefined {
        if (!this.hotwater && !this.heating) return undefined;
        const events = this.guard('status', () => statusEvents(this.hotwater?.plan, this.heating?.plan, now));
        const published = [this.hotwater, this.heating].filter((p) => p !== undefined);
        return {events: events ?? [], failed: this.failed || undefined,
            simulated: published.every((p) => p!.simulated) || undefined};
    }

    private guard<T>(name: string, fn: () => T): T | undefined {
        try {
            const out = fn();
            this.failures.delete(name);
            return out;
        } catch {
            this.failures.add(name);
            return undefined;
        }
    }
}
