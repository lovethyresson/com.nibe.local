import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BACKOFF_MS, Gateway, LANE_GAP_MS, PRIORITY, QUIET_START_MS, connectionLost, tooMany} from '../lib/gateway';

/** A real homey-api V3 local client (its managers, items and locked methods), with the network
 *  replaced by `answer`: nothing is sent anywhere. */
function realClient(answer: (method: string, path: string) => any) {
    const V3 = require('homey-api/lib/HomeyAPI/HomeyAPIV3Local');
    const api = new V3({properties: {id: 'x', localUrl: 'http://127.0.0.1:1', token: 't'}, strategy: [], baseUrl: 'http://127.0.0.1:1'});
    api.call = async ({method, path}: any) => answer(method, path);
    return api;
}

/** A Gateway on a fake clock: sleep advances time instead of waiting. */
function harness(api: any, opts: {sleepThrowsOnce?: boolean} = {}) {
    let now = 1_000_000;
    let clients = 0;
    let throwNext = !!opts.sleepThrowsOnce;
    const slept: number[] = [];
    const logs: string[] = [];
    const gateway = new Gateway({
        createClient: async () => { clients++; return api; },
        now: () => now,
        sleep: async (ms) => {
            if (throwNext) { throwNext = false; throw new Error('timer gone'); }
            slept.push(ms); now += ms;
        },
        log: (...a) => logs.push(a.join(' ')),
        memory: () => 90e6,
    });
    return {gateway, slept, logs, clients: () => clients, advance: (ms: number) => { now += ms; }, now: () => now};
}

const refused = () => Object.assign(new Error('Too many requests'), {statusCode: 429});

test('real homey-api: locked manager methods go through, items come back whole, calls are counted', async () => {
    const api = realClient((method, path) => (path.includes('/device/') ? {id: 'd1', name: 'Hall', capabilitiesObj: {}} : 'SEK'));
    const desc = Object.getOwnPropertyDescriptor(api.devices, 'getDevice') ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(api.devices), 'getDevice');
    assert.equal(desc?.configurable, false, 'the case that broke the 12:36 install');
    const h = harness(api);
    const device: any = await h.gateway.call((a) => a.devices.getDevice({id: 'd1', $cache: false}));
    assert.equal(device.name, 'Hall');
    assert.equal(await h.gateway.call((a) => a.energy.getCurrency()), 'SEK');
    assert.equal(h.clients(), 1);
    assert.match(h.gateway.report(), /2 Homey requests.*devices\.getDevice 1, energy\.getCurrency 1/);
    assert.match(h.gateway.report(), /0 Homey requests/, 'counts start over after a report');
});

test('a family Homey refuses back to back goes one at a time, the gap apart', async () => {
    const starts: number[] = [];
    let h: ReturnType<typeof harness>;
    const api = realClient(() => { starts.push(h.now()); return {values: []}; });
    h = harness(api);
    await Promise.all([1, 2, 3].map(() => h.gateway.call((a) => a.insights.getLogEntries({uri: 'homey:device:x', id: 'homey:device:x:m'}))));
    assert.deepEqual(starts.map((t) => t - starts[0]), [0, LANE_GAP_MS.insights, 2 * LANE_GAP_MS.insights]);
});

test('the lane serves an owner before background work that asked earlier', async () => {
    const served: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const api = {insights: {getLogEntries: async ({id}: any) => { served.push(id); if (id === 'first') await gate; return {}; }}};
    const h = harness(api);
    h.advance(QUIET_START_MS);
    const first = h.gateway.call((a) => a.insights.getLogEntries({id: 'first'}), PRIORITY.background);
    await new Promise((r) => setImmediate(r));
    const bg = h.gateway.call((a) => a.insights.getLogEntries({id: 'background'}), PRIORITY.background);
    const owner = h.gateway.call((a) => a.insights.getLogEntries({id: 'owner'}), PRIORITY.owner);
    await new Promise((r) => setImmediate(r));
    release();
    await Promise.all([first, bg, owner]);
    assert.deepEqual(served, ['first', 'owner', 'background']);
});

test('"too many" pauses only that family; queued requests wait it out; a success ends it', async () => {
    let refuse = 1;
    const api = {
        insights: {getLogEntries: async () => { if (refuse-- > 0) throw refused(); return {}; }},
        devices: {getDevice: async () => ({id: 'sensor'})},
    };
    const h = harness(api);
    const a = h.gateway.call((x) => x.insights.getLogEntries({}));
    const b = h.gateway.call((x) => x.insights.getLogEntries({}));
    await assert.rejects(a);
    await b;
    assert.ok(h.slept.includes(BACKOFF_MS[0]), 'the queued request waited out the pause after its turn');
    const before = h.slept.length;
    await h.gateway.call((x) => x.devices.getDevice({id: 'sensor'}));
    assert.equal(h.slept.length, before, 'a sensor read (the BT50 feed) is never held by an Insights pause');
    assert.ok(h.logs.some((l) => /pausing insights 20 s/.test(l)));
});

test('refusals in a row pause longer; several at once count as one; a success ends it', async () => {
    let refuse = true;
    const api = {devices: {getDevice: async () => { if (refuse) throw refused(); return {id: 'd'}; }}};
    const h = harness(api);
    await Promise.allSettled([1, 2, 3].map(() => h.gateway.call((a) => a.devices.getDevice({id: 'd'}))));
    assert.equal(h.logs.length, 1, 'three requests refused together: one pause');
    assert.match(h.logs[0], /20 s/);
    await assert.rejects(h.gateway.call((a) => a.devices.getDevice({id: 'd'})));
    assert.equal(h.slept.at(-1), BACKOFF_MS[0], 'the next request waited out the pause');
    assert.match(h.logs.at(-1)!, /60 s/, 'refused again after the pause: 1 min');
    refuse = false;
    await h.gateway.call((a) => a.devices.getDevice({id: 'd'}));
    const n = h.slept.length;
    await h.gateway.call((a) => a.devices.getDevice({id: 'd'}));
    assert.equal(h.slept.length, n, 'after a success nothing waits');
});

test('a timer that fails while a request waits its gap does not lock the lane', async () => {
    const api = {insights: {getLogEntries: async () => ({})}};
    const h = harness(api, {sleepThrowsOnce: false});
    await h.gateway.call((a) => a.insights.getLogEntries({}));
    const broken = harness(api, {sleepThrowsOnce: true});
    await broken.gateway.call((a) => a.insights.getLogEntries({})).catch(() => undefined);
    await broken.gateway.call((a) => a.insights.getLogEntries({})).catch(() => undefined);
    const done = await Promise.race([broken.gateway.call((a) => a.insights.getLogEntries({})).then(() => 'served'),
        new Promise((r) => setTimeout(() => r('locked'), 200))]);
    assert.equal(done, 'served');
});

test('a failed request keeps the client; a lost connection gets a new one, once', async () => {
    let lost = false;
    const api = {devices: {getDevice: async () => {
        throw lost ? new Error('socket hang up') : Object.assign(new Error('Not Found'), {statusCode: 404});
    }}};
    const h = harness(api);
    await assert.rejects(h.gateway.call((a) => a.devices.getDevice({id: 'gone'})));
    await assert.rejects(h.gateway.call((a) => a.devices.getDevice({id: 'gone'})));
    assert.equal(h.clients(), 1, 'a sensor that is gone does not rebuild the client');
    lost = true;
    await Promise.allSettled([1, 2].map(() => h.gateway.call((a) => a.devices.getDevice({id: 'x'}))));
    assert.match(h.gateway.report(), /1 client resets/, 'two failures on one client: one reset');
    await assert.rejects(h.gateway.call((a) => a.devices.getDevice({id: 'x'})));
    assert.equal(h.clients(), 2);
});

test('background work waits for the quiet start; control and owner requests do not', async () => {
    const api = {energy: {getCurrency: async () => 'SEK'}};
    const h = harness(api);
    await h.gateway.call((a) => a.energy.getCurrency(), PRIORITY.owner);
    h.advance(LANE_GAP_MS.energy);
    await h.gateway.call((a) => a.energy.getCurrency(), PRIORITY.control);
    assert.equal(h.slept.length, 0);
    h.advance(60_000);
    await h.gateway.call((a) => a.energy.getCurrency(), PRIORITY.background);
    assert.deepEqual(h.slept, [QUIET_START_MS - 60_000 - LANE_GAP_MS.energy]);
});

test('what counts as too many and as a lost connection', () => {
    assert.ok(tooMany({statusCode: 429}) && tooMany(new Error('Too many requests')));
    assert.ok(!tooMany(new Error('Not Found')));
    assert.ok(connectionLost(new Error('connect ECONNREFUSED')) && connectionLost({statusCode: 401}));
    assert.ok(connectionLost(Object.assign(new Error('fetch failed'), {cause: {code: 'ECONNRESET'}})));
    assert.ok(!connectionLost(Object.assign(new Error('Not Found'), {statusCode: 404})));
});
