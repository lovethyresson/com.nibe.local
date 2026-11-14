import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SOLAR_SETTING, SolarSurplus, SurplusBudget, effectivePrice, forecastHeld, heldLive, liveCounts, readSolarAnswer, solarOn} from '../lib/autopilot/solar-surplus';
import {liveSurplusW} from '../lib/autopilot/hotwater-surplus';

const forecast = new Map([[10, 3], [11, 2], [12, 0.5]]);

test('the surplus budget: each user sees what users before it left, never the same kW twice', () => {
    const budget = new SurplusBudget();
    budget.reserve('hotwater', new Map([[10, 2], [11, 2]]));
    assert.deepEqual([...budget.available('hotwater', forecast)!], [[10, 3], [11, 2], [12, 0.5]], 'hot water goes first');
    assert.deepEqual([...budget.available('heating', forecast)!], [[10, 1], [11, 0], [12, 0.5]]);
    budget.reserve('heating', new Map([[10, 1]]));
    assert.deepEqual([...budget.available('cooling', forecast)!], [[10, 0], [11, 0], [12, 0.5]]);
    budget.reserve('hotwater', new Map());
    assert.deepEqual([...budget.available('heating', forecast)!], [[10, 3], [11, 2], [12, 0.5]], 'a new reservation replaces the old');
    assert.equal(budget.available('heating', undefined), undefined, 'no generator, no surplus');
});

test('effective price: the surplus covers its share at the export price, the rest is bought', () => {
    assert.deepEqual(effectivePrice(2, 0.5, 1, 2), {price: 1.25, share: 0.5});
    assert.deepEqual(effectivePrice(2, 0.5, 5, 2), {price: 0.5, share: 1});
    assert.deepEqual(effectivePrice(2, 0.5, undefined, 2), {price: 2, share: 0});
    assert.deepEqual(effectivePrice(2, 0.5, 3, 0), {price: 2, share: 0}, 'no draw, nothing to cover');
});

test('live export counts only with sun forecast and a learned fit: a battery selling is not surplus', () => {
    const settings = new Map<string, any>();
    const service: any = new (SolarSurplus as any)({settings: {get: (k: string) => settings.get(k)}}, () => {});
    const now = Date.now();
    const hour = Math.floor(now / 3_600_000) * 3_600_000;
    const slot = Math.floor(now / (15 * 60_000));
    service.ready = true;
    service.ghi = new Map([[hour, 400], [hour + 3_600_000, 400]]);
    service.live = Array.from({length: 10}, (_, k) => ({at: now - k * 60_000, w: 2000}));
    assert.equal(service.forecast(slot).get(slot), 0, 'no fit yet: export may be a battery');
    service.fit = {a: 0.004, b: 0, hours: 40};
    assert.equal(service.forecast(slot).get(slot), 2, 'fit and sun: the export is surplus');
    service.ghi = new Map([[hour, 0], [hour + 3_600_000, 0]]);
    assert.equal(service.forecast(slot).get(slot), 0, 'no sun: a battery selling');
    service.ghi = new Map([[hour, 400], [hour + 3_600_000, 400]]);
    service.fit = undefined;
    settings.set(SOLAR_SETTING, {live: true, forecast: false});
    assert.equal(service.forecast(slot).get(slot), 2, 'the owner turned live on: export counts before any fit');
    settings.set(SOLAR_SETTING, {live: false, forecast: false});
    assert.equal(service.forecast(slot).get(slot), 0, 'the owner turned it off');
});

test('the plan counts on the forecast only with the switch on and last week held; else live is held while the sun is', () => {
    const settings = new Map<string, any>();
    const service: any = new (SolarSurplus as any)({settings: {get: (k: string) => settings.get(k)}}, () => {});
    const now = Date.now();
    const hour = Math.floor(now / 3_600_000) * 3_600_000;
    const slot = Math.floor(now / (15 * 60_000));
    service.ready = true;
    service.fit = {a: 0.01, b: 0, hours: 40};
    service.ghi = new Map(Array.from({length: 48}, (_, h) => [hour + h * 3_600_000, h < 3 ? 400 : h < 20 ? 0 : 500]));
    service.live = Array.from({length: 10}, (_, k) => ({at: now - k * 60_000, w: 1000}));
    const tomorrow = slot + 4 * 21;
    settings.set(SOLAR_SETTING, {live: true, forecast: false});
    assert.equal(service.forecast(slot).get(slot + 3), 1, 'live held while the sun keeps up');
    assert.equal(service.forecast(slot).get(tomorrow), 0, 'no promise of tomorrow\'s sun');
    settings.set(SOLAR_SETTING, {live: true, forecast: true});
    assert.equal(service.forecast(slot).get(tomorrow), 5, 'forecast on: tomorrow\'s sun through the fit');
    service.check = {held: false, expectedKwh: 30, actualKwh: 4};
    assert.equal(service.forecast(slot).get(tomorrow), 0, 'last week missed: paused');
    assert.equal(service.forecastPaused, true);
    assert.equal(service.forecast(slot).get(slot), 1, 'live still counts while paused');
});

test('heldLive: as it is for half an hour, then scaled down with the sun, never up, gone at dusk and after the hold', () => {
    const hour = 3_600_000, slotMs = 15 * 60_000;
    const ghi = new Map([[0, 400], [hour, 200], [2 * hour, 800], [3 * hour, 20]]);
    const starts = Array.from({length: 14}, (_, j) => j * slotMs);
    assert.deepEqual(heldLive(2, ghi, 0, starts, 12), [2, 2, 2, 2, 1, 1, 1, 1, 2, 2, 2, 2, 0, 0]);
    assert.deepEqual(heldLive(2, ghi, 0, starts, 6).slice(4, 8), [1, 1, 0, 0], 'held no longer than asked');
});

test('forecastHeld: last week\'s sunny hours, expected through the fit against what arrived', () => {
    const hour = 3_600_000, now = 30 * 24 * hour;
    const ghi = new Map<number, number>();
    const buckets = [];
    for (let h = 0; h < 20; h++) {
        const start = now - (h + 1) * hour;
        ghi.set(start, 500);
        buckets.push({start, hours: 1, kwh: 0.4});
    }
    buckets.push({start: now - 10 * 24 * hour, hours: 1, kwh: 50});
    ghi.set(now - 10 * 24 * hour, 500);
    const fit = {a: 0.004, b: 0, hours: 40};
    assert.deepEqual(forecastHeld(fit, ghi, buckets, now), {held: false, expectedKwh: 40, actualKwh: 8}, 'a fifth arrived; older hours ignored');
    assert.equal(forecastHeld({a: 0.001, b: 0, hours: 40}, ghi, buckets, now).held, true, 'four fifths arrived');
    assert.equal(forecastHeld(fit, ghi, [], now).held, true, 'nothing to judge');
});

test('own draw is added back to the export, never more than it draws', () => {
    assert.equal(liveSurplusW({totalCumulative: {W: -1500}}), 1500);
    assert.equal(liveSurplusW({totalCumulative: {W: 200}}, 2000), 1800, 'a 2 kW charge on 1.8 kW of sun');
    assert.equal(liveSurplusW({totalCumulative: {W: 3000}}, 2000), 0, 'importing more than the charge draws');
    assert.equal(liveSurplusW({}), undefined);
});

test('the owner\'s answer decides; before it, the fit stands in as the proof of panels', () => {
    assert.equal(liveCounts(undefined, false, true), false);
    assert.equal(liveCounts(undefined, true, true), true);
    assert.equal(liveCounts({live: true, forecast: false}, false, true), true);
    assert.equal(liveCounts({live: false, forecast: true}, true, true), false);
    assert.equal(liveCounts({live: true, forecast: false}, true, false), false, 'never without forecast sun');
    assert.deepEqual(readSolarAnswer({live: true, forecast: true, meter: 'p1'}), {live: true, forecast: true, meter: 'p1'});
    assert.deepEqual(readSolarAnswer({panels: true, meter: 'p1'}), {live: true, forecast: false, meter: 'p1'}, 'an earlier yes: live, forecast off');
    assert.deepEqual(readSolarAnswer({panels: false}), {live: false, forecast: false, meter: undefined});
    assert.equal(readSolarAnswer({panels: 'yes'}), undefined);
    assert.equal(solarOn(undefined), true);
    assert.equal(solarOn({live: false, forecast: false}), false);
    assert.equal(solarOn({live: false, forecast: true}), true);
    assert.equal(readSolarAnswer(null), undefined);
});
