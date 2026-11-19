import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_STEP_K, MAX_STEPS, READY_DAYS_BEFORE, REPEAT_DAYS, CurveSample, addSample, curveAdvice, isNews, readCurveStore,
    slopeOf, trimShiftFor} from '../lib/autopilot/curve-advice';

const days = (n: number, integral: (d: number) => number, te: (d: number) => number = () => 2): CurveSample[] =>
    Array.from({length: n}, (_, d) => ({day: 100 + d, integral: integral(d), te: te(d)}));
const base = {today: 109, readyDays: 8, offset: 0, curveGain: 1.2, stepK: 1.5};

test('a steady learned trim becomes a curve offset, in the pump\'s own steps', () => {
    // 2 K of fed outdoor on a curve of 1.2 supply K per K: 2.4 K of supply, 1.5 K a step: 2 steps.
    const advice = curveAdvice({...base, samples: days(10, () => 2)});
    assert.deepEqual({from: advice?.from, to: advice?.to}, {from: 0, to: 2});
    // Too warm: down.
    assert.equal(curveAdvice({...base, samples: days(10, () => -2)})?.to, -2);
});

test('no advice while the model learns, in its first week, or while the trim still moves', () => {
    assert.equal(curveAdvice({...base, readyDays: undefined, samples: days(10, () => 2)}), undefined);
    assert.equal(curveAdvice({...base, readyDays: READY_DAYS_BEFORE - 1, samples: days(10, () => 2)}), undefined);
    assert.equal(curveAdvice({...base, samples: days(10, (d) => d * 0.3)}), undefined, 'still learning: 0.6 K over three days');
    assert.equal(curveAdvice({...base, samples: days(2, () => 2), today: 101}), undefined, 'three days needed');
});

test('nothing to say when the curve is about right', () => {
    assert.equal(curveAdvice({...base, samples: days(10, () => 0.4)}), undefined, '0.5 K of supply is under a step');
});

test('at most three steps at a time, and never past the pump\'s range', () => {
    assert.equal(curveAdvice({...base, samples: days(10, () => 9)})?.to, MAX_STEPS);
    assert.equal(curveAdvice({...base, offset: 9, samples: days(10, () => 9)})?.to, 10);
});

test('without a measured step it errs towards fewer steps, NIBE\'s 2.5 K', () => {
    assert.equal(curveAdvice({...base, stepK: undefined, samples: days(10, () => 2)})?.to, Math.round(2.4 / DEFAULT_STEP_K));
});

test('after a change it waits a month, and reads only what the new curve has seen', () => {
    const samples = days(40, (d) => (d < 10 ? 2 : 0.1));
    assert.equal(curveAdvice({...base, today: 120, samples, changed: 109}), undefined, 'within the month');
    assert.equal(curveAdvice({...base, today: 139, samples, changed: 109}), undefined, 'the new curve holds');
});

test('a trim that grows with the cold is a curve too flat: steeper, as advice', () => {
    // Colder days need more: 0.3 K of trim per K colder over 12 K of weather.
    const samples = days(12, (d) => 1 + 0.3 * (6 - d), (d) => -4 + d);
    assert.equal(slopeOf(samples), 'steeper');
    assert.equal(slopeOf(days(12, (d) => 1 - 0.3 * (6 - d), (d) => -4 + d)), 'flatter');
    assert.equal(slopeOf(days(12, () => 1, (d) => -4 + d)), undefined, 'level only');
    assert.equal(slopeOf(days(12, (d) => 0.3 * d, () => 2)), undefined, 'too little weather to tell');
});

test('the trim moves back by what the new offset gives', () => {
    // +2 steps of 1.5 K supply on a curve of 1.2 K per K: 2.5 K less trim.
    assert.equal(trimShiftFor(2, 1.2, 1.5), -2.5);
    assert.equal(trimShiftFor(-1, 1.2, 1.5), 1.25);
    assert.equal(trimShiftFor(2, undefined, 1.5), 0, 'no curve, no guess');
});

test('the same advice is told once a month; different advice at once', () => {
    const advice = {from: 0, to: 2, supplyK: 2.4, integral: 2};
    assert.equal(isNews(advice, undefined, 10), true);
    assert.equal(isNews(advice, {day: 5, to: 2}, 10), false);
    assert.equal(isNews(advice, {day: 5, to: 2}, 5 + REPEAT_DAYS), true);
    assert.equal(isNews({...advice, to: 3}, {day: 5, to: 2}, 10), true);
});

test('the store reads back, and anything unanswered is advice only', () => {
    assert.equal(readCurveStore(null).choice, 'self');
    assert.equal(readCurveStore({choice: 'auto'}).choice, 'auto');
    assert.deepEqual(readCurveStore({choice: 'auto', samples: [{day: 1, integral: 1, te: 2}, {day: 'x'}], offset: 2}),
        {choice: 'auto', samples: [{day: 1, integral: 1, te: 2}], offset: 2});
    // One sample a day, the latest wins, three weeks kept.
    const kept = addSample(addSample(days(30, () => 1), {day: 129, integral: 5, te: 0}), {day: 130, integral: 2, te: 0});
    assert.equal(kept.find((s) => s.day === 129)?.integral, 5);
    assert.ok(kept.every((s) => s.day > 130 - 21));
});
