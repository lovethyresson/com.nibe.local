// The holding trim (lib/autopilot/setpoint.ts) from the day Autopilot is chosen, before the house
// model is ready. Offline, no pump. Companion to dev/simulate-trim.ts.
//
// Each house is the app's 2R2C model, as in simulate-trim.ts, but its heat curve is wrong in both
// slope (40 % too flat to 20 % too steep) and level (up to ±OFFSET K of outdoor): the owner never
// set it, because room-sensor control held the setpoint. The house starts settled at the setpoint
// under that control; on day 0 room-sensor control goes off (Autopilot chosen) and the house runs
// on the curve. The model is "ready" on day READY (no price planner here); until then the trim
// only knows the default time constant, after it the model's (off by up to ±40 %).
// Compared, scored on each day's indoor mean against the target, days 1–14:
//   bare until ready  nothing steers until the model is ready, then the trim (before 2026-11-19)
//   day one           the trim from day 0 (default τ until ready), as shipped
// An error beyond 2 K used to hold the trim still; with that, 59 of 200 houses (curves ±4 K off,
// cold weather) were still more than 2 K off on day 14 under "bare until ready". It now counts as
// MAX_ERROR, and none are.
//
//   npx tsx dev/simulate-trim-dayone.ts [--houses 200] [--seed 7] [--weather cold|swing] [--offset 4] [--ready 6]
import {HouseParams, stepHouse} from '../lib/autopilot/model';
import {DEFAULT_TAU_H, MAX_ERROR, TrimState, nextTrim} from '../lib/autopilot/setpoint';

const arg = (name: string, fallback: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
};
const HOUSES = Number(arg('houses', '200')), SEED = Number(arg('seed', '7')), WEATHER = arg('weather', 'cold');
const OFFSET = Number(arg('offset', '4')), READY = Number(arg('ready', '6')), NOISE = Number(arg('noise', '0.2'));
const SP = 22.5, SLOT_H = 0.25, DAYS = 15, SETTLE_DAYS = 20;
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

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

type Variant = {name: string; from: number};
const variants: Variant[] = [
    {name: 'bare until ready', from: READY},
    {name: 'day one', from: 0},
];

function run(house: HouseParams, flat: number, offset: number, lagH: number, tauModel: number, v: Variant, noise: () => number) {
    const c = flat * house.heatLoss, base = 5 + (house.heatLoss * (SP - 5) - house.gains) / c + offset;
    const demand = (fed: number) => Math.max(0, c * (base - fed));
    // Settled at the setpoint under room-sensor control: the heat that holds it at 5 °C.
    const hold = house.heatLoss * (SP - 5) - house.gains;
    let ti = SP, tm = SP, delivered = hold;
    for (let k = 0; k < SETTLE_DAYS * 96; k++) [ti, tm] = stepHouse(house, ti, tm, {te: 5, q: hold * SLOT_H, sun: 0});
    const follow = 1 - Math.exp(-SLOT_H / lagH);
    const seen: number[] = Array(96).fill(SP), days: number[] = [];
    let state: TrimState = {integral: 0}, applied = 0;
    for (let k = 0; k < DAYS * 96; k++) {
        const te = outdoor(k), day = k / 96;
        seen.push(ti + noise());
        if (day >= v.from) {
            const m = mean(seen.slice(-96));
            const next = nextTrim(state, {setpoint: SP, mean: m, hours: SLOT_H, integrate: true,
                tauHours: day >= READY ? tauModel : DEFAULT_TAU_H});
            state = next.state;
            applied = Math.round(next.trim * 10) / 10;
        }
        delivered += follow * (demand(te - applied) - delivered);
        [ti, tm] = stepHouse(house, ti, tm, {te, q: delivered * SLOT_H, sun: 0});
        if (k % 96 === 95) days.push(SP - mean(seen.slice(-96)));
    }
    return days;
}

const draw = rng(SEED), noiseDraw = rng(SEED + 1000);
const noise = () => (noiseDraw() - 0.5) * 2 * NOISE;
const res = new Map(variants.map((v) => [v.name, [] as number[][]]));
const heavy: boolean[] = [];
for (let n = 0; n < HOUSES; n++) {
    const heatLoss = 0.08 + 0.27 * draw(), ci = 0.8 + 1.5 * draw(), cm = 4 + 14 * draw(), f = 0.2 + 0.7 * draw();
    const house: HouseParams = {heatLoss, ci, cm, rim: (0.5 + 1.5 * draw()) / ci, f, sun: 0, sunE: 0, sunW: 0, gains: 0.1 + 0.3 * draw()};
    const flat = 0.6 + 0.6 * draw(), lagH = 0.5 + 4 * f * draw(), offset = (draw() * 2 - 1) * OFFSET;
    const tau = (ci + cm) / heatLoss;
    heavy.push(tau > 150);
    const tauModel = tau * (0.6 + 0.8 * draw());
    for (const v of variants) res.get(v.name)!.push(run(house, flat, offset, lagH, tauModel, v, noise));
}
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
console.log(`${HOUSES} houses (${heavy.filter(Boolean).length} heavy, τ > 150 h), ${WEATHER}, curve level ±${OFFSET} K, model ready day ${READY}.`);
console.log('Worst day |indoor mean − target| K, median / p90 / max over houses, per period:');
const span = (d: number[], a: number, b: number) => Math.max(...d.slice(a, b).map(Math.abs));
for (const v of variants) {
    const r = res.get(v.name)!;
    const show = (a: number, b: number) => { const w = r.map((d) => span(d, a, b)); return `${pct(w, .5).toFixed(2)}/${pct(w, .9).toFixed(2)}/${Math.max(...w).toFixed(2)}`; };
    // Overshoot: the worst day past the target in the direction opposite to the first day's error.
    const over = r.map((d) => { const s = Math.sign(d[1]); return Math.max(0, ...d.slice(1).map((e) => -s * e)); });
    const overHeavy = over.filter((_, i) => heavy[i]);
    console.log(v.name.padEnd(20), 'days 1-5', show(1, 6).padEnd(16), 'days 6-14', show(6, 15).padEnd(16),
        'overshoot p90/max', `${pct(over, .9).toFixed(2)}/${Math.max(...over).toFixed(2)}`,
        ' heavy', `${pct(overHeavy, .9).toFixed(2)}/${Math.max(...overHeavy).toFixed(2)}`);
}
const bare = res.get('bare until ready')!;
for (const v of variants.slice(1)) {
    const r = res.get(v.name)!, rms = (d: number[]) => Math.sqrt(mean(d.slice(1).map((e) => e * e)));
    const worse = r.map((d, i) => rms(d) - rms(bare[i])).filter((x) => x > 0.05);
    console.log(`${v.name} vs bare: better on ${r.filter((d, i) => rms(d) < rms(bare[i]) - 0.05).length}, worse on ${worse.length}`
        + (worse.length ? ` (by at most ${Math.max(...worse).toFixed(2)} K rms)` : ''));
    const stuck = r.filter((d) => Math.abs(d.at(-1)!) > MAX_ERROR).length;
    console.log(`  still beyond ${MAX_ERROR} K on day 14: ${stuck} houses`);
}
