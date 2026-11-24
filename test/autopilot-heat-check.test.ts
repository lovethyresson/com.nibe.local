import {test} from 'node:test';
import assert from 'node:assert';
import {CHECK_DAYS, CHECK_TOLERANCE, heatCheck} from '../lib/autopilot/heat-check';
import {HouseParams, ModelSlot, fitSeries, stepHouse} from '../lib/autopilot/model';
import {fitHouse} from '../lib/autopilot/house';
import {RADIATOR_HOUSE, SLAB_HOUSE, simulateHouse} from './autopilot-house-sim';

/** The filter's [air, mass] per slot, standing in for fitSeries: the true house run on the same inputs. */
function statesOf(house: HouseParams, slots: ModelSlot[]): Map<number, [number, number]> {
    const states = new Map<number, [number, number]>();
    let ti = 21, tm = 21;
    for (const s of slots) {
        [ti, tm] = stepHouse(house, ti, tm, s.inputs);
        states.set(s.slot, [ti, tm]);
    }
    return states;
}

for (const [name, house] of [['radiator', RADIATOR_HOUSE], ['slab', SLAB_HOUSE]] as const) {
    const slots = simulateHouse(house, {days: 8, seed: 3, hotWaterPerDay: 4});
    const states = statesOf(house, slots);

    test(`${name}: a model with the house's own heat loss agrees with the meter`, () => {
        const check = heatCheck(house, slots, states);
        assert.equal(check.days.length, CHECK_DAYS);
        assert.ok(Math.abs(check.ratio! - 1) <= CHECK_TOLERANCE, `ratio ${check.ratio}`);
        assert.equal(check.heatLoss, undefined);
    });

    test(`${name}: a model 20 % low on heat loss gets the meter's heat loss back`, () => {
        const low = {...house, heatLoss: house.heatLoss * 0.8};
        const check = heatCheck(low, slots, states);
        assert.ok(check.ratio! > 1 + CHECK_TOLERANCE, `the meter delivered more than the model needed: ${check.ratio}`);
        assert.ok(Math.abs(check.heatLoss! / house.heatLoss - 1) < 0.03, `${check.heatLoss} vs ${house.heatLoss}`);
    });

    test(`${name}: a model that overstates its gains is corrected the same way`, () => {
        // More free heat in the model means less from the pump: the plan comes out low, as on the S1155.
        const generous = {...house, gains: house.gains + 0.3};
        const check = heatCheck(generous, slots, states);
        assert.ok(check.ratio! > 1 + CHECK_TOLERANCE, `${check.ratio}`);
        // With the gains held at the model's, the heat loss absorbs the difference: the day's heat is right.
        const fixed = {...generous, heatLoss: check.heatLoss!};
        const again = heatCheck(fixed, slots, states);
        assert.ok(Math.abs(again.ratio! - 1) < 0.01, `after the correction the days balance: ${again.ratio}`);
    });
}

test('too few complete days, or a mild spell, change nothing', () => {
    const slots = simulateHouse(RADIATOR_HOUSE, {days: 3, seed: 5});
    const low = {...RADIATOR_HOUSE, heatLoss: RADIATOR_HOUSE.heatLoss * 0.8};
    // Three days of slots hold only two complete days before the current one.
    assert.equal(heatCheck(low, slots, statesOf(RADIATOR_HOUSE, slots)).skip, 'days');
    // Outdoor almost at indoor: the heat loss cannot be measured.
    const mild = simulateHouse(RADIATOR_HOUSE, {days: 6, seed: 5}).map((s) => ({...s, inputs: {...s.inputs, te: s.ti - 1}}));
    const check = heatCheck(low, mild, statesOf(RADIATOR_HOUSE, mild));
    assert.equal(check.skip, 'mild');
    assert.equal(check.heatLoss, undefined);
});

test('a day with a gap in the readings is left out, not counted short', () => {
    const slots = simulateHouse(RADIATOR_HOUSE, {days: 8, seed: 3}).filter((s, k) => !(k >= 96 * 6 && k < 96 * 6 + 20));
    const check = heatCheck(RADIATOR_HOUSE, slots, statesOf(RADIATOR_HOUSE, slots));
    assert.ok(!check.days.some((d) => d.day === Math.floor(slots[96 * 6].slot / 96) - 0), 'the gappy day is skipped');
    assert.equal(check.days.length, CHECK_DAYS);
});

test('a heat loss the meter cannot explain (a broken meter) is not taken', () => {
    const slots = simulateHouse(RADIATOR_HOUSE, {days: 8, seed: 3}).map((s) => ({...s, inputs: {...s.inputs, q: s.inputs.q * 4}}));
    const check = heatCheck(RADIATOR_HOUSE, slots, statesOf(RADIATOR_HOUSE, slots));
    assert.equal(check.skip, 'implausible');
    assert.equal(check.heatLoss, undefined);
});

test('the plan keeps the fitted heat loss: the check is logged, never swapped in (2026-11-24)', () => {
    // The fit follows a meter that reads high, so the check rarely fires on a simulated house; what is
    // pinned here is that `params` is the filter's own fit, whatever the check says.
    const slots = simulateHouse(RADIATOR_HOUSE, {days: 8, seed: 3, hotWaterPerDay: 4});
    const fit = fitHouse(slots, {system: 'radiators', era: 'unknown'});
    const own = fitSeries(slots, 'radiators', 'unknown', {warmupSlots: 3 * 96}).params!;
    assert.ok(fit.heatCheck, 'the check still runs, for the log');
    assert.equal(fit.params!.heatLoss, own.heatLoss);
});
