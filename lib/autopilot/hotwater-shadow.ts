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
import {DayType, HotwaterModel, KWH_PER_LITRE, LocalClock, learn, localClock, profileFor} from './hotwater-learner';
import {TankCapabilities, fetchTankInsights, pointsFromInsights} from './hotwater-insights';
import {DEFAULT_RESERVE_LITRES, TankSpec, drawsFor, plan, reserveKwh} from './hotwater-planner';
import {appendLine, deleteHistory, modelFileName, saveJson, shadowLogName, trimLines} from './store-file';

const HOUR = 3_600_000;
/** Lowest and highest target the shadow plans with (doc §4.2). The ceiling will come from the
 *  register range and the learned compressor ceiling; until then the highest a compressor reaches
 *  without the immersion on most S-series pumps. */
export const MIN_C = 45;
export const MAX_C = 60;
/** A plan needs at least two hours of known prices. */
export const MIN_HORIZON = 8;
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

/** One slot's plan. Pure. */
export function hotwaterShadowStep(input: ShadowStepInput): ShadowStep {
    const {slot, now, model} = input;
    if (!model?.charge) return {skip: 'no model'};
    if (!Number.isFinite(now.litres)) return {skip: 'no reading'};
    const slots: number[] = [];
    for (let k = slot; input.prices.has(k); k++) slots.push(k);
    if (slots.length < MIN_HORIZON) return {skip: 'no prices'};
    const profile = profileFor(model, input.dayType);
    const draws = drawsFor(slots.map(() => profile), slots.map((k) => input.clock(k * SLOT_MS).hour));
    const charging = (now.powerW ?? 0) > 0;
    const stored = now.litres! * KWH_PER_LITRE;
    const p = plan({
        slots: slots.map((k, j) => ({price: input.prices.get(k)!.price, draw: draws[j]})),
        stored, charging, runningTargetC: now.more ? now.largeStopC : now.stopC,
        topC: now.top, tank: input.tank, charge: model.charge, loss: model.loss,
        reserve: reserveKwh(input.reserveLitres ?? DEFAULT_RESERVE_LITRES), minC: MIN_C, maxC: MAX_C,
    });
    const first = p.charges.find((c) => !(charging && c.start === 0));
    const iso = (k: number) => new Date(slots[k] * SLOT_MS).toISOString();
    return {entry: {
        slot, at: iso(0), litres: round(now.litres!, 1), top: now.top, charging, horizon: slots.length,
        action: charging ? 'running' : p.rescue ? 'rescue' : p.startNow ? 'start' : 'wait',
        next: first && {at: iso(first.start), targetC: first.targetC, heat: round(first.heat), cost: round(first.cost)},
        cost: round(p.cost), shortfall: round(p.shortfall),
    }};
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
        const out = hotwaterShadowStep({slot: slotOf(Date.now()), prices: this.prices, model: this.model, now, tank,
            clock: this.clock()});
        if ('skip' in out) return this.skip(out.skip);
        this.last = out.entry;
        appendLine(shadowLogName(this.fileName), out.entry)
            .then(async () => {
                if (++this.lines > KEEP + 2 * 96) this.lines = await trimLines(shadowLogName(this.fileName), KEEP);
            })
            .catch((error) => this.log('Autopilot hot water: log write failed:', error?.message ?? error));
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
