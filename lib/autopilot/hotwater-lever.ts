/** Whether and how Autopilot starts a planned hot water charge: the Large stop (62) to the planned
 *  temperature, then More hot water (697 = 2). The pump stops at 62 by itself, so a charge never
 *  has to be stopped. Pure: the reads and writes are the device's. Design:
 *  docs/autopilot-hot-water.md §4.3, §4.7.
 *
 *  Every write may land in the pump's permanent memory, so writes are per charge and never on a
 *  timer, and capped per day. */

/** Charges Autopilot starts a day (697 writes), and changes of the Large stop (62 writes). */
export const MAX_STARTS_PER_DAY = 3;
/** Starts a day a rescue may use (the tank under the owner's minimum): above the planned cap, so a
 *  day of planned runs and a legionella run never leaves a rescue refused, and still bounded, as a
 *  wear guard: 5 a day is ~1,800 writes a year, about 55 years even at 100,000 writes per position
 *  (docs/autopilot-hot-water.md §4.3 has the only figure found, a quoted 1 million). */
export const MAX_RESCUE_STARTS_PER_DAY = 5;
export const MAX_STOP_WRITES_PER_DAY = 3;
/** A charge starts only when the tank is this far under its target: a charge of a degree or
 *  two buys nothing and costs a write. */
export const BELOW_TARGET_K = 3;
/** Demand modes (56). */
export const DEMAND_LARGE = 2;
export const DEMAND_SMART = 4;

/** The pump's state as read just before the decision. Missing: the register did not answer. */
export interface PumpFacts {
    /** Tank top, BT7 (°C). */
    top?: number;
    /** The charge sensor, BT6 (°C): what the pump stops a charge on. */
    charge?: number;
    /** The Large stop (62) now, °C. */
    largeStopC?: number;
    /** Demand mode (56). */
    demandMode?: number;
    /** Allow hot water (195). */
    allowed?: boolean;
    /** Smart price adaption for hot water: the master switch (843) and its hot water part (846). */
    spaHotwater?: boolean;
}

/** Today's writes so far, by local date. */
export interface WriteCount {
    date: string;
    starts: number;
    stops: number;
}

export type LeverSkip = 'hot water off' | 'smart price adaption' | 'smart control' | 'daily limit' | 'rescue limit' | 'no tank reading'
    | 'no stop reading' | 'tank hot enough';

export type LeverDecision =
    | {targetC: number; writeStop: boolean}
    | {skip: LeverSkip};

/** The count for `date`: yesterday's resets. */
export function countFor(stored: WriteCount | undefined, date: string): WriteCount {
    return stored?.date === date ? stored : {date, starts: 0, stops: 0};
}

/** Whether to start a charge to `plannedC`, and whether 62 must be written first.
 *
 *  - In demand mode Large, 62 is the owner's own stop for every charge, so Autopilot never writes
 *    it there: it chooses when only, and the charge runs to the stop that is set.
 *  - Once 62 has been written its daily share, the charge runs to the stop already set, if that
 *    still leaves it worth starting.
 *  - Smart price adaption and Smart control (56 = 4) move hot water themselves; Autopilot does not
 *    fight them. A pump with hot water disallowed (195 off) gets nothing.
 *  - `belowK`: how far under the target the top has to be. The legionella run passes half a
 *    degree: it has to get there, not only be worth a write.
 *  - `rescue`: the tank is under the owner's minimum. It may use the day's starts up to
 *    `MAX_RESCUE_STARTS_PER_DAY`, past the planned cap; past that it is 'rescue limit'. */
export function leverDecision(plannedC: number, facts: PumpFacts, count: WriteCount,
    {belowK = BELOW_TARGET_K, rescue = false}: {belowK?: number; rescue?: boolean} = {}): LeverDecision {
    if (facts.allowed === false) return {skip: 'hot water off'};
    if (facts.spaHotwater) return {skip: 'smart price adaption'};
    if (facts.demandMode === DEMAND_SMART) return {skip: 'smart control'};
    if (rescue ? count.starts >= MAX_RESCUE_STARTS_PER_DAY : count.starts >= MAX_STARTS_PER_DAY)
        return {skip: rescue ? 'rescue limit' : 'daily limit'};
    if (facts.top === undefined) return {skip: 'no tank reading'};
    const set = facts.largeStopC;
    const mayWrite = facts.demandMode !== DEMAND_LARGE && count.stops < MAX_STOP_WRITES_PER_DAY;
    if (!mayWrite && set === undefined) return {skip: 'no stop reading'};
    const targetC = mayWrite ? plannedC : set!;
    // The colder of the top and the charge sensor: after a large draw the top stays hot over cold
    // water, and the pump, which stops on the charge sensor, still has a charge to make
    // (2026-11-24 19:15: 96 L left, top 47.6 °C against 47, skipped).
    if (Math.min(facts.top, facts.charge ?? facts.top) > targetC - belowK) return {skip: 'tank hot enough'};
    return {targetC, writeStop: mayWrite && (set === undefined || Math.abs(set - plannedC) >= 0.5)};
}
