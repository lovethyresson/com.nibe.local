// Maintainer tool (not shipped: see .homeyignore). Scores a comfort range trial: a week on each of
// Autopilot heating's comfort ranges, compared day by day. Reads only.
//
// Per local day, from the Autopilot history file (lib/autopilot/history.ts) and the house model
// saved beside it:
//   - saved: what the day would have cost with the BT1 offsets Autopilot fed held at their average
//     (the app's "before Autopilot" cost, lib/autopilot/shift-cost.ts `shiftEffect`), minus what it cost. Weather
//     and prices are the same on both sides, so weeks with different weather can be compared.
//   - cost: heating electricity at each slot's price, the hot water share of a slot left out.
//   - spread: the day's most expensive hour minus its cheapest, to even out flat and spiky weeks.
//   - indoor, thermostat and BT1 offset (fed − real outdoor; 0 in slots nobody fed) per slot.
// The first two days of each week are drawn but not scored, while the house adjusts.
//
//   node --import tsx dev/comfort-trial.mjs <history .bin url or file>
//        --week comfortable=2026-11-30 --week save_some=2026-12-07 --week save_most=2026-12-14
//        [--tz Europe/Stockholm] [--html <out.html>] [--json <out.json>]
//
// The history URL is in the app log at start and in the app setting `autopilotHistoryFile.<device id>`
// (dev/read-autopilot-history.mjs). The model is read from the same name with `.model.json`.
// --html fills dev/comfort-trial.html with the weeks; opened as it is, that page shows mock weeks.
// A week is 7 local days of 96 slots from the given date's midnight (a clock change day is not
// handled: run the trial clear of one).
import fs from 'node:fs';
import {FLAG, History, applyJournal} from '../lib/autopilot/history.ts';
import {electricityPerSlot} from '../lib/autopilot/heat.ts';
import {SLOT_MS} from '../lib/autopilot/prices.ts';
import {SHIFT_MISSING, shiftEffect} from '../lib/autopilot/shift-cost.ts';
import {PROFILE_LIMITS} from '../lib/autopilot/live.ts';

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const all = (name) => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []));
const source = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const weeks = all('week').map((w) => { const [key, date] = w.split('='); return {key, date}; });
if (!source || !weeks.length || weeks.some((w) => !PROFILE_LIMITS[w.key] || !/^\d{4}-\d{2}-\d{2}$/.test(w.date ?? ''))) {
    console.error('usage: node --import tsx dev/comfort-trial.mjs <history .bin> --week <comfortable|save_some|save_most>=YYYY-MM-DD … '
        + '[--tz <zone>] [--html <out>] [--json <out>]');
    process.exit(1);
}
const timeZone = flag('tz', 'Europe/Stockholm');
const DAYS = 7, SLOTS = 96, HOUR = 3_600_000;

const read = async (path) => (/^https?:/.test(path)
    ? fetch(path).then(async (r) => (r.ok ? Buffer.from(await r.arrayBuffer()) : undefined))
    : fs.promises.readFile(path).catch(() => undefined));
const file = await read(source);
const history = file && History.deserialize(file);
if (!history) { console.error(`Could not read a history file from ${source}.`); process.exit(1); }
const journal = await read(`${source}.journal`);
if (journal?.length) applyJournal(history, journal, History.fieldCount(file));
const modelRaw = await read(source.replace(/\.bin$/, '.model.json'));
const fit = modelRaw ? JSON.parse(modelRaw.toString('utf8')).fit : undefined;
if (!fit?.params) console.warn('No house model beside the history: savings are left at 0.');
// The pump's response as the collector builds it (collector.ts `shiftEffect`).
const pump = fit?.pump?.supply && fit.pump.heatPerSupplyK > 0
    ? {supply: fit.pump.supply, heatPerSupplyK: fit.pump.heatPerSupplyK, shiftOnly: true, ...(fit.pump.cop ? {cop: fit.pump.cop} : {})}
    : fit?.lever > 0 ? {lever: fit.lever} : {};

// Local midnight of `date` in the trial's time zone, as UTC ms.
const parts = new Intl.DateTimeFormat('en-GB', {timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'});
const localAsUtc = (ms) => {
    const p = Object.fromEntries(parts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
};
const midnight = (date) => {
    const target = Date.parse(`${date}T00:00:00Z`);
    let t = target;
    for (let k = 0; k < 3; k++) t = target - (localAsUtc(t) - t);
    return t;
};

const range = history.range();
const rows = range.map((slot) => ({slot, ...history.get(slot)}));
const electricity = electricityPerSlot(rows.map((r) => ({slot: r.slot, emeter: r.emeter, pw: r.pw})));
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, d) => (fin(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** One local day: the model's saving and the day's facts. */
function scoreDay(first) {
    const slots = [], shift = [];
    let missing = 0, cost = 0, read = 0, broken = false;
    const hourPrices = new Map();
    for (let k = 0; k < SLOTS; k++) {
        const slot = first + k, v = history.get(slot);
        const fed = !!v && (v.flags & FLAG.fedOutdoor) !== 0;
        slots.push({
            indoor: v && fin(v.ti) ? v.ti : NaN, setpoint: v && fin(v.tset) ? v.tset : NaN, price: v && fin(v.price) ? v.price : NaN,
            offset: v && fed && fin(v.bt1) && fin(v.te) ? v.bt1 - v.te : v ? 0 : NaN,
        });
        if (v) read++;
        if (v && fin(v.price)) {
            const kwh = electricity.get(slot);
            if (fin(kwh)) cost += kwh * (1 - (fin(v.dhw) ? v.dhw : 0)) * v.price;
            const hour = Math.floor(slot * SLOT_MS / HOUR) * HOUR;
            hourPrices.set(hour, [...(hourPrices.get(hour) ?? []), v.price]);
        }
        // The shift's inputs, gaps filled as the collector fills them.
        if (v && fin(v.te) && fin(v.bt1)) shift.push({slot, te: v.te, bt1: v.bt1, ti: v.ti, busy: v.dhw >= 0.5, fed});
        else if (shift.length && ++missing <= SHIFT_MISSING) shift.push({...shift[shift.length - 1], slot, ti: NaN, fed});
        else broken = true;
    }
    const prices = new Map([...hourPrices].map(([h, ps]) => [h, mean(ps)]));
    const hourly = [...prices.values()];
    let saved = 0;
    const effect = fit?.params && !broken && shift.length === SLOTS ? shiftEffect(fit.params, pump, shift) : undefined;
    if (effect) {
        // Before Autopilot minus paid: the electricity the shift added, at its hour's price, given back, and
        // the heat the day left in the house beyond the steady one, at the day's average price.
        for (const [hour, extra] of effect.hours) saved -= extra * (prices.get(hour) ?? mean(hourly));
        saved += effect.carry * mean(hourly);
    }
    return {
        slots, data: read >= SLOTS * 0.75 && hourly.length >= 20, modelled: !!effect,
        saved, cost, spread: hourly.length ? Math.max(...hourly) - Math.min(...hourly) : 0,
    };
}

const out = weeks.map(({key, date}) => {
    const limits = PROFILE_LIMITS[key];
    const week = {key, band: limits.lower, maxOff: Math.max(limits.maxBias, limits.maxCoastBias), start: Date.parse(`${date}T00:00:00Z`),
        indoor: [], offset: [], price: [], setpoint: [], days: []};
    for (let d = 0; d < DAYS; d++) {
        const day = new Date(Date.parse(`${date}T12:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
        const first = Math.round(midnight(day) / SLOT_MS);
        const s = scoreDay(first);
        for (const x of s.slots) {
            week.indoor.push(round(x.indoor, 2)); week.offset.push(round(x.offset, 2));
            week.price.push(round(x.price, 3)); week.setpoint.push(round(x.setpoint, 1));
        }
        week.days.push({at: Date.parse(`${day}T00:00:00Z`), date: day, saved: round(s.saved, 3), cost: round(s.cost, 3),
            spread: round(s.spread, 3), data: s.data, modelled: s.modelled});
    }
    return week;
});

const setpoints = out.flatMap((w) => w.setpoint).filter(fin).sort((a, b) => a - b);
const setpoint = setpoints.length ? setpoints[Math.floor(setpoints.length / 2)] : 22.5;

// The console view: one row per day.
const pad = (s, n) => String(s).padStart(n);
console.log(`Thermostat ${setpoint} °C (median). Model: ${fit?.params ? 'yes' : 'none'}.`);
console.log(`${'day'.padEnd(11)} ${'range'.padEnd(12)} ${pad('saved', 7)} ${pad('cost', 7)} ${pad('spread', 7)} ${pad('pre K·h', 8)} ${pad('ease K·h', 9)} ${pad('indoor', 12)}  note`);
for (const w of out) {
    w.days.forEach((d, k) => {
        const off = w.offset.slice(k * SLOTS, (k + 1) * SLOTS).filter(fin), ins = w.indoor.slice(k * SLOTS, (k + 1) * SLOTS).filter(fin);
        const pre = off.reduce((a, v) => a + Math.max(0, -v) * 0.25, 0), ease = off.reduce((a, v) => a + Math.max(0, v) * 0.25, 0);
        const note = !d.data ? 'too few slots' : k < 2 ? 'settling in' : !d.modelled ? 'no model run' : '';
        console.log(`${d.date} ${w.key.padEnd(12)} ${pad((d.saved ?? 0).toFixed(2), 7)} ${pad((d.cost ?? 0).toFixed(2), 7)} ${pad((d.spread ?? 0).toFixed(2), 7)} `
            + `${pad(pre.toFixed(0), 8)} ${pad(ease.toFixed(0), 9)} ${pad(ins.length ? `${Math.min(...ins).toFixed(1)}–${Math.max(...ins).toFixed(1)}` : '-', 12)}  ${note}`);
    });
}

const data = {generated: new Date().toISOString().slice(0, 10), setpoint, weeks: out};
const jsonOut = flag('json');
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(data));
const htmlOut = flag('html');
if (htmlOut) {
    const page = fs.readFileSync(new URL('./comfort-trial.html', import.meta.url), 'utf8');
    if (!page.includes('/*TRIAL*/null')) { console.error('dev/comfort-trial.html has no /*TRIAL*/null to fill.'); process.exit(1); }
    fs.writeFileSync(htmlOut, page.replace('/*TRIAL*/null', JSON.stringify(data).replace(/</g, '\\u003c')));
    console.log(`Wrote ${htmlOut}.`);
}
