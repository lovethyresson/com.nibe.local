/** The house model the planner predicts with. Pure: no timers, no I/O.
 *  Design: docs/autopilot-plan.md §6.
 *
 *  Two stages:
 *  1. A 1R1C ARX fitted by recursive least squares, reported alongside. Stage 2's heat-loss
 *     starting point is the warm-up's energy balance instead (`balanceHeatLoss`).
 *  2. A 2R2C grey-box model, states [ti, tm] (air and mass), with its parameters learned by an
 *     augmented extended Kalman filter. Its starting point comes from the owner's two Setup
 *     answers (§6.6).
 *
 *  Both learn from *delivered* heat (1577, see heat.ts), so the BT1 → supply lag (τ ≈ 49 min,
 *  §4.5) is not in here: that is the actuator stage in front of the house, which the planner
 *  models separately. Lumping it in would credit a radiator house with storage it lacks.
 *
 *  Units: hours, °C, kW, kWh, W/m². */

export const SLOT_H = 0.25;

// ---- small dense matrix helpers (n ≤ 9) ----

type Mat = number[][];
const zeros = (r: number, c: number): Mat => Array.from({length: r}, () => new Array(c).fill(0));
const eye = (n: number): Mat => zeros(n, n).map((row, i) => { row[i] = 1; return row; });
const mul = (a: Mat, b: Mat): Mat => a.map((row) => b[0].map((_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)));
const transpose = (a: Mat): Mat => a[0].map((_, j) => a.map((row) => row[j]));
const add = (a: Mat, b: Mat): Mat => a.map((row, i) => row.map((v, j) => v + b[i][j]));
const symmetrise = (a: Mat): Mat => a.map((row, i) => row.map((v, j) => (v + a[j][i]) / 2));

// ---- stage 1: 1R1C ARX by RLS ----

/** ti[k+1] = a·ti + b·te + c·q + d·sun + e, with q in kWh per slot.
 *
 *  The history holds slot *means*, and a slot's heat shows up partly in the next slot's mean, so
 *  the inputs are the mean of the two slots (see `rlsRegressors`). Without that the heat loss
 *  reads 6–10 % high on a noiseless simulated house; with it, exact. The time constant stays
 *  biased low by sensor noise (errors in the ti regressor: −50 % at 0.03 K), so its τ is never
 *  shown, and over a short warm-up its heat loss is too erratic to seed stage 2 with. */
export interface Rls {
    theta: number[];
    P: Mat;
    lambda: number;
    n: number;
}

export function newRls(lambda = 0.998): Rls {
    return {theta: [0.9, 0.1, 0, 0, 0], P: eye(5).map((r) => r.map((v) => v * 100)), lambda, n: 0};
}

export function rlsRegressors(previous: ModelSlot, slot: ModelSlot): number[] {
    const mean = (k: 'te' | 'q') => (previous.inputs[k] + slot.inputs[k]) / 2;
    return [previous.ti, mean('te'), mean('q'), (totalSun(previous.inputs) + totalSun(slot.inputs)) / 2, 1];
}

/** Stage 1 has one sun term: the three walls summed. */
const totalSun = (u: Inputs) => u.sun + (u.sunE ?? 0) + (u.sunW ?? 0);

export function rlsUpdate(rls: Rls, x: number[], y: number): Rls {
    const Px = rls.P.map((row) => row.reduce((s, v, j) => s + v * x[j], 0));
    const denom = rls.lambda + x.reduce((s, v, i) => s + v * Px[i], 0);
    const k = Px.map((v) => v / denom);
    const error = y - x.reduce((s, v, i) => s + v * rls.theta[i], 0);
    const theta = rls.theta.map((t, i) => t + k[i] * error);
    const P = symmetrise(rls.P.map((row, i) => row.map((v, j) => (v - k[i] * Px[j]) / rls.lambda)));
    return {theta, P, lambda: rls.lambda, n: rls.n + 1};
}

export interface FirstOrderHouse {
    /** Envelope time constant, h. */
    tau: number;
    /** Heat loss, kW per K. */
    heatLoss: number;
    /** Stored heat, kWh per K. */
    capacity: number;
    /** Solar gain, kW per W/m² summed over the three walls. */
    sun: number;
}

/** The physical reading of the ARX, or undefined while it is not yet plausible. Only
 *  `heatLoss` is trustworthy; see the note on `Rls`. */
export function rlsHouse(rls: Rls): FirstOrderHouse | undefined {
    const [a, b, c, d] = rls.theta;
    if (!(a > 0 && a < 1 && b > 0 && c > 0)) return undefined;
    const tau = -SLOT_H / Math.log(a);
    const heatLoss = b / (SLOT_H * c);
    return {tau, heatLoss, capacity: tau * heatLoss, sun: d / (SLOT_H * c)};
}

// ---- stage 2: 2R2C by augmented EKF ----

/**
 *  Ci dti/dt = (te − ti)/Rie + (tm − ti)/Rim + (1 − f)·P + Σ Aw·sun + Φ
 *  Cm dtm/dt = (ti − tm)/Rim + f·P
 *
 *  The sun term has one window area per wall (east, south, west), so a house whose windows face
 *  west learns that its sun arrives in the afternoon, and one with few windows learns little sun
 *  at all. The walls' irradiance is correlated (one sun), so each area is only told apart on days
 *  when the sun shows at different hours; until then they stay near the prior's split.
 *
 *  Learned in log space (f in logit space) so every parameter stays positive (f in 0..1):
 *  p = [1/(Ci·Rie), 1/(Ci·Rim), 1/(Cm·Rim), 1/Ci, AwS, f, Φ, AwE, AwW]. The window areas and the
 *  gains are absolute, not per Ci like the rates: a wall with no sun yet would otherwise drift
 *  with every change in Ci, and report sun the house never had; and the gains' prior has to pin
 *  the gains themselves (see `GAINS_SD`).
 */
export const PARAMS = ['ie', 'im', 'mi', 'invCi', 'sun', 'f', 'gains', 'sunE', 'sunW'] as const;
const NS = 2;
const NP = PARAMS.length;
const NZ = NS + NP;

export interface HouseParams {
    /** Heat loss through the envelope, kW per K (1/Rie). */
    heatLoss: number;
    /** Air and light furniture, kWh per K. */
    ci: number;
    /** Building mass, kWh per K. */
    cm: number;
    /** Air ↔ mass resistance, K per kW. */
    rim: number;
    /** Share of delivered heat that goes into the mass first (underfloor high, radiators low). */
    f: number;
    /** Solar aperture, kW per W/m², of the south, east and west walls. */
    sun: number;
    sunE: number;
    sunW: number;
    /** Internal gains, kW. */
    gains: number;
}

export function envelopeTau(p: HouseParams): number {
    return (p.ci + p.cm) / p.heatLoss;
}

const logit = (x: number) => Math.log(x / (1 - x));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function toVector(p: HouseParams): number[] {
    const rates = [1 / (p.ci / p.heatLoss), 1 / (p.ci * p.rim), 1 / (p.cm * p.rim), 1 / p.ci, p.sun];
    return [...rates.map(Math.log), logit(p.f), Math.log(p.gains), Math.log(p.sunE), Math.log(p.sunW)];
}

function fromVector(v: number[]): HouseParams {
    const [ie, im, mi, invCi, sun] = v.slice(0, 5).map(Math.exp);
    const ci = 1 / invCi;
    const rim = 1 / (ci * im);
    return {heatLoss: ie * ci, ci, cm: 1 / (mi * rim), rim, f: sigmoid(v[5]), sun, gains: Math.exp(v[6]),
        sunE: Math.exp(v[7]), sunW: Math.exp(v[8])};
}

export interface Inputs {
    te: number;
    /** Delivered heat this slot, kWh. */
    q: number;
    /** Irradiance on the south wall, W/m²; east and west when known (missing reads as no sun). */
    sun: number;
    sunE?: number;
    sunW?: number;
}

/** kW of sun through the windows. */
export function solarGain(p: HouseParams, u: Inputs): number {
    return p.sun * u.sun + p.sunE * (u.sunE ?? 0) + p.sunW * (u.sunW ?? 0);
}

/** One exact zero-order-hold step of the 2R2C model over `dt` hours. */
export function stepHouse(p: HouseParams, ti: number, tm: number, u: Inputs, dt = SLOT_H): [number, number] {
    const P = u.q / SLOT_H;
    const a11 = -(1 / p.rim + p.heatLoss) / p.ci, a12 = 1 / (p.rim * p.ci);
    const a21 = 1 / (p.rim * p.cm), a22 = -1 / (p.rim * p.cm);
    const b1 = (p.heatLoss * u.te + (1 - p.f) * P + solarGain(p, u) + p.gains) / p.ci;
    const b2 = p.f * P / p.cm;
    // expm(A·dt) for a 2×2 with real eigenvalues: e^{s·dt}[cosh(d·dt)·I + sinh(d·dt)/d·(A − s·I)].
    const s = (a11 + a22) / 2;
    const d = Math.sqrt(Math.max(0, ((a11 - a22) / 2) ** 2 + a12 * a21));
    const es = Math.exp(s * dt);
    const ch = Math.cosh(d * dt);
    const sh = d > 1e-12 ? Math.sinh(d * dt) / d : dt;
    const e11 = es * (ch + sh * (a11 - s)), e12 = es * sh * a12;
    const e21 = es * sh * a21, e22 = es * (ch + sh * (a22 - s));
    // Γ·u = A⁻¹(e^{A·dt} − I)·b, solved through the 2×2 inverse.
    const m1 = (e11 - 1) * b1 + e12 * b2;
    const m2 = e21 * b1 + (e22 - 1) * b2;
    const det = a11 * a22 - a12 * a21;
    const g1 = (a22 * m1 - a12 * m2) / det;
    const g2 = (-a21 * m1 + a11 * m2) / det;
    return [e11 * ti + e12 * tm + g1, e21 * ti + e22 * tm + g2];
}

// ---- priors from the Setup answers (§6.6) ----

export type HeatingSystem = 'radiators' | 'slab' | 'wooden_floor' | 'both' | 'unknown';
export type BuildEra = 'pre1960' | '1960_1979' | '1980_1999' | '2000_or_later' | 'unknown';

const ERA_TAU: Record<BuildEra, number> = {
    pre1960: 35, '1960_1979': 50, '1980_1999': 62, '2000_or_later': 100, unknown: 50,
};
const SYSTEM: Record<HeatingSystem, {f: number; massShare: number; couplingH: number}> = {
    radiators: {f: 0.4, massShare: 0.8, couplingH: 1},
    wooden_floor: {f: 0.6, massShare: 0.85, couplingH: 2},
    both: {f: 0.6, massShare: 0.85, couplingH: 2},
    slab: {f: 0.8, massShare: 0.9, couplingH: 3},
    unknown: {f: 0.4, massShare: 0.8, couplingH: 1},
};

/** Household gains (people, appliances, lighting), kW: what a Swedish house averages (Sveby: ~30
 *  kWh/m² a year of household electricity, ~70 % of it ending up as heat, plus the people). */
export const GAINS_KW = 0.4;
/** The gains' prior, in log space: about ±40 %, and not widened by unknown answers. Heat loss and
 *  gains trade off exactly while indoor − outdoor stays in a narrow band: on the maintainer's
 *  house (ΔT 15–22 K) gains 0 → 0.8 kW moved heat loss 191 → 236 W/K at almost the same error
 *  (todo.md, 2026-11-09). Loose, the gains soaked up whatever the outdoor sensor got wrong; held
 *  near a household's typical value, the heat loss carries it, which a cold spell then tests. */
export const GAINS_SD = 0.35;

export interface Prior {
    params: HouseParams;
    /** Standard deviation in the learned (log/logit) space, per parameter. */
    sd: number[];
}

/** Where the EKF starts. The heat loss is the one thing the answers can't size, so it comes from
 *  the warm-up's energy balance when there was heating to judge by, else a wide guess. */
export function priorFor(system: HeatingSystem, era: BuildEra, heatLoss?: number): Prior {
    const s = SYSTEM[system];
    const h = heatLoss && heatLoss > 0.02 && heatLoss < 1.5 ? heatLoss : 0.15;
    const total = ERA_TAU[era] * h;
    const ci = total * (1 - s.massShare);
    const params: HouseParams = {
        heatLoss: h, ci, cm: total * s.massShare, rim: s.couplingH / ci, f: s.f, gains: GAINS_KW,
        // ~3 m² of effective glass per wall: a guess the sun corrects within a few clear days.
        sun: 0.003, sunE: 0.003, sunW: 0.003,
    };
    const wide = system === 'unknown' || era === 'unknown' ? 1.4 : 1;
    const hSd = heatLoss ? 0.3 : 0.7;
    const sd = [hSd, 0.8, 0.8, 0.6, 1, 1, 1, 1, 1].map((v) => v * wide);
    sd[PARAMS.indexOf('gains')] = GAINS_SD;
    return {params, sd};
}

// ---- the filter ----

export interface Ekf {
    /** [ti, tm, ...learned parameter vector]. */
    z: number[];
    P: Mat;
    /** Slot the state refers to; undefined before the first reading. */
    slot?: number;
    updates: number;
}

export interface EkfTuning {
    /** Measurement noise of a slot's mean indoor temperature, K. */
    measurementSd: number;
    /** Model error per slot, K, for [ti, tm]. */
    stateSd: [number, number];
    /** Parameter random walk per slot, in log space: how fast the house may change. */
    paramSd: number;
}

export const TUNING: EkfTuning = {measurementSd: 0.05, stateSd: [0.03, 0.01], paramSd: 0.001};

export function newEkf(prior: Prior): Ekf {
    const P = zeros(NZ, NZ);
    P[0][0] = 1;
    P[1][1] = 4;
    prior.sd.forEach((sd, i) => { P[NS + i][NS + i] = sd * sd; });
    return {z: [NaN, NaN, ...toVector(prior.params)], P, updates: 0};
}

export function ekfParams(ekf: Ekf): HouseParams {
    return fromVector(ekf.z.slice(NS));
}

function transition(z: number[], u: Inputs): number[] {
    const [ti, tm] = stepHouse(fromVector(z.slice(NS)), z[0], z[1], u);
    return [ti, tm, ...z.slice(NS)];
}

function jacobian(z: number[], u: Inputs): Mat {
    const F = zeros(NZ, NZ);
    for (let j = 0; j < NZ; j++) {
        const h = j < NS ? 1e-3 : 1e-5;
        const up = [...z]; up[j] += h;
        const down = [...z]; down[j] -= h;
        const fu = transition(up, u), fd = transition(down, u);
        for (let i = 0; i < NZ; i++) F[i][j] = (fu[i] - fd[i]) / (2 * h);
    }
    return F;
}

/** A slot as the model sees it. */
export interface ModelSlot {
    slot: number;
    /** Indoor mean; NaN when missing. */
    ti: number;
    inputs: Inputs;
    /** False skips the measurement update (§6.2) but still runs the prediction. */
    usable: boolean;
}

/** Longest run of missing slots predicted through; anything longer re-anchors on the reading. */
const MAX_GAP = 8;

/** Advance from the state's slot to `slot.slot` with `slot.inputs`, then correct with its indoor
 *  reading when the slot is usable. Inputs of a slot drive the step *into* it, so a slot's
 *  reading is what the previous state, heated by this slot's heat, turned into. */
export function ekfStep(ekf: Ekf, slot: ModelSlot, tuning = TUNING): Ekf {
    const reading = Number.isFinite(slot.ti) ? slot.ti : undefined;
    if (ekf.slot === undefined || !Number.isFinite(ekf.z[0]) || slot.slot - ekf.slot > MAX_GAP || slot.slot <= ekf.slot) {
        if (reading === undefined) return ekf;
        // (Re)anchor: air on the reading, mass assumed alongside it and left uncertain.
        const z = [reading, reading, ...ekf.z.slice(NS)];
        const P = ekf.P.map((row) => [...row]);
        for (let i = 0; i < NZ; i++) { P[0][i] = P[i][0] = 0; P[1][i] = P[i][1] = 0; }
        P[0][0] = tuning.measurementSd ** 2;
        P[1][1] = 1;
        return {z, P, slot: slot.slot, updates: ekf.updates};
    }
    let z = ekf.z;
    let P = ekf.P;
    for (let k = ekf.slot + 1; k <= slot.slot; k++) {
        const F = jacobian(z, slot.inputs);
        z = transition(z, slot.inputs);
        P = mul(mul(F, P), transpose(F));
        P[0][0] += tuning.stateSd[0] ** 2;
        P[1][1] += tuning.stateSd[1] ** 2;
        for (let i = NS; i < NZ; i++) P[i][i] += tuning.paramSd ** 2;
    }
    if (slot.usable && reading !== undefined) {
        const S = P[0][0] + tuning.measurementSd ** 2;
        const K = P.map((row) => row[0] / S);
        const innovation = reading - z[0];
        z = z.map((v, i) => v + K[i] * innovation);
        // P − K·H·P with H = e₀ᵀ.
        P = P.map((row, i) => row.map((v, j) => v - K[i] * P[0][j]));
    }
    return {z, P: symmetrise(P), slot: slot.slot, updates: ekf.updates + (slot.usable && reading !== undefined ? 1 : 0)};
}

// ---- gating (§6.2) ----

/** Indoor faster than this is a window, a fireplace or sun on the sensor, not the house. */
export const MAX_INDOOR_RATE = 1.5; // K/h

export interface GateInput {
    ti: number;
    previousTi?: number;
    partial: boolean;
    /** Fraction of the slot on hot water. */
    dhw: number;
}

export function usableSlot(g: GateInput): boolean {
    if (g.partial || !Number.isFinite(g.ti)) return false;
    if (Number.isFinite(g.dhw) && g.dhw > 0.5) return false;
    if (g.previousTi !== undefined && Number.isFinite(g.previousTi)
        && Math.abs(g.ti - g.previousTi) > MAX_INDOOR_RATE * SLOT_H) return false;
    return true;
}

const orZero = (v?: number) => v !== undefined && Number.isFinite(v) ? v : 0;

/** History rows (heat already spread, see heat.ts) → what the model reads. Slots from before the
 *  east and west walls were recorded read as no sun there, which the south wall then absorbs. */
export function toModelSlots(rows: {slot: number; ti: number; te: number; gtiS: number; gtiE?: number; gtiW?: number;
    dhw: number; partial: boolean; q?: number}[]): ModelSlot[] {
    const sorted = [...rows].sort((a, b) => a.slot - b.slot);
    return sorted.map((r, i) => {
        const previous = sorted[i - 1]?.slot === r.slot - 1 ? sorted[i - 1].ti : undefined;
        const q = r.q ?? 0;
        return {
            slot: r.slot,
            ti: r.ti,
            inputs: {te: r.te, q, sun: orZero(r.gtiS), sunE: orZero(r.gtiE), sunW: orZero(r.gtiW)},
            // An unknown heat amount (the slot before the first counter step) is not a zero.
            usable: r.q !== undefined && Number.isFinite(r.te) && usableSlot({ti: r.ti, previousTi: previous,
                partial: r.partial, dhw: r.dhw}),
        };
    });
}

// ---- quality (§6.4) ----

export const HORIZON_SLOTS = 24; // 6 h

/** Open-loop prediction error at `horizon` slots ahead: start from a filtered state, drive the
 *  model with the measured inputs only, compare with what the sensor read then. Windows with a gap or
 *  an unusable slot are skipped. */
export function predictionRmse(params: HouseParams, slots: ModelSlot[], states: Map<number, [number, number]>,
                               horizon = HORIZON_SLOTS): {rmse: number; windows: number} {
    let sum = 0;
    let n = 0;
    for (let start = 0; start + horizon < slots.length; start += 4) {
        const state = states.get(slots[start].slot);
        if (!state) continue;
        const window = slots.slice(start + 1, start + 1 + horizon);
        if (window.some((s, i) => s.slot !== slots[start].slot + i + 1 || !s.usable)) continue;
        let [ti, tm] = state;
        for (const s of window) [ti, tm] = stepHouse(params, ti, tm, s.inputs);
        sum += (ti - window.at(-1)!.ti) ** 2;
        n += 1;
    }
    return {rmse: n ? Math.sqrt(sum / n) : NaN, windows: n};
}

/** Sun in a window counts as sunny above this mean on the south wall, W/m². */
export const SUNNY_W = 150;

/** The 6 h prediction error over sunny windows only, with the model's sun term as fitted and with
 *  it removed: the sun term earns its place in a plan only when it predicts sunny days better. */
export function sunScore(params: HouseParams, slots: ModelSlot[], states: Map<number, [number, number]>,
                         horizon = HORIZON_SLOTS): {windows: number; rmseOn: number; rmseOff: number} {
    const noSun = {...params, sun: 0, sunE: 0, sunW: 0};
    let on = 0, off = 0, n = 0;
    for (let start = 0; start + horizon < slots.length; start += 4) {
        const state = states.get(slots[start].slot);
        if (!state) continue;
        const window = slots.slice(start + 1, start + 1 + horizon);
        if (window.some((s, i) => s.slot !== slots[start].slot + i + 1 || !s.usable)) continue;
        if (window.reduce((sum, s) => sum + s.inputs.sun, 0) / window.length < SUNNY_W) continue;
        let [a, am] = state, [b, bm] = state;
        for (const s of window) {
            [a, am] = stepHouse(params, a, am, s.inputs);
            [b, bm] = stepHouse(noSun, b, bm, s.inputs);
        }
        on += (a - window.at(-1)!.ti) ** 2;
        off += (b - window.at(-1)!.ti) ** 2;
        n += 1;
    }
    return {windows: n, rmseOn: n ? Math.sqrt(on / n) : NaN, rmseOff: n ? Math.sqrt(off / n) : NaN};
}

/** Heat loss from the energy balance: heat delivered over degree-hours indoor above outdoor.
 *  It ignores sun, internal gains and what the house stored meanwhile, so it reads low by their
 *  share (10–25 % on the simulated houses), but it never strays far. Stage 1's ARX over the same
 *  three days ranged from 0.06× to 26× the true value on a slab house, and a seed that far off
 *  left the mass unidentified for weeks. Undefined without enough heating to judge by. */
export function balanceHeatLoss(slots: ModelSlot[]): number | undefined {
    let heat = 0, degreeHours = 0;
    for (const s of slots) {
        if (!Number.isFinite(s.ti) || !Number.isFinite(s.inputs.te)) continue;
        heat += s.inputs.q;
        degreeHours += (s.ti - s.inputs.te) * SLOT_H;
    }
    return degreeHours > 24 * 5 && heat > 0 ? heat / degreeHours : undefined;
}

/** Run both stages over a series in time order: the offline path, for tests and dev tools, and
 *  the shape the online collector repeats one slot at a time. */
export function fitSeries(slots: ModelSlot[], system: HeatingSystem, era: BuildEra,
                          options: {warmupSlots?: number; tuning?: EkfTuning} = {}) {
    const warmup = options.warmupSlots ?? 3 * 96;
    let rls = newRls();
    let ekf: Ekf | undefined;
    const states = new Map<number, [number, number]>();
    const buffered: ModelSlot[] = [];
    let previous: ModelSlot | undefined;
    for (const slot of slots) {
        if (previous && previous.slot === slot.slot - 1 && slot.usable && previous.usable)
            rls = rlsUpdate(rls, rlsRegressors(previous, slot), slot.ti);
        previous = slot;
        if (!ekf) {
            buffered.push(slot);
            if (buffered.length < warmup) continue;
            // Seed stage 2 with the warm-up's energy balance and replay from the start.
            ekf = newEkf(priorFor(system, era, balanceHeatLoss(buffered)));
            for (const b of buffered) {
                ekf = ekfStep(ekf, b, options.tuning);
                if (ekf.slot === b.slot) states.set(b.slot, [ekf.z[0], ekf.z[1]]);
            }
            continue;
        }
        ekf = ekfStep(ekf, slot, options.tuning);
        if (ekf.slot === slot.slot) states.set(slot.slot, [ekf.z[0], ekf.z[1]]);
    }
    return {rls, ekf, states, params: ekf ? ekfParams(ekf) : undefined};
}
