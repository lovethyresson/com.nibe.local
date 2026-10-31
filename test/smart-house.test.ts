import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DailyFit, HouseFit, drifting, fitHouse, readiness, recordDailyFit, validDays} from '../lib/smart/house';
import {coolDown, houseInsights} from '../lib/smart/insights';
import {RADIATOR_HOUSE, SLAB_HOUSE, simulateHouse} from './smart-house-sim';

const day = (d: number, heatLoss: number, tau: number): DailyFit => ({day: d, heatLoss, tau, rmse: 0.1});

test('readiness needs accuracy, five valid days and a τ steady over three days', () => {
    const slots = simulateHouse(RADIATOR_HOUSE, {days: 8, excitation: 0.4, seed: 2});
    const fit = fitHouse(slots, {system: 'radiators', era: '1960_1979'});
    assert.equal(fit.validDays, 8);
    const steady = [day(1, 0.18, 50), day(2, 0.18, 52), day(3, 0.18, 51)];
    assert.deepEqual(readiness(fit, steady), {ready: true, missing: []});
    assert.deepEqual(readiness(fit, [day(1, 0.18, 40), day(2, 0.18, 52), day(3, 0.18, 51)]).missing, ['stability']);
    assert.deepEqual(readiness({...fit, validDays: 4}, steady).missing, ['days']);
    assert.deepEqual(readiness({...fit, rmse: 0.5}, steady).missing, ['accuracy']);
});

test('a day of only hot water or idle is not a valid day', () => {
    const slots = simulateHouse(RADIATOR_HOUSE, {days: 2, seed: 3});
    assert.equal(validDays(slots), 2);
    assert.equal(validDays(slots.map((s) => ({...s, inputs: {...s.inputs, q: 0}}))), 0);
    assert.equal(validDays(slots.map((s) => ({...s, usable: false}))), 0);
});

test('drift is three consecutive days each moving more than 20 %', () => {
    assert.equal(drifting([day(1, 0.1, 50), day(2, 0.13, 50), day(3, 0.17, 50), day(4, 0.22, 50)]), true);
    assert.equal(drifting([day(1, 0.1, 50), day(2, 0.13, 50), day(3, 0.14, 50), day(4, 0.22, 50)]), false);
    assert.equal(drifting([day(1, 0.1, 50), day(2, 0.13, 50), day(4, 0.17, 50), day(5, 0.22, 50)]), false);
    assert.equal(drifting([day(1, 0.1, 30), day(2, 0.1, 40), day(3, 0.1, 50), day(4, 0.1, 65)]), true);
});

test('daily fits keep one entry per day, latest wins, bounded', () => {
    const fit = {params: RADIATOR_HOUSE, rmse: 0.1} as HouseFit;
    let log: DailyFit[] = [];
    for (let d = 0; d < 40; d++) log = recordDailyFit(log, d, fit);
    log = recordDailyFit(log, 39, {...fit, params: {...RADIATOR_HOUSE, heatLoss: 0.2}});
    assert.equal(log.length, 30);
    assert.equal(log.at(-1)!.heatLoss, 0.2);
    assert.equal(recordDailyFit(log, 41, {rmse: NaN} as HouseFit), log);
});

test('insights: a slab coasts longer per degree than a radiator house, and says slow', () => {
    const radiator = houseInsights({params: RADIATOR_HOUSE, rmse: 0.1, validDays: 7} as HouseFit)!;
    const slab = houseInsights({params: SLAB_HOUSE, rmse: 0.1, validDays: 7} as HouseFit)!;
    assert.equal(radiator.speed, 'fast');
    assert.equal(slab.speed, 'slow');
    assert.ok(slab.hoursPerDegree > radiator.hoursPerDegree);
    assert.equal(Math.round(radiator.heatLoss), 180);
    assert.ok(Math.abs(radiator.stored - 9.5) < 1e-9);
    // Radiator house: the air drops fast at first, then rides on the mass.
    const curve = coolDown(RADIATOR_HOUSE, 6);
    assert.ok(curve[4] - curve[8] > curve[20] - curve[24]);
});

test('implausible numbers show "still learning"', () => {
    assert.equal(houseInsights({params: {...RADIATOR_HOUSE, heatLoss: 2}, rmse: 0.1} as HouseFit), undefined);
    assert.equal(houseInsights({params: {...RADIATOR_HOUSE, cm: 400}, rmse: 0.1} as HouseFit), undefined);
    assert.equal(houseInsights({rmse: NaN} as HouseFit), undefined);
});
