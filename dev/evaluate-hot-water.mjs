// Maintainer tool (not shipped — see .homeyignore). Back-test of the hot water planner on a real
// tank: the draws and prices that happened, replayed slot by slot. The planner sees only the past
// (its model is relearned each midnight from readings before it) and only the prices known at the
// time (today's, and tomorrow's from 13:00). Scored against what the owner's own setup paid and
// against the same planner with the draws known in advance.
//
//   node --import tsx dev/evaluate-hot-water.mjs --insights <dir> --prices <dir> [--weekends-free]
//        [--tz Europe/Stockholm] [--reserve 40] [--min 45] [--max 60] [--formula "(x+0.609)*1.25"]
//
// <dir> for --insights is what `dev/learn-hot-water.mjs --save <dir>` writes. --prices holds one
// Homey Energy `fetch-dynamic-electricity-prices` answer per day (`YYYY-MM-DD.json`).
// --weekends-free labels Saturday and Sunday free, as an owner's Flow would set the day type.

import {readFileSync, readdirSync} from 'fs';
import {join} from 'path';
import {intervals, learn, localClock, profileFor} from '../lib/autopilot/hotwater-learner.ts';
import {pointsFromInsights, RESOLUTIONS} from '../lib/autopilot/hotwater-insights.ts';
import {chargeRate, copAt} from '../lib/autopilot/hotwater-learner.ts';
import {SLOT_H, drawsFor, heatAt, plan, reserveKwh, tempOf} from '../lib/autopilot/hotwater-planner.ts';

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const has = (name) => argv.includes(`--${name}`);
const tz = flag('tz', 'Europe/Stockholm');
const clock = localClock(tz);
const formula = new Function('x', `return ${flag('formula', '(x+0.609)*1.25')};`);
const reserve = reserveKwh(Number(flag('reserve', 40)));
const minC = Number(flag('min', 45)), maxC = Number(flag('max', 57));
const SLOT = 15 * 60_000, HOUR = 3_600_000;
const slotOf = (ms) => Math.floor(ms / SLOT);

// Readings.
const dir = flag('insights');
const logs = {};
for (const field of ['litres', 'produced', 'used', 'top'])
    logs[field] = RESOLUTIONS.map((r) => { try { return JSON.parse(readFileSync(join(dir, `${field}.${r}.json`), 'utf8')); } catch { return {}; } });
const weekday = (ms) => new Date(`${clock(ms).date}T12:00:00Z`).getUTCDay();
const dayType = (ms) => has('weekends-free') ? (weekday(ms) === 0 || weekday(ms) === 6 ? 'free' : 'working') : undefined;
const points = pointsFromInsights(logs).map((p) => ({...p, dayType: dayType(p.t)}));

// Prices per 15-min slot, all-in.
const price = new Map();
for (const file of readdirSync(flag('prices')).filter((f) => f.endsWith('.json'))) {
    let body; try { body = JSON.parse(readFileSync(join(flag('prices'), file), 'utf8')); } catch { continue; }
    for (const x of body.pricesPerInterval ?? []) {
        const start = Date.parse(x.periodStart), end = Date.parse(x.periodEnd);
        for (let t = start; t < end; t += SLOT) price.set(slotOf(t), formula(x.value));
    }
}

// The truth: hourly draws from the whole record, the tank and pump from the whole record's model.
// A charge fills the tank at the rate the tank itself showed (hotwater-learner.ts `chargeRate`), not
// at the pump's heat counter, which counts heat the tank never gets
// (docs/hot-water-heat-accounting.md); otherwise the back-test only checks the planner against its
// own assumption.
const truthModel = learn(points, clock, points[points.length - 1].t);
const hourly = intervals(points.filter((p, k, a) => k > 0 && p.t - a[k - 1].t <= HOUR * 1.01 || (a[k + 1] && a[k + 1].t - p.t <= HOUR * 1.01)), truthModel.loss, truthModel.charge)
    .filter((i) => i.hours <= 1.01 && Number.isFinite(i.draw));
const drawBySlot = new Map();
for (const i of hourly) for (let q = 0; q < 4; q++) drawBySlot.set(slotOf(i.start) + q, i.draw / 4);
const first = Math.ceil(Math.min(...drawBySlot.keys()) / 96) * 96, last = Math.floor(Math.max(...drawBySlot.keys()) / 96) * 96;
const days = [];
for (let s = first; s < last; s += 96) if ([...Array(96).keys()].every((q) => drawBySlot.has(s + q) && price.has(s + q))) days.push(s);
if (!days.length) { console.error('no full day with both draws and prices'); process.exit(1); }
const tank = {litres: Number(flag('litres', 176)), inletC: 10};
const charge = truthModel.charge, loss = truthModel.loss;
const startStored = (() => { const p = points.find((x) => x.t >= days[0] * SLOT && x.litres > 0); return p.litres * 0.0349; })();

/** One simulated pump: `decide(slot, stored)` returns a target °C to start a charge (or
 *  {target, slots} for a boost that also expires), or undefined. */
function simulate(decide) {
    let stored = startStored, target, until, cost = 0, el = 0, charges = 0, below = 0, targets = 0, runSlots = 0;
    for (const day of days) for (let s = day; s < day + 96; s++) {
        if (target === undefined) {
            const d = decide(s, stored);
            const t = typeof d === 'object' ? d.target : d;
            if (t !== undefined && heatAt(tank, t) > stored + 0.05) {
                target = t; until = typeof d === 'object' ? s + d.slots : Infinity; charges++; targets += t;
            }
        }
        if (target !== undefined) {
            const full = chargeRate(charge, stored) * SLOT_H;
            const q = Math.min(full, heatAt(tank, target) - stored);
            const e = charge.kw !== undefined ? charge.kw * SLOT_H * q / full : q / copAt(charge, tempOf(tank, stored + q));
            stored += q; el += e; cost += e * price.get(s); runSlots++;
            if (stored >= heatAt(tank, target) - 1e-6 || s + 1 >= until) target = undefined;
        }
        stored = Math.max(0, stored - drawBySlot.get(s) - (loss.base + loss.perKwh * stored) * SLOT_H);
        if (stored < reserve) below++;
    }
    const n = days.length;
    return {krDay: cost / n, elDay: el / n, chargesDay: charges / n, meanTarget: charges ? targets / charges : NaN, below,
        runH: charges ? runSlots * SLOT_H / charges : NaN};
}

// Model relearned each midnight from readings before it.
const models = new Map();
const modelFor = (s) => {
    const day = Math.floor(s / 96) * 96;
    if (!models.has(day)) models.set(day, learn(points.filter((p) => p.t < day * SLOT), clock, day * SLOT));
    return models.get(day);
};
/** Prices known at slot s: through tonight, and through tomorrow from 13:00 local. */
const horizon = (s) => {
    const {hour} = clock(s * SLOT);
    const midnights = [];
    for (let k = s + 1; k < s + 200; k++) if (clock(k * SLOT).hour === 0 && clock((k - 1) * SLOT).hour === 23) midnights.push(k);
    const end = hour >= 13 ? midnights[1] : midnights[0];
    const out = [];
    for (let k = s; k < end && price.has(k); k++) out.push(k);
    return out;
};

function planner(foresight) {
    return (s, stored) => {
        const ks = horizon(s);
        const model = modelFor(s);
        const draws = foresight
            ? ks.map((k) => drawBySlot.get(k) ?? 0)
            : drawsFor(ks.map((k) => profileFor(model, dayType(k * SLOT))), ks.map((k) => clock(k * SLOT).hour),
                undefined, ks.map((k) => Math.floor((clock(k * SLOT).minute ?? 0) / 15)));
        const slots = ks.map((k, j) => ({price: price.get(k), draw: draws[j]}));
        const p = plan({slots, stored, charging: false, tank, charge: model.charge ?? charge, loss: model.loss, reserve, minC, maxC});
        return p.startNow ? p.charges[0].targetC : undefined;
    };
}

// The owner's setup as it ran: what it actually paid for the same days.
let actualCost = 0, actualEl = 0;
const used = new Map(points.map((p) => [slotOf(p.t - HOUR / 2), p.used]));
for (const day of days) for (let s = day; s < day + 96; s += 4) {
    const a = used.get(s), b = used.get(s + 4);
    if (a != null && b != null && b >= a) {
        const meanPrice = [0, 1, 2, 3].reduce((x, q) => x + price.get(s + q), 0) / 4;
        actualCost += (b - a) * meanPrice; actualEl += b - a;
    }
}

// The owner's Flow ("Hot water (v2)", doc §1), simulated on the same tank: on each hour while the
// top is under 52 °C, a 2 h boost to 60 °C in an allowed hour; at under 50 L a boost at once.
const hourPrice = (s) => [0, 1, 2, 3].reduce((x, q) => x + price.get(Math.floor(s / 4) * 4 + q), 0) / 4;
function flowAllows(s) {
    const {hour} = clock(s * SLOT);
    const free = dayType(s * SLOT) === 'free' || (!has('weekends-free') && (weekday(s * SLOT) === 0 || weekday(s * SLOT) === 6));
    const dayStart = s - (s - days[0]) % 96;
    const dayHours = [...Array(24).keys()].map((h) => ({h, p: hourPrice(dayStart + 4 * h)}));
    const nightFrom = free ? 22 : 21;
    const night = dayHours.filter((x) => x.h >= nightFrom || x.h < 6).sort((a, b) => a.p - b.p);
    if (night[0]?.h === hour) return true;
    const byPrice = [...dayHours].sort((a, b) => a.p - b.p);
    if (!free) return byPrice.slice(0, 3).some((x) => x.h === hour);
    return hour >= 6 && hour < 22 && !byPrice.slice(-3).some((x) => x.h === hour);
}
const flow = (s, stored) => {
    if (stored < 50 * 0.0349) return {target: 60, slots: 8};
    if (s % 4 === 0 && tempOf(tank, stored) < 52 && flowAllows(s)) return {target: 60, slots: 8};
    return undefined;
};

// Real charges in the record: runs of hours the heat counter moved at charging pace.
const realRuns = [];
{
    let run = 0;
    const hours = intervals(points).filter((i) => i.hours <= 1.01);
    for (const i of hours) {
        const ran = Math.min(1, i.produced / (truthModel.charge?.producedPerHour ?? 6));
        if (ran > 0.1) run += ran; else if (run) { realRuns.push(run); run = 0; }
    }
}
const realRunH = realRuns.filter((h) => h >= 0.5);
const rows = [
    ['Owner\'s setup, as it ran', {krDay: actualCost / days.length, elDay: actualEl / days.length,
        runH: realRunH.reduce((a, b) => a + b, 0) / realRunH.length}],
    ['Owner\'s Flow, simulated', simulate(flow)],
    ['Pump alone (start 42 °C, stop 50 °C)', simulate((s, stored) => tempOf(tank, stored) < 42 ? 50 : undefined)],
    ['Planner, learned profile', simulate(planner(false))],
    ['Planner, draws known ahead', simulate(planner(true))],
];
const r = (v, d = 2) => Number.isFinite(v) ? v.toFixed(d) : '–';
console.log(`${days.length} days, ${clock(days[0] * SLOT).date} to ${clock((days[days.length - 1] + 95) * SLOT).date};`
    + ` reserve ${r(reserve, 1)} kWh; day types: ${has('weekends-free') ? 'weekends free' : 'none'}`);
console.log('strategy'.padEnd(40) + 'kr/day  kr/month  kWh el/day  charges/day  mean target  slots below reserve  h/charge');
const base = rows[0][1].krDay;
for (const [name, x] of rows)
    console.log(name.padEnd(40) + r(x.krDay).padStart(6) + r(x.krDay * 30, 0).padStart(10) + r(x.elDay).padStart(12)
        + r(x.chargesDay, 1).padStart(13) + (Number.isFinite(x.meanTarget) ? r(x.meanTarget, 0) + ' °C' : '–').padStart(13)
        + String(x.below ?? '–').padStart(21) + r(x.runH, 1).padStart(10) + `   ${r((x.krDay / base - 1) * 100, 0)} %`);
