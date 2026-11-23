// Getting started with the price planner on: hold every price shift until Saving (as shipped), or
// shift as soon as the house is within the comfort range, the way Ngenic Tune runs price control
// from the start and leaves the curve to be checked over the season. Offline, no pump.
//
// Houses, curves, trim and curve advice as dev/simulate-getting-started.ts; the planner as
// dev/simulate-trim-planner.ts (planner.ts `planShift` every --every hours, perfect weather, a
// price day with morning and evening peaks, the model's numbers off). Fed bias = trim + shift.
// Getting started (settling.ts) scores the days either way, so its checks read shifted days in
// "range". Scored from the day the model is ready to the end: cost, the daily indoor mean against
// the target, and when Saving is reached.
//
//   npx tsx dev/simulate-getting-started-shift.ts [--houses 40] [--seed 7] [--every 2] [--profile comfortable]
import {HouseParams, envelopeTau, stepHouse} from '../lib/autopilot/model';
import {TrimState, nextTrim} from '../lib/autopilot/setpoint';
import {ForecastSlot, planShift} from '../lib/autopilot/planner';
import {PROFILE_LIMITS} from '../lib/autopilot/live';
import {curveInput} from '../lib/autopilot/actuator';
import {CurveSample, addSample, curveVerdict, trimShiftFor} from '../lib/autopilot/curve-advice';
import {CurveView, SettleState, calibrateDay, checkedWhileSettling, scoreDay, settleDone} from '../lib/autopilot/settling';

const arg = (name: string, fallback: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
};
const HOUSES = Number(arg('houses', '40')), SEED = Number(arg('seed', '7')), EVERY = Number(arg('every', '2'));
const PROFILE = arg('profile', 'comfortable') as keyof typeof PROFILE_LIMITS, OFFSET = Number(arg('offset', '4'));
const READY = 6, NOISE = 0.2, SP = 22.5, SLOT_H = 0.25, DAYS = 40, PRE_DAYS = 20;
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const date = (d: number) => new Date(Date.UTC(2026, 0, 1) + d * 86_400_000).toISOString().slice(0, 10);

function outdoor(k: number): number {
    const d = k / 96, day = 2.5 * Math.sin(2 * Math.PI * ((k % 96) / 96 - 0.375));
    const base = d < 4 ? 5 : d < 7 ? 5 - (10 / 3) * (d - 4) : d < 13 ? -5 : d < 16 ? -5 + (13 / 3) * (d - 13) : 8;
    return base + day;
}
function price(k: number): number {
    const h = (k % 96) / 4, d = Math.floor(k / 96);
    return 1 + 0.15 * Math.sin(d * 1.7) + (h >= 7 && h < 9 ? 1.2 : 0) + (h >= 17 && h < 20 ? 1.6 : 0) - (h < 5 ? 0.3 : 0);
}
function rng(seed: number) {
    let s = seed >>> 0;
    return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

type Mode = 'hold' | 'range';
interface Result { live?: number; firstShift?: number; cost: number; errors: number[] }

function run(house: HouseParams, model: HouseParams, flat: number, offset: number, lagH: number, lever: number,
    stepReal: number, stepSeen: number, mode: Mode, noise: () => number): Result {
    const limits = PROFILE_LIMITS[PROFILE];
    const c = flat * house.heatLoss;
    let base = 5 + (house.heatLoss * (SP - 5) - house.gains) / c + offset;
    const demand = (curve: number) => Math.max(0, c * (base - curve));
    const hold = house.heatLoss * (SP - 5) - house.gains;
    let ti = SP, tm = SP, delivered = hold, curve = 5;
    for (let k = 0; k < PRE_DAYS * 96; k++) [ti, tm] = stepHouse(house, ti, tm, {te: 5, q: hold * SLOT_H, sun: 0});
    const follow = 1 - Math.exp(-SLOT_H / lagH);
    const seen: number[] = Array(96).fill(SP), tes: number[] = [];
    let trim: TrimState = {integral: 0}, applied = 0, shift: number[] = [], shiftAt = 0, bias = 0;
    let steps = 0, samples: CurveSample[] = [], changed: number | undefined, wrote: number | undefined, fits: number | undefined;
    let state: SettleState | undefined, shifting = false;
    const out: Result = {cost: 0, errors: []};
    for (let k = 0; k < DAYS * 96; k++) {
        const te = outdoor(k), day = k / 96;
        seen.push(ti + noise());
        tes.push(te);
        const next = nextTrim(trim, {setpoint: SP, mean: mean(seen.slice(-96)), hours: SLOT_H, integrate: true,
            tauHours: day >= READY ? envelopeTau(model) : 72});
        trim = next.state;
        applied = Math.round(next.trim * 10) / 10;
        if (shifting && k % (EVERY * 4) === 0) {
            const forecast: ForecastSlot[] = Array.from({length: 96}, (_, j) => ({te: outdoor(k + j), sun: 0, price: price(k + j)}));
            shift = planShift(model, SP, {ti, tm, curve, bias: bias - applied}, forecast, limits, {lever}, undefined, 400).shift;
            shiftAt = k;
        }
        const planned = shifting ? shift[k - shiftAt] ?? 0 : 0;
        bias = applied + planned;
        curve = curveInput(curve, te - bias);
        delivered += follow * (demand(curve) - delivered);
        if (day >= READY) out.cost += delivered * SLOT_H * price(k);
        [ti, tm] = stepHouse(house, ti, tm, {te, q: delivered * SLOT_H, sun: 0});
        if (k % 96 !== 95) continue;
        const d = Math.floor(day), dayMean = mean(seen.slice(-96)), today = d + 1;
        if (d >= READY) out.errors.push(SP - dayMean);
        if (d < READY) continue;
        // "range": shifting from the morning the house's day was within the comfort range.
        if (mode === 'range' && !shifting && Math.abs(SP - dayMean) <= limits.lower) {
            shifting = true;
            out.firstShift = today;
        }
        if (out.live !== undefined) continue;
        const reading = {date: date(d), mean: dayMean, slots: 96, setMin: SP, setMax: SP};
        const view: CurveView = {fits: fits !== undefined && today - fits <= 1, ...changed !== undefined ? {changed: date(changed)} : {}};
        state ??= {start: date(d - 1), days: []};
        if (!settleDone(state)) {
            state = scoreDay(state, reading).state;
            const settled = state.settled === date(d);
            if (settled && view.fits && !(view.changed && view.changed > state.start)) state = {...state, live: date(d)};
            else if (settled && checkedWhileSettling(state, view)) state = {...state, live: date(d)};
        } else state = calibrateDay(state, reading, view).state;
        if (state.live) {
            out.live = today;
            if (!shifting) { shifting = true; out.firstShift = today; }
            continue;
        }
        samples = addSample(samples, {day: today, integral: trim.integral, te: mean(tes.slice(-96))});
        const verdict = curveVerdict({today, samples, offset: steps, readyDays: today - READY, curveGain: 1, stepK: stepSeen, changed, wrote});
        fits = verdict === undefined ? fits : verdict.to === verdict.from ? today : undefined;
        if (verdict && verdict.to !== verdict.from) {
            const by = verdict.to - verdict.from;
            base += by * stepReal;
            trim = {...trim, integral: trim.integral + trimShiftFor(by, 1, stepSeen)};
            steps = verdict.to;
            changed = wrote = today;
        }
    }
    return out;
}

const draw = rng(SEED), noiseDraw = rng(SEED + 1000);
const noise = () => (noiseDraw() - 0.5) * 2 * NOISE;
const modes: Mode[] = ['hold', 'range'];
const res = new Map(modes.map((m) => [m, [] as Result[]]));
for (let n = 0; n < HOUSES; n++) {
    const heatLoss = 0.08 + 0.27 * draw(), ci = 0.8 + 1.5 * draw(), cm = 4 + 14 * draw(), f = 0.2 + 0.7 * draw();
    const house: HouseParams = {heatLoss, ci, cm, rim: (0.5 + 1.5 * draw()) / ci, f, sun: 0, sunE: 0, sunW: 0, gains: 0.1 + 0.3 * draw()};
    const flat = 0.6 + 0.6 * draw(), lagH = 0.5 + 4 * f * draw(), offset = (draw() * 2 - 1) * OFFSET;
    const model: HouseParams = {...house, heatLoss: heatLoss * (0.8 + 0.4 * draw()), gains: house.gains * (0.5 + draw())};
    const lever = flat * heatLoss * (0.7 + 0.6 * draw());
    const stepReal = 2.5 + 1.5 * draw(), stepSeen = stepReal * (0.7 + 0.6 * draw());
    for (const m of modes) res.get(m)!.push(run(house, model, flat, offset, lagH, lever, stepReal, stepSeen, m, noise));
    process.stderr.write('.');
}
process.stderr.write('\n');
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
const fmt = (a: number[]) => (a.length ? `${pct(a, .5)}/${pct(a, .9)}` : '-');
console.log(`${HOUSES} houses, ${PROFILE}, planner every ${EVERY} h, curve level ±${OFFSET} K, model ready day ${READY}, scored days ${READY}–${DAYS}.`);
const holdR = res.get('hold')!;
for (const m of modes) {
    const r = res.get(m)!;
    const lives = r.filter((x) => x.live !== undefined).map((x) => x.live!);
    const firsts = r.filter((x) => x.firstShift !== undefined).map((x) => x.firstShift!);
    const rms = r.map((x) => Math.sqrt(mean(x.errors.map((e) => e * e))));
    const off = r.reduce((s, x) => s + x.errors.filter((e) => Math.abs(e) > 0.3).length, 0);
    const days = r.reduce((s, x) => s + x.errors.length, 0);
    const cost = mean(r.map((x, i) => x.cost / holdR[i].cost - 1)) * 100;
    console.log(m.padEnd(6), `shifts from day ${fmt(firsts)}`.padEnd(24), `Saving day ${fmt(lives)} (never ${r.length - lives.length})`.padEnd(28),
        `cost ${cost.toFixed(1)} % vs hold`.padEnd(22), `daily rms ${pct(rms, .5).toFixed(2)}/${pct(rms, .9).toFixed(2)}`.padEnd(22),
        `days >0.3 K ${off} of ${days}`);
}
