import {test} from 'node:test';
import assert from 'node:assert/strict';
import {heatingStatus, pricePeak} from '../lib/autopilot/heating-status';
import {FeedSnapshot} from '../lib/autopilot/live';
import {priceControl, priceControlWrites, spaOn} from '../lib/autopilot/price-control';
import {SLOT_MS} from '../lib/autopilot/prices';
import {AUTOPILOT_HEATING_CAPABILITIES, capabilitySyncPlan, extraCapabilities, possibleExtraCapabilities} from '../lib/roles';
import {sProfile} from '../drivers/nibe_s/profile';

// Keys and tokens echoed back, so a test reads which text was chosen and with what.
const t = (key: string, tokens?: Record<string, string | number>) =>
    key + (tokens ? `(${Object.entries(tokens).map(([k, v]) => `${k}=${v}`).join(',')})` : '');
// Slot k of the plan shows as its index, which keeps "until" readable in assertions.
const slot0 = 1_000_000;
const time = (ms: number) => `s${ms / SLOT_MS - slot0}`;
const now = slot0 * SLOT_MS + 60_000;
const forecast = (prices: number[]) => prices.map((price) => ({te: 3, sun: 0, price}));
const live = (over: Partial<FeedSnapshot>): FeedSnapshot => ({mode: 'live', bias: 0, target: 0, slot: slot0, ...over});

test('price peak: the run of top prices around the most expensive slot', () => {
    assert.deepEqual(pricePeak([1, 1, 3, 4, 3.9, 1]), {from: 3, to: 5});
    assert.equal(pricePeak([2, 2, 2]), undefined);
    assert.equal(pricePeak([]), undefined);
});

test('easing off says until when and why', () => {
    const s = live({bias: -2, biases: [-2, -2, -1, 0, 0, 0], forecast: forecast([1, 1, 4, 4, 1, 1])});
    assert.deepEqual(heatingStatus(s, now, t, time), {status: 'easing_off', reason: 'easing_off(until=s3): peak(from=s2,to=s4)'});
});

test('pre-heating says until when', () => {
    const s = live({bias: 1.5, biases: [1.5, 1, 0, -2], forecast: forecast([1, 1, 1, 5])});
    assert.equal(heatingStatus(s, now, t, time).status, 'preheating');
    assert.match(heatingStatus(s, now, t, time).reason, /^preheating\(until=s2\)/);
});

test('holding names the next move, or why there is none', () => {
    assert.deepEqual(heatingStatus(live({biases: [0, 0, -2], forecast: forecast([1, 1, 3])}), now, t, time),
        {status: 'holding', reason: 'next_easing_off(at=s2)'});
    assert.deepEqual(heatingStatus(live({biases: [0, 0], forecast: forecast([1, 1]), planReason: 'spread_below_margin'}), now, t, time),
        {status: 'holding', reason: 'holding_even'});
    assert.equal(heatingStatus(live({bias: 0.1, biases: [0.1]}), now, t, time).status, 'holding', 'a few tenths is holding');
});

test('learning shows progress; waits are paused with their reason; off is off', () => {
    assert.deepEqual(heatingStatus(live({stopped: 'no_model'}), now, t, time, {days: 3, needed: 5}),
        {status: 'learning', reason: 'learning(day=3,of=5)'});
    assert.deepEqual(heatingStatus(live({stopped: 'no_outdoor'}), now, t, time), {status: 'paused', reason: 'paused.no_outdoor'});
    assert.deepEqual(heatingStatus({mode: 'off', bias: 0, target: 0, stopped: 'mode_off'}, now, t, time), {status: 'off', reason: ''});
    assert.equal(heatingStatus({mode: 'off', bias: 0, target: 0, stopped: 'feed_failed'}, now, t, time).status, 'paused',
        'a feed that failed is not quietly off');
});

test('a test run says so', () => {
    const s = live({mode: 'test', bias: -2, biases: [-2, 0], forecast: forecast([3, 1])});
    assert.match(heatingStatus(s, now, t, time).reason, /^test\(text=easing_off/);
});

test('the plan is read from where now is, not from its first slot', () => {
    const s = live({bias: -2, biases: [0, 0, -2, -2, 0], forecast: forecast([1, 1, 4, 4, 1])});
    assert.match(heatingStatus(s, now + 2 * SLOT_MS, t, time).reason, /^easing_off\(until=s4\)/);
});

const spa = {master: 'm', heating: 'h', hotwater: 'w'};

test('Price control: SPA turns its master and function on; anything else turns only the function off', () => {
    assert.deepEqual(priceControlWrites('heating', 'spa', spa), [['m', true], ['h', true]]);
    assert.deepEqual(priceControlWrites('hotwater', 'spa', spa), [['m', true], ['w', true]]);
    for (const value of ['off', 'test', 'autopilot'] as const) {
        assert.deepEqual(priceControlWrites('heating', value, spa), [['h', false]], value);
        assert.deepEqual(priceControlWrites('hotwater', value, spa), [['w', false]], value);
    }
    assert.equal(priceControl('nonsense'), 'off');
    assert.equal(priceControl(undefined), 'off');
    assert.ok(spaOn(true, true) && !spaOn(true, false) && !spaOn(false, true) && !spaOn(undefined, true));
});

test('the Heating device carries the Autopilot capabilities only while heating Price control is on', () => {
    assert.ok(AUTOPILOT_HEATING_CAPABILITIES.every((c) => possibleExtraCapabilities(sProfile, 'heating').includes(c)));
    assert.ok(AUTOPILOT_HEATING_CAPABILITIES.every((c) => !extraCapabilities(sProfile, 'heating', null, false).includes(c)));
    assert.ok(AUTOPILOT_HEATING_CAPABILITIES.every((c) => extraCapabilities(sProfile, 'heating', null, true).includes(c)));
    for (const role of ['main', 'hotwater', 'pool', 'cooling', 'solar'] as const)
        assert.ok(AUTOPILOT_HEATING_CAPABILITIES.every((c) => !possibleExtraCapabilities(sProfile, role).includes(c)), role);
    const on = capabilitySyncPlan(sProfile, 'heating', null, [], true);
    const off = capabilitySyncPlan(sProfile, "heating", null, on.wanted, false);
    assert.deepEqual([...off.toRemove].sort(), [...AUTOPILOT_HEATING_CAPABILITIES].sort());
});
