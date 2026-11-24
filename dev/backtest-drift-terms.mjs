// Which extra heat loss closes the 19–24 Nov drift (tasks/drift-analysis-2026-11-24.md)? Fits the house as
// the app does (lib/autopilot/house.ts) up to a cut-off, then adds one or both of two terms to its heat loss,
// centred on the training period's means so the fitted level stays valid:
//   wind:  + kw × (wind − mean wind)                      kW/K per m/s
//   cold:  + kc × ((indoor − outdoor) − mean gap)         kW/K per K, losses growing faster than the gap
// The coefficients are fitted on the 6 h open-loop windows before the cut-off only (from the fit's own
// filtered states, as `predictionRmse`), then tested out of sample: open-loop from the cut-off on the
// heat actually delivered, daily residual against the reading. Reads only.
//
//   node --import tsx dev/backtest-drift-terms.mjs <url or file> [--cut "2026-11-19 00:00"]
import fs from 'node:fs';
import {History, applyJournal} from '../lib/autopilot/history.ts';
import {fitHouse, modelSlotsFromHistory, pumpFromHistory} from '../lib/autopilot/house.ts';
import {HORIZON_SLOTS, fitSeries, stepHouse} from '../lib/autopilot/model.ts';

const source = process.argv[2];
const option = (name, fallback) => {
    const at = process.argv.indexOf(`--${name}`);
    return at > 0 ? process.argv[at + 1] : fallback;
};
const read = async (path) => (/^https?:/.test(path)
    ? fetch(path).then(async (r) => (r.ok ? Buffer.from(await r.arrayBuffer()) : undefined))
    : fs.promises.readFile(path).catch(() => undefined));
const file = await read(source) ?? Buffer.alloc(0);
const history = History.deserialize(file);
if (!history) { console.error('Not a history file this version can read.'); process.exit(1); }
const journal = await read(`${source}.journal`);
if (journal?.length) applyJournal(history, journal, History.fieldCount(file));

const SLOT_MS = 15 * 60_000;
const slotAt = (local) => Math.floor(new Date(local.replace(' ', 'T')).getTime() / SLOT_MS);
const localDay = (slot) => new Date(slot * SLOT_MS).toLocaleDateString('sv-SE');
const cutText = option('cut', '2026-11-19 00:00');
const cut = slotAt(cutText);
const windOf = (slot) => { const w = history.get(slot)?.wind; return Number.isFinite(w) ? w : undefined; };

const all = modelSlotsFromHistory(history);
const train = all.filter((s) => s.slot < cut);
const test = all.filter((s) => s.slot >= cut);
const pump = pumpFromHistory(history);
const fit = fitHouse(train, {system: 'unknown', era: 'unknown'}, pump.lever, pump);
if (!fit.params || !fit.state) { console.error('No fit before the cut-off.'); process.exit(1); }
// The plan's house (heat-checked, as the app plans with) and the filter's per-slot states for the windows.
const p = fit.params;
const states = fitSeries(train, 'unknown', 'unknown', {warmupSlots: Math.min(3 * 96, train.length)}).states;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const W0 = mean(train.map((s) => windOf(s.slot)).filter((w) => w !== undefined));
const D0 = mean(train.filter((s) => Number.isFinite(s.ti)).map((s) => s.ti - s.inputs.te));
console.log(`fit to ${cutText}: heat loss ${Math.round(p.heatLoss * 1000)} W/K, τ ${Math.round((p.ci + p.cm) / p.heatLoss)} h, `
    + `training means: wind ${W0.toFixed(1)} m/s, gap ${D0.toFixed(1)} K`);

// The house with the extra terms: its heat loss for this slot, from the state it is in.
const step = (kw, kc, ti, tm, s) => {
    const w = windOf(s.slot) ?? W0;
    const heatLoss = Math.max(0.02, p.heatLoss + kw * (w - W0) + kc * ((ti - s.inputs.te) - D0));
    return stepHouse({...p, heatLoss}, ti, tm, s.inputs);
};
// 6 h open-loop error over the training windows, as `predictionRmse`, with the terms.
const windows = [];
for (let start = 0; start + HORIZON_SLOTS < train.length; start += 4) {
    const state = states.get(train[start].slot);
    const w = train.slice(start + 1, start + 1 + HORIZON_SLOTS);
    if (!state || w.some((s, i) => s.slot !== train[start].slot + i + 1 || !s.usable || s.interpolated)) continue;
    windows.push({state, w});
}
const rmse = (kw, kc) => Math.sqrt(mean(windows.map(({state, w}) => {
    let [ti, tm] = state;
    for (const s of w) [ti, tm] = step(kw, kc, ti, tm, s);
    return (ti - w.at(-1).ti) ** 2;
})));
const grid = (from, to, n) => Array.from({length: n + 1}, (_, i) => from + (to - from) * i / n);
const best = (kws, kcs) => {
    let b = {kw: 0, kc: 0, e: Infinity};
    for (const kw of kws) for (const kc of kcs) { const e = rmse(kw, kc); if (e < b.e) b = {kw, kc, e}; }
    return b;
};
const models = {
    none: {kw: 0, kc: 0, e: rmse(0, 0)},
    wind: best(grid(-0.01, 0.03, 40), [0]),
    cold: best([0], grid(-0.01, 0.03, 40)),
};
models.both = best(grid(-0.01, 0.03, 20), grid(-0.01, 0.03, 20));
console.log(`${windows.length} training windows of 6 h`);
for (const [name, m] of Object.entries(models))
    console.log(`  ${name.padEnd(5)} kw ${(m.kw * 1000).toFixed(1).padStart(5)} W/K per m/s, kc ${(m.kc * 1000).toFixed(1).padStart(5)} W/K per K, 6 h error ${m.e.toFixed(3)} K`);

// Out of sample: open-loop from the cut-off on what was delivered.
const days = new Map();
const run = Object.fromEntries(Object.keys(models).map((k) => [k, [fit.state.ti, fit.state.tm]]));
for (const s of test) {
    const d = days.get(localDay(s.slot)) ?? {meas: [], wind: [], pred: Object.fromEntries(Object.keys(models).map((k) => [k, []]))};
    for (const [name, m] of Object.entries(models)) {
        run[name] = step(m.kw, m.kc, run[name][0], run[name][1], s);
        if (Number.isFinite(s.ti)) d.pred[name].push(run[name][0]);
    }
    if (Number.isFinite(s.ti)) d.meas.push(s.ti);
    const w = windOf(s.slot);
    if (w !== undefined) d.wind.push(w);
    days.set(localDay(s.slot), d);
}
console.log('out of sample, measured minus predicted (daily mean, K)');
console.log('day         measured  wind   ' + Object.keys(models).map((k) => k.padStart(6)).join(' '));
for (const [day, d] of days) {
    if (!d.meas.length) continue;
    const m = mean(d.meas);
    console.log(day, m.toFixed(2).padStart(8), mean(d.wind).toFixed(1).padStart(5), '  '
        + Object.keys(models).map((k) => (m - mean(d.pred[k])).toFixed(2).padStart(6)).join(' '));
}
