import {test} from 'node:test';
import assert from 'node:assert';
import {PROFILE_LIMITS, customLimits, rangeLimits} from '../lib/autopilot/live';

test('Custom with nothing set plans as Comfort', () => {
    assert.deepStrictEqual(customLimits({}), PROFILE_LIMITS.comfortable);
});

test('Custom takes each setting into its limit; the price ratio becomes a margin', () => {
    const l = customLimits({custom_coldest: 1, custom_warmest: 0.5, custom_price_ratio: 1.3, custom_coast_hours: 8,
        custom_preheat_shift: 12, custom_coast_shift: 6, custom_comfort_weight: 1, custom_preheat_lead: 0.5});
    assert.strictEqual(l.lower, 1);
    assert.strictEqual(l.upper, 0.5);
    assert.ok(Math.abs(l.margin - 0.3) < 1e-9);
    assert.strictEqual(l.maxCoastH, 8);
    assert.strictEqual(l.maxBias, 12);
    assert.strictEqual(l.maxCoastBias, 6);
    assert.strictEqual(l.comfortWeight, 1);
    assert.strictEqual(l.preheatLeadTau, 0.5);
    assert.strictEqual(l.forecastTrust, PROFILE_LIMITS.comfortable.forecastTrust, 'forecast trust is not a Custom setting');
});

test('out-of-range and junk values are clamped or ignored', () => {
    const l = customLimits({custom_coldest: 40, custom_price_ratio: 0.2, custom_comfort_weight: 'x' as unknown as number});
    assert.strictEqual(l.lower, 6);
    assert.strictEqual(l.margin, 0, 'never below 1×');
    assert.strictEqual(l.comfortWeight, PROFILE_LIMITS.comfortable.comfortWeight);
});

test('rangeLimits: the three ranges as before, custom from settings', () => {
    assert.deepStrictEqual(rangeLimits('save_some', {custom_coldest: 5}), PROFILE_LIMITS.save_some);
    assert.strictEqual(rangeLimits('custom', {custom_coldest: 2}).lower, 2);
});

test('setup explains each range with the live limits themselves', async () => {
    const {RANGE_IDS, rangeFacts} = await import('../lib/autopilot/live');
    const facts = rangeFacts();
    assert.deepStrictEqual(Object.keys(facts), [...RANGE_IDS]);
    for (const id of RANGE_IDS) {
        assert.strictEqual(facts[id].band, PROFILE_LIMITS[id].lower);
        assert.strictEqual(facts[id].weight, PROFILE_LIMITS[id].comfortWeight);
        assert.strictEqual(facts[id].coast, PROFILE_LIMITS[id].maxCoastH);
    }
});
