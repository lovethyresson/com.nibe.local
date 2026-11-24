// Which heat loss predicts tomorrow's metered heat best (heat-check.ts)? For each complete day, fits the
// house as the app does on the history before the day ends (lib/autopilot/house.ts), takes the day's heat
// balance (`daySums`: degree hours, free heat, heat stored) and predicts its heat with a heat loss chosen from
// the days before it:
//   fitted: the fitted heat loss
//   swap3:  the meter's over the 3 days before, only when they disagree with the fit by more than 5 % (today)
//   meter3: the meter's over the 3 days before, always
//   meter7: the meter's over the 7 days before, always
// The miss is predicted over metered heat, minus 1: what Plan vs actual would be off by. Reads only.
//
//   node --import tsx dev/energy-window.mjs <url or file> [--from 2026-11-12]
import fs from 'node:fs';
import {History, applyJournal} from '../lib/autopilot/history.ts';
import {fitHouse, modelSlotsFromHistory, pumpFromHistory} from '../lib/autopilot/house.ts';
import {fitSeries} from '../lib/autopilot/model.ts';
import {CHECK_TOLERANCE, MIN_DEGREE_HOURS, PLAUSIBLE, daySums} from '../lib/autopilot/heat-check.ts';

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

const DAY = 96;
const all = modelSlotsFromHistory(history);
const pump = pumpFromHistory(history);
const first = Math.floor(Date.parse(`${option('from', '2026-11-12')}T00:00Z`) / 900_000 / DAY);
const last = Math.floor(all.at(-1).slot / DAY) - 1;
const miss = {fitted: [], swap3: [], meter3: [], meter7: []};
const pct = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} %` : '-').padStart(8);
console.log('day (UTC)    metered  fitted W/K   fitted   swap3   meter3   meter7');
for (let day = first; day <= last; day++) {
    // The fit sees only the days before: it predicts the day the way a morning plan does. The filter's
    // states run through the day, for the heat it stored.
    const train = all.filter((s) => s.slot < (day + 1) * DAY);
    const fit = fitHouse(all.filter((s) => s.slot < day * DAY), {system: 'unknown', era: 'unknown'}, pump.lever, pump);
    if (!fit.params) continue;
    const p = {...fit.params, heatLoss: fit.fittedHeatLoss ?? fit.params.heatLoss};
    const states = fitSeries(train, 'unknown', 'unknown', {warmupSlots: Math.min(3 * DAY, train.length)}).states;
    const sums = (d) => daySums(p, d, train.filter((s) => Math.floor(s.slot / DAY) === d), states);
    const today = sums(day);
    if (!today) continue;
    const before = (n) => Array.from({length: n}, (_, k) => sums(day - 1 - k)).filter(Boolean);
    // The heat loss that balances the meter over those days, as heat-check.ts, or undefined.
    const meter = (ds, n) => {
        if (ds.length < n) return undefined;
        const t = (k) => ds.reduce((a, d) => a + d[k], 0);
        if (t('degreeHours') < MIN_DEGREE_HOURS * n / 3) return undefined;
        const h = (t('metered') + t('free') - t('stored')) / t('degreeHours');
        return h >= PLAUSIBLE[0] * p.heatLoss && h <= PLAUSIBLE[1] * p.heatLoss ? h : undefined;
    };
    const b3 = before(3), b7 = before(7);
    const m3 = meter(b3, 3), m7 = meter(b7, 7);
    const modelled3 = b3.length === 3 ? b3.reduce((a, d) => a + p.heatLoss * d.degreeHours - d.free + d.stored, 0) : undefined;
    const ratio3 = modelled3 > 0 ? b3.reduce((a, d) => a + d.metered, 0) / modelled3 : undefined;
    const losses = {
        fitted: p.heatLoss,
        swap3: m3 !== undefined && ratio3 !== undefined && Math.abs(ratio3 - 1) > CHECK_TOLERANCE ? m3 : p.heatLoss,
        meter3: m3 ?? p.heatLoss,
        meter7: m7 ?? m3 ?? p.heatLoss,
    };
    const row = {};
    for (const [name, h] of Object.entries(losses)) {
        row[name] = (h * today.degreeHours - today.free + today.stored) / today.metered - 1;
        miss[name].push(row[name]);
    }
    console.log(new Date(day * DAY * 900_000).toISOString().slice(0, 10), today.metered.toFixed(1).padStart(9),
        (p.heatLoss * 1000).toFixed(0).padStart(11), ...Object.keys(losses).map((k) => pct(row[k])));
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
console.log('mean |miss|  ', ...Object.keys(miss).map((k) => pct(mean(miss[k].map(Math.abs))).padStart(8)));
console.log('mean miss    ', ...Object.keys(miss).map((k) => pct(mean(miss[k])).padStart(8)));
