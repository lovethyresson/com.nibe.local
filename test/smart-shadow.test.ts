import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AHEAD, SHADOW_PRESETS, ShadowMemory, shadowForecast, shadowStep} from '../lib/smart/shadow';
import {steadyState, ForecastSlot} from '../lib/smart/planner';
import {RADIATOR_HOUSE} from './smart-house-sim';
import {RAMP_K_PER_SLOT} from '../lib/smart/actuator';

const house = RADIATOR_HOUSE;
const peak = (k: number) => (k >= 24 && k < 40 ? 4 : 1);
const forecastFrom = (from: number): ForecastSlot[] => Array.from({length: 96}, (_, k) => ({te: 2, sun: 0, price: peak(from + k)}));
const start = steadyState(house, 21, 2);
const input = (from: number, memory: ShadowMemory) => ({house, lever: 0.45 * house.heatLoss, ti: start.ti, tm: start.tm,
    comfort: 21, real: 2, auto: false, thresholds: {}, forecast: forecastFrom(from), memory});

test('each slot plans all three presets and carries each one\'s would-be feed', () => {
    let memory: ShadowMemory = {};
    const biases: Record<string, number[]> = {comfortable: [], save_some: [], save_most: []};
    for (let k = 0; k < 40; k++) {
        const out = shadowStep(input(k, memory));
        assert.deepEqual(Object.keys(out.presets), SHADOW_PRESETS);
        assert.equal(out.baseline.length, AHEAD.length);
        for (const id of SHADOW_PRESETS) {
            const p = out.presets[id]!;
            assert.equal(p.fed, Math.round((2 - p.bias) * 10) / 10);
            biases[id].push(p.bias);
        }
        memory = out.memory;
    }
    for (const id of SHADOW_PRESETS)
        assert.ok(biases[id].every((b, i) => Math.abs(b - (biases[id][i - 1] ?? 0)) <= RAMP_K_PER_SLOT + 1e-9), `${id} jumped`);
    // Inside the expensive block the deepest preset is coasting.
    assert.ok(biases.save_most.slice(26, 38).every((b) => b < 0), biases.save_most.join(','));
    assert.ok(Math.min(...biases.save_most) < Math.min(...biases.comfortable));
});

test('in Auto the would-be feed keeps clear of the auto-stop threshold', () => {
    let memory: ShadowMemory = {};
    let fed = -Infinity;
    for (let k = 0; k < 36; k++) {
        const out = shadowStep({...input(k, memory), real: 12, auto: true, thresholds: {stopHeating: 15},
            forecast: forecastFrom(k).map((s) => ({...s, te: 12}))});
        fed = Math.max(fed, ...Object.values(out.presets).map((p) => p!.fed));
        memory = out.memory;
    }
    assert.ok(fed <= 14, `fed ${fed}`);
});

test('the forecast runs as far as the weather does, with the outdoor correction and the last price carried', () => {
    const weather = new Map([10, 11, 12].map((s) => [s, {te: 1, gtiS: 100, gtiE: 50, gtiW: 0}]));
    const prices = new Map([[8, {price: 3}], [11, {price: 5}]]);
    const out = shadowForecast(10, weather, prices, () => -0.5);
    assert.deepEqual(out.map((s) => s.price), [3, 5, 5]);
    assert.ok(out.every((s) => s.te === 0.5 && s.sun === 100 && s.sunE === 50));
    assert.equal(shadowForecast(10, weather, new Map(), () => 0)[0].price, 1);
    assert.equal(shadowForecast(9, weather, prices, () => 0).length, 0);
});
