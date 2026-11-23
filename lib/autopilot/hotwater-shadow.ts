/** Hot water Autopilot: every 15 minutes, plan from the tank as it is and log what the planner
 *  does. As a test run it only reports; live it also starts the planned charges through
 *  hotwater-lever.ts, the only writes. Design: docs/autopilot-hot-water.md §5 (slices 3 and 4).
 *
 *  Standalone on purpose. Hot water is likely to ship before heating, so it does not wait for the
 *  collector split (autopilot-plan.md, shared inputs): it learns from the device's own Insights,
 *  which already hold the tank's history, and fetches prices itself. When the split lands, the
 *  price fetch moves to the home service and the tank fields to the per-pump history. */
import {localeTime} from '../intl';
import {withApi} from '../indoor-sensors';
import {DayPrices, PriceSlot, SLOT_MS, localDate, nextPriceFetchMs, slotOf} from './prices';
import {pricesFor} from '../gateway-prices';
import {PRIORITY} from '../gateway';
import {DayDraw, DayProfile, DayType, EVENING_FROM, EVENING_TO, HotwaterModel, Household, KWH_PER_LITRE, LocalClock, MORNING_FROM, MORNING_TO, TankPoint, chargeRate, drawsByHour, intervals, learn, localClock, lossAt, morningEvening, profileFor, similarEvening, weekdayOf} from './hotwater-learner';
import {TankCapabilities, fetchTankInsights, pointsFromInsights} from './hotwater-insights';
import {DEFAULT_RESERVE_LITRES, EARLY_DRAW_HOURS, MIN_CHARGE_KWH, Plan, SLOT_H, TankSpec, creditEarly, drawsFor, heatAt, plan, plannedHours, reserveKwh} from './hotwater-planner';
import {preheatAdders} from './orchestrator';
import {appendLine, daysLogName, deleteHistory, loadJson, modelFileName, saveJson, shadowLogName, trimLines} from './store-file';
import {DAYS_KEPT, DayAcc, EveningForecast, LateEvening, daySample} from './hotwater-days';
import {DayTypeState, dayTypeAt} from './day-type';
import {DEMAND_LARGE, MAX_RESCUE_STARTS_PER_DAY, MAX_STOP_WRITES_PER_DAY, PumpFacts, countFor, leverDecision} from './hotwater-lever';
import {BOOST_HOURS, LegionellaState, NOTE_EVERY_MS, REACHED_K, legionellaStep, noteTop, readState} from './legionella';
import {BlockedBy, Edge, TankDay, hotwaterDayScore, leverBlock, tankDayUpdate} from './analytics';
import {Ceiling, CeilingObservation, ChargeWatch, DEFAULT_CEILING_C, ONSET_MIN_C, PollReading, ceilingFromHistory, learnCeiling,
    mergeObservations, targetCap, watchCharge} from './hotwater-ceiling';

const HOUR = 3_600_000;
/** Lowest and highest target the shadow plans with (doc §4.2). The highest is a margin under
 *  where the compressor gives up, learned per pump (hotwater-ceiling.ts); MAX_C is the cap before
 *  anything is learned. On the S1155 the compressor stops near 58 °C (alarm 216 or 382) and the
 *  immersion heater finishes the rest at a third of the COP (docs/hot-water-heat-accounting.md).
 *  Below that the learned rate (hotwater-learner.ts `chargeRate`) already makes the last degrees
 *  slow and dear. */
export const MIN_C = 45;
export const MAX_C = targetCap(DEFAULT_CEILING_C);
/** A plan needs at least two hours of known prices. */
export const MIN_HORIZON = 8;
/** Local hour the morning plan is sent. */
export const DAILY_HOUR = 7;
/** Hours ahead each log line predicts the tank for. */
export const COAST_HOURS = 12;
/** Log lines kept: 28 days of slots. */
const KEEP = 28 * 96;
/** The model is relearned this often from Insights. */
const LEARN_EVERY_MS = 6 * HOUR;
/** A learn that found too few readings tries again after this. */
const LEARN_RETRY_MS = 15 * 60_000;
/** A saved model resumed at start must be this fresh: the relearn replaces it within minutes. */
const MODEL_KEEP_MS = 2 * 24 * HOUR;

/** The tank as the device reads it now. Any field can be missing (a capability not selected). */
export interface TankNow {
    litres?: number;
    top?: number;
    /** Electricity the allocator gives hot water now, W: above 0 while the pump charges the tank. */
    powerW?: number;
    /** More hot water (697) is on: the charge ends at the Large stop. */
    more?: boolean;
    /** The stop of the demand mode in force (56), °C: where a charge the pump started ends. */
    stopC?: number;
    largeStopC?: number;
    /** Hot water heat produced, the kWh counter: what the tank widget reads the day's use from. */
    produced?: number;
}

export interface ShadowStepInput {
    /** The slot to plan from. */
    slot: number;
    /** Buy price per kWh, and spot: what an exported kWh earns, near enough. */
    prices: Map<number, {price: number; spot?: number}>;
    /** Expected export per slot, kW: the live reading for the next half hour, the forecast after. */
    surplus?: Map<number, number>;
    model?: HotwaterModel;
    now: TankNow;
    tank: TankSpec;
    clock: LocalClock;
    dayType?: DayType;
    /** The day type of each slot ahead, when it differs from `dayType` by day (the calendar's
     *  weekend); without it every slot is `dayType`. */
    dayTypeOf?: (ms: number) => DayType;
    reserveLitres?: number;
    /** The highest target, °C: under the learned ceiling (hotwater-ceiling.ts). MAX_C without one. */
    maxC?: number;
    /** Start of the charge the last slot's plan had next (ms): due once this slot reaches it. */
    dueAt?: number;
    /** kWh heat drawn in the last EARLY_DRAW_HOURS beyond what was planned for them (`drawnEarly`):
     *  taken off the draws the plan expects next (`creditEarly`). Not passed live yet: the log
     *  records what the plan would do with it (`ShadowEntry.withEarly`) until two weeks of
     *  Autopilot's own days show it is safe (2026-11-17: a busy Saturday read as early draws held
     *  the tank at 35–56 L for an afternoon). */
    early?: number;
    /** The slots heating pre-heats in (orchestrator.ts `PumpRound.preheat`): a charge goes
     *  there only when it must. */
    preheat?: Set<number>;
}

export interface ShadowEntry {
    slot: number;
    at: string;
    litres: number;
    top?: number;
    charging: boolean;
    horizon: number;
    /** What the planner would do in this slot. */
    action: 'rescue' | 'start' | 'running' | 'wait';
    /** The first charge it plans, now or later. */
    next?: {at: string; targetC: number; heat: number; cost: number};
    cost: number;
    shortfall: number;
    /** Litres predicted 1, 2, … COAST_HOURS h from `at` if nothing charges: the planned draws and
     *  standing loss alone. Scored against the litres read then, over stretches with no real
     *  charge, by dev/review-hotwater-shadow.mjs (the go-live check, doc §6). A plan's own
     *  charges cannot be scored in a test run, since the pump's charges are what happen. */
    coast?: number[];
    /** Hot water heat produced, the kWh counter: with the litres, the draws of a slot that charged. */
    produced?: number;
    /** Litres drawn early (`drawnEarly`), and what the plan would do with them taken off the
     *  draws ahead (`creditEarly`). Logged only, from 3 L. */
    early?: number;
    withEarly?: {action: ShadowEntry['action']; next?: ShadowEntry['next']};
    /** What a replay needs to rebuild this slot's input (dev/replay-hot-water.mjs). */
    ctx?: SlotContext;
}

/** The slot's input beyond the tank: day type, buy price, the owner's minimum, the target cap,
 *  the pump's charge state and the day's lever writes so far. */
export interface SlotContext {
    dt?: string;
    price?: number;
    reserve?: number;
    maxC?: number;
    powerW?: number;
    more?: boolean;
    stopC?: number;
    largeStopC?: number;
    starts?: number;
    stops?: number;
    tank?: TankSpec;
}

/** A slot with no plan, and why: so a gap in the log is a reason, not a lost line. */
export interface ShadowSkip {
    slot: number;
    at: string;
    skip: string;
    litres?: number;
    top?: number;
    produced?: number;
    ctx?: SlotContext;
}

/** A slot's plan: the log line, the first charge after any running one, with its reason, and
 *  the end of the known prices (ms). */
export type ShadowStep = {entry: ShadowEntry; next?: ChargeFacts; until: number; stored: number[]; charges: ChargeFacts[]} | {skip: string};

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

type Planned = {slots: number[]; plan: Plan; charging: boolean; profile?: DayProfile; draws: number[]};

/** The plan from `input.slot` over the contiguous run of known prices, or why there is none. */
function planFrom(input: ShadowStepInput): Planned | {skip: string} {
    const {slot, now, model} = input;
    if (!model?.charge) return {skip: 'no model'};
    if (!Number.isFinite(now.litres)) return {skip: 'no reading'};
    const slots: number[] = [];
    for (let k = slot; input.prices.has(k); k++) slots.push(k);
    if (slots.length < MIN_HORIZON) return {skip: 'no prices'};
    const profile = profileFor(model, input.dayType);
    const times = slots.map((k) => input.clock(k * SLOT_MS));
    const draws = creditEarly(drawsFor(slots.map((k) => input.dayTypeOf ? profileFor(model, input.dayTypeOf(k * SLOT_MS)) : profile),
        times.map((c) => c.hour), undefined, times.map((c) => Math.floor((c.minute ?? 0) / 15))), input.early ?? 0);
    const charging = (now.powerW ?? 0) > 0;
    const adders = preheatAdders(slots, slots.map((k) => input.prices.get(k)!.price), input.preheat);
    const p = plan({
        slots: slots.map((k, j) => {
            const price = input.prices.get(k)!;
            return {price: price.price, draw: draws[j], surplusKw: input.surplus?.get(k), exportPrice: price.spot ?? 0,
                adder: adders[j] || undefined};
        }),
        stored: now.litres! * KWH_PER_LITRE, charging, runningTargetC: now.more ? now.largeStopC : now.stopC,
        topC: now.top, tank: input.tank, charge: model.charge, loss: model.loss,
        reserve: reserveKwh(input.reserveLitres ?? DEFAULT_RESERVE_LITRES), minC: MIN_C, maxC: input.maxC ?? MAX_C,
        due: input.dueAt !== undefined && input.dueAt <= slot * SLOT_MS,
    });
    return {slots, plan: p, charging, profile, draws};
}

/** kWh heat drawn in the `hours` before `at` beyond what the profiles planned for them, ≥ 0: a
 *  draw that came early, whose usual hour is still ahead (`creditEarly`). Pure. */
export function drawnEarly(points: TankPoint[], model: HotwaterModel, at: number, clock: LocalClock,
    profileAt: (ms: number) => DayProfile | undefined, hours = EARLY_DRAW_HOURS): number {
    const from = at - hours * HOUR;
    let drawn = 0;
    for (const i of intervals(points, model.loss, model.charge)) {
        const mid = i.start + i.hours * HOUR / 2;
        if (mid >= from && mid < at && i.hours <= 1.01 && Number.isFinite(i.draw)) drawn += i.draw;
    }
    let planned = 0;
    for (let ms = from; ms < at; ms += SLOT_MS) {
        const p = profileAt(ms);
        if (p) planned += plannedHours(p)[clock(ms).hour] * SLOT_H;
    }
    return Math.max(0, drawn - planned);
}

/** Litres at the end of each whole hour ahead with no charge: draws and standing loss only. */
export function coastLitres(storedKwh: number, draws: number[], loss: HotwaterModel['loss'], hours = COAST_HOURS): number[] {
    const out: number[] = [];
    let kwh = Math.max(0, storedKwh);
    for (let k = 0; k < Math.min(draws.length, hours * 4); k++) {
        kwh = Math.max(0, kwh - draws[k] - lossAt(loss, kwh) * SLOT_H);
        if (k % 4 === 3) out.push(round(kwh / KWH_PER_LITRE, 0));
    }
    return out;
}

/** How far back the tank widget looks: today from midnight, at any hour. */
const HISTORY_MS = 36 * HOUR;

/** Insights readings until the first live one, then the live ones, from `since`. Pure. */
export function mergeHistory(insights: TankPoint[], live: TankPoint[], since: number): TankPoint[] {
    const firstLive = live.length ? live[0].t : Infinity;
    return [...insights.filter((p) => p.t < firstLive), ...live].filter((p) => p.t >= since).sort((a, b) => a.t - b.t);
}

/** Heat produced faster than this, kWh/h, between two readings is a charge running. */
const CHARGING_KWH_PER_HOUR = 1;
/** A span that ran at least this share of its time charges throughout. */
const FULL_SPAN = 0.9;

/** The slots the tank was charging in since `since`: what the plan shows as done before the live
 *  record began (a restart, a fresh install). Insights keeps today in hourly buckets, so an hour
 *  that charged for part of it charged for that part, placed against its neighbour: at the start
 *  after a full hour, at the end before one (2026-11-15: a 10:15 start read as 09:30 when every
 *  hour that charged at all counted in full). The part is the hot water electricity over the
 *  charge's draw (`kw`): steady while it charges, where the heat a near-full tank takes falls to
 *  a third; the heat counter at `rate` (kWh/h) where the electricity is not logged. Readings more
 *  than an hour apart are left out. Pure. */
export function chargedSlots(points: TankPoint[], since: number, rate: number, kw?: number): number[] {
    type Span = {a: number; b: number; share: number};
    const spans: (Span | undefined)[] = [];
    for (let k = 1; k < points.length; k++) {
        const p = points[k - 1], q = points[k];
        const hours = (q.t - p.t) / 3_600_000;
        if (!(hours > 0 && hours <= 1.01)) { spans.push(undefined); continue; }
        const step = (field: 'used' | 'produced') => typeof p[field] === 'number' && typeof q[field] === 'number' ? q[field]! - p[field]! : NaN;
        const used = step('used'), produced = step('produced');
        const byPower = kw !== undefined && kw > 0 && used >= 0;
        const share = byPower ? used / (kw! * hours) : produced / (Math.max(rate, CHARGING_KWH_PER_HOUR) * hours);
        const charging = byPower ? share >= 0.1 : produced / hours >= CHARGING_KWH_PER_HOUR;
        spans.push(charging && Number.isFinite(share) ? {a: p.t, b: q.t, share: Math.min(1, share)} : undefined);
    }
    const full = (s?: Span) => s !== undefined && s.share >= FULL_SPAN;
    const out = new Set<number>();
    spans.forEach((s, k) => {
        if (!s || s.b <= since) return;
        let from = s.a, to = s.b;
        if (!full(s)) {
            const run = (s.b - s.a) * s.share;
            if (full(spans[k - 1]) && !full(spans[k + 1])) to = s.a + run;
            else if (full(spans[k + 1]) && !full(spans[k - 1])) from = s.b - run;
            else { from = (s.a + s.b - run) / 2; to = from + run; }
        }
        for (let slot = Math.round(Math.max(from, since) / SLOT_MS); slot * SLOT_MS < Math.round(to / SLOT_MS) * SLOT_MS; slot++) out.add(slot);
    });
    return [...out].sort((x, y) => x - y);
}

/** An extension must take the charge at least this much hotter, K, and save at least this much,
 *  kr, over the known prices: smaller gains are not worth a write to the pump. */
export const EXTEND_MIN_K = 1;
export const EXTEND_MIN_KR = 0.3;

/** A running More hot water charge (Autopilot's, to the Large stop) raised mid-charge: the plan
 *  made as if the charge could run past its stop, against the plan that ends it there. The pump
 *  follows a Large stop raised during a charge (S1155, 2026-11-15: 54 → 56 °C at 21:25, charged on
 *  to 56.1 °C, no immersion heater). Extend when that plan heats at least `EXTEND_MIN_K` hotter
 *  now, saves at least `EXTEND_MIN_KR` and leaves the tank no shorter; never above the highest
 *  target (`input.maxC`, under the learned ceiling). Pure. */
export function extendTarget(input: ShadowStepInput): {targetC: number; from: number; saves: number} | undefined {
    const now = input.now;
    if (!now.more || !((now.powerW ?? 0) > 0) || now.largeStopC === undefined) return undefined;
    const held = planFrom(input);
    const free = planFrom({...input, now: {...now, largeStopC: undefined}});
    if ('skip' in held || 'skip' in free) return undefined;
    const first = free.plan.charges[0];
    if (!first || first.start !== 0) return undefined;
    const targetC = Math.min(first.targetC, input.maxC ?? MAX_C);
    if (targetC < now.largeStopC + EXTEND_MIN_K) return undefined;
    const saves = held.plan.cost - free.plan.cost;
    if (saves < EXTEND_MIN_KR || free.plan.shortfall > held.plan.shortfall + 1e-6) return undefined;
    return {targetC, from: now.largeStopC, saves: round(saves)};
}

/** The charge to show as next: the one running now while the tank charges, else the first that
 *  has not started (a slot's grace, so one starting this slot still counts). Pure. */
export function nextCharge<C extends {at: number; minutes: number}>(charges: C[], now: number, charging: boolean): C | undefined {
    if (charging) {
        // A plan made mid-charge starts at the next slot: the tank charging now is that charge.
        const running = charges.find((c) => c.at <= now + SLOT_MS && now < c.at + c.minutes * 60_000);
        if (running) return running;
    }
    return charges.find((c) => c.at > now - SLOT_MS);
}

/** One slot's plan. Pure. */
export function hotwaterShadowStep(input: ShadowStepInput): ShadowStep {
    const out = planFrom(input);
    if ('skip' in out) return out;
    const {slots, plan: p, charging, draws} = out;
    const {slot, now} = input;
    const first = p.charges.find((c) => !(charging && c.start === 0));
    const iso = (k: number) => new Date(slots[k] * SLOT_MS).toISOString();
    const charges = chargesOf(input, out, Infinity).charges;
    const next = charges.find((c) => c.reason !== 'running');
    return {next, charges, until: (slots[slots.length - 1] + 1) * SLOT_MS, stored: p.stored, entry: {
        slot, at: iso(0), litres: round(now.litres!, 1), top: now.top, charging, horizon: slots.length,
        action: charging ? 'running' : p.rescue ? 'rescue' : p.startNow ? 'start' : 'wait',
        next: first && {at: iso(first.start), targetC: first.targetC, heat: round(first.heat), cost: round(first.cost)},
        cost: round(p.cost), shortfall: round(p.shortfall),
        coast: coastLitres(input.now.litres! * KWH_PER_LITRE, draws, input.model!.loss),
    }};
}

/** What the Hot water device's "Autopilot now" line says. */
export type HotwaterStatus =
    | {state: 'learning' | 'no_prices'}
    | {state: 'charging'; reason?: ChargeReason}
    | {state: 'planned'; next?: ChargeFacts; until: number; now: number};

/** The "Autopilot now" line, worded through `t` (keys under `autopilot.`). `when` gives a local
 *  time, with "tomorrow" when it is not today. Pure. */
export function hotwaterStatusText(s: HotwaterStatus, t: Translate, when: (ms: number) => string, shadow: boolean): string {
    const reason = (r: ChargeReason) => t(`hotwater_charge.reason.${r}`);
    const text = s.state === 'planned'
        ? s.next ? t(s.next.at <= s.now ? 'hotwater_status.starting' : 'hotwater_status.next',
            {time: when(s.next.at), target: s.next.targetC, reason: reason(s.next.reason)})
            : t('hotwater_status.none', {until: when(s.until)})
        : s.state === 'charging'
            ? s.reason && s.reason !== 'running' ? t('hotwater_status.charging_reason', {reason: reason(s.reason)})
                : t('hotwater_status.charging')
            : t(`hotwater_status.${s.state}`);
    return shadow ? t('hotwater_status.test', {text}) : text;
}

/** Why a charge is where it is. One vocabulary for the morning plan, the charge message and the
 *  morning recap, so a charge reads alike in all three. `pump`: the pump started it itself
 *  (its start temperature, or More hot water). A charge that is not the cheapest it could be says
 *  why it is not earlier: `before_use` (no cheaper hours before it; it is ready for a use), `room`
 *  (cheaper hours before it, but the tank had no room for it then), `loss` (room then, but the
 *  heat would have waited too long). `legionella`: the run to the legionella temperature, in the
 *  cheapest two hours before it is due (legionella.ts). */
export type ChargeReason = 'running' | 'reserve' | 'surplus' | 'cheap' | 'before_use' | 'room' | 'loss' | 'pump' | 'legionella';
/** The analytics value: `room` and `loss` are kinds of `before_use` (not the cheapest of their
 *  window), so `charge_reason` keeps the cross-app taxonomy's four values. */
export const trackedReason = (r: ChargeReason) => r === 'room' || r === 'loss' ? 'before_use' : r;

/** One planned charge, with the facts its wording needs. */
export interface ChargeFacts {
    at: number;
    targetC: number;
    /** Run length, minutes. */
    minutes: number;
    /** Mean buy price over the run, per kWh. */
    price: number;
    surplusShare: number;
    cost: number;
    reason: ChargeReason;
}

/** The plan's charges starting before `before` (ms), each with its reason, and the mean buy
 *  price over the slots before it. Pure. */
function chargesOf(input: ShadowStepInput, out: Planned, before: number): {charges: ChargeFacts[]; meanPrice: number} {
    const {slots, plan: p, charging} = out;
    const buy = (k: number) => input.prices.get(slots[k])!.price;
    const day = slots.filter((k) => k * SLOT_MS < before);
    /** Mean price of the cheapest `n` slots in [from, to): the best the run could have bought. */
    const best = (from: number, to: number, n: number) => {
        const window = [];
        for (let k = from; k < to; k++) window.push(buy(k));
        window.sort((x, y) => x - y);
        const take = window.slice(0, Math.max(1, n));
        return take.reduce((x, y) => x + y, 0) / take.length;
    };
    // "Cheap" when the run bought about as well as any run of its length could have, between the
    // previous charge and the end of the next one (or of the known prices): hours the next charge
    // buys in were there to buy, so a run at a peak just before a use is never "cheap" because
    // the cheap hours after it belong to another charge (2026-11-15, with draws at the hour's start); a run that had to reach
    // into dearer hours to be ready for the use that follows says so instead. Up to 2026-11-14 the
    // window ended at the run's own end, so a charge starting now was always "cheap": one started
    // at the day's 16:00 peak read "Cheapest hours". A charge starting now with the tank under the
    // safety net is the safety net's, rescue or not (a hot top only spares it the rescue).
    const under = (input.now.litres ?? Infinity) < (input.reserveLitres ?? DEFAULT_RESERVE_LITRES);
    const full = heatAt(input.tank, input.maxC ?? MAX_C);
    /** Why a run that is not the cheapest of its window is where it is. Its start as cheap as any
     *  hour before it: it starts in time and reaches into dearer hours to be ready for a use
     *  ('before_use'). Cheaper hours before its start with the tank too full then for the
     *  smallest charge worth starting (under the highest target): 'room'. Room then: the plan judged heat made
     *  then and kept until used to cost more than the price saved ('loss'). The owner reads 'loss'
     *  as "Best time for your use": the plan weighs the whole day at once, so naming one cost
     *  term as the cause would be a guess. */
    const dearer = (c: Plan['charges'][number], from: number): ChargeReason => {
        const earlier: number[] = [];
        for (let k = from; k < c.start; k++) if (buy(k) * 1.02 < buy(c.start)) earlier.push(k);
        if (earlier.length === 0) return 'before_use';
        return earlier.every((k) => full - p.stored[k] < MIN_CHARGE_KWH) ? 'room' : 'loss';
    };
    const charges = p.charges.filter((c) => slots[c.start] * SLOT_MS < before).map((c, i, all) => {
        let sum = 0;
        for (let k = c.start; k < c.end; k++) sum += buy(Math.min(k, slots.length - 1));
        const price = sum / Math.max(1, c.end - c.start);
        const from = i ? all[i - 1].end : 0;
        const reason: ChargeReason = charging && c.start === 0 ? 'running'
            : i === 0 && c.start === 0 && (p.rescue || under) ? 'reserve' : c.surplusShare >= 0.5 ? 'surplus'
            : price <= 1.02 * best(from, i + 1 < all.length ? all[i + 1].end : slots.length, c.end - c.start) + 1e-9
                ? 'cheap' : dearer(c, from);
        return {at: slots[c.start] * SLOT_MS, targetC: c.targetC, minutes: (c.end - c.start) * SLOT_MS / 60_000,
            price: round(price), surplusShare: round(c.surplusShare), cost: round(c.cost), reason};
    });
    return {charges, meanPrice: round(day.reduce((sum, k) => sum + input.prices.get(k)!.price, 0) / Math.max(1, day.length))};
}

/** The morning message's facts: what goes into the day's plan and what comes out. Pure data,
 *  so it can be logged, tested and worded in any language. */
export interface DailyPlan {
    /** Local date the message is for. */
    date: string;
    dayType?: DayType;
    /** Expected use, litres of 40 °C water: the learned day's mean and its 80th percentile. */
    useLitres?: number;
    useLitresP80?: number;
    nowLitres: number;
    top?: number;
    reserveLitres: number;
    /** Charges starting within the next 24 h (or the known prices, if shorter). */
    charges: ChargeFacts[];
    /** Mean buy price over the planned hours, per kWh. */
    meanPrice: number;
    cost: number;
    /** End of the known prices, ms. */
    until: number;
    /** The local dates of each charge and of the prices' last slot, to say "tomorrow". */
    chargeDates: string[];
    untilDate: string;
}

const DAY_MS = 24 * 3_600_000;

/** The morning plan. Pure. */
export function dailyPlan(input: ShadowStepInput): DailyPlan | {skip: string} {
    const out = planFrom(input);
    if ('skip' in out) return out;
    const {slots, profile} = out;
    const start = slots[0] * SLOT_MS;
    const {charges, meanPrice} = chargesOf(input, out, start + DAY_MS);
    return {
        date: input.clock(start).date, dayType: input.dayType,
        useLitres: profile && round(profile.daily / KWH_PER_LITRE, 0),
        useLitresP80: profile && round(profile.dailyP80 / KWH_PER_LITRE, 0),
        nowLitres: round(input.now.litres!, 0), top: input.now.top,
        reserveLitres: input.reserveLitres ?? DEFAULT_RESERVE_LITRES,
        charges, meanPrice,
        cost: round(charges.reduce((sum, c) => sum + c.cost, 0)),
        until: (slots[slots.length - 1] + 1) * SLOT_MS,
        chargeDates: charges.map((c) => input.clock(c.at).date),
        untilDate: input.clock(slots[slots.length - 1] * SLOT_MS).date,
    };
}

/** Translator: a locale key under `autopilot.hotwater_daily` and its `__token__` values. */
export type Translate = (key: string, tokens?: Record<string, string | number>) => string;

/** The morning message, worded through `t`. `time` gives a local HH:MM. */
export function dailyPlanText(d: DailyPlan, t: Translate, time: (ms: number) => string, currency: string,
                              shadow: boolean, recap: string[] = []): string {
    const money = (v: number) => `${v.toFixed(2)} ${currency}`.trim();
    // Yesterday, last night, then today: the plan gets its own heading once a recap comes first.
    // The decision first (what charges, when and why), then the use and the tank behind it. Prices
    // per kWh are in each charge's own message, not here.
    const lines = [t(`title.${d.dayType ?? 'any'}`), ...recap, ...recap.length ? [t('today_heading')] : []];
    if (d.dayType === 'away') lines.push(t('away'));
    if (d.charges.length === 0) lines.push(t('none'));
    const when = (ms: number, date: string) => t(date === d.date ? 'today' : 'tomorrow', {time: time(ms)});
    for (const [i, c] of d.charges.entries()) {
        const reason = c.reason === 'surplus' ? t('reason.surplus', {share: Math.round(c.surplusShare * 100)})
            : t(`reason.${c.reason}`);
        lines.push(t('charge', {target: c.targetC, time: when(c.at, d.chargeDates[i]), reason}));
    }
    if (d.dayType !== 'away' && d.useLitres !== undefined) lines.push(t('use', {litres: d.useLitres, p80: d.useLitresP80 ?? d.useLitres}));
    lines.push(d.reserveLitres > 0 ? t('tank', {litres: d.nowLitres, reserve: d.reserveLitres})
        : t('tank_no_reserve', {litres: d.nowLitres}));
    lines.push(t(d.untilDate === d.date ? 'cost' : 'cost_tomorrow', {cost: money(d.cost)}));
    if (shadow) lines.push(t('shadow'));
    return lines.join('\n');
}

/** A charge starting: one Autopilot starts (or, in shadow, would start), or one the pump starts
 *  itself. What the charge message and the morning recap are worded from. */
export interface ChargeEvent {
    at: number;
    by: 'autopilot' | 'pump';
    reason: ChargeReason;
    /** Where the charge ends, °C: the planned target, or the stop the pump runs to. */
    targetC?: number;
    minutes?: number;
    price?: number;
    meanPrice?: number;
    surplusShare?: number;
    litres?: number;
    top?: number;
    reserveLitres: number;
    /** More hot water (697) is on. */
    more?: boolean;
    /** Against the morning plan: a planned charge within 45 min, one elsewhere within 6 h, or
     *  none. Missing when there was no morning plan to compare with. */
    plan?: 'as_planned' | 'moved' | 'unplanned';
    plannedAt?: number;
    /** A test run's would-be start: nothing was written. */
    shadow?: boolean;
    /** The immersion heater came on during this charge: when, the charge sensor then (°C), and
     *  the highest target Autopilot plans with after learning from it. */
    immersion?: {at: number; c: number; capC: number};
}

/** How near a planned charge has to be to count as this one, and how far a replanned one may
 *  have moved. */
const AS_PLANNED_MS = 45 * 60_000;
const MOVED_MS = 3 * 3_600_000;

/** This start against the morning plan. Pure. Only a start the prices moved can be the planned
 *  one moved: a safety-net start comes on top of the plan, and the pump's own is not the plan's. */
export function againstPlan(at: number, morning?: DailyPlan, canMove = true): Pick<ChargeEvent, 'plan' | 'plannedAt'> {
    if (!morning) return {};
    const nearest = morning.charges.filter((c) => c.reason !== 'running')
        .reduce<ChargeFacts | undefined>((best, c) => !best || Math.abs(c.at - at) < Math.abs(best.at - at) ? c : best, undefined);
    const off = nearest ? Math.abs(nearest.at - at) : Infinity;
    if (off <= AS_PLANNED_MS) return {plan: 'as_planned'};
    return canMove && off <= MOVED_MS ? {plan: 'moved', plannedAt: nearest!.at} : {plan: 'unplanned'};
}

/** The charge Autopilot starts in `input.slot`, or why there is none. Pure. */
export function autopilotCharge(input: ShadowStepInput, morning?: DailyPlan): ChargeEvent | {skip: string} {
    const out = planFrom(input);
    if ('skip' in out) return out;
    if (out.charging || !out.plan.startNow) return {skip: 'no start'};
    const at = out.slots[0] * SLOT_MS;
    const {charges, meanPrice} = chargesOf(input, out, at + DAY_MS);
    const c = charges[0];
    return {at, by: 'autopilot', reason: c.reason, targetC: c.targetC, minutes: c.minutes, price: c.price, meanPrice,
        surplusShare: c.surplusShare, litres: round(input.now.litres!, 0), top: input.now.top,
        reserveLitres: input.reserveLitres ?? DEFAULT_RESERVE_LITRES, ...againstPlan(at, morning, c.reason !== 'reserve')};
}

/** A charge the pump started itself. Pure. */
export function pumpCharge(at: number, now: TankNow, reserveLitres: number, morning?: DailyPlan): ChargeEvent {
    return {at, by: 'pump', reason: 'pump', targetC: now.more ? now.largeStopC : now.stopC, more: now.more,
        litres: now.litres === undefined ? undefined : round(now.litres, 0), top: now.top, reserveLitres,
        ...againstPlan(at, morning, false)};
}

/** The immersion heater came on at `onset.c` °C during the charge `e`: the event with it recorded,
 *  the ceiling observation it adds and the ceiling after. An Autopilot charge's onset counts at
 *  most at its own target: the compressor did not reach the target, so the ceiling goes under it
 *  and the next charge plans cooler. The charge is not stopped: 697 = 0 does not end a running
 *  charge (doc §4.3). Pure. */
export function immersionInCharge(e: ChargeEvent, onset: {at: number; c: number}, observations: readonly CeilingObservation[],
                                  now: number): {event: ChargeEvent; observations: CeilingObservation[]; ceiling: Ceiling} {
    const c = e.by === 'autopilot' && Number.isFinite(e.targetC) ? Math.min(onset.c, e.targetC!) : onset.c;
    const merged = mergeObservations(observations, [{at: onset.at, c, kind: 'onset', source: 'live'}], now);
    const ceiling = learnCeiling(merged, now);
    return {event: {...e, immersion: {at: onset.at, c: round(onset.c, 1), capC: ceiling.maxC}}, observations: merged, ceiling};
}

/** The charge message: a short reason and a detailed one (the Flow trigger's two tokens), worded
 *  through `t` (keys under `autopilot.hotwater_charge`). Pure. */
export function chargeText(e: ChargeEvent, t: Translate, time: (ms: number) => string, currency: string):
    {reason: string; detailedReason: string} {
    const money = (v?: number) => `${(v ?? 0).toFixed(2)} ${currency}`.trim();
    const m = Math.round(e.minutes ?? 0), duration = m < 60 ? t('duration_min', {m})
        : m % 60 ? t('duration', {h: Math.floor(m / 60), m: m % 60}) : t('duration_h', {h: m / 60});
    const run = {target: e.targetC ?? '?', duration, price: money(e.price), mean: money(e.meanPrice),
        share: Math.round((e.surplusShare ?? 0) * 100), litres: e.litres ?? '?', reserve: e.reserveLitres,
        top: e.top ?? '?', stop: e.targetC ?? '?'};
    const detail = e.reason === 'pump' ? t(e.more ? 'detail.pump_more' : 'detail.pump', run)
        : t(e.reason === 'reserve' || e.reason === 'surplus' || e.reason === 'legionella' ? `detail.${e.reason}` : 'detail.price', run);
    const plan = e.plan === 'moved' ? t('plan.moved', {time: time(e.plannedAt!)})
        : e.plan ? t(`plan.${e.plan}${e.by === 'pump' && e.plan === 'as_planned' ? '_pump' : ''}`) : '';
    const immersion = e.immersion ? t('detail.immersion', {at: Math.round(e.immersion.c), cap: e.immersion.capC}) : '';
    return {reason: t(`reason.${e.reason}`), detailedReason: [detail, plan, immersion].filter((x) => x).join(' ')};
}

/** The timeline line for a charge event. */
export function chargeLine(e: ChargeEvent, t: Translate, time: (ms: number) => string, currency: string,
                           shadow: boolean): string {
    const {reason, detailedReason} = chargeText(e, t, time, currency);
    return `${t((e.shadow ?? shadow) && e.by === 'autopilot' ? 'title_would' : 'title', {reason})}\n${detailedReason}`;
}

/** The morning recap: the charges since the last morning plan, by local day ("Yesterday:",
 *  "Last night:" for this date's small hours, an older date if a morning was missed), oldest first. `dateOf` gives a local date,
 *  `today` is the morning's. */
export function recapLines(events: ChargeEvent[], t: Translate, time: (ms: number) => string, shadow: boolean,
                           dateOf: (ms: number) => string, today: string): string[] {
    const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 24 * 3_600_000).toISOString().slice(0, 10);
    const lines: string[] = [];
    let day: string | undefined;
    for (const e of [...events].sort((x, y) => x.at - y.at)) {
        const date = dateOf(e.at);
        if (date !== day) {
            day = date;
            lines.push(date === today ? t('recap.last_night') : date === yesterday ? t('recap.yesterday') : t('recap.on', {date}));
        }
        const plan = e.plan ? ` ${t(`recap.${e.plan}${e.by === 'pump' && e.plan === 'as_planned' ? '_pump' : ''}`)}` : '';
        lines.push(t((e.shadow ?? shadow) && e.by === 'autopilot' ? 'recap.would' : 'recap.item',
            {time: time(e.at), target: e.targetC ?? '?', reason: t(`reason.${e.reason}`)}) + plan
            + (e.immersion ? ` ${t('recap.immersion', {at: Math.round(e.immersion.c)})}` : ''));
    }
    return lines;
}

/** A charge the plan gained, lost, moved or resized between two plans. */
export interface PlanChange {
    kind: 'added' | 'dropped' | 'moved' | 'resized';
    was?: ChargeFacts;
    now?: ChargeFacts;
}

/** A target change this small is the replan's noise, not news. */
const RESIZE_K = 3;

/** What changed from `before` to `after` for the charges still ahead (`from`, ms). A charge is
 *  the same one within 45 min, moved within 3 h, else dropped and another added. Pure. */
export function planChanges(before: DailyPlan, after: DailyPlan, from: number): PlanChange[] {
    const old = before.charges.filter((c) => c.at >= from && c.reason !== 'running');
    const fresh = after.charges.filter((c) => c.reason !== 'running');
    const used = new Set<ChargeFacts>();
    const match = new Map<ChargeFacts, ChargeFacts>();
    // Same-time pairs first, so a charge that only moved cannot take another's partner.
    for (const within of [AS_PLANNED_MS, MOVED_MS]) for (const was of old) {
        if (match.has(was)) continue;
        const now = fresh.filter((c) => !used.has(c) && Math.abs(c.at - was.at) <= within)
            .sort((x, y) => Math.abs(x.at - was.at) - Math.abs(y.at - was.at))[0];
        if (now) { used.add(now); match.set(was, now); }
    }
    const changes: PlanChange[] = [];
    for (const was of old) {
        const now = match.get(was);
        if (!now) changes.push({kind: 'dropped', was});
        else if (Math.abs(now.at - was.at) > AS_PLANNED_MS) changes.push({kind: 'moved', was, now});
        else if (Math.abs(now.targetC - was.targetC) >= RESIZE_K) changes.push({kind: 'resized', was, now});
    }
    for (const now of fresh) if (!used.has(now)) changes.push({kind: 'added', now});
    return changes.sort((x, y) => (x.now ?? x.was)!.at - (y.now ?? y.was)!.at);
}

/** The plan update: why it was redone, each change with its reason, and the plan as it now
 *  stands. `before` is the plan the old prices give from the same tank and slot as `after`, so
 *  every change is the prices' doing. `t` reads `autopilot.hotwater_update`, `when` gives "14:15" or "tomorrow 03:45".
 *  Undefined when nothing ahead changed except charges in hours that had no price before:
 *  those are news for the next morning's recap and the charge message, not for a push. */
export function planUpdateText(before: DailyPlan, after: DailyPlan, from: number, t: Translate,
                               when: (ms: number, at?: boolean) => string, currency: string, shadow: boolean,
                               priceNow?: (at: number, minutes: number) => number | undefined): string | undefined {
    const changes = planChanges(before, after, from);
    if (!changes.some((c) => c.kind !== 'added' || c.now!.at < before.until)) return undefined;
    const money = (v: number) => `${v.toFixed(2)} ${currency}`.trim();
    const reason = (c: ChargeFacts) => t(`reason.${c.reason}`);
    /** The first charge the update added or moved after `at`: what takes over. Not always cheaper
     *  per kWh; nearer the use it loses less heat on the way. */
    const takesOver = (at: number) => changes.filter((c) => c.kind === 'added' || c.kind === 'moved')
        .map((c) => c.now!).filter((c) => c.at > at).sort((x, y) => x.at - y.at)[0];
    const lines = [t(after.until > before.until ? 'title.new_prices' : 'title.revised')];
    for (const c of changes) {
        const now = c.now, was = c.was;
        if (c.kind === 'added') lines.push(t(now!.at >= before.until ? 'added_new_hours' : 'added',
            {time: when(now!.at), target: now!.targetC, price: money(now!.price), reason: reason(now!)}));
        else if (c.kind === 'moved') {
            // Revised prices: say what the old hours cost now, which is why it moved.
            const wasNow = priceNow?.(was!.at, was!.minutes);
            lines.push(wasNow !== undefined && Math.abs(wasNow - was!.price) > 0.01 * was!.price
                ? t('moved_repriced', {was: when(was!.at), time: when(now!.at), target: now!.targetC,
                    price: money(now!.price), wasPrice: money(was!.price), wasNow: money(wasNow)})
                : t('moved', {was: when(was!.at), time: when(now!.at), target: now!.targetC,
                    price: money(now!.price), wasPrice: money(was!.price)}));
        } else {
            const over = takesOver(was!.at);
            const why = over ? t('why.takes_over', {time: when(over.at, true), price: money(over.price)})
                : c.kind === 'dropped' ? t('why.covered') : now!.targetC > was!.targetC ? t('why.store_more') : t('why.needs_less');
            lines.push(c.kind === 'dropped' ? t('dropped', {time: when(was!.at), target: was!.targetC, why})
                : t('resized', {time: when(now!.at), target: now!.targetC, was: was!.targetC, why}));
        }
    }
    lines.push(t(after.untilDate === after.date ? 'cost' : 'cost_tomorrow', {cost: money(after.cost)}));
    if (shadow) lines.push(t('shadow'));
    return lines.join('\n');
}

/** One-line summary for the app log. */
export function summary(entry: ShadowEntry): string {
    const next = entry.next ? `next charge ${entry.next.at.slice(11, 16)} UTC to ${entry.next.targetC} °C`
        + ` (${entry.next.heat} kWh, ${entry.next.cost} kr)` : 'no charge planned';
    return `Autopilot hot water shadow: ${entry.litres} L, top ${entry.top ?? '?'} °C, ${entry.action}; ${next}; `
        + `${entry.horizon} slots ahead.`;
}

/** The Homey device id of this app's device with pairing id `dataId`. */
export function ownDeviceId(devices: Record<string, any>, appId: string, dataId: string): string | undefined {
    return Object.entries(devices ?? {}).find(([, d]) => String(d?.driverId ?? '').startsWith(`homey:app:${appId}:`)
        && String(d?.data?.id) === dataId)?.[0];
}

/** A test run plans and reports; live also starts the charges it plans. */
export type HotwaterMode = 'shadow' | 'live';

/** What the device gives the running Autopilot. Read on every use, so a settings change takes
 *  effect at the next slot without a restart. */
export interface HotwaterHooks {
    /** This device's Homey id for Insights, looked up once and kept (device.ts homeyDeviceId). */
    homeyId?(api: any): Promise<string | undefined>;
    mode(): HotwaterMode;
    reserveLitres(): number;
    solar(): boolean;
    /** Solar surplus left for hot water from `slot`, kW per slot (solar-surplus.ts), or undefined
     *  without a generator. */
    surplus(slot: number): Map<number, number> | undefined;
    /** What the plan's charges take from the surplus, kW per slot, so later users see the rest. */
    reserveSurplus(kw: Map<number, number>): void;
    dayType(): DayTypeState | undefined;
    /** The pump's state read just before a start, live from the pump. */
    pumpFacts(): Promise<PumpFacts>;
    /** The two writes of a start: the Large stop (62) in °C, then More hot water (697 = 2), or
     *  for the legionella run More hot water for `value` hours ('boost'). */
    write(what: 'stop' | 'more' | 'boost', value: number | boolean): Promise<void>;
    /** The legionella run's temperature and interval while Autopilot holds the pump's periodic
     *  boost (hotwater-takeover.ts); undefined otherwise. */
    legionella?(): {targetC: number; intervalDays: number; pumpC?: number} | undefined;
    /** The legionella run did not get there in time: the pump's own periodic boost back on
     *  (true), or off again once a charge got there (false). Throws when the write fails. */
    periodicBoost?(on: boolean): Promise<void>;
    store: {get(key: string): any; set(key: string, value: any): Promise<void>};
    /** Autopilot is about to switch on More hot water: why, in the owner's language, for the
     *  operating state's reason (profile.ts `AUTOPILOT_HOTWATER_NOTE`). */
    starting?(why: string): void;
    /** A real charge started, Autopilot's or the pump's: the Flow trigger. */
    charged(e: ChargeEvent, text: {reason: string; detailedReason: string}): void;
    /** A problem the owner must see on the device, or undefined to clear it. */
    warn(text: string | undefined): void;
    /** The device's "Autopilot now" line: the next planned charge and why, or what it waits for. */
    status(text: string): void;
    /** The plan round (orchestrator.ts): the slots from `slot` heating pre-heats in, and this
     *  slot's planned charges, published after each replan. */
    preheat?(slot: number): Set<number> | undefined;
    replanned?(charges: ChargeFacts[]): void;
    /** What setup asked a home with a short history, the learner's prior; undefined if not asked. */
    household(): Household | undefined;
    /** An analytics event (lib/analytics.ts `track`): a no-op without the owner's consent. */
    track(event: string, properties: Record<string, string | number | boolean>): void;
    /** The morning plan's charges, for Plan vs actual (cost-check.ts). */
    planned?(from: number, charges: ChargeFacts[]): void;
}

/** Device store keys: the charge Autopilot started last, and the day's writes. Both are written
 *  before the pump is: after a restart the charge is still Autopilot's and the writes still count. */
export const CHARGE_KEY = 'autopilotHotwaterCharge';
export const WRITES_KEY = 'autopilotHotwaterWrites';
/** Device store key: the plan in force, the date its morning message went out and the charges
 *  since, so a restart neither loses them (no plan to compare a charge with, an empty widget and
 *  recap until the next morning) nor sends the morning message twice. */
export const PLAN_KEY = 'autopilotHotwaterPlan';
/** Device store key: what taught the compressor ceiling (hotwater-ceiling.ts). */
export const CEILING_KEY = 'autopilotHotwaterCeiling';
/** Device store key: the legionella state (legionella.ts), set when Autopilot takes over. */
export const LEGIONELLA_STATE_KEY = 'autopilotLegionellaState';
/** Local dates Autopilot started a legionella run on, newest last (the savings widget leaves those
 *  days out of the comparison, as it does the heat pump's own boosts before Autopilot). */
export const LEGIONELLA_DATES_KEY = 'autopilotLegionellaDates';
const LEGIONELLA_DATES_KEPT = 40;
/** A real charge started this long ago is still the one running. */
const CHARGE_RUN_MS = 4 * HOUR;

/** What PLAN_KEY holds. */
export interface SavedPlan {
    dailySent?: string;
    plan?: DailyPlan;
    events: ChargeEvent[];
    /** The tank since that morning, for the day's score (analytics.ts). */
    day?: TankDay;
    /** The slots (start ms / SLOT_MS) the polls saw the tank charging, for the charges already
     *  done. (`ran` until 2026-11-15 also held hourly guesses from Insights; it is ignored.) */
    charged?: number[];
}

/** The saved plan to resume from, or nothing when it is too old to be the plan in force: a plan
 *  covers at most the prices known when it was made, two days. Pure. */
export function resumePlan(saved: SavedPlan | undefined, now: number): SavedPlan | undefined {
    if (!saved || !Array.isArray(saved.events)) return undefined;
    const fresh = saved.plan && saved.plan.until > now ? saved.plan : undefined;
    const day = Number.isFinite(saved.day?.from) && saved.day!.from <= now ? {day: saved.day} : {};
    const charged = Array.isArray(saved.charged) ? saved.charged.filter((slot) => Number.isFinite(slot) && now - slot * SLOT_MS < 2 * DAY_MS) : [];
    return {dailySent: saved.dailySent, plan: fresh, events: saved.events.filter((e) => now - e.at < 2 * DAY_MS), ...day,
        ...charged.length ? {charged} : {}};
}
/** The surplus model is relearned this often; the forecast comes with it. */
const SURPLUS_EVERY_MS = 3 * HOUR;
/** Slots ahead that take the live surplus rather than the forecast: what is exported now is the
 *  best guess for the next half hour. */
const LIVE_SLOTS = 2;
/** Lever skips the owner must fix on the pump, and their locale key. */
const BLOCKED: Partial<Record<string, string>> = {'hot water off': 'hot_water_off', 'smart price adaption': 'spa', 'smart control': 'smart_control',
    // The pump's own start is held out of the way, so a refused rescue leaves nothing heating the
    // water until midnight: the owner hears it.
    'rescue limit': 'rescue_limit'};

/** The evening at 16:00: the day type's, and the challengers that need the day so far (plan steps
 *  5.2 and 5.3), from today's draws per local hour. Undefined without a profile. Pure. */
export function lateEvening(model: HotwaterModel, dayType: DayType | undefined, today: number[]): LateEvening | undefined {
    const p = profileFor(model, dayType);
    if (!p) return undefined;
    const sum = (a: number[], from: number, to: number) => round(a.slice(from, to).reduce((x, y) => x + y, 0));
    const morning = sum(today, MORNING_FROM, MORNING_TO);
    const morn = morningEvening(model, dayType, morning), similar = similarEvening(model, dayType, today, EVENING_FROM);
    return {morning, base: sum(p.hours, EVENING_FROM, EVENING_TO), baseP80: sum(p.p80, EVENING_FROM, EVENING_TO),
        ...morn ? {morn} : {}, ...similar ? {similar} : {}};
}

/** The working-day evening the plan uses, and the per-weekday challenger's (plan step 5.1). */
export function eveningForecast(model: HotwaterModel, weekday: number): EveningForecast | undefined {
    const p = model.profiles.working ?? model.profiles.any, w = model.evenings?.[weekday];
    if (!p || !w) return undefined;
    const sum = (a: number[]) => round(a.slice(EVENING_FROM, EVENING_TO).reduce((x, y) => x + y, 0));
    return {base: sum(p.hours), baseP80: sum(p.p80), mean: w.mean, p80: w.p80};
}

/** The plan widget's view of the day (`HotwaterAutopilot.outlook`). */
export type HotwaterOutlook = NonNullable<ReturnType<HotwaterAutopilot['outlook']>>;

/** The hot water widgets' day: the outlook, plus litres of 40 °C water per slot (read behind
 *  now, planned from now) and per hour (drawn, and what the plan expected). */
export interface TankView extends HotwaterOutlook {
    read: (number | undefined)[];
    plan: (number | undefined)[];
    drawn: (number | undefined)[];
    forecast: number[];
}

/** Runs hot water Autopilot for one Hot water device, as a test run or live. */
export class HotwaterAutopilot {
    private prices = new Map<number, PriceSlot>();
    private model?: HotwaterModel;
    /** The timers still pending. Each removes itself when it fires, so this holds only the live ones
     *  (it used to keep every timer ever started: thousands a day). */
    private timers = new Set<any>();
    private later(fn: () => void, ms: number) {
        const timer = this.homey.setTimeout(() => { this.timers.delete(timer); fn(); }, ms);
        this.timers.add(timer);
    }
    private stopped = false;
    private lines = 0;
    /** Today so far, for the day record; and the records kept. */
    private dayAcc?: DayAcc;
    private dayLines = 0;
    private skipped = new Map<string, number>();
    private last?: ShadowEntry;
    /** Whether the tank is charging, from the latest poll. The plan step's own reading is up to a
     *  slot old: a charge started just after it would read as not started. */
    private chargingNow?: boolean;
    /** The slots the polls saw the tank charging (SavedPlan.charged), and those read from Insights
     *  for the time before (`chargedSlots`, redone at each learn). */
    private ran = new Set<number>();
    private ranBefore = new Set<number>();
    /** The plan in force: stored heat, kWh, at the start of each slot from `from`. */
    private planned?: {from: number; stored: number[]};
    /** The tank's history has been read from Insights since the start: until then the day's
     *  readings and use are not known, and the widgets say they are loading. */
    private historyRead = false;
    historyReady(): boolean { return this.historyRead; }
    /** The tank over the last day and a half, a reading a slot: Insights' until the live readings
     *  begin, then one per plan step. What the Hot water use widget reads today's use from. */
    private history: TankPoint[] = [];
    private deviceId?: string;
    private currency = '';
    /** Local date of the last morning plan sent, and the plan in force: the morning's, or the
     *  replan after prices changed. Charges are compared with it. */
    private dailySent?: string;
    private morningPlan?: DailyPlan;
    /** Charges started since the last morning plan, for its recap. */
    private events: ChargeEvent[] = [];
    private wasCharging?: boolean;
    /** End of the run Autopilot last started (or, in a test run, would have), and when it really
     *  started one, so that its own charge is not also reported as the pump's. */
    private wouldRunUntil = 0;
    private autopilotStartedAt = -Infinity;
    /** When the legionella run started: the plan's extension leaves it alone for its 6 h. */
    private legionellaRunAt?: number;
    /** Why the last planned start was not made, so a reason is logged once, not every slot. */
    private leverSkip?: string;
    private starting = false;
    /** The last real charge start, Autopilot's or the pump's: why the tank is heating now. */
    private lastStart?: ChargeEvent;
    /** The tank since the last morning message, for the day's score. */
    private day?: TankDay;
    /** What last blocked a planned start, and whether a plan could not be made for want of
     *  prices: each told to analytics once per change, not every slot. */
    private leverBlocked = new Edge<BlockedBy | undefined>();
    private pricesBlocked = new Edge<boolean>();
    /** What taught the compressor ceiling, the charge the polls follow, and the cap last logged. */
    private ceilingObs: CeilingObservation[] = [];
    private watch: ChargeWatch = {running: false};
    private loggedCap?: number;

    /** `dataId` is the device's pairing id (`getData().id`): the SDK does not expose the Homey
     *  device id that Insights are keyed by, so it is looked up through the Homey API. */
    constructor(private readonly homey: any, private readonly dataId: string, private readonly fileName: string,
                private readonly caps: TankCapabilities,
                private readonly read: () => {now: TankNow; tank?: TankSpec},
                private readonly log: (...args: any[]) => void,
                private readonly hooks: HotwaterHooks) {}

    async start() {
        this.lines = await trimLines(shadowLogName(this.fileName), KEEP).catch(() => 0);
        this.dayLines = await trimLines(daysLogName(this.fileName), DAYS_KEPT).catch(() => 0);
        this.log(`Autopilot hot water log: /userdata/${shadowLogName(this.fileName)} (days: /userdata/${daysLogName(this.fileName)}).`);
        const charge = this.hooks.store.get(CHARGE_KEY) as {at: number; minutes: number; legionella?: boolean} | undefined;
        if (charge && Date.now() - charge.at < (charge.legionella ? BOOST_HOURS : 2) * HOUR) {
            this.autopilotStartedAt = charge.at;
            this.wouldRunUntil = charge.at + charge.minutes * 60_000;
            if (charge.legionella) this.legionellaRunAt = charge.at;
        }
        const saved = resumePlan(this.hooks.store.get(PLAN_KEY), Date.now());
        if (saved) {
            this.dailySent = saved.dailySent;
            this.morningPlan = saved.plan;
            this.events = saved.events;
            this.lastStart = [...saved.events].reverse().find((e) => !e.shadow);
            this.day = saved.day;
            this.ran = new Set(saved.charged ?? []);
            if (saved.plan) this.reserveFor(saved.plan);
        }
        this.ceilingObs = mergeObservations(this.hooks.store.get(CEILING_KEY), [], Date.now());
        this.logCeiling();
        this.loop(() => this.fetchPrices(), 5_000);
        // The last model learned, so a restart plans at once; the relearn runs in the background.
        loadJson<{at?: string; model?: HotwaterModel}>(modelFileName(this.fileName)).then((saved) => {
            const age = Date.now() - Date.parse(saved?.at ?? '');
            if (!this.model && saved?.model && age >= 0 && age < MODEL_KEEP_MS) {
                this.model = saved.model;
                this.log(`Autopilot hot water: resumed the model learned ${Math.round(age / 60_000)} min ago.`);
            }
        }).catch((error) => this.log('Autopilot hot water: saved model not read:', error?.message ?? error));
        // A learn that found too little (Insights refusing requests, say) tries again soon.
        // Each failure in a row waits longer (15 min, 1 h, then 6 h), so a Homey refusing Insights
        // is not asked 18 logs every 15 minutes.
        let failures = 0;
        this.loop(async () => {
            const learned = await this.learn().catch((error: any) => {
                this.log('Autopilot hot water: learning failed:', error?.message ?? error); return false;
            });
            if (learned) { failures = 0; return LEARN_EVERY_MS; }
            failures++;
            return failures === 1 ? LEARN_RETRY_MS : failures === 2 ? 60 * 60_000 : LEARN_EVERY_MS;
        }, 60_000);
        this.loop(async () => { this.report(); return HOUR; }, 10 * 60_000);
        this.scheduleStep();
    }

    stop() {
        this.stopped = true;
        this.timers.forEach((timer) => this.homey.clearTimeout(timer));
        this.timers.clear();
    }

    async remove() {
        this.stop();
        await deleteHistory(this.fileName);
    }

    /** For the Flow condition: a charge running, or one planned to start within `hours`. Only a
     *  plan from this slot or the last counts: an older one is no plan at all. */
    /** What the Autopilot widget shows for `n` slots from `from`: the price, the expected solar
     *  surplus (kW, only with solar on), and the plan's charges with the share each takes from the
     *  surplus; the tank now and the next charge. Reads only. */
    outlook(from: number, n: number): {slots: {price?: number; surplus?: number; charge?: number; ran?: true}[]; litres?: number;
        next?: {at: number; minutes: number; reason: ChargeReason; solar: number; running: boolean}} {
        const charges = this.morningPlan?.charges ?? [];
        const covering = (slot: number) => charges.find((c) => slot * SLOT_MS < c.at + c.minutes * 60_000
            && (slot + 1) * SLOT_MS > c.at);
        const surplus = this.surplus(from);
        const now = Date.now();
        // A planned charge whose start has passed is the next one only while the tank is charging.
        // One that did not start (a safety-net charge filled the tank first) is behind us.
        const charging = (this.chargingNow ?? this.last?.charging) === true;
        const next = nextCharge(charges, now, charging);
        const nowSlot = Math.floor(now / SLOT_MS);
        return {
            // Behind now, the charges that ran; from now on, the plan.
            slots: Array.from({length: n}, (_, k) => {
                const slot = from + k;
                const c = slot >= nowSlot ? covering(slot) : undefined;
                const kw = surplus?.get(slot);
                return {price: this.prices.get(slot)?.price, surplus: kw === undefined ? undefined : Math.max(0, round(kw, 2)),
                    charge: c ? c.surplusShare : undefined, ...(this.ran.has(slot) || this.ranBefore.has(slot)) && slot <= nowSlot ? {ran: true as const} : {}};
            }),
            litres: this.last?.litres,
            next: next && {at: next.at, minutes: next.minutes, reason: next.reason, solar: next.surplusShare,
                running: next.at <= now || (charging && next.at <= now + SLOT_MS)},
        };
    }

    /** The slots [from, from + n) for the hot water widgets: the charges (`outlook`), the litres
     *  read behind now and planned from now, and per hour the litres drawn and expected. */
    tank(from: number, n: number): TankView | undefined {
        const model = this.model, o = this.outlook(from, n);
        if (!model || !o || !this.historyRead) return undefined;
        const clock = this.clock(), dayTypes = this.hooks.dayType();
        const read: (number | undefined)[] = new Array(n).fill(undefined);
        for (const p of this.history) {
            const k = Math.floor(p.t / SLOT_MS) - from;
            if (k >= 0 && k < n && typeof p.litres === 'number' && p.litres > 0) read[k] = round(p.litres, 0);
        }
        // Right after a start the first plan step is up to a slot away: plan now, reading only.
        const {now: reading, tank} = this.read();
        const slotNow = slotOf(Date.now());
        let planned = this.planned && this.planned.from >= slotNow - 1 ? this.planned : undefined;
        if (!planned && tank) {
            const out = planFrom(this.input(slotNow * SLOT_MS, reading, tank));
            if (!('skip' in out)) planned = {from: slotNow, stored: out.plan.stored};
        }
        // The tank now, so the read line reaches now and meets the plan there.
        const k0 = slotNow - from;
        if (k0 >= 0 && k0 < n && read[k0] === undefined && Number.isFinite(reading.litres) && reading.litres! > 0) read[k0] = round(reading.litres!, 0);
        const plan: (number | undefined)[] = new Array(n).fill(undefined);
        if (planned) planned.stored.forEach((kwh, j) => {
            const k = planned!.from + j - from;
            if (k >= 0 && k < n) plan[k] = round(kwh / KWH_PER_LITRE, 0);
        });
        const hours = Math.ceil(n / 4);
        const drawn: (number | undefined)[] = new Array(hours).fill(undefined);
        // Each step's draw goes to the hour that holds its middle: Insights keeps today hourly, from
        // half past to half past, the live readings a slot apart.
        for (const i of intervals(this.history, model.loss, model.charge)) {
            const k = Math.floor((Math.floor((i.start + i.hours * HOUR / 2) / SLOT_MS) - from) / 4);
            if (k >= 0 && k < hours && i.hours <= 1.01 && Number.isFinite(i.draw)) drawn[k] = (drawn[k] ?? 0) + i.draw / KWH_PER_LITRE;
        }
        const forecast = Array.from({length: hours}, (_, k) => {
            const ms = (from + 4 * k) * SLOT_MS;
            const p = profileFor(model, dayTypeAt(dayTypes, ms, clock));
            // The usual day, as Hot water use states it (`usage().expected`): the mean, without the
            // margin the plan adds for a busy day.
            return p ? round(plannedHours(p, 0)[clock(ms).hour] / KWH_PER_LITRE, 0) : 0;
        });
        return {...o, litres: o.litres ?? reading.litres, read, plan, drawn: drawn.map((v) => v === undefined ? undefined : round(v, 0)), forecast};
    }

    /** The compressor ceiling and the highest target under it, from what the pump did recently. */
    ceiling(): Ceiling {
        return learnCeiling(this.ceilingObs, Date.now());
    }

    /** Every poll: follows the running charge for the immersion heater's onset and how hot a
     *  charge got on the compressor alone. An onset in a real charge is recorded on that charge,
     *  said in its detailed reason (log, recap, and the timeline for Autopilot's own) and lowers
     *  the ceiling. */
    poll(r: PollReading) {
        if (this.stopped) return;
        if (r.charging !== undefined) this.chargingNow = r.charging;
        // Kept once per slot, so a restart still shows the charges done today.
        if (r.charging && !this.ran.has(Math.floor(r.at / SLOT_MS))) {
            this.ran.add(Math.floor(r.at / SLOT_MS));
            this.savePlan();
        }
        const {watch, observation} = watchCharge(this.watch, r);
        this.watch = watch;
        if (!observation) return;
        const charge = this.lastStart;
        if (observation.kind === 'onset' && observation.c >= ONSET_MIN_C && charge && !charge.immersion
            && r.at - charge.at < CHARGE_RUN_MS) {
            const out = immersionInCharge(charge, observation, this.ceilingObs, r.at);
            this.ceilingObs = out.observations;
            this.events = this.events.map((e) => e === charge ? out.event : e);
            this.lastStart = out.event;
            this.savePlan();
            const t: Translate = (key, tokens) => this.homey.__(`autopilot.hotwater_charge.${key}`, tokens);
            const text = chargeText(out.event, t, this.time, this.currency);
            this.log(`Autopilot hot water: the immersion heater came on at ${observation.c} °C in the ${charge.by}'s charge. `
                + `${text.detailedReason} ${JSON.stringify(out.event.immersion)}`);
            if (charge.by === 'autopilot' && !charge.shadow)
                this.homey.notifications.createNotification({excerpt: chargeLine(out.event, t, this.time, this.currency, this.shadow)})
                    .catch((error: any) => this.log('Autopilot hot water: timeline failed:', error?.message ?? error));
        } else this.ceilingObs = mergeObservations(this.ceilingObs, [observation], r.at);
        this.saveCeiling();
    }

    private saveCeiling() {
        this.hooks.store.set(CEILING_KEY, this.ceilingObs)
            .catch((error) => this.log('Autopilot hot water: ceiling not saved:', error?.message ?? error));
        this.logCeiling();
    }

    /** Logs the ceiling when the target cap it gives changes. */
    private logCeiling() {
        const c = this.ceiling();
        if (c.maxC === this.loggedCap) return;
        this.loggedCap = c.maxC;
        this.log(`Autopilot hot water: compressor ceiling ${round(c.c, 1)} °C (${c.from}), charges to at most ${c.maxC} °C.`);
    }

    /** Learns again now, after the household answers changed. */
    relearn() {
        this.learn().catch((error) => this.log('Autopilot hot water:', error?.message ?? error));
    }

    /** What the widget's week chart needs: the learned full days, today's local date and day
     *  type, and the heat Autopilot expects drawn today (kWh). Undefined until it has learned. */
    usage(): {recent: DayDraw[]; today: string; dayType?: DayType; expected?: number} | undefined {
        if (!this.model?.recent) return undefined;
        const dayType = dayTypeAt(this.hooks.dayType(), Date.now(), this.clock());
        const expected = profileFor(this.model, dayType)?.daily;
        return {recent: this.model.recent, today: this.clock()(Date.now()).date, dayType,
            expected: Number.isFinite(expected) ? expected : undefined};
    }

    /** Full days of tank history behind the model, once it has learned. */
    historyDays(): number | undefined {
        return this.model?.days;
    }

    /** For each of `n` slots from `from`, whether the plan in force has a charge running then: the
     *  compressor is on hot water, so heating's plan expects no heat from it (live.ts). */
    chargeSlots(from: number, n: number): boolean[] {
        const charges = this.morningPlan?.charges ?? [];
        return Array.from({length: n}, (_, k) => charges.some((c) => (from + k) * SLOT_MS < c.at + c.minutes * 60_000
            && (from + k + 1) * SLOT_MS > c.at));
    }

    chargePlannedWithin(hours: number): boolean {
        const last = this.last;
        if (!last || last.slot < slotOf(Date.now()) - 1) return false;
        return last.charging || (!!last.next && Date.parse(last.next.at) < Date.now() + hours * HOUR);
    }

    private loop(job: () => Promise<number>, firstMs: number) {
        const run = async () => {
            if (this.stopped) return;
            let next = 15 * 60_000;
            try { next = await job(); } catch (error: any) { this.log('Autopilot hot water:', error?.message ?? error); }
            if (!this.stopped) this.later(run, next);
        };
        this.later(run, firstMs);
    }

    /** Half a minute into each slot, so the poll has read the tank since the boundary. */
    private scheduleStep() {
        if (this.stopped) return;
        const now = Date.now();
        const wait = (slotOf(now) + 1) * SLOT_MS + 30_000 - now;
        this.later(() => { this.step(); this.scheduleStep(); }, wait);
    }

    private clock(): LocalClock {
        return localClock(this.homey.clock.getTimezone());
    }

    private get shadow() {
        return this.hooks.mode() !== 'live';
    }

    /** True when a model was learned. */
    private async learn(): Promise<boolean> {
        const started = Date.now();
        const logs = await withApi(this.homey, async (api) => {
            this.deviceId ??= this.hooks.homeyId ? await this.hooks.homeyId(api)
                : ownDeviceId(await api.devices.getDevices({$cache: false, $timeout: 10_000}), this.homey.manifest?.id ?? 'com.nibe.local', this.dataId);
            if (!this.deviceId) throw new Error('could not find this device through the Homey API');
            return fetchTankInsights(api, this.deviceId, this.caps,
                (ms) => new Promise((resolve) => this.homey.setTimeout(resolve, ms)));
        }, PRIORITY.background); // the saved model plans meanwhile; learning waits out the start
        const points = pointsFromInsights(logs);
        if (points.length < 48) {
            this.log(`Autopilot hot water: ${points.length} readings in Insights, too few to learn from yet.`);
            return false;
        }
        // Each reading is learned under the day type in force when it was taken; where none was
        // set, the calendar's.
        const dayTypes = this.hooks.dayType();
        const clock = this.clock();
        for (const point of points) point.dayType = dayTypeAt(dayTypes, point.t, clock);
        const model = learn(points, this.clock(), started, undefined, this.hooks.household());
        this.model = model;
        // Before the polls' own record, read from the counter. Where the polls saw the tank, they win.
        const firstSeen = Math.min(...this.ran);
        this.ranBefore = new Set(chargedSlots(points, started - 2 * DAY_MS, model.charge?.producedPerHour ?? model.charge?.heatPerHour ?? 6, model.charge?.kw)
            .filter((slot) => slot < firstSeen));
        this.history = mergeHistory(points, this.history, started - HISTORY_MS);
        this.historyRead = true;
        this.ceilingObs = mergeObservations(this.ceilingObs, [], started, ceilingFromHistory(points));
        this.saveCeiling();
        const c = model.charge, any = model.profiles.any;
        const typed = (['working', 'free'] as const).filter((type) => model.profiles[type]).join(' and ');
        this.log(`Autopilot hot water: learned from ${points.length} readings over ${model.days} days: `
            + `${any ? `${round(any.daily, 1)} kWh heat a day (p80 ${round(any.dailyP80, 1)})` : 'no day profile'}, `
            + `${typed ? `own profiles for ${typed} days, ` : ''}`
            + `${c ? `tank COP ${round(c.cop)}, ${round(chargeRate(c, 2), 1)} kWh/h near empty to ${round(chargeRate(c, 9), 1)} near full, `
                + `${round(c.kw ?? NaN, 1)} kW` : 'no charge model'}, `
            + `loss ${round(model.loss.base, 3)} + ${round(model.loss.perKwh, 3)}/kWh an hour (${Date.now() - started} ms).`);
        await saveJson(modelFileName(this.fileName), {at: new Date(started).toISOString(), model});
        return true;
    }

    /** Today's and tomorrow's prices, from the Gateway's price book (shared with heating and the
     *  savings widgets). */
    private async fetchPrices(): Promise<number> {
        const now = Date.now();
        const timeZone = this.homey.clock.getTimezone();
        const book = pricesFor(this.homey);
        const info = await book.info();
        this.currency = info.currency ?? '';
        const days: DayPrices[] = info.dynamic
            ? await Promise.all([book.day(localDate(now, timeZone)), book.day(localDate(now, timeZone, 1))]) : [];
        const keepFrom = slotOf(now - 24 * HOUR);
        for (const slot of [...this.prices.keys()]) if (slot < keepFrom) this.prices.delete(slot);
        const old = new Map(this.prices);
        let changed = false;
        for (const day of days) for (const slot of day.slots) {
            if (this.prices.get(slot.slot)?.price !== slot.price) changed = true;
            this.prices.set(slot.slot, slot);
        }
        if (changed) this.pricesChanged(old);
        return nextPriceFetchMs(now, timeZone, (days[1]?.slots.length ?? 0) > 0);
    }

    /** Expected surplus left for hot water per slot, kW, while solar is on. */
    private surplus(slot: number): Map<number, number> | undefined {
        return this.hooks.solar() ? this.hooks.surplus(slot) : undefined;
    }

    /** The plan in force takes the surplus in the slots its solar charges run in. */
    private reserveFor(plan: DailyPlan) {
        const kw = new Map<number, number>();
        const surplus = this.surplus(Math.floor(Date.now() / SLOT_MS));
        for (const c of plan.charges) {
            if (!(c.surplusShare > 0)) continue;
            for (let at = c.at; at < c.at + c.minutes * 60_000; at += SLOT_MS) {
                const slot = Math.floor(at / SLOT_MS);
                kw.set(slot, surplus?.get(slot) ?? 0);
            }
        }
        this.hooks.reserveSurplus(kw);
    }

    private input(at: number, now: TankNow, tank: TankSpec): ShadowStepInput {
        const slot = slotOf(at);
        const clock = this.clock(), dayTypes = this.hooks.dayType();
        return {slot, prices: this.prices, surplus: this.surplus(slot), model: this.model, now, tank, clock,
            dayType: dayTypeAt(dayTypes, at, clock), dayTypeOf: (ms) => dayTypeAt(dayTypes, ms, clock),
            reserveLitres: this.hooks.reserveLitres(), maxC: this.ceiling().maxC,
            dueAt: this.last?.next && this.last.slot === slot - 1 ? Date.parse(this.last.next.at) : undefined,
            preheat: this.hooks.preheat?.(slot)};
    }

    private step() {
        if (this.stopped) return;
        const {now, tank} = this.read();
        if (!tank) return this.skip('no tank size');
        const at = slotOf(Date.now()) * SLOT_MS;
        const input = this.input(at, now, tank);
        if (this.rescueWarnedOn !== undefined && this.rescueWarnedOn !== input.clock(at).date) this.showBlocked(undefined, input.clock(at).date);
        this.watchDay(input);
        this.morning(input);
        this.adoptPlan(input);
        // The legionella run first: a slot it starts in has no other start.
        this.watchLegionella(input, at).catch((error) => this.log('Autopilot hot water: legionella run failed:', error?.message ?? error))
            .then(() => this.watchStarts(input, at))
            .catch((error) => this.log('Autopilot hot water: start failed:', error?.message ?? error));
        this.watchExtend(input, at).catch((error) => this.log('Autopilot hot water: extending the charge failed:', error?.message ?? error));
        const ctx = this.slotContext(input, at);
        this.recordDay(input, at, ctx);
        const out = hotwaterShadowStep(input);
        this.showStatus(input, out);
        // No prices blocks the plan until a plan is made again; other skips change nothing.
        const noPrices = 'skip' in out && out.skip === 'no prices';
        if ((noPrices || !('skip' in out)) && this.pricesBlocked.changed(noPrices) && noPrices)
            this.hooks.track('Blocked Autopilot', {role: 'hotwater', blocked_by: 'no_prices', simulation: this.shadow});
        if ('skip' in out) {
            this.skip(out.skip);
            return this.writeLine({slot: slotOf(at), at: new Date(at).toISOString(), skip: out.skip,
                litres: now.litres, top: now.top, produced: now.produced, ctx} satisfies ShadowSkip);
        }
        this.hooks.replanned?.(out.charges);
        this.last = out.entry;
        this.planned = {from: out.entry.slot, stored: out.stored};
        if (Number.isFinite(now.litres)) this.history = mergeHistory([], [...this.history,
            {t: at, litres: now.litres, produced: now.produced ?? null, top: now.top ?? null}], Date.now() - HISTORY_MS);
        this.writeLine({...out.entry, produced: now.produced, ...this.withEarly(input), ctx});
    }

    private slotContext(input: ShadowStepInput, at: number): SlotContext {
        const count = countFor(this.hooks.store.get(WRITES_KEY), input.clock(at).date);
        const p = this.prices.get(input.slot)?.price;
        const n = input.now;
        return {dt: input.dayType, ...Number.isFinite(p) ? {price: round(p!, 4)} : {}, reserve: input.reserveLitres, maxC: input.maxC,
            powerW: n.powerW, more: n.more, stopC: n.stopC, largeStopC: n.largeStopC, starts: count.starts, stops: count.stops, tank: input.tank};
    }

    /** The day's compact record (hotwater-days.ts), written when a new local day starts. */
    private recordDay(input: ShadowStepInput, at: number, ctx: SlotContext) {
        const {date, hour} = input.clock(at);
        const {acc, done} = daySample(this.dayAcc, {at, date, hour, dayType: input.dayType, litres: input.now.litres,
            produced: input.now.produced, top: input.now.top, price: ctx.price, reserveLitres: input.reserveLitres});
        this.dayAcc = acc;
        if (!acc.eve && hour >= DAILY_HOUR && input.dayType === 'working' && this.model) {
            const eve = eveningForecast(this.model, weekdayOf(date));
            if (eve) acc.eve = eve;
        }
        if (!acc.late && hour >= EVENING_FROM && input.dayType !== 'away' && this.model) {
            const late = lateEvening(this.model, input.dayType, drawsByHour(this.history, this.model, date, input.clock));
            if (late) acc.late = late;
        }
        if (!done) return;
        const name = daysLogName(this.fileName);
        appendLine(name, done)
            .then(async () => {
                if (++this.dayLines > DAYS_KEPT + 31) this.dayLines = await trimLines(name, DAYS_KEPT);
            })
            .catch((error) => this.log('Autopilot hot water: day record write failed:', error?.message ?? error));
    }

    // TEMP(early-draw log): remove before the release is packaged (tasks/todo.md, "Before the
    // release"), with `ShadowEntry.early`/`withEarly` and the `early` input, unless the two-week
    // comparison has moved the credit into the live plan by then.
    /** What the plan would do with the early draws taken off (`creditEarly`), for the log only. */
    private withEarly(input: ShadowStepInput): Pick<ShadowEntry, 'early' | 'withEarly'> {
        const model = this.model;
        if (!model) return {};
        const early = drawnEarly(this.history, model, input.slot * SLOT_MS, input.clock,
            (ms) => profileFor(model, input.dayTypeOf ? input.dayTypeOf(ms) : input.dayType));
        if (!(early / KWH_PER_LITRE >= 3)) return {};
        const out = hotwaterShadowStep({...input, early});
        return {early: round(early / KWH_PER_LITRE, 0),
            ...('entry' in out ? {withEarly: {action: out.entry.action, next: out.entry.next}} : {})};
    }

    private writeLine(line: ShadowEntry | ShadowSkip) {
        appendLine(shadowLogName(this.fileName), line)
            .then(async () => {
                if (++this.lines > KEEP + 2 * 96) this.lines = await trimLines(shadowLogName(this.fileName), KEEP);
            })
            .catch((error) => this.log('Autopilot hot water: log write failed:', error?.message ?? error));
    }

    /** A charge Autopilot starts now (in a test run, would start), and one the pump started on
     *  its own since the last slot. A would-be start is told once per planned run, not every slot
     *  until the planner's moment passes. */
    private async watchStarts(input: ShadowStepInput, at: number) {
        const charging = (input.now.powerW ?? 0) > 0;
        if (charging && this.wasCharging === false && at - this.autopilotStartedAt > 2 * SLOT_MS)
            this.chargeStarted(pumpCharge(at, input.now, input.reserveLitres ?? DEFAULT_RESERVE_LITRES, this.morningPlan));
        if (input.now.powerW !== undefined) this.wasCharging = charging;
        if (at < this.wouldRunUntil || this.starting) return;
        const e = autopilotCharge(input, this.morningPlan);
        if ('skip' in e) {
            this.leverSkip = undefined;
            return;
        }
        if (this.shadow) {
            this.wouldRunUntil = at + (e.minutes ?? 0) * 60_000;
            return this.chargeStarted({...e, shadow: true});
        }
        this.starting = true;
        try { await this.startCharge(e, input.clock(at).date); } finally { this.starting = false; }
    }

    /** The charge an extension was last decided for (its start), so a charge is extended once. */
    private extendedFor?: number;

    /** A running More hot water charge raised mid-charge when cheap hours go on (`extendTarget`):
     *  live, the Large stop is written, within the day's stop writes; in a test run it is logged. */
    private async watchExtend(input: ShadowStepInput, at: number) {
        if (this.starting || !((input.now.powerW ?? 0) > 0) || !input.now.more) return;
        // The legionella run goes to its own temperature: the plan's extension never touches it.
        if (this.legionellaRunAt !== undefined && at - this.legionellaRunAt < BOOST_HOURS * HOUR) return;
        const charge = this.lastStart?.at ?? at;
        if (this.extendedFor === charge) return;
        const e = extendTarget(input);
        if (!e) return;
        this.extendedFor = charge;
        if (this.shadow) {
            this.log(`Autopilot hot water (test run): would raise the running charge ${e.from} → ${e.targetC} °C, saving about ${e.saves} ${this.currency}.`);
            return;
        }
        const date = input.clock(at).date;
        const count = countFor(this.hooks.store.get(WRITES_KEY), date);
        const facts = await this.hooks.pumpFacts();
        if (count.stops >= MAX_STOP_WRITES_PER_DAY || facts.demandMode === DEMAND_LARGE) {
            this.log(`Autopilot hot water: running charge not extended (${count.stops >= MAX_STOP_WRITES_PER_DAY ? 'daily limit' : 'the owner uses the Large stop'}).`);
            return;
        }
        await this.hooks.store.set(WRITES_KEY, {...count, stops: count.stops + 1});
        await this.hooks.write('stop', e.targetC);
        const stored = this.hooks.store.get(CHARGE_KEY);
        if (stored && typeof stored === 'object') await this.hooks.store.set(CHARGE_KEY, {...stored, targetC: e.targetC});
        if (this.lastStart) this.lastStart = {...this.lastStart, targetC: e.targetC};
        this.log(`Autopilot hot water: running charge raised ${e.from} → ${e.targetC} °C while prices stay cheap (saves about ${e.saves} ${this.currency}).`);
    }

    /** The day a refused rescue was told on the device: its warning says "before midnight", so
     *  it goes when the day does (`step`). */
    private rescueWarnedOn?: string;

    /** A lever block on the device, or none: the warning of a block, cleared when nothing blocks. */
    private showBlocked(blocked: string | undefined, date: string) {
        if (blocked) this.warn(this.homey.__(`autopilot.hotwater_charge.blocked.${blocked}`, {max: MAX_RESCUE_STARTS_PER_DAY}));
        else this.clearWarning();
        if (blocked === 'rescue_limit') this.rescueWarnedOn = date;
    }

    /** The live lever: 62 to the target if it differs, then 697 = 2. */
    private async startCharge(e: ChargeEvent, date: string) {
        const count = countFor(this.hooks.store.get(WRITES_KEY), date);
        const rescue = e.reason === 'reserve';
        const d = leverDecision(e.targetC!, await this.hooks.pumpFacts(), count, {rescue});
        // A pump setting that keeps Autopilot out is the owner's to change, so it is on the device,
        // not only in the log; so is a refused rescue (BLOCKED).
        const blocked = 'skip' in d ? BLOCKED[d.skip] : undefined;
        this.showBlocked(blocked, date);
        if ('skip' in d) {
            if (this.leverSkip !== d.skip) {
                this.log(`Autopilot hot water: ${rescue ? 'rescue under the minimum' : 'planned charge'} not started (${d.skip}).`);
                if (d.skip === 'rescue limit') this.noteRefusedRescue();
            }
            this.leverSkip = d.skip;
            // A skip that is not a block (the tank hot enough) leaves the last block standing.
            const block = leverBlock(d.skip);
            if (block && this.leverBlocked.changed(block))
                this.hooks.track('Blocked Autopilot', {role: 'hotwater', blocked_by: block, simulation: false});
            return;
        }
        this.leverSkip = undefined;
        this.leverBlocked.changed(undefined);
        await this.hooks.store.set(CHARGE_KEY, {at: e.at, targetC: d.targetC, minutes: e.minutes ?? 0});
        await this.hooks.store.set(WRITES_KEY, {...count, starts: count.starts + 1, stops: count.stops + (d.writeStop ? 1 : 0)});
        try {
            if (d.writeStop) await this.hooks.write('stop', d.targetC);
            const t: Translate = (key, tokens) => this.homey.__(`autopilot.hotwater_charge.${key}`, tokens);
            this.hooks.starting?.(t('started_reason', {why: chargeText({...e, targetC: d.targetC}, t, this.time, this.currency).detailedReason}));
            await this.hooks.write('more', true);
        } catch (error: any) {
            this.warn(this.homey.__('autopilot.hotwater_charge.write_failed', {error: error?.message ?? String(error)}));
            throw error;
        }
        this.autopilotStartedAt = e.at;
        this.wouldRunUntil = e.at + (e.minutes ?? 0) * 60_000;
        this.chargeStarted({...e, targetC: d.targetC});
    }

    /** The "Autopilot now" line from this slot's plan. A skip without an owner-facing reason
     *  (no reading this slot) leaves the line as it was. */
    private showStatus(input: ShadowStepInput, out: ShadowStep) {
        let s: HotwaterStatus | undefined;
        if ('skip' in out) s = out.skip === 'no model' ? {state: 'learning'} : out.skip === 'no prices' ? {state: 'no_prices'} : undefined;
        else if (out.entry.charging) {
            const last = this.lastStart;
            s = {state: 'charging', reason: last && input.slot * SLOT_MS - last.at < 6 * HOUR ? last.reason : undefined};
        } else s = {state: 'planned', next: out.next, until: out.until, now: input.slot * SLOT_MS};
        if (!s) return;
        const today = input.clock(input.slot * SLOT_MS).date;
        const when = (ms: number) => input.clock(ms).date === today ? this.time(ms)
            : this.homey.__('autopilot.hotwater_daily.tomorrow_bare', {time: this.time(ms)});
        this.hooks.status(hotwaterStatusText(s, (key, tokens) => this.homey.__(`autopilot.${key}`, tokens), when, this.shadow));
    }

    /** The run to the legionella temperature this slot, when it is due and this is the cheapest
     *  two hours before then (legionella.ts); or, a day past due and not reached, the pump's own
     *  periodic boost back on. Live only, and only while Autopilot holds that boost. */
    private async watchLegionella(input: ShadowStepInput, at: number) {
        if (this.shadow || this.starting || !this.hooks.periodicBoost) return;
        const setup = this.hooks.legionella?.();
        const state = readState(this.hooks.store.get(LEGIONELLA_STATE_KEY));
        if (!setup || !state) return;
        const busy = (input.now.powerW ?? 0) > 0 || this.chargingNow === true || at < this.wouldRunUntil;
        const prices = new Map([...this.prices].map(([slot, p]) => [slot * SLOT_MS, p.price]));
        const d = legionellaStep({state, now: at, slotStart: at, intervalDays: setup.intervalDays, targetC: setup.targetC,
            topC: input.now.top, busy, prices});
        if (d.action === 'fallback') return this.legionellaFallback(state, setup.targetC, at);
        if (d.action !== 'start') return;
        this.starting = true;
        try { await this.startLegionella(input, at, setup.targetC, d.window.price); } finally { this.starting = false; }
    }

    /** The legionella run: 62 to the legionella temperature, then More hot water for 6 h. Not
     *  capped by the compressor ceiling: the immersion heater is meant to finish it. One start
     *  and one stop write of the day's. */
    private async startLegionella(input: ShadowStepInput, at: number, targetC: number, price: number) {
        const count = countFor(this.hooks.store.get(WRITES_KEY), input.clock(at).date);
        const d = leverDecision(targetC, await this.hooks.pumpFacts(), count, {belowK: REACHED_K});
        const blocked = 'skip' in d ? BLOCKED[d.skip] : undefined;
        if (blocked) this.showBlocked(blocked, input.clock(at).date);
        // The run needs 62 at its own temperature: with the day's stop writes used it waits.
        const skip = 'skip' in d ? d.skip : d.targetC !== targetC ? 'daily limit' : undefined;
        if (skip) {
            if (this.leverSkip !== `legionella: ${skip}`) this.log(`Autopilot hot water: legionella run not started (${skip}).`);
            this.leverSkip = `legionella: ${skip}`;
            return;
        }
        const writeStop = !('skip' in d) && d.writeStop;
        const minutes = BOOST_HOURS * 60;
        // Saved before the writes, so a restart mid-run still knows the charge is the run's. The
        // writes count against the day's limit whether they land or not.
        const before = this.hooks.store.get(CHARGE_KEY);
        await this.hooks.store.set(CHARGE_KEY, {at, targetC, minutes, legionella: true});
        await this.hooks.store.set(WRITES_KEY, {...count, starts: count.starts + 1, stops: count.stops + (writeStop ? 1 : 0)});
        try {
            if (writeStop) await this.hooks.write('stop', targetC);
            await this.hooks.write('boost', BOOST_HOURS);
        } catch (error: any) {
            // The run never began: a restart must not hold normal charges back for it.
            await this.hooks.store.set(CHARGE_KEY, before ?? null).catch(() => undefined);
            this.warn(this.homey.__('autopilot.hotwater_charge.write_failed', {error: error?.message ?? String(error)}));
            throw error;
        }
        const dates = this.hooks.store.get(LEGIONELLA_DATES_KEY);
        const day = input.clock(at).date;
        const list = Array.isArray(dates) ? dates.filter((d: unknown) => typeof d === 'string' && d !== day) : [];
        await this.hooks.store.set(LEGIONELLA_DATES_KEY, [...list, day].slice(-LEGIONELLA_DATES_KEPT));
        // One run an interval: a run that falls short is not repeated (legionella.ts).
        const state = readState(this.hooks.store.get(LEGIONELLA_STATE_KEY));
        if (state) await this.hooks.store.set(LEGIONELLA_STATE_KEY, {...state, runAt: at});
        this.leverSkip = undefined;
        this.clearWarning();
        this.autopilotStartedAt = at;
        this.wouldRunUntil = at + minutes * 60_000;
        this.legionellaRunAt = at;
        this.extendedFor = at;
        this.chargeStarted({at, by: 'autopilot', reason: 'legionella', targetC, minutes, price: round(price),
            litres: input.now.litres === undefined ? undefined : round(input.now.litres, 0), top: input.now.top,
            reserveLitres: input.reserveLitres ?? DEFAULT_RESERVE_LITRES});
    }

    /** A day past due and not reached: the pump's own periodic boost back on, said once on the
     *  device and the timeline. Legionella runs stop until a charge gets there. A failed write is
     *  said and tried again next slot. */
    private async legionellaFallback(state: LegionellaState, targetC: number, at: number) {
        try {
            await this.hooks.periodicBoost!(true);
        } catch (error: any) {
            this.log('Autopilot hot water: could not turn the periodic boost back on:', error?.message ?? error);
            this.warn(this.homey.__('autopilot.hotwater_legionella.fallback_failed', {error: error?.message ?? String(error)}));
            return;
        }
        await this.hooks.store.set(LEGIONELLA_STATE_KEY, {...state, fallbackAt: at});
        const text = this.homey.__('autopilot.hotwater_legionella.overdue', {target: targetC});
        this.log(`Autopilot hot water: legionella run overdue (${targetC} °C not reached); the heat pump's periodic boost is back on.`);
        this.warn(text);
        this.homey.notifications.createNotification({excerpt: text})
            .catch((error: any) => this.log('Autopilot hot water: timeline failed:', error?.message ?? error));
    }

    /** A tank top reading: at the legionella temperature, the interval starts again, and a
     *  fallback in force ends (the periodic boost off again). Stored at most once an hour. */
    noteTop(topC: number | undefined, at = Date.now()) {
        if (this.stopped || this.shadow) return;
        const setup = this.hooks.legionella?.();
        const state = readState(this.hooks.store.get(LEGIONELLA_STATE_KEY));
        if (!setup || !state) return;
        const next = noteTop(state, topC, at, setup.targetC, setup.pumpC);
        if (next === state) return;
        const recovered = state.fallbackAt !== undefined;
        if (!recovered && state.lastReachedAt !== undefined && at - state.lastReachedAt < NOTE_EVERY_MS) return;
        this.hooks.store.set(LEGIONELLA_STATE_KEY, next)
            .catch((error) => this.log('Autopilot hot water: legionella state not saved:', error?.message ?? error));
        if (!recovered) return;
        this.log(`Autopilot hot water: the tank reached ${topC} °C; legionella runs resume and the periodic boost goes off again.`);
        this.warn(undefined);
        this.hooks.periodicBoost?.(false).catch((error: any) => {
            this.log('Autopilot hot water: could not turn the periodic boost off again:', error?.message ?? error);
            this.warn(this.homey.__('autopilot.hotwater_legionella.fallback_failed', {error: error?.message ?? String(error)}));
        });
    }

    /** No problem with the lever: the warning cleared, unless the legionella safety net is on,
     *  which stays said until a charge gets there. */
    private clearWarning() {
        const state = readState(this.hooks.store.get(LEGIONELLA_STATE_KEY));
        const setup = state?.fallbackAt !== undefined ? this.hooks.legionella?.() : undefined;
        this.warn(setup ? this.homey.__('autopilot.hotwater_legionella.overdue', {target: setup.targetC}) : undefined);
    }

    /** The device warning, set or cleared only on a change. */
    private warning?: string;
    private warn(text: string | undefined) {
        // Any other warning replaces a refused rescue's, so midnight must not clear that one.
        this.rescueWarnedOn = undefined;
        if (text === this.warning) return;
        this.warning = text;
        this.hooks.warn(text);
    }

    /** The plan in force and the recap so far, kept across a restart. */
    private savePlan() {
        const charged = [...this.ran].filter((slot) => Date.now() - slot * SLOT_MS < 2 * DAY_MS);
        const saved: SavedPlan = {dailySent: this.dailySent, plan: this.morningPlan, events: this.events, day: this.day,
            ...charged.length ? {charged} : {}};
        this.hooks.store.set(PLAN_KEY, saved).catch((error) => this.log('Autopilot hot water: plan not saved:', error?.message ?? error));
    }

    private chargeStarted(e: ChargeEvent) {
        this.events.push(e);
        if (this.dayAcc && !e.shadow) {
            this.dayAcc.starts[e.by === 'pump' ? 'pump' : 'autopilot']++;
            if (e.by === 'autopilot' && e.reason === 'reserve') this.dayAcc.rescues++;
        }
        if (!e.shadow) this.lastStart = e;
        this.savePlan();
        const t: Translate = (key, tokens) => this.homey.__(`autopilot.hotwater_charge.${key}`, tokens);
        const text = chargeText(e, t, this.time, this.currency);
        this.log(`Autopilot hot water charge (${e.by}${e.shadow ? ', test run' : ''}): ${text.reason}. ${text.detailedReason} ${JSON.stringify(e)}`);
        if (!e.shadow) this.hooks.charged(e, text);
        this.hooks.track('Started Hot Water Charge', {started_by: e.by === 'pump' ? 'device' : 'autopilot',
            ...e.reason !== 'pump' && e.reason !== 'running' && e.reason !== 'legionella' ? {charge_reason: trackedReason(e.reason)} : {},
            simulation: this.shadow});
        // The timeline hears only what the morning plan did not say: a safety-net start, a moved
        // or unplanned one. Charges as planned, and the pump's own, are for Flows and the recap.
        if (e.by !== 'autopilot' || (e.reason !== 'reserve' && e.plan === 'as_planned')) return;
        this.homey.notifications.createNotification({excerpt: chargeLine(e, t, this.time, this.currency, this.shadow)})
            .catch((error: any) => this.log('Autopilot hot water: timeline failed:', error?.message ?? error));
    }

    /** New or revised prices: replan from now, and tell what the prices changed and why. The
     *  plan they are told against is the one the old prices give from the tank as it is now, not
     *  the morning's: by afternoon the tank has drifted from the morning's projection, and that
     *  drift is not news. Only after the morning plan is out: before it there is no plan to have
     *  changed. When the collector split moves the price fetch to the home service, this is its
     *  "prices changed" event. */
    private pricesChanged(old: Map<number, PriceSlot>) {
        if (!this.morningPlan || this.stopped) return;
        const {now, tank} = this.read();
        if (!tank) return;
        const at = slotOf(Date.now()) * SLOT_MS;
        const input = this.input(at, now, tank);
        const after = dailyPlan(input);
        if ('skip' in after) return this.log(`Autopilot hot water: prices changed, no replan (${after.skip}).`);
        this.morningPlan = after;
        this.reserveFor(after);
        this.savePlan();
        const before = dailyPlan({...input, prices: old});
        if ('skip' in before) return this.log(`Autopilot hot water: prices changed, replanned (nothing to compare: ${before.skip}).`);
        this.log(`Autopilot hot water: prices changed, replanned: ${JSON.stringify(planChanges(before, after, at))}`);
        const tDaily: Translate = (key, tokens) => this.homey.__(`autopilot.hotwater_daily.${key}`, tokens);
        const when = (ms: number, at = false) => {
            const today = this.clock()(ms).date === after.date;
            return at ? tDaily(today ? 'today' : 'tomorrow', {time: this.time(ms)})
                : today ? this.time(ms) : tDaily('tomorrow_bare', {time: this.time(ms)});
        };
        const priceNow = (from: number, minutes: number) => {
            const run = Array.from({length: Math.max(1, minutes / 15)}, (_, k) => this.prices.get(slotOf(from) + k)?.price);
            return run.every((v) => v !== undefined) ? run.reduce((x, y) => x! + y!, 0)! / run.length : undefined;
        };
        const text = planUpdateText(before, after, at, (key, tokens) => this.homey.__(`autopilot.hotwater_update.${key}`, tokens),
            when, this.currency, this.shadow, priceNow);
        if (!text) return;
        this.homey.notifications.createNotification({excerpt: text})
            .catch((error: any) => this.log('Autopilot hot water: timeline failed:', error?.message ?? error));
    }

    /** The plan in force, for Plan vs actual after a restart (cost-check.ts). */
    dayPlan(): DailyPlan | undefined {
        return this.morningPlan;
    }

    private time = (ms: number) => localeTime(ms, 'sv-SE', {timeZone: this.homey.clock.getTimezone(), hour: '2-digit', minute: '2-digit'});

    /** With no plan in force (a first start, or a restart with none saved that is still current),
     *  the plan from now becomes it, without a message: charges are compared with it, and the
     *  widget shows it, instead of nothing until the next morning. */
    private adoptPlan(input: ShadowStepInput) {
        if (this.morningPlan && this.morningPlan.until > input.slot * SLOT_MS) return;
        const d = dailyPlan(input);
        if ('skip' in d) return;
        this.morningPlan = d;
        this.reserveFor(d);
        this.savePlan();
    }

    /** Once a day at DAILY_HOUR: the charges since the last morning, then what the day's plan is
     *  and what it rests on, to the log and the timeline. */
    private morning(input: ShadowStepInput) {
        const {date, hour} = input.clock(input.slot * SLOT_MS);
        if (hour !== DAILY_HOUR || this.dailySent === date) return;
        const d = dailyPlan(input);
        if ('skip' in d) return this.log(`Autopilot hot water: no morning plan (${d.skip}).`);
        this.dailySent = date;
        this.scoreDay(input);
        const recap = recapLines(this.events, (key, tokens) => this.homey.__(`autopilot.hotwater_charge.${key}`, tokens),
            this.time, this.shadow, (ms) => input.clock(ms).date, date);
        this.events = [];
        this.morningPlan = d;
        this.reserveFor(d);
        this.savePlan();
        const text = dailyPlanText(d, (key, tokens) => this.homey.__(`autopilot.hotwater_daily.${key}`, tokens),
            this.time, this.currency, this.shadow, recap);
        this.log(`Autopilot hot water morning plan: ${JSON.stringify(d)}`);
        this.hooks.planned?.(input.slot * SLOT_MS, d.charges);
        this.homey.notifications.createNotification({excerpt: text})
            .catch((error: any) => this.log('Autopilot hot water: timeline failed:', error?.message ?? error));
    }

    /** A rescue the day's starts refused: counted in the day, so the daily score shows it. */
    private noteRefusedRescue() {
        const day = this.day ??= {from: Date.now()};
        this.day = {...day, refusedRescues: (day.refusedRescues ?? 0) + 1};
        if (this.dayAcc) this.dayAcc.refused++;
        this.savePlan();
    }

    /** The tank's lowest volume and top since the morning, saved only when they change. */
    private watchDay(input: ShadowStepInput) {
        const now = input.slot * SLOT_MS;
        const before = this.day ??= {from: now};
        this.day = tankDayUpdate(before, input.now, input.reserveLitres ?? DEFAULT_RESERVE_LITRES);
        if (this.day !== before) this.savePlan();
    }

    /** The day since the last morning message, scored against the home's own expectation: once,
     *  with the morning message, then a new day starts. Never litres, °C, prices or times. */
    private scoreDay(input: ShadowStepInput) {
        const now = input.slot * SLOT_MS;
        const day = this.day ?? {from: now};
        this.day = {from: now};
        const yesterday = input.clock(now - DAY_MS).date;
        const drawn = this.model?.recent?.find((d) => d.date === yesterday && !d.away && !d.partial);
        const expected = drawn && this.model ? profileFor(this.model, drawn.dayType ?? dayTypeAt(this.hooks.dayType(), now - DAY_MS, input.clock))
            ?.daily : undefined;
        const window = [...this.prices].filter(([slot]) => slot * SLOT_MS >= day.from && slot * SLOT_MS < now).map(([, p]) => p.price);
        const charges = this.events.filter((e) => e.at >= day.from)
            .map((e) => ({by: e.by, surplusShare: e.surplusShare, price: e.price ?? this.prices.get(slotOf(e.at))?.price}));
        const score = hotwaterDayScore({day, now, charges, drawKwh: drawn?.draw, expectedKwh: expected,
            dayMeanPrice: window.length ? window.reduce((a, b) => a + b, 0) / window.length : undefined, simulation: this.shadow});
        if (score) this.hooks.track('Scored Autopilot Day', score);
    }

    private skip(why: string) {
        this.skipped.set(why, (this.skipped.get(why) ?? 0) + 1);
    }

    private report() {
        const skipped = [...this.skipped].map(([why, n]) => `${n} ${why}`).join(', ');
        this.skipped.clear();
        this.log(this.last ? `${summary(this.last)}${skipped ? ` Skipped ${skipped}.` : ''}`
            : `Autopilot hot water: nothing planned yet${skipped ? ` (${skipped})` : ''}.`);
    }
}
