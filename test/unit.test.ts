import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    Dir, combineRaw, signedValue, isUnavailableRaw, toNumericValue, isAdjustable, isPollable,
    buildPickerPrimary, buildRegisterByName, isSelectableRegister, isRegisterEnabled, Register
} from '../lib/registers';
import {makeProfile} from '../lib/profile';
import {
    registersForRole, roleRegisters, extraCapabilities, roleGroups, allRoles, functionRoles
} from '../lib/roles';
import {recommendGroups, ProbeSamples} from '../lib/detection';
import {sProfile} from '../drivers/nibe_s/profile';
import {registers} from '../drivers/nibe_s/registers';

// ---------------------------------------------------------------------------------------
// Decode helpers — the raw Modbus → value maths. These are the load-bearing bits the
// extraction must not have changed.
// ---------------------------------------------------------------------------------------

test('combineRaw: 16-bit is the single word, 32-bit is low-word-first', () => {
    assert.equal(combineRaw([1234]), 1234);
    assert.equal(combineRaw([1234], 16), 1234);
    assert.equal(combineRaw([0x0001, 0x0002], 32), 0x0002 * 65536 + 0x0001); // low word first
    assert.equal(combineRaw([57568, 2], 32), 2 * 65536 + 57568);
});

test('signedValue: two-s complement per width', () => {
    assert.equal(signedValue(205, 16), 205);
    assert.equal(signedValue(65516, 16), -20);       // -2.0 °C at scale 10
    assert.equal(signedValue(32768, 16), -32768);
    assert.equal(signedValue(0x80000000, 32), -2147483648);
    assert.equal(signedValue(143907, 32), 143907);   // energy counter stays positive
});

test('isUnavailableRaw: Nibe not-available sentinels', () => {
    assert.equal(isUnavailableRaw(0x8000, 16), true);
    assert.equal(isUnavailableRaw(0x80000000, 32), true);
    assert.equal(isUnavailableRaw(0x8000, 32), false);
    assert.equal(isUnavailableRaw(0, 16), false);
});

test('toNumericValue: sign + scale, no enum/bool mapping', () => {
    const reg = (scale?: number, size?: 16 | 32): Register =>
        ({address: 1, name: 'x', direction: Dir.In, group: 'core', info: {en: '', sv: ''}, scale, size});
    assert.equal(toNumericValue(reg(10), 205), 20.5);
    assert.equal(toNumericValue(reg(10), 65516), -2);
    assert.equal(toNumericValue(reg(), 42), 42);
    assert.equal(toNumericValue(reg(10, 32), 1439070), 143907);
});

test('isAdjustable / isPollable', () => {
    const base = {address: 1, name: 'x', group: 'core' as const, info: {en: '', sv: ''}};
    assert.equal(isAdjustable({...base, direction: Dir.Out}), true);
    assert.equal(isAdjustable({...base, direction: Dir.Out, noAction: true}), false);
    assert.equal(isAdjustable({...base, direction: Dir.In}), false);
    assert.equal(isPollable({...base, direction: Dir.Out}), true);
    assert.equal(isPollable({...base, direction: Dir.Out, writeOnly: true}), false);
});

// ---------------------------------------------------------------------------------------
// Catalog helpers — picker/sensor twins and selection resolution.
// ---------------------------------------------------------------------------------------

test('buildPickerPrimary maps a picker to its non-picker twin at the same address', () => {
    const pp = buildPickerPrimary(registers);
    assert.equal(pp['curve_mode_NIBE.h26_heat_curve'], 'measure_count_NIBE.h26_heat_curve');
    // the non-picker twin itself is not in the map
    assert.equal(pp['measure_count_NIBE.h26_heat_curve'], undefined);
});

test('isSelectableRegister: pickers are not separately selectable', () => {
    const pp = buildPickerPrimary(registers);
    const picker = registers.find((r) => r.name === 'curve_mode_NIBE.h26_heat_curve')!;
    const twin = registers.find((r) => r.name === 'measure_count_NIBE.h26_heat_curve')!;
    assert.equal(isSelectableRegister(picker, pp), false);
    assert.equal(isSelectableRegister(twin, pp), true);
});

test('isRegisterEnabled: core always on; group + override precedence; picker follows twin', () => {
    const pp = buildPickerPrimary(registers);
    const core = registers.find((r) => r.group === 'core')!;
    const hw = registers.find((r) => r.group === 'hotwater' && !r.picker)!;
    // no selection => everything enabled
    assert.equal(isRegisterEnabled(hw, null, pp), true);
    // core ignores selection
    assert.equal(isRegisterEnabled(core, {groups: {}, overrides: {}}, pp), true);
    // group off disables it
    assert.equal(isRegisterEnabled(hw, {groups: {hotwater: false}, overrides: {}}, pp), false);
    // per-register override wins over the group
    assert.equal(isRegisterEnabled(hw, {groups: {hotwater: false}, overrides: {[hw.name]: true}}, pp), true);
    // a picker resolves through its twin's override, not its own name
    const picker = registers.find((r) => r.name === 'curve_mode_NIBE.h26_heat_curve')!;
    const twinName = 'measure_count_NIBE.h26_heat_curve';
    assert.equal(isRegisterEnabled(picker, {groups: {heating: true}, overrides: {[twinName]: false}}, pp), false);
});

test('makeProfile computes registerByName and pickerPrimary', () => {
    const p = makeProfile({
        registers,
        role: sProfile.role,
        transport: sProfile.transport,
        detection: sProfile.detection,
        compose: sProfile.compose
    });
    assert.equal(Object.keys(p.registerByName).length, registers.length);
    assert.deepEqual(p.registerByName, buildRegisterByName(registers));
    assert.deepEqual(p.pickerPrimary, buildPickerPrimary(registers));
});

// ---------------------------------------------------------------------------------------
// Register-table invariants (the single-superset-table safety net).
// ---------------------------------------------------------------------------------------

test('every register name is unique', () => {
    const names = registers.map((r) => r.name);
    assert.equal(new Set(names).size, names.length);
});

test('every register is present in the compose capabilities superset', () => {
    const caps = new Set(sProfile.compose.capabilities);
    for (const r of registers)
        assert.ok(caps.has(r.name), `missing from compose.capabilities: ${r.name}`);
});

test('every register has bilingual info and a sane scale/size', () => {
    for (const r of registers) {
        assert.ok(r.info?.en && r.info?.sv, `missing info for ${r.name}`);
        if (r.scale !== undefined)
            assert.ok(typeof r.scale === 'number' && r.scale !== 0, `bad scale for ${r.name}`);
        if (r.size !== undefined)
            assert.ok(r.size === 16 || r.size === 32, `bad size for ${r.name}`);
    }
});

test('every picker has a non-picker twin at the same address', () => {
    for (const r of registers.filter((x) => x.picker)) {
        const twin = registers.find((o) => o.address === r.address && !o.picker);
        assert.ok(twin, `picker ${r.name} has no twin`);
    }
});

// ---------------------------------------------------------------------------------------
// Role logic against the real S profile.
// ---------------------------------------------------------------------------------------

test('registersForRole partitions by role groups', () => {
    const main = registersForRole(sProfile, 'main', null);
    // main carries core; never a heating-only register
    assert.ok(main.some((r) => r.group === 'core'));
    assert.ok(!main.some((r) => r.group === 'heating'));
    const heating = registersForRole(sProfile, 'heating', null);
    assert.ok(heating.some((r) => r.group === 'heating'));
    assert.ok(!heating.some((r) => r.group === 'core'));
    // role-pinned energy register lands only on its role
    const heatProduced = 'meter_kwh_NIBE.i1577_heating_produced';
    assert.ok(heating.some((r) => r.name === heatProduced));
    assert.ok(!registersForRole(sProfile, 'hotwater', null).some((r) => r.name === heatProduced));
});

test('roleRegisters ignores selection; registersForRole honours it', () => {
    const all = roleRegisters(sProfile, 'hotwater');
    const off = registersForRole(sProfile, 'hotwater', {groups: {hotwater: false, energy: false}, overrides: {}});
    assert.ok(all.length > off.length);
});

test('extraCapabilities: S main gets energy pair + total COP; functions get rolling COP; solar none', () => {
    const main = extraCapabilities(sProfile, 'main', null);
    assert.deepEqual(main, ['onoff', 'meter_power.total', 'measure_power', 'measure_cop_NIBE.total']);
    const heating = extraCapabilities(sProfile, 'heating', null);
    assert.deepEqual(heating, ['meter_power.total', 'measure_power', 'measure_cop_NIBE.rolling']);
    assert.deepEqual(extraCapabilities(sProfile, 'solar', null), []);
    // energy group off on main => only the derived on/off remains
    assert.deepEqual(extraCapabilities(sProfile, 'main', {groups: {energy: false}, overrides: {}}), ['onoff']);
});

test('role config sanity: power source scale yields watts, roles cover all functions', () => {
    // S: single whole-unit power register, scale 1 (raw already watts)
    assert.deepEqual(sProfile.role.powerSources, ['measure_watt_NIBE.i2166_energy_usage']);
    assert.equal(sProfile.registerByName['measure_watt_NIBE.i2166_energy_usage'].scale, 1);
    for (const role of functionRoles)
        assert.ok(sProfile.role.producedRegisterForRole[role], `no produced register for ${role}`);
    // every role has a group list
    for (const role of allRoles)
        assert.ok(roleGroups[role].length > 0);
});

// ---------------------------------------------------------------------------------------
// Detection recommendation logic.
// ---------------------------------------------------------------------------------------

function probes(reads: Record<string, {last?: number; moved?: boolean; reads?: number}>): ProbeSamples {
    const out: ProbeSamples = {};
    for (const r of registers)
        out[r.name] = {reads: 0, moved: false};
    for (const [name, p] of Object.entries(reads))
        out[name] = {reads: p.reads ?? 1, moved: p.moved ?? false, last: p.last};
    return out;
}

test('recommendGroups: a moving hot-water sensor recommends hotwater', () => {
    const recs = recommendGroups(sProfile, probes({
        'measure_temperature.i8_warmwater_top': {last: 48, moved: true}
    }));
    assert.equal(recs.hotwater?.recommended, true);
    assert.equal(recs.hotwater?.evidence, 'moving');
});

test('recommendGroups: pool sensor stuck at 0 is not recommended', () => {
    const recs = recommendGroups(sProfile, probes({
        'measure_temperature.i27_pool': {last: 0, moved: false}
    }));
    // read but implausible (0) and not moving
    assert.equal(recs.pool?.recommended, false);
});

test('recommendGroups: a plausible in-range pool temp is recommended', () => {
    const recs = recommendGroups(sProfile, probes({
        'measure_temperature.i27_pool': {last: 27, moved: false}
    }));
    assert.equal(recs.pool?.recommended, true);
    assert.equal(recs.pool?.evidence, 'plausible');
});

test('recommendGroups: groups whose registers never read are unsupported', () => {
    const recs = recommendGroups(sProfile, probes({})); // nothing read
    // heating always plausible-true, but groundsource has no reads => unsupported
    assert.equal(recs.groundsource?.evidence, 'unsupported');
    assert.equal(recs.groundsource?.recommended, false);
});
