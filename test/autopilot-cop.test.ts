import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    CopModel, TRUST_DAYS, carnotCop, copAt, copFromHistory, copLine, copWindows, fitCop,
} from '../lib/autopilot/cop';
import {FIELDS, FLAG, Field, History} from '../lib/autopilot/history';
import {COP, ForecastSlot, Plan, marginalElectricity, planShift, simulate, steadyState} from '../lib/autopilot/planner';
import {PROFILE_LIMITS, planLive} from '../lib/autopilot/live';
import {SupplyCurve} from '../lib/autopilot/curve';
import {PRESETS, limitsFor} from '../lib/autopilot/presets';
import {RADIATOR_HOUSE, SLAB_HOUSE, rng} from './autopilot-house-sim';

const empty = () => Object.fromEntries(FIELDS.map((f) => [f, NaN])) as Record<Field, number>;

test('the Carnot COP falls as the supply rises and the source cools', () => {
    assert.ok(carnotCop(35, 0) > carnotCop(45, 0));
    assert.ok(carnotCop(35, 5) > carnotCop(35, 0));
    // A source warmer than the supply doesn't promise an absurd COP.
    assert.ok(carnotCop(30, 40) < 25);
    const ground: CopModel = {eta: 0.5, source: 'ground', brine: 2, windows: 20, days: 5, spread: 0.05, trusted: true, missing: []};
    // Ground source prices with the brine, whatever the outdoor temperature.
    assert.equal(copAt(ground, 35, -20), copAt(ground, 35, 10));
    const air: CopModel = {...ground, source: 'air', brine: undefined};
    assert.ok(copAt(air, 35, 10) > copAt(air, 35, -10));
    assert.ok(copAt({...air, eta: 0.8}, 25, 25) <= 8, 'clamped to a plausible COP');
});

interface SimPump {
    eta: number;
    days: number;
    ground?: boolean;
    seed?: number;
    /** Immersion heater slots: on in these, with the electricity they burn at COP 1. */
    immersion?: boolean;
}

/** A pump heating a house for `days`: supply and source wander with the weather, a hot-water
 *  charge every 6 h, and both counters stepped the way the S1155's are (3823 in uneven steps
 *  that land mid-slot, 3821 in 0.1 kWh). */
function simulatedPump(o: SimPump): History {
    const random = rng(o.seed ?? 1).next;
    const history = new History(o.days * 96 + 10);
    let used = 0;
    let made = 0;
    let shownUsed = 0;
    let sinceStep = 0;
    let step = 0.5;
    for (let k = 0; k < o.days * 96; k++) {
        const slot = 96 * 20 + k;
        const te = 2 + 6 * Math.sin(k / 96 * 2 * Math.PI) + random() - 0.5;
        const brine = 1 + 0.15 * te + 0.3 * (random() - 0.5);
        const hotwater = k % 24 < 2;
        const aux = o.immersion && k % 96 >= 40 && k % 96 < 44;
        const supply = hotwater ? 52 : 38 - 0.5 * te + random() - 0.5;
        const source = o.ground ? brine : te;
        const heatKw = hotwater ? 5 : 3 + 0.2 * (8 - te);
        const cop = o.eta * carnotCop(supply, source);
        let pw = heatKw / cop;
        if (aux) pw += 3;
        const before = used;
        used += pw * 0.25;
        made += heatKw * 0.25;
        // The consumption counter steps once enough has gathered, at a poll inside the slot.
        sinceStep += pw * 0.25;
        if (sinceStep >= step) {
            shownUsed = before + (used - before) * random();
            sinceStep = used - shownUsed;
            step = [0.3, 0.8, 1.4, 0.6, 2.5][Math.floor(random() * 5)];
        }
        history.put(slot, {
            ...empty(), flags: 0, coverage: 1, te, ti: 21, tsup: supply, tbrine: o.ground ? brine : NaN, hz: 50,
            pw: pw * 1000, dhw: hotwater ? 1 : 0, heat: hotwater ? 0 : 1, aux: aux ? 1 : 0,
            emeter: Math.round(shownUsed * 10) / 10, pmeter: Math.floor(made * 10) / 10,
        });
    }
    return history;
}

test('η is learned from the counters on a simulated ground-source pump', () => {
    for (const seed of [1, 2, 3]) {
        const model = copFromHistory(simulatedPump({eta: 0.5, days: 7, ground: true, seed}))!;
        assert.equal(model.source, 'ground');
        assert.ok(Math.abs(model.eta - 0.5) < 0.025, `seed ${seed}: η ${model.eta}`);
        assert.ok(model.trusted, `seed ${seed}: ${copLine(model)}`);
        assert.ok(model.brine! > -2 && model.brine! < 4, `brine ${model.brine}`);
    }
});

test('air source learns against the outdoor temperature', () => {
    const model = copFromHistory(simulatedPump({eta: 0.42, days: 7}))!;
    assert.equal(model.source, 'air');
    assert.equal(model.brine, undefined);
    assert.ok(Math.abs(model.eta - 0.42) < 0.025, `η ${model.eta}`);
});

test('hot water, the immersion heater and partial slots are left out', () => {
    const history = simulatedPump({eta: 0.5, days: 7, ground: true, immersion: true});
    const model = copFromHistory(history)!;
    // The immersion heater's electricity at COP 1 would pull η well down if it were counted.
    assert.ok(Math.abs(model.eta - 0.5) < 0.025, `η ${model.eta}`);
    for (const w of copWindows(history)) {
        for (let s = w.from; s <= w.to; s++) {
            const v = history.get(s)!;
            assert.ok(v.heat === 1 && v.aux === 0, `slot ${s} in a window`);
        }
    }
    // A partial slot breaks a window.
    const before = copWindows(history).length;
    for (let s = 96 * 20; s < 96 * 27; s += 7) history.put(s, {...history.get(s)!, flags: FLAG.partial});
    assert.ok(copWindows(history).length < before);
});

test('not trusted until there are enough days, and a fit no pump has is dropped', () => {
    const short = copFromHistory(simulatedPump({eta: 0.5, days: TRUST_DAYS - 1, ground: true}))!;
    assert.equal(short.trusted, false);
    assert.ok(short.missing.includes('days'), copLine(short));
    assert.equal(fitCop([{from: 1, to: 9, produced: 30, used: 2, carnot: 6, supply: 35, source: 0, kind: 'air'}]), undefined);
    assert.equal(fitCop([]), undefined);
    assert.equal(copLine(undefined), 'COP learning');
});

test('slots from before the heating share was recorded still count, by hot water and Hz', () => {
    const history = simulatedPump({eta: 0.5, days: 5, ground: true});
    for (const s of history.range()) history.put(s, {...history.get(s)!, heat: NaN, pmeter: NaN,
        // Without 3821 the heating counter stands in; over heating-only slots they count the same.
        qmeter: history.get(s)!.pmeter});
    const model = copFromHistory(history)!;
    assert.ok(Math.abs(model.eta - 0.5) < 0.03, `η ${model.eta}`);
});

// The S1155's learned curve at curve 5, offset +6 (2026-11-14), as in the live tests.
const FINE: SupplyCurve = {knots: Array.from({length: 29}, (_, i) => -8 + 2 * i), points: 859,
    supply: [44.1, 43.3, 42.6, 41.8, 41, 40.2, 39.3, 38.4, 37.5, 36.6, 35.6, 34.6, 33.4, 31.9, 30.2, 28.3, 26.3, 24.4,
        22.9, 21.8, 21, 20.4, 20.1, 19.8, 19.7, 19.7, 19.7, 19.7, 19.7]};
const TRUSTED: CopModel = {eta: 0.5, source: 'ground', brine: 0, windows: 40, days: 7, spread: 0.06, trusted: true, missing: []};

test('a trusted COP prices each slot at its supply, and the extra heat of a warmer supply costs more', () => {
    const house = RADIATOR_HOUSE;
    const start = steadyState(house, 21.5, 3);
    const forecast: ForecastSlot[] = Array.from({length: 16}, () => ({te: 3, sun: 0, price: 1}));
    const pump = {supply: FINE, heatPerSupplyK: 0.255, shiftOnly: true};
    const plain = simulate(house, 21.5, start, forecast, new Array(16).fill(0), pump);
    assert.ok(plain.cop.every((c) => c === COP), 'untrusted or absent: the constant');
    const priced = simulate(house, 21.5, start, forecast, new Array(16).fill(0), {...pump, cop: TRUSTED});
    assert.ok(priced.cop.every((c) => c > COP), `${priced.cop[0]}`);
    const warmer = simulate(house, 21.5, start, forecast, new Array(16).fill(8), {...pump, cop: TRUSTED});
    assert.ok(warmer.cop.at(-1)! < priced.cop.at(-1)!, 'a pre-heat runs a warmer supply at a lower COP');
    const k = 8;
    const marginal = marginalElectricity({...pump, cop: TRUSTED}, priced.heat[k], priced.cop[k], priced.supply[k], 3);
    assert.ok(marginal > 1 / priced.cop[k] * 1.05, `${marginal} vs ${1 / priced.cop[k]}`);
    assert.equal(marginalElectricity(pump, priced.heat[k], COP, priced.supply[k], 3), 1 / COP);
    // Not trusted: the planner keeps the constant.
    const untrusted = simulate(house, 21.5, start, forecast, new Array(16).fill(0), {...pump, cop: {...TRUSTED, trusted: false}});
    assert.deepEqual(untrusted.cop, plain.cop);
});

test('the planner pre-heats less when the COP penalty outweighs the price spread', () => {
    for (const house of [RADIATOR_HOUSE, SLAB_HOUSE]) {
        for (const te of [3, -5]) {
            const start = steadyState(house, 21.5, te);
            // Cheap for 6 h, then 6 h at a premium, then cheap again.
            const priced = (premium: number): ForecastSlot[] => Array.from({length: 96}, (_, k) => ({te, sun: 0,
                price: k >= 24 && k < 48 ? premium : 1}));
            const plan = (premium: number, cop?: CopModel) => planLive({house, lever: 0.5 * house.heatLoss, ti: start.ti,
                tm: start.tm, mean: 21.5, curve: te, bias: 0, forecast: priced(premium), supply: FINE, heatPerSupplyK: 0.255,
                ...(cop ? {cop} : {})}, PROFILE_LIMITS.save_some);
            const preheat = (p: Plan) => p.shift.slice(0, 24).reduce((a, b) => a + Math.max(0, b), 0);
            const coast = (p: Plan) => -p.shift.slice(24, 48).reduce((a, b) => a + Math.min(0, b), 0);
            // A thin spread: at a constant COP it pays for a pre-heat and a coast. Priced at the
            // supply each takes, the warmer supply eats most of the spread.
            const constant = plan(1.45);
            const learned = plan(1.45, TRUSTED);
            const where = `${house === SLAB_HOUSE ? 'slab' : 'radiator'} at ${te} °C`;
            assert.ok(preheat(constant) > 0, `${where}: at a constant COP the spread pays for a pre-heat`);
            assert.ok(preheat(learned) < 0.75 * preheat(constant), `${where}: pre-heat ${preheat(learned)} K·slots with the COP, ${preheat(constant)} without`);
            assert.ok(coast(learned) < coast(constant), `${where}: coast ${coast(learned)} vs ${coast(constant)}`);
            assert.ok(learned.fairCost < learned.baselineFairCost);
            // A wide spread still pays for a shift, COP penalty and all.
            assert.ok(coast(plan(4, TRUSTED)) > 0);
        }
    }
});

test('without a trusted model the planner is unchanged', () => {
    const house = RADIATOR_HOUSE;
    const start = steadyState(house, 21, 2);
    const forecast: ForecastSlot[] = Array.from({length: 96}, (_, k) => ({te: 2, sun: 0, price: k >= 66 && k < 78 ? 3 : 1}));
    const limits = limitsFor(PRESETS.save_most);
    const pump = {supply: FINE, heatPerSupplyK: 0.255};
    const a = planShift(house, 21, start, forecast, limits, pump);
    const b = planShift(house, 21, start, forecast, limits, {...pump, cop: {...TRUSTED, trusted: false}});
    assert.deepEqual(a.biases, b.biases);
    assert.equal(a.fairCost, b.fairCost);
});
