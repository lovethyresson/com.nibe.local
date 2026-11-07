import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AHEAD, SHADOW_PRESETS, ShadowMemory, curveViewOf, shadowForecast, shadowStep, wiredOf} from '../lib/autopilot/shadow';
import {fitSupplyCurve} from '../lib/autopilot/curve';
import {comfortBias} from '../lib/autopilot/trim';
import {FIELDS, History, roomControlOff} from '../lib/autopilot/history';
import {steadyState, ForecastSlot} from '../lib/autopilot/planner';
import {RADIATOR_HOUSE} from './autopilot-house-sim';
import {RAMP_K_PER_SLOT} from '../lib/autopilot/actuator';

const house = RADIATOR_HOUSE;
const peak = (k: number) => (k >= 24 && k < 40 ? 4 : 1);
const forecastFrom = (from: number): ForecastSlot[] => Array.from({length: 96}, (_, k) => ({te: 2, sun: 0, price: peak(from + k)}));
const start = steadyState(house, 21, 2);
const input = (from: number, memory: ShadowMemory) => ({house, pump: {lever: 0.45 * house.heatLoss}, ti: start.ti, tm: start.tm,
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

test('with a learned curve, presets plan on top of the bias that holds comfort', () => {
    // A curve well short of what 0 °C outdoor needs: doing nothing drifts cold.
    const supply = fitSupplyCurve(Array.from({length: 200}, (_, i) => ({x: -10 + i * 0.15, supply: 30 - 0.5 * (-10 + i * 0.15)})))!;
    const pump = {supply, heatPerSupplyK: 0.25};
    const cold = Array.from({length: 96}, () => ({te: 0, sun: 0, price: 1}));
    const step = (memory: ShadowMemory) => shadowStep({house, pump, ti: 21, tm: 21, comfort: 21, real: 0, auto: false,
        thresholds: {}, forecast: cold, memory, curveNow: 0});
    const held = comfortBias(house, pump, 21, 0);
    assert.ok(held > 3, `${held}: the curve alone is short, so holding comfort pre-heats`);
    // Flat prices: nothing to shift, so each preset ramps onto the comfort bias and stays there.
    let out = step({});
    const last: Record<string, number> = {comfortable: 0, save_some: 0, save_most: 0};
    for (let k = 0; k < 8; k++) {
        for (const id of SHADOW_PRESETS) {
            const p = out.presets[id]!;
            assert.equal(p.comfortBias, Math.round(held * 10) / 10);
            assert.ok(p.bias - last[id] <= RAMP_K_PER_SLOT + 1e-9 && p.bias >= last[id] - 1e-9, `${id} ${k}: ${last[id]} → ${p.bias}`);
            last[id] = p.bias;
        }
        out = step(out.memory);
    }
    for (const id of SHADOW_PRESETS) assert.ok(Math.abs(last[id] - held) < 0.6, `${id}: ${last[id]} vs ${held}`);
    assert.ok(out.baseline[1] < 21 - 0.2, `${out.baseline}: doing nothing drifts below comfort`);
});

test('doing nothing feeds the wired BT1, which trails the outdoor temperature', () => {
    const supply = fitSupplyCurve(Array.from({length: 200}, (_, i) => ({x: -10 + i * 0.15, supply: 40 - 0.5 * (-10 + i * 0.15)})))!;
    const pump = {supply, heatPerSupplyK: 0.25};
    const falling = Array.from({length: 96}, (_, k) => ({te: 5 - k * 0.1, sun: 0, price: 1}));
    const base = {house, pump, ti: 21, tm: 21, comfort: 21, real: 5, auto: false, thresholds: {}, forecast: falling, memory: {}, curveNow: 5};
    const plain = shadowStep(base).baseline;
    const lagged = shadowStep({...base, wired: {lag: 5, offset: 0}}).baseline;
    // The wired sensor still reads warm as it turns colder, so the pump gives less heat.
    assert.ok(lagged[1] < plain[1], `${lagged} vs ${plain}`);
});

test('the wired BT1 model and the curve\'s view come from the history', () => {
    const history = new History(200);
    for (let k = 0; k < 100; k++)
        history.put(1000 + k, {...Object.fromEntries(FIELDS.map((f) => [f, NaN])), te: 3, bt1: 5.3, flags: 0} as any);
    const wired = wiredOf(history)!;
    assert.ok(Math.abs(wired.lag - 3) < 1e-9);
    assert.ok(Math.abs(wired.offset - 2.3) < 1e-6);
    assert.ok(Math.abs(curveViewOf(history)! - 5.3) < 1e-6);
});

test('room control counts as off when 202 says so or the offset answers', () => {
    const v = (roomctl: number, hoffset: number) => ({...Object.fromEntries(FIELDS.map((f) => [f, NaN])), roomctl, hoffset}) as any;
    assert.equal(roomControlOff(v(0, NaN)), true);
    assert.equal(roomControlOff(v(1, 2)), true); // zone firmware: 202 stuck on, 30 answers with the loop off
    assert.equal(roomControlOff(v(1, NaN)), false);
    assert.equal(roomControlOff(undefined), false);
});
