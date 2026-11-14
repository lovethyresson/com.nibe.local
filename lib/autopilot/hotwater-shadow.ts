/** Hot water Autopilot: every 15 minutes, plan from the tank as it is and log what the planner
 *  does. As a test run it only reports; live it also starts the planned charges through
 *  hotwater-lever.ts, the only writes. Design: docs/autopilot-hot-water.md §5 (slices 3 and 4).
 *
 *  Standalone on purpose. Hot water is likely to ship before heating, so it does not wait for the
 *  collector split (autopilot-plan.md, shared inputs): it learns from the device's own Insights,
 *  which already hold the tank's history, and fetches prices itself. When the split lands, the
 *  price fetch moves to the home service and the tank fields to the per-pump history. */
import {withApi} from '../indoor-sensors';
import {DayPrices, PriceSlot, SLOT_MS, localDate, nextPriceFetchMs, normalisePrices, slotOf} from './prices';
import {DayDraw, DayProfile, DayType, HotwaterModel, Household, KWH_PER_LITRE, LocalClock, chargeRate, learn, localClock, lossAt, profileFor} from './hotwater-learner';
import {TankCapabilities, fetchTankInsights, pointsFromInsights} from './hotwater-insights';
import {DEFAULT_RESERVE_LITRES, Plan, SLOT_H, TankSpec, drawsFor, plan, reserveKwh} from './hotwater-planner';
import {appendLine, deleteHistory, modelFileName, saveJson, shadowLogName, trimLines} from './store-file';
import {DayTypeState, dayTypeAt} from './day-type';
import {PumpFacts, countFor, leverDecision} from './hotwater-lever';
import {BlockedBy, Edge, TankDay, hotwaterDayScore, leverBlock, tankDayUpdate} from './analytics';

const HOUR = 3_600_000;
/** Lowest and highest target the shadow plans with (doc §4.2). The highest is under where the
 *  compressor gives up: on the S1155 it stops near 58 °C (alarm 216 or 382) and the immersion
 *  heater finishes the rest at a third of the COP (docs/hot-water-heat-accounting.md). Below that
 *  the learned rate (hotwater-learner.ts `chargeRate`) already makes the last degrees slow and dear. */
export const MIN_C = 45;
export const MAX_C = 58;
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
}

/** A slot's plan: the log line, the first charge after any running one, with its reason, and
 *  the end of the known prices (ms). */
export type ShadowStep = {entry: ShadowEntry; next?: ChargeFacts; until: number} | {skip: string};

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
    const draws = drawsFor(slots.map((k) => input.dayTypeOf ? profileFor(model, input.dayTypeOf(k * SLOT_MS)) : profile),
        slots.map((k) => input.clock(k * SLOT_MS).hour));
    const charging = (now.powerW ?? 0) > 0;
    const p = plan({
        slots: slots.map((k, j) => {
            const price = input.prices.get(k)!;
            return {price: price.price, draw: draws[j], surplusKw: input.surplus?.get(k), exportPrice: price.spot ?? 0};
        }),
        stored: now.litres! * KWH_PER_LITRE, charging, runningTargetC: now.more ? now.largeStopC : now.stopC,
        topC: now.top, tank: input.tank, charge: model.charge, loss: model.loss,
        reserve: reserveKwh(input.reserveLitres ?? DEFAULT_RESERVE_LITRES), minC: MIN_C, maxC: MAX_C,
    });
    return {slots, plan: p, charging, profile, draws};
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

/** One slot's plan. Pure. */
export function hotwaterShadowStep(input: ShadowStepInput): ShadowStep {
    const out = planFrom(input);
    if ('skip' in out) return out;
    const {slots, plan: p, charging, draws} = out;
    const {slot, now} = input;
    const first = p.charges.find((c) => !(charging && c.start === 0));
    const iso = (k: number) => new Date(slots[k] * SLOT_MS).toISOString();
    const next = chargesOf(input, out, Infinity).charges.find((c) => c.reason !== 'running');
    return {next, until: (slots[slots.length - 1] + 1) * SLOT_MS, entry: {
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
 *  (its start temperature, or More hot water). */
export type ChargeReason = 'running' | 'reserve' | 'surplus' | 'cheap' | 'before_use' | 'pump';

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
    // previous charge and the next one (or the end of the known prices); a run that had to reach
    // into dearer hours to be ready for the use that follows says so instead. Up to 2026-11-14 the
    // window ended at the run's own end, so a charge starting now was always "cheap": one started
    // at the day's 16:00 peak read "Cheapest hours". A charge starting now with the tank under the
    // safety net is the safety net's, rescue or not (a hot top only spares it the rescue).
    const under = (input.now.litres ?? Infinity) < (input.reserveLitres ?? DEFAULT_RESERVE_LITRES);
    const charges = p.charges.filter((c) => slots[c.start] * SLOT_MS < before).map((c, i, all) => {
        let sum = 0;
        for (let k = c.start; k < c.end; k++) sum += buy(Math.min(k, slots.length - 1));
        const price = sum / Math.max(1, c.end - c.start);
        const reason: ChargeReason = charging && c.start === 0 ? 'running'
            : i === 0 && c.start === 0 && (p.rescue || under) ? 'reserve' : c.surplusShare >= 0.5 ? 'surplus'
            : price <= 1.02 * best(i ? all[i - 1].end : 0, i + 1 < all.length ? all[i + 1].start : slots.length, c.end - c.start) + 1e-9
                ? 'cheap' : 'before_use';
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
    const lines = [t(`title.${d.dayType ?? 'any'}`), ...recap, ...recap.length ? [t('today_heading')] : []];
    if (d.dayType === 'away') lines.push(t('away'));
    else if (d.useLitres !== undefined) lines.push(t('use', {litres: d.useLitres, p80: d.useLitresP80 ?? d.useLitres}));
    lines.push(d.reserveLitres > 0 ? t('tank', {litres: d.nowLitres, reserve: d.reserveLitres})
        : t('tank_no_reserve', {litres: d.nowLitres}));
    if (d.charges.length === 0) lines.push(t('none'));
    const when = (ms: number, date: string) => t(date === d.date ? 'today' : 'tomorrow', {time: time(ms)});
    for (const [i, c] of d.charges.entries()) {
        const reason = c.reason === 'cheap' || c.reason === 'before_use' ? t(`reason.${c.reason}`, {mean: money(d.meanPrice)})
            : c.reason === 'surplus' ? t('reason.surplus', {share: Math.round(c.surplusShare * 100)})
            : t(`reason.${c.reason}`);
        lines.push(t('charge', {target: c.targetC, time: when(c.at, d.chargeDates[i]), price: money(c.price), reason}));
    }
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
        : t(e.reason === 'reserve' || e.reason === 'surplus' ? `detail.${e.reason}` : 'detail.price', run);
    const plan = e.plan === 'moved' ? t('plan.moved', {time: time(e.plannedAt!)})
        : e.plan ? t(`plan.${e.plan}${e.by === 'pump' && e.plan === 'as_planned' ? '_pump' : ''}`) : '';
    return {reason: t(`reason.${e.reason}`), detailedReason: plan ? `${detail} ${plan}` : detail};
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
            {time: time(e.at), target: e.targetC ?? '?', reason: t(`reason.${e.reason}`)}) + plan);
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
    /** The two writes of a start: the Large stop (62) in °C, then More hot water (697 = 2). */
    write(what: 'stop' | 'more', value: number | boolean): Promise<void>;
    store: {get(key: string): any; set(key: string, value: any): Promise<void>};
    /** A real charge started, Autopilot's or the pump's: the Flow trigger. */
    charged(e: ChargeEvent, text: {reason: string; detailedReason: string}): void;
    /** A problem the owner must see on the device, or undefined to clear it. */
    warn(text: string | undefined): void;
    /** The device's "Autopilot now" line: the next planned charge and why, or what it waits for. */
    status(text: string): void;
    /** What setup asked a home with a short history, the learner's prior; undefined if not asked. */
    household(): Household | undefined;
    /** An analytics event (lib/analytics.ts `track`): a no-op without the owner's consent. */
    track(event: string, properties: Record<string, string | number | boolean>): void;
}

/** Device store keys: the charge Autopilot started last, and the day's writes. Both are written
 *  before the pump is: after a restart the charge is still Autopilot's and the writes still count. */
export const CHARGE_KEY = 'autopilotHotwaterCharge';
export const WRITES_KEY = 'autopilotHotwaterWrites';
/** Device store key: the plan in force, the date its morning message went out and the charges
 *  since, so a restart neither loses them (no plan to compare a charge with, an empty widget and
 *  recap until the next morning) nor sends the morning message twice. */
export const PLAN_KEY = 'autopilotHotwaterPlan';

/** What PLAN_KEY holds. */
export interface SavedPlan {
    dailySent?: string;
    plan?: DailyPlan;
    events: ChargeEvent[];
    /** The tank since that morning, for the day's score (analytics.ts). */
    day?: TankDay;
}

/** The saved plan to resume from, or nothing when it is too old to be the plan in force: a plan
 *  covers at most the prices known when it was made, two days. Pure. */
export function resumePlan(saved: SavedPlan | undefined, now: number): SavedPlan | undefined {
    if (!saved || !Array.isArray(saved.events)) return undefined;
    const fresh = saved.plan && saved.plan.until > now ? saved.plan : undefined;
    const day = Number.isFinite(saved.day?.from) && saved.day!.from <= now ? {day: saved.day} : {};
    return {dailySent: saved.dailySent, plan: fresh, events: saved.events.filter((e) => now - e.at < 2 * DAY_MS), ...day};
}
/** The surplus model is relearned this often; the forecast comes with it. */
const SURPLUS_EVERY_MS = 3 * HOUR;
/** Slots ahead that take the live surplus rather than the forecast: what is exported now is the
 *  best guess for the next half hour. */
const LIVE_SLOTS = 2;
/** Lever skips the owner must fix on the pump, and their locale key. */
const BLOCKED: Partial<Record<string, string>> = {'hot water off': 'hot_water_off', 'smart price adaption': 'spa', 'smart control': 'smart_control'};

/** Runs hot water Autopilot for one Hot water device, as a test run or live. */
export class HotwaterAutopilot {
    private prices = new Map<number, PriceSlot>();
    private model?: HotwaterModel;
    private timers: any[] = [];
    private stopped = false;
    private lines = 0;
    private skipped = new Map<string, number>();
    private last?: ShadowEntry;
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

    /** `dataId` is the device's pairing id (`getData().id`): the SDK does not expose the Homey
     *  device id that Insights are keyed by, so it is looked up through the Homey API. */
    constructor(private readonly homey: any, private readonly dataId: string, private readonly fileName: string,
                private readonly caps: TankCapabilities,
                private readonly read: () => {now: TankNow; tank?: TankSpec},
                private readonly log: (...args: any[]) => void,
                private readonly hooks: HotwaterHooks) {}

    async start() {
        this.lines = await trimLines(shadowLogName(this.fileName), KEEP).catch(() => 0);
        const charge = this.hooks.store.get(CHARGE_KEY) as {at: number; minutes: number} | undefined;
        if (charge && Date.now() - charge.at < 2 * HOUR) {
            this.autopilotStartedAt = charge.at;
            this.wouldRunUntil = charge.at + charge.minutes * 60_000;
        }
        const saved = resumePlan(this.hooks.store.get(PLAN_KEY), Date.now());
        if (saved) {
            this.dailySent = saved.dailySent;
            this.morningPlan = saved.plan;
            this.events = saved.events;
            this.lastStart = [...saved.events].reverse().find((e) => !e.shadow);
            this.day = saved.day;
            if (saved.plan) this.reserveFor(saved.plan);
        }
        this.loop(() => this.fetchPrices(), 5_000);
        this.loop(async () => { await this.learn(); return LEARN_EVERY_MS; }, 60_000);
        this.loop(async () => { this.report(); return HOUR; }, 10 * 60_000);
        this.scheduleStep();
    }

    stop() {
        this.stopped = true;
        this.timers.forEach((timer) => this.homey.clearTimeout(timer));
        this.timers = [];
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
    outlook(from: number, n: number): {slots: {price?: number; surplus?: number; charge?: number}[]; litres?: number;
        next?: {at: number; minutes: number; reason: ChargeReason; solar: number}} {
        const charges = this.morningPlan?.charges ?? [];
        const covering = (slot: number) => charges.find((c) => slot * SLOT_MS < c.at + c.minutes * 60_000
            && (slot + 1) * SLOT_MS > c.at);
        const surplus = this.surplus(from);
        const now = Date.now();
        const next = charges.find((c) => c.at + c.minutes * 60_000 > now);
        return {
            slots: Array.from({length: n}, (_, k) => {
                const c = covering(from + k);
                const kw = surplus?.get(from + k);
                return {price: this.prices.get(from + k)?.price, surplus: kw === undefined ? undefined : Math.max(0, round(kw, 2)),
                    charge: c ? c.surplusShare : undefined};
            }),
            litres: this.last?.litres,
            next: next && {at: next.at, minutes: next.minutes, reason: next.reason, solar: next.surplusShare},
        };
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
            if (!this.stopped) this.timers.push(this.homey.setTimeout(run, next));
        };
        this.timers.push(this.homey.setTimeout(run, firstMs));
    }

    /** Half a minute into each slot, so the poll has read the tank since the boundary. */
    private scheduleStep() {
        if (this.stopped) return;
        const now = Date.now();
        const wait = (slotOf(now) + 1) * SLOT_MS + 30_000 - now;
        this.timers.push(this.homey.setTimeout(() => { this.step(); this.scheduleStep(); }, wait));
    }

    private clock(): LocalClock {
        return localClock(this.homey.clock.getTimezone());
    }

    private get shadow() {
        return this.hooks.mode() !== 'live';
    }

    private async learn() {
        const started = Date.now();
        const logs = await withApi(this.homey, async (api) => {
            this.deviceId ??= ownDeviceId(await api.devices.getDevices({$cache: false, $timeout: 10_000}),
                this.homey.manifest?.id ?? 'com.nibe.local', this.dataId);
            if (!this.deviceId) throw new Error('could not find this device through the Homey API');
            return fetchTankInsights(api, this.deviceId, this.caps,
                (ms) => new Promise((resolve) => this.homey.setTimeout(resolve, ms)));
        });
        const points = pointsFromInsights(logs);
        if (points.length < 48) {
            this.log(`Autopilot hot water: ${points.length} readings in Insights, too few to learn from yet.`);
            return;
        }
        // Each reading is learned under the day type in force when it was taken; where none was
        // set, the calendar's.
        const dayTypes = this.hooks.dayType();
        const clock = this.clock();
        for (const point of points) point.dayType = dayTypeAt(dayTypes, point.t, clock);
        const model = learn(points, this.clock(), started, undefined, this.hooks.household());
        this.model = model;
        const c = model.charge, any = model.profiles.any;
        const typed = (['working', 'free'] as const).filter((type) => model.profiles[type]).join(' and ');
        this.log(`Autopilot hot water: learned from ${points.length} readings over ${model.days} days: `
            + `${any ? `${round(any.daily, 1)} kWh heat a day (p80 ${round(any.dailyP80, 1)})` : 'no day profile'}, `
            + `${typed ? `own profiles for ${typed} days, ` : ''}`
            + `${c ? `tank COP ${round(c.cop)}, ${round(chargeRate(c, 2), 1)} kWh/h near empty to ${round(chargeRate(c, 9), 1)} near full, `
                + `${round(c.kw ?? NaN, 1)} kW` : 'no charge model'}, `
            + `loss ${round(model.loss.base, 3)} + ${round(model.loss.perKwh, 3)}/kWh an hour (${Date.now() - started} ms).`);
        await saveJson(modelFileName(this.fileName), {at: new Date(started).toISOString(), model});
    }

    /** Today's and tomorrow's prices, as the heating collector fetches them (it will be one fetch
     *  once the home service exists). */
    private async fetchPrices(): Promise<number> {
        const now = Date.now();
        const timeZone = this.homey.clock.getTimezone();
        const days = await withApi(this.homey, async (api) => {
            if (await api.energy.getElectricityPriceType() !== 'dynamic') return [] as DayPrices[];
            this.currency = String(await api.energy.getCurrency().catch(() => '') ?? '');
            const costs = await api.energy.getDynamicElectricityPriceUserCosts().catch(() => undefined);
            const fetchDay = (date: string) => api.energy.fetchDynamicElectricityPrices({date})
                .then((response: any) => normalisePrices(response, costs?.mathExpression))
                .catch(() => ({slots: [], costsApplied: false}) as DayPrices);
            return Promise.all([fetchDay(localDate(now, timeZone)), fetchDay(localDate(now, timeZone, 1))]);
        });
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
            reserveLitres: this.hooks.reserveLitres()};
    }

    private step() {
        if (this.stopped) return;
        const {now, tank} = this.read();
        if (!tank) return this.skip('no tank size');
        const at = slotOf(Date.now()) * SLOT_MS;
        const input = this.input(at, now, tank);
        this.watchDay(input);
        this.morning(input);
        this.adoptPlan(input);
        this.watchStarts(input, at).catch((error) => this.log('Autopilot hot water: start failed:', error?.message ?? error));
        const out = hotwaterShadowStep(input);
        this.showStatus(input, out);
        // No prices blocks the plan until a plan is made again; other skips change nothing.
        const noPrices = 'skip' in out && out.skip === 'no prices';
        if ((noPrices || !('skip' in out)) && this.pricesBlocked.changed(noPrices) && noPrices)
            this.hooks.track('Blocked Autopilot', {role: 'hotwater', blocked_by: 'no_prices', simulation: this.shadow});
        if ('skip' in out) return this.skip(out.skip);
        this.last = out.entry;
        appendLine(shadowLogName(this.fileName), out.entry)
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

    /** The live lever: 62 to the target if it differs, then 697 = 2. */
    private async startCharge(e: ChargeEvent, date: string) {
        const count = countFor(this.hooks.store.get(WRITES_KEY), date);
        const d = leverDecision(e.targetC!, await this.hooks.pumpFacts(), count);
        // A pump setting that keeps Autopilot out is the owner's to change, so it is on the device,
        // not only in the log.
        const blocked = 'skip' in d ? BLOCKED[d.skip] : undefined;
        if (blocked) this.warn(this.homey.__(`autopilot.hotwater_charge.blocked.${blocked}`));
        else this.warn(undefined);
        if ('skip' in d) {
            if (this.leverSkip !== d.skip) this.log(`Autopilot hot water: planned charge not started (${d.skip}).`);
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

    /** The device warning, set or cleared only on a change. */
    private warning?: string;
    private warn(text: string | undefined) {
        if (text === this.warning) return;
        this.warning = text;
        this.hooks.warn(text);
    }

    /** The plan in force and the recap so far, kept across a restart. */
    private savePlan() {
        const saved: SavedPlan = {dailySent: this.dailySent, plan: this.morningPlan, events: this.events, day: this.day};
        this.hooks.store.set(PLAN_KEY, saved).catch((error) => this.log('Autopilot hot water: plan not saved:', error?.message ?? error));
    }

    private chargeStarted(e: ChargeEvent) {
        this.events.push(e);
        if (!e.shadow) this.lastStart = e;
        this.savePlan();
        const t: Translate = (key, tokens) => this.homey.__(`autopilot.hotwater_charge.${key}`, tokens);
        const text = chargeText(e, t, this.time, this.currency);
        this.log(`Autopilot hot water charge (${e.by}${e.shadow ? ', test run' : ''}): ${text.reason}. ${text.detailedReason} ${JSON.stringify(e)}`);
        if (!e.shadow) this.hooks.charged(e, text);
        this.hooks.track('Started Hot Water Charge', {started_by: e.by === 'pump' ? 'device' : 'autopilot',
            ...e.reason !== 'pump' && e.reason !== 'running' ? {charge_reason: e.reason} : {}, simulation: this.shadow});
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

    private time = (ms: number) => new Date(ms).toLocaleTimeString('sv-SE',
        {timeZone: this.homey.clock.getTimezone(), hour: '2-digit', minute: '2-digit'});

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
        this.homey.notifications.createNotification({excerpt: text})
            .catch((error: any) => this.log('Autopilot hot water: timeline failed:', error?.message ?? error));
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
