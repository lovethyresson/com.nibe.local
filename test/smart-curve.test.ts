import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CurvePoint, DEFAULT_GAIN, curveLine, curvePoints, fitSupplyCurve, gainBetween, supplyAt} from '../lib/smart/curve';
import {FIELDS, FLAG, Field, History} from '../lib/smart/history';
import {pumpHeat} from '../lib/smart/planner';
import {RADIATOR_HOUSE} from './smart-house-sim';

// Calculated supply against what the curve saw on the S1155 at curve 5, min supply 20: the §3.3
// ladders' rung ends (pre-heat 2026-11-02 from real 8.6 °C, coast 2026-11-03 from real 2.1 °C).
const S1155: [number, number][] = [[-9.9, 36.4], [-4.9, 34.3], [0.1, 32.1], [2.1, 30.9], [5.9, 29.2],
    [8.6, 28.3], [10.7, 26.75], [15.1, 24.1], [20.5, 20.0]];
const measured = (x: number) => {
    const above = S1155.findIndex(([a]) => a > x);
    const j = Math.max(0, Math.min(S1155.length - 2, (above < 0 ? S1155.length : above) - 1));
    const [[a, sa], [b, sb]] = [S1155[j], S1155[j + 1]];
    return sa + (x - a) * (sb - sa) / (b - a);
};
// A deterministic wobble standing in for the slot-to-slot noise of 1017.
const pointsOn = (f: (x: number) => number, lo: number, hi: number, n = 400, noise = 0.15): CurvePoint[] =>
    Array.from({length: n}, (_, i) => {
        const x = lo + (hi - lo) * i / (n - 1);
        return {x, supply: f(x) + noise * Math.sin(i * 12.9898)};
    });

test('the curve is learned from its points, slope by slope', () => {
    const curve = fitSupplyCurve(pointsOn(measured, -10, 20))!;
    // The pre-heat side is flat at ~0.44 and the coast side steepens, as the ladders measured.
    assert.ok(Math.abs(gainBetween(curve, -10, -5) - 0.42) < 0.06, `${gainBetween(curve, -10, -5)}`);
    assert.ok(Math.abs(gainBetween(curve, -5, 0) - 0.44) < 0.06);
    assert.ok(Math.abs(gainBetween(curve, 10, 15) - 0.6) < 0.08);
    assert.ok(gainBetween(curve, 15, 20) > 0.7, `${gainBetween(curve, 15, 20)}`);
    assert.ok(Math.abs(supplyAt(curve, 2.1) - 30.9) < 0.3);
    assert.match(curveLine(curve), /^heat curve -10…20 °C \(400 slots\), gain per 4 K/);
});

test('supply never rises with what the curve sees, and min supply reads as no gain', () => {
    const floored = (x: number) => Math.max(20, 40 - 0.6 * x);
    const curve = fitSupplyCurve(pointsOn(floored, 0, 40))!;
    for (let k = 1; k < curve.supply.length; k++) assert.ok(curve.supply[k] <= curve.supply[k - 1] + 1e-9);
    assert.ok(Math.abs(gainBetween(curve, 2, 30) - 0.6) < 0.05);
    assert.ok(gainBetween(curve, 36, 40) < 0.05, 'below min supply a feed moves nothing');
});

test('no curve until there are enough points over enough of a range', () => {
    assert.equal(fitSupplyCurve(pointsOn(measured, 0, 10, 40)), undefined);
    assert.equal(fitSupplyCurve(pointsOn(measured, 4, 6)), undefined);
    assert.equal(gainBetween(undefined, 0, 5), DEFAULT_GAIN);
});

const empty = () => Object.fromEntries(FIELDS.map((f) => [f, NaN])) as Record<Field, number>;

test('points follow BT1 through the curve\'s filter, restarting after a gap or a settings change', () => {
    const history = new History(400);
    const put = (slot: number, v: Partial<Record<Field, number>>) =>
        history.put(slot, {...empty(), flags: 0, hcurve: 5, hoffset: 0, supmin: 20, supmax: 60, ...v});
    // 3 h at a steady 5 °C, then a step to 15 °C fed: the curve sees it arrive over ~49 min.
    for (let s = 1; s <= 12; s++) put(s, {bt1: 5, te: 5, tcalc: 30});
    for (let s = 13; s <= 24; s++) put(s, {bt1: 15, te: 5, tcalc: 26});
    const points = curvePoints(history);
    assert.equal(points.length, 24 - 4, 'the first hour warms the filter up');
    assert.ok(Math.abs(points[0].x - 5) < 1e-9);
    const firstFed = points.find((p) => p.supply === 26)!;
    assert.ok(firstFed.x > 5 && firstFed.x < 8, `${firstFed.x}: the curve lags what was fed`);
    assert.ok(points.at(-1)!.x > 14, 'and catches up within a few hours');

    // A gap restarts the filter; a partial slot does too.
    put(30, {bt1: 15, tcalc: 26});
    put(31, {bt1: 15, tcalc: 26, flags: FLAG.partial});
    assert.equal(curvePoints(history).length, 20);

    // A new curve number starts a new curve: the old points no longer describe it.
    for (let s = 40; s <= 50; s++) put(s, {bt1: 5, tcalc: 33, hcurve: 6});
    assert.equal(curvePoints(history).length, 50 - 40 + 1 - 4);
    // A slot that did not read the settings is not a change.
    put(51, {bt1: 5, tcalc: 33, hcurve: NaN, hoffset: NaN, supmin: NaN, supmax: NaN});
    assert.equal(curvePoints(history).length, 50 - 40 + 1 - 4 + 1);
    // Nor is one that stops answering and comes back unchanged: the S1155 refuses the offset
    // while room-sensor control is on.
    put(52, {bt1: 5, tcalc: 33, hcurve: 6, hoffset: NaN});
    put(53, {bt1: 5, tcalc: 33, hcurve: 6, hoffset: 0});
    assert.equal(curvePoints(history).length, 50 - 40 + 1 - 4 + 3);
    put(54, {bt1: 5, tcalc: 33, hcurve: 6, hoffset: 2});
    assert.equal(curvePoints(history).length, 1, 'a moved offset is a new curve');
});

test('with a learned curve a bias moves heat by the curve\'s slope where the feed lands', () => {
    const house = RADIATOR_HOUSE;
    const linear = fitSupplyCurve(pointsOn((x) => 40 - 0.5 * x, -15, 25))!;
    const k = 0.45 * house.heatLoss / 0.5; // kW per K of supply, making the linear case 0.45·H per K
    const legacy = (curve: number) => pumpHeat(house, 21, 2, curve, {lever: 0.45 * house.heatLoss});
    const learned = (curve: number, supply = linear) => pumpHeat(house, 21, 2, curve, {supply, heatPerSupplyK: k});
    // A straight curve at the old gain reproduces the old lever.
    for (const curve of [-8, -3, 2, 7, 12]) assert.ok(Math.abs(learned(curve) - legacy(curve)) < 0.01);
    // On the S1155's real curve a deep coast takes away more heat than 0.5 assumed.
    const s1155 = fitSupplyCurve(pointsOn(measured, -10, 22))!;
    const coast = (pump: Parameters<typeof pumpHeat>[4]) => pumpHeat(house, 21, 2, 2, pump) - pumpHeat(house, 21, 2, 20, pump);
    assert.ok(coast({supply: s1155, heatPerSupplyK: k}) > coast({lever: 0.45 * house.heatLoss}) * 1.1);
});

test('room-sensor control is fitted beside the curve and kept out of it', () => {
    // Factor 2: indoor wandering ±0.8 K from its setpoint, on its own rhythm, moves 1017 by ±1.6 K.
    const points = pointsOn(measured, -10, 20, 600).map((p, i) => {
        const room = 0.8 * Math.sin(i / 7);
        return {...p, supply: p.supply + 2 * room, room};
    });
    const curve = fitSupplyCurve(points)!;
    assert.ok(Math.abs(curve.room - 2) < 0.3, `${curve.room}`);
    assert.ok(Math.abs(gainBetween(curve, -5, 0) - 0.44) < 0.06);
    assert.ok(gainBetween(curve, 15, 20) > 0.7);
    assert.match(curveLine(curve), /, room factor \d\.\d$/);
});

test('without room-sensor control, indoor following the heat is not read as one', () => {
    // A coast like 2026-11-03: the feed warms, supply falls, and the house cools after it.
    const supplyStart = measured(-10);
    const points = pointsOn(measured, -10, 20, 600).map((p) => ({...p, room: 0.06 * (supplyStart - p.supply)}));
    const curve = fitSupplyCurve(points)!;
    assert.ok(Math.abs(curve.room) < 0.2, `${curve.room}`);
    assert.ok(Math.abs(gainBetween(curve, -5, 0) - 0.44) < 0.06);
    assert.ok(gainBetween(curve, 15, 20) > 0.7, `${gainBetween(curve, 15, 20)}`);
});

test('a point carries indoor\'s distance from its setpoint when both were read', () => {
    const history = new History(16);
    for (let s = 1; s <= 6; s++)
        history.put(s, {...empty(), flags: 0, bt1: 5, tcalc: 30, ti: 20.5, tset: s < 6 ? 21.5 : NaN});
    const points = curvePoints(history);
    assert.deepEqual(points.map((p) => p.room), [1, undefined]);
});
