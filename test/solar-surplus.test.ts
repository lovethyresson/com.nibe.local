import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SOLAR_SETTING, SolarSurplus, SurplusBudget, effectivePrice, liveCounts, readSolarAnswer} from '../lib/autopilot/solar-surplus';

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
    settings.set(SOLAR_SETTING, {panels: true});
    assert.equal(service.forecast(slot).get(slot), 2, 'the owner said they have panels: live export counts before any fit');
    settings.set(SOLAR_SETTING, {panels: false});
    assert.equal(service.forecast(slot).get(slot), 0, 'the owner said no panels');
});

test('the owner\'s answer decides; before it, the fit stands in as the proof of panels', () => {
    assert.equal(liveCounts(undefined, false, true), false);
    assert.equal(liveCounts(undefined, true, true), true);
    assert.equal(liveCounts({panels: true}, false, true), true);
    assert.equal(liveCounts({panels: false}, true, true), false);
    assert.equal(liveCounts({panels: true}, true, false), false, 'never without forecast sun');
    assert.deepEqual(readSolarAnswer({panels: true, meter: 'p1'}), {panels: true, meter: 'p1'});
    assert.equal(readSolarAnswer({panels: 'yes'}), undefined);
    assert.equal(readSolarAnswer(null), undefined);
});
