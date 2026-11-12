import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ModelSlot, stepHouse, sunScore} from '../lib/autopilot/model';
import {DailyFit, SUN_DAYS, sunReady} from '../lib/autopilot/house';
import {RADIATOR_HOUSE} from './autopilot-house-sim';

/** Two sunny days of a house the sun really warms, heat held steady, every slot's state known. */
function sunnyDays() {
    const slots: ModelSlot[] = [];
    const states = new Map<number, [number, number]>();
    let ti = 21, tm = 21.5;
    for (let k = 0; k < 2 * 96; k++) {
        const hour = (k / 4) % 24;
        const sun = hour >= 9 && hour < 16 ? 600 * Math.sin(Math.PI * (hour - 9) / 7) : 0;
        const inputs = {te: 2, q: 0.25 * 3.5, sun};
        [ti, tm] = stepHouse(RADIATOR_HOUSE, ti, tm, inputs);
        slots.push({slot: 1000 + k, ti, inputs, usable: true});
        states.set(1000 + k, [ti, tm]);
    }
    return {slots, states};
}

test('on sunny windows the sun term predicts better than leaving it out, when the house really has one', () => {
    const {slots, states} = sunnyDays();
    const score = sunScore(RADIATOR_HOUSE, slots, states);
    assert.ok(score.windows > 0, 'some windows count as sunny');
    assert.ok(score.rmseOn < score.rmseOff, `${score.rmseOn} < ${score.rmseOff}`);
    const dark = {...sunnyDays(), slots: sunnyDays().slots.map((s) => ({...s, inputs: {...s.inputs, sun: 0}}))};
    assert.equal(sunScore(RADIATOR_HOUSE, dark.slots, dark.states).windows, 0, 'no sunny windows on dark days');
});

test('the sun gate: enough days where sun predicted better, and a sun term that has settled', () => {
    const day = (d: number, on: number, off: number, sun = 2): DailyFit =>
        ({day: d, heatLoss: 0.2, tau: 40, rmse: 0.2, sun, sunWindows: 4, sunOn: on, sunOff: off});
    const good = Array.from({length: SUN_DAYS}, (_, i) => day(i, 0.1, 0.3));
    assert.ok(sunReady(good));
    assert.ok(!sunReady(good.slice(1)), 'one day short');
    assert.ok(!sunReady([...good.slice(0, -1), day(SUN_DAYS, 0.4, 0.3)]), 'a worse day does not count');
    assert.ok(!sunReady([...good.slice(0, -1), day(SUN_DAYS, 0.1, 0.3, 4)]), 'the sun term still moving');
    assert.ok(!sunReady(good.map((d) => ({...d, sunWindows: 1}))), 'too few sunny windows to judge a day by');
});
