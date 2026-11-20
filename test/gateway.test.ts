import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BACKOFF_MS, Gateway, INSIGHTS_GAP_MS, PRIORITY, QUIET_START_MS, connectionLost, tooMany} from '../lib/gateway';

/** A Gateway on a fake clock: sleep advances time instead of waiting. */
function harness(api: any) {
    let now = 1_000_000;
    let clients = 0;
    const slept: number[] = [];
    const logs: string[] = [];
    const gateway = new Gateway({
        createClient: async () => { clients++; return api; },
        now: () => now,
        sleep: async (ms) => { slept.push(ms); now += ms; },
        log: (...a) => logs.push(a.join(' ')),
        memory: () => 90e6,
    });
    return {gateway, slept, logs, clients: () => clients, advance: (ms: number) => { now += ms; }, now: () => now};
}

test('every manager call is counted per resource, and one client serves them all', async () => {
    const api = {devices: {getDevice: async ({id}: any) => ({id})}, energy: {getCurrency: async () => 'SEK'}};
    const h = harness(api);
    await h.gateway.call(async (a) => { await a.devices.getDevice({id: 'x'}); await a.devices.getDevice({id: 'y'}); });
    assert.equal(await h.gateway.call((a) => a.energy.getCurrency()), 'SEK');
    assert.equal(h.clients(), 1);
    const line = h.gateway.report();
    assert.match(line, /3 Homey requests/);
    assert.match(line, /devices\.getDevice 2, energy\.getCurrency 1/);
    assert.match(line, /memory 90 MB/);
    assert.match(h.gateway.report(), /0 Homey requests/, 'counts start over after a report');
});

test('Insights requests run one at a time, two seconds apart, whoever asks', async () => {
    const starts: number[] = [];
    let h: ReturnType<typeof harness>;
    const api = {insights: {getLogEntries: async () => { starts.push(h.now()); return {values: []}; }}};
    h = harness(api);
    await Promise.all([1, 2, 3].map(() => h.gateway.call((a) => a.insights.getLogEntries({}))));
    assert.deepEqual(starts.map((t) => t - starts[0]), [0, INSIGHTS_GAP_MS, 2 * INSIGHTS_GAP_MS]);
});

test('"too many requests" pauses every request, longer each time in a row, and a success resets it', async () => {
    let fail = true;
    const api = {energy: {getCurrency: async () => {
        if (fail) throw Object.assign(new Error('Too many requests'), {statusCode: 429});
        return 'SEK';
    }}};
    const h = harness(api);
    await assert.rejects(h.gateway.call((a) => a.energy.getCurrency()));
    await assert.rejects(h.gateway.call((a) => a.energy.getCurrency()));
    assert.deepEqual(h.slept, [BACKOFF_MS[0]], 'the second request waited out the first pause');
    fail = false;
    await h.gateway.call((a) => a.energy.getCurrency());
    assert.deepEqual(h.slept, [BACKOFF_MS[0], BACKOFF_MS[1]], 'two in a row: the longer pause');
    await h.gateway.call((a) => a.energy.getCurrency());
    assert.equal(h.slept.length, 2, 'after a success nothing waits');
    assert.ok(h.logs.some((l) => /too many requests/.test(l)));
});

test('a failed request keeps the client; a lost connection gets a new one', async () => {
    let lost = false;
    const api = {devices: {getDevice: async () => {
        throw lost ? new Error('socket hang up') : Object.assign(new Error('Not Found'), {statusCode: 404});
    }}};
    const h = harness(api);
    await assert.rejects(h.gateway.call((a) => a.devices.getDevice({id: 'gone'})));
    await assert.rejects(h.gateway.call((a) => a.devices.getDevice({id: 'gone'})));
    assert.equal(h.clients(), 1, 'a sensor that is gone does not rebuild the client');
    lost = true;
    await assert.rejects(h.gateway.call((a) => a.devices.getDevice({id: 'x'})));
    await assert.rejects(h.gateway.call((a) => a.devices.getDevice({id: 'x'})));
    assert.equal(h.clients(), 2);
    assert.match(h.gateway.report(), /client resets/);
});

test('background work waits for the quiet start; control and owner requests do not', async () => {
    const api = {energy: {getCurrency: async () => 'SEK'}};
    const h = harness(api);
    await h.gateway.call((a) => a.energy.getCurrency(), PRIORITY.owner);
    await h.gateway.call((a) => a.energy.getCurrency(), PRIORITY.control);
    assert.equal(h.slept.length, 0);
    h.advance(60_000);
    await h.gateway.call((a) => a.energy.getCurrency(), PRIORITY.background);
    assert.deepEqual(h.slept, [QUIET_START_MS - 60_000]);
    await h.gateway.call((a) => a.energy.getCurrency(), PRIORITY.background);
    assert.equal(h.slept.length, 1, 'after the quiet start it runs at once');
});

test('what counts as too many and as a lost connection', () => {
    assert.ok(tooMany({statusCode: 429}) && tooMany(new Error('Too many requests')));
    assert.ok(!tooMany(new Error('Not Found')));
    assert.ok(connectionLost(new Error('connect ECONNREFUSED')) && connectionLost({statusCode: 401}));
    assert.ok(!connectionLost(Object.assign(new Error('Not Found'), {statusCode: 404})));
});
