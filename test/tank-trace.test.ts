import {test} from 'node:test';
import assert from 'node:assert/strict';
import {traceLine} from '../lib/autopilot/tank-trace';

test('a trace line keeps the numbers it has, rounded, and the water meter in litres', () => {
    const line = traceLine(Date.UTC(2026, 10, 26, 17, 15), {bt6: 28.04, bt7: 49.1, heat: 1457.4166, prio: 20, hz: undefined, litres: NaN},
        {litres: 203661.4, flow: 7.234});
    assert.deepEqual(line, {t: '2026-11-26T17:15:00.000Z', bt6: 28.04, bt7: 49.1, heat: 1457.42, prio: 20, water: 203661.4, flow: 7.23});
});

test('without a water meter the line carries the pump alone', () => {
    assert.deepEqual(traceLine(0, {bt6: 40}, undefined), {t: '1970-01-01T00:00:00.000Z', bt6: 40});
});
