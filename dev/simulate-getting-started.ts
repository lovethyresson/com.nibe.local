// Getting started (lib/autopilot/settling.ts) end to end, offline: how long until Saving, and
// whether a house that gets there sooner is any less settled. Companion to simulate-trim-dayone.ts,
// whose houses it uses: the app's 2R2C model with a heat curve off in slope and level, room-sensor
// control off from day 0, the trim (setpoint.ts) from day 0, the house model ready on day READY.
//
// Each morning, in the app's order (device.ts `afterFit`): Getting started scores yesterday
// (scoreDay, then calibrateDay), then the heat curve advice reads the trim's learned part
// (curve-advice.ts `curveVerdict`) and, with the owner's "auto", changes the offset once; the trim
// gives back what the offset adds (`trimShiftFor`). The curve fit's offset step is the real one
// off by up to ±30 %.
//
// Compared:
//   before   settling.ts at --baseline (calibrating's 3-day check, 14-day cap) with the advice
//            acting only once settling is done, as before
//   now      this tree's settling.ts, with the advice acting while settling
//
//   npx tsx dev/simulate-getting-started.ts [--houses 200] [--seed 7] [--weather cold|swing]
//        [--offset 4] [--ready 6] [--baseline 4b5fb78] [--try <check days>,<cap days>[,<advice after days>]]...
import {execFileSync} from 'child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {HouseParams, stepHouse} from '../lib/autopilot/model';
import {DEFAULT_TAU_H, TrimState, nextTrim} from '../lib/autopilot/setpoint';
import {CurveSample, READY_DAYS_BEFORE, addSample, curveVerdict, trimShiftFor} from '../lib/autopilot/curve-advice';
import * as now from '../lib/autopilot/settling';

const arg = (name: string, fallback: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
};
const HOUSES = Number(arg('houses', '200')), SEED = Number(arg('seed', '7')), WEATHER = arg('weather', 'cold');
const OFFSET = Number(arg('offset', '4')), READY = Number(arg('ready', '6')), NOISE = Number(arg('noise', '0.2'));
const BASELINE = arg('baseline', '4b5fb78');
const SP = 22.5, SLOT_H = 0.25, DAYS = 60, SETTLE_DAYS = 20;
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const date = (d: number) => new Date(Date.UTC(2026, 0, 1) + d * 86_400_000).toISOString().slice(0, 10);

type Settling = typeof now;
const dir = mkdtempSync(join(tmpdir(), 'settling-'));
process.on('exit', () => rmSync(dir, {recursive: true, force: true}));
writeFileSync(join(dir, 'settling.ts'), execFileSync('git', ['show', `${BASELINE}:lib/autopilot/settling.ts`], {encoding: 'utf8'}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const before: Settling = require(join(dir, 'settling.ts'));

function outdoor(k: number): number {
    const d = k / 96, day = 2.5 * Math.sin(2 * Math.PI * ((k % 96) / 96 - 0.375));
    if (WEATHER === 'swing') return 3 + 7 * Math.sin(2 * Math.PI * d / 9) + day;
    const base = d < 4 ? 5 : d < 7 ? 5 - (10 / 3) * (d - 4) : d < 13 ? -5 : d < 16 ? -5 + (13 / 3) * (d - 13) : 8;
    return base + day;
}
function rng(seed: number) {
    let s = seed >>> 0;
    return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

type Variant = {name: string; lib: Settling; adviseWhileSettling: boolean; adviceAfter?: number};
const variants: Variant[] = [
    {name: 'before', lib: before, adviseWhileSettling: false},
    {name: 'now', lib: now, adviseWhileSettling: true},
];
// --try "check,cap": this tree's settling.ts with other calibrating numbers, beside the two above.
for (const spec of process.argv.flatMap((a, i) => (process.argv[i - 1] === '--try' ? [a] : []))) {
    const [check, cap, after] = spec.split(',');
    const text = readFileSync(join(__dirname, '../lib/autopilot/settling.ts'), 'utf8')
        .replace(/export const CHECK_DAYS = [^;]+;/, `export const CHECK_DAYS = ${check};`)
        .replace(/export const CALIBRATE_MAX_DAYS = [^;]+;/, `export const CALIBRATE_MAX_DAYS = ${cap};`);
    const file = join(dir, `settling-${check}-${cap}.ts`);
    writeFileSync(file, text);
    variants.push({name: `${check}d/${cap}d${after ? `/a${after}` : ''}`, lib: require(file), adviseWhileSettling: true,
        ...after ? {adviceAfter: Number(after)} : {}});
}

interface Result {
    /** Day Saving started, from Autopilot's start; undefined if never within DAYS. */
    live?: number;
    reason?: string;
    /** Daily indoor mean error (target − mean) per day. */
    errors: number[];
    /** Day the offset changed, if it did. */
    changed?: number;
    /** Day settling ended (settled or stopped). */
    settled?: number;
}

function run(house: HouseParams, flat: number, offset: number, lagH: number, tauModel: number, stepReal: number,
    stepSeen: number, v: Variant, noise: () => number): Result {
    const c = flat * house.heatLoss;
    let base = 5 + (house.heatLoss * (SP - 5) - house.gains) / c + offset;
    const demand = (fed: number) => Math.max(0, c * (base - fed));
    const hold = house.heatLoss * (SP - 5) - house.gains;
    let ti = SP, tm = SP, delivered = hold;
    for (let k = 0; k < SETTLE_DAYS * 96; k++) [ti, tm] = stepHouse(house, ti, tm, {te: 5, q: hold * SLOT_H, sun: 0});
    const follow = 1 - Math.exp(-SLOT_H / lagH);
    const seen: number[] = Array(96).fill(SP), tes: number[] = [], errors: number[] = [];
    let trim: TrimState = {integral: 0}, applied = 0;
    // The curve advice's store, as days: offset steps from the owner's, samples, the change.
    let steps = 0, samples: CurveSample[] = [], changed: number | undefined, wrote: number | undefined, fits: number | undefined;
    let state: now.SettleState | undefined;
    const out: Result = {errors};
    for (let k = 0; k < DAYS * 96; k++) {
        const te = outdoor(k), day = k / 96;
        seen.push(ti + noise());
        tes.push(te);
        const next = nextTrim(trim, {setpoint: SP, mean: mean(seen.slice(-96)), hours: SLOT_H, integrate: true,
            tauHours: day >= READY ? tauModel : DEFAULT_TAU_H});
        trim = next.state;
        applied = Math.round(next.trim * 10) / 10;
        delivered += follow * (demand(te - applied) - delivered);
        [ti, tm] = stepHouse(house, ti, tm, {te, q: delivered * SLOT_H, sun: 0});
        if (k % 96 !== 95) continue;
        // The morning after day d.
        const d = Math.floor(day), dayMean = mean(seen.slice(-96)), today = d + 1;
        errors.push(SP - dayMean);
        if (d < READY || out.live !== undefined) continue;
        const reading = {date: date(d), mean: dayMean, slots: 96, setMin: SP, setMax: SP};
        const view: now.CurveView = {fits: fits !== undefined && today - fits <= 1,
            ...changed !== undefined ? {changed: date(changed)} : {}};
        state ??= {start: date(d - 1), days: []};
        if (!v.lib.settleDone(state)) {
            const scored = v.lib.scoreDay(state, reading);
            state = scored.state;
            if (v.lib.settleDone(state)) out.settled = today;
            const settled = scored.event?.kind === 'settled';
            if (settled && view.fits && !(view.changed && view.changed > state.start)) state = {...state, live: date(d), fits: true};
            else if (settled && 'checkedWhileSettling' in v.lib && (v.lib as typeof now).checkedWhileSettling(state, view)) {
                state = {...state, live: date(d)};
                out.reason = 'checked';
            }
        } else {
            const checked = v.lib.calibrateDay(state, reading, view);
            state = checked.state;
            if (checked.event) out.reason = checked.event.reason;
        }
        if (state.live) {
            out.live = today;
            out.reason ??= 'fits';
            continue;
        }
        // The heat curve advice, after Getting started in the same hour.
        samples = addSample(samples, {day: today, integral: trim.integral, te: mean(tes.slice(-96))});
        // adviceAfter: the advice's first verdict that many days after the model is ready, not READY_DAYS_BEFORE.
        const readyDays = today - READY + (v.adviceAfter === undefined ? 0 : READY_DAYS_BEFORE - v.adviceAfter);
        const verdict = curveVerdict({today, samples, offset: steps, readyDays, curveGain: 1, stepK: stepSeen,
            changed, wrote});
        fits = verdict === undefined ? fits : verdict.to === verdict.from ? today : undefined;
        const may = v.adviseWhileSettling || v.lib.settleDone(state);
        if (may && verdict && verdict.to !== verdict.from) {
            const by = verdict.to - verdict.from;
            base += by * stepReal;
            trim = {...trim, integral: trim.integral + trimShiftFor(by, 1, stepSeen)};
            steps = verdict.to;
            changed = wrote = today;
            out.changed = today;
        }
    }
    return out;
}

const draw = rng(SEED), noiseDraw = rng(SEED + 1000);
const noise = () => (noiseDraw() - 0.5) * 2 * NOISE;
const res = new Map(variants.map((v) => [v.name, [] as Result[]]));
for (let n = 0; n < HOUSES; n++) {
    const heatLoss = 0.08 + 0.27 * draw(), ci = 0.8 + 1.5 * draw(), cm = 4 + 14 * draw(), f = 0.2 + 0.7 * draw();
    const house: HouseParams = {heatLoss, ci, cm, rim: (0.5 + 1.5 * draw()) / ci, f, sun: 0, sunE: 0, sunW: 0, gains: 0.1 + 0.3 * draw()};
    const flat = 0.6 + 0.6 * draw(), lagH = 0.5 + 4 * f * draw(), offset = (draw() * 2 - 1) * OFFSET;
    const tau = (ci + cm) / heatLoss, tauModel = tau * (0.6 + 0.8 * draw());
    // One offset step as K of fed outdoor (S1155: 1.53 K of supply at ~0.45 supply K per K), and the fit's reading of it.
    const stepReal = 2.5 + 1.5 * draw(), stepSeen = stepReal * (0.7 + 0.6 * draw());
    for (const v of variants) res.get(v.name)!.push(run(house, flat, offset, lagH, tauModel, stepReal, stepSeen, v, noise));
}

const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
console.log(`${HOUSES} houses, ${WEATHER}, curve level ±${OFFSET} K, model ready day ${READY}, baseline ${BASELINE}.`);
console.log('Settling ended on day (median / p90), Saving from day (median / p90 / max), houses never live in 60 days, the week after Saving:'
    + ' worst day |error| K (median / p90 / max) and days off by more than 0.3 K.');
for (const v of variants) {
    const r = res.get(v.name)!, live = r.filter((x) => x.live !== undefined);
    const lives = live.map((x) => x.live!);
    const week = live.map((x) => Math.max(...x.errors.slice(x.live!, x.live! + 7).map(Math.abs)));
    const off = live.reduce((n, x) => n + x.errors.slice(x.live!, x.live! + 7).filter((e) => Math.abs(e) > 0.3).length, 0);
    const reasons = [...new Set(live.map((x) => x.reason))].map((k) => `${k} ${live.filter((x) => x.reason === k).length}`).join(', ');
    const settled = r.filter((x) => x.settled !== undefined).map((x) => x.settled!);
    console.log(v.name.padEnd(8), `settled ${pct(settled, .5)}/${pct(settled, .9)}`.padEnd(15),
        `live ${pct(lives, .5)}/${pct(lives, .9)}/${Math.max(...lives)}`.padEnd(18),
        `never ${r.length - live.length}`.padEnd(10),
        `week after ${pct(week, .5).toFixed(2)}/${pct(week, .9).toFixed(2)}/${Math.max(...week).toFixed(2)}`.padEnd(28),
        `days >0.3 K ${off} of ${live.length * 7}`.padEnd(22), reasons);
}
const a = res.get('before')!, b = res.get('now')!;
const both = a.map((x, i) => [x, b[i]] as const).filter(([x, y]) => x.live !== undefined && y.live !== undefined);
const sooner = both.map(([x, y]) => x.live! - y.live!);
console.log(`now vs before: Saving sooner by median ${pct(sooner, .5)} days (p90 ${pct(sooner, .9)}), later on ${sooner.filter((s) => s < 0).length} houses.`);
