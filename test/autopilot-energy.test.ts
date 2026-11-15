import {test} from 'node:test';
import assert from 'node:assert';
import {energyChart} from '../lib/autopilot/energy';

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
