import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {localDate, nextPriceFetchMs, normalisePrices, parseCostFormula, slotOf} from '../lib/autopilot/prices';

const live = JSON.parse(readFileSync(join(__dirname, 'fixtures/energy-prices-se3-2026-10-30.json'), 'utf8'));
const formula = '{{([[price]]+0.041+0.36+0.208)*1.25}}';

test('the cost formula parser evaluates arithmetic and refuses anything else', () => {
    assert.equal(parseCostFormula(formula)!(1), (1 + 0.041 + 0.36 + 0.208) * 1.25);
    assert.equal(parseCostFormula('{{-[[price]]*2+(3-1)/4}}')!(5), -9.5);
    assert.equal(parseCostFormula('[[price]]')!(2), 2);
    for (const bad of ['{{process.exit()}}', '{{[[price]]+}}', '{{([[price]]}}', '{{2 3}}', '', 42, null])
        assert.equal(parseCostFormula(bad), undefined, String(bad));
});

test('a live SE3 day becomes 96 quarter-hour slots with the owner\'s costs applied', () => {
    const day = normalisePrices(live, formula);
    assert.equal(day.costsApplied, true);
    assert.equal(day.slots.length, 96);
    assert.equal(day.slots[0].slot, slotOf(Date.parse('2026-10-29T23:00:00Z')));
    assert.equal(day.slots[0].spot, 1.1174);
    assert.ok(Math.abs(day.slots[0].price - (1.1174 + 0.609) * 1.25) < 1e-9);
    assert.ok(Math.abs(Math.max(...day.slots.map((s) => s.price)) - live.highestPriceWithUserCosts) < 1e-6);
});

test('a formula that does not reproduce Homey\'s own maximum falls back to spot', () => {
    for (const expression of ['{{[[price]]*2}}', 'not a formula', undefined]) {
        const day = normalisePrices(live, expression);
        assert.equal(day.costsApplied, false);
        assert.equal(day.slots[0].price, day.slots[0].spot);
    }
});

test('an hourly zone expands to four slots, and a DST day keeps every UTC slot', () => {
    const hours = Array.from({length: 25}, (_, i) => ({
        periodStart: new Date(Date.UTC(2025, 9, 25, 22 + i)).toISOString(),
        periodEnd: new Date(Date.UTC(2025, 9, 25, 23 + i)).toISOString(), value: i}));
    const day = normalisePrices({pricesPerInterval: hours}, undefined);
    assert.equal(day.slots.length, 100);
    assert.deepEqual(day.slots.slice(0, 5).map((s) => s.spot), [0, 0, 0, 0, 1]);
});

test('broken intervals are skipped, not fatal', () => {
    const day = normalisePrices({pricesPerInterval: [{periodStart: 'x', periodEnd: 'y', value: 1},
        {periodStart: '2026-10-30T00:00:00Z', periodEnd: '2026-10-30T00:15:00Z', value: null},
        {periodStart: '2026-10-30T00:15:00Z', periodEnd: '2026-10-30T00:30:00Z', value: 0.5}]}, formula);
    assert.equal(day.slots.length, 1);
    assert.equal(normalisePrices({error: 'Timeout after 10000ms'}, formula).slots.length, 0);
});

test('local dates and the fetch schedule follow the Homey time zone', () => {
    const tz = 'Europe/Stockholm';
    assert.equal(localDate(Date.parse('2026-10-29T23:30:00Z'), tz), '2026-10-30');
    assert.equal(localDate(Date.parse('2026-10-30T22:30:00Z'), tz, 1), '2026-10-31');
    const at = (iso: string) => Date.parse(iso);
    assert.equal(nextPriceFetchMs(at('2026-10-30T12:00:00Z'), tz, false), 15 * 60000);
    assert.equal(nextPriceFetchMs(at('2026-10-30T12:00:00Z'), tz, true), 60 * 60000);
    assert.equal(nextPriceFetchMs(at('2026-10-30T09:00:00Z'), tz, false), 60 * 60000);
});
