import {test} from 'node:test';
import assert from 'node:assert';
import {joinReadings, tankChart} from '../lib/autopilot/hotwater-tank';
import {TankView} from '../lib/autopilot/hotwater-shadow';

// Eight slots (two hours): read for the first three, planned from the third, a charge done at
// slot 1 and one planned at slot 6, prices rising.
const view = (): TankView => ({
    slots: [1, 1, 2, 2, 3, 3, 4, undefined].map((price, k) => ({
        ...price === undefined ? {} : {price}, ...k === 1 ? {ran: true as const} : {}, ...k === 6 ? {charge: 0} : {}})),
    read: [200, 210, 190, undefined, undefined, undefined, undefined, undefined],
    plan: [undefined, 260, 185, 170, 150, 140, 180, 230],
    drawn: [12, 30], forecast: [20, 40],
});

test('the tank is read behind now and planned from now, meeting at the reading now', () => {
    const c = tankChart(view(), 2);
    assert.deepStrictEqual(c.slots.map((s) => s.read), [200, 210, 190, undefined, undefined, undefined, undefined, undefined]);
    assert.deepStrictEqual(c.slots.map((s) => s.plan), [undefined, undefined, 190, 170, 150, 140, 180, 230], 'a stale plan slot behind now is dropped');
    assert.ok(c.slots[1].ran && c.slots[6].charge === 0);
});

test('use per hour: drawn only up to now\'s hour, the forecast for every hour; today\'s totals', () => {
    const c = tankChart(view(), 2);
    assert.deepStrictEqual(c.hours, [{forecast: 20, drawn: 12}, {forecast: 40}]);
    assert.strictEqual(c.used, 12);
    assert.strictEqual(c.expected, 60);
});

test('prices fall into thirds; a slot with no price has no tier; the axis covers the tank', () => {
    const c = tankChart(view(), 2);
    assert.deepStrictEqual(c.slots.map((s) => s.tier), [0, 0, 0, 1, 1, 2, 2, undefined]);
    assert.ok(c.max >= 230 && c.gridlines[0] === 0 && c.gridlines[c.gridlines.length - 1] === c.max);
});

test('hourly readings are joined into a line; a long gap stays open', () => {
    const u = undefined;
    assert.deepStrictEqual(joinReadings([u, 200, u, u, u, 160, u, u, u, u, u, u, u, 100]),
        [u, 200, 190, 180, 170, 160, u, u, u, u, u, u, u, 100]);
});
