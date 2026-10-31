// What each Smart heating preset would have saved, at equal comfort, on real price days.
// Offline: no pump, no Homey writes. Closed loop: replan every hour over 24 h (the next day's
// prices as look-ahead), apply the first hour through the actuator, step the house, repeat.
//
// Saving is "fair": the plan's electricity plus any warmth it leaves owing (lower mean indoor,
// less stored heat at the end) bought back at the day's mean price, against doing nothing
// (lib/smart/planner.ts `fairCost`). A cooler house saves nothing here.
//
//   for d in $(seq 1 30); do D=$(date -v-${d}d +%F)
//     homey api energy fetch-dynamic-electricity-prices --date $D --json > prices/$D.json; done
//   node --import tsx dev/evaluate-presets.mjs prices/ [--model <url or file of smart-….model.json>]
//       [--formula "(p+0.609)*1.25"] [--outdoor 2]
//
// Without --model it runs the two simulated houses from test/smart-house-sim.ts. Weather is a
// fixed day shape around --outdoor; the planner's pump model assumes a tuned curve (planner.ts).
import fs from 'node:fs';
import {COP, planShift, simulate, steadyState} from '../lib/smart/planner.ts';
import {PRESETS, limitsFor} from '../lib/smart/presets.ts';
import {fedValue} from '../lib/smart/actuator.ts';
import {RADIATOR_HOUSE, SLAB_HOUSE} from '../test/smart-house-sim.ts';

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
const days = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => ({
    date: f.slice(0, 10),
    prices: (JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')).pricesPerInterval ?? []).map((x) => allIn(x.value)),
})).filter((d) => d.prices.length >= 92);

const houses = {};
const model = option('model');
if (model) {
    const text = /^https?:/.test(model) ? await (await fetch(model)).text() : fs.readFileSync(model, 'utf8');
    const params = JSON.parse(text).fit?.params;
    if (!params) {
        console.error('That model file has no fitted parameters yet.');
        process.exit(1);
    }
    houses.yours = params;
} else {
    houses.radiator = RADIATOR_HOUSE;
    houses.slab = SLAB_HOUSE;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const weather = (k) => {
    const h = (k / 4) % 24;
    return {te: outdoor + 3 * Math.sin(2 * Math.PI * (h - 9) / 24),
        sun: h > 8 && h < 16 ? 250 * Math.sin(Math.PI * (h - 8) / 8) : 0};
};

function runDay(house, prices, ahead, limits) {
    const n = prices.length;
    const forecast = [...prices, ...ahead].map((price, k) => ({price, ...weather(k)}));
    const start = steadyState(house, 21, forecast[0].te);
    const base = simulate(house, 21, start, forecast.slice(0, n), new Array(n).fill(0));
    let state = {...start};
    const ti = [];
    let cost = 0;
    for (let k = 0; k < n; k += 4) {
        const plan = planShift(house, 21, state, forecast.slice(k, k + 96), limits);
        const applied = [];
        let previous = state.bias;
        const m = Math.min(4, n - k);
        for (let j = 0; j < m; j++) {
            const out = fedValue({real: forecast[k + j].te, bias: plan.biases[j], previousBias: previous,
                maxBias: limits.maxBias, auto: true, thresholds: {stopHeating: 17, startCooling: 25}});
            applied.push(out.bias);
            previous = out.bias;
        }
        const sim = simulate(house, 21, state, forecast.slice(k, k + m), applied);
        ti.push(...sim.ti);
        cost += sim.cost;
        state = {ti: sim.ti[m - 1], tm: sim.tm[m - 1], curve: sim.curveEnd, bias: applied[m - 1]};
    }
    const owed = house.ci * (base.ti[n - 1] - state.ti) + house.cm * (base.tm[n - 1] - state.tm)
        + house.heatLoss * (mean(base.ti) - mean(ti)) * n / 4;
    return {fair: 1 - (cost + owed / COP * mean(prices)) / base.cost, gross: 1 - cost / base.cost,
        min: Math.min(...ti), max: Math.max(...ti)};
}

console.log(`${days.length - 1} days with look-ahead, ${days[0]?.date} → ${days.at(-2)?.date}, price = ${formula}`);
const pct = (v) => `${(v * 100).toFixed(1)} %`;
for (const [name, house] of Object.entries(houses)) {
    for (const id of ['comfortable', 'save_some', 'save_most']) {
        const limits = limitsFor(PRESETS[id]);
        const runs = days.slice(0, -1).map((d, i) => runDay(house, d.prices, days[i + 1].prices, limits));
        console.log(`${name.padEnd(9)} ${id.padEnd(12)} fair ${pct(mean(runs.map((r) => r.fair))).padStart(6)}`
            + ` (best day ${pct(Math.max(...runs.map((r) => r.fair)))}), gross ${pct(mean(runs.map((r) => r.gross)))},`
            + ` indoor ${Math.min(...runs.map((r) => r.min)).toFixed(1)}–${Math.max(...runs.map((r) => r.max)).toFixed(1)} °C`);
    }
}
