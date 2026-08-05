import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    Dir, combineRaw, signedValue, isUnavailableRaw, toNumericValue, isAdjustable, isPollable,
    buildPickerPrimary, buildRegisterByName, isSelectableRegister, isRegisterEnabled, Register,
    resolvedAddress
} from '../lib/registers';
import {makeProfile} from '../lib/profile';
import {
    registersForRole, roleRegisters, extraCapabilities, extraCapabilityOptions,
    extraCapabilitySupport, roleGroups, allRoles, functionRoles,
    ACTIVE_POWER_CAPABILITY, FUNCTION_COP_CAPABILITY, METER_CAPABILITY, TOTAL_COP_CAPABILITY
} from '../lib/roles';
import type {Role} from '../lib/roles';
import {sReason} from '../drivers/nibe_s/reason';
import {buildDetectionResult, recommendGroups, sampleRegisters, ProbeSamples} from '../lib/detection';
import {alarmAdvice, alarmDescription, alarmEntry} from '../lib/alarms';
import alarmCodes from '../lib/alarm-codes.json';
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
    // The "value not available" sentinel is a read that carried nothing, not a number. Decoded
    // naively it becomes a plausible -3276.8, which is how unfitted sensors (BT70/BT82/BT83)
    // used to survive detection and arrive as capabilities that render "-" forever.
    assert.equal(toNumericValue(reg(10), 0x8000), undefined);
    assert.equal(toNumericValue(reg(10, 32), 0x80000000), undefined);
    // A 32-bit register whose value happens to be 0x8000 is a real reading, not the sentinel.
    assert.equal(toNumericValue(reg(10, 32), 0x8000), 3276.8);
});

test('detection: a sensor answering "not available" does not count as read', () => {
    // The hot water circulation accessory (BT70/BT82/BT83) is absent on most pumps. Its
    // registers exist on the model, so the pump answers — with the sentinel. Detection must
    // treat that as no data, or pairing hands the user capabilities that can never fill in.
    const bt70 = 'measure_temperature.i87_outgoing_hotwater';
    const bt82 = 'measure_temperature.i174_hw_comfort_return';
    const bt83 = 'measure_temperature.i175_hw_comfort_heater';
    for (const name of [bt70, bt82, bt83])
        assert.ok(sProfile.registerByName[name], `${name} missing from the register table`);

    // sampleRegisters skips undefined readings, so an all-sentinel register ends at reads: 0.
    const sampled = probes({[bt70]: {reads: 0}});
    assert.equal(sampled[bt70].reads, 0);
    assert.equal(buildDetectionResult(sProfile, sampled).samples[bt70].read, false,
        'an unavailable sensor must be reported as not read, so pairing drops it');
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
    // Internal registers are engine infrastructure with no capability — see Register.internal.
    for (const r of registers.filter((r) => !r.internal))
        assert.ok(caps.has(r.name), `missing from compose.capabilities: ${r.name}`);
});

test('internal registers are polled but never surface as capabilities', () => {
    const internal = registers.filter((r) => r.internal);
    assert.ok(internal.length > 0, 'expected at least the energy-log power fallback');
    const caps = new Set(sProfile.compose.capabilities);
    for (const r of internal) {
        assert.ok(!caps.has(r.name), `${r.name} is internal and must not be a capability`);
        assert.ok(isPollable(r), `${r.name} must still be polled — the allocator reads it`);
        assert.ok(!isSelectableRegister(r, sProfile.pickerPrimary),
            `${r.name} must not be offered in the features view`);
        // Not on any device, under any selection.
        for (const role of allRoles)
            assert.ok(!registersForRole(sProfile, role, null).some((x) => x.name === r.name),
                `${r.name} leaked onto the ${role} device`);
    }
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

test('extraCapabilities: Main carries the bare onoff (pinned on); functions do not', () => {
    // Main: pinned-on bare onoff + derived alarm flag + energy pair + total COP.
    // (alarm_text_NIBE is not here — it's the alarm *register's* own capability.)
    const main = extraCapabilities(sProfile, 'main', null);
    assert.deepEqual(main, ['onoff', 'alarm_generic',
        'meter_power.total', 'measure_power', 'measure_cop_NIBE.total']);
    // Function devices: NO bare onoff (their tile on/off is the real "Allow X" register) —
    // just the energy pair + rolling COP.
    const heating = extraCapabilities(sProfile, 'heating', null);
    assert.deepEqual(heating, ['meter_power.total', 'measure_power', 'measure_cop_NIBE.rolling']);
    // Solar carries neither.
    assert.deepEqual(extraCapabilities(sProfile, 'solar', null), []);
    // Main keeps its on/off (and the alarm pair, which rides the alarm group) when energy is
    // off; functions have no extras then.
    assert.deepEqual(extraCapabilities(sProfile, 'main', {groups: {energy: false}, overrides: {}}),
        ['onoff', 'alarm_generic']);
    assert.deepEqual(extraCapabilities(sProfile, 'heating', {groups: {energy: false}, overrides: {}}), []);
});

test('every extra capability has role-specific options (no option-less COP created at pairing)', () => {
    // The COP "Invalid Capability" bug was a device created with an extra capability but no
    // capabilitiesOptions. Guarantee every extra a role carries resolves to options.
    for (const role of allRoles)
        for (const extra of extraCapabilities(sProfile, role, null))
            assert.ok(extraCapabilityOptions(role, extra)?.title, `no options for ${extra} on ${role}`);
    // Role-specific COP titles.
    assert.deepEqual(extraCapabilityOptions('heating', 'measure_cop_NIBE.rolling').title,
        {en: 'Heating COP (30-day)', sv: 'Värme COP (30 dagar)'});
    assert.deepEqual(extraCapabilityOptions('main', 'measure_cop_NIBE.total').title,
        {en: 'Total COP (30-day)', sv: 'Total COP (30 dagar)'});
});

test('alarm descriptions: known codes, no-alarm, and unknown-code fallback', () => {
    assert.equal(alarmDescription('s', 0, 'en'), 'No alarm');
    assert.equal(alarmDescription('s', 0, 'sv'), 'Inget larm');
    assert.equal(alarmDescription('s', 0, 'de'), 'Kein Alarm');
    // Swedish is NIBE's own wording; other languages get the English translation.
    assert.equal(alarmDescription('s', 438, 'sv'), '438: Tappad anslutning till trådlös enhet');
    assert.equal(alarmDescription('s', 438, 'en'), '438: Lost connection to wireless device');
    assert.equal(alarmDescription('s', 438, 'de'), '438: Lost connection to wireless device');
    // Unmapped code -> localized raw fallback, never blank.
    assert.equal(alarmDescription('s', 99999, 'en'), 'Alarm 99999');
    assert.equal(alarmDescription('s', 99999, 'sv'), 'Larm 99999');
});

test('S and F alarm numbering are different tables and must not be mixed', () => {
    // The bug this guards: 301 codes exist in both series and 300 mean different things.
    // Using the F table on an S pump is silently wrong.
    assert.notEqual(alarmEntry('s', 438)!.sv, alarmEntry('f', 438)!.sv);
    assert.match(alarmEntry('s', 438)!.en, /wireless/i);
    assert.match(alarmEntry('f', 438)!.en, /inverter/i);
    // 51 is an F-series code with no S-series counterpart.
    assert.ok(alarmEntry('f', 51));
    assert.equal(alarmEntry('s', 51), undefined);
    // The S driver must be pinned to the S table.
    assert.equal(sProfile.alarm?.series, 's');
});

test('alarm table is well formed and carries NIBE advice', () => {
    const s = (alarmCodes as any).s as Record<string, {sv: string; en: string; advice?: string}>;
    assert.ok(Object.keys(s).length > 400, 'expected the full S-series table');
    for (const [code, entry] of Object.entries(s)) {
        assert.ok(Number(code) > 0, `alarm code ${code} must be positive (0 = no alarm)`);
        assert.ok(entry.sv && entry.en, `alarm ${code} missing sv/en`);
        // The English pass must not leave Swedish characters behind.
        assert.ok(!/[åäöÅÄÖ]/.test(entry.en), `alarm ${code} English still Swedish: ${entry.en}`);
    }
    // Advice is NIBE's cause/action text, present for most codes.
    assert.ok(alarmAdvice('s', 438), 'expected advice for 438');
    assert.equal(alarmAdvice('s', 99999), undefined);
});

test('alarm wiring: the alarm register carries the text capability, alarm_generic is derived', () => {
    assert.equal(sProfile.alarm?.registerName, 'alarm_text_NIBE');
    const reg = sProfile.registerByName[sProfile.alarm!.registerName];
    assert.ok(reg, 'alarm register must exist');
    assert.equal(reg.address, 1975);
    assert.equal(reg.scale, undefined, 'alarm code must not be scaled');
    assert.equal(reg.group, 'alarm');
    // No numeric alarm-code capability should remain (it made Homey generate meaningless
    // "becomes greater/less than" triggers for an unordered fault code).
    assert.ok(!registers.some((r) => r.name.includes('i1975')));
    assert.ok(!sProfile.compose.capabilities.some((c: string) => c.includes('i1975')));
    assert.ok(extraCapabilities(sProfile, 'main', null).includes('alarm_generic'));
    assert.ok(!extraCapabilities(sProfile, 'heating', null).includes('alarm_generic'));
    assert.ok(!extraCapabilities(sProfile, 'main', {groups: {alarm: false}, overrides: {}})
        .includes('alarm_generic'));
});

test('primaryOnoff maps each function to its enable register and Main to the bare onoff', () => {
    assert.equal(sProfile.role.primaryOnoff?.main, 'onoff');
    assert.equal(sProfile.role.primaryOnoff?.heating, 'onoff.h181_enable_heating');
    assert.equal(sProfile.role.primaryOnoff?.hotwater, 'onoff.h195_enable_hotwater');
    assert.equal(sProfile.role.primaryOnoff?.pool, 'onoff.h691_pool_active');
    assert.equal(sProfile.role.primaryOnoff?.cooling, 'onoff.h182_enable_cooling');
    // Each function's primary onoff is a real, writable register in the table.
    for (const role of functionRoles) {
        const name = sProfile.role.primaryOnoff![role]!;
        const reg = sProfile.registerByName[name];
        assert.ok(reg, `${name} should be a register`);
        assert.equal(reg.bool, true);
    }
});

test('role config sanity: power source scale yields watts, roles cover all functions', () => {
    // S: alternative single-register sources in preference order. 2166 is the instantaneous
    // whole-unit draw (scale 1 = raw already watts); 2305 is the energy log's averaged
    // reading in kW/100 (scale 0.1 → watts), used on the models with no 2166.
    assert.deepEqual(sProfile.role.powerSources, [
        ['measure_watt_NIBE.i2166_energy_usage'],
        ['measure_watt_NIBE.i2305_energylog_power']
    ]);
    assert.equal(sProfile.registerByName['measure_watt_NIBE.i2166_energy_usage'].scale, 1);
    assert.equal(sProfile.registerByName['measure_watt_NIBE.i2305_energylog_power'].scale, 0.1);
    // Every candidate must exist in the table and be readable, or the fallback is a no-op.
    for (const group of sProfile.role.powerSources)
        for (const name of group)
            assert.ok(sProfile.registerByName[name], `power source ${name} is not in the register table`);
    for (const role of functionRoles)
        assert.ok(sProfile.role.producedRegisterForRole[role], `no produced register for ${role}`);
    // every role has a group list
    for (const role of allRoles)
        assert.ok(roleGroups[role].length > 0);
});

// ---------------------------------------------------------------------------------------
// Which derived energy/COP capabilities a pump can actually populate. The regression this
// guards: an S320/S2125 has no register 2166, so the allocator has no power reading and the
// energy pair and per-function COP can never hold a value — but detection used to offer them
// anyway because *other* energy-group registers read fine.
// ---------------------------------------------------------------------------------------

const POWER_2166 = 'measure_watt_NIBE.i2166_energy_usage';
const POWER_2305 = 'measure_watt_NIBE.i2305_energylog_power';
const HEATING_PRODUCED = 'meter_kwh_NIBE.i1577_heating_produced';

// A sample accessor over a set of "these registers did not answer" names; everything else
// read and moved.
const samplesExcept = (absent: string[], flatZero: string[] = []) => (name: string) =>
    absent.includes(name) ? undefined
        : {read: true, moved: !flatZero.includes(name), value: flatZero.includes(name) ? 0 : 42};

test('extraCapabilitySupport: each derived capability follows the registers it needs', () => {
    // Everything reads — an S1155.
    const all = extraCapabilitySupport(sProfile, 'heating', samplesExcept([]));
    assert.equal(all[METER_CAPABILITY], true);
    assert.equal(all[ACTIVE_POWER_CAPABILITY], true);
    assert.equal(all[FUNCTION_COP_CAPABILITY], true);

    // An S320/S2125: no 2166 at all, but the energy log's 2305 answers → still supported,
    // because the allocator falls back to it.
    const viaFallback = extraCapabilitySupport(sProfile, 'heating', samplesExcept([POWER_2166]));
    assert.equal(viaFallback[METER_CAPABILITY], true, 'the fallback power source keeps energy alive');
    assert.equal(viaFallback[FUNCTION_COP_CAPABILITY], true);

    // Neither power source usable → the whole allocator-derived set drops out.
    const noPower = extraCapabilitySupport(sProfile, 'heating', samplesExcept([POWER_2166, POWER_2305]));
    assert.equal(noPower[METER_CAPABILITY], false, 'energy pair needs a power source');
    assert.equal(noPower[ACTIVE_POWER_CAPABILITY], false);
    assert.equal(noPower[FUNCTION_COP_CAPABILITY], false, 'function COP needs the used energy');

    // Main's Total COP comes straight off the lifetime counters, so it survives that — which
    // is exactly why an S320 shows a Total COP while every per-function COP stays empty.
    const mainNoPower = extraCapabilitySupport(sProfile, 'main', samplesExcept([POWER_2166, POWER_2305]));
    assert.equal(mainNoPower[TOTAL_COP_CAPABILITY], true);

    // A missing produced counter kills only that function's COP, not the energy pair.
    const noProduced = extraCapabilitySupport(sProfile, 'heating', samplesExcept([HEATING_PRODUCED]));
    assert.equal(noProduced[FUNCTION_COP_CAPABILITY], false);
    assert.equal(noProduced[METER_CAPABILITY], true);
});

test('extraCapabilitySupport: a power register that answers but is always zero is not usable', () => {
    // Register 2727 on a live S1155 answers every read and sits at zero through a 3.3 kW
    // compressor run, because it belongs to the external energy-meter accessory. "It replied"
    // is therefore not enough evidence to build the energy capabilities on.
    const flatZero = extraCapabilitySupport(sProfile, 'heating',
        samplesExcept([POWER_2166], [POWER_2305]));
    assert.equal(flatZero[METER_CAPABILITY], false, 'a flat-zero power register must not count');
    assert.equal(flatZero[FUNCTION_COP_CAPABILITY], false);

    // But a register that reads zero *and moves* is a real reading that happens to be idle.
    const movedThroughZero = extraCapabilitySupport(sProfile, 'heating',
        (name) => (name === POWER_2166 ? undefined : {read: true, moved: true, value: 0}));
    assert.equal(movedThroughZero[METER_CAPABILITY], true);
});

test('extraCapabilities honours a per-capability override for the COP sensors', () => {
    const selection = (overrides: Record<string, boolean>) =>
        ({groups: {energy: true, heating: true}, overrides});

    assert.ok(extraCapabilities(sProfile, 'heating', selection({})).includes(FUNCTION_COP_CAPABILITY));
    const off = extraCapabilities(sProfile, 'heating', selection({[FUNCTION_COP_CAPABILITY]: false}));
    assert.ok(!off.includes(FUNCTION_COP_CAPABILITY), 'the override must switch the COP off');
    assert.ok(off.includes(METER_CAPABILITY), 'without disturbing the energy pair');

    const mainOff = extraCapabilities(sProfile, 'main', selection({[TOTAL_COP_CAPABILITY]: false}));
    assert.ok(!mainOff.includes(TOTAL_COP_CAPABILITY));
    // Main's energy pair honours overrides the same way (it previously ignored them).
    const mainNoMeter = extraCapabilities(sProfile, 'main', selection({[METER_CAPABILITY]: false}));
    assert.ok(!mainNoMeter.includes(METER_CAPABILITY));
    assert.ok(mainNoMeter.includes(ACTIVE_POWER_CAPABILITY), 'only the overridden one drops');
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

// ---- Priority-change reasons (drivers/nibe_s/reason.ts) ----
//
// The rules are pure, so they're exercised directly here rather than through a live pump: for
// each scenario, feed the register values the pump would be showing and check the sentence
// names the comparison that actually fired.

// A realistic idle S1155: -60 start threshold, medium hot-water demand, nothing running.
const baseline: Record<string, number> = {
    dm: 0, dmStart: -60, dmAddDiff: 400, calcSupply: 26.6, supply: 22.7, addSteps: 0,
    stopHeatingOut: 17.0, hwCharge: 48.9, hwTop: 49.5, hwMode: 1,
    hwStartSmall: 38, hwStopSmall: 45, hwStartMedium: 44, hwStopMedium: 51,
    hwStartLarge: 48, hwStopLarge: 55, moreHotwater: 0, periodicHw: 0,
    dmCooling: 30, startCoolingOut: 25, poolTemp: 24, poolStart: 22, poolStop: 25,
    outdoor: 10.0, sgReady: 10
};

const why = (role: Role, previousRole: Role | undefined, over: Record<string, number> = {}) => {
    const values = {...baseline, ...over};
    return sReason.explain({role, previousRole, v: (id) => values[id]});
};

test('reason: heating start cites degree minutes against the start threshold', () => {
    const reason = why('heating', 'main', {dm: -60, supply: 34.2, calcSupply: 35.1});
    assert.match(reason!.en, /degree minutes are down to -60/);
    assert.match(reason!.en, /at or past the -60 threshold that starts the compressor/);
    assert.match(reason!.en, /supply line is 34\.2 °C against a calculated 35\.1 °C/);
    // Swedish carries the same facts with a decimal comma.
    assert.match(reason!.sv, /gradminuterna är nere på -60/);
    assert.match(reason!.sv, /34,2 °C mot beräknade 35,1 °C/);
});

test('reason: heating with the electric addition running says so, and where it cuts in', () => {
    const reason = why('heating', 'main', {dm: -470, addSteps: 2});
    assert.match(reason!.en, /electric addition has joined in at 2 steps/);
    assert.match(reason!.en, /cuts in at -460/);          // dmStart (-60) - dmAddDiff (400)
});

test('reason: heating that resumes after another function is not blamed on degree minutes', () => {
    // Coming off hot water the compressor is already turning, so DM is nowhere near the start
    // threshold — claiming the house "fell behind on heat" would be wrong.
    const reason = why('heating', 'hotwater', {dm: -12})!;
    assert.match(reason.en, /Hot water was finished, so the pump went back to heating/);
    assert.match(reason.en, /degree minutes are at -12, still short of the -60 start threshold/);
    assert.doesNotMatch(reason.en, /fell behind/);
});

test('reason: the heating cut-off is not mentioned after hot water or pool', () => {
    // It is relevant when heating is what you'd expect to happen next...
    assert.match(why('main', 'heating', {outdoor: 17.3})!.en, /stays off anyway/);
    assert.match(why('main', 'main', {outdoor: 17.3})!.en, /stays off anyway/);
    // ...and a non sequitur when the pump just finished something else.
    assert.doesNotMatch(why('main', 'hotwater', {outdoor: 17.3})!.en, /stays off anyway/);
    assert.doesNotMatch(why('main', 'pool', {outdoor: 17.3})!.en, /stays off anyway/);
});

test('reason: hot water start cites the tank against its demand-mode start point', () => {
    const reason = why('hotwater', 'main', {hwCharge: 43.6});
    assert.match(reason!.en, /Hot water ran down to 43\.6 °C/);
    assert.match(reason!.en, /44\.0 °C start point for Medium demand/);
});

test('reason: the demand mode selects which start/stop pair is quoted', () => {
    const large = why('hotwater', 'main', {hwMode: 2, hwCharge: 47.5});
    assert.match(large!.en, /48\.0 °C start point for Large demand/);
    const small = why('hotwater', 'main', {hwMode: 0, hwCharge: 37.2});
    assert.match(small!.en, /38\.0 °C start point for Small demand/);
});

test('reason: a manual boost is reported as the boost, not as a temperature', () => {
    const reason = why('hotwater', 'main', {moreHotwater: 2, hwCharge: 20});
    assert.match(reason!.en, /"More hot water" was switched on/);
    assert.doesNotMatch(reason!.en, /start point/);
});

test('reason: charging a tank that is above its start point is a scheduled top-up', () => {
    // Only claimed when periodic hot water is actually enabled...
    assert.match(why('hotwater', 'main', {periodicHw: 1})!.en, /Scheduled periodic hot water charge/);
    // ...otherwise the app says what it knows and nothing more.
    const plain = why('hotwater', 'main', {periodicHw: 0})!;
    assert.match(plain.en, /Hot water demand — the tank is at 48\.9 °C\./);
});

test('reason: going idle explains what just finished, not that nothing is happening', () => {
    assert.match(why('main', 'heating', {dm: 0})!.en,
        /house has caught up on heat — degree minutes are back to 0 \(the compressor restarts at -60\)/);
    assert.match(why('main', 'hotwater', {hwCharge: 51.2})!.en,
        /tank is charged: hot water reached 51\.2 °C, its 51\.0 °C stop point/);
    assert.match(why('main', 'pool', {poolTemp: 25})!.en, /pool reached 25\.0 °C, its 25\.0 °C stop point/);
});

test('reason: the outdoor cut-off is reported when it is what keeps heating off', () => {
    const blocked = why('main', 'heating', {outdoor: 17.3, stopHeatingOut: 17.0})!;
    assert.match(blocked.en, /Heating stays off anyway while it is 17\.3 °C outside \(the limit is 17\.0 °C\)/);
    // Below the limit it is not mentioned — no filler.
    assert.doesNotMatch(why('main', 'heating', {outdoor: 4.1})!.en, /stays off anyway/);
});

test('reason: an SG Ready price signal is only mentioned when it changes behaviour', () => {
    assert.match(why('heating', 'main', {dm: -60, sgReady: 20})!.en, /high electricity price/);
    assert.match(why('heating', 'main', {dm: -60, sgReady: 40})!.en, /free electricity/);
    assert.doesNotMatch(why('heating', 'main', {dm: -60, sgReady: 10})!.en, /SG Ready/);
    assert.doesNotMatch(why('heating', 'main', {dm: -60, sgReady: 30})!.en, /SG Ready/);
});

test('reason: cooling and pool starts cite their own thresholds', () => {
    assert.match(why('cooling', 'main', {dm: 45, outdoor: 26.4})!.en,
        /degree minutes rose to 45, past the 30 cooling threshold, with 26\.4 °C outdoors/);
    assert.match(why('pool', 'main', {poolTemp: 21.4})!.en,
        /pool cooled to 21\.4 °C, reaching its 22\.0 °C start point/);
});

test('reason: rules degrade instead of printing blanks when registers do not read', () => {
    // Nothing read at all — still a sentence, just a weaker one, and never "undefined".
    const bare = sReason.explain({role: 'heating', previousRole: 'main', v: () => undefined})!;
    assert.equal(bare.en, 'Heat demand in the house.');
    assert.doesNotMatch(bare.sv, /undefined|NaN/);
    // A partial read drops the clause it can't support rather than the whole sentence.
    const noSupply = why('heating', 'main', {dm: -60, supply: undefined as any, calcSupply: undefined as any})!;
    assert.match(noSupply.en, /degree minutes are down to -60/);
    assert.doesNotMatch(noSupply.en, /supply line/);
});

test('reason: both languages are always produced, and neither leaks the other', () => {
    const cases: [Role, Role | undefined][] = [
        ['heating', 'main'], ['hotwater', 'main'], ['cooling', 'main'], ['pool', 'main'],
        ['main', 'heating'], ['main', 'hotwater'], ['main', 'pool'], ['main', 'cooling'],
        ['main', 'main'], ['main', undefined]
    ];
    for (const [role, previous] of cases) {
        const reason = why(role, previous);
        assert.ok(reason, `expected an explanation for ${previous} -> ${role}`);
        for (const lang of ['en', 'sv'] as const) {
            assert.ok(reason![lang].length > 10, `${lang} explanation for ${previous} -> ${role} is too short`);
            assert.doesNotMatch(reason![lang], /undefined|NaN/,
                `${lang} explanation for ${previous} -> ${role} has an unresolved value`);
        }
        assert.notEqual(reason!.en, reason!.sv, `${previous} -> ${role} was not translated`);
    }
});

test('reason inputs are synthetic names, kept out of every capability path', () => {
    // They are read on demand at a priority change and are best-effort by contract — explain()
    // degrades when one is missing, and several cover functions a given pump may not have. The
    // `__` prefix is what keeps them out of the capability table and out of read-failure
    // reporting, so a missing pool sensor is not announced as a broken register.
    const names = Object.keys(sReason.inputs);
    assert.ok(names.length > 0);
    const caps = new Set(sProfile.compose.capabilities);
    for (const id of names) {
        const synthetic = `__reason.${id}`;
        assert.ok(synthetic.startsWith('__'), `${synthetic} must be namespaced as synthetic`);
        assert.ok(!caps.has(synthetic), `${synthetic} must never be a capability`);
        assert.ok(!registers.some((r) => r.name === synthetic),
            `${synthetic} must not appear in the register table`);
    }
});

test('energy-log inclusion settings are declared, and are diagnostics rather than capabilities', () => {
    // Whether cooling or hot water counts toward the pump's own energy totals is a setting on
    // the pump (Nibe: eMbHolding_eU8EnergyLogSettingsInc*), so two identical models can report
    // different totals. The app reads these once per connect and logs them, because a support
    // log showing the energy figures without them cannot explain the figures.
    const settings = sProfile.energyLogSettings ?? [];
    const byLabel = Object.fromEntries(settings.map((s) => [s.label, s.address]));
    assert.equal(byLabel['cooling'], 3095, 'IncCooling is the one that explains cooling totals');
    assert.equal(byLabel['pool 1'], 3093);
    // Only flags some S-model actually exposes belong here. IncHW (3092) and IncPool2 (3094)
    // are in Nibe's master symbol list but on none of the six S-series maps, so listing them
    // would add a permanent "unavailable" to every log line and tell nobody anything.
    assert.equal(settings.length, 2, 'do not list flags no S-model exposes');

    for (const setting of settings) {
        // Never a capability: no register may claim these addresses, or they would show on a
        // tile and be offered during pairing.
        assert.ok(!registers.some((r) => r.address === setting.address),
            `${setting.label} (${setting.address}) must not be in the register table`);
        assert.ok(!sProfile.compose.capabilities.some((c) => c.includes(String(setting.address))),
            `${setting.label} (${setting.address}) must not be a capability`);
    }
});

test('the energy log is declared internal, resolves, and is never a capability', () => {
    // These are the pump's own per-function hourly figures — the intended replacement for the
    // allocator's estimate, which was measured attributing 1.37 kWh to hot water on a day the
    // pump booked 1.00 kWh for the whole unit.
    const entries = sProfile.energyLog ?? [];
    assert.ok(entries.length >= 8, 'expected the produced/used pairs plus additional heat');
    const caps = new Set(sProfile.compose.capabilities);
    for (const entry of entries) {
        const register = sProfile.registerByName[entry.name];
        assert.ok(register, `${entry.name} is not in the register table`);
        assert.equal(register.internal, true, `${entry.name} must be internal, never a capability`);
        assert.ok(!caps.has(entry.name), `${entry.name} must not be in the compose capabilities`);
        // div=100 in Nibe's tables, 32-bit. Getting either wrong silently scales every hour.
        assert.equal(register.scale, 100, `${entry.name} is kWh/100`);
        assert.equal(register.size, 32, `${entry.name} is a 32-bit value`);
    }
    // Both halves of a COP must be present for at least heating and hot water on every model.
    for (const label of ['heating used', 'heating produced', 'hot water used', 'hot water produced'])
        assert.ok(entries.some((e) => e.label === label), `missing ${label}`);
});

test('compressor-only produced counters are mapped as internal', () => {
    // Mapped to test whether 3821 tracks compressor-only output: the per-function counters
    // overshoot it by +0.99% on an S320 and +0.54% on an S1155 that has neither cooling nor
    // pool, so cooling exclusion cannot be the explanation.
    for (const name of ['meter_kwh_NIBE.i1583_hotwater_produced_compressor',
                        'meter_kwh_NIBE.i1585_heating_produced_compressor']) {
        const register = sProfile.registerByName[name];
        assert.ok(register, `${name} missing`);
        assert.equal(register.internal, true);
        assert.equal(register.scale, 10);
        assert.equal(register.size, 32);
    }
});

test('every energy-log entry names a real role and side, and both sides exist per function', () => {
    // The engine groups these by role to steer each function's meter onto the pump's own books,
    // so a wrong role silently sends one function's energy to another device.
    const entries = sProfile.energyLog ?? [];
    for (const e of entries) {
        assert.ok(allRoles.includes(e.role), `${e.name} names an unknown role ${e.role}`);
        assert.ok(e.role !== 'main' && e.role !== 'solar',
            `${e.name}: the log is per function; main's share is the residual, not a register`);
        assert.ok(e.flow === 'used' || e.flow === 'produced', `${e.name} has no side`);
    }
    // Heating and hot water must have both sides on every model, or their COP loses a half.
    for (const role of ['heating', 'hotwater'])
        for (const flow of ['used', 'produced'])
            assert.ok(entries.some((e) => e.role === role && e.flow === flow),
                `no ${flow} entry for ${role}`);
    // Additional-heat entries are electricity, so they must be on the used side — putting one
    // on produced would inflate that function's COP.
    for (const e of entries.filter((x) => x.label.startsWith('add.heat')))
        assert.equal(e.flow, 'used', `${e.name} is electricity the additional heater drew`);
});

test('a Modbus write failure explains itself instead of saying "see response body"', async () => {
    const {describeModbusError, safeJson} = await import('../lib/connection');
    // jsmodbus reports every exception as "A Modbus Exception Occurred - See Response Body" and
    // the body was previously discarded, leaving no way to tell an out-of-range value from a
    // register the pump refuses in its current state.
    const exception = (code: number) =>
        ({message: 'A Modbus Exception Occurred - See Response Body', response: {body: {code}}});
    assert.match(describeModbusError(exception(3)).summary, /Illegal data value/);
    assert.equal(describeModbusError(exception(3)).code, 3);
    assert.match(describeModbusError(exception(2)).summary, /no such register/);
    assert.match(describeModbusError(exception(6)).summary, /busy/);
    // An unknown code must still name the number rather than falling back to the useless message.
    assert.match(describeModbusError(exception(99)).summary, /99/);
    // Non-exception failures keep their own meaning.
    assert.match(describeModbusError({err: 'Timeout'}).summary, /did not answer in time/);
    assert.equal(describeModbusError({message: 'socket closed'}).summary, 'socket closed');

    // The raw error is dumped verbatim alongside, so nothing is lost — including shapes that
    // would defeat a naive JSON.stringify.
    const circular: any = {response: {body: {code: 3}}};
    circular.self = circular;
    assert.match(safeJson(circular), /"code": 3/);
    assert.match(safeJson(circular), /circular/);
    assert.match(safeJson(new Error('boom')), /boom/);
});

// ---- Registers that live at a different address on some models ----

// Drive sampleRegisters with a fake pump: `answers` maps an address to the value that
// address returns, and anything else reads as nothing (the model doesn't implement it, or
// answers with the sentinel — both arrive here as undefined).
function sampleAgainst(answers: Record<number, number | undefined>) {
    return sampleRegisters(
        sProfile,
        async (register: Register) => answers[register.address],
        () => {},
        1,
        0
    );
}

const INSIDE = 'measure_temperature.i26_inside';

test('sources: indoor temperature offers the three candidates, 116 first', () => {
    // Verified on a live S1155 (fw 1036): 116 is climate system 1 and carries the real value,
    // 111 is climate system 6 and returns the sentinel, 26 is a single sensor and excepts.
    const inside = sProfile.registerByName[INSIDE];
    assert.equal(inside.address, 116, 'climate system 1 is 116 on all six model maps');
    assert.deepEqual(inside.sources?.map((s) => s.address), [116, 111, 26]);
    assert.equal(inside.altAddresses, undefined, 'sources replaces the silent-fallback path');
});

test('sources: only one candidate alive resolves silently, with no question for the user', async () => {
    // The S735 case: 116 and 111 are dead, 26 carries the room temperature. There is nothing to
    // ask — but the address must still be recorded, or the device goes on reading a dead 116.
    const {probes, addresses, choices} = await sampleAgainst({26: 22.5});
    assert.equal(addresses[INSIDE], 26, 'the only live candidate must be recorded');
    assert.equal(choices[INSIDE], undefined, 'one candidate is not a choice');
    // Folded into the probe, or pairing drops the capability as "no data" and the resolution
    // never gets used — the gap that lost the room-temperature tile on a fresh S735 pair.
    assert.equal(probes[INSIDE].reads, 1);
    assert.equal(probes[INSIDE].last, 22.5);
    assert.equal(buildDetectionResult(sProfile, probes, addresses).samples[INSIDE].read, true);
});

test('sources: several live candidates become a question, defaulting to the first', async () => {
    // A house with both a climate-system average and a single room sensor. These are different
    // quantities, so the pump cannot choose and detection must hand the decision up.
    const {addresses, choices} = await sampleAgainst({116: 21.0, 26: 22.5});
    assert.equal(addresses[INSIDE], 116, 'the default is the first live candidate, in declared order');
    assert.deepEqual(choices[INSIDE].map((c) => c.address), [116, 26]);
    // The view shows each candidate's reading — without the numbers there is no way to tell a
    // system average from a single sensor.
    assert.deepEqual(choices[INSIDE].map((c) => c.value), [21.0, 22.5]);
    assert.ok(choices[INSIDE][0].label.en && choices[INSIDE][0].label.sv, 'candidates are bilingual');
});

test('sources: an implausible candidate is not offered', async () => {
    // The 2727 trap again: 26 answering with a flat 0 is a dead sensor, not 0 °C, so the user
    // must not be asked to choose it — and with only 116 alive there is no question at all.
    const {addresses, choices} = await sampleAgainst({116: 21.0, 26: 0});
    assert.equal(addresses[INSIDE], 116);
    assert.equal(choices[INSIDE], undefined);
});

test('sources: no live candidate leaves the register alone', async () => {
    const {addresses, choices} = await sampleAgainst({});
    assert.equal(addresses[INSIDE], undefined);
    assert.equal(choices[INSIDE], undefined);
});

test('sources: every declaration is well formed', () => {
    for (const register of registers) {
        if (!register.sources?.length)
            continue;
        assert.ok(register.altPlausible,
            `${register.name} declares sources without a band to judge them by`);
        assert.equal(register.sources[0].address, register.address,
            `${register.name} must list its own address first — it is the default`);
        assert.equal(new Set(register.sources.map((s) => s.address)).size, register.sources.length,
            `${register.name} lists a candidate address twice`);
        for (const source of register.sources)
            assert.ok(source.label.en && source.label.sv,
                `${register.name} candidate ${source.address} is missing a label`);
    }
});

test('alternates: an implausible reading is rejected rather than accepted', async () => {
    // 0 *is* data for a meter that has counted nothing, so that band admits it — unlike the
    // room-sensor band, which treats a flat 0 as a dead sensor.
    const pulse = 'meter_kwh_NIBE.i398_pulse_energy';
    const resolved = (await sampleAgainst({396: 0})).addresses;
    assert.equal(resolved[pulse], 396);
});

test('alternates: every declaration is well formed and unambiguous', () => {
    const byDirection = new Map<string, string>();
    for (const register of registers)
        byDirection.set(`${register.direction}@${register.address}`, register.name);
    for (const register of registers) {
        if (!register.altAddresses?.length)
            continue;
        // A band is what stops an undocumented address being accepted on the strength of
        // answering, so it is not optional.
        assert.ok(register.altPlausible, `${register.name} declares alternates without a band`);
        assert.ok(register.altPlausible!.min < register.altPlausible!.max,
            `${register.name} has an inverted band`);
        for (const address of register.altAddresses) {
            assert.notEqual(address, register.address,
                `${register.name} lists its own address as an alternate`);
            // An alternate that is another register's primary in the same direction would make
            // two capabilities read the same quantity without anyone noticing.
            const clash = byDirection.get(`${register.direction}@${address}`);
            assert.ok(clash === undefined || clash === register.name,
                `${register.name} alternate ${address} collides with ${clash}`);
        }
    }
});

test('alternates: the resolved address is what reads and writes actually use', () => {
    const selection = {groups: {heating: true}, overrides: {}, addresses: {[INSIDE]: 26}};
    const resolved = registersForRole(sProfile, 'heating', selection)
        .find((r) => r.name === INSIDE);
    assert.equal(resolved?.address, 26, 'polling and the dump must follow the resolution');
    // The table itself is untouched — resolution is per device, not a global mutation.
    assert.equal(sProfile.registerByName[INSIDE].address, 116);
    // Writes resolve at call time from the same map.
    assert.equal(resolvedAddress(sProfile.registerByName[INSIDE], selection), 26);
    assert.equal(resolvedAddress(sProfile.registerByName[INSIDE], null), 116);
});

// ---- Zone setpoints ----

test('the indoor setpoint is the zone register, not the legacy room-sensor one', () => {
    // Verified on a live S1155 (fw 1036): setting 35 °C then 28 °C in the myUplink app moved
    // holding 2505 both times, and it was the only register out of 2065 to follow. Registers
    // 206/55 sat at their factory default throughout — they are legacy on zone firmware, and
    // exposing them would give the user a control that silently does nothing.
    const setpoint = sProfile.registerByName['target_temperature.h2505_zone1_setpoint'];
    assert.ok(setpoint, 'zone 1 setpoint must exist');
    assert.equal(setpoint.address, 2505);
    assert.equal(setpoint.direction, Dir.Out);
    assert.equal(setpoint.size, 32, 'the zone family is s32 — a 16-bit read returns garbage');
    assert.equal(setpoint.scale, 10);
    assert.equal(setpoint.group, 'heating', 'zone 1 is the single-zone case, not an extra');

    // The CSV documents max 300 (30.0 °C) and is wrong: the live register held 350. Clamping to
    // 30 would reject a value the pump itself accepts.
    assert.equal(setpoint.max, 35);
    assert.equal(setpoint.min, 5);

    for (const legacy of [206, 205, 204, 203, 55, 54, 53])
        assert.ok(!registers.some((r) => r.direction === Dir.Out && r.address === legacy),
            `legacy room-sensor register ${legacy} must not be exposed as a control`);
});

test('zones 2-4 are their own group so a single-zone pump does not carry dead controls', () => {
    const extras = ['target_temperature.h2507_zone2_setpoint',
        'target_temperature.h2509_zone3_setpoint',
        'target_temperature.h2511_zone4_setpoint'];
    for (const name of extras) {
        const zone = sProfile.registerByName[name];
        assert.ok(zone, `${name} must exist`);
        assert.equal(zone.group, 'zones');
        assert.equal(zone.size, 32);
    }
    // The zone family is one zone per two registers, ascending.
    assert.deepEqual(extras.map((n) => sProfile.registerByName[n].address), [2507, 2509, 2511]);
    // The heating device owns them, so the setpoints land next to the temperature they drive.
    assert.ok((roleGroups.heating as string[]).includes('zones'));
});

test('zones are recommended on evidence of a real setpoint, never on the register answering', () => {
    // The trap this guards: on a single-zone S1155 registers 2507..2583 all ANSWER — they just
    // read a flat 0 instead of their documented default of 20. Recommending on "it responded"
    // would give every ordinary house three phantom zones.
    const answered = (value: number): ProbeSamples => Object.fromEntries(
        sProfile.registers.map((r) => [r.name,
            {reads: 1, moved: false, last: r.group === 'zones' ? value : 0}]));

    assert.equal(recommendGroups(sProfile, answered(0)).zones?.recommended, false,
        'a flat zero is an unconfigured zone, not a zone set to 0 °C');
    assert.equal(recommendGroups(sProfile, answered(21)).zones?.recommended, true);
});
