// How stable is the house fit? Fits the house exactly as the app does (lib/autopilot/house.ts) at rolling
// cut-offs, every `--step` hours, and prints what each fit learned beside how well it then predicts:
// open-loop from the cut-off on the heat actually delivered, the mean of measured minus predicted over the
// next 24 h and 48 h. Reads only.
//
//   node --import tsx dev/fit-stability.mjs <url or file> [--from "2026-11-12 00:00"] [--step 12]
import fs from 'node:fs';
import {History, applyJournal} from '../lib/autopilot/history.ts';
import {fitHouse, modelSlotsFromHistory, pumpFromHistory} from '../lib/autopilot/house.ts';
import {fitSeries, stepHouse} from '../lib/autopilot/model.ts';
import {heatCheck} from '../lib/autopilot/heat-check.ts';

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
const local = (slot) => new Date(slot * SLOT_MS).toLocaleString('sv-SE').slice(5, 16);
const all = modelSlotsFromHistory(history);
const pump = pumpFromHistory(history);
const step = Number(option('step', '12')) * 4;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const f = (v, d = 2, w = 6) => (Number.isFinite(v) ? v.toFixed(d) : '-').padStart(w);

// Variants of the heat loss the plan uses, scored on the same open-loop gaps:
//   app:    as shipped (the fitted heat loss, replaced by the meter's when 3 days disagree by over 5 %)
//   fitted: the fitted heat loss, never replaced
//   ratio6: the fitted heat loss scaled by metered/modelled heat over the last 6 days, always, within 0.8–1.25
const score = {app: [], fitted: [], ratio6: []};
const gapsFor = (p, state) => {
    let ti = state.ti, tm = state.tm;
    const out = {24: [], 48: [], 120: []};
    for (const s of all) {
        if (s.slot <= state.slot) continue;
        if (s.slot > state.slot + 120 * 4) break;
        [ti, tm] = stepHouse(p, ti, tm, s.inputs);
        if (!Number.isFinite(s.ti)) continue;
        if (s.slot <= state.slot + 24 * 4) out[24].push(s.ti - ti);
        if (s.slot <= state.slot + 48 * 4) out[48].push(s.ti - ti);
        if (s.slot > state.slot + 96 * 4) out[120].push(s.ti - ti);
    }
    return {g24: mean(out[24]), g48: mean(out[48]), g120: out[120].length > 48 ? mean(out[120]) : NaN};
};
console.log('cut          fitted checked check  ratio   Ci    Cm   rim    f  gains  sun   τ h  6h err  24h gap 48h gap');
for (let cut = slotAt(option('from', '2026-11-12 00:00')); cut <= all.at(-1).slot; cut += step) {
    const train = all.filter((s) => s.slot < cut);
    const fit = fitHouse(train, {system: 'unknown', era: 'unknown'}, pump.lever, pump);
    if (!fit.params || !fit.state) { console.log(local(cut), 'no fit'); continue; }
    const p = fit.params;
    let ti = fit.state.ti, tm = fit.state.tm;
    const gaps = {24: [], 48: []};
    for (const s of all) {
        if (s.slot <= fit.state.slot) continue;
        if (s.slot > fit.state.slot + 48 * 4) break;
        [ti, tm] = stepHouse(p, ti, tm, s.inputs);
        if (!Number.isFinite(s.ti)) continue;
        if (s.slot <= fit.state.slot + 24 * 4) gaps[24].push(s.ti - ti);
        gaps[48].push(s.ti - ti);
    }
    const check = fit.heatCheck;
    console.log(local(cut), f((fit.fittedHeatLoss ?? p.heatLoss) * 1000, 0, 7), f(p.heatLoss * 1000, 0, 7),
        (check?.heatLoss !== undefined ? 'meter' : check?.skip ?? '-').padStart(6), f(check?.ratio, 2),
        f(p.ci, 2), f(p.cm, 1), f(p.rim, 2), f(p.f, 2, 5), f(p.gains, 2), f((p.sun + p.sunE + p.sunW) * 500, 2, 5),
        f((p.ci + p.cm) / p.heatLoss, 0, 5), f(fit.rmse, 2, 7), f(mean(gaps[24]), 2, 8), f(mean(gaps[48]), 2, 8));
    const fitted = {...p, heatLoss: fit.fittedHeatLoss ?? p.heatLoss};
    const states = fitSeries(train, 'unknown', 'unknown', {warmupSlots: Math.min(3 * 96, train.length)}).states;
    const days = [...heatCheck(fitted, train, states).days, ...heatCheck(fitted, train.filter((s) => s.slot < cut - 3 * 96), states).days];
    const met = days.reduce((a, d) => a + d.metered, 0), mod = days.reduce((a, d) => a + d.modelled, 0);
    const ratio = mod > 0 ? Math.min(1.25, Math.max(0.8, met / mod)) : 1;
    for (const [name, q] of [['app', p], ['fitted', fitted], ['ratio6', {...fitted, heatLoss: fitted.heatLoss * ratio}]]) score[name].push(gapsFor(q, fit.state));
}
console.log('variant   24 h gap: mean   rms    48 h gap: mean   rms   worst 48 h   day-5 gap: mean   rms');
for (const [name, g] of Object.entries(score)) {
    const a = g.map((x) => x.g24).filter(Number.isFinite), b = g.map((x) => x.g48).filter(Number.isFinite);
    const c = g.map((x) => x.g120).filter(Number.isFinite);
    const rms = (v) => Math.sqrt(mean(v.map((x) => x * x)));
    console.log(name.padEnd(8), f(mean(a), 2, 15), f(rms(a), 2), f(mean(b), 2, 16), f(rms(b), 2), f(b.reduce((m, x) => Math.abs(x) > Math.abs(m) ? x : m, 0), 2, 12),
        f(mean(c), 2, 17), f(rms(c), 2));
}
