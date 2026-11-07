import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LOCATION_SETTING, OUTDOOR_SENSOR_SETTING, carryRenamedSettings} from '../lib/autopilot/collector';

const store = (init: Record<string, unknown>) => {
    const m = new Map(Object.entries(init));
    return {m, get: (k: string) => m.get(k), set: (k: string, v: unknown) => { m.set(k, v); }, unset: (k: string) => { m.delete(k); }};
};

test('settings named before Autopilot are carried over once, never over a newer value', () => {
    const sensor = {deviceId: 'a', capabilityId: 'measure_temperature'};
    const s = store({smartOutdoorSensor: sensor});
    carryRenamedSettings(s);
    assert.deepEqual(s.m.get(OUTDOOR_SENSOR_SETTING), sensor);
    assert.equal(s.m.has('smartOutdoorSensor'), false);
    // Already moved: a later start changes nothing.
    carryRenamedSettings(s);
    assert.deepEqual(s.m.get(OUTDOOR_SENSOR_SETTING), sensor);
    // A value set under the new name wins; the old one is dropped.
    const newer = store({smartLocation: {name: 'old'}, [LOCATION_SETTING]: {name: 'new'}});
    carryRenamedSettings(newer);
    assert.deepEqual(newer.m.get(LOCATION_SETTING), {name: 'new'});
    assert.equal(newer.m.has('smartLocation'), false);
});
