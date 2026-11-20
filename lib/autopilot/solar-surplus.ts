/** Solar surplus for every Autopilot function, learned once per home. Surplus is the household's,
 *  not one function's: hot water, pool, heating and cooling all want the same exported watts, so
 *  they share one fit, one live reading and one budget, and the same kW is never spent twice.
 *  The pure parts are in hotwater-surplus.ts (named for the function that used them first).
 *  Design: docs/autopilot-plan.md §1 of the solar plan (2026-11-12), §19.3. */
import {withApi} from '../indoor-sensors';
import {SLOT_MS} from './prices';
import {ExportBucket, LIVE_WINDOW, SurplusFit, exportBuckets, fitSurplus, gridMeter, gridMeters,
    liveSurplusKw, liveSurplusW, mergeBuckets, peakExportKw, solarDevices, SUNNY_GHI, sunNow, surplusForecast} from './hotwater-surplus';
import {RESOLUTIONS} from './hotwater-insights';
import {LOCATION_SETTING} from './collector';
import {weatherFor} from '../gateway-weather';

const HOUR = 3_600_000;
/** The surplus model is relearned this often; the forecast comes with it. */
const LEARN_EVERY_MS = 3 * HOUR;
/** Slots ahead that take the live surplus rather than the forecast: what is exported now is the
 *  best guess for the next half hour. */
const LIVE_SLOTS = 2;
/** How long the live reading is held ahead while the sun keeps up, slots: long enough for a charge
 *  started on it to be priced on it, short enough that a cloud front does not carry a promise. */
export const HOLD_SLOTS = 8;
const AHEAD_SLOTS = 2 * 96;

/** Who may use the surplus first. A store that must be filled anyway and holds it longest goes
 *  first: hot water's charges, then the pool, then the house as a battery, then cooling, which
 *  takes surplus when it is cooling anyway. */
export type SurplusUser = 'hotwater' | 'pool' | 'heating' | 'cooling';
export const SURPLUS_ORDER: SurplusUser[] = ['hotwater', 'pool', 'heating', 'cooling'];

/** The budget: expected surplus per slot and what each user has reserved. Pure. */
export class SurplusBudget {
    private reserved = new Map<SurplusUser, Map<number, number>>();

    /** What `user` reserves from now on, kW per slot; replaces its earlier reservation. */
    reserve(user: SurplusUser, kw: Map<number, number>) {
        this.reserved.set(user, new Map([...kw].filter(([, v]) => v > 0)));
    }

    /** Surplus left for `user`: the expected surplus minus what users before it reserved. */
    available(user: SurplusUser, surplus: Map<number, number> | undefined): Map<number, number> | undefined {
        if (!surplus) return undefined;
        const before = SURPLUS_ORDER.slice(0, SURPLUS_ORDER.indexOf(user));
        return new Map([...surplus].map(([slot, kw]) => {
            const taken = before.reduce((sum, u) => sum + (this.reserved.get(u)?.get(slot) ?? 0), 0);
            return [slot, Math.max(0, kw - taken)];
        }));
    }
}

/** The share of `drawKw` the surplus covers, and the price that leaves: surplus at what an
 *  exported kWh earns, the rest at the buy price. Pure. */
export function effectivePrice(price: number, exportPrice: number, surplusKw: number | undefined, drawKw: number): {price: number; share: number} {
    const share = drawKw > 0 ? Math.min(1, Math.max(0, surplusKw ?? 0) / drawKw) : 0;
    return {price: share * exportPrice + (1 - share) * price, share};
}

/** The owner's answer from setup (app setting, one per home): two switches and which grid meter
 *  to read when there are several. `live`: charge while the home exports, read at the meter; it
 *  can only ever replace a grid charge. `forecast`: plan around the sun ahead from the meter's
 *  history, which a battery or car charger taking the sun first makes wrong, so it is off unless
 *  the owner turns it on, and pauses itself when last week's sun did not reach the meter.
 *  Unset until setup asks; then live export counts once the export-vs-sun fit exists, the proof
 *  there are panels at all, and the forecast does not. An answer saved before the switches,
 *  `{panels}`, reads as `live` = panels with the forecast off. */
export const SOLAR_SETTING = 'autopilotSolar';
export interface SolarAnswer {
    live: boolean;
    forecast: boolean;
    meter?: string;
}

export function readSolarAnswer(raw: any): SolarAnswer | undefined {
    const meter = typeof raw?.meter === 'string' ? raw.meter : undefined;
    if (typeof raw?.live === 'boolean') return {live: raw.live, forecast: raw.forecast === true, meter};
    if (typeof raw?.panels === 'boolean') return {live: raw.panels, forecast: false, meter};
    return undefined;
}

/** Whether Autopilot uses surplus at all under this answer: either switch on, or no answer yet. */
export function solarOn(answer: SolarAnswer | undefined): boolean {
    return !answer || answer.live || answer.forecast;
}

/** Whether live export counts as surplus right now. Never without forecast sun (at night it is a
 *  battery selling). With sun: once the owner turned it on, or, before they answered, once the fit
 *  shows export that follows the sun. Pure. */
export function liveCounts(answer: SolarAnswer | undefined, fitted: boolean, sun: boolean): boolean {
    if (!sun) return false;
    return answer ? answer.live : fitted;
}

/** Last week's check of the forecast: sun the fit expected at the meter against what arrived. */
export interface ForecastCheck {
    held: boolean;
    expectedKwh: number;
    actualKwh: number;
}
/** Days back the forecast is checked over, and the share of its expected export that must have
 *  arrived. Measured 2026-11-14 on a home with a battery: a fit over three months expected 6–7×
 *  the export that came, since the battery took the sun first. */
export const CHECK_DAYS = 7;
export const CHECK_SHARE = 0.5;
/** Below this much expected export there is nothing to judge, and the forecast stands. */
const CHECK_MIN_KWH = 2;

/** Whether the fit's forecast held over the last `CHECK_DAYS`, hour by sunny hour. Pure. */
export function forecastHeld(fit: SurplusFit, ghi: Map<number, number>, buckets: ExportBucket[], now: number): ForecastCheck {
    let expectedKwh = 0, actualKwh = 0;
    for (const b of buckets) {
        if (b.hours !== 1 || b.start < now - CHECK_DAYS * 24 * HOUR || b.start >= now) continue;
        const g = ghi.get(b.start);
        if (g === undefined || g < SUNNY_GHI) continue;
        expectedKwh += Math.max(0, fit.a * g + fit.b);
        actualKwh += b.kwh;
    }
    const round = (v: number) => Math.round(v * 10) / 10;
    return {held: expectedKwh < CHECK_MIN_KWH || actualKwh >= CHECK_SHARE * expectedKwh,
        expectedKwh: round(expectedKwh), actualKwh: round(actualKwh)};
}

/** Expected surplus per slot from the live reading alone, kW: what is exported now holds while the
 *  sun does, for `holdSlots` at most, scaled down where the forecast has less sun than now and
 *  never up. The first `LIVE_SLOTS` take it as it is. No history: a battery or car charger taking
 *  the sun is already in the reading. Pure. */
export function heldLive(liveKw: number, ghi: Map<number, number>, nowMs: number, slotStarts: number[], holdSlots: number): number[] {
    const sunAt = (ms: number) => ghi.get(Math.floor(ms / HOUR) * HOUR) ?? 0;
    const now = sunAt(nowMs);
    return slotStarts.map((ms, j) => {
        if (j < LIVE_SLOTS) return liveKw;
        if (j >= holdSlots || !(now > 0)) return 0;
        const g = sunAt(ms);
        return g < SUNNY_GHI ? 0 : liveKw * Math.min(1, g / now);
    });
}

/** What the home has for surplus: its grid meters and solar devices, the meter's export history
 *  as far back as Insights keeps it, and the sun over the same time and two days ahead. */
async function survey(homey: any, preferred?: string, known?: {id: string; exported: string}) {
    return withApi(homey, async (api) => {
        // The meter found last time is read directly: listing every device in the home to find it
        // again every 3 hours cost a full device list each time. Setup (`known` unset) still scans.
        let meters: ReturnType<typeof gridMeters> = [];
        let solar: ReturnType<typeof solarDevices> = [];
        let meter = known && (!preferred || preferred === known.id)
            && await api.devices.getDevice({id: known.id, $cache: false, $timeout: 10_000}).then(() => known).catch(() => undefined);
        if (!meter) {
            const [devices, report] = await Promise.all([api.devices.getDevices({$cache: false, $timeout: 10_000}),
                api.energy.getLiveReport({})]);
            meters = gridMeters(devices, report);
            solar = solarDevices(devices);
            meter = gridMeter(devices, report, preferred);
        }
        if (!meter) return {meters, solar};
        const uri = `homey:device:${meter.id}`;
        const logs: ExportBucket[][] = [];
        for (const resolution of RESOLUTIONS) {
            const log = await api.insights.getLogEntries({uri, id: `${uri}:${meter.exported}`, resolution, $timeout: 20_000})
                .catch(() => undefined);
            logs.push(exportBuckets(log));
        }
        return {meters, solar, meter, buckets: mergeBuckets(logs), location: await weatherFor(homey, LOCATION_SETTING).location()};
    });
}

/** What setup shows (assets/pair/setup.js `solarStep`): the meters and panels found with their
 *  live power, and whether the meter's history shows export that follows the sun. */
export async function scanSolar(homey: any) {
    const answer = readSolarAnswer(homey.settings.get(SOLAR_SETTING));
    const found = await survey(homey, answer?.meter);
    let fit: SurplusFit | undefined;
    if (found.buckets?.length && found.location) {
        const ghi = await weatherFor(homey, LOCATION_SETTING).ghi() ?? new Map<number, number>();
        fit = fitSurplus(ghi, found.buckets);
    }
    const peak = found.buckets ? peakExportKw(found.buckets) : undefined;
    return {
        meters: found.meters.map((m) => ({id: m.id, name: m.name, w: m.w ?? null})),
        meter: found.meter?.id ?? null,
        solar: found.solar.map((d) => ({id: d.id, name: d.name, w: d.w ?? null})),
        followsSun: !!fit,
        peakKw: fit && peak !== undefined ? Math.round(peak * 10) / 10 : null,
        live: answer?.live ?? null,
        forecast: answer?.forecast ?? null,
    };
}

/** The home's surplus service: one per Homey, started by its first user and stopped by its last. */
export class SolarSurplus {
    private static instance?: SolarSurplus;
    private users = new Set<object>();
    /** The timers still pending. Each removes itself when it fires, so this holds only the live ones
     *  (it used to keep every timer ever started: thousands a day). */
    /** The grid meter the last survey used, so the next one reads it without a full device list. */
    private meter?: {id: string; exported: string};
    private timers = new Set<any>();
    private later(fn: () => void, ms: number) {
        const timer = this.homey.setTimeout(() => { this.timers.delete(timer); fn(); }, ms);
        this.timers.add(timer);
    }
    private ready = false;
    private fit?: SurplusFit;
    private ghi = new Map<number, number>();
    private live: {at: number; w: number}[] = [];
    private check?: ForecastCheck;
    private draws = new Map<object, () => number | undefined>();
    private state?: string;
    readonly budget = new SurplusBudget();

    private constructor(private readonly homey: any, private readonly log: (...args: any[]) => void) {}

    /** The home's service; `owner` keeps it running until it calls release(owner). */
    static acquire(homey: any, log: (...args: any[]) => void, owner: object): SolarSurplus {
        const service = SolarSurplus.instance ??= new SolarSurplus(homey, log);
        if (!service.users.size) service.start();
        service.users.add(owner);
        return service;
    }

    /** `owner`'s own draw now, W, whenever it runs on what would otherwise be exported (hot water's
     *  charge): added back to the live reading, or a charge started on surplus would read as
     *  having used it up. */
    draw(owner: object, watts: () => number | undefined) {
        this.draws.set(owner, watts);
    }

    release(owner: object) {
        this.draws.delete(owner);
        this.users.delete(owner);
        if (this.users.size) return;
        this.timers.forEach((timer) => this.homey.clearTimeout(timer));
        this.timers.clear();
        if (SolarSurplus.instance === this) SolarSurplus.instance = undefined;
    }

    /** Whether the home has a grid meter: without one there is never surplus. */
    get available(): boolean { return this.ready; }

    /** Expected export per slot from `slot`, kW: live for the next half hour; after it, the
     *  forecast when the owner turned it on and last week held, else the live reading held while
     *  the sun keeps up (`heldLive`). */
    forecast(slot: number): Map<number, number> | undefined {
        if (!this.ready) return undefined;
        const now = Date.now();
        const answer = this.answer();
        const live = liveCounts(answer, !!this.fit, sunNow(this.ghi, now)) ? liveSurplusKw(this.live, now) ?? 0 : 0;
        const starts = Array.from({length: AHEAD_SLOTS}, (_, j) => (slot + j) * SLOT_MS);
        const held = heldLive(live, this.ghi, now, starts, HOLD_SLOTS);
        const ahead = this.forecastOn(answer) ? surplusForecast(this.fit, this.ghi, starts) : undefined;
        return new Map(starts.map((ms, j) => [slot + j, j < LIVE_SLOTS || !ahead ? held[j] : ahead[j]]));
    }

    /** Whether the plan may count on the forecast: the owner's switch, a fit, and last week held. */
    private forecastOn(answer = this.answer()): boolean {
        return !!answer?.forecast && !!this.fit && this.check?.held !== false;
    }

    /** The owner turned the forecast on and last week's sun did not reach the meter: the widget
     *  says so. */
    get forecastPaused(): boolean {
        return !!this.answer()?.forecast && this.check?.held === false;
    }

    /** What is left for `user` from `slot` on, after users before it took theirs. */
    forUser(user: SurplusUser, slot: number): Map<number, number> | undefined {
        return this.budget.available(user, this.forecast(slot));
    }

    private answer(): SolarAnswer | undefined {
        return readSolarAnswer(this.homey.settings.get(SOLAR_SETTING));
    }

    /** Relearn now: the owner just answered setup. */
    refresh() {
        if (!this.users.size) return;
        this.learn().catch((error: any) => this.log('Solar surplus:', error?.message ?? error));
    }

    static refresh() { SolarSurplus.instance?.refresh(); }

    private start() {
        this.loop(() => this.learn(), 90_000);
        this.loop(() => this.sample(), 2 * 60_000);
    }

    private loop(job: () => Promise<number>, firstMs: number) {
        const run = async () => {
            if (!this.users.size) return;
            let next = LEARN_EVERY_MS;
            try { next = await job(); } catch (error: any) { this.log('Solar surplus:', error?.message ?? error); }
            if (this.users.size) this.later(run, next);
        };
        this.later(run, firstMs);
    }

    /** What surplus needs from the home (a grid meter Homey Energy counts and the owner's yes, or
     *  no answer yet), the fit of export against the sun over the meter's history, and the sun ahead. */
    private async learn(): Promise<number> {
        const answer = this.answer();
        const off = !solarOn(answer);
        const found = off ? undefined : await survey(this.homey, answer?.meter, this.meter);
        this.meter = found?.meter || undefined;
        if (!found?.meter || !found.location) {
            const state = off ? 'the owner turned it off' : !found?.meter ? 'no grid meter' : 'no location';
            if (state !== this.state) this.log(`Solar surplus: none (${state}).`);
            this.state = state;
            this.ready = false;
            this.fit = undefined;
            this.check = undefined;
            return LEARN_EVERY_MS;
        }
        this.ready = true;
        // The weather book's sun: 92 days fetched daily, the hours ahead from the shared forecast.
        this.ghi = await weatherFor(this.homey, LOCATION_SETTING).ghi() ?? new Map<number, number>();
        this.fit = fitSurplus(this.ghi, found.buckets ?? []);
        this.check = this.fit ? forecastHeld(this.fit, this.ghi, found.buckets ?? [], Date.now()) : undefined;
        const check = this.check ? `; last ${CHECK_DAYS} days ${this.check.actualKwh} of ${this.check.expectedKwh} kWh expected arrived` : '';
        const state = (this.fit ? `${this.fit.hours} sunny hours: ${Math.round(this.fit.a * 1000 * 100) / 100} kW `
            + `per 1000 W/m², ${Math.round(this.fit.b * 100) / 100} kW${check}` : 'too few sunny hours yet')
            + (answer ? `; live ${answer.live ? 'on' : 'off'}, forecast ${!answer.forecast ? 'off' : this.forecastOn(answer) ? 'on' : 'paused'}`
                : this.fit ? '; live export counts' : '; no surplus until there are');
        if (state !== this.state) this.log(`Solar surplus from ${state}.`);
        this.state = state;
        return LEARN_EVERY_MS;
    }

    /** One live reading a minute while the home has a grid meter. */
    private async sample(): Promise<number> {
        if (!this.ready) {
            this.live = [];
            return 60_000;
        }
        const now = Date.now();
        const own = [...this.draws.values()].reduce((sum, watts) => sum + Math.max(0, watts() ?? 0), 0);
        const w = liveSurplusW(await withApi(this.homey, (api) => api.energy.getLiveReport({})), own);
        if (w !== undefined) this.live.push({at: now, w});
        this.live = this.live.filter((r) => r.at > now - LIVE_WINDOW * 60_000);
        return 60_000;
    }
}
