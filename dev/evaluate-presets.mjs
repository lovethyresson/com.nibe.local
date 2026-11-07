// What each Autopilot preset would have saved, at equal comfort, on real price days.
// Offline: no pump, no Homey writes. Closed loop: replan every hour over 24 h (the next day's
// prices as look-ahead), apply the first hour through the actuator, step the house, repeat.
//
// Saving is "fair": the plan's electricity plus any warmth it leaves owing (lower mean indoor,
// less stored heat at the end) bought back at the day's mean price, against doing nothing
// (lib/autopilot/planner.ts `fairCost`). A cooler house saves nothing here. Steadiness is reported
// beside it: the RMS distance from comfort, with and without the planner.
//
//   for d in $(seq 1 30); do D=$(date -v-${d}d +%F)
//     homey api energy fetch-dynamic-electricity-prices --date $D --json > prices/$D.json; done
//   node --import tsx dev/evaluate-presets.mjs prices/ [--model <url or file of autopilot-….model.json>]
//       [--formula "(p+0.609)*1.25"] [--outdoor 2] [--lever 0.45] [--mode auto|manual] [--stop 17]
//       [--comfort 21] [--max-bias 20] [--weather actual.json [--forecast day-ahead.json]]
//
// Without --model it runs the simulated houses from test/autopilot-house-sim.ts. Weather is a fixed
// day shape around --outdoor, or with --weather the Open-Meteo history the house really saw:
//   https://historical-forecast-api.open-meteo.com/v1/forecast?…&start_date=…&end_date=…
//   (the hourly variables of lib/autopilot/weather.ts `openMeteoUrl`)
// --forecast plans on what was forecast a day ahead instead, from the previous-runs API with
// each variable suffixed `_previous_day1`; the house still runs on --weather. Forecast sun is
// discounted by the preset's forecast trust, as the controller does.
// --lever is the heat a K of bias moves, as a share of the house's heat loss: 1 for a curve
// tuned to the house; the S1155 measured ~0.45 (planner.ts).
import fs from 'node:fs';
import {COP, planShift, simulate, steadyState} from '../lib/autopilot/planner.ts';
import {PRESETS, limitsFor} from '../lib/autopilot/presets.ts';
import {fedValue} from '../lib/autopilot/actuator.ts';
import {comfortBias} from '../lib/autopilot/trim.ts';
import {weatherSlots} from '../lib/autopilot/weather.ts';
import {RADIATOR_HOUSE, SLAB_HOUSE, WEST_HOUSE} from '../test/autopilot-house-sim.ts';

const option = (name, fallback) => {
    const at = process.argv.indexOf(`--${name}`);
    return at > 0 ? process.argv[at + 1] : fallback;
};
const dir = process.argv[2];
if (!dir) {
    console.error('usage: node --import tsx dev/evaluate-presets.mjs <prices dir> [--model …] [--formula …] [--outdoor n]');
    process.exit(1);
}
const formula = option('formula', '(p+0.609)*1.25');
const allIn = new Function('p', `return ${formula};`);
const outdoor = Number(option('outdoor', 2));
const leverShare = Number(option('lever', 1));
// Operating mode (237) and auto-stop heating (184): the clamps act in Auto only (actuator.ts).
const auto = option('mode', 'auto') === 'auto';
const thresholds = {stopHeating: Number(option('stop', 17)), startCooling: 25};
const comfort = Number(option('comfort', 21));
const maxBias = option('max-bias');
const days = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const intervals = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')).pricesPerInterval ?? [];
    return {date: f.slice(0, 10), prices: intervals.map((x) => allIn(x.value)),
        slot: intervals.length ? Date.parse(intervals[0].periodStart) / 900_000 : NaN};
}).filter((d) => d.prices.length >= 92);

const loadWeather = (file, suffix = '') => {
    if (!file) return undefined;
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hourly = Object.fromEntries(Object.entries(json.hourly).map(([k, v]) => [k.replace(suffix, ''), v]));
    // The previous-runs API has no wind, humidity or cloud; the model doesn't read them.
    for (const k of ['wind_speed_10m', 'relative_humidity_2m', 'cloud_cover']) hourly[k] ??= hourly.time.map(() => 0);
    return new Map(weatherSlots({...json, hourly}).map((w) => [w.slot, {te: w.te, sun: w.gtiS, sunE: w.gtiE, sunW: w.gtiW}]));
};
const actual = loadWeather(option('weather'));
const forecasted = loadWeather(option('forecast'), '_previous_day1') ?? actual;

const houses = {};
const learned = {};
const model = option('model');
if (model) {
    const text = /^https?:/.test(model) ? await (await fetch(model)).text() : fs.readFileSync(model, 'utf8');
    const fit = JSON.parse(text).fit;
    if (!fit?.params) {
        console.error('That model file has no fitted parameters yet.');
        process.exit(1);
    }
    houses.yours = fit.params;
    // The learned curve and emission make the pump honest: doing nothing drifts with the weather
    // and the comfort bias (trim.ts) is what holds comfort. --lever falls back to the old
    // assumption that the curve holds comfort by itself.
    if (fit.pump?.supply && fit.pump.heatPerSupplyK !== undefined && option('lever') === undefined) learned.yours = fit.pump;
} else {
    houses.radiator = RADIATOR_HOUSE;
    houses.slab = SLAB_HOUSE;
    houses.west = WEST_HOUSE;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const shape = (k) => {
    const h = (k / 4) % 24;
    return {te: outdoor + 3 * Math.sin(2 * Math.PI * (h - 9) / 24),
        sun: h > 8 && h < 16 ? 250 * Math.sin(Math.PI * (h - 8) / 8) : 0};
};
const weatherAt = (source, slot, k) => source?.get(slot + k) ?? shape(k);

/** One day closed loop. `limits` undefined runs doing nothing (the bare curve) or, with `trim`,
 *  the comfort bias alone; otherwise the planner at those limits. */
function runDay(house, pump, day, ahead, limits, trim) {
    const prices = day.prices;
    const n = prices.length;
    const all = [...prices, ...ahead.prices];
    const truth = all.map((price, k) => ({price, ...weatherAt(actual, day.slot, k)}));
    const trustOf = limits?.forecastTrust ?? 1;
    const trust = (w) => ({...w, sun: w.sun * trustOf, sunE: (w.sunE ?? 0) * trustOf, sunW: (w.sunW ?? 0) * trustOf});
    const forecast = all.map((price, k) => ({price, ...trust(weatherAt(forecasted, day.slot, k))}));
    const start = steadyState(house, comfort, truth[0].te, pump);
    let state = {...start};
    let lastPlan;
    const ti = [];
    let cost = 0;
    for (let k = 0; k < n; k += 4) {
        const m = Math.min(4, n - k);
        const held = forecast.slice(k, k + m).map((s) => comfortBias(house, pump, comfort, s.te));
        let want;
        if (limits) {
            const plan = planShift(house, comfort, state, forecast.slice(k, k + 96), limits, pump, lastPlan);
            lastPlan = plan.biases.slice(4);
            want = plan.biases;
        } else want = trim ? held : held.map(() => 0);
        const applied = [];
        let previous = state.bias;
        for (let j = 0; j < m; j++) {
            const out = limits || trim
                ? fedValue({real: truth[k + j].te, bias: want[j], previousBias: previous, comfortBias: held[j],
                    maxBias: limits?.maxBias ?? 0, maxCoastBias: limits?.maxCoastBias ?? 0, auto, thresholds})
                : {bias: 0};
            applied.push(out.bias);
            previous = out.bias;
        }
        const sim = simulate(house, comfort, state, truth.slice(k, k + m), applied, pump);
        ti.push(...sim.ti);
        cost += sim.cost;
        state = {ti: sim.ti[m - 1], tm: sim.tm[m - 1], curve: sim.curveEnd, bias: applied[m - 1]};
    }
    const rms = (xs) => Math.sqrt(mean(xs.map((t) => (t - comfort) ** 2)));
    return {ti, tmEnd: state.tm, tiEnd: state.ti, cost, min: Math.min(...ti), max: Math.max(...ti), rms: rms(ti),
        mean: mean(ti), prices, n};
}

/** A run scored against a reference run of the same day: electricity saved, and saved once the
 *  heat it owes the reference is bought back (planner.ts `owedHeat`: degree-hours colder, stored
 *  heat short at the end, warmth above earning nothing), also against the reference capped at
 *  comfort. */
function score(house, run, ref) {
    const {n} = run;
    const owedAgainst = (refTi, refTiEnd, refTmEnd) => Math.max(0, house.ci * (refTiEnd - run.tiEnd) + house.cm * (refTmEnd - run.tmEnd))
        + run.ti.reduce((a, t, k) => a + house.heatLoss * 0.25 * Math.max(0, refTi[k] - t), 0);
    const owed = owedAgainst(ref.ti, ref.tiEnd, ref.tmEnd);
    const capped = owedAgainst(ref.ti.map((t) => Math.min(t, comfort)), Math.min(ref.tiEnd, comfort), ref.tmEnd);
    return {fair: 1 - (run.cost + owed / COP * mean(run.prices)) / ref.cost, gross: 1 - run.cost / ref.cost,
        atComfort: 1 - (run.cost + capped / COP * mean(run.prices)) / ref.cost};
}

console.log(`${days.length - 1} days with look-ahead, ${days[0]?.date} → ${days.at(-2)?.date}, price = ${formula}, lever ${leverShare}·H, ${auto ? `Auto, stop ${thresholds.stopHeating} °C` : 'Manual'}, comfort ${comfort} °C, `
    + (actual ? `real weather${option('forecast') ? ', planned on the day-ahead forecast' : ', perfect forecast'}` : `weather shape around ${outdoor} °C`));
const pct = (v) => `${(v * 100).toFixed(1)} %`;
const indoor = (runs) => `indoor ${Math.min(...runs.map((r) => r.min)).toFixed(1)}–${Math.max(...runs.map((r) => r.max)).toFixed(1)} °C`
    + ` (mean ${mean(runs.map((r) => r.mean)).toFixed(2)}), off comfort ${mean(runs.map((r) => r.rms)).toFixed(2)} K RMS`;
for (const [name, house] of Object.entries(houses)) {
    const pump = learned[name] ?? {lever: leverShare * house.heatLoss};
    const each = (f) => days.slice(0, -1).map((d, i) => f(d, days[i + 1]));
    const nothing = each((d, a) => runDay(house, pump, d, a));
    const held = each((d, a) => runDay(house, pump, d, a, undefined, true));
    if (learned[name]) {
        console.log(`${name.padEnd(9)} pump: learned curve, ${(pump.heatPerSupplyK * 1000).toFixed(0)} W per K of supply`);
        console.log(`${name.padEnd(9)} ${'nothing'.padEnd(12)} electricity ${mean(nothing.map((r) => r.cost)).toFixed(2)}/day, ${indoor(nothing)}`);
        const vs = held.map((r, i) => score(house, r, nothing[i]));
        console.log(`${name.padEnd(9)} ${'trim only'.padEnd(12)} electricity ${mean(held.map((r) => r.cost)).toFixed(2)}/day`
            + ` (${pct(-mean(vs.map((v) => v.gross)))} vs nothing), ${indoor(held)}`);
    }
    for (const id of ['comfortable', 'save_some', 'save_most']) {
        const limits = limitsFor(PRESETS[id]);
        // Explore beyond the presets' +20/−15 K: scales both sides' limit by the preset's share.
        if (maxBias) limits.maxBias = limits.maxCoastBias = Number(maxBias) * PRESETS[id].stored;
        const runs = each((d, a) => runDay(house, pump, d, a, limits));
        // Price shifting is judged against holding comfort: trim only (= doing nothing when the
        // curve is assumed to hold comfort).
        const s = runs.map((r, i) => score(house, r, held[i]));
        console.log(`${name.padEnd(9)} ${id.padEnd(12)} fair ${pct(mean(s.map((r) => r.fair))).padStart(6)}`
            + ` (best day ${pct(Math.max(...s.map((r) => r.fair)))}), at comfort ${pct(mean(s.map((r) => r.atComfort)))},`
            + ` gross ${pct(mean(s.map((r) => r.gross)))}, ${indoor(runs)}`);
    }
}
