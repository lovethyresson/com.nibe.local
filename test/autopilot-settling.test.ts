import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ASK_WAIT_DAYS, CALIBRATE_MAX_DAYS, CHECK_DAYS, MAX_DAYS, SettleState, calibrateDay, change, checkedWhileSettling, readSettle, withinRange, scoreDay, settleDone, settleRun, stepOf,
    projectSettle, settleProgress, shiftEta, streak} from '../lib/autopilot/settling';

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
    assert.equal(stepOf({...s, live: '2026-11-26'}, true), 'done');
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

test('after a curve change, CHECK_DAYS in a row holding the thermostat end it; a miss starts the count over', () => {
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

test('the check is as long as settling\'s', () => {
    assert.equal(CHECK_DAYS, 2, 'the tests below are written for a two-day check');
});

test('a curve changed while settling: the settled days after it are the check', () => {
    let s: SettleState = {start: '2026-11-20', days: []};
    s = scoreDay(s, day('2026-11-21', 21.8)).state;
    s = scoreDay(s, day('2026-11-22', 22.0)).state;
    const changed = {fits: false, changed: '2026-11-22'};
    s = scoreDay(s, day('2026-11-23', 22.4)).state;
    assert.equal(checkedWhileSettling(s, changed), false, 'not settled yet');
    s = scoreDay(s, day('2026-11-24', 22.5)).state;
    assert.equal(s.settled, '2026-11-24');
    assert.equal(checkedWhileSettling(s, changed), true, `${CHECK_DAYS} settled days after the change`);
    assert.equal(checkedWhileSettling(s, {fits: false, changed: '2026-11-23'}), false, 'one day after a later change');
    assert.equal(checkedWhileSettling(s, {fits: false}), false, 'no change: calibrating waits for the advice');
    assert.equal(checkedWhileSettling(s, {fits: false, changed: '2026-11-19'}), false, 'a change before the start is not checked');
});

test('a change late in settling: calibrating counts its settled days and needs only the rest', () => {
    let s: SettleState = {start: '2026-11-20', days: []};
    s = scoreDay(s, day('2026-11-21', 22.0)).state;
    s = scoreDay(s, day('2026-11-22', 22.4)).state;
    const curve = {fits: false, changed: '2026-11-22'};
    s = scoreDay(s, day('2026-11-23', 22.5)).state;
    assert.equal(s.settled, '2026-11-23');
    assert.equal(checkedWhileSettling(s, curve), false, 'one settled day after the change');
    let r = calibrateDay(s, day('2026-11-24', 21.9), curve);
    assert.deepEqual(r.state.calibrating!.days.map((d) => d.date), ['2026-11-23', '2026-11-24'], 'the settled day, then today');
    assert.equal(r.event, undefined, 'today missed');
    r = calibrateDay(r.state, day('2026-11-25', 22.5), curve);
    assert.equal(r.state.calibrating!.days.length, 3, 'seeded once, not again');
    assert.equal(r.event, undefined);
    r = calibrateDay(r.state, day('2026-11-26', 22.5), curve);
    assert.deepEqual(r.event, {kind: 'live', reason: 'steady'});
});

test('a change from before Autopilot started is not calibrating\'s', () => {
    const r = calibrateDay(settledOn('2026-11-24'), day('2026-11-25', 22.5), {fits: true, changed: '2026-10-30'});
    assert.equal(r.event?.reason, 'fits');
});

test('an owner who was asked and changed nothing: on without it after ASK_WAIT_DAYS', () => {
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

test('the projection carries the pace so far on to the band around the thermostat', () => {
    const day = (date: string, mean: number, setpoint = 22.5) => ({date, mean, setpoint});
    // 2026-11-22/23 on the S1155: 21.8, then 21.9, of 22.5: in the band (22.3) on the fourth day after.
    assert.deepEqual(projectSettle([day('2026-11-21', 21.8), day('2026-11-22', 21.9)]), [22, 22.1, 22.2, 22.3]);
    // The pace is the last four days': an early jump fades out.
    assert.deepEqual(projectSettle([day('a', 20.5), day('b', 21.7), day('c', 21.8), day('d', 21.9), day('e', 22.0)]), [22.1, 22.2, 22.3]);
    assert.equal(projectSettle([day('a', 21.8)]), undefined, 'one day has no pace');
    assert.equal(projectSettle([day('a', 21.9), day('b', 21.8)]), undefined, 'moving away: nothing to promise');
    assert.equal(projectSettle([day('a', 21.9), day('b', 21.9)]), undefined, 'standing still');
    assert.equal(projectSettle([day('a', 22.2), day('b', 22.4)]), undefined, 'already in the band');
    assert.equal(projectSettle([day('a', 20.0), day('b', 20.03)]), undefined, 'would not get there before MAX_DAYS');
    // A new thermostat: only its own days set the pace.
    assert.deepEqual(projectSettle([day('a', 21.0, 21.5), day('b', 21.9), day('c', 22.0)]), [22.1, 22.2, 22.3]);
    // Coming down from above works the same way.
    assert.deepEqual(projectSettle([day('a', 23.3), day('b', 23.1)]), [22.9, 22.7]);
});

test('price shifts start on a day within the comfort range, either side, and not on a day that says nothing', () => {
    assert.equal(withinRange(day('2026-11-23', 22.04), 0.5, 0.5), true, '0.5 below, rounded to a tenth: inside');
    assert.equal(withinRange(day('2026-11-23', 21.94), 0.5, 0.5), false, '0.6 below');
    assert.equal(withinRange(day('2026-11-23', 23.0), 0.5, 0.5), true, '0.5 above');
    assert.equal(withinRange(day('2026-11-23', 23.0), 0.5, 0.3), false, 'the upper side has its own limit');
    assert.equal(withinRange(day('2026-11-23', 20.5), 3, 3), true, 'a wider range');
    assert.equal(withinRange(day('2026-11-23', 22.5, 22.5, 50), 0.5, 0.5), false, 'too few readings');
    assert.equal(withinRange(day('2026-11-23', 22.5, 22.5, 96, 20), 0.5, 0.5), false, 'a setpoint that moved (Away)');
    assert.equal(withinRange(day('2026-11-23', undefined), 0.5, 0.5), false, 'no mean');
});

test('the run on target counts the last days within the band, for "1 of 2 days on target"', () => {
    const d = (mean: number) => ({date: '2026-11-25', mean, setpoint: 22.5});
    assert.equal(settleRun([]), 0);
    assert.equal(settleRun([d(21.8), d(22.4)]), 1);
    assert.equal(settleRun([d(22.4), d(22.2)]), 0, 'a miss ends the run');
    assert.equal(settleRun([d(22.3), d(22.7)]), 2, 'the band is ±0.2 K, both sides');
});

test('the widget estimates when settling ends and when price shifts start', () => {
    const s = (date: string, mean: number) => ({date, mean, setpoint: 22.5});
    // Climbing 0.2 a day from 21.6: in the band (22.3) on the 4th projected day, the 2nd day there one later.
    const days = [s('2026-11-25', 21.4), s('2026-11-26', 21.6)];
    const ahead = projectSettle(days);
    assert.deepEqual(ahead, [21.8, 22, 22.2, 22.4]);
    assert.deepEqual(settleProgress(days, ahead), {have: 0, eta: 5});
    // One day already in the band: one more to go, whatever the projection says.
    assert.deepEqual(settleProgress([s('2026-11-25', 21.9), s('2026-11-26', 22.4)]), {have: 1, eta: 1});
    assert.deepEqual(settleProgress([s('2026-11-26', 21.9)]), {have: 0});
    // Comfort range 0.5 below: 22.0 is the first day within it, the 2nd projected.
    assert.equal(shiftEta(days, ahead, 0.5, 1), 2);
    assert.equal(shiftEta(days, undefined, 0.5, 1), undefined);
    assert.equal(shiftEta(days, [21.8, 21.9], 0.5, 1), undefined);
    // Too warm: within the range only once under its high edge.
    assert.equal(shiftEta([s('2026-11-26', 23.4)], [23.2, 23.0, 22.8], 0.5, 0.5), 2);
});

test('after a curve change while settling, only the days after it count', () => {
    const s = (date: string, mean: number) => ({date, mean, setpoint: 22.5});
    // Changed Fri: Thu doesn't count, Fri is the change day, so Sat and Sun are the two (3 days after Thu).
    const days = [s('2026-11-25', 22.4), s('2026-11-26', 22.2)];
    assert.deepEqual(settleProgress(days, [22.35], '2026-11-27'), {have: 0, eta: 3});
    // A held day before the change is not part of the run that checks it.
    const held = [s('2026-11-25', 22.4), s('2026-11-26', 22.5)];
    assert.deepEqual(settleProgress(held, undefined, '2026-11-26'), {have: 0});
    assert.deepEqual(settleProgress([...held, s('2026-11-27', 22.5)], undefined, '2026-11-26'), {have: 1, eta: 1});
});
