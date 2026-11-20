import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Gateway} from '../lib/gateway';
import {LogStore} from '../lib/gateway-insights';
import {PriceBook} from '../lib/gateway-prices';
import {WeatherBook} from '../lib/gateway-weather';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Requests per day each family may make in steady state (docs/external-io.md). Before the
 *  Gateway, prices alone were about 400 a day, Open-Meteo 32 and the location 32. */
const BUDGET: Record<string, number> = {
    'energy.getElectricityPriceType': 30,
    'energy.getDynamicElectricityPriceUserCosts': 30,
    'energy.getCurrency': 30,
    'energy.fetchDynamicElectricityPrices': 60,
    'geolocation.getOptionLocation': 2,
    'web.open-meteo forecast': 26,
    'web.open-meteo irradiance': 2,
    'insights.getLogEntries': 130,
};

/** One day of every consumer's own schedule, against one Gateway and its shared books. */
test('a day of heating, hot water, three savings devices and solar stays within the request budget', async () => {
    let now = Date.parse('2026-11-20T00:00:00Z');
    const counts = new Map<string, number>();
    const count = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
    const hourStart = () => Math.floor(now / HOUR) * HOUR;
    const api = {
        energy: {
            getElectricityPriceType: async () => { count('energy.getElectricityPriceType'); return 'dynamic'; },
            getDynamicElectricityPriceUserCosts: async () => { count('energy.getDynamicElectricityPriceUserCosts'); return {}; },
            getCurrency: async () => { count('energy.getCurrency'); return 'SEK'; },
            fetchDynamicElectricityPrices: async ({date}: any) => {
                count('energy.fetchDynamicElectricityPrices');
                const start = Date.parse(`${date}T00:00:00Z`);
                // Tomorrow's prices exist from 13:00.
                if (start > now && new Date(now).getUTCHours() < 13) return {pricesPerInterval: []};
                return {pricesPerInterval: [{periodStart: new Date(start).toISOString(), periodEnd: new Date(start + DAY).toISOString(), value: 1}]};
            },
        },
        geolocation: {getOptionLocation: async () => { count('geolocation.getOptionLocation'); return {value: {latitude: 59.3, longitude: 18.1}}; }},
        insights: {getLogEntries: async (args: any) => {
            count('insights.getLogEntries');
            const hours = args.resolution === 'last7Days' ? 168 : 336;
            const last = hourStart() - HOUR;
            return {step: HOUR, updatesIn: hourStart() + HOUR + 5 * MIN - now,
                values: Array.from({length: hours}, (_, k) => ({t: new Date(last - (hours - 1 - k) * HOUR).toISOString(), v: k}))};
        }},
    };
    const gateway = new Gateway({createClient: async () => api, now: () => now, sleep: async () => undefined, log: () => undefined});
    const disk = new Map<string, unknown>();
    gateway.logs = new LogStore({now: () => now, load: async (n) => disk.get(n), save: async (n, v) => { disk.set(n, v); },
        remove: async (n) => { disk.delete(n); }, log: () => undefined});
    const prices = new PriceBook({call: (use) => gateway.call(use), now: () => now, today: () => new Date(now).toISOString().slice(0, 10)});
    const weather = new WeatherBook({
        homeyLocation: () => gateway.call((a) => a.geolocation.getOptionLocation()),
        chosenPlace: () => null,
        getJson: (url, name) => gateway.web(name, async () => { count(`web.${name}`); return {hourly: {time: [], shortwave_radiation: []}}; }),
        now: () => now,
    });
    const date = (offset = 0) => new Date(now + offset * DAY).toISOString().slice(0, 10);
    const meter = (device: string, cap: string, resolution = 'last14Days') =>
        gateway.call((a) => a.insights.getLogEntries({uri: `homey:device:${device}`, id: `homey:device:${device}:${cap}`, resolution}));

    for (let minute = 0; minute < 24 * 60; minute += 5) {
        now = Date.parse('2026-11-20T00:00:00Z') + minute * MIN;
        if (minute % 60 === 0) {
            // Heating collector and hot water: prices for today and tomorrow, hourly.
            for (let k = 0; k < 2; k++) if ((await prices.info()).dynamic) await Promise.all([prices.day(date()), prices.day(date(1))]);
            // Heating collector: the forecast.
            await weather.forecast();
            // Savings on Heating, Hot water and Main: price info, today's prices, the meter (and Heating's two more logs).
            for (const device of ['heating', 'hotwater', 'main']) {
                await prices.info();
                await prices.day(date());
                await meter(device, 'meter_power.total');
            }
            await meter('heating', 'autopilot_fed');
            await meter('heating', 'i1_outside');
        }
        // Solar: every 3 hours, the sun.
        if (minute % 180 === 90) await weather.ghi();
        // Hot water learning: every 6 hours, 6 capabilities at three resolutions.
        if (minute % 360 === 60) {
            for (const cap of ['litres', 'produced', 'meter_power.total', 'top', 'aux', 'charge'])
                for (const resolution of ['last14Days', 'last31Days', 'last3Months']) await meter('hotwater', cap, resolution);
        }
    }
    for (const [family, limit] of Object.entries(BUDGET))
        assert.ok((counts.get(family) ?? 0) <= limit, `${family}: ${counts.get(family)} a day, budget ${limit}`);
    assert.ok(counts.get('energy.fetchDynamicElectricityPrices')! >= 24, 'prices are still kept fresh');
});
