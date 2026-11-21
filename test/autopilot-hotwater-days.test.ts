/** The day record: one compact line a day, kept a year. */
import {test} from 'node:test';
import assert from 'node:assert';
import {DayAcc, daySample} from '../lib/autopilot/hotwater-days';

const SLOT = 15 * 60_000;

test('a day is recorded when the next one starts, hour by hour, with its safety facts', () => {
    let acc: DayAcc | undefined;
    const done = [];
    for (let k = 0; k < 96 + 1; k++) {
        const date = k < 96 ? '2026-11-17' : '2026-11-18';
        const hour = Math.floor(k / 4) % 24;
        // 18:00–18:59 drains the tank under the 40 L minimum.
        const litres = hour === 18 ? 30 - (k % 4) : 200;
        const out = daySample(acc, {at: k * SLOT, date, hour, dayType: k < 90 ? 'working' : 'free', litres,
            produced: 1000 + k * 0.1, top: hour === 18 ? 38 : 55, price: hour === 18 ? 2 : 1, reserveLitres: 40});
        acc = out.acc;
        if (out.done) done.push(out.done);
    }
    assert.strictEqual(done.length, 1);
    const d = done[0];
    assert.strictEqual(d.date, '2026-11-17');
    assert.strictEqual(d.dt, 'working', 'the type in force most of the day');
    assert.strictEqual(d.slots, 96);
    assert.strictEqual(d.underMin, 60);
    assert.deepStrictEqual(d.hours[18], [30, 27, 1007.2, 1007.5, 38, 2]);
    assert.deepStrictEqual(acc!.date, '2026-11-18', 'the new day starts with the slot that ended the old one');
    assert.strictEqual(acc!.slots, 1);
});

test('an hour never read stays empty, and a missing reading leaves its field empty', () => {
    const {acc} = daySample(undefined, {at: 0, date: '2026-11-17', hour: 3, top: 50});
    const {done} = daySample(acc, {at: SLOT, date: '2026-11-18', hour: 0});
    assert.strictEqual(done!.hours[0], null);
    assert.deepStrictEqual(done!.hours[3], [null, null, null, null, 50, null]);
    assert.strictEqual(done!.dt, undefined);
});
