import {test} from 'node:test';
import assert from 'node:assert/strict';
import {averageSensors, cleanIndoorConfig, sensorInventory, SensorReading} from '../lib/indoor-sensors';
const now = Date.now();
const reading = (id: string, value: number): SensorReading => ({deviceId: id,
    capabilityId: 'measure_temperature', name: id, room: 'Home', zoneId: 'home', type: 'sensor',
    app: 'test', value, updatedAt: now, available: true});
const readings = [reading('floor1', 20), reading('floor2', 22), reading('floor3', 24)];
const config = cleanIndoorConfig({sensors: readings, state: 'active'});
test('selection is whitelisted, pending, unique and requires all selected floors', () => {
    assert.equal(config.state, 'pending');
    assert.deepEqual(Object.keys(config.sensors[0]), ['deviceId', 'capabilityId']);
    assert.equal(averageSensors(config, readings, now), 22);
    assert.throws(() => averageSensors(config, readings.slice(1), now), /missing/);
    assert.throws(() => cleanIndoorConfig({sensors: [readings[0], readings[0]]}), /once/);
    assert.throws(() => cleanIndoorConfig({sensors: []}), /Choose/);
});
test('cached reads do not renew observation age; every source must be usable', () => {
    assert.throws(() => averageSensors(config, readings, now + 121 * 60000), /recent/);
    for (const invalid of [{value: NaN}, {value: null}, {value: 3276.8}, {available: false}, {value: -1}])
        assert.throws(() => averageSensors(config, [{...readings[0], ...invalid}, ...readings.slice(1)], now));
    assert.throws(() => averageSensors(config, [{...readings[0], updatedAt: null}, ...readings.slice(1)], now));
    assert.throws(() => cleanIndoorConfig({sensors: readings, maxAgeMinutes: 0}));
});
test('inventory respects room hierarchy and saved order, rejects feedback and unknown units', () => {
    const zones = {root: {id: 'root', name: 'Home', parent: null},
        z: {id: 'z', name: 'Z upstairs', parent: 'root', sortIndex: 1},
        a: {id: 'a', name: 'A basement', parent: 'root', sortIndex: 2},
        child: {id: 'child', name: 'Bedroom', parent: 'z'}};
    const device = (id: string, zone: string, driverId = 'homey:app:com.test:sensor', units = '°C') => ({
        id, zone, name: id, available: true, driverId, capabilitiesObj: {
            measure_temperature: {value: 22, units, lastUpdated: new Date(now)},
            custom_temperature: {value: 23}, target_temperature: {value: 24}
        }
    });
    const list = sensorInventory({a: device('a', 'a'), z: device('z', 'z'), c: device('c', 'child'),
        own: device('own', 'z', 'homey:app:com.nibe.local:heating'), f: device('f', 'z', 'other', '°F')}, zones);
    assert.deepEqual(list.map(s => s.deviceId), ['z', 'c', 'a']);
    assert.equal(list[1].room, 'Home / Z upstairs / Bedroom');
    assert.equal(list[0].updatedAt, now);
});
