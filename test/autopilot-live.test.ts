import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    FeedHooks, HeatingFeed, LIVE_LIMITS, LiveEntry, LiveMode, PROFILE_LIMITS, PumpFacts, ShiftInput, StopReason, cycleBias,
    flatPrices, indoorMean, liveMode, planLive, profileLimits, stopReason, surplusPrices, SURPLUS_SHIFT_K, curveCoastDepth, liveLimits, livePump, withHotwater,
} from '../lib/autopilot/live';
import {SupplyCurve} from '../lib/autopilot/curve';
import {pumpHeat, simulate} from '../lib/autopilot/planner';
import {newForecastBias} from '../lib/autopilot/outdoor';
import {ForecastSlot, steadyState} from '../lib/autopilot/planner';
import {SLOT_MS} from '../lib/autopilot/prices';
import {RADIATOR_HOUSE} from './autopilot-house-sim';

const house = RADIATOR_HOUSE;
const start = steadyState(house, 21.5, 3);
const peak = (k: number) => (k >= 24 && k < 40 ? 4 : 1);
const forecast = (): ForecastSlot[] => Array.from({length: 96}, (_, k) => ({te: 3, sun: 300, price: peak(k)}));
const input = (over: Partial<ShiftInput> = {}): ShiftInput => ({house, lever: 0.5 * house.heatLoss, ti: start.ti, tm: start.tm,
    mean: 21.5, curve: 3, bias: 0, forecast: forecast(), ...over});

test('heating\'s Smart mode decides the feed mode', () => {
    assert.equal(liveMode(undefined), 'off');
    assert.equal(liveMode('spa'), 'off');
    assert.equal(liveMode('test'), 'test');
    assert.equal(liveMode('autopilot'), 'live');
});

test('profiles are indoor tolerances, ±0.5 / ±3 / ±6 °C, and widen the shift with them; unknown is Comfort', () => {
    assert.equal(profileLimits(undefined), PROFILE_LIMITS.comfortable);
    assert.deepEqual(['comfortable', 'save_some', 'save_most'].map((id) => profileLimits(id).lower), [0.5, 3, 6]);
    assert.ok(PROFILE_LIMITS.comfortable.maxBias < PROFILE_LIMITS.save_some.maxBias
        && PROFILE_LIMITS.save_some.maxBias < PROFILE_LIMITS.save_most.maxBias);
    assert.ok(PROFILE_LIMITS.comfortable.margin > PROFILE_LIMITS.save_most.margin);
    for (const id of ['comfortable', 'save_some', 'save_most'] as const) {
        const plan = planLive(input(), PROFILE_LIMITS[id]);
        assert.ok(plan.biases.every((b) => Math.abs(b) <= PROFILE_LIMITS[id].maxBias + 1e-9), id);
    }
});

test('shift-only plans no comfort bias and stays inside ±3 K', () => {
    const plan = planLive(input());
    assert.ok(plan.comfort.every((b) => b === 0), 'no comfort bias');
    assert.ok(plan.biases.every((b) => b <= LIVE_LIMITS.maxBias && b >= -LIVE_LIMITS.maxCoastBias));
    // A 4× price for 4 h: it eases off during the peak and buys the heat back after it.
    assert.ok(Math.min(...plan.biases.slice(24, 40)) < 0, 'eases off in the peak');
    assert.ok(Math.max(...plan.biases.slice(40, 56)) > 0, 'recovers after it');
    assert.ok(Math.min(...plan.plan.ti) >= 21.5 - LIVE_LIMITS.lower - 0.1, 'stays in the band');
});

test('shift-only ignores forecast sun', () => {
    const sunny = planLive(input());
    const dark = planLive(input({forecast: forecast().map((s) => ({...s, sun: 0}))}));
    assert.deepEqual(sunny.biases, dark.biases);
});

test('a flat price moves nothing', () => {
    const plan = planLive(input({forecast: forecast().map((s) => ({...s, price: 1}))}));
    assert.ok(plan.biases.every((b) => b === 0));
});

test('indoor mean needs half a day of readings', () => {
    assert.equal(indoorMean(new Array(47).fill(21)), undefined);
    assert.equal(indoorMean([...new Array(48).fill(21), NaN, NaN, ...new Array(48).fill(22)]), 21.5);
});

test('guards that stop the feed', () => {
    const ok: PumpFacts = {mode: 1, thresholds: {}, spaHeating: false, roomControl: 0};
    assert.equal(stopReason(ok, true), undefined);
    assert.equal(stopReason(ok, false), 'no_model');
    assert.equal(stopReason({...ok, mode: 2}, true), 'immersion_only');
    assert.equal(stopReason({...ok, spaHeating: true}, true), 'spa_on');
    assert.equal(stopReason({...ok, roomControl: 1}, true), 'room_control');
    // Unknown room control (not readable on this firmware) does not block.
    assert.equal(stopReason({...ok, roomControl: undefined}, true), undefined);
});

test('no pre-heat while the immersion heater runs; coasting is still allowed', () => {
    assert.equal(cycleBias(2, true), 0);
    assert.equal(cycleBias(-2, true), -2);
    assert.equal(cycleBias(2, false), 2);
});

/** A fake pump: 5217 writes show on input 1 unless `deaf`. Timers run by hand. */
function harness(over: {mode?: LiveMode; facts?: Partial<PumpFacts>; sensor?: number; forecast?: number; deaf?: boolean;
    plan?: ShiftInput | undefined; setpoint?: number; mean?: number; hold?: boolean; input1?: number} = {}) {
    let now = 1_800_000 * SLOT_MS + 1000;
    let input1: number | undefined = over.input1;
    const state = {
        mode: over.mode ?? 'live' as LiveMode, writes: [] as number[], records: [] as LiveEntry[], warnings: [] as (StopReason | undefined)[],
        changes: 0, neutral: false, logs: [] as string[], setpoint: over.setpoint, trim: {integral: 0}, saves: 0,
        feeding: [] as boolean[], sensor: ('sensor' in over ? over.sensor : 3) as number | undefined, deaf: over.deaf ?? false,
        facts: {mode: 1, thresholds: {}, spaHeating: false, roomControl: 0, ...over.facts} as PumpFacts,
    };
    const hooks: FeedHooks = {
        mode: () => state.mode,
        limits: () => LIVE_LIMITS,
        neutral: () => state.neutral,
        sunTrust: () => 0,
        holdShift: () => over.hold === true,
        plan: () => ('plan' in over ? over.plan : input({curve: 3})),
        indoorMean: () => over.mean,
        setpoint: () => state.setpoint,
        loadTrim: () => state.trim,
        saveTrim: (t) => { state.trim = t; state.saves++; },
        pump: async () => state.facts,
        outdoor: () => ({sensor: state.sensor, forecast: over.forecast, localHour: 12, bias: newForecastBias()}),
        write: async (c) => { state.writes.push(c); if (!state.deaf) input1 = c; },
        readBack: async () => input1,
        feeding: (on) => state.feeding.push(on),
        warn: (m) => state.warnings.push(m),
        changed: () => { state.changes++; },
        log: (...args) => { state.logs.push(args.join(' ')); },
        debug: () => 'indoor 20.8',
        record: (e) => state.records.push(e),
        setTimeout: () => 1,
        clearTimeout: () => undefined,
        sleep: async () => undefined,
        now: () => now,
    };
    const feed = new HeatingFeed(hooks);
    return {feed, state, advance: (ms: number) => { now += ms; }};
}

test('a cycle feeds the real outdoor minus the plan\'s bias and checks the pump took it', async () => {
    const {feed, state} = harness();
    feed.start();
    await feed.cycle();
    assert.equal(state.writes.length, 1);
    assert.equal(state.writes[0], Math.round((3 - feed.state.bias) * 10) / 10);
    assert.equal(state.feeding.at(-1), true);
    assert.equal(state.records.length, 1, 'one record for the new slot');
    assert.ok(state.changes > 0, 'the owner-facing status is told');
    assert.equal(feed.state.slot, 1_800_000, 'the snapshot carries the plan');
    await feed.cycle();
    assert.equal(state.records.length, 1, 'no replan within the slot');
});

const heldPlan = async (setpoint: number, prices: (k: number) => number = peak) => {
    const h = harness({setpoint, hold: true, plan: input({forecast: forecast().map((f, k) => ({...f, price: prices(k)}))})});
    h.feed.start();
    await h.feed.cycle();
    return h;
};

test('Getting started holds prices still, and says why', async () => {
    const shifting = harness({setpoint: 21.5});
    shifting.feed.start();
    await shifting.feed.cycle();
    const held = await heldPlan(21.5);
    assert.equal(held.feed.state.planReason, 'getting_started');
    assert.equal(held.state.records[0].reason, 'getting_started');
    assert.ok(shifting.feed.state.biases!.some((b) => Math.abs(b) > 0.5), 'the same input shifts for prices when not held');
    assert.ok(held.feed.state.biases!.every((b) => Math.abs(b) < 0.5), 'held at the setpoint: nothing to do');
});

test('Getting started still warms a house below the setpoint back, at no particular hour (2026-11-24)', async () => {
    // The house sits at 21.5 °C: a 22.5 °C setpoint leaves it 1 K short.
    const cold = await heldPlan(22.5);
    assert.ok(cold.feed.state.biases!.slice(0, 16).some((b) => b > 0.5), `warms: ${cold.feed.state.biases!.slice(0, 16)}`);
    assert.ok(cold.feed.state.biases!.every((b) => b >= -1e-9), 'and never eases off to save');
    // Where the prices peak changes nothing: the hold moves no heat for price.
    const late = await heldPlan(22.5, (k) => (k >= 60 && k < 76 ? 4 : 1));
    const flat = await heldPlan(22.5, () => 2);
    assert.deepEqual(late.feed.state.biases, cold.feed.state.biases);
    assert.deepEqual(flat.feed.state.biases, cold.feed.state.biases);
});

test('the curve check counts the warming the hold adds, not price shifts (2026-11-24)', async () => {
    // A cold house under the hold: the plan warms it, and that is level the curve is short of.
    // Past the start-up ramp (2 K a slot from neutral), so the plan's shift shows.
    const held = await heldPlan(22.5);
    for (let k = 0; k < 6; k++) { held.advance(SLOT_MS); await held.feed.cycle(); }
    // Seven slots of it count as seven of a day's 96, not a whole day.
    const extra = held.feed.levelPush - held.feed.learnedTrim;
    assert.ok(extra > 0 && extra < 1, `${held.feed.levelPush} vs ${held.feed.learnedTrim}`);
    // The same plan shifting for prices adds nothing to it.
    const shifting = harness({setpoint: 22.5, plan: input()});
    shifting.feed.start();
    for (let k = 0; k < 6; k++) { await shifting.feed.cycle(); shifting.advance(SLOT_MS); }
    assert.equal(shifting.feed.levelPush, shifting.feed.learnedTrim);
});

test('flatPrices sets every slot to the forecast\'s mean price and drops spot', () => {
    const out = flatPrices([{te: 1, sun: 0, price: 1, spot: 0.5}, {te: 2, sun: 0, price: 3}]);
    assert.deepEqual(out.map((s) => s.price), [2, 2]);
    assert.equal(out[0].spot, undefined);
    assert.equal(out[1].te, 2);
    assert.deepEqual(flatPrices([]), []);
});

test('an owner change replans within the slot, not at the next one', async () => {
    const {feed, state} = harness();
    feed.start();
    await feed.cycle();
    assert.equal(state.records.length, 1);
    feed.replanSoon();
    await feed.cycle();
    assert.equal(state.records.length, 2, 'replanned at once after a Comfort range or thermostat change');
    await feed.cycle();
    assert.equal(state.records.length, 2, 'and then holds until the next slot');
});

test('a test run plans and reports but never writes', async () => {
    const {feed, state} = harness({mode: 'test'});
    feed.start();
    await feed.cycle();
    await feed.cycle();
    assert.equal(state.writes.length, 0);
    assert.ok(feed.state.biases?.length, 'it has a plan to show');
    assert.equal(feed.state.stopped, undefined);
    await feed.stop();
    assert.equal(state.writes.length, 0, 'nothing to hand back');
});

test('switching from live to test hands BT1 back once', async () => {
    const {feed, state} = harness();
    feed.start();
    await feed.cycle();
    state.mode = 'test';
    await feed.cycle();
    await feed.cycle();
    assert.deepEqual(state.writes.slice(1), [3], 'one neutral write, then nothing');
});

test('Comfort range Off feeds the real outdoor temperature, unshifted, and plans again when it is back', async () => {
    const {feed, state} = harness({plan: input({curve: 3, forecast: Array.from({length: 96}, (_, k) => ({te: 3, sun: 0, price: k < 16 ? 4 : 1}))})});
    feed.start();
    await feed.cycle();
    assert.notEqual(state.writes.at(-1), 3, 'shifting while the range is on');
    state.neutral = true;
    await feed.cycle();
    assert.equal(state.writes.at(-1), 3, 'the real outdoor temperature');
    assert.equal(feed.state.bias, 0);
    assert.equal(feed.state.neutral, true);
    assert.equal(feed.state.stopped, undefined, 'still feeding, not a wait');
    await feed.cycle();
    assert.equal(state.writes.at(-1), 3, 'and again: the pump stays on the chosen sensor');
    state.neutral = false;
    await feed.cycle();
    assert.notEqual(state.writes.at(-1), 3, 'shifting again within the slot');
});

test('Comfort range Off still stands aside for SPA', async () => {
    const {feed, state} = harness({facts: {spaHeating: true}});
    state.neutral = true;
    feed.start();
    await feed.cycle();
    assert.equal(feed.state.stopped, 'spa_on');
    assert.deepEqual(state.writes, []);
});

test('three failed cycles stop the feed with a warning', async () => {
    const {feed, state} = harness({deaf: true});
    feed.start();
    await feed.cycle();
    await feed.cycle();
    assert.ok(feed.running);
    await feed.cycle();
    await new Promise((r) => setImmediate(r));
    assert.ok(!feed.running);
    assert.equal(feed.state.stopped, 'feed_failed');
    assert.ok(state.warnings.includes('feed_failed'));
    assert.equal(state.feeding.at(-1), false);
});

test('SPA on, immersion-only or no model wait before anything is written, and keep checking', async () => {
    for (const [over, reason] of [[{facts: {spaHeating: true}}, 'spa_on'], [{facts: {mode: 2}}, 'immersion_only'],
        [{plan: undefined}, 'no_model']] as const) {
        const {feed, state} = harness(over as any);
        feed.start();
        await feed.cycle();
        await new Promise((r) => setImmediate(r));
        assert.equal(state.writes.length, 0, reason);
        assert.equal(feed.state.stopped, reason);
        assert.ok(feed.running, `${reason} is a wait`);
    }
});

test('without a model it plans as soon as one lands, not at the next slot', async () => {
    const over: {plan?: any} = {plan: undefined};
    const {feed, state} = harness(over as any);
    feed.start();
    await feed.cycle();
    assert.equal(feed.state.stopped, 'no_model');
    over.plan = input({curve: 3});
    await feed.cycle();
    assert.equal(feed.state.stopped, undefined, 'the first fit after a restart, a cycle later');
    assert.equal(state.writes.length, 1);
});

test('while the model learns, the trim alone holds the setpoint', async () => {
    const over: {plan?: any; setpoint: number; mean: number} = {plan: undefined, setpoint: 21, mean: 20.5};
    const {feed, state, advance} = harness(over as any);
    feed.start();
    await feed.cycle();
    assert.equal(feed.state.stopped, undefined, 'feeding, not waiting');
    assert.equal(feed.state.learning, true);
    assert.equal(feed.state.biases, undefined, 'no price plan');
    assert.ok(feed.state.trim! > 0, '0.5 K under warms');
    assert.equal(state.writes.at(-1), Math.round((3 - feed.state.trim!) * 10) / 10, 'fed colder by the trim');
    assert.equal(state.records.at(-1)?.reason, 'learning');
    // The model lands: the next slot plans, under the same trim.
    over.plan = input({curve: 3});
    advance(SLOT_MS);
    await feed.cycle();
    const planned = feed.state;
    assert.equal(planned.learning, undefined);
    assert.ok(planned.biases?.length);
});

test('just after a start, a model that loads plans within the slot, not at the next one', async () => {
    const over: {plan?: any; setpoint: number; mean: number} = {plan: undefined, setpoint: 21, mean: 20.5};
    const {feed, advance} = harness(over as any);
    feed.start();
    await feed.cycle();
    assert.equal(feed.state.learning, true, 'the model is still loading');
    over.plan = input({curve: 3});
    advance(30_000);
    await feed.cycle();
    assert.equal(feed.state.learning, undefined, 'planned 30 s later, in the same slot');
    assert.ok(feed.state.biases?.length);
});

test('long after a start, learning waits for the next slot to try a plan again', async () => {
    const {STARTUP_REPLAN_MS} = await import('../lib/autopilot/live');
    const over: {plan?: any; setpoint: number; mean: number} = {plan: undefined, setpoint: 21, mean: 20.5};
    const {feed, advance} = harness(over as any);
    feed.start();
    advance(STARTUP_REPLAN_MS + SLOT_MS);
    await feed.cycle();
    assert.equal(feed.state.learning, true);
    over.plan = input({curve: 3});
    advance(30_000);
    await feed.cycle();
    assert.equal(feed.state.learning, true, 'days of learning do not plan every 30 s');
});

test('while learning, the pump\'s guards still hold, and without a setpoint or a mean it waits', async () => {
    const room = harness({plan: undefined, setpoint: 21, mean: 20.5, facts: {roomControl: 1}} as any);
    room.feed.start();
    await room.feed.cycle();
    assert.equal(room.feed.state.stopped, 'room_control');
    assert.deepEqual(room.state.writes, []);
    for (const over of [{setpoint: undefined, mean: 20.5}, {setpoint: 21, mean: undefined}]) {
        const {feed, state} = harness({plan: undefined, ...over} as any);
        feed.start();
        await feed.cycle();
        assert.equal(feed.state.stopped, 'no_model');
        assert.deepEqual(state.writes, []);
    }
});

test('a curve offset change moves the trim\'s learned part once, and it is saved', async () => {
    const {feed, state} = harness({setpoint: 21});
    state.trim = {integral: 2};
    assert.equal(feed.learnedTrim, 2);
    feed.shiftTrim(-1.5);
    assert.equal(feed.learnedTrim, 0.5);
    assert.deepEqual(state.trim, {integral: 0.5});
    feed.shiftTrim(-50);
    assert.equal(feed.learnedTrim, -10, 'within the trim\'s range');
});

test('a wait clears at the next slot', async () => {
    const {feed, state, advance} = harness({facts: {spaHeating: true}});
    feed.start();
    await feed.cycle();
    assert.equal(feed.state.stopped, 'spa_on');
    state.facts.spaHeating = false;
    await feed.cycle();
    assert.equal(state.writes.length, 0, 'not within the same slot');
    advance(SLOT_MS);
    await feed.cycle();
    assert.equal(feed.state.stopped, undefined);
    assert.equal(state.writes.length, 1);
    assert.equal(state.warnings.at(-1), undefined, 'its warning cleared');
});

test('turning the setting off stops and hands back the real outdoor temperature', async () => {
    const {feed, state} = harness();
    feed.start();
    await feed.cycle();
    state.mode = 'off';
    await feed.cycle();
    await new Promise((r) => setImmediate(r));
    assert.ok(!feed.running);
    assert.equal(state.writes.at(-1), 3, 'last write is the real outdoor temperature');
});

test('without the sensor it runs on the forecast for 6 h, then stops', async () => {
    const {feed, state, advance} = harness({sensor: undefined, forecast: 2});
    feed.start();
    await feed.cycle();
    assert.ok(feed.running);
    assert.ok(state.writes.length >= 1);
    advance(6 * 3600_000);
    await feed.cycle();
    await new Promise((r) => setImmediate(r));
    assert.equal(feed.state.stopped, 'no_outdoor');
    assert.ok(state.warnings.includes('no_outdoor'));
});

test('stop on a feed that never ran writes nothing', async () => {
    const {feed, state} = harness();
    await feed.stop();
    assert.equal(state.writes.length, 0);
});

test('the feed stands aside while the pump is cooling', () => {
    assert.equal(stopReason({thresholds: {}, cooling: true}, true), 'cooling');
    assert.equal(stopReason({thresholds: {}, cooling: false}, true), undefined);
});

test('solar surplus left for heating lowers those slots\' price toward what an export earns', () => {
    const forecast = [{te: 3, sun: 0, price: 2, spot: 0.4}, {te: 3, sun: 0, price: 2, spot: 0.4}, {te: 3, sun: 0, price: 2}];
    const lever = 0.15; // kW per K: a 2 K pre-heat draws 0.1 kW of electricity at COP 3
    const draw = lever * SURPLUS_SHIFT_K / 3;
    const out = surplusPrices(forecast, 100, new Map([[100, draw], [101, draw / 2], [102, 5]]), lever);
    assert.equal(out[0].price, 0.4, 'fully covered: the export price');
    assert.ok(Math.abs(out[1].price - 1.2) < 1e-9, 'half covered: half and half');
    assert.equal(out[2].price, 0, 'no spot known: an export earns nothing');
    assert.equal(surplusPrices(forecast, 100, undefined, lever), forecast, 'no generator: unchanged');
});

test('live plans count forecast sun only at the trust given, 0 until the sun term has earned it', () => {
    const sunny = input({forecast: Array.from({length: 96}, (_, k) => ({te: 3, sun: k >= 40 && k < 56 ? 600 : 0, price: 1}))});
    const without = planLive(sunny, PROFILE_LIMITS.save_some, 0);
    const withSun = planLive(sunny, PROFILE_LIMITS.save_some, 0.74);
    assert.ok(Math.min(...withSun.biases.slice(36, 56)) <= Math.min(...without.biases.slice(36, 56)),
        'with sun expected it eases off at least as much around it');
    assert.deepEqual(without.biases, planLive({...sunny, forecast: sunny.forecast.map((s) => ({...s, sun: 0}))}, PROFILE_LIMITS.save_some).biases,
        'trust 0 is the same as no sun at all');
});

// The S1155's learned curve at curve 5, offset +6 (2026-11-14), 2 K knots: supply reaches indoor
// near a fed 29 °C and the 20 °C floor near 36 °C.

test('the coast goes as deep as the owner\'s curve needs to stop heating, as far as the curve is learned', () => {
    const fine: SupplyCurve = {knots: Array.from({length: 29}, (_, i) => -8 + 2 * i), points: 859,
        supply: [44.1, 43.3, 42.6, 41.8, 41, 40.2, 39.3, 38.4, 37.5, 36.6, 35.6, 34.6, 33.4, 31.9, 30.2, 28.3, 26.3, 24.4,
            22.9, 21.8, 21, 20.4, 20.1, 19.8, 19.7, 19.7, 19.7, 19.7, 19.7]};
    const withCurve = input({forecast: forecast().map((s) => ({...s, te: 2})), mean: 22, supply: fine, heatPerSupplyK: 0.255});
    // Supply = indoor (22) at a fed ~29 °C; from 2 °C outside that is a 26–27 K coast.
    const depth = curveCoastDepth(withCurve)!;
    assert.ok(depth >= 25 && depth <= 28, String(depth));
    assert.equal(liveLimits(PROFILE_LIMITS.comfortable, withCurve).maxCoastBias, depth);
    // Never shallower than the profile's own, and nothing changes without a learned curve.
    assert.equal(liveLimits(PROFILE_LIMITS.save_most, {...withCurve, forecast: forecast().map((s) => ({...s, te: 20}))}).maxCoastBias, 20);
    assert.equal(liveLimits(PROFILE_LIMITS.comfortable, input()), PROFILE_LIMITS.comfortable);
    // Learned only to 10 °C: the depth stops there, never on a guessed shape.
    const short: SupplyCurve = {knots: fine.knots.slice(0, 10), supply: fine.supply.slice(0, 10), points: 200};
    assert.equal(curveCoastDepth({...withCurve, supply: short}), 8);
});

test('live plans along the learned curve when it exists, and the curve still holds comfort at no bias', () => {
    const fine: SupplyCurve = {knots: Array.from({length: 29}, (_, i) => -8 + 2 * i), points: 859,
        supply: [44.1, 43.3, 42.6, 41.8, 41, 40.2, 39.3, 38.4, 37.5, 36.6, 35.6, 34.6, 33.4, 31.9, 30.2, 28.3, 26.3, 24.4,
            22.9, 21.8, 21, 20.4, 20.1, 19.8, 19.7, 19.7, 19.7, 19.7, 19.7]};
    const pump = livePump(input({supply: fine, heatPerSupplyK: 0.255}));
    assert.equal(pump.shiftOnly, true);
    assert.deepEqual(livePump(input()), {lever: 0.5 * house.heatLoss});
    // No bias: what holds comfort, whatever indoor is now.
    const hold = pumpHeat(house, 21.5, 3, 3, pump, 20);
    assert.ok(Math.abs(hold - pumpHeat(house, 21.5, 3, 3, {}, undefined)) < 1e-9);
    // A coast to where the curve's supply reaches indoor cuts more than the lever's straight line says.
    const deep = pumpHeat(house, 21.5, 3, 28, pump, 21.5);
    const lever = pumpHeat(house, 21.5, 3, 28, {lever: 0.104}, undefined);
    assert.ok(deep < lever, `${deep} < ${lever}`);
});

test('while hot water has the compressor the house gets nothing, and the pump catches up after', () => {
    const fc = forecast().map((s, k) => ({...s, price: 1, busy: k >= 8 && k < 16}));
    const free = simulate(house, 21.5, {ti: start.ti, tm: start.tm, curve: 3, bias: 0}, forecast().map((s) => ({...s, price: 1})),
        new Array(96).fill(0));
    const run = simulate(house, 21.5, {ti: start.ti, tm: start.tm, curve: 3, bias: 0}, fc, new Array(96).fill(0));
    for (let k = 8; k < 16; k++) assert.equal(run.heat[k], 0, `no heat in slot ${k}`);
    assert.ok(run.ti[15] < free.ti[15] - 0.05, 'the house cools during the charge');
    // Degree minutes: the heat missed is delivered afterwards, so the day's heat is the same.
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum(run.heat) - sum(free.heat)) < 0.05 * sum(free.heat), `${sum(run.heat)} vs ${sum(free.heat)}`);
    assert.ok(run.heat[16] > free.heat[16], 'it catches up straight after');
    assert.deepEqual(withHotwater(forecast().slice(0, 2), [false, true]).map((s) => !!s.busy), [false, true]);
});

// A flat price, so the plan is about the thermostat, not the price. The house sits at 21.5 °C.
const flat = (): ShiftInput => input({curve: 3, forecast: Array.from({length: 96}, () => ({te: 3, sun: 0, price: 1}))});

test('Autopilot plans around the thermostat: a house below it is pre-heated, and Expected climbs to it', async () => {
    const {feed, state} = harness({plan: flat(), setpoint: 22.5});
    feed.start();
    await feed.cycle();
    assert.ok(feed.state.bias > 0, 'pre-heats: fed colder than the real outdoor temperature');
    assert.ok(state.writes[0] < 3);
    const indoor = feed.state.indoor!;
    assert.ok(indoor[indoor.length - 1] > 22.3, 'the expected path reaches the thermostat within the plan');
    assert.equal(feed.state.setpoint, 22.5);
    assert.equal(state.records[0].setpoint, 22.5, 'the shadow log carries the setpoint');
});

test('a house above the thermostat is eased off toward it', async () => {
    const {feed, state} = harness({plan: flat(), setpoint: 20.5});
    feed.start();
    await feed.cycle();
    assert.ok(feed.state.bias < 0 && state.writes[0] > 3, 'fed warmer, so the pump heats less');
});

test('live, the trim learns the level the curve misses; Simulated holds it', async () => {
    const live = harness({plan: flat(), setpoint: 22});
    live.feed.start();
    for (let i = 0; i < 8; i++) { live.advance(SLOT_MS); await live.feed.cycle(); }
    assert.ok(live.state.trim.integral > 0, 'the house mean sits 0.5 K below the thermostat: it learns a pre-heat');
    assert.ok(live.state.saves > 0, 'and it is kept across restarts');
    const sim = harness({plan: flat(), setpoint: 22, mode: 'test'});
    sim.feed.start();
    for (let i = 0; i < 8; i++) { await sim.feed.cycle(); sim.advance(SLOT_MS); }
    assert.equal(sim.state.trim.integral, 0);
    assert.equal(sim.state.writes.length, 0, 'and nothing is written');
});

test('without a thermostat the plan centres on the house\'s own level, as before', async () => {
    const {feed, state} = harness({plan: flat()});
    feed.start();
    await feed.cycle();
    assert.equal(feed.state.setpoint, undefined);
    assert.equal(state.writes[0], 3, 'a flat price and a house at its level: nothing to shift');
});

test('no outdoor temperature right after a start waits quietly, and is told if it lasts', async () => {
    const {OUTDOOR_GRACE_MS} = await import('../lib/autopilot/live');
    const {feed, state, advance} = harness({sensor: undefined, forecast: undefined});
    feed.start();
    await feed.cycle();
    assert.equal(feed.state.stopped, 'no_outdoor');
    assert.ok(!state.warnings.includes('no_outdoor'), 'the first sensor reading is still on its way');
    advance(OUTDOOR_GRACE_MS + 60_000);
    await feed.cycle();
    assert.ok(state.warnings.includes('no_outdoor'), 'still none after the start-up minutes: told');
});

test('the wait for the first outdoor reading after a start counts as starting up, not as a pause', async () => {
    const {OUTDOOR_GRACE_MS} = await import('../lib/autopilot/live');
    const {feed, state, advance} = harness({sensor: undefined, forecast: undefined});
    feed.start();
    await feed.cycle();
    assert.equal(feed.startingUp, true);
    assert.equal(feed.state.startingUp, true, 'the status and the widget see it');
    const told = state.changes;
    advance(OUTDOOR_GRACE_MS + 60_000);
    await feed.cycle();
    assert.equal(feed.startingUp, false, 'still none after the start-up minutes: a real pause');
    assert.equal(feed.state.startingUp, undefined);
    assert.ok(state.changes > told, 'the status is told, so it turns from Starting to Paused');
});

test('after a quick restart the plan carries on from the shift the pump still holds (2026-11-26)', async () => {
    // Real outdoor 3 °C; input 1 still shows the feed from before the restart, 2.5 K warmer.
    const {feed, state} = harness({input1: 0.5});
    feed.start();
    await feed.cycle();
    assert.ok(state.logs.some((l) => l.includes('still holds a 2.5 K shift')), state.logs.join('\n'));
    const fresh = harness();
    fresh.feed.start();
    await fresh.feed.cycle();
    assert.notDeepEqual(feed.state.biases, fresh.feed.state.biases, 'planned from the held shift, not from 0');
});

test('once the write has run out, input 1 is the wired sensor and nothing is carried on', async () => {
    const {feed, state} = harness({input1: 3.6});
    feed.start();
    await feed.cycle();
    const fresh = harness();
    fresh.feed.start();
    await fresh.feed.cycle();
    assert.ok(!state.logs.some((l) => l.includes('still holds')));
    assert.deepEqual(feed.state.biases, fresh.feed.state.biases);
});

test('the held shift is read once the first outdoor temperature is in, and only right after a start', async () => {
    const {feed, state, advance} = harness({input1: 0.5, sensor: undefined});
    feed.start();
    await feed.cycle();
    assert.equal(feed.state.stopped, 'no_outdoor');
    state.sensor = 3;
    advance(30_000);
    await feed.cycle();
    assert.equal(feed.state.stopped, undefined);
    assert.ok(state.logs.some((l) => l.includes('still holds a 2.5 K shift')), state.logs.join('\n'));
    // Past the write's 5 min the pump is on the wired sensor whatever input 1 shows.
    const late = harness({input1: 0.5, sensor: undefined});
    late.feed.start();
    await late.feed.cycle();
    late.state.sensor = 3;
    late.advance(SLOT_MS);
    await late.feed.cycle();
    assert.ok(!late.state.logs.some((l) => l.includes('still holds')));
});
