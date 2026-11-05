/** The pump's heat curve, learned from what it reports. Pure.
 *  Design: docs/smart-heating-plan.md §3.3, §4.5.
 *
 *  The planner moves heat by feeding BT1, and how much supply 1 K of feed moves is the slope of
 *  the heat curve where the feed lands. That slope is not one number: on the S1155 at curve 5 it
 *  measured 0.44 from 5 to 20 K colder than real and 0.45 → 0.77 from 5 to 20 K warmer (§3.3),
 *  and it changes with the curve, the offset and the min/max supply. The pump never states the
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
/** Smoothness: a knot without points of its own follows its neighbours. */
const SMOOTH = 0.5;

export interface CurvePoint {
    /** What the curve saw: BT1 through its filter, °C. */
    x: number;
    /** Calculated supply, °C. */
    supply: number;
}

export interface SupplyCurve {
    /** Knot positions, °C of what the curve sees, ascending and KNOT_K apart. */
    knots: number[];
    /** Supply at each knot, never rising with x. */
    supply: number[];
    points: number;
}

/** The settings that shape the curve; a change to any of them starts a new one. */
const SETTINGS = ['hcurve', 'hoffset', 'supmin', 'supmax'] as const;

/** Points from the history since the curve's settings last changed, from slots with room-sensor
 *  control off. The filtered view restarts after any gap or partial slot; room control does not
 *  restart it, since the curve's filter runs either way. */
export function curvePoints(history: History): CurvePoint[] {
    const slots = history.range();
    let points: CurvePoint[] = [];
    const settings = new Map<string, number>();
    let x: number | undefined;
    let last: number | undefined;
    let warm = 0;
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
            points.push({x, supply: v.tcalc});
    }
    return points;
}

/** Piecewise-linear supply over knots KNOT_K apart, least squares with a smoothness penalty, then
 *  made non-increasing. Undefined until there are MIN_POINTS over MIN_SPAN_K. */
export function fitSupplyCurve(points: CurvePoint[]): SupplyCurve | undefined {
    const usable = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.supply));
    if (usable.length < MIN_POINTS) return undefined;
    const lo = Math.min(...usable.map((p) => p.x));
    const hi = Math.max(...usable.map((p) => p.x));
    if (hi - lo < MIN_SPAN_K) return undefined;
    const first = Math.floor(lo / KNOT_K) * KNOT_K;
    const knots: number[] = [];
    for (let k = first; k < hi + KNOT_K; k += KNOT_K) knots.push(k);
    const n = knots.length;
    const A = Array.from({length: n}, () => new Array(n).fill(0));
    const b = new Array(n).fill(0);
    const weight = new Array(n).fill(0);
    for (const p of usable) {
        const j = Math.min(n - 2, Math.floor((p.x - first) / KNOT_K));
        const t = (p.x - knots[j]) / KNOT_K;
        const idx = [j, j + 1];
        const w = [1 - t, t];
        for (let a = 0; a < 2; a++) {
            b[idx[a]] += w[a] * p.supply;
            weight[idx[a]] += w[a];
            for (let c = 0; c < 2; c++) A[idx[a]][idx[c]] += w[a] * w[c];
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
    return {knots, supply: nonIncreasing(s, weight.map((w) => w + 1e-3)), points: usable.length};
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
    return `heat curve ${knots[0]}…${knots.at(-1)} °C (${curve.points} slots), gain per 4 K ${gains.join(' ') || '-'}`;
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
