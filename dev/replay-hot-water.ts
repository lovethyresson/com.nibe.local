// Replays the hot water log (lib/autopilot/hotwater-shadow.ts) through today's planner, slot by
// slot from the state each line logged, and diffs what it decides against what was logged.
// Plan: tasks/hotwater-improvement-plan.md step 1.3. Reads only.
//
//   npx tsx dev/replay-hot-water.ts http://<homey-ip>/app/com.nibe.local/userdata/autopilot-….shadow.jsonl
//   npx tsx dev/replay-hot-water.ts ./autopilot-….shadow.jsonl [--tz Europe/Stockholm] [--days 7]
//
// The app logs the path at start ("Autopilot hot water log: …"). The model is read from beside
// the log (….model.json). Only lines with `ctx` (from 2026-11-21) can be replayed.
//
// What a diff means: the code changed since, or an input the log cannot carry differs. Those are
// the model (the file holds today's, not the one in force then), the solar surplus and the
// heating pre-heat slots; a line that ran with surplus or pre-heat is marked, not judged.
import fs from 'node:fs';
import {hotwaterShadowStep, ShadowEntry, SlotContext} from '../lib/autopilot/hotwater-shadow';
import {localClock, HotwaterModel, DayType} from '../lib/autopilot/hotwater-learner';

const SLOT_MS = 15 * 60_000;
const source = process.argv[2];
if (!source) {
    console.error('usage: npx tsx dev/replay-hot-water.ts <url or file of autopilot-….shadow.jsonl> [--tz <zone>] [--days <n>]');
    process.exit(1);
}
const arg = (name: string, fallback: string) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : fallback;
};
const clock = localClock(arg('--tz', 'Europe/Stockholm'));
const days = Number(arg('--days', '28'));
const read = async (s: string) => (/^https?:/.test(s) ? (await fetch(s)).text() : fs.readFileSync(s, 'utf8'));

type Line = ShadowEntry & {skip?: string; ctx?: SlotContext};

async function main() {
const lines: Line[] = (await read(source)).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const model: HotwaterModel = JSON.parse(await read(source.replace(/\.shadow\.jsonl$/, '.model.json'))).model;
const since = Date.now() - days * 24 * 3_600_000;
const withCtx = lines.filter((l) => l.ctx && l.slot * SLOT_MS >= since);
if (!withCtx.length) {
    console.log('No line carries ctx yet: the log predates 2026-11-21, or the app has not run since.');
    return;
}
const prices = new Map<number, {price: number}>();
const types = new Map<number, DayType>();
for (const l of lines) {
    if (Number.isFinite(l.ctx?.price)) prices.set(l.slot, {price: l.ctx!.price!});
    if (l.ctx?.dt) types.set(l.slot, l.ctx.dt as DayType);
}

let same = 0, differ = 0, skipped = 0;
const byDay = new Map<string, string[]>();
for (const l of withCtx) {
    if (l.skip || !l.ctx!.tank) {
        skipped++;
        continue;
    }
    const c = l.ctx!;
    // Prices as far as the log knew them then: the line's own horizon.
    const known = new Map([...prices].filter(([slot]) => slot >= l.slot && slot < l.slot + l.horizon));
    // The log holds a slot's price from its own line: near the log's end the later prices the
    // plan saw are not logged yet, so the slot cannot be replayed as it was.
    if (known.size < l.horizon) {
        skipped++;
        continue;
    }
    const dayType = c.dt as DayType | undefined;
    const out = hotwaterShadowStep({slot: l.slot, prices: known, model, clock, tank: c.tank!,
        now: {litres: l.litres, top: l.top, powerW: c.powerW, more: c.more, stopC: c.stopC, largeStopC: c.largeStopC, produced: l.produced},
        dayType, dayTypeOf: (ms) => types.get(Math.floor(ms / SLOT_MS)) ?? dayType!, reserveLitres: c.reserve, maxC: c.maxC});
    if ('skip' in out) {
        skipped++;
        continue;
    }
    const a = out.entry;
    const match = a.action === l.action && a.next?.at === l.next?.at;
    if (match) same++;
    else {
        differ++;
        const {date} = clock(l.slot * SLOT_MS);
        const t = (iso?: string) => (iso ? `${String(clock(Date.parse(iso)).hour).padStart(2, '0')}:${String(clock(Date.parse(iso)).minute).padStart(2, '0')}` : '—');
        const at = clock(l.slot * SLOT_MS);
        (byDay.get(date) ?? byDay.set(date, []).get(date)!).push(
            `${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')} ${l.litres} L  live ${l.action} next ${t(l.next?.at)}  replay ${a.action} next ${t(a.next?.at)}`);
    }
}
console.log(`Replayed ${same + differ} slots: ${same} the same, ${differ} differ, ${skipped} not replayable.`);
for (const [date, rows] of byDay) {
    console.log(`\n${date}: ${rows.length} differ`);
    for (const r of rows.slice(0, 12)) console.log('  ' + r);
    if (rows.length > 12) console.log(`  … ${rows.length - 12} more`);
}
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
