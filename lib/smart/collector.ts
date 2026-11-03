/** Collects the smart heating history for one pump: poll samples from the Heating device, prices
 *  from Homey Energy and weather from Open-Meteo; refits the house model hourly; and runs the
 *  controller in shadow every slot. Reads only; nothing here writes to the pump.
 *  Design: docs/smart-heating-plan.md §5.2–5.4, §6, §7.5. */
import https from 'https';
import {SensorRef, selectedReadings, withApi} from '../indoor-sensors';
import {Aggregator, FLAG, Field, History, Sample, SlotContext, encodeRecord} from './history';
import {DayPrices, PriceSlot, SLOT_MS, localDate, nextPriceFetchMs, normalisePrices, slotOf} from './prices';
import {Place, WEATHER_STALE_MS, WeatherSlot, openMeteoUrl, placeSearchUrl, placesFrom, weatherLocation, weatherSlots} from './weather';
import {
    appendJournal, appendLine, deleteHistory, loadHistory, loadJson, modelFileName, saveHistory, saveJson, shadowLogName,
    shadowStateName, trimLines,
} from './store-file';
import {DailyFit, HouseAnswers, HouseFit, drifting, fitHistory, readiness, recordDailyFit} from './house';
import {houseInsights, insightsLine} from './insights';
import {ForecastBias, forecastCorrection, learnForecastBias, newForecastBias, usableSensor} from './outdoor';
import {SHADOW_PRESETS, ShadowMemory, shadowForecast, shadowStep} from './shadow';
import {PumpThresholds} from './actuator';

const HOUR = 60 * 60 * 1000;
/** App setting: the Homey sensor the owner picked for outdoor, a SensorRef. Setup will write it
 *  (plan §4.2); until then it is set by hand, `homey api apps set-app-setting`. */
export const OUTDOOR_SENSOR_SETTING = 'smartOutdoorSensor';
/** App setting: a `Place` the owner searched for, used when the Homey has no location. */
export const LOCATION_SETTING = 'smartLocation';

/** Setup's place search, for a Homey without a location (plan §8). */
export async function searchPlaces(query: string, language = 'en'): Promise<Place[]> {
    if (query.trim().length < 2) return [];
    return placesFrom(await getJson(placeSearchUrl(query, language)));
}
/** Minute readings a slot needs before its sensor mean stands for the slot. */
const SENSOR_MIN_READINGS = 5;
/** Shadow log lines kept: 28 days of slots, trimmed once it passes 30. */
const SHADOW_KEEP = 28 * 96;

/** The pump settings the controller reads, as of the latest poll. */
export interface Controls {
    /** Indoor setpoint (2505), °C. */
    comfort?: number;
    /** Operating mode (237): 0 Auto, 1 Manual, 2 immersion heater only. */
    mode?: number;
    thresholds: PumpThresholds;
}

function getJson(url: string, timeoutMs = 15_000): Promise<any> {
    return new Promise((resolve, reject) => {
        const request = https.get(url, {headers: {'User-Agent': 'com.nibe.local (Homey app)'}}, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => {
                if ((response.statusCode ?? 0) >= 400) return reject(new Error(`HTTP ${response.statusCode}`));
                try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
            });
        });
        request.setTimeout(timeoutMs, () => request.destroy(new Error('timed out')));
        request.on('error', reject);
    });
}

export class SmartCollector {
    private history = new History();
    private aggregator: Aggregator;
    private prices = new Map<number, PriceSlot>();
    private costsApplied = false;
    private weather = new Map<number, WeatherSlot>();
    private weatherAt = 0;
    private pricesAt = 0;
    private timers: any[] = [];
    private stopped = false;
    private dailyFits: DailyFit[] = [];
    private fit?: HouseFit;
    private controls: Controls = {thresholds: {}};
    private shadowMemory: ShadowMemory = {};
    private forecastBias: ForecastBias = newForecastBias();
    private shadowSlot?: number;
    private shadowLines = 0;
    private shadowSkipped = new Map<string, number>();
    private lastShadow?: any;
    private sensorSums = new Map<number, {sum: number; n: number}>();
    private sensorState = '';
    private locationState = '';

    constructor(private readonly homey: any, private readonly fileName: string,
                private readonly log: (...args: any[]) => void,
                private readonly answers: HouseAnswers = {system: 'unknown', era: 'unknown'}) {
        this.aggregator = this.newAggregator();
    }

    private newAggregator() {
        return new Aggregator(this.history, (slot) => this.context(slot), (slot, values) => this.journal(slot, values));
    }

    private journal(slot: number, values: Record<Field, number>) {
        appendJournal(this.fileName, encodeRecord(slot, values))
            .catch((error) => this.log('Smart history: journal write failed:', error?.message ?? error));
        // Off the poll's call stack: three plans take a moment on a Homey.
        this.homey.setTimeout(() => this.shadow(slot, values), 0);
    }

    async start() {
        const loaded = await loadHistory(this.fileName).catch((error) => {
            this.log('Smart history: could not read the saved file, starting a new one:', error?.message ?? error);
            return undefined;
        });
        if (loaded) {
            this.history = loaded;
            this.aggregator = this.newAggregator();
        }
        // Save before the first journal record: a journal is read with the saved file's field
        // count, so a file from before a field was appended must not gain new-format records.
        await this.save().catch((error) => this.log('Smart history: save failed:', error?.message ?? error));
        const model = await loadJson<{dailyFits?: DailyFit[]}>(modelFileName(this.fileName)).catch(() => undefined);
        this.dailyFits = Array.isArray(model?.dailyFits) ? model!.dailyFits : [];
        // `outdoorBias`, not the earlier `forecastBias`: that one learned from the BT1 test feeds of
        // 2026-11-02 before fed slots were recognised, and starts over.
        const shadow = await loadJson<{memory?: ShadowMemory; outdoorBias?: ForecastBias; slot?: number}>(
            shadowStateName(this.fileName)).catch(() => undefined);
        if (shadow?.memory) this.shadowMemory = shadow.memory;
        if (shadow?.outdoorBias?.mean?.length === 24) this.forecastBias = shadow.outdoorBias;
        this.shadowSlot = shadow?.slot;
        this.shadowLines = await trimLines(shadowLogName(this.fileName), SHADOW_KEEP).catch(() => 0);
        this.log(`Smart history: ${this.history.range().length} slots in /userdata/${this.fileName}.`);
        this.loop(() => this.fetchPrices(), 5_000);
        this.loop(() => this.fetchWeather(), 20_000);
        this.loop(() => this.readOutdoorSensor(), 30_000);
        // First fit soon after start, so shadow doesn't wait an hour for a model.
        this.loop(async () => {
            await this.save();
            this.logStatus();
            await this.fitModel();
            await this.saveShadow();
            return HOUR;
        }, 2 * 60 * 1000);
    }

    /** The latest poll's settings. A setting this poll didn't read keeps its last value. */
    setControls(controls: Controls) {
        const keep = <T>(next: T | undefined, last: T | undefined) => next ?? last;
        const t = controls.thresholds, last = this.controls.thresholds;
        this.controls = {comfort: keep(controls.comfort, this.controls.comfort), mode: keep(controls.mode, this.controls.mode),
            thresholds: {stopHeating: keep(t.stopHeating, last.stopHeating), stopAddHeat: keep(t.stopAddHeat, last.stopAddHeat),
                startCooling: keep(t.startCooling, last.startCooling)}};
    }

    /** One completed poll of the pump. */
    sample(pollSeconds: number, sample: Sample) {
        if (!this.stopped) this.aggregator.sample(Date.now(), pollSeconds, sample);
    }

    markReconnect() {
        this.aggregator.markReconnect();
    }

    async stop(pollSeconds: number) {
        this.stopped = true;
        this.timers.forEach((timer) => this.homey.clearTimeout(timer));
        this.timers = [];
        this.aggregator.flush(pollSeconds);
        await this.save();
    }

    async remove() {
        this.stopped = true;
        this.timers.forEach((timer) => this.homey.clearTimeout(timer));
        await deleteHistory(this.fileName);
    }

    snapshot(): History {
        return this.history;
    }

    private context(slot: number): SlotContext {
        const context: SlotContext = {};
        const price = this.prices.get(slot);
        if (price) context.price = {price: price.price, spot: price.spot, costsApplied: this.costsApplied};
        const weather = Date.now() - this.weatherAt < WEATHER_STALE_MS ? this.weather.get(slot) : undefined;
        if (weather) context.weather = {gtiS: weather.gtiS, gtiE: weather.gtiE, gtiW: weather.gtiW, ghi: weather.ghi, wind: weather.wind,
            rh: weather.rh, cloud: weather.cloud};
        const sensor = this.sensorSums.get(slot);
        if (sensor && sensor.n >= SENSOR_MIN_READINGS) context.sensor = sensor.sum / sensor.n;
        for (const s of [...this.sensorSums.keys()]) if (s <= slot) this.sensorSums.delete(s);
        if (weather && Number.isFinite(weather.te))
            context.outdoor = weather.te + forecastCorrection(this.forecastBias, this.localHour(slot));
        return context;
    }

    /** Runs `job` after `firstMs`, then again after the delay it returns; a failure retries in 15 min. */
    private loop(job: () => Promise<number>, firstMs: number) {
        const run = async () => {
            if (this.stopped) return;
            let next = 15 * 60 * 1000;
            try { next = await job(); } catch (error: any) { this.log('Smart history:', error?.message ?? error); }
            if (!this.stopped) this.timers.push(this.homey.setTimeout(run, next));
        };
        this.timers.push(this.homey.setTimeout(run, firstMs));
    }

    /** One minute's reading of the owner's outdoor sensor, if one is picked. Logged only when
     *  its state changes, never once a minute. */
    private async readOutdoorSensor(): Promise<number> {
        const ref = this.homey.settings.get(OUTDOOR_SENSOR_SETTING) as SensorRef | null;
        let state: string;
        if (!ref?.deviceId || !ref.capabilityId) state = 'none';
        else {
            const reading = (await selectedReadings(this.homey, [ref]))[0];
            const value = usableSensor(reading, Date.now());
            if (value !== undefined) {
                const slot = slotOf(Date.now());
                const sum = this.sensorSums.get(slot) ?? {sum: 0, n: 0};
                this.sensorSums.set(slot, {sum: sum.sum + value, n: sum.n + 1});
                state = `using ${reading.name} (${reading.capabilityId})`;
            } else state = `${reading?.name ?? ref.deviceId} not usable (missing, unavailable, stale or out of range)`;
        }
        if (state !== this.sensorState) {
            this.log(`Smart history: outdoor sensor ${state === 'none' ? 'not picked; the pump and the forecast stand in' : state}.`);
            this.sensorState = state;
        }
        return 60 * 1000;
    }

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
        const keepFrom = slotOf(now - 2 * 24 * HOUR);
        for (const slot of [...this.prices.keys()]) if (slot < keepFrom) this.prices.delete(slot);
        for (const day of days) {
            for (const slot of day.slots) this.prices.set(slot.slot, slot);
            if (day.slots.length) this.costsApplied = day.costsApplied;
        }
        this.pricesAt = now;
        const haveTomorrow = (days[1]?.slots.length ?? 0) > 0;
        return nextPriceFetchMs(now, timeZone, haveTomorrow);
    }

    private async fetchWeather(): Promise<number> {
        const jitter = (Math.random() - 0.5) * 10 * 60 * 1000;
        const homeyLocation: any = await withApi(this.homey, (api) => api.geolocation.getOptionLocation())
            .catch(() => undefined);
        const chosen = this.homey.settings.get(LOCATION_SETTING) as Place | null;
        const location = weatherLocation(homeyLocation?.value, chosen);
        const state = location?.source === 'chosen' ? `the chosen place ${chosen!.name}` : location ? 'the Homey\'s location' : 'none';
        if (state !== this.locationState) {
            this.log(`Smart history: weather for ${location ? state
                : 'nowhere: the Homey has no location and no place is chosen (Setup will ask)'}.`);
            this.locationState = state;
        }
        if (!location) return HOUR;
        const slots = weatherSlots(await getJson(openMeteoUrl(location.latitude, location.longitude)));
        if (slots.length) {
            this.weather = new Map(slots.map((s) => [s.slot, s]));
            this.weatherAt = Date.now();
        }
        return HOUR + jitter;
    }

    /** Refit the house model over the whole history and keep the result beside it. Reads only:
     *  nothing here reaches the pump or the owner yet. */
    private async fitModel() {
        const started = Date.now();
        const fit = fitHistory(this.history, this.answers);
        this.fit = fit;
        const day = Math.floor(started / (24 * HOUR));
        this.dailyFits = recordDailyFit(this.dailyFits, day, fit);
        const ready = readiness(fit, this.dailyFits);
        const insights = houseInsights(fit);
        const drift = drifting(this.dailyFits);
        this.log(`${insightsLine(fit, insights, ready)}${drift ? '; DRIFT' : ''} (${Date.now() - started} ms)`);
        await saveJson(modelFileName(this.fileName), {
            at: new Date(started).toISOString(), answers: this.answers, fit, ready, insights, drift,
            dailyFits: this.dailyFits,
        });
    }

    private async save() {
        await saveHistory(this.fileName, this.history);
    }

    private localHour(slot: number): number {
        const parts = new Intl.DateTimeFormat('en-GB', {timeZone: this.homey.clock.getTimezone(), hour: 'numeric', hourCycle: 'h23'})
            .formatToParts(new Date(slot * SLOT_MS));
        return Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    }

    /** A slot closed: learn the forecast's outdoor error from it, then plan the next slot in
     *  shadow (§7.5). The app feeds nothing, and a slot BT1 was fed from elsewhere already carries
     *  the forecast's outdoor temperature (history.ts FLAG.fedOutdoor). */
    private shadow(slot: number, values: Record<Field, number>) {
        if (this.stopped) return;
        const forecastTe = this.weather.get(slot)?.te;
        // Learn from a real reading (the sensor, or an unfed input 1), never from the forecast itself.
        if (Number.isFinite(values.te) && forecastTe !== undefined && !(values.flags & FLAG.forecastOutdoor))
            this.forecastBias = learnForecastBias(this.forecastBias, this.localHour(slot), values.te, forecastTe);
        const skip = (why: string) => this.shadowSkipped.set(why, (this.shadowSkipped.get(why) ?? 0) + 1);
        const fit = this.fit;
        const c = this.controls;
        if (!fit?.params || !fit.state) return skip('no model');
        if (!Number.isFinite(values.ti) || !Number.isFinite(values.te)) return skip('no reading');
        if (c.comfort === undefined || c.mode === undefined) return skip('no settings');
        if (c.mode === 2) return skip('immersion only');
        const next = slot + 1;
        const fresh = Date.now() - this.weatherAt < WEATHER_STALE_MS ? this.weather : new Map<number, WeatherSlot>();
        const forecast = shadowForecast(next, fresh, this.prices,
            (s) => forecastCorrection(this.forecastBias, this.localHour(s)));
        if (forecast.length < 8) return skip('no forecast');
        const started = Date.now();
        const out = shadowStep({
            house: fit.params, pump: fit.pump, ti: values.ti,
            // The mass moves slowly: the hourly fit's is close enough, the air is the reading.
            tm: fit.state.tm, comfort: c.comfort, real: values.te, auto: c.mode === 0, thresholds: c.thresholds,
            forecast, memory: this.shadowMemory,
            slots: this.shadowSlot !== undefined && slot > this.shadowSlot ? Math.min(4, slot - this.shadowSlot) : 1,
        });
        this.shadowMemory = out.memory;
        this.shadowSlot = slot;
        this.lastShadow = {slot: next, at: new Date(next * SLOT_MS).toISOString(), ti: values.ti, te: values.te,
            comfort: c.comfort, mode: c.mode, horizon: forecast.length, ms: Date.now() - started,
            fitSlot: fit.state.slot, baseline: out.baseline, presets: out.presets};
        appendLine(shadowLogName(this.fileName), this.lastShadow)
            .then(() => { this.shadowLines++; })
            .catch((error) => this.log('Smart shadow: log write failed:', error?.message ?? error));
    }

    private async saveShadow() {
        await saveJson(shadowStateName(this.fileName), {memory: this.shadowMemory, outdoorBias: this.forecastBias,
            slot: this.shadowSlot});
        if (this.shadowLines > SHADOW_KEEP + 2 * 96)
            this.shadowLines = await trimLines(shadowLogName(this.fileName), SHADOW_KEEP);
        const last = this.lastShadow;
        const skipped = [...this.shadowSkipped].map(([why, n]) => `${n} ${why}`).join(', ');
        this.shadowSkipped.clear();
        if (!last) {
            this.log(`Smart shadow: nothing planned yet${skipped ? ` (${skipped})` : ''}.`);
            return;
        }
        const presets = SHADOW_PRESETS.map((id) => {
            const p = last.presets[id];
            return p ? `${id} ${p.bias > 0 ? '+' : ''}${p.bias} K → ${p.fed} °C (${(p.saving * 100).toFixed(1)} %)` : `${id} -`;
        }).join(', ');
        this.log(`Smart shadow: ${presets}; doing nothing ${last.baseline.join('/')} °C in 1/6 h; `
            + `${last.horizon} slots ahead, ${last.ms} ms${skipped ? `; skipped ${skipped}` : ''}.`);
    }

    private logStatus() {
        const since = slotOf(Date.now() - 24 * HOUR);
        const day = this.history.range().filter((s) => s >= since).map((s) => this.history.get(s)!);
        const partial = day.filter((v) => v.flags & FLAG.partial).length;
        const fed = day.filter((v) => v.flags & FLAG.fedOutdoor).length;
        const sensed = day.filter((v) => v.flags & FLAG.sensorOutdoor).length;
        const priced = day.filter((v) => Number.isFinite(v.price)).length;
        const weathered = day.filter((v) => Number.isFinite(v.gtiS)).length;
        const age = (at: number) => at ? `${Math.round((Date.now() - at) / 60000)} min` : 'never';
        this.log(`Smart history: last 24 h ${day.length}/96 slots, ${partial} partial, ${priced} priced, `
            + `${fed ? `${fed} with BT1 fed from elsewhere, ` : ''}${sensed ? `${sensed} outdoor from the sensor, ` : ''}`
            + `${weathered} with weather; prices ${age(this.pricesAt)} old (owner costs ${this.costsApplied ? 'on' : 'off'}), `
            + `weather ${age(this.weatherAt)} old; ${this.history.range().length} slots on file.`);
    }
}

