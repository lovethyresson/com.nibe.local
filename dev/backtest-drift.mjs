// Back-test of an indoor drift (tasks/drift-analysis-2026-11-24.md, step 0): fit the house model on the
// history up to a cut-off, exactly as the app does (lib/autopilot/house.ts), then run it open-loop from
// there with the heat the pump actually delivered, the real outdoor temperature and sun. Prints the
// daily indoor mean, measured against predicted, beside the day's wind. If the model, which has the
// house's thermal mass but no wind, predicts the decline, the house was settling after colder weather;
// if a residual opens with the wind, it is wind. Reads only.
//
//   node --import tsx dev/backtest-drift.mjs <url or file> --cut "2026-11-18 00:00" [--to "2026-11-24 08:00"]
import fs from 'node:fs';
import {History, applyJournal} from '../lib/autopilot/history.ts';
import {fitHouse, modelSlotsFromHistory, pumpFromHistory} from '../lib/autopilot/house.ts';
import {stepHouse} from '../lib/autopilot/model.ts';

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
const cut = slotAt(option('cut', '2026-11-18 00:00'));
const to = slotAt(option('to', '2099-01-01 00:00'));

const all = modelSlotsFromHistory(history);
const before = all.filter((s) => s.slot < cut);
const after = all.filter((s) => s.slot >= cut && s.slot < to);
const pump = pumpFromHistory(history);
const fit = fitHouse(before, {system: 'unknown', era: 'unknown'}, pump.lever, pump);
if (!fit.params || !fit.state) { console.error('No fit before the cut-off.'); process.exit(1); }
const p = fit.params;
console.log(`fit to ${option('cut', '2026-11-18 00:00')}: heat loss ${Math.round(p.heatLoss * 1000)} W/K, `
    + `τ ${Math.round((p.ci + p.cm) / p.heatLoss)} h, gains ${p.gains.toFixed(2)} kW, 6 h error ${fit.rmse.toFixed(2)} K`);

// Start from the fit's filtered state at the cut-off, then run open-loop on measured inputs.
let ti = fit.state.ti, tm = fit.state.tm;
const days = new Map();
for (const s of after) {
    [ti, tm] = stepHouse(p, ti, tm, s.inputs);
    const d = days.get(localDay(s.slot)) ?? {meas: [], pred: [], wind: [], te: [], q: 0};
    if (Number.isFinite(s.ti)) { d.meas.push(s.ti); d.pred.push(ti); }
    const w = history.get(s.slot)?.wind;
    if (Number.isFinite(w)) d.wind.push(w);
    d.te.push(s.inputs.te);
    d.q += s.inputs.q;
    days.set(localDay(s.slot), d);
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
console.log('day         measured predicted  resid  wind m/s  outdoor  heat kWh');
for (const [day, d] of days) {
    if (!d.meas.length) continue;
    console.log(day, mean(d.meas).toFixed(2).padStart(8), mean(d.pred).toFixed(2).padStart(9),
        (mean(d.meas) - mean(d.pred)).toFixed(2).padStart(6), mean(d.wind).toFixed(1).padStart(9),
        mean(d.te).toFixed(1).padStart(8), d.q.toFixed(1).padStart(9));
}
