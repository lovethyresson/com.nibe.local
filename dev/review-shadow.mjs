// Reviews Autopilot's shadow log (lib/autopilot/shadow.ts): what each preset would have fed, and
// how well the model predicted the house doing nothing, which is what the house really did.
// Reads only.
//
// The log sits beside the history file (dev/read-autopilot-history.mjs says where), as
// autopilot-….shadow.jsonl, one line per slot:
//   node dev/review-shadow.mjs http://<homey-ip>/app/com.nibe.local/userdata/autopilot-….shadow.jsonl
//   node dev/review-shadow.mjs ./autopilot-….shadow.jsonl [--tz Europe/Stockholm]
import fs from 'node:fs';

const source = process.argv[2];
if (!source) {
    console.error('usage: node dev/review-shadow.mjs <url or file of autopilot-….shadow.jsonl> [--tz <zone>]');
    process.exit(1);
}
const tzAt = process.argv.indexOf('--tz');
const timeZone = tzAt > 0 ? process.argv[tzAt + 1] : 'Europe/Stockholm';
const text = /^https?:/.test(source) ? await (await fetch(source)).text() : fs.readFileSync(source, 'utf8');
const entries = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
if (!entries.length) {
    console.log('The shadow log is empty: no slot has been planned yet.');
    process.exit(0);
}
const bySlot = new Map(entries.map((e) => [e.slot, e]));
const day = new Intl.DateTimeFormat('sv-SE', {timeZone, dateStyle: 'short'});
const stamp = new Intl.DateTimeFormat('sv-SE', {timeZone, dateStyle: 'short', timeStyle: 'short'});
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const rms = (xs) => Math.sqrt(mean(xs.map((x) => x * x)));
const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');

console.log(`${entries.length} slots planned, ${stamp.format(new Date(entries[0].at))} → ${stamp.format(new Date(entries.at(-1).at))}, `
    + `${f(mean(entries.map((e) => e.ms)), 0)} ms a slot (all presets), horizon ${f(mean(entries.map((e) => e.horizon)), 0)} slots`);

// An entry's `ti` is the slot before the one it plans, so the slot-mean indoor of slot s is in
// the entry for s + 1. Prediction k slots ahead ends slot (planned + k − 1).
const realised = (slot) => bySlot.get(slot + 1)?.ti;
const errors = (k, i) => entries.map((e) => e.baseline?.[i] - realised(e.slot + k - 1)).filter(Number.isFinite);
const e1 = errors(4, 0), e6 = errors(24, 1);
console.log(`Doing nothing, predicted vs what the house did: 1 h ${f(rms(e1))} K RMS (bias ${f(mean(e1))}, n ${e1.length}), `
    + `6 h ${f(rms(e6))} K RMS (bias ${f(mean(e6))}, n ${e6.length}). Positive bias: the model expected it warmer.`);

const presets = ['comfortable', 'save_some', 'save_most'];
const summarise = (list) => presets.map((id) => {
    const p = list.map((e) => e.presets?.[id]).filter(Boolean);
    if (!p.length) return `  ${id.padEnd(12)} -`;
    const clamps = {};
    for (const x of p) for (const c of x.clamped) clamps[c] = (clamps[c] ?? 0) + 1;
    const clamped = Object.entries(clamps).map(([c, n]) => `${c} ${Math.round(100 * n / p.length)} %`).join(', ');
    // From 2026-11-07 each entry carries the comfort bias (trim.ts): coasting and pre-heating are
    // the shift from it, not from the real outdoor temperature.
    const held = p.map((x) => x.comfortBias ?? 0);
    const shift = p.map((x, i) => x.bias - held[i]);
    const comfort = p.some((x) => x.comfortBias !== undefined)
        ? `comfort bias ${f(Math.min(...held), 1)}…${f(Math.max(...held), 1)} K (mean ${f(mean(held), 1)}), ` : '';
    return `  ${id.padEnd(12)} bias ${f(Math.min(...p.map((x) => x.bias)), 0)}…${f(Math.max(...p.map((x) => x.bias)), 0)} K, ${comfort}`
        + `shift mean ${f(mean(shift), 1)}, coasting ${Math.round(100 * shift.filter((x) => x < -0.05).length / p.length)} %, `
        + `pre-heating ${Math.round(100 * shift.filter((x) => x > 0.05).length / p.length)} %, `
        + `planned saving ${f(100 * mean(p.map((x) => x.saving)), 1)} %${clamped ? `, clamped: ${clamped}` : ''}`;
}).join('\n');

console.log('\nWhole log:');
console.log(summarise(entries));
const days = new Map();
for (const e of entries) {
    const d = day.format(new Date(e.at));
    days.set(d, [...(days.get(d) ?? []), e]);
}
if (days.size > 1) for (const [d, list] of days) {
    console.log(`\n${d} (${list.length} slots, outdoor ${f(Math.min(...list.map((e) => e.te)), 1)}…${f(Math.max(...list.map((e) => e.te)), 1)} °C, `
        + `indoor ${f(Math.min(...list.map((e) => e.ti)), 1)}…${f(Math.max(...list.map((e) => e.ti)), 1)} °C):`);
    console.log(summarise(list));
}
