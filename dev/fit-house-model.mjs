// Fits the smart heating house model (lib/smart/model.ts) to the history file and prints what
// it learned. Reads only. Same inputs as read-smart-history.mjs.
//
//   node --import tsx dev/fit-house-model.mjs <url or file> [--system radiators|slab|wooden_floor|both|unknown]
//       [--era pre1960|1960_1979|1980_1999|2000_or_later|unknown] [--warmup <slots>]
import fs from 'node:fs';
import {FLAG, History} from '../lib/smart/history.ts';
import {heatPerSlot} from '../lib/smart/heat.ts';
import {envelopeTau, fitSeries, predictionRmse, rlsHouse, toModelSlots} from '../lib/smart/model.ts';

const source = process.argv[2];
if (!source) {
    console.error('usage: node --import tsx dev/fit-house-model.mjs <url or file> [--system …] [--era …] [--warmup n]');
    process.exit(1);
}
const option = (name, fallback) => {
    const at = process.argv.indexOf(`--${name}`);
    return at > 0 ? process.argv[at + 1] : fallback;
};
const buffer = /^https?:/.test(source)
    ? Buffer.from(await (await fetch(source)).arrayBuffer())
    : fs.readFileSync(source);
const history = History.deserialize(buffer);
if (!history) {
    console.error('Not a history file this version can read.');
    process.exit(1);
}
const rows = history.range().map((slot) => ({slot, ...history.get(slot)}));
const heat = heatPerSlot(rows.map((r) => ({slot: r.slot, qmeter: r.qmeter, hz: r.hz, dhw: r.dhw})));
const slots = toModelSlots(rows.map((r) => ({slot: r.slot, ti: r.ti, te: r.te, gtiS: r.gtiS, dhw: r.dhw,
    partial: (r.flags & FLAG.partial) !== 0, q: heat.get(r.slot)})));
const fit = fitSeries(slots, option('system', 'unknown'), option('era', 'unknown'),
    {warmupSlots: Number(option('warmup', 3 * 96))});

const round = (v, d = 3) => +v.toFixed(d);
console.log(`${slots.length} slots, ${slots.filter((s) => s.usable).length} usable`);
const first = rlsHouse(fit.rls);
console.log('stage 1:', first ? `heat loss ${round(first.heatLoss * 1000, 0)} W/K` : 'not plausible yet');
if (!fit.params) {
    console.log('stage 2: not started (needs the warm-up first)');
} else {
    const p = fit.params;
    console.log('stage 2:', {
        heatLossWPerK: round(p.heatLoss * 1000, 0), tauH: round(envelopeTau(p), 1), storedKWhPerK: round(p.ci + p.cm, 1),
        airKWhPerK: round(p.ci, 2), massShareOfHeat: round(p.f, 2), sunKWAt500: round(p.sun * 500, 2),
        gainsKW: round(p.gains, 2), updates: fit.ekf.updates,
    });
    const quality = predictionRmse(p, slots, fit.states);
    console.log(`6 h prediction: RMSE ${round(quality.rmse)} K over ${quality.windows} windows`);
}
