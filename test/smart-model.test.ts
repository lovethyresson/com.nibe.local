import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    BuildEra, HeatingSystem, HouseParams, envelopeTau, fitSeries, newRls, predictionRmse, priorFor, rlsHouse,
    rlsRegressors, rlsUpdate, stepHouse, usableSlot,
} from '../lib/smart/model';
import {RADIATOR_HOUSE, SLAB_HOUSE, simulateHouse} from './smart-house-sim';

const within = (actual: number, expected: number, share: number) =>
    assert.ok(Math.abs(actual / expected - 1) <= share, `${actual} not within ${share * 100} % of ${expected}`);

test('the exact step matches a fine Euler integration of the same house', () => {
    const p = RADIATOR_HOUSE;
    const u = {te: -5, q: 1.2, sun: 200};
    let [ti, tm] = [20, 22];
    for (let m = 0; m < 15 * 60; m++) {
        const dt = 1 / 3600;
        const P = u.q / 0.25;
        const dti = (p.heatLoss * (u.te - ti) + (tm - ti) / p.rim + (1 - p.f) * P + p.sun * u.sun + p.gains) / p.ci;
        const dtm = ((ti - tm) / p.rim + p.f * P) / p.cm;
        ti += dt * dti;
        tm += dt * dtm;
    }
    const [eti, etm] = stepHouse(p, 20, 22, u);
    assert.ok(Math.abs(eti - ti) < 1e-3 && Math.abs(etm - tm) < 1e-3, `${eti},${etm} vs ${ti},${tm}`);
});

test('stage 1 recovers the heat loss of a one-mass house within 5 %', () => {
    const house: HouseParams = {heatLoss: 0.2, ci: 10, cm: 1, rim: 1, f: 0, sun: 0.004, gains: 0.3};
    for (const seed of [1, 2, 3]) {
        const slots = simulateHouse(house, {days: 14, excitation: 0.4, seed, singleNode: true, noise: 0.01});
        let rls = newRls();
        for (let i = 1; i < slots.length; i++) rls = rlsUpdate(rls, rlsRegressors(slots[i - 1], slots[i]), slots[i].ti);
        within(rlsHouse(rls)!.heatLoss, 0.2, 0.05);
    }
});

const cases: [string, HouseParams, HeatingSystem, BuildEra][] = [
    ['radiator', RADIATOR_HOUSE, 'radiators', '1960_1979'],
    ['slab', SLAB_HOUSE, 'slab', '2000_or_later'],
];
for (const [name, house, system, era] of cases) {
    test(`stage 2 learns a ${name} house from three weeks with excitation`, () => {
        for (const seed of [1, 2, 3]) {
            const slots = simulateHouse(house, {days: 21, excitation: 0.4, hotWaterPerDay: 3, seed});
            const fit = fitSeries(slots, system, era);
            const p = fit.params!;
            within(p.heatLoss, house.heatLoss, 0.1);
            within(envelopeTau(p), envelopeTau(house), 0.15);
            assert.ok(Math.abs(p.f - house.f) < 0.1, `f ${p.f} vs ${house.f}`);
            const {rmse, windows} = predictionRmse(p, slots.slice(-7 * 96), fit.states);
            assert.ok(windows > 20 && rmse < 0.35, `6 h RMSE ${rmse} over ${windows} windows`);
        }
    });
}

test('a wrong Setup answer still predicts inside the bar, and learns which kind of house it is', () => {
    const slots = simulateHouse(SLAB_HOUSE, {days: 21, excitation: 0.4, hotWaterPerDay: 3, seed: 1});
    const fit = fitSeries(slots, 'radiators', 'pre1960');
    assert.ok(fit.params!.f > 0.6, `f ${fit.params!.f}`);
    assert.ok(predictionRmse(fit.params!, slots.slice(-7 * 96), fit.states).rmse < 0.35);
});

test('the Setup answers set the prior: a slab starts slower and with more of its heat in the mass', () => {
    const radiator = priorFor('radiators', '1960_1979', 0.15).params;
    const slab = priorFor('slab', '2000_or_later', 0.15).params;
    assert.ok(envelopeTau(slab) > envelopeTau(radiator));
    assert.ok(slab.f > radiator.f);
    within(envelopeTau(radiator), 50, 0.001);
    assert.equal(priorFor('unknown', 'unknown').params.heatLoss, 0.15);
    assert.ok(priorFor('unknown', 'unknown').sd[0] > priorFor('radiators', '1960_1979').sd[0]);
});

test('gating drops partial, hot-water and jumping slots', () => {
    assert.equal(usableSlot({ti: 21, previousTi: 21.1, partial: false, dhw: 0}), true);
    assert.equal(usableSlot({ti: 21, previousTi: 21.1, partial: true, dhw: 0}), false);
    assert.equal(usableSlot({ti: 21, previousTi: 21.1, partial: false, dhw: 0.6}), false);
    assert.equal(usableSlot({ti: 21, previousTi: 21.5, partial: false, dhw: 0}), false);
    assert.equal(usableSlot({ti: NaN, partial: false, dhw: 0}), false);
});

test('missing indoor readings are predicted through, and a long gap re-anchors on the next reading', () => {
    const slots = simulateHouse(RADIATOR_HOUSE, {days: 6, excitation: 0.4, seed: 4});
    const holed = slots.map((s, i) => (i % 50 === 25 ? {...s, ti: NaN} : s)).filter((_, i) => i < 400 || i > 430);
    const fit = fitSeries(holed, 'radiators', '1960_1979', {warmupSlots: 96});
    assert.ok(fit.params);
    assert.ok(holed.filter((s) => Number.isNaN(s.ti)).every((s) => fit.states.has(s.slot)));
    const anchor = holed.find((s) => s.slot === slots[431].slot)!;
    assert.ok(Math.abs(fit.states.get(anchor.slot)![0] - anchor.ti) < 0.2);
});
