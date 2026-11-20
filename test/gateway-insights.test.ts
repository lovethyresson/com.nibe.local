import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DISK_BUDGET_BYTES, LogStore, UNUSED_MS} from '../lib/gateway-insights';
import {Gateway} from '../lib/gateway';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Homey's answer for a meter log: hourly points ending at the last whole hour before `now`. */
function hourly(now: number, hours: number, updatesIn = 20 * 60_000) {
    const last = Math.floor(now / HOUR) * HOUR - HOUR;
    return {step: HOUR, updatesIn, values: Array.from({length: hours}, (_, k) => ({t: new Date(last - (hours - 1 - k) * HOUR).toISOString(), v: last - (hours - 1 - k) * HOUR}))};
}

function harness() {
    let now = Date.parse('2026-11-20T12:30:00Z');
    const disk = new Map<string, string>();
    const fetched: string[] = [];
    const deps = {
        now: () => now,
        load: async (name: string) => (disk.has(name) ? JSON.parse(disk.get(name)!) : undefined),
        save: async (name: string, value: unknown) => { disk.set(name, JSON.stringify(value)); },
        remove: async (name: string) => { disk.delete(name); },
        log: () => undefined,
    };
    const fetch = async (args: any) => {
        fetched.push(args.resolution);
        return hourly(now, args.resolution === 'last7Days' ? 168 : 336);
    };
    const args = {uri: 'homey:device:x', id: 'homey:device:x:meter_power.total', resolution: 'last14Days'};
    return {deps, disk, fetched, fetch, args, store: new LogStore(deps), advance: (ms: number) => { now += ms; }, now: () => now};
}

test('until Homey has a newer point, the stored log is the answer, for every consumer', async () => {
    const h = harness();
    const a = await h.store.entries(h.args, h.fetch);
    const b = await h.store.entries(h.args, h.fetch);
    h.advance(10 * 60_000);
    const c = await h.store.entries(h.args, h.fetch);
    assert.deepEqual(h.fetched, ['last14Days']);
    assert.equal(a.values.length, 336);
    assert.deepEqual(b.values, a.values);
    assert.equal(c.step, HOUR);
});

test('after a restart the log comes from disk, and only the gap is fetched once it is due', async () => {
    const h = harness();
    await h.store.entries(h.args, h.fetch);
    const restarted = new LogStore(h.deps);
    await restarted.entries(h.args, h.fetch);
    assert.deepEqual(h.fetched, ['last14Days'], 'a restart within the hour fetches nothing');
    h.advance(HOUR);
    const log = await restarted.entries(h.args, h.fetch);
    assert.deepEqual(h.fetched, ['last14Days', 'last7Days'], 'the 7-day window, not 14 days');
    assert.equal(log.values.length, 336, 'merged and trimmed back to 14 days of hours');
    assert.equal(log.values.at(-1).t, hourly(h.now(), 1).values[0].t, 'ends at the newest hour');
});

test('a log too old for the 7-day window is fetched whole', async () => {
    const h = harness();
    await h.store.entries(h.args, h.fetch);
    h.advance(8 * DAY);
    await h.store.entries(h.args, h.fetch);
    assert.deepEqual(h.fetched, ['last14Days', 'last14Days']);
});

test('disk: a log nobody asked for in 7 days is deleted; the total stays under the budget', async () => {
    const h = harness();
    await h.store.entries(h.args, h.fetch);
    const other = {...h.args, id: 'homey:device:x:other'};
    h.advance(UNUSED_MS + DAY);
    await h.store.entries(other, h.fetch);
    const index = JSON.parse(h.disk.get('insights-index.json')!);
    assert.deepEqual(Object.keys(index), [`${other.id}|last14Days`]);
    assert.equal([...h.disk.keys()].filter((k) => k.startsWith('insights-') && k !== 'insights-index.json').length, 1);
    assert.ok(h.store.diskBytes() < DISK_BUDGET_BYTES);
});

test('through the Gateway: Insights reads are served by the store and counted', async () => {
    const h = harness();
    let calls = 0;
    const api = {insights: {getLogEntries: async (args: any) => { calls++; return hourly(h.now(), args.resolution === 'last7Days' ? 168 : 336); }}};
    const gateway = new Gateway({createClient: async () => api, now: h.now, sleep: async () => undefined, log: () => undefined});
    gateway.logs = new LogStore(h.deps);
    await gateway.call((a) => a.insights.getLogEntries(h.args));
    await gateway.call((a) => a.insights.getLogEntries(h.args));
    assert.equal(calls, 1);
    assert.match(gateway.report(), /1 from store \/ 1 fetched/);
});

test('an owner never shares a request already made for background work', async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const slow = async (args: any) => { calls++; if (calls === 1) await gate; return hourly(h.now(), 336); };
    const background = h.store.entries(h.args, slow, 3);
    const owner = h.store.entries(h.args, slow, 1);
    await owner;
    assert.equal(calls, 2, 'the owner made its own request');
    release();
    await background;
});
