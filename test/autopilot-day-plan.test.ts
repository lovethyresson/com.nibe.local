import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dayPlanData} from '../lib/autopilot/day-plan';
import {WidgetData} from '../lib/autopilot/widget';

const t = (key: string) => `dp.${key}`;
const w = (key: string) => `w.${key}`;
const n = 96, now = 52;
const ticks = [{at: 0, label: '00:00'}];
const hotwater = (over: Partial<WidgetData> = {}): WidgetData => ({kind: 'hotwater', title: 'Hot water', chips: [], ticks, legend: {},
    slots: Array.from({length: n}, (_, k) => ({price: k < 24 ? 1 : 2, charge: k >= 60 && k < 66 ? 0 : undefined})),
    bands: [{from: 60, to: 66, solar: 0, label: '15:00 to 16:30'}], ...over});
const heating = (over: Partial<WidgetData> = {}): WidgetData => ({kind: 'heating', title: 'Heating', chips: [], ticks, legend: {},
    // Fed 2 K colder 08–09 (heats more), 2 K warmer 17–19 (eases off).
    slots: Array.from({length: n}, (_, k) => ({offset: k >= 32 && k < 36 ? -2 : k >= 68 && k < 76 ? 2 : 0})), ...over});
const input = (over: Partial<Parameters<typeof dayPlanData>[0]> = {}) =>
    dayPlanData({title: 'Main', status: 'Hot water 15:00, then heating eases off 17–19', hotwater: hotwater(), heating: heating(),
        ticks, n, now, t, w, ...over});

test('the day plan puts hot water\'s charges and heating\'s shift on one day, heat up reading up', () => {
    const d = input();
    assert.equal(d.status, 'Hot water 15:00, then heating eases off 17–19');
    assert.deepEqual(d.bands, [{from: 60, to: 66, solar: 0, label: '15:00 to 16:30'}]);
    assert.deepEqual(d.bars, [{at: 32, to: 36, value: 2}, {at: 68, to: 72, value: -2}, {at: 72, to: 76, value: -2}]);
    assert.equal(d.prices.length, n);
    assert.equal(d.prices[0], 1);
    assert.equal(d.scale!.shift!.lo, -d.scale!.shift!.hi, 'the shift axis is symmetric');
    assert.deepEqual(d.lanes, {price: 'w.axis_price', hotwater: 'dp.lane_hotwater', heating: 'dp.lane_heating'});
    assert.deepEqual(d.quiet, {hotwater: undefined, heating: undefined});
    assert.equal(d.chips.length, 0);
});

test('a function without Autopilot has no lane, and heating\'s forecast fills the price', () => {
    const d = input({hotwater: {kind: 'none', title: '', chips: [], slots: [], ticks: [], legend: {}},
        heatingPrices: Array.from({length: n}, (_, k) => (k >= now ? 3 : undefined))});
    assert.equal(d.lanes.hotwater, undefined);
    assert.equal(d.bands, undefined);
    assert.equal(d.prices[now - 1], undefined);
    assert.equal(d.prices[now], 3);
    assert.equal(d.legend.grid, '');
});

test('neither on says how to turn it on; both simulated reads as a simulation', () => {
    assert.equal(input({hotwater: undefined, heating: undefined}).empty, 'dp.off');
    assert.deepEqual(input({hotwater: hotwater({test: true}), heating: heating({test: true})}).chips, ['w.test']);
    assert.deepEqual(input({hotwater: hotwater({test: true})}).chips, []);
});

test('a lane with nothing left today says so quietly', () => {
    const d = input({hotwater: hotwater({bands: [{from: 4, to: 10, solar: 1, label: '01:00 to 02:30'}]}),
        heating: heating({slots: Array.from({length: n}, () => ({offset: 0}))})});
    assert.equal(d.quiet!.hotwater, 'dp.no_charge');
    assert.equal(d.quiet!.heating, 'dp.no_shift');
    assert.equal(d.legend.solar, 'w.charge_solar');
});
