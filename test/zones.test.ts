import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatHits, isRoomTemperatureWord, scanInputSpace} from '../lib/zone-scan';
import {isPlausibleAlt, resolvedAddress} from '../lib/registers';
import {sProfile} from '../drivers/nibe_s/profile';

// A pump that answers only the addresses in `space`, refusing any block touching another one.
const pump = (space: Record<number, number>, delay = () => 0) => {
    let now = 0;
    const read = async (address: number, count: number) => {
        now += delay();
        for (let a = address; a < address + count; a++)
            if (!(a in space)) return undefined;
        return Array.from({length: count}, (_, i) => space[address + i]);
    };
    return {read, now: () => now};
};

test('zone setpoints are offered as thermostat targets, zone 1 first', () => {
    const target = sProfile.registerByName['target_temperature'];
    assert.equal(target.address, 2505);
    assert.equal(target.sources?.[0].address, 2505, 'zone 1 stays the default');
    assert.equal(target.sources?.[1].address, 2507, 'zone 2 is the next 32-bit slot');
    assert.equal(target.sources?.length, 40);
    assert.equal(target.sources?.at(-1)?.address, 2583);
    // An unconfigured zone reads a flat 0 and must never be offered as a zone to control.
    assert.equal(isPlausibleAlt(target, 0), false);
    assert.equal(isPlausibleAlt(target, 21.5), true);
    // Reads and writes both follow the choice.
    assert.equal(resolvedAddress(target, {groups: {}, overrides: {}, addresses: {target_temperature: 2507}}), 2507);
    assert.equal(resolvedAddress(target, null), 2505);
});

test('room-temperature words: 5-40 °C in tenths, signed, never the sentinel', () => {
    assert.equal(isRoomTemperatureWord(220), true);
    assert.equal(isRoomTemperatureWord(49), false);
    assert.equal(isRoomTemperatureWord(401), false);
    assert.equal(isRoomTemperatureWord(0x8000), false);
    assert.equal(isRoomTemperatureWord(0xFFF6), false, '-1.0 °C is not a room');
});

test('scan finds temperatures next to refused addresses, and splits refused blocks', async () => {
    const space: Record<number, number> = {};
    for (let a = 0; a < 200; a++) space[a] = 0;
    delete space[37];          // one hole: the 50-block and its 10-block are refused
    space[26] = 215; space[116] = 234; space[150] = 245; space[151] = 1000;
    const {read} = pump(space);
    const result = await scanInputSpace(read, 0, 249);
    assert.deepEqual(result.hits, [{address: 26, value: 21.5}, {address: 116, value: 23.4}, {address: 150, value: 24.5}]);
    assert.equal(result.answered, 199);
    assert.ok(!result.aborted);
    // 0-49: 1 + 5 tens, of which 30-39 goes single (10). 50-199: 3 blocks. 200-249: 1 + 5 + 50.
    assert.equal(result.reads, 1 + 5 + 10 + 3 + 1 + 5 + 50);
});

test('scan stops when the pump answers too slowly, instead of wedging the wire', async () => {
    const {read, now} = pump({}, () => 5000);
    const result = await scanInputSpace(read, 0, 9999, {now});
    assert.equal(result.aborted, 'pump answering too slowly');
    assert.equal(result.reads, 2);
});

test('scan respects its deadline', async () => {
    const {read, now} = pump({}, () => 100);
    const result = await scanInputSpace(read, 0, 9999, {now, deadline: 1000});
    assert.equal(result.aborted, 'time limit');
    assert.ok(result.reads <= 11);
});

test('hits format as compact lines', () => {
    const hits = Array.from({length: 25}, (_, i) => ({address: i, value: 20}));
    const lines = formatHits(hits);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].split(' ').length, 20);
    assert.equal(lines[1], '20=20 21=20 22=20 23=20 24=20');
});
