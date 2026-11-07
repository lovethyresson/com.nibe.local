/** The pump's heat curve, learned from what it reports. Pure.
 *  Design: docs/autopilot-plan.md §3.3, §4.5.
 *
 *  The planner moves heat by feeding BT1, and how much supply 1 K of feed moves is the slope of
 *  the heat curve where the feed lands. That slope is not one number: on the S1155 at curve 5 it
 *  measured 0.44 from 5 to 20 K colder than real and 0.45 → 0.77 from 5 to 20 K warmer (§3.3),
 *  and it changes with the curve and the min/max supply. The pump never states the
 *  curve's shape, but it reports the curve's output: calculated supply (1017) for what the curve
 *  sees, BT1 through its ~49 min filter. Each slot is a point on the curve; normal weather traces
 *  it over the outdoor range the house meets, and every feed samples it further out.
 *
 *  Only slots with room-sensor control known to be off are points. While it is on, 1017 carries
 *  the room loop's correction too, and on the S1155 that correction integrates: on 2026-11-03,
 *  after a coast, 1017 climbed 34 → 49 °C at a steady BT1 while indoor closed in on its setpoint,
 *  and stayed there with indoor above it. No term in indoor's distance from the setpoint
 *  describes that, and left in it would read as a curve ~15 K too high. */
import {FLAG, History, roomControlOff} from './history';
import {CURVE_TAU_H, curveInput} from './actuator';

/** Supply K per K of what the curve sees, before a curve is learned (§3.1 measured 0.50). */
export const DEFAULT_GAIN = 0.5;
const KNOT_K = 2;
const SLOT_H = 0.25;
/** Slots after a gap before the filtered view is trusted again: ~1.2 τ. */
const WARMUP_SLOTS = 4;
/** A curve needs half a day of points spread over at least this many K of what it saw. */
export const MIN_POINTS = 48;
export const MIN_SPAN_K = 3;
/** An earlier offset's points join the fit only with this many of them, sharing at least
 *  OVERLAP_K of what the curve saw with the points already in it (or all of the shorter range,
 *  when one is shorter: an offset set an hour ago has traced little yet): the shift is read where
 *  both offsets traced the same stretch, not inferred from two ends of the curve. */
const MIN_GROUP = 8;
const OVERLAP_K = 1;
/** Supply K per offset step outside this range is a fit gone wrong, not a curve. */
const OFFSET_GAIN_RANGE = [0.2, 5] as const;
/** Smoothness: a knot without points of its own follows its neighbours. */
const SMOOTH = 0.5;

export interface CurvePoint {
    /** What the curve saw: BT1 through its filter, °C. */
    x: number;
    /** Calculated supply, °C. */
    supply: number;
    /** The curve offset (30) the slot ran at; the last one read when the slot didn't read it. */
    offset?: number;
}

export interface SupplyCurve {
    /** Knot positions, °C of what the curve sees, ascending and KNOT_K apart. */
    knots: number[];
    /** Supply at each knot, never rising with x. */
    supply: number[];
    points: number;
    /** Supply K per offset step, when points at more than one offset were fitted together. The
     *  curve itself is at the offset of the newest point. */
    offsetGain?: number;
}

/** The settings that shape the curve; a change to any of them starts a new one. The offset is
 *  not among them: it shifts the whole curve by a fixed amount per step, which the fit learns
 *  (measured on the S1155 at curve 5, 2026-11-04…07: offsets 2, 3 and 5 fitted jointly as one
 *  curve plus 1.53 K per step, 0.05 K RMS, the same as each offset fitted alone). */
const SETTINGS = ['hcurve', 'supmin', 'supmax'] as const;

/** Points from the history since the curve's shape last changed, from slots with room-sensor
 *  control off, each tagged with its offset. The filtered view restarts after any gap or
 *  partial slot; room control does not restart it, since the curve's filter runs either way. */
export function curvePoints(history: History): CurvePoint[] {
    const slots = history.range();
    let points: CurvePoint[] = [];
    const settings = new Map<string, number>();
    let x: number | undefined;
    let last: number | undefined;
    let warm = 0;
    let offset: number | undefined;
    for (const slot of slots) {
        const v = history.get(slot)!;
        // Only a setting read before and read differently now is a change. One that stops or
        // starts answering is not: the S1155 refuses the offset (30) while room-sensor control
        // is on, and switching that is no reason to forget the curve.
        for (const k of SETTINGS) {
            if (!Number.isFinite(v[k])) continue;
            if (settings.has(k) && settings.get(k) !== v[k]) points = [];
            settings.set(k, v[k]);
        }
        if (Number.isFinite(v.hoffset)) offset = v.hoffset;
        const bt1 = v.bt1;
        if (!Number.isFinite(bt1) || (v.flags & FLAG.partial) || last === undefined || slot !== last + 1 || x === undefined) {
            x = Number.isFinite(bt1) ? bt1 : undefined;
            warm = 0;
        } else {
            x = curveInput(x, bt1, SLOT_H, CURVE_TAU_H);
            warm++;
        }
        last = slot;
        if (x !== undefined && warm >= WARMUP_SLOTS && roomControlOff(v) && Number.isFinite(v.tcalc))
            points.push(offset === undefined ? {x, supply: v.tcalc} : {x, supply: v.tcalc, offset});
    }
    return points;
}

/** Piecewise-linear supply over knots KNOT_K apart, least squares with a smoothness penalty, then
 *  made non-increasing. Points at earlier offsets are fitted together with the newest ones as the
 *  same curve plus a learned shift per offset step, and the curve returned is at the newest
 *  offset. Undefined until there are MIN_POINTS over MIN_SPAN_K. */
export function fitSupplyCurve(points: CurvePoint[]): SupplyCurve | undefined {
    const finite = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.supply));
    if (finite.length === 0) return undefined;
    const current = finite.at(-1)!.offset;
    const joint = jointPoints(finite, current);
    if (joint.length > 0) {
        const fit = solveCurve(joint, current);
        if (fit && fit.offsetGain !== undefined
            && fit.offsetGain >= OFFSET_GAIN_RANGE[0] && fit.offsetGain <= OFFSET_GAIN_RANGE[1]) return fit;
    }
    // One offset, or a shift that didn't fit: only the newest offset's points describe the curve.
    return solveCurve(finite.filter((p) => p.offset === current), current);
}

/** The points of every offset that overlaps the fit, when more than one offset does; else none. */
function jointPoints(points: CurvePoint[], current: number | undefined): CurvePoint[] {
    if (current === undefined) return [];
    const groups = new Map<number, CurvePoint[]>();
    for (const p of points) if (p.offset !== undefined) groups.set(p.offset, [...groups.get(p.offset) ?? [], p]);
    if (groups.size < 2) return [];
    const range = (g: CurvePoint[]) => [Math.min(...g.map((p) => p.x)), Math.max(...g.map((p) => p.x))];
    const kept = new Set([current]);
    let [lo, hi] = range(groups.get(current)!);
    for (let added = true; added;) {
        added = false;
        for (const [offset, g] of groups) {
            if (kept.has(offset) || g.length < MIN_GROUP) continue;
            const [a, b] = range(g);
            if (Math.min(b, hi) - Math.max(a, lo) < Math.min(OVERLAP_K, b - a, hi - lo)) continue;
            kept.add(offset);
            [lo, hi] = [Math.min(lo, a), Math.max(hi, b)];
            added = true;
        }
    }
    return kept.size < 2 ? [] : points.filter((p) => p.offset !== undefined && kept.has(p.offset));
}

function solveCurve(usable: CurvePoint[], current: number | undefined): SupplyCurve | undefined {
    if (usable.length < MIN_POINTS) return undefined;
    const lo = Math.min(...usable.map((p) => p.x));
    const hi = Math.max(...usable.map((p) => p.x));
    if (hi - lo < MIN_SPAN_K) return undefined;
    const first = Math.floor(lo / KNOT_K) * KNOT_K;
    const knots: number[] = [];
    for (let k = first; k < hi + KNOT_K; k += KNOT_K) knots.push(k);
    const n = knots.length;
    // One more unknown, the supply per offset step, when the points span more than one offset.
    const shift = (p: CurvePoint) => (p.offset === undefined || current === undefined ? 0 : p.offset - current);
    const shifted = usable.some((p) => shift(p) !== 0);
    const m = shifted ? n + 1 : n;
    const A = Array.from({length: m}, () => new Array(m).fill(0));
    const b = new Array(m).fill(0);
    const weight = new Array(n).fill(0);
    for (const p of usable) {
        const j = Math.min(n - 2, Math.floor((p.x - first) / KNOT_K));
        const t = (p.x - knots[j]) / KNOT_K;
        const idx = [j, j + 1];
        const w = [1 - t, t];
        if (shifted) {
            idx.push(n);
            w.push(shift(p));
        }
        for (let a = 0; a < idx.length; a++) {
            b[idx[a]] += w[a] * p.supply;
            if (a < 2) weight[idx[a]] += w[a];
            for (let c = 0; c < idx.length; c++) A[idx[a]][idx[c]] += w[a] * w[c];
        }
    }
    const lambda = SMOOTH * usable.length / n;
    for (let j = 1; j + 1 < n; j++) {
        const d = [j - 1, j, j + 1];
        const c = [1, -2, 1];
        for (let a = 0; a < 3; a++) for (let e = 0; e < 3; e++) A[d[a]][d[e]] += lambda * c[a] * c[e];
    }
    // With two knots there is no curvature to penalise; a tiny ridge keeps an empty knot defined.
    for (let j = 0; j < n; j++) A[j][j] += 1e-6 * (usable.length / n);
    const s = solve(A, b);
    if (!s) return undefined;
    const curve: SupplyCurve = {knots, supply: nonIncreasing(s.slice(0, n), weight.map((w) => w + 1e-3)), points: usable.length};
    if (shifted) curve.offsetGain = s[n];
    return curve;
}

/** Supply where the curve sees `x`; beyond the learned knots the end segment carries on. */
export function supplyAt(curve: SupplyCurve, x: number): number {
    const {knots, supply} = curve;
    const n = knots.length;
    const j = Math.max(0, Math.min(n - 2, Math.floor((x - knots[0]) / KNOT_K)));
    const t = (x - knots[j]) / KNOT_K;
    return supply[j] + t * (supply[j + 1] - supply[j]);
}

/** Supply K per K over [a, b] (a ≠ b), positive when supply falls as the curve sees warmer. */
export function gainBetween(curve: SupplyCurve | undefined, a: number, b: number): number {
    if (!curve || a === b) return DEFAULT_GAIN;
    return (supplyAt(curve, a) - supplyAt(curve, b)) / (b - a);
}

/** One line for the app log: the learned range and the gain over each 4 K of it. */
export function curveLine(curve: SupplyCurve | undefined): string {
    if (!curve) return 'heat curve learning';
    const {knots} = curve;
    const gains: string[] = [];
    for (let a = knots[0]; a + 2 * KNOT_K <= knots.at(-1)!; a += 2 * KNOT_K) gains.push(gainBetween(curve, a, a + 2 * KNOT_K).toFixed(2));
    const offset = curve.offsetGain === undefined ? '' : `, ${curve.offsetGain.toFixed(2)} K per offset step`;
    return `heat curve ${knots[0]}…${knots.at(-1)} °C (${curve.points} slots), gain per 4 K ${gains.join(' ') || '-'}${offset}`;
}

// Gaussian elimination with partial pivoting; undefined when singular.
function solve(A: number[][], b: number[]): number[] | undefined {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
        if (Math.abs(M[p][c]) < 1e-12) return undefined;
        [M[c], M[p]] = [M[p], M[c]];
        for (let r = 0; r < n; r++) {
            if (r === c) continue;
            const f = M[r][c] / M[c][c];
            for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
        }
    }
    return M.map((row, i) => row[n] / row[i]);
}

// Pool-adjacent-violators: the weighted closest non-increasing sequence.
function nonIncreasing(values: number[], weights: number[]): number[] {
    const blocks: {v: number; w: number; n: number}[] = [];
    values.forEach((v, i) => {
        blocks.push({v, w: weights[i], n: 1});
        while (blocks.length > 1 && blocks.at(-2)!.v < blocks.at(-1)!.v) {
            const b = blocks.pop()!;
            const a = blocks.pop()!;
            blocks.push({v: (a.v * a.w + b.v * b.w) / (a.w + b.w), w: a.w + b.w, n: a.n + b.n});
        }
    });
    return blocks.flatMap((b) => new Array(b.n).fill(b.v));
}

/** What the curve must see for `supply`: the inverse of `supplyAt`, end segments carried on. On a
 *  flat stretch (min or max supply) any x there gives the same supply; the end nearer the rest of
 *  the curve is returned, so a feed never goes further than it has to. Undefined when the curve
 *  is flat everywhere. */
export function curveInputFor(curve: SupplyCurve, supply: number): number | undefined {
    const {knots, supply: s} = curve;
    const n = knots.length;
    if (s[0] - s[n - 1] < 1e-9) return undefined;
    // Above the first knot's supply: carry the first sloped segment on to the left.
    if (supply >= s[0]) {
        const j = s.findIndex((v, i) => i > 0 && s[i - 1] - v > 1e-9);
        // A flat top is max supply: nothing colder gives more.
        if (j > 1) return knots[j - 1];
        const slope = (s[j - 1] - s[j]) / KNOT_K;
        return knots[j - 1] - (supply - s[j - 1]) / slope;
    }
    if (supply <= s[n - 1]) {
        let j = n - 1;
        while (j > 0 && s[j - 1] - s[j] <= 1e-9) j--;
        const slope = (s[j - 1] - s[j]) / KNOT_K;
        // On the flat floor any x past the last sloped knot gives min supply: stop where it starts.
        return j === n - 1 ? knots[j] + (s[j] - supply) / slope : knots[j];
    }
    for (let j = 0; j + 1 < n; j++) {
        if (supply <= s[j] && supply >= s[j + 1]) {
            if (s[j] - s[j + 1] <= 1e-9) return knots[j];
            return knots[j] + (s[j] - supply) / (s[j] - s[j + 1]) * KNOT_K;
        }
    }
    return undefined;
}
