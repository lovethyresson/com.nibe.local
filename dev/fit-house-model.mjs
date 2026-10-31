// Fits the smart heating house model to the history file, exactly as the app does every hour
// (lib/smart/house.ts), and prints what it learned. Reads only. Same inputs as
// read-smart-history.mjs. The app's own latest fit is beside the history as `….model.json`.
//
//   node --import tsx dev/fit-house-model.mjs <url or file> [--system radiators|slab|wooden_floor|both|unknown]
//       [--era pre1960|1960_1979|1980_1999|2000_or_later|unknown] [--days <last n days only>]
import fs from 'node:fs';
import {History, applyJournal} from '../lib/smart/history.ts';
import {CURVE_GAIN} from '../lib/smart/actuator.ts';
import {estimateLever} from '../lib/smart/planner.ts';
import {fitHouse, heatingHours, modelSlotsFromHistory, readiness} from '../lib/smart/house.ts';
import {houseInsights, insightsLine} from '../lib/smart/insights.ts';

const source = process.argv[2];
if (!source) {
    console.error('usage: node --import tsx dev/fit-house-model.mjs <url or file> [--system …] [--era …] [--days n]');
    process.exit(1);
}
const option = (name, fallback) => {
    const at = process.argv.indexOf(`--${name}`);
    return at > 0 ? process.argv[at + 1] : fallback;
};
const read = async (path) => (/^https?:/.test(path)
    ? fetch(path).then(async (r) => (r.ok ? Buffer.from(await r.arrayBuffer()) : undefined))
    : fs.promises.readFile(path).catch(() => undefined));
const history = History.deserialize(await read(source) ?? Buffer.alloc(0));
if (!history) {
    console.error('Not a history file this version can read.');
    process.exit(1);
}
// Slots closed since the last hourly save, as the app replays them (lib/smart/store-file.ts).
const journal = await read(`${source}.journal`);
if (journal?.length) applyJournal(history, journal);
let slots = modelSlotsFromHistory(history);
const days = option('days');
if (days) slots = slots.slice(-Number(days) * 96);
const fit = fitHouse(slots, {system: option('system', 'unknown'), era: option('era', 'unknown')},
    estimateLever(heatingHours(history), CURVE_GAIN));
const insights = houseInsights(fit);
console.log(insightsLine(fit, insights, readiness(fit, [])));
if (fit.params) {
    const p = fit.params;
    const round = (v, d = 3) => +v.toFixed(d);
    console.log({firstOrderHeatLossWPerK: fit.firstOrderHeatLoss && round(fit.firstOrderHeatLoss * 1000, 0),
        heatLossWPerK: round(p.heatLoss * 1000, 0), airKWhPerK: round(p.ci, 2), massKWhPerK: round(p.cm, 1),
        rimKPerKW: round(p.rim, 2), massShareOfHeat: round(p.f, 2), sunKWAt500: round(p.sun * 500, 2),
        gainsKW: round(p.gains, 2), hoursPerDegree: insights && round(insights.hoursPerDegree, 1)});
}
