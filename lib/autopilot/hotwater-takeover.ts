/** While hot water Autopilot runs live it takes over the pump's own charging and periodic boost,
 *  and gives them back when it stops. Pure: the reads and writes are the device's. Design:
 *  docs/autopilot-hot-water.md §4.3.
 *
 *  The owner's values are kept before anything is written. Each setting is confirmed by reading it
 *  back, and the record holds what the pump confirmed, so a takeover cut short (a restart, a failed
 *  write) is finished on the next try, and a value the pump clamped is never taken for the
 *  owner's. Settings go back only where the pump still holds what Autopilot left there: a setting
 *  the owner changed since is theirs. */

/** Demand modes (56). */
export const DEMAND_SMALL = 0;
export const DEMAND_LARGE = 2;
export const DEMAND_SMART = 4;
/** Small's start temperature (60) while Autopilot runs: at 5 °C the pump never starts a charge
 *  itself. Not a "safety floor" of 30–35 °C (decided 2026-11-20): the start is judged on BT6, low
 *  in the tank near the inlet, which read 14 °C with 52 L of hot water still above it (S1155,
 *  2026-11-16). A floor above the inlet temperature would start the pump's own charges while
 *  Autopilot still has plenty in the tank. */
export const LOWEST_START_C = 5;
/** Days between periodic boosts (66) when the pump's own does not read. */
export const DEFAULT_INTERVAL_DAYS = 14;
/** Write attempts on one setting before Autopilot stops writing it and says so. */
export const MAX_FAILURES = 4;

/** The pump's hot water settings as read: missing where a register did not answer. */
export interface OwnerHotwater {
    /** Demand mode (56). */
    demandMode?: number;
    /** Start temperature for Small (60), °C. */
    startSmallC?: number;
    /** Periodic hot water on (65). */
    periodic?: boolean;
    /** The Large stop (62), °C: the lever's while Autopilot runs, the owner's own in Large. */
    largeStopC?: number;
    /** Days between periodic boosts (66). */
    intervalDays?: number;
    /** Stop temperature of the periodic boost (61), °C. */
    periodicStopC?: number;
}

/** The settings Autopilot writes when it takes over. */
export type TakenKey = 'demandMode' | 'startSmallC' | 'periodic';
export const TAKEN_KEYS: TakenKey[] = ['demandMode', 'startSmallC', 'periodic'];
/** What a restore can write: the taken settings, and the Large stop for an owner back in Large. */
export type RestoreKey = TakenKey | 'largeStopC';

/** What each taken setting is set to while Autopilot runs live. */
export const TAKEN: Record<TakenKey, number | boolean> = {
    // Small: the mode whose start Autopilot sets out of the way, and whose stop it does not use.
    demandMode: DEMAND_SMALL,
    // The start that keeps the pump from charging on its own, so Autopilot picks every hour.
    startSmallC: LOWEST_START_C,
    // Periodic boost off: Autopilot heats for legionella itself, in the cheapest hours.
    periodic: false,
};

export interface TakeoverWrite<K extends RestoreKey = RestoreKey> {
    key: K;
    value: number | boolean;
}

/** What the device store keeps while Autopilot holds the settings. */
export interface TakeoverRecord {
    /** The owner's values from before. */
    owner: OwnerHotwater;
    /** What the pump confirmed (read back) after Autopilot wrote it, per setting. */
    wrote: Partial<Record<TakenKey, number | boolean>>;
    /** Failed write attempts in a row, per setting. */
    failures?: Partial<Record<RestoreKey, number>>;
    at: number;
}

export const same = (a: number | boolean | undefined, b: number | boolean | undefined) =>
    typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 0.05 : a === b;

/** A stored record, or undefined when there is none or it is not one. */
export function readTakeover(raw: unknown): TakeoverRecord | undefined {
    const r = raw as TakeoverRecord | undefined;
    return r && typeof r === 'object' && r.owner && typeof r.owner === 'object' && r.wrote && typeof r.wrote === 'object'
        && Number.isFinite(r.at) ? r : undefined;
}

/** Autopilot gave up writing this setting after MAX_FAILURES tries. */
export function gaveUp(saved: TakeoverRecord | undefined, key: RestoreKey): boolean {
    return (saved?.failures?.[key] ?? 0) >= MAX_FAILURES;
}

/** The takeover, run while Autopilot is live: the record to save first (the first time), the
 *  writes still to make, and settings already at Autopilot's value that only need recording.
 *  Or why it waits. */
export function takeoverPlan(now: OwnerHotwater, saved: TakeoverRecord | undefined, at: number):
    {save?: TakeoverRecord; writes: TakeoverWrite<TakenKey>[]; confirmed: TakeoverWrite<TakenKey>[]} | {skip: 'unread' | 'smart control'} {
    let save: TakeoverRecord | undefined;
    if (!saved) {
        // Nothing is written until all three are known: the owner's values have to be kept first.
        if (now.demandMode === undefined || now.startSmallC === undefined || now.periodic === undefined) return {skip: 'unread'};
        // Smart control keeps Autopilot out (the lever refuses it), so the pump keeps everything,
        // its periodic boost included.
        if (now.demandMode === DEMAND_SMART) return {skip: 'smart control'};
        saved = save = {owner: {...now}, wrote: {}, at};
    }
    const writes: TakeoverWrite<TakenKey>[] = [], confirmed: TakeoverWrite<TakenKey>[] = [];
    for (const key of TAKEN_KEYS) {
        const owner = saved.owner[key], value = now[key];
        // Done: the pump confirmed it, or Autopilot stopped trying.
        if (saved.wrote[key] !== undefined || gaveUp(saved, key) || value === undefined || owner === undefined) continue;
        // The owner already had it this way: nothing of theirs to change or give back.
        if (same(owner, TAKEN[key])) continue;
        // At Autopilot's value though not recorded (cut short after the write): record it.
        if (same(value, TAKEN[key])) confirmed.push({key, value});
        // Still the owner's value: write it. Anything else the owner set since, and is theirs.
        else if (same(value, owner)) writes.push({key, value: TAKEN[key]});
    }
    return {...save ? {save} : {}, writes, confirmed};
}

/** The record after writing `key` and reading `readBack`: what the pump holds now is Autopilot's
 *  (even a clamped value), unless it still reads the owner's, which is a failed attempt. */
export function noteTaken(saved: TakeoverRecord, key: TakenKey, readBack: number | boolean | undefined): TakeoverRecord {
    if (readBack === undefined || same(readBack, saved.owner[key])) return noteFailure(saved, key);
    const failures = {...saved.failures};
    delete failures[key];
    return {...saved, wrote: {...saved.wrote, [key]: readBack}, failures};
}

export function noteFailure(saved: TakeoverRecord, key: RestoreKey): TakeoverRecord {
    return {...saved, failures: {...saved.failures, [key]: (saved.failures?.[key] ?? 0) + 1}};
}

/** The writes that put the owner's values back when Autopilot stops being live, and the settings
 *  that could not be read to decide. */
export function restorePlan(now: OwnerHotwater, saved: TakeoverRecord): {writes: TakeoverWrite[]; unread: RestoreKey[]} {
    const writes: TakeoverWrite[] = [], unread: RestoreKey[] = [];
    let backToLarge = false;
    for (const key of TAKEN_KEYS) {
        const wrote = saved.wrote[key], owner = saved.owner[key];
        if (wrote === undefined || owner === undefined || gaveUp(saved, key)) continue;
        if (now[key] === undefined) { unread.push(key); continue; }
        // Still what Autopilot left there: the owner's value goes back. Anything else the owner set since.
        if (same(now[key], wrote) && !same(owner, wrote)) {
            writes.push({key, value: owner});
            if (key === 'demandMode' && owner === DEMAND_LARGE) backToLarge = true;
        }
    }
    // An owner going back to Large gets their own Large stop back, whatever it reads: while
    // Autopilot ran, 62 was the target of every charge it started (and the legionella run's), so
    // whatever it holds now is Autopilot's. Written before 56, so Large never runs on Autopilot's stop.
    const stop = saved.owner.largeStopC;
    if (backToLarge && stop !== undefined && !gaveUp(saved, 'largeStopC')) {
        if (now.largeStopC === undefined) unread.push('largeStopC');
        else if (!same(now.largeStopC, stop)) writes.unshift({key: 'largeStopC', value: stop});
    }
    return {writes, unread};
}

/** Every owner value Autopilot changed, to write back without reading (the device is being
 *  deleted and this is the last chance). */
export function restoreAll(saved: TakeoverRecord): TakeoverWrite[] {
    const writes: TakeoverWrite[] = [];
    for (const key of TAKEN_KEYS) {
        const owner = saved.owner[key];
        if (saved.wrote[key] !== undefined && owner !== undefined && !same(owner, saved.wrote[key])) writes.push({key, value: owner});
    }
    if (saved.owner.demandMode === DEMAND_LARGE && saved.wrote.demandMode !== undefined && saved.owner.largeStopC !== undefined)
        writes.unshift({key: 'largeStopC', value: saved.owner.largeStopC});
    return writes;
}

/** The record after Autopilot wrote `value` to `key` later on (the legionella safety net turning
 *  the periodic boost back on), so the restore treats it as Autopilot's. */
export function noteWrite(saved: TakeoverRecord, key: TakenKey, value: number | boolean): TakeoverRecord {
    return {...saved, wrote: {...saved.wrote, [key]: value}};
}

/** How long to wait before trying again after `attempt` failed tries in a row (0-based): 5 min,
 *  30 min, 2 h, then every 6 h. */
export function retryDelayMs(attempt: number): number {
    return ([5, 30, 120][attempt] ?? 360) * 60_000;
}

/** The record after `key` went back to the owner's value: no longer Autopilot's to give back. */
export function noteRestored(saved: TakeoverRecord, key: RestoreKey): TakeoverRecord {
    const wrote = {...saved.wrote}, failures = {...saved.failures};
    if (key !== 'largeStopC') delete wrote[key];
    delete failures[key];
    return {...saved, wrote, failures};
}
