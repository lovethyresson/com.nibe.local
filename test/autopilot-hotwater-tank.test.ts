import {test} from 'node:test';
import assert from 'node:assert';
import {joinReadings, tankChart} from '../lib/autopilot/hotwater-tank';
import {TankView} from '../lib/autopilot/hotwater-shadow';

const u = undefined;
// A short "day" of 12 slots (3 h) and 4 more of tomorrow; now is slot 6. Readings every fourth
// slot (Insights' hourly), a plan from slot 5 (a step behind), 20 L then 40 L used.
const view = (): TankView => ({
    slots: Array.from({length: 16}, () => ({})),
    read: [200, u, u, u, 180, u, 170, u, u, u, u, u, u, u, u, u],
    plan: [u, u, u, u, u, 175, 168, 160, 150, 140, 130, 120, 110, 100, 250, 240],
    drawn: [20, 40, 5, u],
    forecast: [30, 30, 60, 0],
});

test('the tank is read up to now and planned from now; the lines meet at the reading now', () => {
    const c = tankChart(view(), 6, 12);
    assert.deepStrictEqual(c.read, [200, 195, 190, 185, 180, 175, 170, u, u, u, u, u, u, u, u, u]);
    assert.deepStrictEqual(c.plan.slice(4, 9), [u, u, 170, 160, 150], 'nothing behind now; now is the reading');
    assert.strictEqual(c.plan[15], 240, 'the plan runs on into tomorrow');
});

test('use is a running total per hour, ending at now; the usual day runs to the day\'s end', () => {
    const c = tankChart(view(), 6, 12);
    assert.deepStrictEqual(c.used, [[0, 0], [4, 20], [6, 60]]);
    assert.deepStrictEqual(c.expected, [[0, 0], [4, 30], [8, 60], [12, 120]]);
    assert.strictEqual(c.usedTotal, 60);
    assert.strictEqual(c.expectedTotal, 120);
});

test('each panel has its own round scale', () => {
    const c = tankChart(view(), 6, 12);
    assert.ok(c.tankAxis.max >= 250 && c.tankAxis.gridlines[0] === 0);
    assert.ok(c.useAxis.max >= 120 && c.useAxis.gridlines[c.useAxis.gridlines.length - 1] === c.useAxis.max);
});

test('hourly readings are joined into a line; a long gap stays open', () => {
    assert.deepStrictEqual(joinReadings([u, 200, u, u, u, 160, u, u, u, u, u, u, u, 100]),
        [u, 200, 190, 180, 170, 160, u, u, u, u, u, u, u, 100]);
});
