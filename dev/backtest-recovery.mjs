// Would a hold that plans on flat prices have brought this house back to the setpoint sooner? Fits the
// house exactly as the app does on the history before `--from` (lib/autopilot/house.ts), then runs it
// open-loop on the heat actually delivered, twice: as it happened (the Getting started hold, trim only),
// and with the planner also run every 2 h on the forecast flattened to its mean price (live.ts with the
// Comfort profile), its extra heat over doing nothing added to the delivered heat. Weather is the
// measured one. Prints the daily indoor mean of each run beside what was measured; the difference
// between the two runs is what the change adds. Reads only.
//
//   node --import tsx dev/backtest-recovery.mjs <url or file> [--from "2026-11-23 00:00"] [--setpoint 22.5]
import fs from 'node:fs';
import {History, applyJournal} from '../lib/autopilot/history.ts';
import {fitHouse, modelSlotsFromHistory, pumpFromHistory} from '../lib/autopilot/house.ts';
import {stepHouse} from '../lib/autopilot/model.ts';
import {planShift} from '../lib/autopilot/planner.ts';
import {PROFILE_LIMITS} from '../lib/autopilot/live.ts';

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
const from = slotAt(option('from', '2026-11-23 00:00'));
const SP = Number(option('setpoint', '22.5'));
const all = modelSlotsFromHistory(history);
const pump = pumpFromHistory(history);
const fit = fitHouse(all.filter((s) => s.slot < from), {system: 'unknown', era: 'unknown'}, pump.lever, pump);
if (!fit.params || !fit.state) { console.error('No fit before --from.'); process.exit(1); }
const p = fit.params;
const plannerPump = pump.supply && pump.heatPerSupplyK > 0
    ? {supply: pump.supply, heatPerSupplyK: pump.heatPerSupplyK, shiftOnly: true}
    : {lever: pump.lever};
const after = all.filter((s) => s.slot > fit.state.slot);
const fedOf = (slot) => { const v = history.get(slot); return v && Number.isFinite(v.bt1) ? v.bt1 : undefined; };

let held = [fit.state.ti, fit.state.tm], flat = [fit.state.ti, fit.state.tm];
let extra = [], extraAt = 0, bias = 0;
const days = new Map();
for (let i = 0; i < after.length; i++) {
    const s = after[i];
    if ((s.slot - after[0].slot) % 8 === 0) {
        // The next 24 h as measured, at one flat price: the planner can only buy back owed warmth.
        const ahead = after.slice(i, i + 96);
        if (ahead.length >= 8) {
            const forecast = ahead.map((a) => ({te: a.inputs.te, sun: 0, price: 1}));
            const fed = fedOf(s.slot) ?? s.inputs.te;
            const plan = planShift(p, SP, {ti: flat[0], tm: flat[1], curve: fed, bias}, forecast, PROFILE_LIMITS.comfortable, plannerPump);
            extra = plan.plan.heat.map((q, k) => q - plan.baseline.heat[k]);
            extraAt = i;
            bias = plan.shift[0] ?? 0;
        }
    }
    held = stepHouse(p, held[0], held[1], s.inputs);
    const q = Math.max(0, s.inputs.q + (extra[i - extraAt] ?? 0));
    flat = stepHouse(p, flat[0], flat[1], {...s.inputs, q});
    const d = days.get(localDay(s.slot)) ?? {meas: [], held: [], flat: [], extra: 0, shift: []};
    if (Number.isFinite(s.ti)) d.meas.push(s.ti);
    d.held.push(held[0]);
    d.flat.push(flat[0]);
    d.extra += extra[i - extraAt] ?? 0;
    days.set(localDay(s.slot), d);
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`fit to ${option('from', '2026-11-23 00:00')}: heat loss ${Math.round(p.heatLoss * 1000)} W/K, τ ${Math.round((p.ci + p.cm) / p.heatLoss)} h; setpoint ${SP}`);
console.log('day         measured  model, held  model, flat  added  extra heat kWh');
for (const [day, d] of days) {
    console.log(day, (d.meas.length ? mean(d.meas).toFixed(2) : '-').padStart(8), mean(d.held).toFixed(2).padStart(12),
        mean(d.flat).toFixed(2).padStart(12), (mean(d.flat) - mean(d.held)).toFixed(2).padStart(6), d.extra.toFixed(1).padStart(14));
}
const lastMeasured = [...after].reverse().find((s) => Number.isFinite(s.ti));
console.log(`now (${new Date(after.at(-1).slot * SLOT_MS).toLocaleString('sv-SE').slice(0, 16)}): measured ${lastMeasured?.ti.toFixed(2)}, `
    + `model held ${held[0].toFixed(2)}, model flat ${flat[0].toFixed(2)}, added ${(flat[0] - held[0]).toFixed(2)} K`);
