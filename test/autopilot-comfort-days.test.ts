import {test} from 'node:test';
import assert from 'node:assert';
import {addComfortSlot, comfortSummary, readComfortDays} from '../lib/autopilot/comfort-days';

const slot = (date: string, ti: number, extra: {te?: number; sun?: number} = {}) =>
    ({date, ti, comfort: 22.5, lower: 0.5, upper: 0.5, ...extra});

test('a day counts the slots outside the range, how far it strayed, and its weather', () => {
    let days = addComfortSlot([], slot('2026-11-15', 22.4, {te: 5, sun: 0}));
    days = addComfortSlot(days, slot('2026-11-15', 23.2, {te: 2, sun: 300}));
    days = addComfortSlot(days, slot('2026-11-15', 21.9, {te: 7, sun: 100}));
    assert.strictEqual(days.length, 1);
    const d = days[0];
    assert.strictEqual(d.slots, 3);
    assert.strictEqual(d.outside, 2, '23.2 above 23.0 and 21.9 below 22.0');
    assert.ok(Math.abs(d.maxAbove - 0.7) < 1e-9 && Math.abs(d.maxBelow - 0.6) < 1e-9);
    assert.deepStrictEqual([d.teMin, d.teMax, d.sun], [2, 7, 400]);
    assert.deepStrictEqual(comfortSummary(d), {hours: 0.8, inRange: 0.3, meanOff: 0.47, maxBelow: 0.6, maxAbove: 0.7});
});

test('a new date starts a new day; 14 days are kept', () => {
    let days = addComfortSlot([], slot('2026-11-01', 22.5));
    for (let k = 2; k <= 20; k++) days = addComfortSlot(days, slot(`2026-11-${String(k).padStart(2, '0')}`, 22.5));
    assert.strictEqual(days.length, 14);
    assert.strictEqual(days[0].date, '2026-11-07');
    assert.strictEqual(days[13].date, '2026-11-20');
});

test('a reading that is not a number changes nothing; junk in the store is dropped', () => {
    const days = addComfortSlot([], slot('2026-11-15', 22.5));
    assert.strictEqual(addComfortSlot(days, slot('2026-11-15', NaN)), days);
    assert.deepStrictEqual(readComfortDays([{date: 'x', slots: 1, outside: 0}, null, {date: 3}, 'y']).length, 1);
    assert.deepStrictEqual(readComfortDays(undefined), []);
});
