/** Solar surplus for every Autopilot function, learned once per home. Surplus is the household's,
 *  not one function's: hot water, pool, heating and cooling all want the same exported watts, so
 *  they share one fit, one live reading and one budget, and the same kW is never spent twice.
 *  The pure parts are in hotwater-surplus.ts (named for the function that used them first).
 *  Design: docs/autopilot-plan.md §1 of the solar plan (2026-11-12), §19.3. */
import {withApi} from '../indoor-sensors';
import {SLOT_MS} from './prices';
import {ExportBucket, LIVE_WINDOW, SurplusFit, exportBuckets, fitSurplus, gridMeter, gridMeters, hourlyGhi, irradianceUrl,
    liveSurplusKw, liveSurplusW, mergeBuckets, peakExportKw, solarDevices, sunNow, surplusForecast} from './hotwater-surplus';
import {RESOLUTIONS} from './hotwater-insights';
import {getJson, LOCATION_SETTING} from './collector';
import {weatherLocation} from './weather';

const HOUR = 3_600_000;
/** The surplus model is relearned this often; the forecast comes with it. */
const LEARN_EVERY_MS = 3 * HOUR;
/** Slots ahead that take the live surplus rather than the forecast: what is exported now is the
 *  best guess for the next half hour. */
const LIVE_SLOTS = 2;
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

/** The owner's answer from setup (app setting, one per home): whether the home has panels, and
 *  which grid meter to read when there are several. Unset until setup asks; then live export
 *  counts only once the export-vs-sun fit exists, the proof there are panels at all. */
export const SOLAR_SETTING = 'autopilotSolar';
export interface SolarAnswer {
    panels: boolean;
    meter?: string;
}

export function readSolarAnswer(raw: any): SolarAnswer | undefined {
    if (!raw || typeof raw.panels !== 'boolean') return undefined;
    return {panels: raw.panels, meter: typeof raw.meter === 'string' ? raw.meter : undefined};
}

/** Whether live export counts as surplus right now. Never without forecast sun (at night it is a
 *  battery selling). With sun: once the owner said they have panels, or, before they answered,
 *  once the fit shows export that follows the sun. Pure. */
export function liveCounts(answer: SolarAnswer | undefined, fitted: boolean, sun: boolean): boolean {
    if (!sun || answer?.panels === false) return false;
    return answer?.panels === true || fitted;
}

/** What the home has for surplus: its grid meters and solar devices, the meter's export history
 *  as far back as Insights keeps it, and the sun over the same time and two days ahead. */
async function survey(homey: any, preferred?: string) {
    return withApi(homey, async (api) => {
        const [devices, report] = await Promise.all([api.devices.getDevices({$cache: false, $timeout: 10_000}),
            api.energy.getLiveReport({})]);
        const meters = gridMeters(devices, report);
        const solar = solarDevices(devices);
        const meter = gridMeter(devices, report, preferred);
        if (!meter) return {meters, solar};
        const uri = `homey:device:${meter.id}`;
        const logs: ExportBucket[][] = [];
        for (const resolution of RESOLUTIONS) {
            const log = await api.insights.getLogEntries({uri, id: `${uri}:${meter.exported}`, resolution, $timeout: 20_000})
                .catch(() => undefined);
            logs.push(exportBuckets(log));
        }
        const homeyLocation: any = await api.geolocation.getOptionLocation().catch(() => undefined);
        return {meters, solar, meter, buckets: mergeBuckets(logs),
            location: weatherLocation(homeyLocation?.value, homey.settings.get(LOCATION_SETTING))};
    });
}

/** What setup shows (assets/pair/setup.js `solarStep`): the meters and panels found with their
 *  live power, and whether the meter's history shows export that follows the sun. */
export async function scanSolar(homey: any) {
    const answer = readSolarAnswer(homey.settings.get(SOLAR_SETTING));
    const found = await survey(homey, answer?.meter);
    let fit: SurplusFit | undefined;
    if (found.buckets?.length && found.location) {
        const ghi = hourlyGhi(await getJson(irradianceUrl(found.location.latitude, found.location.longitude)));
        fit = fitSurplus(ghi, found.buckets);
    }
    const peak = found.buckets ? peakExportKw(found.buckets) : undefined;
    return {
        meters: found.meters.map((m) => ({id: m.id, name: m.name, w: m.w ?? null})),
        meter: found.meter?.id ?? null,
        solar: found.solar.map((d) => ({id: d.id, name: d.name, w: d.w ?? null})),
        followsSun: !!fit,
        peakKw: fit && peak !== undefined ? Math.round(peak * 10) / 10 : null,
        panels: answer?.panels ?? null,
    };
}

/** The home's surplus service: one per Homey, started by its first user and stopped by its last. */
export class SolarSurplus {
    private static instance?: SolarSurplus;
    private users = new Set<object>();
    private timers: any[] = [];
    private ready = false;
    private fit?: SurplusFit;
    private ghi = new Map<number, number>();
    private live: {at: number; w: number}[] = [];
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

    release(owner: object) {
        this.users.delete(owner);
        if (this.users.size) return;
        this.timers.forEach((timer) => this.homey.clearTimeout(timer));
        this.timers = [];
        if (SolarSurplus.instance === this) SolarSurplus.instance = undefined;
    }

    /** Whether the home has a grid meter: without one there is never surplus. */
    get available(): boolean { return this.ready; }

    /** Expected export per slot from `slot`, kW: live for the next half hour, the forecast after. */
    forecast(slot: number): Map<number, number> | undefined {
        if (!this.ready) return undefined;
        const live = liveCounts(this.answer(), !!this.fit, sunNow(this.ghi, Date.now())) ? liveSurplusKw(this.live, Date.now()) : 0;
        const ahead = Array.from({length: AHEAD_SLOTS}, (_, j) => slot + j);
        const forecast = surplusForecast(this.fit, this.ghi, ahead.map((k) => k * SLOT_MS));
        return new Map(ahead.map((k, j) => [k, j < LIVE_SLOTS && live !== undefined ? live : forecast[j]]));
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
            if (this.users.size) this.timers.push(this.homey.setTimeout(run, next));
        };
        this.timers.push(this.homey.setTimeout(run, firstMs));
    }

    /** What surplus needs from the home (a grid meter Homey Energy counts and the owner's yes, or
     *  no answer yet), the fit of export against the sun over the meter's history, and the sun ahead. */
    private async learn(): Promise<number> {
        const answer = this.answer();
        const found = answer?.panels === false ? undefined : await survey(this.homey, answer?.meter);
        if (!found?.meter || !found.location) {
            const state = answer?.panels === false ? 'the owner has no panels' : !found?.meter ? 'no grid meter' : 'no location';
            if (state !== this.state) this.log(`Solar surplus: none (${state}).`);
            this.state = state;
            this.ready = false;
            this.fit = undefined;
            return LEARN_EVERY_MS;
        }
        this.ready = true;
        this.ghi = hourlyGhi(await getJson(irradianceUrl(found.location.latitude, found.location.longitude)));
        this.fit = fitSurplus(this.ghi, found.buckets ?? []);
        const state = (this.fit ? `${this.fit.hours} sunny hours: ${Math.round(this.fit.a * 1000 * 100) / 100} kW `
            + `per 1000 W/m², ${Math.round(this.fit.b * 100) / 100} kW` : 'too few sunny hours yet to plan ahead')
            + (answer?.panels ? '; live export counts (owner has panels)' : this.fit ? '' : '; no surplus until there are');
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
        const w = liveSurplusW(await withApi(this.homey, (api) => api.energy.getLiveReport({})));
        if (w !== undefined) this.live.push({at: now, w});
        this.live = this.live.filter((r) => r.at > now - LIVE_WINDOW * 60_000);
        return 60_000;
    }
}
