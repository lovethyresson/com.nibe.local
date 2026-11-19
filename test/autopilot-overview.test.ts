import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MAX_LINES, OverviewInput, overviewData, priceThirds} from '../lib/autopilot/overview';

const t = (key: string, tokens?: Record<string, string | number>) => key + (tokens ? JSON.stringify(tokens) : '');
const base: OverviewInput = {title: 'Heat pump', autopilot: true, warnings: [], rows: [{kind: 'heating', name: 'Heating'}]};

test('the ring is the share of today\'s use in the cheapest third', () => {
    const d = overviewData({...base, tiers: [6.9, 2.5, 0.6]}, t);
    assert.deepEqual(d.ring, {tiers: [6.9, 2.5, 0.6], centre: '69 %', label: 'cheap'});
    assert.equal(overviewData({...base, tiers: [0, 0, 0]}, t).ring, undefined, 'nothing used yet: no ring');
});

test('the month\'s savings lead, with today\'s cost under them; without savings, today\'s cost leads', () => {
    const d = overviewData({...base, spent: '14 kr', saved: {value: '214 kr', month: 'November'}}, t);
    assert.deepEqual(d.hero, {value: '214 kr', label: 'saved_month{"month":"November"}', good: true});
    assert.equal(d.line, 'spent_line{"cost":"14 kr"}');
    const e = overviewData({...base, spent: '14 kr'}, t);
    assert.deepEqual(e.hero, {value: '14 kr', label: 'spent'});
    assert.equal(e.line, undefined, 'the cost is not said twice');
});

test('problems come before advice, a pump-wide line shows once, and two at most', () => {
    const d = overviewData({...base, offline: 'No answer', alarm: 'Alarm 153',
        warnings: [{text: 'Curve offset 0 → +2', advice: true}, {text: 'Sensor lost'}, {text: 'Sensor lost'}]}, t);
    assert.deepEqual(d.attention.map((l) => l.text), ['No answer', 'Alarm 153']);
    assert.equal(d.attention.length, MAX_LINES);
    const e = overviewData({...base, warnings: [{text: 'Advice', advice: true}, {text: 'Sensor lost'}, {text: 'Sensor lost'}]}, t);
    assert.deepEqual(e.attention, [{tone: 'bad', text: 'Sensor lost'}, {tone: 'warn', text: 'Advice'}]);
});

test('the chip: Offline over Autopilot, none when nothing runs', () => {
    assert.deepEqual([overviewData({...base, offline: 'x'}, t).chip, overviewData({...base, offline: 'x'}, t).chipQuiet], ['offline', true]);
    assert.equal(overviewData(base, t).chip, 'Autopilot');
    assert.equal(overviewData({...base, autopilot: false}, t).chip, undefined);
});

test('thirds rank the day\'s hours by price, as the savings widgets do', () => {
    const hours = Array.from({length: 24}, (_, k) => k);
    const prices = new Map(hours.map((h) => [h, h < 8 ? 1 : h < 16 ? 2 : 3]));
    assert.deepEqual(priceThirds(hours, () => 1, prices), [8, 8, 8]);
    // A 23-hour day (spring forward): 8 cheap, as Energy today's cheap share counts them.
    const short = hours.slice(0, 23);
    assert.equal(priceThirds(short, () => 1, prices)![0], 8);
    assert.equal(priceThirds(hours, () => 1, new Map()), undefined);
});
