/** Live hot water Autopilot takes over the pump's own charging and periodic boost, and gives it back. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MAX_FAILURES, TakeoverRecord, gaveUp, noteFailure, noteRestored, noteTaken, noteWrite, readTakeover, restoreAll, restorePlan,
    retryDelayMs, takeoverPlan} from '../lib/autopilot/hotwater-takeover';

const T0 = Date.UTC(2026, 10, 20, 12);
const plan = (...args: Parameters<typeof takeoverPlan>) => {
    const out = takeoverPlan(...args);
    assert.ok(!('skip' in out));
    return out;
};

test('the takeover writes only what differs from Small, start 5 °C and periodic off', () => {
    assert.deepEqual(plan({demandMode: 1, startSmallC: 42, periodic: true, intervalDays: 14, periodicStopC: 60}, undefined, T0).writes,
        [{key: 'demandMode', value: 0}, {key: 'startSmallC', value: 5}, {key: 'periodic', value: false}]);
    assert.deepEqual(plan({demandMode: 0, startSmallC: 5, periodic: false}, undefined, T0).writes, [], 'already set up this way');
    assert.deepEqual(plan({demandMode: 2, startSmallC: 5, periodic: false}, undefined, T0).writes, [{key: 'demandMode', value: 0}]);
});

test('the owner values are saved once, before any write, with nothing confirmed yet', () => {
    const now = {demandMode: 2, startSmallC: 42, periodic: true, largeStopC: 58, intervalDays: 21, periodicStopC: 60};
    const first = plan(now, undefined, T0);
    assert.deepEqual(first.save, {owner: now, wrote: {}, at: T0});
    assert.equal(plan({demandMode: 0, startSmallC: 5, periodic: false}, first.save, T0).save, undefined, 'never saved again');
});

test('a takeover cut short is finished: unwritten settings still at the owner\'s value get written, done ones recorded', () => {
    const saved: TakeoverRecord = {owner: {demandMode: 1, startSmallC: 42, periodic: true}, wrote: {demandMode: 0}, at: T0};
    // A restart after 60 was written but before it was recorded; 65 never written.
    const out = plan({demandMode: 0, startSmallC: 5, periodic: true}, saved, T0 + 60_000);
    assert.deepEqual(out.confirmed, [{key: 'startSmallC', value: 5}]);
    assert.deepEqual(out.writes, [{key: 'periodic', value: false}]);
    // A setting the owner changed since is theirs.
    assert.deepEqual(plan({demandMode: 0, startSmallC: 30, periodic: true}, saved, T0).writes, [{key: 'periodic', value: false}]);
    // Fully done: nothing to do.
    const done = {...saved, wrote: {demandMode: 0, startSmallC: 5, periodic: false}};
    assert.deepEqual(plan({demandMode: 2, startSmallC: 50, periodic: true}, done, T0), {writes: [], confirmed: []});
});

test('nothing is taken over before every written setting reads, nor under Smart control', () => {
    assert.deepEqual(takeoverPlan({demandMode: 1, startSmallC: 42}, undefined, T0), {skip: 'unread'});
    assert.deepEqual(takeoverPlan({demandMode: 4, startSmallC: 42, periodic: true}, undefined, T0), {skip: 'smart control'});
});

const record: TakeoverRecord = {owner: {demandMode: 1, startSmallC: 42, periodic: true, intervalDays: 14, periodicStopC: 60},
    wrote: {demandMode: 0, startSmallC: 5, periodic: false}, at: T0};

test('what the pump read back is recorded, a clamped value too; still the owner\'s value is a failed try', () => {
    const base: TakeoverRecord = {owner: record.owner, wrote: {}, at: T0};
    assert.deepEqual(noteTaken(base, 'startSmallC', 10).wrote, {startSmallC: 10}, 'clamped to 10: Autopilot\'s, not an owner change');
    assert.deepEqual(restorePlan({demandMode: 1, startSmallC: 10, periodic: true}, noteTaken(base, 'startSmallC', 10)).writes,
        [{key: 'startSmallC', value: 42}], 'so the restore puts 42 back');
    assert.deepEqual(noteTaken(base, 'startSmallC', 42).failures, {startSmallC: 1});
    assert.deepEqual(noteTaken(base, 'startSmallC', undefined).failures, {startSmallC: 1});
});

test('the restore puts back what Autopilot left there and skips what the owner changed since', () => {
    assert.deepEqual(restorePlan({demandMode: 0, startSmallC: 5, periodic: false}, record),
        {writes: [{key: 'demandMode', value: 1}, {key: 'startSmallC', value: 42}, {key: 'periodic', value: true}], unread: []});
    const out = restorePlan({demandMode: 2, startSmallC: 5, periodic: false}, record);
    assert.deepEqual(out.writes, [{key: 'startSmallC', value: 42}, {key: 'periodic', value: true}]);
    assert.deepEqual(restorePlan({demandMode: 0, startSmallC: 5}, record).unread, ['periodic'], 'an unread setting waits');
    assert.deepEqual(restorePlan({demandMode: 0, startSmallC: 5, periodic: false}, noteRestored(record, 'demandMode')).writes.length, 2,
        'a setting already back is not written again');
});

test('an owner back to Large gets their Large stop (62) back first, whatever Autopilot left there', () => {
    const large: TakeoverRecord = {owner: {demandMode: 2, startSmallC: 5, periodic: false, largeStopC: 58}, wrote: {demandMode: 0}, at: T0};
    assert.deepEqual(restorePlan({demandMode: 0, startSmallC: 5, periodic: false, largeStopC: 65}, large).writes,
        [{key: 'largeStopC', value: 58}, {key: 'demandMode', value: 2}]);
    assert.deepEqual(restorePlan({demandMode: 1, startSmallC: 5, periodic: false, largeStopC: 65}, large).writes, [],
        'the owner chose Medium since: neither goes back');
    assert.deepEqual(restorePlan({demandMode: 0, startSmallC: 5, periodic: false}, large).unread, ['largeStopC']);
    assert.deepEqual(restoreAll(large), [{key: 'largeStopC', value: 58}, {key: 'demandMode', value: 2}], 'on delete, without reading');
});

test('after 4 failed tries a setting is no longer written; retries back off to every 6 h', () => {
    let r: TakeoverRecord = {owner: record.owner, wrote: {}, at: T0};
    for (let k = 0; k < MAX_FAILURES; k++) {
        assert.equal(gaveUp(r, 'periodic'), false);
        r = noteFailure(r, 'periodic');
    }
    assert.equal(gaveUp(r, 'periodic'), true);
    assert.deepEqual(plan({demandMode: 1, startSmallC: 42, periodic: true}, r, T0).writes.map((w) => w.key), ['demandMode', 'startSmallC']);
    assert.deepEqual([0, 1, 2, 3, 9].map((a) => retryDelayMs(a) / 60_000), [5, 30, 120, 360, 360]);
});

test('a later write by the safety net counts as Autopilot\'s', () => {
    const off: TakeoverRecord = {owner: {demandMode: 0, startSmallC: 5, periodic: false}, wrote: {}, at: T0};
    const on = noteWrite(off, 'periodic', true);
    assert.deepEqual(restorePlan({demandMode: 0, startSmallC: 5, periodic: true}, on).writes, [{key: 'periodic', value: false}]);
    assert.equal(readTakeover({owner: {}, wrote: {}}), undefined);
    assert.deepEqual(readTakeover(on), on);
});
