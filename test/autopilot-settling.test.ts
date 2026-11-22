import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MAX_DAYS, SettleState, change, readSettle, scoreDay, settleDone} from '../lib/autopilot/settling';

const day = (date: string, mean: number | undefined, setpoint = 22.5, slots = 96, setMin = setpoint) =>
    ({date, mean, slots, setMin, setMax: setpoint});

test('each day after the start is scored once, with the day before beside it', () => {
    let s: SettleState = {start: '2026-11-22', days: []};
    let r = scoreDay(s, day('2026-11-22', 21.9));
    assert.equal(r.event, undefined, 'the start day is partial: not scored');
    r = scoreDay(r.state, day('2026-11-23', 21.84));
    assert.deepEqual(r.event, {kind: 'progress', day: {date: '2026-11-23', mean: 21.8, setpoint: 22.5}});
    s = r.state;
    r = scoreDay(s, day('2026-11-24', 22.06));
    assert.equal(r.event?.kind, 'progress');
    assert.equal((r.event as any).previous.mean, 21.8);
    assert.deepEqual(change((r.event as any).day, (r.event as any).previous), {delta: 0.3, dir: 'up'});
    assert.equal(scoreDay(r.state, day('2026-11-24', 22.1)).event, undefined, 'the same day again: nothing');
});

test('two days in a row within 0.2 °C settle it, once', () => {
    let s: SettleState = {start: '2026-11-22', days: []};
    s = scoreDay(s, day('2026-11-23', 22.0)).state;
    const one = scoreDay(s, day('2026-11-24', 22.4));
    assert.equal(one.event?.kind, 'progress', 'one day close is not yet settled');
    const two = scoreDay(one.state, day('2026-11-25', 22.6));
    assert.equal(two.event?.kind, 'settled');
    assert.ok(settleDone(two.state));
    assert.equal(scoreDay(two.state, day('2026-11-26', 22.5)).event, undefined, 'nothing after it settled');
});

test('a day with a moved setpoint or too few readings is skipped, not scored', () => {
    const s: SettleState = {start: '2026-11-22', days: []};
    const away = scoreDay(s, day('2026-11-23', 19, 22.5, 96, 17));
    assert.equal(away.event, undefined);
    assert.equal(away.state.checked, '2026-11-23');
    assert.equal(away.state.days.length, 0);
    assert.equal(scoreDay(s, day('2026-11-23', 22, 22.5, 50)).event, undefined, 'half a day read');
    assert.equal(scoreDay(s, day('2026-11-23', undefined)).event, undefined);
});

test('it stops after three weeks without settling', () => {
    let s: SettleState = {start: '2026-11-01', days: []};
    let last;
    for (let d = 2; d <= MAX_DAYS + 1; d++) {
        last = scoreDay(s, day(`2026-11-${String(d).padStart(2, '0')}`, 21.5));
        s = last.state;
    }
    assert.equal(last!.event?.kind, 'stopped');
    assert.ok(settleDone(s));
});

test('a falling day reads as down, a flat one as the same', () => {
    const a = {date: '2026-11-23', mean: 22.1, setpoint: 22.5};
    assert.deepEqual(change({...a, mean: 21.9}, a), {delta: 0.2, dir: 'down'});
    assert.deepEqual(change(a, a), {delta: 0, dir: 'same'});
    assert.equal(change(a), undefined);
});

test('the stored state reads back, and junk reads as none', () => {
    assert.equal(readSettle(null), undefined);
    assert.equal(readSettle({days: []}), undefined);
    const s = readSettle({start: '2026-11-22', days: [{date: '2026-11-23', mean: 22, setpoint: 22.5}, {date: 'x'}], checked: '2026-11-23'})!;
    assert.equal(s.days.length, 1);
    assert.equal(s.checked, '2026-11-23');
});
