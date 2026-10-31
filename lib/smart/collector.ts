/** Collects the smart heating history for one pump: poll samples from the Heating device, prices
 *  from Homey Energy and weather from Open-Meteo. Reads only; nothing here writes to the pump.
 *  Design: docs/smart-heating-plan.md §5.2–5.4. */
import https from 'https';
import {withApi} from '../indoor-sensors';
import {Aggregator, FLAG, History, Sample, SlotContext} from './history';
import {DayPrices, PriceSlot, localDate, nextPriceFetchMs, normalisePrices, slotOf} from './prices';
import {WEATHER_STALE_MS, WeatherSlot, openMeteoUrl, weatherSlots} from './weather';
import {deleteHistory, loadHistory, loadJson, modelFileName, saveHistory, saveJson} from './store-file';
import {DailyFit, HouseAnswers, drifting, fitHouse, modelSlotsFromHistory, readiness, recordDailyFit} from './house';
import {houseInsights, insightsLine} from './insights';

const HOUR = 60 * 60 * 1000;

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

    constructor(private readonly homey: any, private readonly fileName: string,
                private readonly log: (...args: any[]) => void,
                private readonly answers: HouseAnswers = {system: 'unknown', era: 'unknown'}) {
        this.aggregator = new Aggregator(this.history, (slot) => this.context(slot));
    }

    async start() {
        const loaded = await loadHistory(this.fileName).catch((error) => {
            this.log('Smart history: could not read the saved file, starting a new one:', error?.message ?? error);
            return undefined;
        });
        if (loaded) {
            this.history = loaded;
            this.aggregator = new Aggregator(this.history, (slot) => this.context(slot));
        }
        const model = await loadJson<{dailyFits?: DailyFit[]}>(modelFileName(this.fileName)).catch(() => undefined);
        this.dailyFits = Array.isArray(model?.dailyFits) ? model!.dailyFits : [];
        this.log(`Smart history: ${this.history.range().length} slots in /userdata/${this.fileName}.`);
        this.loop(() => this.fetchPrices(), 5_000);
        this.loop(() => this.fetchWeather(), 20_000);
        this.loop(async () => {
            await this.save();
            this.logStatus();
            await this.fitModel();
            return HOUR;
        }, HOUR);
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
        if (weather) context.weather = {gtiS: weather.gtiS, ghi: weather.ghi, wind: weather.wind,
            rh: weather.rh, cloud: weather.cloud};
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
        const location: any = await withApi(this.homey, (api) => api.geolocation.getOptionLocation());
        const {latitude, longitude} = location?.value ?? {};
        if (typeof latitude !== 'number' || typeof longitude !== 'number') {
            this.log('Smart history: the Homey has no location, so no weather.');
            return 6 * HOUR;
        }
        const slots = weatherSlots(await getJson(openMeteoUrl(latitude, longitude)));
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
        const fit = fitHouse(modelSlotsFromHistory(this.history), this.answers);
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

    private logStatus() {
        const since = slotOf(Date.now() - 24 * HOUR);
        const day = this.history.range().filter((s) => s >= since).map((s) => this.history.get(s)!);
        const partial = day.filter((v) => v.flags & FLAG.partial).length;
        const priced = day.filter((v) => Number.isFinite(v.price)).length;
        const weathered = day.filter((v) => Number.isFinite(v.gtiS)).length;
        const age = (at: number) => at ? `${Math.round((Date.now() - at) / 60000)} min` : 'never';
        this.log(`Smart history: last 24 h ${day.length}/96 slots, ${partial} partial, ${priced} priced, `
            + `${weathered} with weather; prices ${age(this.pricesAt)} old (owner costs ${this.costsApplied ? 'on' : 'off'}), `
            + `weather ${age(this.weatherAt)} old; ${this.history.range().length} slots on file.`);
    }
}

