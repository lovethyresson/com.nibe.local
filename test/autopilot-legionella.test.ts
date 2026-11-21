/** The legionella run: when it is due, the cheapest two hours before then, and the safety net. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BOOST_HOURS, LOOKAHEAD_MS, OVERDUE_MS, WINDOW_SLOTS, dueAt, legionellaStep, noteTop, overdue, pickWindow, readSetting, reachedC, validSetting}
    from '../lib/autopilot/legionella';
import {LEGIONELLA_DATES_KEY, CHARGE_KEY, HotwaterAutopilot, HotwaterHooks, LEGIONELLA_STATE_KEY, WRITES_KEY} from '../lib/autopilot/hotwater-shadow';
import {MAX_C} from '../lib/autopilot/hotwater-shadow';
import {localClock} from '../lib/autopilot/hotwater-learner';
import {SLOT_MS} from '../lib/autopilot/prices';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 20); // a midnight, UTC
/** Prices for two days from T0: 1.0 everywhere, 0.2 from 02:00 to 04:00 on the second day. */
const prices = new Map(Array.from({length: 192}, (_, k) => [T0 + k * SLOT_MS, k >= 104 && k < 112 ? 0.2 : 1.0]));

test('a top at the target, within half a degree, marks it reached and ends a fallback', () => {
    const state = {since: T0 - 20 * DAY, fallbackAt: T0 - DAY};
    assert.equal(noteTop(state, 60, T0, 65), state, 'too cool: unchanged');
    assert.equal(noteTop(state, undefined, T0, 65), state);
    assert.deepEqual(noteTop(state, 64.5, T0, 65), {since: T0 - 20 * DAY, lastReachedAt: T0});
});

test('due an interval after it was last reached, or after the takeover', () => {
    assert.equal(dueAt({since: T0}, 14), T0 + 14 * DAY);
    assert.equal(dueAt({since: T0, lastReachedAt: T0 + 3 * DAY}, 7), T0 + 10 * DAY);
});

test('the run takes the cheapest two hours that end by when it is due, and nothing outside 48 h', () => {
    const due = T0 + 2 * DAY;
    const w = pickWindow(prices, T0 + 6 * HOUR, due)!;
    assert.deepEqual({...w, price: Math.round(w.price * 100) / 100}, {start: T0 + DAY + 2 * HOUR, end: T0 + DAY + 4 * HOUR, price: 0.2});
    assert.equal(w.end - w.start, WINDOW_SLOTS * SLOT_MS);
    assert.equal(pickWindow(prices, due - LOOKAHEAD_MS - SLOT_MS, due), undefined, 'more than 48 h before it is due');
    const tight = pickWindow(prices, T0 + 6 * HOUR, T0 + DAY + 3 * HOUR)!;
    assert.ok(tight.end <= T0 + DAY + 3 * HOUR, 'never past when it is due');
    assert.equal(pickWindow(prices, T0 + DAY + 5 * HOUR, T0 + DAY + 6 * HOUR), undefined, 'no two hours left before it is due');
    assert.equal(pickWindow(new Map([[T0, 1]]), T0, T0 + DAY), undefined, 'unknown prices are no window');
});

test('a day past due and not reached: the pump\'s own boost comes back, once', () => {
    const state = {since: T0 - 14 * DAY};
    assert.equal(overdue(state, T0 + OVERDUE_MS, 14), false);
    assert.equal(overdue(state, T0 + OVERDUE_MS + 1, 14), true);
    assert.equal(overdue({...state, fallbackAt: T0 + OVERDUE_MS + 1}, T0 + 2 * DAY, 14), false, 'said once');
    const step = (s: any, now: number) => legionellaStep({state: s, now, slotStart: now, intervalDays: 14, targetC: 65, topC: 50, busy: false, prices});
    assert.deepEqual(step(state, T0 + 2 * DAY), {action: 'fallback'});
    assert.deepEqual(step({...state, fallbackAt: T0 + 2 * DAY}, T0 + 2 * DAY + HOUR), {action: 'wait', why: 'fallback'}, 'no runs until reached');
});

test('the setting: recommended 65 °C by default, a temperature of their own from 55 to 70', () => {
    assert.deepEqual(readSetting(undefined), {choice: 'recommended', c: 65});
    assert.deepEqual(validSetting({choice: 'custom', c: 70}), {choice: 'custom', c: 70});
    assert.equal(validSetting({choice: 'custom', c: 71}), undefined);
    assert.equal(validSetting({choice: 'pump', c: 50}), undefined);
    assert.deepEqual(validSetting({choice: 'recommended', c: 12}), {choice: 'recommended', c: 65});
});

// ---- The run, through HotwaterAutopilot ----

test('one run an interval: a run that fell short is not repeated, and the safety net follows once due', () => {
    const state = {since: T0 + 2 * DAY - 14 * DAY, runAt: T0 + DAY + 2 * HOUR};
    const step = (s: any, now: number) => legionellaStep({state: s, now, slotStart: now, intervalDays: 14, targetC: 65, topC: 58, busy: false, prices});
    assert.deepEqual(step(state, T0 + DAY + 8 * HOUR), {action: 'wait', why: 'ran'});
    assert.equal(overdue(state, T0 + 2 * DAY, 14), false);
    assert.deepEqual(step(state, T0 + 2 * DAY + SLOT_MS), {action: 'fallback'}, 'due, the run fell short: no extra day');
    const reached = noteTop(state, 65, T0 + DAY + 4 * HOUR, 65);
    assert.equal(overdue(reached, T0 + 2 * DAY + SLOT_MS, 14), false, 'a top that got there starts a new interval');
});

test('the safety net ends at the heat pump\'s own boost temperature when that is lower than the target', () => {
    const fallback = {since: T0 - 20 * DAY, fallbackAt: T0 - DAY};
    assert.equal(reachedC(fallback, 65, 55), 54.5);
    assert.equal(reachedC({since: T0}, 65, 55), 64.5, 'outside the safety net the target counts');
    assert.equal(noteTop(fallback, 55, T0, 65, 55).fallbackAt, undefined, 'a 55 °C periodic boost ends it');
    assert.equal(noteTop(fallback, 55, T0, 65), fallback, 'without the pump\'s value, the target');
});

function autopilot(state: any, facts: any = {}) {
    const store = new Map<string, any>([[LEGIONELLA_STATE_KEY, state]]);
    const writes: [string, any][] = [];
    const notes: string[] = [];
    const warnings: (string | undefined)[] = [];
    let fail: string | undefined;
    const homey = {__: (key: string) => key, clock: {getTimezone: () => 'UTC'}, setTimeout, clearTimeout,
        notifications: {createNotification: async (n: any) => { notes.push(n.excerpt); }}};
    const hooks: HotwaterHooks = {
        mode: () => 'live', reserveLitres: () => 40, solar: () => false, surplus: () => undefined, reserveSurplus() {},
        dayType: () => undefined, household: () => undefined, track() {}, warn(text) { warnings.push(text); }, status() {}, charged() {},
        pumpFacts: async () => ({top: 50, largeStopC: 55, demandMode: 0, allowed: true, spaHotwater: false, ...facts}),
        write: async (what, value) => { if (fail === what) throw new Error('refused'); writes.push([what, value]); },
        store: {get: (key) => store.get(key), set: async (key, value) => { store.set(key, value); }},
        legionella: () => ({targetC: 65, intervalDays: 14}),
        periodicBoost: async (on) => { writes.push(['periodic', on]); },
    };
    const ap = new HotwaterAutopilot(homey, 'hw', 'file', {} as any, () => ({now: {}}), () => {}, hooks);
    (ap as any).prices = new Map([...prices].map(([ms, price]) => [ms / SLOT_MS, {slot: ms / SLOT_MS, price}]));
    const run = (at: number, top = 50) => (ap as any).watchLegionella({slot: at / SLOT_MS, prices: new Map(), tank: {litres: 176, inletC: 10},
        clock: localClock('UTC'), now: {litres: 120, top, powerW: 0}, reserveLitres: 40}, at);
    return {ap, store, writes, notes, warnings, run, failOn: (what?: string) => { fail = what; }};
}

test('a due run starts at the cheapest slot: 62 to 65 °C, uncapped by the ceiling, then More hot water for 6 h', async () => {
    const f = autopilot({since: T0 + 2 * DAY - 14 * DAY});
    await f.run(T0 + DAY + HOUR);
    assert.deepEqual(f.writes, [], 'not yet: the cheap hours start at 02:00');
    await f.run(T0 + DAY + 2 * HOUR);
    assert.ok(MAX_C < 65, 'the compressor ceiling caps normal plans below it');
    assert.deepEqual(f.writes, [['stop', 65], ['boost', BOOST_HOURS]]);
    assert.equal(BOOST_HOURS, 6);
    assert.deepEqual(f.store.get(CHARGE_KEY), {at: T0 + DAY + 2 * HOUR, targetC: 65, minutes: 360, legionella: true});
    assert.deepEqual(f.store.get(WRITES_KEY), {date: '2026-11-21', starts: 1, stops: 1}, 'one start and one stop write of the day');
    assert.equal(f.store.get(LEGIONELLA_STATE_KEY).runAt, T0 + DAY + 2 * HOUR, 'the run is kept: one an interval');
    assert.deepEqual(f.store.get(LEGIONELLA_DATES_KEY), ['2026-11-21'], 'its day, for the savings comparison');
    await f.run(T0 + DAY + 2 * HOUR + SLOT_MS);
    assert.equal(f.writes.length, 2, 'once');
});

test('a run whose write fails holds nothing back: the charge record is cleared and no run is counted', async () => {
    const f = autopilot({since: T0 + 2 * DAY - 14 * DAY});
    f.failOn('boost');
    await assert.rejects(f.run(T0 + DAY + 2 * HOUR), /refused/);
    assert.equal(f.store.get(CHARGE_KEY), null);
    assert.equal(f.store.get(LEGIONELLA_STATE_KEY).runAt, undefined);
});

test('no run when the target was reached within the interval, or the tank is there now', async () => {
    const reached = autopilot({since: T0 - 30 * DAY, lastReachedAt: T0 - 2 * DAY});
    await reached.run(T0 + DAY + 2 * HOUR);
    assert.deepEqual(reached.writes, []);
    const hot = autopilot({since: T0 + 2 * DAY - 14 * DAY});
    await hot.run(T0 + DAY + 2 * HOUR, 64.6);
    assert.deepEqual(hot.writes, []);
});

test('overdue live: the periodic boost goes back on and the owner is told on the timeline', async () => {
    const f = autopilot({since: T0 - 16 * DAY});
    await f.run(T0 + DAY);
    assert.deepEqual(f.writes, [['periodic', true]]);
    assert.equal(f.store.get(LEGIONELLA_STATE_KEY).fallbackAt, T0 + DAY);
    assert.deepEqual(f.notes, ['autopilot.hotwater_legionella.overdue']);
    f.ap.noteTop(65, T0 + DAY + HOUR);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.writes, [['periodic', true], ['periodic', false]], 'a charge got there: the boost goes off again');
    assert.equal(f.store.get(LEGIONELLA_STATE_KEY).fallbackAt, undefined);
});

test('a rescue refused after a refused planned run is still counted and told, and its warning goes at midnight', async () => {
    const f = autopilot(undefined);
    const date = '2026-11-21';
    await f.store.set(WRITES_KEY, {date, starts: 5, stops: 3});
    const charge = (reason: string) => (f.ap as any).startCharge({at: T0, by: 'autopilot', reason, targetC: 55, minutes: 60}, date);
    await charge('cheap');
    await charge('reserve');
    assert.equal((f.ap as any).day?.refusedRescues, 1, 'counted although the planned run was refused for the cap first');
    assert.equal(f.warnings[f.warnings.length - 1], 'autopilot.hotwater_charge.blocked.rescue_limit');
    assert.deepEqual(f.writes, [], 'nothing written');
    (f.ap as any).showBlocked(undefined, '2026-11-22');
    assert.equal(f.warnings[f.warnings.length - 1], undefined, 'cleared');
});
