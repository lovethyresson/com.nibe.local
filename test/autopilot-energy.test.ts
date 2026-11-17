import {test} from 'node:test';
import assert from 'node:assert';
import {energyChart, withLiveHours} from '../lib/autopilot/energy';

const H = 3_600_000;
// Six hours; prices 1–6 kr; heating every hour so far (four), hot water in two.
const hours = Array.from({length: 6}, (_, k) => k * H);
const prices = new Map(hours.map((at, k) => [at, k + 1]));
const heating = new Map([[0, 1], [H, 1], [2 * H, 0.5], [3 * H, 0.5]]);
const hotwater = new Map([[0, 2], [3 * H, 2]]);

test('kWh, cost and the share used in the cheapest third', () => {
    const c = energyChart(hours, {heating, hotwater}, prices);
    assert.strictEqual(c.kwh, 7);
    assert.strictEqual(c.cost, 1 * 3 + 2 * 1 + 3 * 0.5 + 4 * 2.5);
    // The cheapest third is hours 0 and 1: 3 + 1 kWh of 7.
    assert.strictEqual(c.cheapShare, Math.round(4 / 7 * 1000) / 1000);
});

test('each hour carries its use by function and its price; hours to come have only a price', () => {
    const c = energyChart(hours, {heating, hotwater}, prices);
    assert.deepStrictEqual(c.hours[0], {use: {heating: 1, hotwater: 2}, price: 1});
    assert.deepStrictEqual(c.hours[5], {use: {}, price: 6});
    assert.ok(c.kwhAxis.max >= 3 && c.priceAxis.max >= 6);
});

test('no use yet: no share; no prices: no cost', () => {
    assert.strictEqual(energyChart(hours, {}, prices).cheapShare, undefined);
    const free = energyChart(hours, {heating}, new Map());
    assert.strictEqual(free.cost, 0);
    assert.strictEqual(free.kwh, 3);
});

test('today runs up to now: live hours after the last Insights hour, the meter\'s total kept', () => {
    // Insights to the 18:00 hour (its mean 118.5); the meter now 121; live from 19:00: 1 and 0.3.
    const insights = new Map([[17 * H, 1], [18 * H, 1]]);
    const live = new Map([[17 * H, 0.9], [19 * H, 1], [20 * H, 0.3]]);
    const out = withLiveHours(insights, {at: 18 * H, v: 118.5}, 121, live, 20.3 * H);
    assert.deepEqual([...out].sort((a, b) => a[0] - b[0]),
        [[17 * H, 1], [18 * H, 1], [19 * H, 2.2], [20 * H, 0.3]]); // 19:00 also takes the 1.2 not in live
    const added = [...out.values()].reduce((s, v) => s + v, 0) - 2;
    assert.ok(Math.abs(added - 2.5) < 1e-9); // what the meter added since the seam
    // No seam (nothing from Insights yet): the live hours alone.
    assert.deepEqual([...withLiveHours(new Map(), undefined, 121, live)].length, 3);
    // Insights' last point is this hour's, still filling: the rest stays in this hour.
    const filling = withLiveHours(new Map([[20 * H, 0.5]]), {at: 20 * H, v: 120}, 120.2, new Map(), 20.3 * H);
    assert.deepEqual([...filling.keys()], [20 * H]);
    assert.ok(Math.abs(filling.get(20 * H)! - 0.7) < 1e-9);
    // A meter set back: nothing beyond the live hours.
    assert.equal(withLiveHours(insights, {at: 18 * H, v: 118.5}, 50, live, 20.3 * H).get(19 * H), 1);
});
