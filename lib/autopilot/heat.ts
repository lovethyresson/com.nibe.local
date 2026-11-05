/** Energy per slot from the pump's stepped counters: heat delivered to space heating (1577) and
 *  electricity consumed (3823). Design: docs/autopilot-plan.md §5.5. */

export interface HeatInput {
    slot: number;
    /** Counter value at the end of the slot, kWh; NaN when not read. */
    qmeter: number;
    /** Mean compressor Hz in the slot; NaN when not read. */
    hz: number;
    /** Fraction of the slot on hot water; its Hz made no space heat. Missing counts as 0. */
    dhw?: number;
}

export interface ElectricityInput {
    slot: number;
    /** Consumption counter at the end of the slot, kWh; NaN when not read. */
    emeter: number;
    /** Mean electrical power in the slot, W (2166); NaN when not read. */
    pw: number;
}

/** A counter moves in steps, so one slot sees the whole step that several slots produced. Each
 *  step is spread back over the slots since the previous step in proportion to `weight` (evenly
 *  if all are zero). A gap in the series — a missing slot or an unread counter — restarts the
 *  chain, so a step is never spread across unknown time. */
function spreadSteps<T extends {slot: number}>(series: T[], counter: (p: T) => number,
                                               weight: (p: T) => number): Map<number, number> {
    const out = new Map<number, number>();
    let pending: T[] = [];
    let reference: number | undefined;
    let previousSlot: number | undefined;
    for (const point of [...series].sort((a, b) => a.slot - b.slot)) {
        const value = counter(point);
        const contiguous = previousSlot !== undefined && point.slot === previousSlot + 1;
        previousSlot = point.slot;
        if (!Number.isFinite(value) || !contiguous || reference === undefined || value < reference) {
            pending = [];
            reference = Number.isFinite(value) ? value : undefined;
            continue;
        }
        pending.push(point);
        const delta = value - reference;
        if (delta <= 0) continue;
        const weights = pending.map(weight);
        const total = weights.reduce((a, b) => a + b, 0);
        pending.forEach((p, i) => out.set(p.slot, total > 0 ? delta * weights[i] / total : delta / pending.length));
        pending = [];
        reference = value;
    }
    return out;
}

const positive = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);

/** 1577 steps by 0.1 kWh on the S1155, weighted by compressor Hz. It counts heating only, so a
 *  slot's hot-water share of Hz gets none of it. */
export function heatPerSlot(series: HeatInput[]): Map<number, number> {
    return spreadSteps(series, (p) => p.qmeter,
        (p) => positive(p.hz) * (1 - Math.min(1, Math.max(0, Number.isFinite(p.dhw) ? p.dhw! : 0))));
}

/** 3823 steps unevenly (0.3–2.5 kWh seen), weighted by 2166. The counter is the amount and
 *  2166 only the shape: 2166 reads ~6 % low against 3823 over a day on the S1155 (it misses
 *  fans and runs low on hot water, see the 0.9.13 row in docs/releases.md). */
export function electricityPerSlot(series: ElectricityInput[]): Map<number, number> {
    return spreadSteps(series, (p) => p.emeter, (p) => positive(p.pw));
}
