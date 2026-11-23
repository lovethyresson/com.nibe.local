import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OverviewInput, overviewData, plannedAhead, splitWarning} from '../lib/autopilot/overview';

const t = (key: string, tokens?: Record<string, string | number>) => key + (tokens ? JSON.stringify(tokens) : '');
const base: OverviewInput = {title: 'Nibe Live', warnings: [],
    now: {kind: 'hotwater', title: 'Heating hot water', sub: 'Until about 13:45'},
    tiles: [{kind: 'heating', label: 'Indoor', value: '21.7 °C', sub: 'Target 22.5 °C'}, {kind: 'hotwater', label: 'Hot water', value: '201 L'}],
    facts: [{label: 'Power now', value: '2.4 kW'}, {label: 'November', value: '14 kr saved', good: true}]};

test('nothing to report: no band, the activity line leads, tiles and facts as given', () => {
    const d = overviewData(base, t);
    assert.equal(d.alert, undefined);
    assert.deepEqual(d.now, base.now, 'full size: nothing competes with it');
    assert.deepEqual(d.tiles, base.tiles);
    assert.deepEqual(d.facts, base.facts);
    assert.equal(d.stale, undefined);
    assert.equal(d.chip, undefined, 'a working day shows no chip');
    assert.equal(overviewData({...base, dayType: 'Day off'}, t).chip, 'Day off');
    assert.equal(d.badge, undefined, 'no Autopilot pill while it runs nothing');
    assert.equal(overviewData({...base, autopilot: true}, t).badge, 'Autopilot');
    assert.equal(overviewData({...base, autopilot: true, gettingStarted: true}, t).badge, 'Autopilot · getting_started');
    assert.equal(overviewData({...base, gettingStarted: true}, t).badge, undefined, 'nothing runs: no pill at all');
});

test('one band, the most serious first: offline, then an alarm, then a problem, then advice', () => {
    const all = {...base, offline: 'No answer', alarm: 'Alarm 153',
        warnings: [{text: 'Curve offset 0 → +2.', advice: true}, {text: 'Autopilot is waiting. Turn off Smart Price Adaption.', advice: false}]};
    assert.deepEqual(overviewData(all, t).alert, {tone: 'bad', title: 'offline_title', text: 'No answer'});
    assert.deepEqual(overviewData({...all, offline: undefined}, t).alert, {tone: 'bad', title: 'alarm_title', text: 'Alarm 153'});
    assert.deepEqual(overviewData({...all, offline: undefined, alarm: undefined}, t).alert,
        {tone: 'warn', title: 'Autopilot is waiting', text: 'Turn off Smart Price Adaption.'}, 'a problem before advice');
    assert.deepEqual(overviewData({...base, warnings: [{text: 'Curve offset 0 → +2.', advice: true}]}, t).alert,
        {tone: 'warn', title: 'Curve offset 0 → +2'});
});

test('with a band the activity line steps back; offline it goes, and the rest is drawn faded', () => {
    const waiting = overviewData({...base, warnings: [{text: 'Autopilot is waiting. Do this.', advice: false}]}, t);
    assert.equal(waiting.now?.quiet, true, 'only the band dominates');
    const off = overviewData({...base, offline: 'No answer'}, t);
    assert.equal(off.now, undefined, 'the band already says it');
    assert.equal(off.stale, true);
    assert.deepEqual(off.tiles, base.tiles, 'the last readings stay');
});

test('a warning splits at its first sentence', () => {
    assert.deepEqual(splitWarning('Autopilot is waiting. Turn off Smart Price Adaption for hot water on your heat pump.'),
        {title: 'Autopilot is waiting', text: 'Turn off Smart Price Adaption for hot water on your heat pump.'});
    assert.deepEqual(splitWarning('Sensor lost.'), {title: 'Sensor lost'});
    assert.deepEqual(splitWarning('Sensor lost'), {title: 'Sensor lost'});
});

test('by midnight counts each plan from its own start, only the hours after this one', () => {
    const H = 3_600_000, midnight = 0;
    // Heating planned from midnight, hot water from 07:00 (its plan's index 0 is 07:00).
    const heating = {from: midnight, expected: Array.from({length: 24}, () => 2)};
    const water = {from: midnight + 7 * H, expected: [0, 0, 0, 0, 0, 0, 4, 0]}; // 13:00
    const now = midnight + 12 * H; // 12:xx: hours from 13:00 count
    const out = plannedAhead([heating, water], now, () => 2);
    assert.equal(out.cost, 11 * 2 + 4, 'heating 13–23 and the 13:00 hot water run');
    assert.equal(out.kwh, out.cost / 2);
    assert.equal(plannedAhead([water], midnight + 13 * H, () => 2).cost, 0, 'a run in this hour is already in today so far');
});
