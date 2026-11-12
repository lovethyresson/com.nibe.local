import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SurplusBudget, effectivePrice} from '../lib/autopilot/solar-surplus';

const forecast = new Map([[10, 3], [11, 2], [12, 0.5]]);

test('the surplus budget: each user sees what users before it left, never the same kW twice', () => {
    const budget = new SurplusBudget();
    budget.reserve('hotwater', new Map([[10, 2], [11, 2]]));
    assert.deepEqual([...budget.available('hotwater', forecast)!], [[10, 3], [11, 2], [12, 0.5]], 'hot water goes first');
    assert.deepEqual([...budget.available('heating', forecast)!], [[10, 1], [11, 0], [12, 0.5]]);
    budget.reserve('heating', new Map([[10, 1]]));
    assert.deepEqual([...budget.available('cooling', forecast)!], [[10, 0], [11, 0], [12, 0.5]]);
    budget.reserve('hotwater', new Map());
    assert.deepEqual([...budget.available('heating', forecast)!], [[10, 3], [11, 2], [12, 0.5]], 'a new reservation replaces the old');
    assert.equal(budget.available('heating', undefined), undefined, 'no generator, no surplus');
});

test('effective price: the surplus covers its share at the export price, the rest is bought', () => {
    assert.deepEqual(effectivePrice(2, 0.5, 1, 2), {price: 1.25, share: 0.5});
    assert.deepEqual(effectivePrice(2, 0.5, 5, 2), {price: 0.5, share: 1});
    assert.deepEqual(effectivePrice(2, 0.5, undefined, 2), {price: 2, share: 0});
    assert.deepEqual(effectivePrice(2, 0.5, 3, 0), {price: 2, share: 0}, 'no draw, nothing to cover');
});
