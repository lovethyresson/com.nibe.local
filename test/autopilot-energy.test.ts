import {test} from 'node:test';
import assert from 'node:assert';
import {energyChart, useToday} from '../lib/autopilot/energy';

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

test('today, up to now: the meter slot by slot since the app ran, Insights before', () => {
    const Q = H / 4, day = Array.from({length: 24}, (_, k) => k * H);
    // App ran since before midnight: every slot counted, nothing from yesterday.
    const slots = new Map([[-Q, 5], [0, 0.25], [Q, 0.25], [20 * H, 0.1]]);
    const a = useToday({points: [{at: -H, v: 100}], liveFrom: {at: -2 * H, v: 90}, slots, meterNow: 200}, day, 20.3 * H);
    assert.deepEqual([...a.use], [[0, 0.5], [20 * H, 0.1]]);
    assert.deepEqual([...a.slots], [[0, 0.25], [Q, 0.25], [20 * H, 0.1]]);
    // Started at 19:05: Insights to the 17:00 hour (mean 117.5, about 17:30), the meter 118.7 at
    // 19:15, then two slots.
    const points = [{at: 16 * H, v: 116.5}, {at: 17 * H, v: 117.5}];
    const b = useToday({points, liveFrom: {at: 19.25 * H, v: 118.7}, slots: new Map([[19 * H, 0.1], [19.25 * H, 0.3], [19.5 * H, 0.2]]), meterNow: 119.2}, day, 19.7 * H);
    const close = (x: number | undefined, y: number) => assert.ok(x !== undefined && Math.abs(x - y) < 1e-9, `${x} vs ${y}`);
    close(b.use.get(17 * H), 1);       // 16:30–17:30 from Insights
    close(b.use.get(19 * H), 1.2 + 0.5); // 17:30–19:15 bridged into the hour before 19:15, then the slots
    assert.equal(b.slots.size, 2);
    // The total is the meter's own since Insights' first middle.
    close([...b.use.values()].reduce((x, y) => x + y, 0), 119.2 - 116.5);
    // Still in the first slot: the bridge to now and the slot so far.
    const c = useToday({points, slots: new Map([[19 * H, 0.1]]), meterNow: 118.9}, day, 19.1 * H);
    close([...c.use.values()].reduce((x, y) => x + y, 0), 118.9 - 116.5);
    // Nothing from Insights, the app running since 19:15: the slots alone.
    assert.deepEqual([...useToday({points: [], liveFrom: {at: 19.25 * H, v: 1}, slots: new Map([[19.25 * H, 0.3]]), meterNow: 1.3}, day, 19.4 * H).use], [[19 * H, 0.3]]);
});

test('cost: each 15-minute slot at its own price, the rest at the hour\'s mean', () => {
    const Q = H / 4;
    const slotPrices = new Map([[0, 0.8], [Q, 0.8], [2 * Q, 2], [3 * Q, 2]]);
    const c = energyChart([0], {heating: new Map([[0, 1]])}, new Map([[0, 1.4]]),
        {slots: {heating: new Map([[0, 0.5], [Q, 0.5]])}, prices: slotPrices});
    assert.equal(c.cost, 0.8); // Homey Energy's figure; the hour's mean would say 1.40
});
