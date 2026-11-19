// The holding trim with the price planner on top: does the trim fight the planner's pre-heats and
// coasts, and what does it do to the cost? Offline, no pump. Companion to dev/simulate-trim.ts.
//
// Each house is the app's 2R2C model heated through a heat curve that is wrong by a random amount;
// the curve sees the fed BT1 through its own filter (actuator.ts `curveInput`) and the radiators
// deliver through a lag. The planner (planner.ts `planShift`) runs every `--every` hours with a
// profile's limits, a 24 h look-ahead, perfect weather, a price day with morning and evening peaks,
// and the model's numbers off (heat loss ±20 %, gains ±50 %, the curve's lever ±30 %). Fed bias =
// trim + the plan's shift, as live.ts feeds it. Scored per day: the indoor mean against the
// target, and the heat bought at its price.
//
//   npx tsx dev/simulate-trim-planner.ts [--houses 20] [--seed 7] [--every 2]
import {HouseParams, envelopeTau, stepHouse} from '../lib/autopilot/model';
import {TrimState, nextTrim} from '../lib/autopilot/setpoint';
import {ForecastSlot, planShift} from '../lib/autopilot/planner';
import {PROFILE_LIMITS} from '../lib/autopilot/live';
import {curveInput} from '../lib/autopilot/actuator';

const arg = (name: string, fallback: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
};
const HOUSES = Number(arg('houses', '20')), SEED = Number(arg('seed', '7')), EVERY = Number(arg('every', '2'));
const SP = 22.5, SLOT_H = 0.25, DAYS = 21, SETTLE_DAYS = 20;
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

function outdoor(k: number): number {
    const d = k / 96, day = 2.5 * Math.sin(2 * Math.PI * ((k % 96) / 96 - 0.375));
    const base = d < 4 ? 5 : d < 7 ? 5 - (10 / 3) * (d - 4) : d < 13 ? -5 : d < 16 ? -5 + (13 / 3) * (d - 13) : 8;
    return base + day;
}
/** kr/kWh: a night low, a morning peak 07–09 and an evening peak 17–20, varying a little by day. */
function price(k: number): number {
    const h = (k % 96) / 4, d = Math.floor(k / 96);
    return 1 + 0.15 * Math.sin(d * 1.7) + (h >= 7 && h < 9 ? 1.2 : 0) + (h >= 17 && h < 20 ? 1.6 : 0) - (h < 5 ? 0.3 : 0);
}
function rng(seed: number) {
    let s = seed >>> 0;
    return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

type Trim = 'none' | 'before' | 'shipped';
function integralOnly(state: TrimState, error: number, hours: number): {trim: number; state: TrimState} {
    const integral = Math.abs(error) <= 1 ? state.integral + 0.02 * error * hours : state.integral;
    return {trim: integral, state: {integral}};
}

function run(house: HouseParams, model: HouseParams, flat: number, lever: number, lagH: number, profile: keyof typeof PROFILE_LIMITS, trim: Trim) {
    const limits = PROFILE_LIMITS[profile];
    const c = flat * house.heatLoss, base = 5 + (house.heatLoss * (SP - 5) - house.gains) / c;
    const demand = (curve: number) => Math.max(0, c * (base - curve));
    let ti = SP, tm = SP, curve = 5, delivered = demand(5);
    for (let k = 0; k < SETTLE_DAYS * 96; k++) [ti, tm] = stepHouse(house, ti, tm, {te: 5, q: delivered * SLOT_H, sun: 0});
    const follow = 1 - Math.exp(-SLOT_H / lagH);
    const seen: number[] = [], days: number[] = [];
    let state: TrimState = {integral: 0}, applied = 0, shift: number[] = [], shiftAt = 0, cost = 0, bias = 0, moved = 0;
    for (let k = 0; k < DAYS * 96; k++) {
        const te = outdoor(k);
        seen.push(ti);
        if (k >= 96 && trim !== 'none') {
            const error = SP - mean(seen.slice(-96));
            const next = trim === 'shipped'
                ? nextTrim(state, {setpoint: SP, mean: mean(seen.slice(-96)), hours: SLOT_H, integrate: true, tauHours: envelopeTau(model)})
                : integralOnly(state, error, SLOT_H);
            state = next.state;
            applied = Math.round(next.trim * 10) / 10;
        }
        if (k % (EVERY * 4) === 0) {
            const forecast: ForecastSlot[] = Array.from({length: 96}, (_, j) => ({te: outdoor(k + j), sun: 0, price: price(k + j)}));
            const plan = planShift(model, SP, {ti, tm, curve, bias: bias - applied}, forecast, limits, {lever}, undefined, 400);
            shift = plan.shift;
            shiftAt = k;
        }
        const planned = shift[k - shiftAt] ?? 0;
        bias = applied + planned;
        moved += Math.abs(planned);
        curve = curveInput(curve, te - bias);
        delivered += follow * (demand(curve) - delivered);
        cost += delivered * SLOT_H * price(k);
        [ti, tm] = stepHouse(house, ti, tm, {te, q: delivered * SLOT_H, sun: 0});
        if (k >= 4 * 96 && k % 96 === 95) days.push(SP - mean(seen.slice(-96)));
    }
    return {rms: Math.sqrt(mean(days.map((d) => d * d))), worst: Math.max(...days.map(Math.abs)), cost, shift: moved / (DAYS * 96)};
}

const draw = rng(SEED);
const profiles = Object.keys(PROFILE_LIMITS) as (keyof typeof PROFILE_LIMITS)[];
const trims: Trim[] = ['none', 'before', 'shipped'];
const out = new Map<string, {rms: number[]; worst: number[]; cost: number[]; shift: number[]}>();
for (let n = 0; n < HOUSES; n++) {
    const heatLoss = 0.08 + 0.27 * draw(), ci = 0.8 + 1.5 * draw(), cm = 4 + 14 * draw(), f = 0.2 + 0.7 * draw();
    const house: HouseParams = {heatLoss, ci, cm, rim: (0.5 + 1.5 * draw()) / ci, f, sun: 0, sunE: 0, sunW: 0, gains: 0.1 + 0.3 * draw()};
    const flat = 0.6 + 0.6 * draw(), lagH = 0.5 + 4 * f * draw();
    const model: HouseParams = {...house, heatLoss: heatLoss * (0.8 + 0.4 * draw()), gains: house.gains * (0.5 + draw())};
    const lever = flat * heatLoss * (0.7 + 0.6 * draw());
    for (const profile of profiles) for (const trim of trims) {
        const r = run(house, model, flat, lever, lagH, profile, trim);
        const key = `${profile}|${trim}`;
        const o = out.get(key) ?? out.set(key, {rms: [], worst: [], cost: [], shift: []}).get(key)!;
        o.rms.push(r.rms); o.worst.push(r.worst); o.cost.push(r.cost); o.shift.push(r.shift);
    }
    process.stderr.write('.');
}
process.stderr.write('\n');
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
console.log(`${HOUSES} houses with the planner every ${EVERY} h, seed ${SEED}. Daily indoor mean against the target, K; cost against no trim.`);
console.log('profile'.padEnd(12), 'trim'.padEnd(9), 'median rms', ' p90 rms', ' worst day max', ' cost vs none', ' mean |shift| K');
for (const profile of profiles) {
    const none = out.get(`${profile}|none`)!;
    for (const trim of trims) {
        const o = out.get(`${profile}|${trim}`)!;
        const costRatio = mean(o.cost.map((v, i) => v / none.cost[i] - 1));
        console.log(profile.padEnd(12), trim.padEnd(9), pct(o.rms, 0.5).toFixed(2).padStart(10), pct(o.rms, 0.9).toFixed(2).padStart(8),
            Math.max(...o.worst).toFixed(2).padStart(14), `${(costRatio * 100).toFixed(1)} %`.padStart(13), mean(o.shift).toFixed(2).padStart(15));
    }
    const before = out.get(`${profile}|before`)!, now = out.get(`${profile}|shipped`)!;
    console.log(''.padEnd(22), `shipped vs before: better on ${now.rms.filter((v, i) => v < before.rms[i] - 0.05).length}, `
        + `worse on ${now.rms.filter((v, i) => v > before.rms[i] + 0.05).length} of ${HOUSES}`);
}
