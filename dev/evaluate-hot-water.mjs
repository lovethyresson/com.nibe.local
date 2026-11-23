// Maintainer tool (not shipped: see .homeyignore). Back-test of hot water Autopilot on a real
// tank: the draws and prices that happened, replayed slot by slot through the code live runs
// (hotwater-shadow.ts `autopilotCharge`, `extendTarget`, `hotwaterShadowStep`; hotwater-lever.ts
// `leverDecision` with the day's start and stop-write caps). The planner sees only the past (its
// model is relearned each midnight from readings before it) and only the prices known at the time
// (today's, and tomorrow's from 13:00). Scored against what the owner's own setup paid, and per
// day as kr above hindsight: the same planner with the draws known in advance and no caps.
// Plan: tasks/hotwater-improvement-plan.md step 1.2.
//
//   node --import tsx dev/evaluate-hot-water.mjs --insights <dir> --prices <dir> [--day-types <file>]
//        [--tz Europe/Stockholm] [--reserve 40] [--max <°C>] [--large-stop 50] [--large-mode]
//        [--litres 175] [--inlet 10]
//        [--spread] [--no-extend] [--probe <local time>,<litres>,<top>[,today][,due]] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--formula "(x+0.609)*1.25"]
//
// <dir> for --insights is what `dev/learn-hot-water.mjs --save <dir>` writes. --prices holds one
// Homey Energy `fetch-dynamic-electricity-prices` answer per day (`YYYY-MM-DD.json`).
// --day-types: the app's day type setting as JSON (`{"log": [{"at": <ms>, "type": "working"}, …]}`);
// without it, or before its first entry, the calendar's weekend, as live (day-type.ts `dayTypeAt`).
// --large-stop: the Large stop (62) in force at the start. --large-mode: the owner's demand mode is
// Large, so 62 is never written (every charge runs to the stop that is set).
// --spread: each hour's draw spread over its four slots (the old back-test), instead of all of it in
// the hour's first slot. The draws are hourly, so the first slot is the honest worst case.
//
// Not modelled: the legionella run, heating's pre-heat slots, solar surplus, and the learned
// ceiling (--max stands in for it; MAX_C by default). The tank top is the mixed tank's temperature (`tempOf`): a
// stratified tank's top is hotter after a draw, so live may vouch against a rescue a little sooner.

import {readFileSync, readdirSync} from 'fs';
import {join} from 'path';
import {intervals, learn, localClock, profileFor} from '../lib/autopilot/hotwater-learner.ts';
import {pointsFromInsights, RESOLUTIONS} from '../lib/autopilot/hotwater-insights.ts';
import {chargeRate, copAt} from '../lib/autopilot/hotwater-learner.ts';
import {SLOT_H, drawsFor, heatAt, plan, reserveKwh, tempOf} from '../lib/autopilot/hotwater-planner.ts';
import {KWH_PER_LITRE} from '../lib/autopilot/hotwater-learner.ts';
import {MAX_C, autopilotCharge, extendTarget, hotwaterShadowStep} from '../lib/autopilot/hotwater-shadow.ts';
import {DEMAND_LARGE, MAX_STOP_WRITES_PER_DAY, countFor, leverDecision} from '../lib/autopilot/hotwater-lever.ts';
import {dayTypeAt} from '../lib/autopilot/day-type.ts';

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const has = (name) => argv.includes(`--${name}`);
const tz = flag('tz', 'Europe/Stockholm');
const clock = localClock(tz);
const formula = new Function('x', `return ${flag('formula', '(x+0.609)*1.25')};`);
const reserveLitres = Number(flag('reserve', 40));
const reserve = reserveKwh(reserveLitres);
const minC = 45, maxC = Number(flag('max', MAX_C));
const largeStart = Number(flag('large-stop', 50)), largeMode = has('large-mode');
const SLOT = 15 * 60_000, HOUR = 3_600_000;
const slotOf = (ms) => Math.floor(ms / SLOT);

// Readings.
const dir = flag('insights');
const logs = {};
for (const field of ['litres', 'produced', 'used', 'top'])
    logs[field] = RESOLUTIONS.map((r) => { try { return JSON.parse(readFileSync(join(dir, `${field}.${r}.json`), 'utf8')); } catch { return {}; } });
const weekday = (ms) => new Date(`${clock(ms).date}T12:00:00Z`).getUTCDay();
const dayTypes = flag('day-types') ? JSON.parse(readFileSync(flag('day-types'), 'utf8')) : undefined;
const dayType = (ms) => dayTypeAt(dayTypes, ms, clock);
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
for (const i of hourly) for (let q = 0; q < 4; q++) drawBySlot.set(slotOf(i.start) + q, has('spread') ? i.draw / 4 : q === 0 ? i.draw : 0);
// Local days (midnight to midnight, 96 slots: a clock-change day is left out), with draws and
// prices in every slot.
const first = Math.min(...drawBySlot.keys()), last = Math.max(...drawBySlot.keys());
const midnight = (k) => clock(k * SLOT).hour === 0 && clock(k * SLOT).minute === 0;
const days = [];
for (let s = first; s + 96 <= last; s++)
    if (midnight(s) && midnight(s + 96) && clock(s * SLOT).date >= flag('from', '') && clock(s * SLOT).date <= flag('to', '9999')
        && [...Array(96).keys()].every((q) => drawBySlot.has(s + q) && price.has(s + q))) days.push(s);
if (!days.length) { console.error('no full day with both draws and prices'); process.exit(1); }
const tank = {litres: Number(flag('litres', 175)), inletC: Number(flag('inlet', 10))};
const charge = truthModel.charge, loss = truthModel.loss;
/** The heat the tank read at the start of `day`: where a simulation starts, and starts again after
 *  a gap in the days (a day left out has no draws to carry the tank through). */
const storedAt = (day) => points.find((x) => x.t >= day * SLOT && x.litres > 0).litres * KWH_PER_LITRE;
/** Whether `day` follows a day left out (or is the first). */
const afterGap = (day, k) => k === 0 || days[k - 1] + 96 !== day;
/** One slot of a charge to `target`: the heat added and the electricity it took, at the rate and
 *  COP the tank itself showed. */
function chargeSlot(stored, target) {
    const full = chargeRate(charge, stored) * SLOT_H;
    const q = Math.max(0, Math.min(full, heatAt(tank, target) - stored));
    const e = charge.kw !== undefined ? charge.kw * SLOT_H * q / full : q / copAt(charge, tempOf(tank, stored + q));
    return {q, e};
}

/** One simulated pump: `decide(slot, stored)` returns a target °C to start a charge (or
 *  {target, slots} for a boost that also expires), or undefined. */
/** The three most expensive hours of the local day holding each day's slots. */
const dearHours = new Map(days.map((day) => {
    const hours = [...Array(24).keys()].map((h) => ({h, p: [0, 1, 2, 3].reduce((x, q) => x + price.get(day + 4 * h + q), 0)}));
    return [day, new Set(hours.sort((a, b) => b.p - a.p).slice(0, 3).map((x) => x.h))];
}));
function simulate(decide) {
    let stored, target, until, cost = 0, el = 0, charges = 0, below = 0, targets = 0, runSlots = 0, dearEl = 0;
    const perDay = new Map(days.map((d) => [d, {kr: 0, kwh: 0}]));
    for (const [k, day] of days.entries()) for (let s = day; s < day + 96; s++) {
        if (s === day && afterGap(day, k)) { stored = storedAt(day); target = undefined; }
        if (target === undefined) {
            const d = decide(s, stored);
            const t = typeof d === 'object' ? d.target : d;
            if (t !== undefined && heatAt(tank, t) > stored + 0.05) {
                target = t; until = typeof d === 'object' ? s + d.slots : Infinity; charges++; targets += t;
            }
        }
        if (target !== undefined) {
            const {q, e} = chargeSlot(stored, target);
            stored += q; el += e; cost += e * price.get(s); runSlots++;
            perDay.get(day).kr += e * price.get(s); perDay.get(day).kwh += e;
            if (dearHours.get(day).has(Math.floor((s - day) / 4))) dearEl += e;
            if (stored >= heatAt(tank, target) - 1e-6 || s + 1 >= until) target = undefined;
        }
        stored = Math.max(0, stored - drawBySlot.get(s) - (loss.base + loss.perKwh * stored) * SLOT_H);
        if (stored < reserve) below++;
    }
    const n = days.length;
    return {krDay: cost / n, elDay: el / n, chargesDay: charges / n, meanTarget: charges ? targets / charges : NaN, below,
        runH: charges ? runSlots * SLOT_H / charges : NaN, dear: el > 0 ? dearEl / el : NaN, perDay};
}

// Model relearned each local midnight from readings before it.
const models = new Map();
const modelFor = (s) => {
    const day = days.findLast((d) => d <= s);
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

/** Prices known at slot s, as live holds them (`ShadowStepInput.prices`). */
const knownAt = (s) => new Map(horizon(s).map((k) => [k, {price: price.get(k)}]));

/** The planner with the draws known in advance and no caps: the hindsight bound. */
function hindsight() {
    return (s, stored) => {
        const ks = horizon(s);
        const slots = ks.map((k) => ({price: price.get(k), draw: drawBySlot.get(k) ?? 0}));
        const p = plan({slots, stored, charging: false, tank, charge: modelFor(s).charge ?? charge, loss: modelFor(s).loss, reserve, minC, maxC});
        return p.startNow ? p.charges[0].targetC : undefined;
    };
}

/** Autopilot as live runs it, slot by slot: the start decision (`autopilotCharge`), the lever with
 *  the day's caps (`leverDecision`: 3 starts, 5 for a rescue, 3 stop writes, never 62 in Large
 *  mode), a running charge raised mid-charge (`extendTarget`), and the plan's next run passed on as
 *  due (`dueAt`). Physics as `simulate`. */
function simulateLive() {
    let stored, target, base, largeStopC = largeStart, count, dueAt, extended = false;
    let cost = 0, el = 0, charges = 0, targets = 0, below = 0, runSlots = 0, dearEl = 0, rescues = 0, refused = 0, stopWrites = 0, raises = 0, raisedE = 0, raisedKr = 0;
    const perDay = new Map(days.map((d) => [d, {kr: 0, kwh: 0}]));
    for (const [k, day] of days.entries()) for (let s = day; s < day + 96; s++) {
        if (s === day && afterGap(day, k)) { stored = storedAt(day); target = dueAt = undefined; }
        const at = s * SLOT, date = clock(at).date;
        count = countFor(count, date);
        const input = {slot: s, prices: knownAt(s), model: modelFor(s), tank, clock, dayType: dayType(at), dayTypeOf: dayType,
            reserveLitres, maxC, dueAt,
            now: {litres: stored / KWH_PER_LITRE, top: tempOf(tank, stored), powerW: target !== undefined ? 1000 : 0,
                more: target !== undefined, largeStopC: target ?? largeStopC}};
        if (target === undefined) {
            const e = autopilotCharge(input);
            if (!('skip' in e)) {
                const rescue = e.reason === 'reserve';
                const d = leverDecision(e.targetC, {top: input.now.top, largeStopC, demandMode: largeMode ? DEMAND_LARGE : undefined, allowed: true},
                    count, {rescue});
                if ('skip' in d) { if (d.skip === 'rescue limit') refused++; }
                else {
                    count = {...count, starts: count.starts + 1, stops: count.stops + (d.writeStop ? 1 : 0)};
                    if (d.writeStop) { largeStopC = d.targetC; stopWrites++; }
                    target = d.targetC; extended = false; charges++; targets += d.targetC; if (rescue) rescues++;
                }
            }
        } else if (!extended && !largeMode && !has('no-extend') && count.stops < MAX_STOP_WRITES_PER_DAY) {
            const e = extendTarget(input);
            if (e) { base = target; target = largeStopC = e.targetC; extended = true; raises++; count = {...count, stops: count.stops + 1}; stopWrites++; }
        }
        const step = hotwaterShadowStep(input);
        dueAt = 'entry' in step && step.entry.next ? Date.parse(step.entry.next.at) : undefined;
        let e = 0;
        if (target !== undefined) {
            const slot = chargeSlot(stored, target);
            // The heat above the target the charge started with, and its share of the slot's electricity.
            if (extended && slot.q > 0) {
                const above = Math.max(0, stored + slot.q - Math.max(stored, heatAt(tank, base))) / slot.q;
                raisedE += slot.e * above; raisedKr += slot.e * above * price.get(s);
            }
            e = slot.e; stored += slot.q; runSlots++;
            if (dearHours.get(day).has(Math.floor((s - day) / 4))) dearEl += e;
            if (stored >= heatAt(tank, target) - 1e-6) target = undefined;
        }
        el += e; cost += e * price.get(s);
        perDay.get(day).kr += e * price.get(s); perDay.get(day).kwh += e;
        stored = Math.max(0, stored - drawBySlot.get(s) - (loss.base + loss.perKwh * stored) * SLOT_H);
        if (stored < reserve) below++;
    }
    const n = days.length;
    return {krDay: cost / n, elDay: el / n, chargesDay: charges / n, meanTarget: charges ? targets / charges : NaN, below,
        runH: charges ? runSlots * SLOT_H / charges : NaN, dear: el > 0 ? dearEl / el : NaN,
        rescues, refused, stopWrites, raises, raisedE, raisedKr, perDay};
}

// The owner's setup as it ran: what it actually paid for the same days.
let actualCost = 0, actualEl = 0;
const actualDays = new Map(days.map((d) => [d, {kr: 0, kwh: 0}]));
const used = new Map(points.map((p) => [slotOf(p.t - HOUR / 2), p.used]));
for (const day of days) for (let s = day; s < day + 96; s += 4) {
    const a = used.get(s), b = used.get(s + 4);
    if (a != null && b != null && b >= a) {
        const meanPrice = [0, 1, 2, 3].reduce((x, q) => x + price.get(s + q), 0) / 4;
        actualCost += (b - a) * meanPrice; actualEl += b - a;
        actualDays.get(day).kr += (b - a) * meanPrice; actualDays.get(day).kwh += b - a;
    }
}

// The owner's Flow ("Hot water (v2)", doc §1), simulated on the same tank: on each hour while the
// top is under 52 °C, a 2 h boost to 60 °C in an allowed hour; at under 50 L a boost at once.
const hourPrice = (s) => [0, 1, 2, 3].reduce((x, q) => x + price.get(Math.floor(s / 4) * 4 + q), 0) / 4;
function flowAllows(s) {
    const {hour} = clock(s * SLOT);
    const free = dayType(s * SLOT) !== 'working';
    const dayStart = days.findLast((d) => d <= s);
    const dayHours = [...Array(24).keys()].map((h) => ({h, p: hourPrice(dayStart + 4 * h)}));
    const nightFrom = free ? 22 : 21;
    const night = dayHours.filter((x) => x.h >= nightFrom || x.h < 6).sort((a, b) => a.p - b.p);
    if (night[0]?.h === hour) return true;
    const byPrice = [...dayHours].sort((a, b) => a.p - b.p);
    if (!free) return byPrice.slice(0, 3).some((x) => x.h === hour);
    return hour >= 6 && hour < 22 && !byPrice.slice(-3).some((x) => x.h === hour);
}
const flow = (s, stored) => {
    if (stored < 50 * KWH_PER_LITRE) return {target: 60, slots: 8};
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
// --probe "YYYY-MM-DDTHH:MM,<litres>,<top °C>": one slot's decision from a tank state read off the
// live log, with the model and prices known then (plan step 4.1). A fifth field `today` holds back
// tomorrow's prices (live got them at 13:30 on some days, not 13:00); `due` says the slot before
// planned a charge for this one (live's `dueAt`), which lets a charge pushed a little later start now.
// The lever is asked as on the day's first start (no caps used). Prints and exits.
if (flag('probe')) {
    const [when, litres, top, ...opts] = flag('probe').split(',');
    const todayOnly = opts.includes('today'), due = opts.includes('due');
    const s = days.find((d) => clock(d * SLOT).date === when.slice(0, 10));
    if (s === undefined) { console.error(`no replayed day ${when.slice(0, 10)}`); process.exit(1); }
    const [h, m] = when.slice(11).split(':').map(Number), slot = s + h * 4 + m / 15;
    if (!Number.isInteger(slot)) { console.error(`${when} is not on a quarter hour`); process.exit(1); }
    const prices = new Map([...knownAt(slot)].filter(([k]) => !todayOnly || k < s + 96));
    const input = {slot, prices, model: modelFor(slot), tank, clock, dayType: dayType(slot * SLOT), dayTypeOf: dayType,
        reserveLitres, maxC, dueAt: due ? slot * SLOT : undefined, now: {litres: Number(litres), top: Number(top), powerW: 0, more: false, largeStopC: largeStart}};
    const step = hotwaterShadowStep(input);
    console.log('model charge:', JSON.stringify(input.model.charge));
    console.log(`at ${when}: rate near this fill ${chargeRate(input.model.charge, Number(litres) * KWH_PER_LITRE).toFixed(2)} kWh/h,`
        + ` COP at ${top} °C ${copAt(input.model.charge, Number(top)).toFixed(2)}`);
    const start = autopilotCharge(input);
    console.log('start:', JSON.stringify(start));
    if (!('skip' in start)) console.log('lever:', JSON.stringify(leverDecision(start.targetC,
        {top: Number(top), largeStopC: largeStart, demandMode: largeMode ? DEMAND_LARGE : undefined, allowed: true},
        countFor(undefined, when.slice(0, 10)), {rescue: start.reason === 'reserve'})));
    console.log('step:', JSON.stringify('entry' in step ? {...step.entry, coast: undefined} : step));
    process.exit(0);
}

const live = simulateLive();
const hind = simulate(hindsight());
const rows = [
    ['Owner\'s setup, as it ran', {krDay: actualCost / days.length, elDay: actualEl / days.length,
        runH: realRunH.reduce((a, b) => a + b, 0) / realRunH.length}],
    ['Owner\'s Flow, simulated', simulate(flow)],
    ['Pump alone (start 42 °C, stop 50 °C)', simulate((s, stored) => tempOf(tank, stored) < 42 ? 50 : undefined)],
    ['Autopilot, as live runs it', live],
    ['Hindsight (draws known, no caps)', hind],
];
const r = (v, d = 2) => Number.isFinite(v) ? v.toFixed(d) : '–';
console.log(`${days.length} days, ${clock(days[0] * SLOT).date} to ${clock((days[days.length - 1] + 95) * SLOT).date};`
    + ` reserve ${reserveLitres} L; day types: ${dayTypes ? 'from the file' : 'the calendar\'s weekend'};`
    + ` draws: ${has('spread') ? 'spread over the hour' : 'in the hour\'s first slot'}; Large stop ${largeStart} °C${largeMode ? ', Large mode' : ''}`);
console.log('strategy'.padEnd(40) + 'kr/day  kr/month  kWh el/day  charges/day  mean target  slots below reserve  h/charge  in 3 dearest h');
const base = rows[0][1].krDay;
for (const [name, x] of rows)
    console.log(name.padEnd(40) + r(x.krDay).padStart(6) + r(x.krDay * 30, 0).padStart(10) + r(x.elDay).padStart(12)
        + r(x.chargesDay, 1).padStart(13) + (Number.isFinite(x.meanTarget) ? r(x.meanTarget, 0) + ' °C' : '–').padStart(13)
        + String(x.below ?? '–').padStart(21) + r(x.runH, 1).padStart(10)
        + (Number.isFinite(x.dear) ? `${r(x.dear * 100, 0)} %` : '–').padStart(16) + `   ${r((x.krDay / base - 1) * 100, 0)} %`);
console.log(`\nAutopilot: ${live.rescues} rescues, ${live.refused} refused by the day's cap, ${live.stopWrites} Large stop writes; `
    + `${live.raises} running charges raised, ${r(live.raisedE)} kWh at ${r(live.raisedKr)} kr above their first target.`);
// Per day: kr, and the price index (paid per kWh over the day's mean price), so days and
// strategies compare on timing as well as on kWh.
const meanOf = (day) => [...Array(96).keys()].reduce((x, q) => x + price.get(day + q), 0) / 96;
const cell = (x, day) => `${r(x.kr).padStart(6)} kr ${r(x.kwh, 1).padStart(5)} kWh ${x.kwh > 0.1 ? r(x.kr / x.kwh / meanOf(day)).padStart(5) : '    –'}`;
console.log('\nPer day: kr, kWh and price index (1.00 = the day\'s mean price)');
console.log('date       type      ' + 'as it ran'.padEnd(25) + 'Autopilot (replay)'.padEnd(25) + 'hindsight'.padEnd(25) + 'replay above hindsight');
for (const day of days) {
    const date = clock(day * SLOT).date, l = live.perDay.get(day), h = hind.perDay.get(day);
    console.log(`${date} ${dayType(day * SLOT + 12 * HOUR).padEnd(9)} ${cell(actualDays.get(day), day)}  ${cell(l, day)}  ${cell(h, day)}  ${r(l.kr - h.kr).padStart(6)} kr`);
}
const index = (map) => { let kr = 0, ref = 0; for (const day of days) { const x = map.get(day); kr += x.kr; ref += x.kwh * meanOf(day); } return kr / ref; };
console.log(`Price index over all days: as it ran ${r(index(actualDays))}, Autopilot (replay) ${r(index(live.perDay))}, hindsight ${r(index(hind.perDay))}.`);
