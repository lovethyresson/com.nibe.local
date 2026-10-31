// Decodes the smart heating history file (lib/smart/history.ts) and prints it as CSV, one row
// per 15-minute slot, with heat and electricity per slot spread from the pump's counters
// (lib/smart/heat.ts). Reads only.
//
// The file lives in the app's /userdata, which the Homey serves over HTTP. Its name is in the
// app log at start, and in the app setting `smartHistoryFile.<device id>`:
//   homey api apps get-app-settings --id com.nibe.local
//
//   node --import tsx dev/read-smart-history.mjs http://<homey-ip>/app/com.nibe.local/userdata/smart-….bin
//   node --import tsx dev/read-smart-history.mjs ./smart-….bin [--tz Europe/Stockholm]
import fs from 'node:fs';
import {FIELDS, History, applyJournal} from '../lib/smart/history.ts';
import {electricityPerSlot, heatPerSlot} from '../lib/smart/heat.ts';
import {SLOT_MS} from '../lib/smart/prices.ts';

const source = process.argv[2];
if (!source) {
    console.error('usage: node --import tsx dev/read-smart-history.mjs <url or file> [--tz <zone>]');
    process.exit(1);
}
const tzAt = process.argv.indexOf('--tz');
const timeZone = tzAt > 0 ? process.argv[tzAt + 1] : 'Europe/Stockholm';

const read = async (path) => (/^https?:/.test(path)
    ? fetch(path).then(async (r) => (r.ok ? Buffer.from(await r.arrayBuffer()) : undefined))
    : fs.promises.readFile(path).catch(() => undefined));
const history = History.deserialize(await read(source) ?? Buffer.alloc(0));
if (!history) {
    console.error('Not a history file this version can read.');
    process.exit(1);
}
// Slots closed since the last hourly save, as the app replays them (lib/smart/store-file.ts).
const journal = await read(`${source}.journal`);
if (journal?.length) applyJournal(history, journal);
const slots = history.range();
const rows = slots.map((slot) => ({slot, ...history.get(slot)}));
const heat = heatPerSlot(rows.map((r) => ({slot: r.slot, qmeter: r.qmeter, hz: r.hz, dhw: r.dhw})));
const electricity = electricityPerSlot(rows.map((r) => ({slot: r.slot, emeter: r.emeter, pw: r.pw})));
const local = new Intl.DateTimeFormat('sv-SE', {timeZone, dateStyle: 'short', timeStyle: 'short'});

console.log(['local', ...FIELDS, 'qheat_kwh', 'pel_kwh'].join(','));
for (const r of rows) {
    const cells = FIELDS.map((f) => (Number.isFinite(r[f]) ? +r[f].toFixed(3) : ''));
    const q = heat.get(r.slot);
    const pel = electricity.get(r.slot);
    console.log([local.format(new Date(r.slot * SLOT_MS)), ...cells, q === undefined ? '' : q.toFixed(3),
        pel === undefined ? '' : pel.toFixed(3)].join(','));
}
console.error(`${rows.length} slots, ${slots.length ? local.format(new Date(slots[0] * SLOT_MS)) : '-'} → `
    + `${slots.length ? local.format(new Date(slots.at(-1) * SLOT_MS)) : '-'}`);
