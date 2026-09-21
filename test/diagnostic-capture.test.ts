import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DiagnosticCapture} from '../lib/diagnostic-capture';
import {fProfile} from '../drivers/nibe_f/profile';
import {toNumericValue} from '../lib/registers';

const r = fProfile.registers.find((r) => r.address === 43141)!;
const sample = (now: number, words = [57], error?: string) => ({receivedAt: new Date(now).toISOString(),
    address: 3140, functionCode: 3 as const, count: 1, words, error, durationMs: 10, queueMs: 0});

test('F compressor units are 10 watts per raw unit for both inputs', () => {
    for (const address of [43141, 43375])
        assert.equal(toNumericValue(fProfile.registers.find((r) => r.address === address)!, 57), 570);
});

test('sweep deduplicates addresses, excludes commands, records two passes then stops', () => {
    const logs: string[] = [];
    const c = new DiagnosticCapture({registers: [r, {...r, name: 'duplicate'}, {...r, address: 60000, writeOnly: true}], energy: []}, (s) => logs.push(s), 0);
    for (let i = 0; i < 2; i++) {
        const job = c.next(100)!;
        assert.equal(job.pass, i + 1);
        c.complete(job, sample(110), 110);
    }
    assert.equal(c.next(200), undefined);
    assert.ok(logs.some((l) => l.includes('sweeps complete')));
    assert.ok(logs.some((l) => l.includes('decoded=570')));
    c.stop('debug disabled');
    assert.equal(c.next(300), undefined);
});

test('energy capture throttles repeated reads but preserves errors and successful delta baseline', () => {
    const logs: string[] = [];
    const c = new DiagnosticCapture({registers: [], energy: [r]}, (s) => logs.push(s), 0);
    c.observe(r, sample(0), 0);
    c.observe(r, sample(1000), 1000);
    assert.equal(logs.filter((l) => l.startsWith('F energy sample')).length, 1);
    c.observe(r, sample(60_000, [], 'timeout'), 60_000);
    c.observe(r, sample(120_000, [60]), 120_000);
    assert.ok(logs.some((l) => l.includes('error=timeout') && l.includes('decoded=unavailable')));
    assert.ok(logs.some((l) => l.includes('delta=30')));
    assert.equal(c.next(2 * 3600_000), undefined);
    c.observe(r, sample(2 * 3600_000), 2 * 3600_000);
    assert.ok(logs.at(-1)!.includes('two-hour limit'));
});

test('reconnect cannot label an old reply as a new sweep observation', () => {
    const logs: string[] = [];
    const c = new DiagnosticCapture({registers: [r], energy: []}, (s) => logs.push(s), 0);
    c.complete(c.next(1000)!, sample(999), 1001);
    assert.ok(logs.at(-1)!.includes('no new reply'));
    assert.ok(!logs.some((l) => l.includes('decoded=')));
});

test('all eight production candidates are diagnostic inputs without selecting new COP sources', () => {
    for (const address of [42437, 42439, 42445, 42447, 44298, 44300, 44306, 44308])
        assert.ok(fProfile.diagnosticSweep!.energy.some((r) => r.address === address && r.size === 32 && r.scale === 10));
    assert.equal(fProfile.role.producedRegisterForRole.hotwater, 'meter_kwh_NIBE.h42437_hotwater_produced');
});
