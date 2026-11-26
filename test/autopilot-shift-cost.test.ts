import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HouseParams} from '../lib/autopilot/model';
import {ShiftSlot, beforeAutopilotCost, shiftEffect} from '../lib/autopilot/shift-cost';
import {daySaving, savingsDay} from '../lib/autopilot/savings';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 15);
const S0 = T0 / (15 * 60_000);
const house: HouseParams = {heatLoss: 0.264, ci: 2, cm: 27, rim: 0.5, f: 0.4, sun: 0, sunE: 0, sunW: 0, gains: 0.4};
const pump = {lever: 0.25};
const hours = Array.from({length: 24}, (_, h) => T0 + h * HOUR);

/** A day at 0 °C outdoor, fed with `bias(k)` K below the real outdoor in slot k. */
function day(bias: (k: number) => number, fed = true): ShiftSlot[] {
    return Array.from({length: 96}, (_, k) => ({slot: S0 + k, te: 0, bt1: -bias(k), ti: 21, busy: false, fed}));
}
/** Night pre-heat: +4 K for six hours, then −4 K for six, then nothing. */
const preheat = (k: number) => (k < 24 ? 4 : k < 48 ? -4 : 0);
const sum = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);

test('a day Autopilot did not feed has no shift to price', () => {
    assert.equal(shiftEffect(house, pump, day(preheat, false)), undefined);
});

test('a steady feed moves nothing: no extra use and no heat left over', () => {
    const effect = shiftEffect(house, pump, day(() => 2))!;
    assert.ok(Math.abs(sum(effect.hours)) < 1e-9);
    assert.ok(Math.abs(effect.carry) < 1e-9);
});

test('a pre-heat at a flat price costs something: the warmer house loses more heat', () => {
    const effect = shiftEffect(house, pump, day(preheat))!;
    // What the pump drew: a steady 1 kWh an hour plus what the shift moved.
    const use = new Map(hours.map((at) => [at, 1 + (effect.hours.get(at) ?? 0)]));
    const flat = new Map(hours.map((at) => [at, 1]));
    const old = beforeAutopilotCost(effect, use, flat, hours, 1)!;
    const cost = hours.reduce((s, at) => s + use.get(at)!, 0);
    assert.ok(old - cost < 0, `saving ${old - cost} should be a loss`);
    assert.ok(effect.carry < 0, 'the shifted day ends with less heat in the house');
});

test('the same pre-heat into cheap night hours before expensive ones saves', () => {
    const effect = shiftEffect(house, pump, day(preheat))!;
    const use = new Map(hours.map((at) => [at, 1 + (effect.hours.get(at) ?? 0)]));
    const prices = new Map(hours.map((at, h) => [at, h < 6 ? 0.5 : h < 12 ? 2 : 1]));
    const old = beforeAutopilotCost(effect, use, prices, hours, 1.125)!;
    const cost = hours.reduce((s, at) => s + use.get(at)! * prices.get(at)!, 0);
    assert.ok(old - cost > 0, `saving ${old - cost} should be positive`);
});

test('a heating day records the model\'s before-Autopilot cost beside the baseline\'s, which stays the saving', () => {
    const effect = shiftEffect(house, pump, day(preheat))!;
    const use = new Map(hours.map((at) => [at, 1 + (effect.hours.get(at) ?? 0)]));
    const prices = new Map(hours.map((at, h) => [at, h < 6 ? 0.5 : h < 12 ? 2 : 1]));
    const d = savingsDay('2026-11-15', hours, use, prices, 1, false, effect)!;
    assert.ok(d.old !== undefined);
    const kwh = d.tiers.reduce((a, b) => a + b);
    assert.ok(Math.abs(daySaving(d, {days: 10, ratio: 1.1}) - (kwh * d.mean * 1.1 - d.cost)) < 1e-9);
    assert.equal(savingsDay('2026-11-15', hours, use, prices, 1)!.old, undefined);
});
