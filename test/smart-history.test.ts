import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Aggregator, FIELDS, FLAG, History} from '../lib/smart/history';
import {heatPerSlot} from '../lib/smart/heat';
import {SLOT_MS} from '../lib/smart/prices';

const t0 = 2_000_000 * SLOT_MS; // slot 2,000,000
const price = {price: 2.5, spot: 1.2, costsApplied: true};
const weather = {gtiS: 300, ghi: 150, wind: 3, rh: 80, cloud: 40};

test('a full slot averages samples, keeps counters\' last value and attaches price and weather', () => {
    const history = new History(8);
    const agg = new Aggregator(history, () => ({price, weather}));
    for (let i = 0; i < 90; i++)
        agg.sample(t0 + i * 10_000, 10, {ti: 20 + (i % 2), te: 5, pw: 1000, qmeter: 100 + i / 100,
            dhw: i < 45, aux: false, dm: undefined});
    agg.sample(t0 + SLOT_MS, 10, {ti: 30}); // closes the first slot
    const slot = history.get(2_000_000)!;
    assert.equal(slot.ti, 20.5);
    assert.equal(slot.pw, 1000);
    assert.ok(Math.abs(slot.qmeter - 100.89) < 1e-4);
    assert.equal(slot.dhw, 0.5);
    assert.equal(slot.aux, 0);
    assert.ok(Number.isNaN(slot.dm));
    assert.equal(slot.coverage, 1);
    assert.equal(slot.flags, FLAG.costs);
    assert.equal(slot.price, 2.5);
    assert.equal(slot.gtiS, 300);
});

test('thin coverage and reconnects mark a slot partial', () => {
    const history = new History(8);
    const agg = new Aggregator(history, () => ({}));
    for (let i = 0; i < 40; i++) agg.sample(t0 + i * 10_000, 10, {ti: 20});
    agg.sample(t0 + SLOT_MS, 10, {ti: 20});
    assert.equal(history.get(2_000_000)!.flags & FLAG.partial, FLAG.partial);
    agg.markReconnect();
    for (let i = 1; i < 90; i++) agg.sample(t0 + SLOT_MS + i * 10_000, 10, {ti: 20});
    agg.flush(10);
    assert.equal(history.get(2_000_001)!.flags & (FLAG.partial | FLAG.reconnect), FLAG.partial | FLAG.reconnect);
});

test('the ring keeps the newest slots and round-trips through its file format', () => {
    const history = new History(4);
    const row = (v: number) => Object.fromEntries(FIELDS.map((f) => [f, v])) as any;
    for (let s = 10; s < 16; s++) history.put(s, row(s));
    assert.deepEqual(history.range(), [12, 13, 14, 15]);
    assert.equal(history.get(11), undefined);
    const back = History.deserialize(history.serialize())!;
    assert.deepEqual(back.range(), [12, 13, 14, 15]);
    assert.equal(back.get(15)!.ti, 15);
    const wrong = history.serialize();
    wrong.writeUInt8(99, 4);
    assert.equal(History.deserialize(wrong), undefined);
    assert.equal(History.deserialize(Buffer.alloc(3)), undefined);
});

test('heat steps are spread back over their slots by compressor Hz', () => {
    const heat = heatPerSlot([
        {slot: 1, qmeter: 10.0, hz: 30},
        {slot: 2, qmeter: 10.0, hz: 30},
        {slot: 3, qmeter: 10.3, hz: 60},
        {slot: 4, qmeter: 10.3, hz: 0},
        {slot: 5, qmeter: 10.4, hz: 0},
    ]);
    assert.ok(Math.abs(heat.get(2)! - 0.1) < 1e-9);
    assert.ok(Math.abs(heat.get(3)! - 0.2) < 1e-9);
    assert.ok(Math.abs(heat.get(4)! - 0.05) < 1e-9);
    assert.ok(Math.abs(heat.get(5)! - 0.05) < 1e-9);
    assert.equal(heat.has(1), false);
});

test('a gap or an unread counter restarts the chain instead of guessing', () => {
    const heat = heatPerSlot([
        {slot: 1, qmeter: 10.0, hz: 30},
        {slot: 3, qmeter: 10.5, hz: 30},
        {slot: 4, qmeter: NaN, hz: 30},
        {slot: 5, qmeter: 10.7, hz: 30},
        {slot: 6, qmeter: 10.8, hz: 30},
    ]);
    assert.deepEqual([...heat.keys()], [6]);
});
