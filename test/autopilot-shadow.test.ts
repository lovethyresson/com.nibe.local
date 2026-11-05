import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AHEAD, SHADOW_PRESETS, ShadowMemory, curveComfort, shadowForecast, shadowStep} from '../lib/autopilot/shadow';
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

test('with room-sensor control off, comfort is where the curve has kept the house', () => {
    const history = new History(200);
    const put = (slot: number, ti: number, roomctl: number) =>
        history.put(slot, {...Object.fromEntries(FIELDS.map((f) => [f, NaN])), ti, roomctl, flags: 0} as any);
    for (let k = 0; k < 10; k++) put(1000 + k, 22.5, 1); // the room loop holding the setpoint
    for (let k = 10; k < 20; k++) put(1000 + k, 21 + (k % 2), 0);
    assert.equal(curveComfort(history, 1019, 21.3), 21.5); // only the loop-off slots count
    put(1020, 22.5, 1);
    assert.equal(curveComfort(history, 1020, 22.5), undefined); // loop on: the setpoint is comfort
    put(1021, NaN, 0);
    put(1021 + 200, 20, 0); // a day later the old slots have left the window
    assert.equal(curveComfort(history, 1221, 20), 20);
});

test('room control counts as off when 202 says so or the offset answers', () => {
    const v = (roomctl: number, hoffset: number) => ({...Object.fromEntries(FIELDS.map((f) => [f, NaN])), roomctl, hoffset}) as any;
    assert.equal(roomControlOff(v(0, NaN)), true);
    assert.equal(roomControlOff(v(1, 2)), true); // zone firmware: 202 stuck on, 30 answers with the loop off
    assert.equal(roomControlOff(v(1, NaN)), false);
    assert.equal(roomControlOff(undefined), false);
});
