// Offline "new user": what would a brand-new Autopilot heating have done in this house since `--from`?
// The house is the app's own fit on all of this history (lib/autopilot/house.ts), used as the truth. Weather,
// sun, prices and hot water are what happened. The pump answers a different feed through the learned lever:
// heat = the heat actually delivered + lever × (real curve input − simulated curve input), the curve input being
// the fed outdoor filtered as the pump sees it (actuator.ts). A new Autopilot then runs on top, learning the
// house from scratch:
//   - the trim from the first 12 h of readings (setpoint.ts), at the default time constant until the model is
//     ready, then at the model's;
//   - the model refitted every midnight on the simulated readings since the start, ready by `readiness`;
//   - Getting started: hold (no price shifts) from ready until the first day within the comfort range, then
//     shifting (settling.ts `withinRange`). The hold is either "old" (plans nothing) or "flat" (plans on one
//     flat price, 8264f23).
// Prints both side by side per day. Reads only.
//
//   node --import tsx dev/replay-new-user.mjs <url or file> [--from "2026-10-31 00:00"] [--setpoint 22.5]
import fs from 'node:fs';
import {History, applyJournal} from '../lib/autopilot/history.ts';
import {fitHouse, modelSlotsFromHistory, pumpFromHistory, readiness, recordDailyFit} from '../lib/autopilot/house.ts';
import {envelopeTau, fitSeries, stepHouse} from '../lib/autopilot/model.ts';
import {nextTrim} from '../lib/autopilot/setpoint.ts';
import {planShift} from '../lib/autopilot/planner.ts';
import {PROFILE_LIMITS, flatPrices} from '../lib/autopilot/live.ts';
import {curveInput} from '../lib/autopilot/actuator.ts';
import {withinRange} from '../lib/autopilot/settling.ts';

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

const SLOT_MS = 15 * 60_000, SLOT_H = 0.25, DAY = 96;
const slotAt = (local) => Math.floor(new Date(local.replace(' ', 'T')).getTime() / SLOT_MS);
const localDay = (slot) => new Date(slot * SLOT_MS).toLocaleDateString('sv-SE');
const SP = Number(option('setpoint', '22.5'));
const LIMITS = PROFILE_LIMITS.comfortable;
const all = modelSlotsFromHistory(history);
const pump = pumpFromHistory(history);
const truthFit = fitHouse(all, {system: 'unknown', era: 'unknown'}, pump.lever, pump);
const truth = truthFit.params;
const truthStates = fitSeries(all, 'unknown', 'unknown').states;
const LEVER = pump.lever ?? truthFit.lever;
const from = slotAt(option('from', '2026-10-31 00:00'));
const slots = all.filter((s) => s.slot >= from);
const raw = (slot) => history.get(slot) ?? {};
const priceAt = (slot) => (Number.isFinite(raw(slot).price) ? raw(slot).price : 1);
const sunOf = (s) => ({sun: s.inputs.sun, sunE: s.inputs.sunE, sunW: s.inputs.sunW});
let noiseSeed = 7;
const noise = () => ((noiseSeed = (noiseSeed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5) * 0.1;
console.log(`truth house: heat loss ${Math.round(truth.heatLoss * 1000)} W/K, τ ${Math.round(envelopeTau(truth))} h; lever ${Math.round(LEVER * 1000)} W/K; setpoint ${SP}`);

function replay(holdKind) {
    const anchor = [...truthStates.keys()].filter((k) => k <= from).at(-1);
    const start = anchor !== undefined ? truthStates.get(anchor) : [slots.find((s) => Number.isFinite(s.ti)).ti, slots.find((s) => Number.isFinite(s.ti)).ti];
    let [ti, tm] = start;
    let qLast = 0;
    const fedAt = (k, te) => (Number.isFinite(raw(k).bt1) ? raw(k).bt1 : te);
    let curveSim = fedAt(from, slots[0].inputs.te), curveReal = curveSim;
    let trim = {integral: 0}, shift = [], shiftAt = 0, prevBias = 0;
    let model, modelState, log = [], ready, shifting;
    const seen = [], simSlots = [], days = new Map();
    for (let i = 0; i < slots.length; i++) {
        const s = slots[i], k = s.slot;
        // Midnight: score yesterday, refit the model on what this Autopilot has seen.
        if (k % DAY === 0 && simSlots.length >= DAY) {
            // Slots are counted from UTC midnight, an hour into the local day: yesterday is the local day 2 h back.
            const y = days.get(localDay(k - 8));
            if (ready && !shifting && y && withinRange({date: localDay(k - 8), mean: y.ti / y.n, slots: y.n, setMin: SP, setMax: SP},
                LIMITS.lower, LIMITS.upper)) shifting = localDay(k);
            const fit = fitHouse(simSlots, {system: 'unknown', era: 'unknown'}, LEVER, pump);
            if (fit.params) {
                log = recordDailyFit(log, Math.floor(k / DAY), fit);
                model = fit; modelState = fit.state;
                if (!ready && readiness(fit, log).ready) ready = localDay(k);
            }
        }
        const reading = ti + noise();
        seen.push(reading);
        // The trim, every slot, once 12 h of readings exist (live.ts `learn`/`steer`).
        let trimNow = 0;
        if (seen.length >= 48) {
            const n = nextTrim(trim, {setpoint: SP, mean: seen.slice(-DAY).reduce((a, b) => a + b, 0) / Math.min(DAY, seen.length),
                hours: SLOT_H, integrate: true, tauHours: ready && model ? envelopeTau(model.params) : undefined});
            trim = n.state; trimNow = n.trim;
        }
        // The plan, every 2 h once the model is ready: held (old: nothing; flat: one price) or shifting.
        if (ready && model && i % 8 === 0) {
            const ahead = slots.slice(i, i + DAY);
            if (shifting || holdKind === 'flat') {
                let forecast = ahead.map((a) => ({te: a.inputs.te, ...sunOf(a), sun: 0, sunE: 0, sunW: 0, price: priceAt(a.slot), ...(raw(a.slot).dhw > 0.5 ? {busy: true} : {})}));
                if (!shifting) forecast = flatPrices(forecast);
                const plannerPump = model.pump?.supply ? {...model.pump, shiftOnly: true} : {lever: LEVER};
                const plan = planShift(model.params, SP, {ti: reading, tm: modelState?.tm ?? reading, curve: curveSim, bias: prevBias - trimNow},
                    forecast, LIMITS, plannerPump);
                shift = plan.shift; shiftAt = i;
            } else { shift = []; }
        }
        const planned = shift[i - shiftAt] ?? 0;
        const bias = trimNow + planned;
        prevBias = bias;
        // The pump: the real heat, plus the lever on how much colder this feed is than the real one.
        const fedReal = fedAt(k, s.inputs.te);
        curveReal = curveInput(curveReal, fedReal);
        curveSim = curveInput(curveSim, s.inputs.te - bias);
        // A slot whose real heat is unknown (a counter gap) carries the last known one.
        const qReal = Number.isFinite(s.inputs.q) ? (qLast = s.inputs.q) : qLast;
        const q = Math.max(0, qReal + LEVER * (curveReal - curveSim) * SLOT_H);
        [ti, tm] = stepHouse(truth, ti, tm, {te: s.inputs.te, q, ...sunOf(s)});
        simSlots.push({...s, ti: reading, inputs: {...s.inputs, q}});
        const d = days.get(localDay(k)) ?? {ti: 0, n: 0, bias: 0, q: 0, cost: 0};
        d.ti += ti; d.n += 1; d.bias += bias; d.q += q; d.cost += q / 3 * priceAt(k);
        d.phase = !ready ? 'learning' : shifting ? 'shifting' : 'holding';
        days.set(localDay(k), d);
    }
    return {days, ready, shifting};
}

const runs = {old: replay('old'), flat: replay('flat')};
console.log('model ready:', runs.flat.ready, '| first shifting day: old', runs.old.shifting, ', flat', runs.flat.shifting);
console.log('day         phase(flat)  | indoor old  flat | push old  flat | heat kWh old  flat');
for (const [day, d] of runs.flat.days) {
    const o = runs.old.days.get(day);
    const v = (x, k, n = 2, w = 6) => (x ? (x[k] / (k === 'q' ? 1 : x.n)).toFixed(n) : '-').padStart(w);
    console.log(day, d.phase.padEnd(12), '|', v(o, 'ti', 2, 10), v(d, 'ti'), '|', v(o, 'bias', 1, 8), v(d, 'bias', 1), '|', v(o, 'q', 0, 12), v(d, 'q', 0));
}
const tot = (r, from) => [...r.days.entries()].filter(([day]) => day >= from).reduce((a, [, d]) => ({q: a.q + d.q, cost: a.cost + d.cost, err: a.err + Math.abs(d.ti / d.n - SP), n: a.n + 1}), {q: 0, cost: 0, err: 0, n: 0});
for (const name of ['old', 'flat']) {
    const t = tot(runs[name], runs.flat.ready ?? '9999');
    console.log(`${name.padEnd(5)} from ready: heat ${t.q.toFixed(0)} kWh, cost index ${t.cost.toFixed(0)}, mean |indoor − setpoint| ${(t.err / t.n).toFixed(2)} K over ${t.n} days`);
}
