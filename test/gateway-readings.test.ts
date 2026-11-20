import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Gateway, useGatewayForTests} from '../lib/gateway';
import {READING_MAX_AGE_MS, forgetReadings, selectedReadings} from '../lib/indoor-sensors';

function setup(answer: (id: string) => any) {
    forgetReadings();
    const reads: string[] = [];
    const api = {devices: {getDevice: async ({id}: any) => { reads.push(id); return answer(id); }}};
    useGatewayForTests(new Gateway({createClient: async () => api, now: () => Date.now(), sleep: async () => undefined, log: () => undefined}));
    return reads;
}
const sensor = (id: string, value: number) => ({id, name: id, zone: 'z', class: 'sensor', driverId: 'homey:app:x:y', available: true,
    capabilitiesObj: {measure_temperature: {value, lastUpdated: new Date().toISOString()}}});
const ref = (deviceId: string) => ({deviceId, capabilityId: 'measure_temperature'});

test('a sensor two features read is fetched once while it is fresh, then again', async () => {
    const reads = setup((id) => sensor(id, 21.5));
    const t0 = Date.now();
    const [a, b] = await Promise.all([selectedReadings({}, [ref('hall')], t0), selectedReadings({}, [ref('hall')], t0)]);
    await selectedReadings({}, [ref('hall')], t0 + READING_MAX_AGE_MS - 1);
    assert.deepEqual(reads, ['hall'], 'the indoor read and the BT50 feed share one fetch');
    assert.equal(a[0].value, 21.5);
    assert.equal(b[0].value, 21.5);
    await selectedReadings({}, [ref('hall')], t0 + READING_MAX_AGE_MS + 60_000);
    assert.deepEqual(reads, ['hall', 'hall']);
    useGatewayForTests(undefined);
});

test('a deleted sensor is left out; any other failure is thrown and not kept', async () => {
    let fail = true;
    const reads = setup((id) => {
        if (id === 'gone') throw Object.assign(new Error('Not Found'), {statusCode: 404});
        if (fail) throw new Error('timed out');
        return sensor(id, 20);
    });
    assert.deepEqual(await selectedReadings({}, [ref('gone')]), []);
    await assert.rejects(selectedReadings({}, [ref('hall')]));
    fail = false;
    assert.equal((await selectedReadings({}, [ref('hall')]))[0].value, 20, 'tried again at once after a failure');
    assert.equal(reads.filter((r) => r === 'hall').length, 2);
    useGatewayForTests(undefined);
});

test('solar samples often enough to ever count live surplus', async () => {
    const {LIVE_SAMPLE_MS} = await import('../lib/autopilot/solar-surplus');
    const {LIVE_WINDOW, LIVE_MIN_READINGS} = await import('../lib/autopilot/hotwater-surplus');
    assert.ok(LIVE_WINDOW * 60_000 / LIVE_SAMPLE_MS >= LIVE_MIN_READINGS);
});
