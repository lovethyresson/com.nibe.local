/** Hot water Autopilot in shadow: every 15 minutes, plan from the tank as it is and log what the
 *  planner would do. Reads only; nothing here writes to the pump. Design:
 *  docs/autopilot-hot-water.md §5 (slice 3).
 *
 *  Standalone on purpose. Hot water is likely to ship before heating, so it does not wait for the
 *  collector split (autopilot-plan.md, shared inputs): it learns from the device's own Insights,
 *  which already hold the tank's history, and fetches prices itself. When the split lands, the
 *  price fetch moves to the home service and the tank fields to the per-pump history. */
import {withApi} from '../indoor-sensors';
import {DayPrices, PriceSlot, SLOT_MS, localDate, nextPriceFetchMs, normalisePrices, slotOf} from './prices';
import {DayProfile, DayType, HotwaterModel, KWH_PER_LITRE, LocalClock, learn, localClock, profileFor} from './hotwater-learner';
import {TankCapabilities, fetchTankInsights, pointsFromInsights} from './hotwater-insights';
import {DEFAULT_RESERVE_LITRES, Plan, TankSpec, drawsFor, plan, reserveKwh} from './hotwater-planner';
import {appendLine, deleteHistory, modelFileName, saveJson, shadowLogName, trimLines} from './store-file';

const HOUR = 3_600_000;
/** Lowest and highest target the shadow plans with (doc §4.2). The ceiling will come from the
 *  register range and the learned compressor ceiling; until then the highest a compressor reaches
 *  without the immersion on most S-series pumps. */
export const MIN_C = 45;
export const MAX_C = 60;
/** A plan needs at least two hours of known prices. */
export const MIN_HORIZON = 8;
/** Local hour the morning plan is sent. */
export const DAILY_HOUR = 7;
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
    prices: Map<number, {price: number}>;
    model?: HotwaterModel;
    now: TankNow;
    tank: TankSpec;
    clock: LocalClock;
    dayType?: DayType;
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
}

export type ShadowStep = {entry: ShadowEntry} | {skip: string};

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

type Planned = {slots: number[]; plan: Plan; charging: boolean; profile?: DayProfile};

/** The plan from `input.slot` over the contiguous run of known prices, or why there is none. */
function planFrom(input: ShadowStepInput): Planned | {skip: string} {
    const {slot, now, model} = input;
    if (!model?.charge) return {skip: 'no model'};
    if (!Number.isFinite(now.litres)) return {skip: 'no reading'};
    const slots: number[] = [];
    for (let k = slot; input.prices.has(k); k++) slots.push(k);
    if (slots.length < MIN_HORIZON) return {skip: 'no prices'};
    const profile = profileFor(model, input.dayType);
    const draws = drawsFor(slots.map(() => profile), slots.map((k) => input.clock(k * SLOT_MS).hour));
    const charging = (now.powerW ?? 0) > 0;
    const p = plan({
        slots: slots.map((k, j) => ({price: input.prices.get(k)!.price, draw: draws[j]})),
        stored: now.litres! * KWH_PER_LITRE, charging, runningTargetC: now.more ? now.largeStopC : now.stopC,
        topC: now.top, tank: input.tank, charge: model.charge, loss: model.loss,
        reserve: reserveKwh(input.reserveLitres ?? DEFAULT_RESERVE_LITRES), minC: MIN_C, maxC: MAX_C,
    });
    return {slots, plan: p, charging, profile};
}

/** One slot's plan. Pure. */
export function hotwaterShadowStep(input: ShadowStepInput): ShadowStep {
    const out = planFrom(input);
    if ('skip' in out) return out;
    const {slots, plan: p, charging} = out;
    const {slot, now} = input;
    const first = p.charges.find((c) => !(charging && c.start === 0));
    const iso = (k: number) => new Date(slots[k] * SLOT_MS).toISOString();
    return {entry: {
        slot, at: iso(0), litres: round(now.litres!, 1), top: now.top, charging, horizon: slots.length,
        action: charging ? 'running' : p.rescue ? 'rescue' : p.startNow ? 'start' : 'wait',
        next: first && {at: iso(first.start), targetC: first.targetC, heat: round(first.heat), cost: round(first.cost)},
        cost: round(p.cost), shortfall: round(p.shortfall),
    }};
}

/** Why a charge is where it is, as the morning message tells it. */
export type ChargeReason = 'running' | 'reserve' | 'surplus' | 'cheap' | 'before_use';

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
    charges: {at: number; targetC: number; price: number; surplusShare: number; cost: number; reason: ChargeReason}[];
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
    const {slots, plan: p, charging, profile} = out;
    const start = slots[0] * SLOT_MS;
    const buy = (k: number) => input.prices.get(slots[k])!.price;
    const day = slots.filter((k) => k * SLOT_MS < start + DAY_MS);
    /** Mean price of the cheapest `n` slots in [from, to): the best the run could have bought. */
    const best = (from: number, to: number, n: number) => {
        const window = [];
        for (let k = from; k < to; k++) window.push(buy(k));
        window.sort((a, b) => a - b);
        const take = window.slice(0, Math.max(1, n));
        return take.reduce((a, b) => a + b, 0) / take.length;
    };
    // "Cheap" when the run bought about as well as any run of its length could have, between the
    // previous charge and its own end; a run that had to reach into dearer hours to be ready for
    // the use that follows says so instead.
    const charges = p.charges.filter((c) => slots[c.start] * SLOT_MS < start + DAY_MS).map((c, i, all) => {
        let sum = 0;
        for (let k = c.start; k < c.end; k++) sum += buy(Math.min(k, slots.length - 1));
        const price = sum / Math.max(1, c.end - c.start);
        const reason: ChargeReason = charging && c.start === 0 ? 'running'
            : i === 0 && c.start === 0 && p.rescue ? 'reserve' : c.surplusShare >= 0.5 ? 'surplus'
            : price <= 1.02 * best(i ? all[i - 1].end : 0, Math.min(c.end, slots.length), c.end - c.start) + 1e-9
                ? 'cheap' : 'before_use';
        return {at: slots[c.start] * SLOT_MS, targetC: c.targetC, price: round(price),
            surplusShare: round(c.surplusShare), cost: round(c.cost), reason};
    });
    return {
        date: input.clock(start).date, dayType: input.dayType,
        useLitres: profile && round(profile.daily / KWH_PER_LITRE, 0),
        useLitresP80: profile && round(profile.dailyP80 / KWH_PER_LITRE, 0),
        nowLitres: round(input.now.litres!, 0), top: input.now.top,
        reserveLitres: input.reserveLitres ?? DEFAULT_RESERVE_LITRES,
        charges, meanPrice: round(day.reduce((sum, k) => sum + input.prices.get(k)!.price, 0) / day.length),
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
                              shadow: boolean): string {
    const money = (v: number) => `${v.toFixed(2)} ${currency}`.trim();
    const lines = [t(`title.${d.dayType ?? 'any'}`)];
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

/** Runs the shadow for one Hot water device. */
export class HotwaterShadow {
    private prices = new Map<number, PriceSlot>();
    private model?: HotwaterModel;
    private timers: any[] = [];
    private stopped = false;
    private lines = 0;
    private skipped = new Map<string, number>();
    private last?: ShadowEntry;
    private deviceId?: string;
    private currency = '';
    /** Local date of the last morning plan sent. */
    private dailySent?: string;

    /** `dataId` is the device's pairing id (`getData().id`): the SDK does not expose the Homey
     *  device id that Insights are keyed by, so it is looked up through the Homey API. */
    constructor(private readonly homey: any, private readonly dataId: string, private readonly fileName: string,
                private readonly caps: TankCapabilities,
                private readonly read: () => {now: TankNow; tank?: TankSpec},
                private readonly log: (...args: any[]) => void) {}

    async start() {
        this.lines = await trimLines(shadowLogName(this.fileName), KEEP).catch(() => 0);
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
        // No day type yet (slice 4 puts it on Main): every day plans with the pooled profile.
        const model = learn(points, this.clock(), started);
        this.model = model;
        const c = model.charge, any = model.profiles.any;
        this.log(`Autopilot hot water: learned from ${points.length} readings over ${model.days} days: `
            + `${any ? `${round(any.daily, 1)} kWh heat a day (p80 ${round(any.dailyP80, 1)})` : 'no day profile'}, `
            + `${c ? `COP ${round(c.cop)} at ${round(c.atTop, 0)} °C, ${round(c.heatPerHour, 1)} kWh/h` : 'no charge model'}, `
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
        for (const day of days) for (const slot of day.slots) this.prices.set(slot.slot, slot);
        return nextPriceFetchMs(now, timeZone, (days[1]?.slots.length ?? 0) > 0);
    }

    private step() {
        if (this.stopped) return;
        const {now, tank} = this.read();
        if (!tank) return this.skip('no tank size');
        const input = {slot: slotOf(Date.now()), prices: this.prices, model: this.model, now, tank, clock: this.clock()};
        this.morning(input);
        const out = hotwaterShadowStep(input);
        if ('skip' in out) return this.skip(out.skip);
        this.last = out.entry;
        appendLine(shadowLogName(this.fileName), out.entry)
            .then(async () => {
                if (++this.lines > KEEP + 2 * 96) this.lines = await trimLines(shadowLogName(this.fileName), KEEP);
            })
            .catch((error) => this.log('Autopilot hot water: log write failed:', error?.message ?? error));
    }

    /** Once a day at DAILY_HOUR: what the day's plan is and what it rests on, to the log and the
     *  timeline. */
    private morning(input: ShadowStepInput) {
        const {date, hour} = input.clock(input.slot * SLOT_MS);
        if (hour !== DAILY_HOUR || this.dailySent === date) return;
        const d = dailyPlan(input);
        if ('skip' in d) return this.log(`Autopilot hot water: no morning plan (${d.skip}).`);
        this.dailySent = date;
        const timeZone = this.homey.clock.getTimezone();
        const time = (ms: number) => new Date(ms).toLocaleTimeString('sv-SE', {timeZone, hour: '2-digit', minute: '2-digit'});
        const text = dailyPlanText(d, (key, tokens) => this.homey.__(`autopilot.hotwater_daily.${key}`, tokens),
            time, this.currency, true);
        this.log(`Autopilot hot water morning plan: ${JSON.stringify(d)}`);
        this.homey.notifications.createNotification({excerpt: text})
            .catch((error: any) => this.log('Autopilot hot water: timeline failed:', error?.message ?? error));
    }

    private skip(why: string) {
        this.skipped.set(why, (this.skipped.get(why) ?? 0) + 1);
    }

    private report() {
        const skipped = [...this.skipped].map(([why, n]) => `${n} ${why}`).join(', ');
        this.skipped.clear();
        this.log(this.last ? `${summary(this.last)}${skipped ? ` Skipped ${skipped}.` : ''}`
            : `Autopilot hot water shadow: nothing planned yet${skipped ? ` (${skipped})` : ''}.`);
    }
}
