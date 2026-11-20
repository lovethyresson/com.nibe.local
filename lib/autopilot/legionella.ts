/** The legionella charge while hot water Autopilot runs live: the pump's own periodic boost is off
 *  (hotwater-takeover.ts), so Autopilot heats the tank to the legionella temperature itself, every
 *  interval, in the cheapest two hours before it is due. A charge that got there anyway resets the
 *  interval. Pure. Design: docs/autopilot-hot-water.md §4.3. */
import {SLOT_MS} from './prices';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const RECOMMENDED_C = 65;
export const MIN_C = 55;
export const MAX_C = 70;
/** The top counts as there half a degree under the target: the sensor's own step. */
export const REACHED_K = 0.5;
/** The run: 8 slots, two hours, the cheapest that fits. */
export const WINDOW_SLOTS = 8;
/** A run is planned only this close to when it is due: the prices known then cover it. */
export const LOOKAHEAD_MS = 48 * HOUR;
/** Not reached this long after it was due: the pump's own periodic boost comes back. */
export const OVERDUE_MS = 24 * HOUR;
/** More hot water for 6 h, not 2: on the S1155 the immersion heater takes over only after the
 *  compressor stops near 58 °C, and a 2 h boost ran out before that (2026-10-18). */
export const BOOST_HOURS = 6;
/** Whether Autopilot runs legionella for an owner whose own periodic boost was off before it
 *  took over. Yes, one rule for everyone (decided 2026-11-20); an owner who wants less sets the
 *  temperature to 55 °C in Hot water setup. */
export const LEGIONELLA_WHEN_PERIODIC_OFF = true;
/** Store writes for a reached top at most this often. */
export const NOTE_EVERY_MS = HOUR;

export type LegionellaChoice = 'pump' | 'recommended' | 'custom';
/** The owner's choice in setup: the heat pump's own temperature (61, as read then), 65 °C, or their own. */
export interface LegionellaSetting {
    choice: LegionellaChoice;
    c: number;
}
export const DEFAULT_SETTING: LegionellaSetting = {choice: 'recommended', c: RECOMMENDED_C};

/** What the store keeps: when the top last got there, and when Autopilot first took over (the
 *  start of the first interval). `runAt`: the last legionella run started. `fallbackAt`: the run
 *  did not get there in time and the pump's own boost is back on, until a reached top resets it.
 *  Kept across a stop and a new takeover, so going Simulated and back does not restart the interval. */
export interface LegionellaState {
    lastReachedAt?: number;
    since: number;
    runAt?: number;
    fallbackAt?: number;
}

const inRange = (c: number) => Number.isFinite(c) && c >= MIN_C && c <= MAX_C;

/** A valid setting from what setup sent, or undefined. 'recommended' is always 65 °C. */
export function validSetting(raw: any): LegionellaSetting | undefined {
    const choice = raw?.choice, c = Number(raw?.c);
    if (choice === 'recommended') return DEFAULT_SETTING;
    if ((choice === 'pump' || choice === 'custom') && inRange(c)) return {choice, c: Math.round(c * 10) / 10};
    return undefined;
}

/** The stored setting, or the recommended one. */
export function readSetting(raw: unknown): LegionellaSetting {
    return validSetting(raw) ?? DEFAULT_SETTING;
}

export function readState(raw: unknown): LegionellaState | undefined {
    const s = raw as LegionellaState | undefined;
    return s && typeof s === 'object' && Number.isFinite(s.since) ? s : undefined;
}

/** The temperature that counts as reached. While the safety net is on, the pump's own boost
 *  heats only to its own stop (61), so that counts too: otherwise a 55 °C periodic boost could
 *  never end a fallback to a 65 °C target. */
export function reachedC(state: LegionellaState, targetC: number, pumpC?: number): number {
    return (state.fallbackAt !== undefined && pumpC !== undefined ? Math.min(targetC, pumpC) : targetC) - REACHED_K;
}

/** The state after a tank top reading: at or above the target (`reachedC`), it got there now,
 *  and a fallback in force ends. The same object when nothing changed. */
export function noteTop(state: LegionellaState, topC: number | undefined, now: number, targetC: number, pumpC?: number): LegionellaState {
    if (topC === undefined || !Number.isFinite(topC) || topC < reachedC(state, targetC, pumpC)) return state;
    const next: LegionellaState = {...state, lastReachedAt: now};
    delete next.fallbackAt;
    return next;
}

/** When the next legionella charge is due: an interval after the top last got there, or after
 *  Autopilot took over. */
export function dueAt(state: LegionellaState, intervalDays: number): number {
    return (state.lastReachedAt ?? state.since) + intervalDays * DAY;
}

/** A run started in this interval (since the top last got there): one run per interval. */
export function ranThisInterval(state: LegionellaState): boolean {
    return state.runAt !== undefined && state.runAt >= (state.lastReachedAt ?? state.since);
}

/** The safety net (the pump's own boost) takes over: past due, not reached, and either this
 *  interval's run already fell short or a day has gone by without one. */
export function overdue(state: LegionellaState, now: number, intervalDays: number): boolean {
    if (state.fallbackAt !== undefined) return false;
    const due = dueAt(state, intervalDays);
    return ranThisInterval(state) ? now > due : now > due + OVERDUE_MS;
}

/** The cheapest two hours that start at or after `now` and end by `due`, among the known prices
 *  (slot start, ms → price); only from 48 h before it is due. The earliest of equal ones. */
export function pickWindow(prices: Map<number, number>, now: number, due: number):
    {start: number; end: number; price: number} | undefined {
    if (now < due - LOOKAHEAD_MS) return undefined;
    let best: {start: number; end: number; price: number} | undefined;
    for (const start of [...prices.keys()].sort((a, b) => a - b)) {
        const end = start + WINDOW_SLOTS * SLOT_MS;
        if (start < now || end > due) continue;
        let sum = 0, known = true;
        for (let k = 0; k < WINDOW_SLOTS && known; k++) {
            const p = prices.get(start + k * SLOT_MS);
            if (p === undefined) known = false; else sum += p;
        }
        if (!known) continue;
        const price = sum / WINDOW_SLOTS;
        if (!best || price < best.price - 1e-9) best = {start, end, price};
    }
    return best;
}

/** What this slot does for legionella: turn the pump's own boost back on (overdue), start the
 *  run (this slot is the chosen window's start), or nothing. */
export function legionellaStep(input: {state: LegionellaState; now: number; slotStart: number; intervalDays: number;
    targetC: number; topC?: number; busy: boolean; prices: Map<number, number>}):
    {action: 'fallback'} | {action: 'start'; window: {start: number; end: number; price: number}} | {action: 'wait'; why: string} {
    const {state, now, intervalDays} = input;
    if (state.fallbackAt !== undefined) return {action: 'wait', why: 'fallback'};
    if (overdue(state, now, intervalDays)) return {action: 'fallback'};
    if (input.topC !== undefined && input.topC >= input.targetC - REACHED_K) return {action: 'wait', why: 'reached'};
    // One run an interval: a run that fell short is not repeated, the safety net follows when due.
    if (ranThisInterval(state)) return {action: 'wait', why: 'ran'};
    const window = pickWindow(input.prices, input.slotStart, dueAt(state, intervalDays));
    if (!window) return {action: 'wait', why: 'no window'};
    if (window.start !== input.slotStart) return {action: 'wait', why: 'later'};
    if (input.busy) return {action: 'wait', why: 'charging'};
    return {action: 'start', window};
}
