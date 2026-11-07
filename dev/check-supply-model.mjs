// How well the planner's pump model predicts indoor: the house model run open loop over the
// history, heat from the pump's calculated supply (planner.ts `pumpHeat`, heatPerSupplyK × (1017 −
// indoor)) against heat from the meter, 6 h and 24 h ahead from every hour. If supply predicts
// as well as the meter, the comfort bias (trim.ts) that inverts it can be trusted. Reads only.
//
//   node --import tsx dev/check-supply-model.mjs <history url or file> [--system radiators] [--since 2026-11-04]
import fs from 'node:fs';
import {History, applyJournal} from '../lib/autopilot/history.ts';
import {fitHistory} from '../lib/autopilot/house.ts';
import {stepHouse} from '../lib/autopilot/model.ts';
import {heatPerSlot} from '../lib/autopilot/heat.ts';
import {SLOT_MS} from '../lib/autopilot/prices.ts';

const source = process.argv[2];
if (!source) {
    console.error('usage: node --import tsx dev/check-supply-model.mjs <history url or file> [--system radiators] [--since YYYY-MM-DD]');
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
const journal = await read(source.replace(/\.bin$/, '.journal'));
if (journal) applyJournal(history, journal);

const fit = fitHistory(history, {system: option('system', 'unknown'), era: 'unknown'});
const k = fit.pump?.heatPerSupplyK;
if (!fit.params || k === undefined) {
    console.error('No house model or emission yet.');
    process.exit(1);
}
const since = Date.parse(option('since', '1970-01-01')) / SLOT_MS;
const rows = history.range().map((slot) => ({slot, ...history.get(slot)}));
const meter = heatPerSlot(rows.map((r) => ({slot: r.slot, qmeter: r.qmeter, hz: r.hz, dhw: r.dhw})));
const p = fit.params;
console.log(`heat loss ${(p.heatLoss * 1000).toFixed(0)} W/K, emission ${(k * 1000).toFixed(0)} W per K of supply above indoor`);
for (const hours of [6, 24]) {
    const span = hours * 4;
    const errSupply = [];
    const errMeter = [];
    for (let i = 0; i + span < rows.length; i += 4) {
        if (rows[i].slot < since || rows[i + span - 1].slot !== rows[i].slot + span - 1) continue;
        let [ti, tm, tiM, tmM] = [rows[i].ti, rows[i].ti, rows[i].ti, rows[i].ti];
        let ok = Number.isFinite(ti);
        for (let j = i; ok && j < i + span; j++) {
            const r = rows[j];
            const q = meter.get(r.slot);
            if (![r.te, r.tcalc].every(Number.isFinite) || q === undefined) { ok = false; break; }
            const sun = {sun: r.gtiS || 0, sunE: r.gtiE || 0, sunW: r.gtiW || 0};
            // During hot water the compressor isn't heating the house.
            const fromSupply = r.dhw > 0.05 ? 0 : Math.max(0, k * (r.tcalc - ti)) * 0.25;
            [ti, tm] = stepHouse(p, ti, tm, {te: r.te, q: fromSupply, ...sun});
            [tiM, tmM] = stepHouse(p, tiM, tmM, {te: r.te, q, ...sun});
        }
        if (!ok) continue;
        const actual = rows[i + span - 1].ti;
        errSupply.push(ti - actual);
        errMeter.push(tiM - actual);
    }
    const stat = (e) => `bias ${(e.reduce((a, b) => a + b, 0) / e.length).toFixed(2)}, RMS ${Math.sqrt(e.reduce((a, b) => a + b * b, 0) / e.length).toFixed(2)} K`;
    if (!errSupply.length) console.log(`${hours} h: no windows`);
    else console.log(`${hours} h ahead (${errSupply.length} windows): from supply ${stat(errSupply)}; from the meter ${stat(errMeter)}`);
}
