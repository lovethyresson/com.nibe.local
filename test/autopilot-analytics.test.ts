// Autopilot's analytics: the buckets, the edge triggers and the daily scores (lib/autopilot/analytics.ts).
import {test} from 'node:test';
import assert from 'node:assert';
import {
    COLD_TOP_C, Edge, FORECAST_SLOTS, HeatingDay, analyticsSmartMode, heatingBlock, hotwaterDayScore, kelvinBucket,
    TankDay, leverBlock, ratioBucket, reserveBucket, solarShareBucket, tankDayUpdate,
} from '../lib/autopilot/analytics';
import {resumePlan} from '../lib/autopilot/hotwater-shadow';

const HOUR = 3_600_000;

test('Smart mode: the internal test run is "simulation"; the rest keep their names', () => {
    assert.strictEqual(analyticsSmartMode('test'), 'simulation');
    for (const m of ['off', 'spa', 'autopilot'] as const) assert.strictEqual(analyticsSmartMode(m), m);
});

test('reserve bucket: off, the three offered values, anything else is other', () => {
    assert.deepStrictEqual([0, 20, 40, 60, 10, 80, 500].map(reserveBucket), ['off', '20', '40', '60', 'other', 'other', 'other']);
});

test('ratio bucket: edges fall where the taxonomy says', () => {
    assert.deepStrictEqual([0, 0.49, 0.5, 0.79, 0.8, 1, 1.25, 1.26, 2, 2.01].map(ratioBucket),
        ['<0.5', '<0.5', '0.5-0.8', '0.5-0.8', '0.8-1.25', '0.8-1.25', '0.8-1.25', '1.25-2', '1.25-2', '>2']);
    assert.strictEqual(ratioBucket(NaN), undefined);
    assert.strictEqual(ratioBucket(-1), undefined);
    assert.strictEqual(ratioBucket(Infinity), undefined);
});

test('kelvin bucket', () => {
    assert.deepStrictEqual([0, 0.29, 0.3, 0.69, 0.7, 1.5, 1.51].map(kelvinBucket),
        ['<0.3', '<0.3', '0.3-0.7', '0.3-0.7', '0.7-1.5', '0.7-1.5', '>1.5']);
    assert.strictEqual(kelvinBucket(NaN), undefined);
});

test('solar share bucket', () => {
    assert.deepStrictEqual([0, 0.01, 0.49, 0.5, 1].map(solarShareBucket), ['0', '<50%', '<50%', '>=50%', '>=50%']);
});

test('blocks: lever skips that block map; the rest are not a block', () => {
    assert.strictEqual(leverBlock('hot water off'), 'hot_water_off');
    assert.strictEqual(leverBlock('smart price adaption'), 'spa_on');
    assert.strictEqual(leverBlock('smart control'), 'smart_control');
    assert.strictEqual(leverBlock('daily limit'), 'daily_limit');
    for (const skip of ['tank hot enough', 'no tank reading', 'no stop reading']) assert.strictEqual(leverBlock(skip), undefined);
    assert.strictEqual(heatingBlock('spa_on'), 'spa_on');
    assert.strictEqual(heatingBlock('room_control'), 'room_control');
    assert.strictEqual(heatingBlock('mode_off'), undefined);
    assert.strictEqual(heatingBlock('no_model'), undefined);
    assert.strictEqual(heatingBlock(undefined), undefined);
});

test('edge: the first value and each change, never a repeat', () => {
    const e = new Edge<string | undefined>();
    assert.deepStrictEqual(['a', 'a', 'a', 'b', 'b', undefined, undefined, 'b'].map((v) => e.changed(v)),
        [true, false, false, true, false, true, false, true]);
});

test('edge as the hot water lever uses it: one event per block, a start re-arms it', () => {
    // What startCharge does each planned start: a block is told once; a skip that is not a block
    // leaves it standing; a real start clears it.
    const edge = new Edge<string | undefined>();
    const told: string[] = [];
    const attempt = (skip?: string) => {
        if (skip === undefined) return void edge.changed(undefined);
        const block = leverBlock(skip);
        if (block && edge.changed(block)) told.push(block);
    };
    for (const s of ['daily limit', 'daily limit', 'tank hot enough', 'daily limit', undefined, 'daily limit', 'smart control'])
        attempt(s);
    assert.deepStrictEqual(told, ['daily_limit', 'daily_limit', 'smart_control']);
});

test('tank day: keeps the lowest volume and top, and whether it went under the net; same object when unchanged', () => {
    let d: TankDay = {from: 0};
    d = tankDayUpdate(d, {litres: 120.4, top: 52.34}, 40);
    assert.deepStrictEqual(d, {from: 0, minLitres: 120, minTop: 52.3});
    const same = tankDayUpdate(d, {litres: 150, top: 55}, 40);
    assert.strictEqual(same, d);
    d = tankDayUpdate(d, {litres: 35, top: 38}, 40);
    assert.deepStrictEqual(d, {from: 0, minLitres: 35, minTop: 38, belowNet: true});
    assert.strictEqual(tankDayUpdate(d, {}, 40), d);
    // No safety net: never below it.
    assert.strictEqual(tankDayUpdate({from: 0, minLitres: 0}, {litres: 0}, 0).belowNet, undefined);
});

test('hot water day score: ratios and counts, nothing absolute', () => {
    const score = hotwaterDayScore({
        day: {from: 0, minLitres: 30, minTop: COLD_TOP_C - 1, belowNet: true}, now: 24 * HOUR,
        charges: [{by: 'autopilot', price: 0.5, surplusShare: 1}, {by: 'autopilot', price: 0.7, surplusShare: 0}, {by: 'pump'}],
        drawKwh: 9, expectedKwh: 6, dayMeanPrice: 1, simulation: true,
    });
    assert.deepStrictEqual(score, {
        role: 'hotwater', fell_below_net: true, ran_cold: true, charges_autopilot: 2, charges_device: 1, simulation: true,
        use_vs_expected: '1.25-2', price_vs_day_mean: '0.5-0.8', solar_share: '<50%',
    });
    for (const v of Object.values(score!)) assert.ok(typeof v !== 'number' || Number.isInteger(v), 'only counts are numbers');
});

test('hot water day score: what cannot be worked out is left out; a short window is no day', () => {
    assert.strictEqual(hotwaterDayScore({day: {from: 0}, now: 19 * HOUR, charges: [], simulation: false}), undefined);
    assert.deepStrictEqual(hotwaterDayScore({day: {from: 0}, now: 24 * HOUR, charges: [], drawKwh: 5, expectedKwh: 0, simulation: false}),
        {role: 'hotwater', fell_below_net: false, ran_cold: false, charges_autopilot: 0, charges_device: 0, simulation: false});
});

test('the saved plan keeps the tank day across a restart', () => {
    const resumed = resumePlan({events: [], day: {from: 1000, minLitres: 80}}, 2000);
    assert.deepStrictEqual(resumed?.day, {from: 1000, minLitres: 80});
    assert.strictEqual(resumePlan({events: [], day: {from: 3000}}, 2000)?.day, undefined);
});

/** Feed heating's day `n` slots of `ti` on `date` from `slot0`. */
function feed(day: HeatingDay, date: string, slot0: number, n: number, ti: (k: number) => number, simulation = false) {
    let out;
    for (let k = 0; k < n; k++)
        out ??= day.observe({slot: slot0 + k, date, ti: ti(k), comfort: 21, lower: 1, upper: 1, simulation});
    return out;
}

test('heating day: scored when the next day starts, once a slot, off-target and outside range bucketed', () => {
    const day = new HeatingDay();
    // 96 slots: 80 at comfort, 16 (4 h) 2 K under, outside the ±1 K range.
    assert.strictEqual(feed(day, '2026-11-13', 0, 96, (k) => (k < 80 ? 21 : 19)), undefined);
    // A repeated slot does not count twice.
    day.observe({slot: 95, date: '2026-11-13', ti: 10, comfort: 21, lower: 1, upper: 1, simulation: false});
    const score = day.observe({slot: 96, date: '2026-11-14', ti: 21, comfort: 21, lower: 1, upper: 1, simulation: false});
    // Mean |off| = 16 × 2 / 96 = 0.33 K.
    assert.deepStrictEqual(score, {role: 'heating', indoor_off_target: '0.3-0.7', hours_outside_range: 4, simulation: false});
});

test('heating day: the 6 h prediction is scored against the indoor it predicted', () => {
    const day = new HeatingDay();
    for (let k = 0; k < 96; k++) {
        day.predict(k, 21.5);
        day.predict(k, 30); // a replan in the same slot keeps the first prediction
        day.observe({slot: k, date: 'd1', ti: 21, comfort: 21, lower: 1, upper: 1, simulation: true});
    }
    const score = day.observe({slot: 96, date: 'd2', ti: 21, comfort: 21, lower: 1, upper: 1, simulation: false});
    // 96 − FORECAST_SLOTS slots had a prediction, each 0.5 K off.
    assert.strictEqual(FORECAST_SLOTS, 24);
    assert.deepStrictEqual(score, {role: 'heating', indoor_off_target: '<0.3', hours_outside_range: 0, simulation: true,
        forecast_error: '0.3-0.7'});
});

test('heating day: a day watched for under 20 h is not scored', () => {
    const day = new HeatingDay();
    feed(day, 'd1', 0, 79, () => 21);
    assert.strictEqual(day.observe({slot: 200, date: 'd2', ti: 21, comfort: 21, lower: 1, upper: 1, simulation: false}), undefined);
});
