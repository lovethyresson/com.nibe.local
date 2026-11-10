// Scores the hot water test run (lib/autopilot/hotwater-shadow.ts) against the go-live check in
// docs/autopilot-hot-water.md §6: the litres it predicts at the usage peaks within ±50 L on at
// least 80 % of days. Reads only.
//
// Each log line carries `coast`: the litres predicted 1…12 h ahead if nothing charges. In a test
// run the pump's own charges are what happen, so only a stretch with no real charge between the
// prediction and its hour is scored. Peaks are the hours of the model's pooled profile drawing at
// least 70 % of its busiest hour, joined into windows; each window is scored at its end, from the
// prediction made LEAD hours before.
//   node dev/review-hotwater-shadow.mjs http://<homey-ip>/app/com.nibe.local/userdata/autopilot-….shadow.jsonl
//   node dev/review-hotwater-shadow.mjs ./autopilot-….shadow.jsonl [--lead 3] [--tz Europe/Stockholm]
// The model file is read from beside the log (…model.json).
import fs from 'node:fs';

const source = process.argv[2];
if (!source) {
    console.error('usage: node dev/review-hotwater-shadow.mjs <url or file of autopilot-….shadow.jsonl> [--lead <h>] [--tz <zone>]');
    process.exit(1);
}
const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : fallback;
};
const LEAD = Number(arg('--lead', 3));
const timeZone = arg('--tz', 'Europe/Stockholm');
const TOLERANCE_L = 50, PASS_SHARE = 0.8, SLOT_MS = 15 * 60_000, HOUR_MS = 3_600_000;
const read = async (s) => (/^https?:/.test(s) ? (await fetch(s)).text() : fs.readFileSync(s, 'utf8'));

const entries = (await read(source)).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
if (!entries.length) {
    console.log('The test run log is empty: no slot has been planned yet.');
    process.exit(0);
}
const model = JSON.parse(await read(source.replace(/\.shadow\.jsonl$/, '.model.json'))).model;
const bySlot = new Map(entries.map((e) => [e.slot, e]));
const parts = new Intl.DateTimeFormat('sv-SE', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'});
const local = (ms) => {
    const p = Object.fromEntries(parts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return {date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour)};
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const rms = (xs) => Math.sqrt(mean(xs.map((x) => x * x)));
const f = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '-');

/** Predicted minus read litres, `lead` h after line `e`, or undefined when it cannot be scored. */
function error(e, lead) {
    const predicted = e.coast?.[lead - 1];
    const target = e.slot + lead * 4;
    if (!Number.isFinite(predicted) || !bySlot.has(target)) return undefined;
    for (let s = e.slot; s <= target; s++) {
        const x = bySlot.get(s);
        if (!x || x.charging) return undefined;
    }
    return predicted - bySlot.get(target).litres;
}

const withCoast = entries.filter((e) => e.coast);
console.log(`${entries.length} slots logged, ${withCoast.length} with a prediction.`);
console.log('If nothing charges, predicted vs read litres (stretches with no real charge only):');
for (const lead of [1, 2, 3, 6, 12]) {
    const errs = withCoast.map((e) => error(e, lead)).filter(Number.isFinite);
    console.log(`  ${String(lead).padStart(2)} h ahead: ${f(rms(errs))} L RMS, bias ${f(mean(errs))} L, n ${errs.length}`);
}

const profile = model.profiles.any;
const busiest = Math.max(...profile.hours);
const peakHours = profile.hours.map((v, h) => (v >= 0.7 * busiest ? h : -1)).filter((h) => h >= 0);
const windows = [];
for (const h of peakHours) {
    const last = windows.at(-1);
    if (last && last.end === h) last.end = h + 1;
    else windows.push({start: h, end: h + 1});
}
console.log(`Peaks: ${windows.map((w) => `${w.start}–${w.end}`).join(', ')} local; scored at each window's end from ${LEAD} h before.`);

const days = new Map();
for (const e of withCoast) {
    const at = e.slot * SLOT_MS + LEAD * HOUR_MS;
    const {date, hour} = local(at);
    if (new Date(at).getUTCMinutes() !== 0 || !windows.some((w) => w.end % 24 === hour)) continue;
    const err = error(e, LEAD);
    const day = days.get(date) ?? days.set(date, []).get(date);
    day.push({hour, err});
}
let scored = 0, passed = 0;
for (const [date, rows] of days) {
    const ok = rows.filter((r) => Number.isFinite(r.err));
    const pass = ok.length > 0 && ok.every((r) => Math.abs(r.err) <= TOLERANCE_L);
    if (ok.length) { scored++; if (pass) passed++; }
    console.log(`  ${date}: ${rows.map((r) => `${String(r.hour).padStart(2, '0')}:00 ${Number.isFinite(r.err) ? `${r.err > 0 ? '+' : ''}${f(r.err)} L` : 'not scored (a charge ran)'}`).join(', ')}`
        + (ok.length ? (pass ? '  pass' : '  FAIL') : ''));
}
const share = scored ? passed / scored : NaN;
console.log(`Days within ±${TOLERANCE_L} L: ${passed} of ${scored} scored (${f(share * 100)} %); the check asks ${PASS_SHARE * 100} % over 14 days.`);
