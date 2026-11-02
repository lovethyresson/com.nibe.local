import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Aggregator, FIELDS, FLAG, History, RECORD_BYTES, applyJournal, encodeRecord} from '../lib/smart/history';
import {electricityPerSlot, heatPerSlot} from '../lib/smart/heat';
import {SLOT_MS} from '../lib/smart/prices';

const t0 = 2_000_000 * SLOT_MS; // slot 2,000,000
const price = {price: 2.5, spot: 1.2, costsApplied: true};
const weather = {gtiS: 300, gtiE: 120, gtiW: 80, ghi: 150, wind: 3, rh: 80, cloud: 40};

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

test('a BT1 fed from elsewhere is recognised against the forecast and replaced by it', () => {
    const history = new History(8);
    // 2026-11-02: the pump read 3.6 °C while a probe fed it, against a real ~7.3 °C.
    const fedAt = (te: number, outdoor?: number) => {
        const agg = new Aggregator(history, () => ({outdoor}));
        for (let i = 0; i < 90; i++) agg.sample(t0 + i * 10_000, 10, {ti: 21, te});
        agg.flush(10);
        return history.get(2_000_000)!;
    };
    const fed = fedAt(3.6, 7.3);
    assert.ok(Math.abs(fed.te - 7.3) < 1e-6);
    assert.equal(fed.flags & (FLAG.fedOutdoor | FLAG.forecastOutdoor), FLAG.fedOutdoor | FLAG.forecastOutdoor);
    // An ordinary forecast miss stays the pump's reading.
    const miss = fedAt(5.6, 7.3);
    assert.ok(Math.abs(miss.te - 5.6) < 1e-6);
    assert.equal(miss.flags & FLAG.fedOutdoor, 0);
    // Without a forecast there is nothing to judge against.
    assert.ok(Math.abs(fedAt(3.6).te - 3.6) < 1e-6);
    // The owner's sensor wins, and is what the slot says it used.
    const agg = new Aggregator(history, () => ({outdoor: 7.3, sensor: 7.2}));
    for (let i = 0; i < 90; i++) agg.sample(t0 + i * 10_000, 10, {ti: 21, te: 3.6});
    agg.flush(10);
    const sensed = history.get(2_000_000)!;
    assert.ok(Math.abs(sensed.te - 7.2) < 1e-6);
    assert.equal(sensed.flags & (FLAG.sensorOutdoor | FLAG.fedOutdoor), FLAG.sensorOutdoor | FLAG.fedOutdoor);
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

test('compressor Hz spent on hot water gets none of the heating step', () => {
    const heat = heatPerSlot([
        {slot: 1, qmeter: 10.0, hz: 50},
        {slot: 2, qmeter: 10.0, hz: 50, dhw: 1},
        {slot: 3, qmeter: 10.3, hz: 50, dhw: 0.5},
    ]);
    assert.ok(Math.abs(heat.get(2)!) < 1e-9);
    assert.ok(Math.abs(heat.get(3)! - 0.3) < 1e-9);
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

test('electricity comes from the consumption counter, shaped by the power reading', () => {
    const pel = electricityPerSlot([
        {slot: 1, emeter: 500.0, pw: 1000},
        {slot: 2, emeter: 500.0, pw: 1000},
        {slot: 3, emeter: 501.2, pw: 3000},
    ]);
    assert.ok(Math.abs(pel.get(2)! - 0.3) < 1e-9);
    assert.ok(Math.abs(pel.get(3)! - 0.9) < 1e-9);
});

test('closed slots journal as records that replay onto the last full save', () => {
    const saved = new History(8);
    const journal: Buffer[] = [];
    const agg = new Aggregator(saved, () => ({}), (slot, values) => journal.push(encodeRecord(slot, values)));
    for (let k = 0; k < 3; k++)
        for (let i = 0; i < 90; i++) agg.sample(t0 + k * SLOT_MS + i * 10_000, 10, {ti: 20 + k, te: 5});
    agg.flush(10);
    assert.equal(journal.length, 3);
    const restored = History.deserialize(new History(8).serialize())!;
    const bytes = Buffer.concat([...journal, Buffer.alloc(RECORD_BYTES - 3)]); // torn last write
    assert.equal(applyJournal(restored, bytes), 3);
    for (let k = 0; k < 3; k++) assert.deepEqual(restored.get(2_000_000 + k), saved.get(2_000_000 + k));
});

test('a file and journal from before the wall fields load with those fields missing', () => {
    const old = FIELDS.length - 2;
    const history = new History(4);
    history.put(7, Object.fromEntries(FIELDS.map((f, i) => [f, i])) as any);
    // Rewrite the current file as the older writer would have: fewer fields per slot.
    const current = history.serialize();
    const capacity = 4;
    const legacy = Buffer.alloc(12 + capacity * 4 * (1 + old));
    current.copy(legacy, 0, 0, 12 + capacity * 4);
    legacy.writeUInt8(old, 5);
    for (let i = 0; i < capacity; i++)
        current.copy(legacy, 12 + capacity * 4 + i * old * 4, 12 + capacity * 4 + i * FIELDS.length * 4,
            12 + capacity * 4 + (i * FIELDS.length + old) * 4);
    assert.equal(History.fieldCount(legacy), old);
    const back = History.deserialize(legacy)!;
    assert.equal(back.get(7)!.flags, FIELDS.indexOf('flags'));
    assert.ok(Number.isNaN(back.get(7)!.gtiE) && Number.isNaN(back.get(7)!.gtiW));
    const record = Buffer.alloc(4 + 4 * old);
    record.writeUInt32BE(9, 0);
    record.writeFloatBE(21.5, 4);
    assert.equal(applyJournal(back, record, old), 1);
    assert.equal(back.get(9)!.ti, 21.5);
    assert.ok(Number.isNaN(back.get(9)!.gtiW));
});
