import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isPlausibleValue, isPlausibleAlt, isRegisterEnabled, resolvedAddress} from '../lib/registers';
import {sProfile} from '../drivers/nibe_s/profile';

test('zone setpoints are offered as thermostat targets, zone 1 first', () => {
    const target = sProfile.registerByName['target_temperature'];
    assert.equal(target.address, 2505);
    assert.equal(target.sources?.[0].address, 2505, 'zone 1 stays the default');
    assert.equal(target.sources?.[1].address, 2507, 'zone 2 is the next 32-bit slot');
    assert.equal(target.sources?.length, 40);
    assert.equal(target.sources?.at(-1)?.address, 2583);
    // An unconfigured zone reads a flat 0 and must never be offered as a zone to control.
    assert.equal(isPlausibleAlt(target, 0), false);
    assert.equal(isPlausibleAlt(target, 21.5), true);
    // Reads and writes both follow the choice.
    assert.equal(resolvedAddress(target, {groups: {}, overrides: {}, addresses: {target_temperature: 2507}}), 2507);
    assert.equal(resolvedAddress(target, null), 2505);
});


test('wireless room sensors: offered as indoor sources by reading, rows only where detected', () => {
    const indoor = sProfile.registerByName['measure_temperature'];
    const slots = (indoor.sources ?? []).filter((s) => s.address >= 2800);
    assert.deepEqual(slots.map((s) => s.address), [2800, 2802, 2804, 2806, 2808, 2810, 2812, 2814]);
    assert.equal(indoor.sources?.[0].address, 116, 'climate-system average stays the default');
    // Pro-Z's S1156: the first slot is the sensor listed second in both 1.3.4 and 5.4, so no
    // slot label may carry a number, zone or position.
    assert.ok(slots.every((s) => !/\d/.test(s.label.en)));

    const row = sProfile.registerByName['measure_temperature.i2802_wireless_2'];
    assert.ok(row?.optIn, 'opt-in row');
    const none = {} as Record<string, string>;
    // Off for a device that never ran detection, or predates the register.
    assert.equal(isRegisterEnabled(row, null, none), false);
    assert.equal(isRegisterEnabled(row, {groups: {heating: true}, overrides: {}}, none), false);
    assert.equal(isRegisterEnabled(row, {groups: {heating: true}, overrides: {[row.name]: true}}, none), true);
    assert.equal(isRegisterEnabled(row, {groups: {heating: false}, overrides: {[row.name]: true}}, none), false);
    // An empty slot reads NIBE's sentinel or 0; neither is a room.
    assert.equal(isPlausibleValue(row, 0), false);
    assert.equal(isPlausibleValue(row, 22), true);
});
