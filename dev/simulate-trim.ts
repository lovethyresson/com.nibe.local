// The holding trim (lib/autopilot/setpoint.ts) on many simulated houses. Offline, no pump.
//
// Each house is the app's own 2R2C model with random heat loss, capacities, coupling and share of
// heat into the mass (radiators to slab floor), heated through a heat curve that is wrong by a
// random amount (40 % too flat to 20 % too steep) and delivers through a lag (1–4 h). The trim
// gets the model's numbers wrong too: its time constant is off by up to ±40 %. The house is
// settled for 20 days, then run through 28 days of weather; each day's indoor mean is scored
// against the target, from day 5 on. Compared: no trim, the integral-only trim it replaced
// (2026-11-19), and the shipped `nextTrim`.
//
//   npx tsx dev/simulate-trim.ts [--houses 200] [--seed 7] [--weather cold|swing] [--noise 0.2]
//
// No planner runs here: the planner twin (dev/evaluate-presets.mjs) is the check that the trim
// does not fight pre-heats and coasts.
import {HouseParams, stepHouse} from '../lib/autopilot/model';
import {TrimState, nextTrim} from '../lib/autopilot/setpoint';

const arg = (name: string, fallback: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
};
const HOUSES = Number(arg('houses', '200')), SEED = Number(arg('seed', '7')), WEATHER = arg('weather', 'cold');
const NOISE = Number(arg('noise', '0'));
const SP = 22.5, SLOT_H = 0.25, DAYS = 28, SETTLE_DAYS = 20;
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

/** Cold: 4 days at 5 °C, 3 days falling to −5, 6 days there, 3 days up to 8, then 8. Swing: ±7 K
 *  over 9 days. Both with a ±2.5 K day. */
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

type Trim = (state: TrimState, input: {setpoint: number; mean: number; hours: number; tauHours: number}) => {trim: number; state: TrimState};
/** The trim this replaced: integral only, 0.02 K per K·h, learning within 1 K. */
const integralOnly: Trim = (state, input) => {
    const error = input.setpoint - input.mean;
    const integral = Math.abs(error) <= 1 ? state.integral + 0.02 * error * input.hours : state.integral;
    return {trim: integral, state: {integral}};
};
const noTrim: Trim = (state) => ({trim: 0, state});
const shipped: Trim = (state, input) => nextTrim(state, {...input, integrate: true});

function run(house: HouseParams, flat: number, lagH: number, tauGuess: number, trim: Trim, noise: () => number): number[] {
    const c = flat * house.heatLoss, base = 5 + (house.heatLoss * (SP - 5) - house.gains) / c;
    const demand = (fed: number) => Math.max(0, c * (base - fed));
    let ti = SP, tm = SP, delivered = demand(5);
    for (let k = 0; k < SETTLE_DAYS * 96; k++) [ti, tm] = stepHouse(house, ti, tm, {te: 5, q: delivered * SLOT_H, sun: 0});
    const follow = 1 - Math.exp(-SLOT_H / lagH);
    const seen: number[] = [], days: number[] = [];
    let state: TrimState = {integral: 0}, applied = 0;
    for (let k = 0; k < DAYS * 96; k++) {
        const te = outdoor(k);
        seen.push(ti + noise());
        if (k >= 96) {
            const next = trim(state, {setpoint: SP, mean: mean(seen.slice(-96)), hours: SLOT_H, tauHours: tauGuess});
            state = next.state;
            applied = Math.round(next.trim * 10) / 10;
        }
        delivered += follow * (demand(te - applied) - delivered);
        [ti, tm] = stepHouse(house, ti, tm, {te, q: delivered * SLOT_H, sun: 0});
        if (k >= 4 * 96 && k % 96 === 95) days.push(SP - mean(seen.slice(-96)));
    }
    return days;
}

const draw = rng(SEED), noiseDraw = rng(SEED + 1000);
const noise = () => (noiseDraw() - 0.5) * 2 * NOISE;
const trims: [string, Trim][] = [['no trim', noTrim], ['integral only (before)', integralOnly], ['shipped', shipped]];
const scores = new Map(trims.map(([name]) => [name, [] as {rms: number; worst: number}[]]));
for (let n = 0; n < HOUSES; n++) {
    const heatLoss = 0.08 + 0.27 * draw(), ci = 0.8 + 1.5 * draw(), cm = 4 + 14 * draw(), f = 0.2 + 0.7 * draw();
    const house: HouseParams = {heatLoss, ci, cm, rim: (0.5 + 1.5 * draw()) / ci, f, sun: 0, sunE: 0, sunW: 0, gains: 0.1 + 0.3 * draw()};
    const flat = 0.6 + 0.6 * draw(), lagH = 0.5 + 4 * f * draw();
    const tauGuess = (ci + cm) / heatLoss * (0.6 + 0.8 * draw());
    for (const [name, trim] of trims) {
        const days = run(house, flat, lagH, tauGuess, trim, noise);
        scores.get(name)!.push({rms: Math.sqrt(mean(days.map((d) => d * d))), worst: Math.max(...days.map(Math.abs))});
    }
}
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
console.log(`${HOUSES} houses, ${WEATHER} weather, seed ${SEED}, sensor noise ±${NOISE} K. Each day's indoor mean against the target, K.`);
console.log('trim'.padEnd(24), 'median rms'.padStart(10), 'p90 rms'.padStart(8), '  worst day: median / p90 / max');
for (const [name] of trims) {
    const s = scores.get(name)!, rms = s.map((x) => x.rms), worst = s.map((x) => x.worst);
    console.log(name.padEnd(24), pct(rms, 0.5).toFixed(2).padStart(10), pct(rms, 0.9).toFixed(2).padStart(8),
        `   ${pct(worst, 0.5).toFixed(2)} / ${pct(worst, 0.9).toFixed(2)} / ${Math.max(...worst).toFixed(2)}`);
}
const before = scores.get('integral only (before)')!, now = scores.get('shipped')!;
const better = now.filter((s, i) => s.rms < before[i].rms - 0.05).length, worse = now.filter((s, i) => s.rms > before[i].rms + 0.05).length;
console.log(`shipped against before: better on ${better}, worse on ${worse} of ${HOUSES} (by more than 0.05 K)`);
const bare = scores.get('no trim')!;
console.log(`shipped against no trim: better on ${now.filter((s, i) => s.rms < bare[i].rms - 0.05).length}, `
    + `worse on ${now.filter((s, i) => s.rms > bare[i].rms + 0.05).length} of ${HOUSES}`);
