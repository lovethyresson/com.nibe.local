import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RESTORE_FIT_SLOTS, restoredFit} from '../lib/autopilot/collector';
import {HouseFit} from '../lib/autopilot/house';
import {RADIATOR_HOUSE} from './autopilot-house-sim';

const fit = (slot: number, lever = 0.4): HouseFit => ({params: RADIATOR_HOUSE, lever, rmse: 0.2, windows: 10, slots: 2000,
    usable: 1800, validDays: 14, state: {slot, ti: 21, tm: 21.3}});

test('a restart plans from the saved fit while its state is recent', () => {
    // Through JSON, as it comes back from the model file.
    const saved = JSON.parse(JSON.stringify(fit(1000)));
    assert.deepEqual(restoredFit(saved, 1000 + RESTORE_FIT_SLOTS), saved);
    assert.equal(restoredFit(saved, 1001 + RESTORE_FIT_SLOTS), undefined, 'too old: the house has moved on');
});

test('a saved fit without a model, a lever or a state is not restored', () => {
    assert.equal(restoredFit(undefined, 1000), undefined);
    assert.equal(restoredFit({...fit(1000), params: undefined}, 1000), undefined);
    assert.equal(restoredFit(fit(1000, 0), 1000), undefined);
    assert.equal(restoredFit({...fit(1000), state: undefined}, 1000), undefined);
});
