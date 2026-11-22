import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ASK_WAIT_DAYS, CALIBRATE_MAX_DAYS, CHECK_DAYS, MAX_DAYS, SettleState, calibrateDay, change, readSettle, scoreDay, settleDone, stepOf,
    streak} from '../lib/autopilot/settling';

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


const settledOn = (date: string): SettleState =>
    ({start: '2026-11-01', days: [], settled: date, calibrating: {start: date, days: []}});
const later = (from: string, n: number) => new Date(Date.parse(`${from}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

test('settling hands over to calibrating, and the step follows', () => {
    let s: SettleState = {start: '2026-11-22', days: []};
    assert.equal(stepOf(s, false), 'learning');
    assert.equal(stepOf(s, true), 'settling');
    s = scoreDay(s, day('2026-11-23', 22.4)).state;
    s = scoreDay(s, day('2026-11-24', 22.5)).state;
    assert.deepEqual(s.calibrating, {start: '2026-11-24', days: []});
    assert.equal(stepOf(s, true), 'calibrating');
    assert.equal(stepOf({...s, live: '2026-11-26'}, true), 'saving');
});

test('a new thermostat starts settling over', () => {
    let s: SettleState = {start: '2026-11-22', days: []};
    s = scoreDay(s, day('2026-11-23', 21.6)).state;
    s = scoreDay(s, day('2026-11-24', 21.8)).state;
    const r = scoreDay(s, day('2026-11-25', 21.2, 21));
    assert.deepEqual(r.state.days.map((d) => d.date), ['2026-11-25']);
    assert.equal(r.state.restarted, '2026-11-25');
    assert.deepEqual(r.event, {kind: 'progress', day: {date: '2026-11-25', mean: 21.2, setpoint: 21}});
});

test('a curve that already fits ends calibrating at once', () => {
    const r = calibrateDay(settledOn('2026-11-24'), day('2026-11-25', 22.5), {fits: true});
    assert.deepEqual(r.event, {kind: 'live', reason: 'fits'});
    assert.equal(r.state.live, '2026-11-25');
    assert.equal(r.state.fits, true);
});

test('after a curve change, three days in a row holding the thermostat end it; a miss starts the count over', () => {
    let s = settledOn('2026-11-24');
    const curve = {fits: false, changed: '2026-11-25'};
    s = calibrateDay(s, day('2026-11-25', 22.5), curve).state;
    assert.equal(s.calibrating!.days.length, 0, 'the change day is not checked');
    s = calibrateDay(s, day('2026-11-26', 22.5), curve).state;
    s = calibrateDay(s, day('2026-11-27', 21.9), curve).state;
    assert.equal(streak(s.calibrating!.days), 0);
    let r;
    for (let k = 0; k < CHECK_DAYS; k++) {
        r = calibrateDay(s, day(later('2026-11-28', k), 22.4), curve);
        s = r.state;
    }
    assert.deepEqual(r!.event, {kind: 'live', reason: 'steady'});
    assert.equal(s.fits, undefined);
});

test('a change from before Autopilot started is not calibrating\'s', () => {
    const r = calibrateDay(settledOn('2026-11-24'), day('2026-11-25', 22.5), {fits: true, changed: '2026-10-30'});
    assert.equal(r.event?.reason, 'fits');
});

test('an owner who was asked and changed nothing: on without it after a week', () => {
    let s = settledOn('2026-11-24');
    const curve = {fits: false, asked: '2026-11-25'};
    for (let k = 1; k < ASK_WAIT_DAYS; k++) {
        const r = calibrateDay(s, day(later('2026-11-25', k), 22.5), curve);
        assert.equal(r.event, undefined);
        s = r.state;
    }
    assert.deepEqual(calibrateDay(s, day(later('2026-11-25', ASK_WAIT_DAYS), 22.5), curve).event, {kind: 'live', reason: 'asked'});
});

test('no verdict: calibrating ends on its own', () => {
    let s = settledOn('2026-11-24');
    let r;
    for (let k = 1; k <= CALIBRATE_MAX_DAYS; k++) {
        r = calibrateDay(s, day(later('2026-11-24', k), 22.5), {fits: false});
        s = r.state;
        if (k < CALIBRATE_MAX_DAYS) assert.equal(r.event, undefined);
    }
    assert.deepEqual(r!.event, {kind: 'live', reason: 'timeout'});
    assert.equal(calibrateDay(s, day(later('2026-11-24', 20), 22.5), {fits: true}).event, undefined, 'nothing after Saving');
});

test('three weeks without settling hand over to calibrating too', () => {
    let s: SettleState = {start: '2026-11-01', days: []};
    for (let d = 2; d <= MAX_DAYS + 1; d++) s = scoreDay(s, day(`2026-11-${String(d).padStart(2, '0')}`, 21.5)).state;
    assert.equal(stepOf(s, true), 'calibrating');
    assert.equal(s.calibrating?.start, s.stopped);
});

test('the four steps read back', () => {
    const s = readSettle({start: '2026-11-22', days: [], settled: '2026-11-24', restarted: '2026-11-23', live: '2026-11-27', fits: true, liveAt: 5,
        calibrating: {start: '2026-11-24', checked: '2026-11-26', days: [{date: '2026-11-26', mean: 22.4, setpoint: 22.5, ok: true}, {date: 'x'}]}})!;
    assert.deepEqual(s.calibrating, {start: '2026-11-24', checked: '2026-11-26', days: [{date: '2026-11-26', mean: 22.4, setpoint: 22.5, ok: true}]});
    assert.equal(s.live, '2026-11-27');
    assert.equal(s.fits, true);
    assert.equal(s.restarted, '2026-11-23');
    assert.equal(s.liveAt, 5);
});
