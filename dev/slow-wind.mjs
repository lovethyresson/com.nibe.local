// A slow wind estimator, outside the house model's filter (tasks/drift-analysis-2026-11-24.md: the filter
// learns no wind from 15-minute steps). At each cut-off: fit the house as the app does on the history before
// it (lib/autopilot/house.ts), then choose one wind coefficient for it,
//   heat loss for a slot = fitted + kw × (wind − mean wind of the training days)
// by the open-loop error of `--horizon`-hour windows started every 6 h from the filter's states over the last
// `--days` days. Then predict after the cut-off with and without it. Prints kw per cut-off (is it stable?)
// and the out-of-sample gaps, overall and after windy days. Reads only.
//
//   node --import tsx dev/slow-wind.mjs <url or file> [--from "2026-11-12 00:00"] [--step 12] [--horizon 48] [--days 14]
import fs from 'node:fs';
import {History, applyJournal} from '../lib/autopilot/history.ts';
import {fitHouse, modelSlotsFromHistory, pumpFromHistory} from '../lib/autopilot/house.ts';
import {fitSeries, stepHouse} from '../lib/autopilot/model.ts';

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
const HORIZON = Number(option('horizon', '48')) * 4, DAYS = Number(option('days', '14'));
const all = modelSlotsFromHistory(history);
const pump = pumpFromHistory(history);
const windAt = (slot) => { const w = history.get(slot)?.wind; return Number.isFinite(w) ? w : undefined; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const rms = (a) => Math.sqrt(mean(a.map((x) => x * x)));
const f = (v, d = 2, w = 6) => (Number.isFinite(v) ? v.toFixed(d) : '-').padStart(w);

const step = (p, kw, ref, ti, tm, s) => {
    const w = windAt(s.slot) ?? ref;
    return stepHouse({...p, heatLoss: Math.max(0.2 * p.heatLoss, p.heatLoss + kw * (w - ref))}, ti, tm, s.inputs);
};
// Mean gap of an open-loop run from `state` over the slots after it, up to `hours`.
const run = (p, kw, ref, state, slots, hours) => {
    let ti = state.ti, tm = state.tm;
    const out = [];
    for (const s of slots) {
        if (s.slot <= state.slot) continue;
        if (s.slot > state.slot + hours * 4) break;
        [ti, tm] = step(p, kw, ref, ti, tm, s);
        if (Number.isFinite(s.ti)) out.push(s.ti - ti);
    }
    return out;
};
const KWS = Array.from({length: 41}, (_, i) => i * 0.0005); // 0 … 20 W/K per m/s

const rows = [];
console.log(`kw chosen on ${HORIZON / 4} h windows over the last ${DAYS} days before each cut-off; tested after it`);
console.log('cut          kw W/K/(m/s)  ref m/s  train err kw/0   next 24h wind   48h gap kw/0     day-5 gap kw/0');
for (let cut = slotAt(option('from', '2026-11-12 00:00')); cut <= all.at(-1).slot; cut += Number(option('step', '12')) * 4) {
    const train = all.filter((s) => s.slot < cut);
    const fit = fitHouse(train, {system: 'unknown', era: 'unknown'}, pump.lever, pump);
    if (!fit.params || !fit.state) continue;
    const p = fit.params;
    const recent = train.filter((s) => s.slot >= cut - DAYS * 96);
    const ref = mean(recent.map((s) => windAt(s.slot)).filter((w) => w !== undefined));
    const states = fitSeries(train, 'unknown', 'unknown', {warmupSlots: Math.min(3 * 96, train.length)}).states;
    // Training windows: every 6 h from a filtered state, ending before the cut-off.
    const starts = recent.filter((s, i) => i % 24 === 0 && states.has(s.slot) && s.slot + HORIZON < cut);
    const err = (kw) => rms(starts.flatMap((s) => {
        const [ti, tm] = states.get(s.slot);
        const g = run(p, kw, ref, {slot: s.slot, ti, tm}, train, HORIZON / 4);
        return g.length ? [mean(g.slice(-16))] : [];
    }));
    let best = {kw: 0, e: err(0)};
    const e0 = best.e;
    for (const kw of KWS) { const e = err(kw); if (e < best.e) best = {kw, e}; }
    const next = mean(all.filter((s) => s.slot > fit.state.slot && s.slot <= fit.state.slot + 96).map((s) => windAt(s.slot)).filter((w) => w !== undefined));
    const g48 = (kw) => mean(run(p, kw, ref, fit.state, all, 48));
    const g120 = (kw) => { const g = run(p, kw, ref, fit.state, all, 120); return g.length > 400 ? mean(g.slice(-96)) : NaN; };
    const r = {cut, kw: best.kw, ref, next, a48: g48(best.kw), b48: g48(0), a120: g120(best.kw), b120: g120(0)};
    rows.push(r);
    console.log(local(cut), f(r.kw * 1000, 1, 11), f(ref, 1, 8), `${f(best.e, 2, 10)}/${f(e0, 2, 4)}`, f(next, 1, 12),
        `${f(r.a48, 2, 10)}/${f(r.b48, 2, 5)}`, `${f(r.a120, 2, 12)}/${f(r.b120, 2, 5)}`);
}
const windy = rows.filter((r) => r.next >= r.ref + 2);
const g = (set, k) => rms(set.map((r) => r[k]).filter(Number.isFinite));
console.log(`\nrms gap after the cut-off   48 h kw/none   day 5 kw/none`);
console.log(`all ${rows.length} cut-offs`.padEnd(28), `${f(g(rows, 'a48'))}/${f(g(rows, 'b48'), 2, 4)}`, `   ${f(g(rows, 'a120'))}/${f(g(rows, 'b120'), 2, 4)}`);
console.log(`${windy.length} before a windy day`.padEnd(28), `${f(g(windy, 'a48'))}/${f(g(windy, 'b48'), 2, 4)}`, `   ${f(g(windy, 'a120'))}/${f(g(windy, 'b120'), 2, 4)}`);
const kws = rows.map((r) => r.kw * 1000);
console.log(`kw: min ${Math.min(...kws).toFixed(1)}, median ${[...kws].sort((a, b) => a - b)[Math.floor(kws.length / 2)].toFixed(1)}, max ${Math.max(...kws).toFixed(1)} W/K per m/s`);
