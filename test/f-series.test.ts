import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fProfile} from '../drivers/nibe_f/profile';
import {sProfile} from '../drivers/nibe_s/profile';
import {Dir, flowPredicates, toNumericValue} from '../lib/registers';
import {recommendGroups, readNumeric, sampleRegisters} from '../lib/detection';
import {PumpConnection} from '../lib/connection';
import {planPoll, frequentRegisterNames} from '../lib/poll-plan';
import {extraCapabilitySupport, FUNCTION_COP_CAPABILITY, METER_CAPABILITY, roomThermostatActive, deviceClass, extraCapabilities} from '../lib/roles';

const at = (address: number) => fProfile.registers.find((r) => r.address === address)!;

test('detection paces cached replies, retries an initial miss and can cancel during pacing', async () => {
    const profile = {...fProfile, registers: [at(40004)],
        detection: {...fProfile.detection, requestIntervalMs: 30}};
    const starts: number[] = []; const progress: number[] = [];
    const result = await sampleRegisters(profile, async () => {
        starts.push(Date.now()); return starts.length === 1 ? undefined : 7.5;
    }, (done) => progress.push(done), undefined, 0);
    assert.equal(starts.length, 2);
    assert.ok(starts[1] - starts[0] >= 25);
    assert.equal(result.probes[at(40004).name].reads, 1);
    assert.deepEqual(progress, [1, 2]);
    const controller = new AbortController(); let calls = 0;
    await assert.rejects(sampleRegisters(profile, async () => {
        calls++; setTimeout(() => controller.abort(), 5); return 7.5;
    }, () => {}, undefined, 0, controller.signal), /cancelled/);
    assert.equal(calls, 1);
});

test('slow gateway plan retains coherent energy and thermostat inputs and fairly rotates background reads', () => {
    const attempted = new Map<string, number>();
    const first = planPoll(fProfile, fProfile.registers, attempted, 0);
    for (const a of [43086, 43375, 43141, 43084, 42437, 42439, 40033, 47394, 47398])
        assert.ok(first.frequent.includes(at(a)), `frequent ${a}`);
    assert.equal(first.background.length, 1);
    const visited = new Set<string>();
    for (let i = 0; i < fProfile.registers.length - first.frequent.length; i++) {
        const next = planPoll(fProfile, fProfile.registers, attempted, i * 10_000).background[0];
        assert.ok(!visited.has(next.name));
        visited.add(next.name); attempted.set(next.name, i * 10_000);
    }
    const only = first.background;
    assert.equal(planPoll(fProfile, only, new Map([[only[0].name, 0]]), 59_999).background.length, 0);
    assert.equal(planPoll(fProfile, only, new Map([[only[0].name, 0]]), 60_000).background.length, 1);
    assert.deepEqual(planPoll(sProfile, sProfile.registers, attempted, 0).frequent, sProfile.registers);
    assert.ok(frequentRegisterNames(fProfile).size <= 20);
});

test('frequent values and allocation are published before a slow background reply', async () => {
    const c: any = Object.create(PumpConnection.prototype);
    let release!: (v: number) => void;
    let allocations = 0; let completed = 0;
    const seen: string[] = [];
    const chosen = [at(43086), at(43375), at(43084), at(47011)];
    Object.assign(c, {profile: fProfile, connected: true, polling: false, generation: 1,
        pollDeadlineMs: 1000, priorityRegister: at(43086), powerRegisters: [at(43375), at(43084)],
        unsupportedUntil: new Map(), knownAbsent: new Set(), backgroundAttempted: new Map(), lastRaw: new Map(),
        unionRegisters: () => chosen,
        readRegisterRaw: async (r: any) => r.address === 47011
            ? await new Promise<number>((resolve) => { release = resolve; }) : 1,
        subscribers: [{wantedRegisters: () => chosen,
            onRegisterRaw: (r: any) => seen.push(r.name), onPollComplete: () => completed++}],
        applyEnergyLogPriorityOverride: () => {}, reportReadFailures: () => {}, reportEnergyLogSteps: () => {},
        traceSnapshot: () => {}, allocateEnergy: () => allocations++, log: assert.fail});
    c.poll();
    try {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(allocations, 1); assert.equal(completed, 1);
        assert.ok(!seen.includes(at(47011).name));
        release(2);
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(seen.includes(at(47011).name));
        assert.equal(allocations, 1); assert.equal(completed, 1);
    } finally { clearTimeout(c.pollDeadline); }
});

test('F thermostat requires a real room reading and enabled room regulation', () => {
    const cfg = fProfile.roomThermostat!;
    const values = new Map([[cfg.sensor, 21], [cfg.target, 22], [cfg.enabled, 0]]);
    assert.equal(roomThermostatActive(fProfile, (n) => values.get(n)), false);
    values.set(cfg.enabled, 1);
    assert.equal(roomThermostatActive(fProfile, (n) => values.get(n)), true);
    values.delete(cfg.sensor);
    assert.equal(roomThermostatActive(fProfile, (n) => values.get(n)), false);
    const selection = {groups: {}, overrides: {}, roomThermostat: false};
    assert.equal(deviceClass(fProfile, 'heating', selection), 'heater');
    assert.equal(extraCapabilities(fProfile, 'heating', selection).includes('target_temperature'), false);
    selection.roomThermostat = true;
    assert.equal(deviceClass(fProfile, 'heating', selection), 'thermostat');
    assert.equal(extraCapabilities(fProfile, 'heating', selection).includes('target_temperature'), true);
});

test('F single-word controls use FC16 with every address convention', async () => {
    for (const base of [0, 40001, 40000]) {
        const c: any = Object.create(PumpConnection.prototype);
        const writes: any[] = [];
        Object.assign(c, {profile: fProfile, transport: {addressBase: base},
            withWireAccess: (fn: any) => fn(),
            client: {writeMultipleRegisters: async (...args: any[]) => writes.push(args)}});
        await c.writeRegisterValue(at(47011), 65535);
        assert.deepEqual(writes, [[47011 - base, [65535]]]);
        await assert.rejects(c.writeRegisterValue(at(40033), 200), /read-only/);
    }
});

test('F COP requires production and a complete compressor plus immersion source', () => {
    const values = new Map([[43375, 1000], [43084, 0], [42439, 1234]]);
    const sample = (name: string) => {
        const value = values.get(fProfile.registerByName[name]?.address);
        return {read: value !== undefined, moved: false, value};
    };
    assert.equal(extraCapabilitySupport(fProfile, 'heating', sample)[FUNCTION_COP_CAPABILITY], true);
    values.delete(43084);
    assert.equal(extraCapabilitySupport(fProfile, 'heating', sample)[METER_CAPABILITY], false);
    values.set(43084, 0); values.delete(42439);
    assert.equal(extraCapabilitySupport(fProfile, 'heating', sample)[FUNCTION_COP_CAPABILITY], false);
});

test('F power sums required sources and falls back without double counting', () => {
    const c: any = Object.create(PumpConnection.prototype);
    c.powerGroups = fProfile.role.powerSources.map((g) => g.map((n) => fProfile.registerByName[n]));
    c.notePowerGroup = () => {};
    const raw = new Map([[at(43375).name, 100], [at(43141).name, 120], [at(43084).name, 150]]);
    assert.equal(c.totalWatts(raw), 2500);
    raw.delete(at(43375).name);
    assert.equal(c.totalWatts(raw), 2700);
    raw.delete(at(43084).name);
    assert.equal(c.totalWatts(raw), null);
});

test('F holding registers expose only the reviewed controls', () => {
    assert.ok(fProfile.registers.length > 0);
    for (const r of fProfile.registers) {
        assert.equal(r.direction, Dir.Out);
        if (r.address < 47000) {
            assert.equal(r.noAction, true);
            assert.equal(flowPredicates.numericAction(r), false);
            assert.equal(flowPredicates.boolAction(r), false);
        }
        if (!r.internal) {
            assert.ok(fProfile.compose.capabilities.includes(r.name));
            assert.ok(fProfile.compose.capabilitiesOptions[r.name]);
        }
    }
    assert.equal(fProfile.alarm?.series, 'f');
    assert.equal(fProfile.estimatedEnergy, true);
    assert.equal(fProfile.role.powerSources.length, 2);
});

test('F register formats follow the exports, including different factors from S', () => {
    assert.equal(toNumericValue(at(40004), 0xff9c), -10);
    assert.equal(at(43005).size, 16);
    assert.equal(toNumericValue(at(43005), 0xff9c), -10);
    assert.equal(toNumericValue(at(43136), 425), 42.5);
    assert.equal(toNumericValue(at(43084), 150), 1500, '1.5 kW displayed in watts');
    assert.equal(at(40079).size, 32);
    assert.equal(toNumericValue(at(42075), 0x90000000), 241591910.4, 'unsigned counters stay positive');
    assert.equal(toNumericValue(at(40004), 0x8000), undefined);
});

test('one F table reads full MODBUS 40 ids or translated gateway ids', async () => {
    const reads: number[][] = [];
    const client: any = {
        readHoldingRegisters: async (address: number, count: number) => {
            reads.push([address, count]);
            return {response: {body: {values: [213]}}};
        },
        readInputRegisters: () => { throw new Error('F sensor incorrectly read as input'); }
    };
    assert.equal(await readNumeric(client, at(40004), fProfile), 21.3);
    assert.equal(await readNumeric(client, at(40004), {...fProfile, addressBase: fProfile.addressModes!.nibegw.addressBase}), 21.3);
    assert.deepEqual(reads, [[40004, 1], [3, 1]]);
});

test('absent accessories returning zero do not recommend pool, cooling or solar', () => {
    const samples = Object.fromEntries(fProfile.registers.map((r) =>
        [r.name, {reads: 3, moved: false, last: 0}]));
    let recs = recommendGroups(fProfile, samples);
    for (const id of ['pool', 'cooling', 'solar'] as const) assert.equal(recs[id]?.recommended, false);
    samples[at(40042).name].last = 24;
    samples[at(43024).name].last = 1;
    samples[at(42075).name].last = 150;
    recs = recommendGroups(fProfile, samples);
    for (const id of ['pool', 'cooling', 'solar'] as const) assert.equal(recs[id]?.recommended, true);
});

test('drivers share pairing views and use disjoint Flow ids', () => {
    for (const view of ['pair/ip_address.html', 'pair/detect.html', 'pair/devices.html',
                        'repair/detect.html', 'repair/features.html']) {
        assert.equal(fs.readFileSync(`drivers/nibe_f/${view}`, 'utf8'),
            fs.readFileSync(`drivers/nibe_s/${view}`, 'utf8'));
    }
    const sIds = new Set([...sProfile.compose.actions, ...sProfile.compose.conditions,
        ...sProfile.compose.triggers].map((card) => card.id));
    for (const card of [...fProfile.compose.conditions, ...fProfile.compose.triggers])
        assert.equal(sIds.has(fProfile.flowPrefix + card.id), false);
});

test('diagnostics preserve raw words and errors and cap repeated capture', async () => {
    const c: any = Object.create(PumpConnection.prototype);
    const logs: string[] = [];
    Object.assign(c, {
        profile: fProfile, transport: {port: 502, unitId: 1, addressBase: fProfile.addressModes!.nibegw.addressBase}, generation: 1,
        readDiagnostics: new Map(), captureCounts: new Map(), captureUntil: Date.now() + 60000,
        captureRemaining: 200, debugOn: true, unsupportedUntil: new Map(), knownAbsent: new Set(),
        noteRead: () => {}, log: (s: string) => logs.push(s), withWireAccess: (run: any) => run(),
        client: {readHoldingRegisters: async () => ({response: {body: {values: [0xff9c]}}})}
    });
    for (let i = 0; i < 5; i++) assert.equal(await c.readRegisterRaw(at(40004)), 0xff9c);
    assert.equal(logs.length, 3);
    assert.match(logs[0], /FC3 address=3 count=1 words=\[0xff9c\]/);
    assert.match(logs[0], /received=.*request=\d+ms queue=\d+ms/);
    c.client.readHoldingRegisters = async () => { throw {body: {code: 2}}; };
    assert.equal(await c.readRegisterRaw(at(40004), false), undefined);
    assert.match(c.describeLastRead(at(40004).name), /Modbus exception 2/);
    c.client.readHoldingRegisters = async () => ({response: {body: {values: [42]}}});
    assert.equal(await c.readRegisterRaw(at(40079), false), undefined);
    assert.match(c.describeLastRead(at(40079).name), /Short response: expected 2 words, got 1/);
});

test('captured F730 unavailable solar value does not recommend Solar, real production still does', async () => {
    const solar = at(42075);
    const client: any = {readHoldingRegisters: async () => ({response: {body: {values: [0x8000, 0xffff]}}})};
    assert.equal(await readNumeric(client, solar, fProfile), undefined);
    const present = (raw: number) => fProfile.detection.plausible.solar!({
        value: (name: string) => name === solar.name ? toNumericValue(solar, raw) : 0
    } as any);
    assert.equal(present(0xffff8000), false);
    assert.equal(present(0), false);
    assert.equal(present(12345), true);
    // The extra encoding is local to the solar register, not a global 32-bit rule.
    assert.equal(toNumericValue({...solar, unavailableRaw: undefined}, 0xffff8000), 429493452.8);
});

test('EP14 diagnostic aliases stay internal; selected production sources retain canonical capability names', async () => {
    const c: any = Object.create(PumpConnection.prototype);
    Object.assign(c, {profile: fProfile, debugOn: false, subscribers: new Set(), powerRegisters: []});
    const union = c.unionRegisters();
    const reads: number[][] = [];
    const client: any = {readHoldingRegisters: async (...args: number[]) => {
        reads.push(args); return {response: {body: {values: [3525, 0]}}};
    }};
    for (const address of [44298, 44300]) {
        const r = at(address);
        assert.equal(r.internal, true);
        assert.equal(r.noAction, true);
        assert.ok(union.includes(r));
        assert.ok(fProfile.diagnosticTrace!.includes(r.name));
        assert.equal(fProfile.compose.capabilities.includes(r.name), false);
        assert.equal(frequentRegisterNames(fProfile).has(r.name), false);
        assert.equal(await readNumeric(client, r, {...fProfile, addressBase: 40001}), 352.5);
    }
    assert.deepEqual(reads, [[4297, 2], [4299, 2]]);
    assert.equal(fProfile.role.producedRegisterForRole.hotwater, at(42437).name);
    assert.equal(fProfile.role.producedRegisterForRole.heating, at(42439).name);
    assert.deepEqual(fProfile.role.powerSources, [[at(43375).name, at(43084).name],
        [at(43141).name, at(43084).name]]);
});

test('bounded diagnostic probes follow normal publication and never enter allocation or cached device values', async () => {
    const c: any = Object.create(PumpConnection.prototype);
    const events: string[] = [];
    const probe = fProfile.diagnosticSweep!.energy.find((r) => r.address === 44306)!;
    let jobs = 0;
    const capture = {next: () => (++jobs <= 2 ? {register: probe} : undefined),
        complete: () => events.push('diagnostic logged')};
    Object.assign(c, {profile: fProfile, connected: true, polling: false, generation: 1, debugOn: true,
        diagnosticCapture: capture, readDiagnostics: new Map(),
        pollDeadlineMs: 1000, priorityRegister: at(43086), powerRegisters: [at(43375), at(43084)],
        unsupportedUntil: new Map(), knownAbsent: new Set(), backgroundAttempted: new Map(), lastRaw: new Map(),
        unionRegisters: () => [at(43086), at(43375), at(43084)],
        readRegisterRaw: async (r: any, track = true) => {
            if (r === probe) { assert.equal(track, false); events.push('probe'); }
            return 1;
        },
        subscribers: [{wantedRegisters: () => [], onPollComplete: () => events.push('published')}],
        applyEnergyLogPriorityOverride: () => {}, reportReadFailures: () => {}, reportEnergyLogSteps: () => {},
        traceSnapshot: () => {}, allocateEnergy: (raw: Map<string, number>) => {
            assert.equal(raw.has(probe.name), false); events.push('allocated');
        }, log: assert.fail});
    c.poll();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['allocated', 'published', 'probe', 'diagnostic logged', 'probe', 'diagnostic logged']);
    assert.equal(c.lastRaw.has(probe.name), false);
    assert.equal(jobs, 2);
    c.debugOn = false;
    events.length = 0;
    c.poll();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['allocated', 'published']);
});

test('F production discovery uses documented combined sources and keeps manual selection', async () => {
    const {buildDetectionResult} = await import('../lib/detection');
    const {registersForRole} = await import('../lib/roles');
    const produced = at(42439);
    const profile = {...fProfile, registers: [produced, at(43375), at(43084)],
        detection: {...fProfile.detection, requestIntervalMs: 0}};
    for (const alternate of [undefined, 0, 26660.4]) {
        const values = new Map<number, number | undefined>([[42439, 0], [44300, alternate],
            [43375, 1400], [43084, 0]]);
        const result = await sampleRegisters(profile, async (r) => values.get(r.address), () => {}, undefined, 0);
        const detected = buildDetectionResult(profile, result.probes, result.addresses, result.choices);
        assert.equal(detected.samples[produced.name].read, !!alternate);
        assert.equal(extraCapabilitySupport(profile, 'heating',
            (name) => detected.samples[name])[FUNCTION_COP_CAPABILITY], !!alternate);
        if (alternate) {
            assert.equal(result.addresses[produced.name], 44300);
            assert.equal(detected.samples[produced.name].value, alternate);
        }
        const selection = {groups: {heating: true, energy: true},
            overrides: {[produced.name]: true, [FUNCTION_COP_CAPABILITY]: true},
            addresses: result.addresses};
        assert.ok(registersForRole(fProfile, 'heating', selection).some((r) =>
            r.name === produced.name && r.address === (alternate ? 44300 : 42439)));
        assert.ok(extraCapabilities(fProfile, 'heating', selection).includes(FUNCTION_COP_CAPABILITY));
    }
    assert.deepEqual(at(42437).sources?.map((s) => s.address), [42437, 44298]);
    assert.deepEqual(produced.sources?.map((s) => s.address), [42439, 44300]);
});

test('F added temperatures decode signed tenths; zero fan is not recommended but still a valid reading', async () => {
    const {buildDetectionResult} = await import('../lib/detection');
    for (const address of [40017, 40020]) assert.equal(toNumericValue(at(address), 0xff9c), -10);
    const fan = at(43108);
    assert.equal(toNumericValue(fan, 0), 0);
    assert.equal(buildDetectionResult({...fProfile, registers: [fan]}, {[fan.name]: {reads: 2, moved: false, last: 0}})
        .samples[fan.name].read, false);
    assert.equal(buildDetectionResult({...fProfile, registers: [fan]}, {[fan.name]: {reads: 2, moved: false, last: 85}})
        .samples[fan.name].read, true);
});
