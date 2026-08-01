// Maintainer tool (not shipped — see .homeyignore). Turns a `homey app run` log into the one
// answer that decides whether per-function energy can move off the allocator and onto the
// pump's own books: **hour by hour, does the pump's per-function split add up to the pump's own
// total?**
//
// Why it matters. The allocator estimates — instantaneous power × elapsed time, attributed by
// operating priority. Measured against myUplink on a live S1155 over 24 h, the pump's own
// counter moved 1.00 kWh for the whole unit while the allocator credited hot water alone with
// 1.37 kWh. Register-sourced figures match myUplink to the kilowatt-hour; derived ones cannot.
// So the plan is to read what the pump itself booked (registers 2283-2303, one value per
// completed hour) — but only if those figures reconcile with the pump's own totals.
//
// This script answers that from a log alone. It reads the self-contained hourly lines the app
// emits under debug logging:
//
//   Energy log — the pump's own figures for the hour ending 09:00 UTC: heating used=0.01,
//   hot water used=0.13 kWh | same hour from the lifetime counters: used 0.14, produced 0.52 kWh
//
//   node dev/analyse-energylog.mjs /tmp/nibe.log
//
// Read the output as: if `used Δ%` sits within a few percent hour after hour, the pump's split
// is trustworthy and step 2 can proceed. A large or one-sided error means it cannot, and the
// allocator stays.

import {readFileSync} from 'fs';

const path = process.argv[2] ?? '/tmp/nibe.log';
let text;
try {
    text = readFileSync(path, 'utf8');
} catch {
    console.error(`Cannot read ${path}. Usage: node dev/analyse-energylog.mjs <logfile>`);
    process.exit(1);
}

// Matches both log formats: the original single line carrying same-hour counters, and the
// current pair (split line + a separate reconciliation line comparing one step back).
const HOUR_LINE = /hour ending (\d{2}):00 UTC: (.+?)(?: kWh \| same hour from the lifetime counters: used ([-\d.?]+), produced ([-\d.?]+)| kWh\s*$)/;
const RECON_LINE = /Energy log reconciliation — the (\d{2}):00 hour: split used ([\d.]+) vs counter ([\d.]+).*?produced ([\d.]+) vs ([\d.]+)/;
const PRIORITY = /Priority change: raw=(\S+) -> role=(\w+)/;
const RECONCILE = /Energy reconciliation after ([\d.]+) h — pump\(\d+\)=([\d.]+) kWh \| trapezoid=([\d.]+) \(([-\d.]+)%\)/;

const hours = [];
const priorities = [];
let reconcile = null;
let baseline = false;

for (const line of text.split('\n')) {
    if (line.includes('Energy log baseline recorded'))
        baseline = true;

    const p = PRIORITY.exec(line);
    if (p) priorities.push(p[2]);

    const r = RECONCILE.exec(line);
    if (r) reconcile = {hours: +r[1], pump: +r[2], trapezoid: +r[3], drift: +r[4]};

    // The app now emits the reconciliation itself, already aligned. Prefer it when present.
    const rc = RECON_LINE.exec(line);
    if (rc) {
        const row = hours.find((h) => h.hour === rc[1]);
        if (row) { row.usedTotal = Number(rc[3]); row.producedTotal = Number(rc[5]); row.preAligned = true; }
        continue;
    }

    const m = HOUR_LINE.exec(line);
    if (!m) continue;
    // "heating used=0.01, hot water used=0.13" -> per-label values. Anything labelled
    // "add.heat …" is electricity used by the additional heater, so it belongs on the used side.
    const parts = {};
    for (const chunk of m[2].split(',')) {
        const [label, value] = chunk.split('=');
        if (value === undefined) continue;
        parts[label.trim()] = Number(value);
    }
    const sum = (pick) => Object.entries(parts)
        .filter(([label]) => pick(label))
        .reduce((acc, [, v]) => acc + v, 0);
    hours.push({
        hour: m[1],
        parts,
        usedSplit: sum((l) => l.includes('used') || l.startsWith('add.heat')),
        producedSplit: sum((l) => l.includes('produced')),
        usedTotal: !m[3] || m[3] === '?' ? null : Number(m[3]),
        producedTotal: !m[4] || m[4] === '?' ? null : Number(m[4])
    });
}

if (!hours.length) {
    console.log('No hourly energy-log lines found.\n');
    console.log(baseline
        ? 'A baseline WAS recorded, so the block is being read — the run just has not crossed a\n'
          + ':00 boundary yet since it started. The first reading describes an hour nobody\n'
          + 'watched, so it is deliberately not reported. Leave it running past the next hour.'
        : 'No baseline line either, which means the energy-log registers never answered on this\n'
          + 'pump — the block may be absent, or Debug logging was off. Check the register dump\n'
          + 'for 2283-2303 reading "no answer".');
    process.exit(0);
}

// The pump's lifetime counters LAG its own energy log by about an hour. Measured on a live
// S1155: the log booked 1.44 kWh of hot water at 11:00 while 3823 had not moved at all, then
// 3823 gained 1.40 over the following hour. Compared same-hour that reads 1.44 vs 0.00 and
// looks catastrophic; compared one step apart it reads 1.44 vs 1.40, which is the counter's
// 0.1 kWh quantisation. So try both alignments and report whichever actually fits, rather than
// assuming — the assumption is what made the first version of this script wrong.
function align(hours, lag) {
    const out = [];
    for (let i = 0; i + lag < hours.length; ++i)
        out.push({
            hour: hours[i].hour,
            usedSplit: hours[i].usedSplit, producedSplit: hours[i].producedSplit,
            usedTotal: hours[i + lag].usedTotal, producedTotal: hours[i + lag].producedTotal,
            parts: hours[i].parts
        });
    return out;
}

const pct = (a, b) => (b === null || b === 0 ? null : ((a - b) / b) * 100);
const fmt = (v, w = 6) => (v === null ? '—' : v.toFixed(2)).padStart(w);
const fmtPct = (v) => (v === null ? '     —' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`.padStart(6));

console.log(`\n${'='.repeat(78)}`);
console.log(`Energy-log reconciliation — ${hours.length} completed hour(s) from ${path}`);
if (priorities.length)
    console.log(`Functions seen running: ${[...new Set(priorities)].join(', ')}`);
console.log('='.repeat(78));
// Pick the alignment that fits the busy hours, where the comparison is actually meaningful.
const busyErr = (rows) => {
    const busy = rows.filter((r) => (r.usedTotal ?? 0) >= 0.5 || (r.usedSplit ?? 0) >= 0.5);
    if (!busy.length) return null;
    const errs = busy.map((r) => pct(r.usedSplit, r.usedTotal)).filter((x) => x !== null);
    return errs.length ? errs.reduce((a, b) => a + Math.abs(b), 0) / errs.length : null;
};
// If the app already aligned them, trust that and do not shift again.
const preAligned = hours.some((h) => h.preAligned);
const sameHour = align(hours, 0);
const lagged = align(hours, 1);
const eSame = busyErr(sameHour);
const eLag = busyErr(lagged);
const useLag = !preAligned && eLag !== null && (eSame === null || eLag < eSame);
const rows = useLag ? lagged : sameHour;
console.log(useLag
    ? `\nAlignment: counters lag the log by one hour (same-hour fit ${eSame === null ? 'n/a' : eSame.toFixed(0) + '%'}, `
      + `lagged fit ${eLag.toFixed(1)}%). Each split is compared with the counter movement reported one step later.`
    : `\nAlignment: same hour${eSame === null ? '' : ` (fit ${eSame.toFixed(1)}%)`}.`);
console.log('\n  hour   used(split) used(pump)   Δ%     prod(split) prod(pump)   Δ%   breakdown');
console.log('  ' + '-'.repeat(74));

const errs = {used: [], produced: []};
for (const h of rows) {
    const du = pct(h.usedSplit, h.usedTotal);
    const dp = pct(h.producedSplit, h.producedTotal);
    if (du !== null) errs.used.push(du);
    if (dp !== null) errs.produced.push(dp);
    const detail = Object.entries(h.parts).filter(([, v]) => v > 0)
        .map(([l, v]) => `${l} ${v}`).join('; ') || 'nothing ran';
    console.log(`  ${h.hour}:00 ${fmt(h.usedSplit, 10)} ${fmt(h.usedTotal, 10)} ${fmtPct(du)} `
        + `${fmt(h.producedSplit, 11)} ${fmt(h.producedTotal, 10)} ${fmtPct(dp)}  ${detail}`);
}

const stats = (xs) => {
    if (!xs.length) return null;
    const abs = xs.map(Math.abs);
    return {
        mean: abs.reduce((a, b) => a + b, 0) / abs.length,
        worst: Math.max(...abs),
        // A one-sided error is a systematic bias; a two-sided one is mostly quantisation.
        biased: xs.every((x) => x > 0) || xs.every((x) => x < 0)
    };
};

console.log('\n--- Verdict ------------------------------------------------------------------');
const u = stats(errs.used);
if (!u) {
    console.log('  No hour carried both a split and a counter delta — nothing to compare.');
} else {
    console.log(`  used:     mean |error| ${u.mean.toFixed(1)}%, worst ${u.worst.toFixed(1)}%`
        + `${u.biased ? ', ONE-SIDED (systematic, not rounding)' : ', two-sided'}`);
    const p = stats(errs.produced);
    if (p)
        console.log(`  produced: mean |error| ${p.mean.toFixed(1)}%, worst ${p.worst.toFixed(1)}%`
            + `${p.biased ? ', ONE-SIDED' : ', two-sided'}`);
    console.log();
    // The counters step in 0.1 kWh, so a quiet hour of ~0.1 kWh is ±50% on quantisation alone.
    // Judge on the busy hours; that is where the pump's own attribution is actually exercised.
    const busy = rows.filter((h) => (h.usedTotal ?? 0) >= 0.5);
    if (!busy.length)
        console.log('  CAUTION: no hour used 0.5 kWh or more. The lifetime counters step in 0.1 kWh,\n'
            + '  so quiet hours are dominated by quantisation and prove very little. Run again\n'
            + '  across a hot-water cycle before drawing a conclusion.');
    else {
        const bu = stats(busy.map((h) => pct(h.usedSplit, h.usedTotal)).filter((x) => x !== null));
        console.log(`  On the ${busy.length} busy hour(s) (>=0.5 kWh): mean |error| `
            + `${bu.mean.toFixed(1)}%, worst ${bu.worst.toFixed(1)}%.`);
        console.log(bu.worst <= 5
            ? '  -> The pump\'s per-function split reconciles with its own total. Step 2 can proceed.'
            : '  -> The split does NOT reconcile. Do not move per-function energy onto it yet;\n'
              + '     find out what the residual is first.');
    }
}

if (reconcile)
    console.log(`\n  For contrast, the allocator over the same run: pump ${reconcile.pump} kWh vs `
        + `trapezoid ${reconcile.trapezoid} kWh (${reconcile.drift}%) after ${reconcile.hours} h.`);
console.log();
