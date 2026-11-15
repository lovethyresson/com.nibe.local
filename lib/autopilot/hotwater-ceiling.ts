/** Hot water's compressor ceiling: the tank temperature at which the immersion heater starts
 *  helping a charge, learned per pump, and the highest target the planner may use under it. Pure.
 *  Design: docs/autopilot-hot-water.md §4.2 (Ceiling) and §4.8.
 *
 *  On the S1155 the compressor gives up near 58 °C at BT6 (alarm 216 or 382) and the immersion
 *  heater finishes the charge at about a third of the efficiency
 *  (docs/hot-water-heat-accounting.md). Where that happens differs per pump, brine and season,
 *  so it is learned from what the pump did:
 *
 *  - an **onset**: the immersion heater came on during a hot water charge, with the charge sensor
 *    at `c`. The compressor did not get past about `c`.
 *  - a **clean** end: a charge ended on the compressor alone at `c`. The compressor reached `c`.
 *
 *  The ceiling is the default (or the highest clean end, if higher), lowered to the lowest
 *  recent onset that no later clean end got above. The planner's target stays a margin below it. */

/** Until anything is learned (maintainer, 2026-11-15). */
export const DEFAULT_CEILING_C = 58;
/** The planner's target stays this far under the ceiling. */
export const CEILING_MARGIN_K = 1;
/** Never above: the planner's range, and the Large stop's usual top on the S-series. */
export const HARD_MAX_C = 60;
/** Never below: a reading that would put it lower is a fault, not the compressor's limit. */
export const CEILING_FLOOR_C = 50;
/** An immersion heater seen under this is not the compressor giving up near its ceiling: it is
 *  the heater already running for heating, or a cold tank on a high degree-minute deficit. */
export const ONSET_MIN_C = 50;
/** Observations older than this no longer count: the ceiling moves with brine and season. */
export const CEILING_WINDOW_MS = 60 * 24 * 3_600_000;
/** Kept in the store at most. */
const KEEP = 200;

export interface CeilingObservation {
    at: number;
    /** The charge sensor (BT6), else the tank top, °C. */
    c: number;
    kind: 'onset' | 'clean';
    /** `history`: from Insights, replaced at each relearn. `live`: from the polls, kept. */
    source: 'live' | 'history';
}

export interface Ceiling {
    /** Where the immersion heater starts helping, °C. */
    c: number;
    /** The highest charge target the planner may use, °C. */
    maxC: number;
    /** What set it: nothing learned, a clean end raising it, or an onset lowering it. */
    from: 'default' | 'clean' | 'onset';
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number) => Math.max(CEILING_FLOOR_C, Math.min(HARD_MAX_C, v));

/** The highest planned target under a ceiling of `c`. Whole degrees: 62 is written in them. */
export function targetCap(c: number): number {
    return Math.floor(clamp(c) - CEILING_MARGIN_K + 1e-9);
}

/** The ceiling from what the pump did recently. */
export function learnCeiling(observations: readonly CeilingObservation[], now: number): Ceiling {
    const recent = observations.filter((o) => finite(o.c) && now - o.at <= CEILING_WINDOW_MS && o.at <= now);
    const clean = recent.filter((o) => o.kind === 'clean');
    const best = clean.reduce((m, o) => Math.max(m, o.c), -Infinity);
    let c = Math.max(DEFAULT_CEILING_C, best);
    let from: Ceiling['from'] = best > DEFAULT_CEILING_C ? 'clean' : 'default';
    // An onset counts until a later charge got above it on the compressor alone (a warmer brine).
    for (const o of recent) {
        if (o.kind !== 'onset' || o.c < ONSET_MIN_C) continue;
        if (clean.some((k) => k.at > o.at && k.c > o.c)) continue;
        if (o.c < c) { c = o.c; from = 'onset'; }
    }
    c = clamp(c);
    return {c, maxC: targetCap(c), from};
}

/** Adds observations, drops the expired, keeps the newest `KEEP`. `history` replaces every earlier
 *  history observation, since each relearn reads the whole of Insights again. */
export function mergeObservations(stored: readonly CeilingObservation[] | undefined, added: readonly CeilingObservation[],
                                  now: number, history?: readonly CeilingObservation[]): CeilingObservation[] {
    const valid = (o: any): o is CeilingObservation => !!o && finite(o.at) && finite(o.c)
        && (o.kind === 'onset' || o.kind === 'clean') && (o.source === 'live' || o.source === 'history');
    const kept = (Array.isArray(stored) ? stored : []).filter(valid).filter((o) => !history || o.source !== 'history');
    return [...kept, ...history ?? [], ...added.filter(valid)]
        .filter((o) => now - o.at <= CEILING_WINDOW_MS)
        .sort((a, b) => a.at - b.at)
        .slice(-KEEP);
}

/** One charge as the polls see it. */
export interface ChargeWatch {
    running: boolean;
    /** Highest charge-sensor reading in the run. */
    maxC?: number;
    /** The immersion heater came on in this run. */
    immersion?: {at: number; c: number};
}

/** One poll. Missing: not read this poll. */
export interface PollReading {
    at: number;
    /** A hot water charge is running (the allocator gives hot water power). */
    charging?: boolean;
    /** The immersion heater runs (1029). */
    immersion?: boolean;
    /** The charge sensor (BT6), else the tank top, °C. */
    c?: number;
}

/** Follows charges poll by poll: the immersion heater's onset in a charge, and how hot a charge
 *  got when it ended on the compressor alone. Pure. */
export function watchCharge(w: ChargeWatch, r: PollReading): {watch: ChargeWatch; observation?: CeilingObservation} {
    if (r.charging === undefined) return {watch: w};
    if (!r.charging) {
        if (!w.running) return {watch: w};
        const observation: CeilingObservation | undefined = !w.immersion && finite(w.maxC)
            ? {at: r.at, c: w.maxC, kind: 'clean', source: 'live'} : undefined;
        return {watch: {running: false}, observation};
    }
    const maxC = finite(r.c) ? Math.max(w.maxC ?? -Infinity, r.c) : w.maxC;
    const watch: ChargeWatch = {running: true, maxC: w.running ? maxC : (finite(r.c) ? r.c : undefined),
        immersion: w.running ? w.immersion : undefined};
    if (r.immersion === true && !watch.immersion && finite(r.c)) {
        watch.immersion = {at: r.at, c: r.c};
        return {watch, observation: {at: r.at, c: r.c, kind: 'onset', source: 'live'}};
    }
    return {watch};
}

/** What the Insights history says. A reading is an hourly (or finer) bucket mean; coarser ones
 *  blur a charge into its neighbours and are left out. */
export interface HistoryPoint {
    t: number;
    /** Hot water heat counter (1575), kWh: rising while the compressor charges the tank. */
    produced?: number | null;
    /** Immersion heater hours for hot water (1069): rising while it helps a charge. */
    aux?: number | null;
    /** The charge sensor (BT6), °C. */
    charge?: number | null;
    top?: number | null;
}

/** Longest gap between two readings that still counts as one charge interval. */
const MAX_GAP_MS = 1.5 * 3_600_000;
/** A rise of the heat counter that means the compressor ran. */
const CHARGING_KWH = 0.1;
/** A rise of 1069 that means the immersion heater ran (it counts in tenths of an hour). */
const AUX_H = 0.05;

/** Onsets and clean ends from Insights. Each run of charging intervals is one charge.
 *  - With 1069 rising in it: an onset at the hottest bucket while the heater ran. Bucket means
 *    put that a little above the real onset, so history lowers the ceiling less than a poll would.
 *  - Without: a clean end at the run's hottest bucket, which bucket means put a little under the
 *    real end, so history raises the ceiling less than the pump really reached. */
export function ceilingFromHistory(points: readonly HistoryPoint[]): CeilingObservation[] {
    const sorted = [...points].filter((p) => finite(p.t)).sort((a, b) => a.t - b.t);
    const temp = (p: HistoryPoint) => finite(p.charge) ? p.charge : finite(p.top) ? p.top : undefined;
    const out: CeilingObservation[] = [];
    // `low`: the heater ran only under ONSET_MIN_C (a cold tank): neither an onset nor a clean end.
    let run: {end: number; maxC: number; auxC: number; aux: boolean; low: boolean} | undefined;
    const close = () => {
        if (!run) return;
        if (run.aux && finite(run.auxC)) out.push({at: run.end, c: run.auxC, kind: 'onset', source: 'history'});
        else if (!run.aux && !run.low && finite(run.maxC)) out.push({at: run.end, c: run.maxC, kind: 'clean', source: 'history'});
        run = undefined;
    };
    for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1], b = sorted[i];
        const charging = b.t - a.t <= MAX_GAP_MS && finite(a.produced) && finite(b.produced) && b.produced - a.produced >= CHARGING_KWH;
        if (!charging) { close(); continue; }
        const aux = finite(a.aux) && finite(b.aux) && b.aux - a.aux >= AUX_H;
        const hottest = Math.max(temp(a) ?? -Infinity, temp(b) ?? -Infinity);
        run ??= {end: b.t, maxC: -Infinity, auxC: -Infinity, aux: false, low: false};
        run.end = b.t;
        run.maxC = Math.max(run.maxC, hottest);
        if (aux && hottest >= ONSET_MIN_C) { run.aux = true; run.auxC = Math.max(run.auxC, hottest); }
        else if (aux) run.low = true;
    }
    close();
    return out;
}
