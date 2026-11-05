import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DailyFit, HouseFit, drifting, fitHouse, heatingHours, pumpFromHistory, readiness, recordDailyFit, validDays} from '../lib/autopilot/house';
import {FIELDS, FLAG, History} from '../lib/autopilot/history';
import {coolDown, houseInsights} from '../lib/autopilot/insights';
import {RADIATOR_HOUSE, SLAB_HOUSE, WEST_HOUSE, simulateHouse} from './autopilot-house-sim';

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

test('insights name the wall the sun comes through, when one dominates', () => {
    const west = houseInsights({params: WEST_HOUSE, rmse: 0.1, validDays: 7} as HouseFit)!;
    assert.equal(west.sunMostly, 'west');
    assert.ok(Math.abs(west.sunAt500.west - 4) < 1e-9);
    assert.equal(houseInsights({params: {...RADIATOR_HOUSE, sun: 0.002}, rmse: 0.1, validDays: 7} as HouseFit)!.sunMostly, undefined);
});

test('implausible numbers show "still learning"', () => {
    assert.equal(houseInsights({params: {...RADIATOR_HOUSE, heatLoss: 2}, rmse: 0.1} as HouseFit), undefined);
    assert.equal(houseInsights({params: {...RADIATOR_HOUSE, cm: 400}, rmse: 0.1} as HouseFit), undefined);
    assert.equal(houseInsights({rmse: NaN} as HouseFit), undefined);
});

test('the lever is fitted only on whole hours of clean space heating', () => {
    const history = new History(64);
    let meter = 1000;
    for (let k = 0; k < 24; k++) {
        const values = Object.fromEntries(FIELDS.map((f) => [f, NaN])) as any;
        meter += 1.2; // 4.8 kW
        Object.assign(values, {ti: 22, tcalc: 40, hz: 50, qmeter: meter, dhw: k >= 12 && k < 16 ? 1 : 0, flags: k === 20 ? FLAG.partial : 0});
        history.put(5000 + k, values);
    }
    const hours = heatingHours(history);
    // Hour 0 lacks a reference reading for its first slot; hours 3 (hot water) and 5 (partial) are out.
    assert.equal(hours.length, 3);
    assert.ok(hours.every((h) => Math.abs(h.heatKw - 4.8) < 1e-3 && h.tcalc === 40));
});

test('the planner gets the learned curve once the history traces one, the lever until then', () => {
    const history = new History(400);
    let meter = 1000;
    const put = (k: number, bt1: number) => {
        const values = Object.fromEntries(FIELDS.map((f) => [f, NaN])) as any;
        const tcalc = 40 - 0.5 * bt1;
        meter += 0.05 * (tcalc - 21); // heat follows supply above indoor
        Object.assign(values, {ti: 21, te: 2, bt1, tcalc, hz: 50, qmeter: meter, dhw: 0, flags: 0,
            hcurve: 5, hoffset: 0, supmin: 20, supmax: 60, roomctl: 0});
        history.put(5000 + k, values);
    };
    // A short history: the lever, no curve yet.
    for (let k = 0; k < 60; k++) put(k, 2);
    const early = pumpFromHistory(history);
    assert.equal(early.supply, undefined);
    assert.ok(early.lever! > 0);
    // A day of outdoor swinging 10 K traces the curve.
    for (let k = 60; k < 156; k++) put(k, 2 + 5 * Math.sin(k / 15));
    const later = pumpFromHistory(history);
    assert.ok(later.supply, 'a curve once the points span it');
    assert.ok(Math.abs(later.heatPerSupplyK! - 0.2) < 0.02, `${later.heatPerSupplyK}`);
    const fit = fitHouse([], {system: 'radiators', era: 'unknown'}, later.lever, later);
    assert.deepEqual(fit.pump, {supply: later.supply, heatPerSupplyK: later.heatPerSupplyK});
});
