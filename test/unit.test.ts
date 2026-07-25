import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    Dir, combineRaw, signedValue, isUnavailableRaw, toNumericValue, isAdjustable, isPollable,
    buildPickerPrimary, buildRegisterByName, isSelectableRegister, isRegisterEnabled, Register
} from '../lib/registers';
import {makeProfile} from '../lib/profile';
import {
    registersForRole, roleRegisters, extraCapabilities, extraCapabilityOptions,
    roleGroups, allRoles, functionRoles
} from '../lib/roles';
import type {Role} from '../lib/roles';
import {sReason} from '../drivers/nibe_s/reason';
import {recommendGroups, ProbeSamples} from '../lib/detection';
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
