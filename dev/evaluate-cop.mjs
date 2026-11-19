// What the learned COP (M5 stage 1) and the DP optimiser (stage 2) change in the outcome, on real
// price days. Offline: no pump, no Homey. Design: docs/autopilot-plan.md §13.
//
// The simulated pump is honest about COP: its electricity is heat / (η × Carnot) at the supply its
// curve runs (lib/autopilot/cop.ts), whatever the planner believes. Every arm is run closed loop on
// that pump (replan every hour, feed the first hour through the actuator, step the house) and
// scored at equal comfort against doing nothing on the same pump, as dev/evaluate-presets.mjs does:
// electricity plus the heat a run owes doing nothing (degree-hours colder, stored heat short at the
// end) bought back at the day's mean price and doing nothing's marginal COP.
//
// Arms, all the live build (shift-only, live profiles, the S1155's learned curve):
//   constant   the planner as it shipped: heat priced at COP 3
//   learned    the planner pricing heat at the learned COP (η × --eta-error)
//   dp         the DP optimiser on the learned COP (slow: --no-dp skips it)
// plus `old view`: the constant arm scored on a constant-COP pump, the yardstick §7.3's numbers used.
//
//   node --import tsx dev/evaluate-cop.mjs <prices dir> [--weather open-meteo.json | --outdoor 2]
//       [--formula "(p+0.609)*1.25"] [--eta 0.5] [--source ground|air] [--brine 1] [--eta-error 1]
//       [--wrong-house] [--houses radiator,slab] [--profiles save_some] [--no-dp] [--days 30]
//
// Prices: Homey's `homey api energy fetch-dynamic-electricity-prices --json` per day, or any file
// with `pricesPerInterval: [{periodStart, value}]` (spot per kWh). Weather: Open-Meteo's historical
// forecast API with the hourly variables of lib/autopilot/weather.ts `openMeteoUrl`, else a day
// shape around --outdoor. --wrong-house plans with a house 30 % off on heat loss and mass while the
// true house runs.
import fs from 'node:fs';
import {COP, buyBackCop, marginals, planShift, simulate, steadyState} from '../lib/autopilot/planner.ts';
import {optimise} from '../lib/autopilot/optimiser.ts';
import {PROFILE_LIMITS} from '../lib/autopilot/live.ts';
import {fedValue} from '../lib/autopilot/actuator.ts';
import {weatherSlots} from '../lib/autopilot/weather.ts';
import {RADIATOR_HOUSE, SLAB_HOUSE, WEST_HOUSE} from '../test/autopilot-house-sim.ts';

const option = (name, fallback) => {
    const at = process.argv.indexOf(`--${name}`);
    return at > 0 ? process.argv[at + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const dir = process.argv[2];
if (!dir) {
    console.error('usage: node --import tsx dev/evaluate-cop.mjs <prices dir> [--weather file] [--eta 0.5] …');
    process.exit(1);
}
const formula = option('formula', '(p+0.609)*1.25');
const allIn = new Function('p', `return ${formula};`);
const outdoor = Number(option('outdoor', 2));
const comfort = Number(option('comfort', 21));
const eta = Number(option('eta', 0.5));
const source = option('source', 'ground');
const brine = Number(option('brine', 1));
const etaError = Number(option('eta-error', 1));
const auto = option('mode', 'auto') === 'auto';
const thresholds = {stopHeating: Number(option('stop', 17)), startCooling: 25};
const runDp = !flag('no-dp');
const maxDays = Number(option('days', 1000));

let days = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const intervals = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')).pricesPerInterval ?? [];
    return {date: f.slice(0, 10), prices: intervals.map((x) => allIn(x.value)),
        slot: intervals.length ? Date.parse(intervals[0].periodStart) / 900_000 : NaN};
}).filter((d) => d.prices.length >= 92);
days = days.slice(-(maxDays + 1));

const weatherFile = option('weather');
const weather = weatherFile
    ? new Map(weatherSlots(JSON.parse(fs.readFileSync(weatherFile, 'utf8'))).map((w) => [w.slot, {te: w.te, sun: w.gtiS, sunE: w.gtiE, sunW: w.gtiW}]))
    : undefined;
const shape = (k) => {
    const h = (k / 4) % 24;
    return {te: outdoor + 3 * Math.sin(2 * Math.PI * (h - 9) / 24), sun: h > 8 && h < 16 ? 250 * Math.sin(Math.PI * (h - 8) / 8) : 0,
        sunE: 0, sunW: 0};
};
const weatherAt = (slot, k) => weather?.get(slot + k) ?? shape(k);

// The S1155's learned curve at curve 5, offset +6 (2026-11-14), and its emission.
const CURVE = {knots: Array.from({length: 29}, (_, i) => -8 + 2 * i), points: 859,
    supply: [44.1, 43.3, 42.6, 41.8, 41, 40.2, 39.3, 38.4, 37.5, 36.6, 35.6, 34.6, 33.4, 31.9, 30.2, 28.3, 26.3, 24.4,
        22.9, 21.8, 21, 20.4, 20.1, 19.8, 19.7, 19.7, 19.7, 19.7, 19.7]};
const HEAT_PER_SUPPLY_K = 0.255;
const copModel = (e) => ({eta: e, source, ...(source === 'ground' ? {brine} : {}), windows: 99, days: 9, spread: 0.05, trusted: true, missing: []});
const base = {supply: CURVE, heatPerSupplyK: HEAT_PER_SUPPLY_K, shiftOnly: true};
const truthPump = {...base, cop: copModel(eta)};
const constantTruth = base;
const plans = {
    constant: base,
    learned: {...base, cop: copModel(eta * etaError)},
};

const houses = Object.fromEntries(Object.entries({radiator: RADIATOR_HOUSE, slab: SLAB_HOUSE, west: WEST_HOUSE})
    .filter(([name]) => (option('houses') ?? 'radiator,slab,west').split(',').includes(name)));
const profiles = (option('profiles') ?? 'comfortable,save_some,save_most').split(',');
const wrong = (h) => ({...h, heatLoss: h.heatLoss * 1.3, cm: h.cm * 0.7});
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** One day closed loop on `truth`. `arm` undefined is doing nothing. */
async function runDay(house, truth, day, ahead, limits, arm) {
    const n = day.prices.length;
    const all = [...day.prices, ...ahead.prices];
    const truthSlots = all.map((price, k) => ({price, ...weatherAt(day.slot, k)}));
    const trust = limits?.forecastTrust ?? 1;
    const forecast = truthSlots.map((s) => ({...s, sun: s.sun * trust, sunE: s.sunE * trust, sunW: s.sunW * trust}));
    const planHouse = flag('wrong-house') ? wrong(house) : house;
    let state = {...steadyState(house, comfort, truthSlots[0].te, truth)};
    let lastPlan;
    const out = {ti: [], heat: [], cop: [], supply: [], te: [], cost: 0, biases: [], prices: day.prices, n};
    for (let k = 0; k < n; k += 4) {
        const m = Math.min(4, n - k);
        let want = new Array(m).fill(0);
        if (arm) {
            const horizon = forecast.slice(k, k + 96);
            if (arm === 'dp') {
                const r = await optimise({house: planHouse, comfort, state, forecast: horizon, limits, pump: plans.learned, previous: lastPlan},
                    {defer: async () => {}, budgetMs: Infinity, perSide: Number(option('dp-levels', 3))});
                if (r.fallback) fallbacks++;
                dpMs.push(r.ms);
                want = r.biases;
                lastPlan = r.biases.slice(4);
            } else {
                const plan = planShift(planHouse, comfort, state, horizon, limits, plans[arm], lastPlan);
                want = plan.biases;
                lastPlan = plan.biases.slice(4);
            }
        }
        const applied = [];
        let previous = state.bias;
        for (let j = 0; j < m; j++) {
            const fed = arm ? fedValue({real: truthSlots[k + j].te, bias: want[j], previousBias: previous, comfortBias: 0,
                maxBias: limits.maxBias, maxCoastBias: limits.maxCoastBias, auto, thresholds,
                // --no-ramp: an experiment, how much the actuator's 2 K a slot costs a plan that ignores it.
                ...(flag('no-ramp') ? {slots: 100} : {})}) : {bias: 0};
            applied.push(fed.bias);
            previous = fed.bias;
        }
        const sim = simulate(house, comfort, state, truthSlots.slice(k, k + m), applied, truth);
        out.ti.push(...sim.ti); out.heat.push(...sim.heat); out.cop.push(...sim.cop); out.supply.push(...sim.supply);
        out.te.push(...truthSlots.slice(k, k + m).map((s) => s.te));
        out.biases.push(...applied);
        out.cost += sim.cost;
        state = {ti: sim.ti[m - 1], tm: sim.tm[m - 1], curve: sim.curveEnd, bias: applied[m - 1]};
    }
    out.tiEnd = state.ti; out.tmEnd = state.tm;
    return out;
}

/** Saving at equal comfort against doing nothing, owed heat bought back at doing nothing's marginal COP. */
function score(house, truth, run, ref) {
    const owedAgainst = (refTi, refTiEnd) => Math.max(0, house.ci * (refTiEnd - run.tiEnd) + house.cm * (ref.tmEnd - run.tmEnd))
        + run.ti.reduce((a, t, k) => a + house.heatLoss * 0.25 * Math.max(0, refTi[k] - t), 0);
    const cop = buyBackCop(ref, marginals(truth, ref, ref.te.map((te) => ({te}))));
    const price = mean(run.prices) / cop;
    // At comfort: doing nothing's warmth above the setpoint (sun, a mild day the curve overshoots)
    // counts for nothing, which is what the planners themselves optimise (planner.ts `comfortReference`).
    const capped = owedAgainst(ref.ti.map((t) => Math.min(t, comfort)), Math.min(ref.tiEnd, comfort));
    return {paid: run.cost + owedAgainst(ref.ti, ref.tiEnd) * price, paidAtComfort: run.cost + capped * price, ref: ref.cost};
}
/** Over the whole period: what all days cost at equal comfort against what doing nothing cost.
 *  A mean of daily percentages lets a mild day, where doing nothing costs next to nothing, swing it. */
const total = (s, key = 'paid') => 1 - s.reduce((a, v) => a + v[key], 0) / s.reduce((a, v) => a + v.ref, 0);
const daily = (v) => 1 - v.paid / v.ref;

const pct = (v) => `${(v * 100).toFixed(2)} %`;
console.log(`${days.length - 1} days, ${days[0]?.date} → ${days.at(-2)?.date}, price = ${formula}, `
    + `${weather ? 'real weather' : `weather shape around ${outdoor} °C`}, pump η ${eta} ${source}${source === 'ground' ? ` (brine ${brine} °C)` : ''}, `
    + `planner's η ×${etaError}${flag('wrong-house') ? ', planned on a house 30 % off' : ''}, ${auto ? `Auto, stop ${thresholds.stopHeating} °C` : 'Manual'}`);
// One day at a time: run together, the DP's solves would share the clock.
const each = async (f) => {
    const out = [];
    for (let i = 0; i + 1 < days.length; i++) out.push(await f(days[i], days[i + 1]));
    return out;
};
let fallbacks = 0;
const dpMs = [];
const summary = [];
for (const [name, house] of Object.entries(houses)) {
    const nothing = await each((d, a) => runDay(house, truthPump, d, a));
    const nothingOld = await each((d, a) => runDay(house, constantTruth, d, a));
    const meanCop = mean(nothing.map((r) => r.heat.reduce((a, b) => a + b, 0) / r.heat.reduce((a, q, k) => a + q / r.cop[k], 0)));
    console.log(`${name}: doing nothing ${mean(nothing.map((r) => r.cost)).toFixed(2)}/day at COP ${meanCop.toFixed(2)}`);
    for (const id of profiles) {
        const limits = PROFILE_LIMITS[id];
        const row = {house: name, profile: id};
        const old = await each((d, a) => runDay(house, constantTruth, d, a, limits, 'constant'));
        row.old = total(old.map((r, i) => score(house, constantTruth, r, nothingOld[i])));
        for (const arm of ['constant', 'learned', ...(runDp ? ['dp'] : [])]) {
            const runs = await each((d, a) => runDay(house, truthPump, d, a, limits, arm));
            const s = runs.map((r, i) => score(house, truthPump, r, nothing[i]));
            const all = runs.flatMap((r) => r.biases);
            row[arm] = total(s);
            row[`${arm}AtComfort`] = total(s, 'paidAtComfort');
            row[`${arm}Worst`] = Math.min(...s.map(daily));
            row[`${arm}Pre`] = all.filter((b) => b > 0).length / all.length;
            row[`${arm}Rms`] = mean(runs.map((r) => Math.sqrt(mean(r.ti.map((t) => (t - comfort) ** 2)))));
        }
        summary.push(row);
        const cell = (arm) => (row[arm] === undefined ? '' : `${arm} ${pct(row[arm])} [at comfort ${pct(row[`${arm}AtComfort`])}] (worst day ${pct(row[`${arm}Worst`])}, pre-heating ${pct(row[`${arm}Pre`])} of slots, off comfort ${row[`${arm}Rms`].toFixed(2)} K)`);
        console.log(`  ${id.padEnd(12)} old view ${pct(row.old)}; ${['constant', 'learned', 'dp'].map(cell).filter(Boolean).join('; ')}`);
    }
}
const avg = (key) => mean(summary.map((r) => r[key]));
console.log(`mean over houses and profiles: old view ${pct(avg('old'))}, constant ${pct(avg('constant'))}, learned ${pct(avg('learned'))}`
    + (runDp ? `, dp ${pct(avg('dp'))}` : '')
    + ` | at comfort: constant ${pct(avg('constantAtComfort'))}, learned ${pct(avg('learnedAtComfort'))}${runDp ? `, dp ${pct(avg('dpAtComfort'))}` : ''}`
    + ` | learned − constant ${((avg('learned') - avg('constant')) * 100).toFixed(2)} points`
    + (runDp ? `, dp − learned ${((avg('dp') - avg('learned')) * 100).toFixed(2)} points; DP ${dpMs.length} solves, `
        + `median ${dpMs.sort((a, b) => a - b)[dpMs.length >> 1]} ms, ${fallbacks} fell back` : ''));
