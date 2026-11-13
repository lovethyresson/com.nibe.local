import {test} from 'node:test';
import assert from 'node:assert/strict';
import {heatingStatus, pricePeak} from '../lib/autopilot/heating-status';
import {FeedSnapshot} from '../lib/autopilot/live';
import {POOL_INFLUENCE_DEFAULT, shownSmartMode, smartMode, smartModeWrites, spaOn} from '../lib/autopilot/smart-mode';
import {SLOT_MS} from '../lib/autopilot/prices';
import {AUTOPILOT_HEATING_CAPABILITIES, AUTOPILOT_HOTWATER_CAPABILITIES, capabilitySyncPlan, extraCapabilities, hiddenBySmartMode, possibleExtraCapabilities} from '../lib/roles';
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

test('Comfort range Off is holding, and says why', () => {
    assert.deepEqual(heatingStatus(live({neutral: true}), now, t, time), {status: 'holding', reason: 'range_off'});
});

test('easing off with no price peak names the sun, only when the plan counts it', () => {
    const sunny = (k: number) => ({te: 3, sun: k >= 1 && k < 3 ? 400 : 0, price: 1});
    const s = live({bias: -2, biases: [-2, -2, -2, 0], forecast: [0, 1, 2, 3].map(sunny), sunTrusted: true});
    assert.equal(heatingStatus(s, now, t, time).reason, 'easing_off(until=s3): sun(from=s1,to=s3)');
    assert.equal(heatingStatus({...s, sunTrusted: undefined}, now, t, time).reason, 'easing_off(until=s3)');
});

test('a test run says so', () => {
    const s = live({mode: 'test', bias: -2, biases: [-2, 0], forecast: forecast([3, 1])});
    assert.match(heatingStatus(s, now, t, time).reason, /^test\(text=easing_off/);
});

test('the plan is read from where now is, not from its first slot', () => {
    const s = live({bias: -2, biases: [0, 0, -2, -2, 0], forecast: forecast([1, 1, 4, 4, 1])});
    assert.match(heatingStatus(s, now + 2 * SLOT_MS, t, time).reason, /^easing_off\(until=s4\)/);
});

const spa = {master: 'm', heating: 'h', hotwater: 'w', controls: {heating: ['h'], hotwater: ['w']}};

test('Smart mode: SPA turns its master and function on; anything else turns only the function off', () => {
    assert.deepEqual(smartModeWrites('heating', 'spa', spa), [['m', true], ['h', true]]);
    assert.deepEqual(smartModeWrites('hotwater', 'spa', spa), [['m', true], ['w', true]]);
    for (const value of ['off', 'test', 'autopilot'] as const) {
        assert.deepEqual(smartModeWrites('heating', value, spa), [['h', false]], value);
        assert.deepEqual(smartModeWrites('hotwater', value, spa), [['w', false]], value);
    }
    assert.equal(smartMode('nonsense'), 'off');
    assert.equal(smartMode(undefined), 'off');
    assert.ok(spaOn(true, true) && !spaOn(true, false) && !spaOn(false, true) && !spaOn(undefined, true));
});

test('Repair shows Off or SPA as the pump has it, and Autopilot as stored', () => {
    assert.equal(shownSmartMode('off', true), 'spa', 'SPA turned on on the pump shows as SPA');
    assert.equal(shownSmartMode('spa', false), 'off', 'and turned off as Off');
    assert.equal(shownSmartMode('autopilot', true), 'autopilot');
    assert.equal(shownSmartMode('test', false), 'test');
});

test('the Hot water device carries the "Autopilot now" line only while its Smart mode runs Autopilot', () => {
    for (const mode of ['off', 'spa'] as const)
        assert.ok(AUTOPILOT_HOTWATER_CAPABILITIES.every((c) => !extraCapabilities(sProfile, 'hotwater', null, mode).includes(c)), mode);
    for (const mode of ['test', 'autopilot'] as const)
        assert.ok(AUTOPILOT_HOTWATER_CAPABILITIES.every((c) => extraCapabilities(sProfile, 'hotwater', null, mode).includes(c)), mode);
    for (const role of ['main', 'pool', 'cooling', 'solar'] as const)
        assert.ok(AUTOPILOT_HOTWATER_CAPABILITIES.every((c) => !extraCapabilities(sProfile, role, null, 'autopilot').includes(c)), role);
});

test('the Heating device carries the Autopilot capabilities only while Smart mode runs Autopilot', () => {
    assert.ok(AUTOPILOT_HEATING_CAPABILITIES.every((c) => possibleExtraCapabilities(sProfile, 'heating').includes(c)));
    for (const mode of ['off', 'spa'] as const)
        assert.ok(AUTOPILOT_HEATING_CAPABILITIES.every((c) => !extraCapabilities(sProfile, 'heating', null, mode).includes(c)), mode);
    for (const mode of ['test', 'autopilot'] as const)
        assert.ok(AUTOPILOT_HEATING_CAPABILITIES.every((c) => extraCapabilities(sProfile, 'heating', null, mode).includes(c)), mode);
    for (const role of ['main', 'hotwater', 'pool', 'cooling', 'solar'] as const)
        assert.ok(AUTOPILOT_HEATING_CAPABILITIES.filter((c) => !AUTOPILOT_HOTWATER_CAPABILITIES.includes(c))
            .every((c) => !possibleExtraCapabilities(sProfile, role).includes(c)), role);
    const on = capabilitySyncPlan(sProfile, 'heating', null, [], 'autopilot');
    const off = capabilitySyncPlan(sProfile, "heating", null, on.wanted, 'off');
    const spaControls = sProfile.spaSwitches!.controls.heating!;
    assert.deepEqual([...off.toRemove].sort(), [...AUTOPILOT_HEATING_CAPABILITIES].sort());
    assert.deepEqual([...off.toAdd].sort(), [...spaControls].sort(), 'the SPA tiles come back');
});

test('a function shows SPA\'s controls only while Autopilot does not run it', () => {
    for (const role of ['heating', 'hotwater'] as const) {
        const controls = sProfile.spaSwitches!.controls[role]!;
        assert.ok(controls.every((c) => sProfile.registerByName[c]), `${role}: real registers`);
        for (const mode of ['off', 'spa'] as const) {
            assert.deepEqual(hiddenBySmartMode(sProfile, role, mode), [], `${role} ${mode}`);
            assert.ok(controls.every((c) => capabilitySyncPlan(sProfile, role, null, [], mode).wanted.includes(c)), `${role} ${mode}`);
        }
        for (const mode of ['test', 'autopilot'] as const)
            assert.ok(controls.every((c) => !capabilitySyncPlan(sProfile, role, null, [], mode).wanted.includes(c)), `${role} ${mode}`);
    }
    assert.ok(capabilitySyncPlan(sProfile, 'main', null, [], 'autopilot').wanted.includes(sProfile.spaSwitches!.master),
        'the master stays on Main: pool and cooling use it too');
});

test('pool and cooling: SPA on and off through their own switches; the pool\'s is its influence', () => {
    const spa = sProfile.spaSwitches!;
    assert.deepEqual(smartModeWrites('cooling', 'spa', spa), [[spa.master, true], [spa.cooling, true]]);
    assert.deepEqual(smartModeWrites('cooling', 'off', spa), [[spa.cooling, false]]);
    assert.deepEqual(smartModeWrites('pool', 'off', spa), [[spa.poolInfluence, 0]]);
    assert.deepEqual(smartModeWrites('pool', 'spa', spa, 7), [[spa.master, true], [spa.poolInfluence, 7]], 'the owner\'s influence comes back');
    assert.deepEqual(smartModeWrites('pool', 'spa', spa), [[spa.master, true], [spa.poolInfluence, POOL_INFLUENCE_DEFAULT]]);
    assert.deepEqual(smartModeWrites('pool', 'spa', {...spa, poolInfluence: undefined}), [], 'no pool SPA on this model');
});
