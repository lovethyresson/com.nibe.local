/** Heat delivered to space heating per slot, from the pump's stepped counter (1577).
 *  Design: docs/smart-heating-plan.md §5.5. */

export interface HeatInput {
    slot: number;
    /** Counter value at the end of the slot, kWh; NaN when not read. */
    qmeter: number;
    /** Mean compressor Hz in the slot; NaN when not read. */
    hz: number;
}

/** The counter moves in steps (0.1 kWh on the S1155), so one slot sees the whole step that
 *  several slots produced. Each step is spread back over the slots since the previous step,
 *  weighted by compressor Hz (evenly if none ran). A gap in the series — a missing slot or an
 *  unread counter — restarts the chain, so a step is never spread across unknown time. 1577
 *  counts heating only, so hot-water slots need no subtraction. */
export function heatPerSlot(series: HeatInput[]): Map<number, number> {
    const out = new Map<number, number>();
    let pending: HeatInput[] = [];
    let reference: number | undefined;
    let previousSlot: number | undefined;
    for (const point of [...series].sort((a, b) => a.slot - b.slot)) {
        const contiguous = previousSlot !== undefined && point.slot === previousSlot + 1;
        previousSlot = point.slot;
        if (!Number.isFinite(point.qmeter) || !contiguous || reference === undefined || point.qmeter < reference) {
            pending = [];
            reference = Number.isFinite(point.qmeter) ? point.qmeter : undefined;
            continue;
        }
        pending.push(point);
        const delta = point.qmeter - reference;
        if (delta <= 0) continue;
        const weights = pending.map((p) => (Number.isFinite(p.hz) && p.hz > 0 ? p.hz : 0));
        const total = weights.reduce((a, b) => a + b, 0);
        pending.forEach((p, i) => out.set(p.slot, total > 0 ? delta * weights[i] / total : delta / pending.length));
        pending = [];
        reference = point.qmeter;
    }
    return out;
}
