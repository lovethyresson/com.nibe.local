import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MAX_WARMUP_SLOTS, PROFILE_LIMITS, ShiftInput, planComfort, planLive, setpointPath, warmUpSlots, warmingUp} from '../lib/autopilot/live';
import {ForecastSlot, simulate, steadyState} from '../lib/autopilot/planner';
import {SLOT_MS} from '../lib/autopilot/prices';
import {awayEnded, localDateTime, readAwayUntil} from '../lib/autopilot/away';
import {PeriodWatch, periodDue, pricePeriods, startedTrigger} from '../lib/autopilot/heating-flows';
import {heatingStatus} from '../lib/autopilot/heating-status';
import {FeedSnapshot} from '../lib/autopilot/live';
import {RADIATOR_HOUSE, SLAB_HOUSE} from './autopilot-house-sim';

// ---- Warm-up before Away ends ----

test('the setpoint path steps up at the first slot that ends at the return', () => {
    const slot = 1000;
    const at = (slot + 10) * SLOT_MS; // the end of slot 9
    assert.deepEqual(setpointPath(17, slot, 12, {at, setpoint: 21}),
        {setpoints: [17, 17, 17, 17, 17, 17, 17, 17, 17, 21, 21, 21], firmFrom: 9});
    // Mid-slot: the slot that holds the return is already at the home setpoint.
    assert.deepEqual(setpointPath(17, slot, 4, {at: (slot + 2.5) * SLOT_MS, setpoint: 21}), {setpoints: [17, 17, 21, 21], firmFrom: 2});
    assert.equal(setpointPath(17, slot, 12, undefined), 17, 'no end time: one setpoint');
    assert.equal(setpointPath(17, slot, 12, {at: (slot + 40) * SLOT_MS, setpoint: 21}), 17, 'past the horizon: nothing yet');
    assert.deepEqual(setpointPath(17, slot, 3, {at: (slot - 5) * SLOT_MS, setpoint: 21}), {setpoints: [21, 21, 21], firmFrom: 0}, 'already past');
});

const AWAY = 17;
const HOME = 21;
const TE = 2;
// Cheap nights, an expensive morning and evening: the warm-up should lean on the cheap hours.
const priceAt = (k: number) => {
    const hour = (k / 4) % 24;
    return hour < 6 ? 0.5 : (hour >= 7 && hour < 10) || (hour >= 17 && hour < 20) ? 3 : 1.5;
};
const forecast = (n: number, from = 0): ForecastSlot[] => Array.from({length: n}, (_, k) => ({te: TE, sun: 0, price: priceAt(from + k)}));

/** Run the planner closed loop over a simulated house, replanning each slot as the feed does, from
 *  the house settled at the Away temperature, with Away ending at slot `back`. Returns indoor per
 *  slot and the bias fed. The house the plan runs on is the same model, so this checks the plan
 *  carries through, not the model. */
function warmUp(house: typeof RADIATOR_HOUSE, back: number, horizon = 96) {
    let {ti, tm} = steadyState(house, AWAY, TE);
    let curve = TE;
    let bias = 0;
    let previous: number[] | undefined;
    let warming = false;
    const indoor: number[] = [];
    const fed: number[] = [];
    for (let slot = 0; slot < back + 8; slot++) {
        const fc = forecast(horizon, slot);
        const input: ShiftInput = {house, lever: 0.5 * house.heatLoss, ti, tm, mean: slot < back ? AWAY : HOME,
            curve, bias, forecast: fc, previous};
        // Away plans with the widest range (device.ts: limits are Save more while away). After the
        // return the home's Comfort range takes over. What the plan aims at is composed as the feed does.
        const limits = slot < back ? PROFILE_LIMITS.save_most : PROFILE_LIMITS.comfortable;
        const comfort = planComfort(input, limits, slot < back ? AWAY : HOME, slot, slot < back ? {at: back * SLOT_MS, setpoint: HOME} : undefined,
            warming);
        warming = warmingUp(comfort);
        const plan = planLive({...input, comfort}, limits);
        bias = plan.biases[0];
        previous = plan.biases.slice(1);
        const step = simulate(house, comfort, {ti, tm, curve, bias}, fc.slice(0, 1), [bias], {lever: 0.5 * house.heatLoss});
        ti = step.ti[0];
        tm = step.tm[0];
        curve = step.curveEnd;
        indoor.push(ti);
        fed.push(bias);
    }
    return {indoor, fed};
}

const startInput = (house: typeof RADIATOR_HOUSE): ShiftInput => {
    const {ti, tm} = steadyState(house, AWAY, TE);
    return {house, lever: 0.5 * house.heatLoss, ti, tm, mean: AWAY, curve: TE, bias: 0, forecast: forecast(96)};
};

test('the warm-up lead comes from the house: a slab needs longer than the horizon shows', () => {
    const radiator = warmUpSlots(startInput(RADIATOR_HOUSE), PROFILE_LIMITS.save_most, AWAY, HOME);
    const slab = warmUpSlots(startInput(SLAB_HOUSE), PROFILE_LIMITS.save_most, AWAY, HOME);
    assert.ok(radiator > 0 && radiator < slab, `radiator ${radiator}, slab ${slab} slots`);
    assert.ok(slab > 96, 'more than the 24 h horizon: without a lead the slab house would be late');
    assert.equal(warmUpSlots({...startInput(RADIATOR_HOUSE), ti: HOME}, PROFILE_LIMITS.save_most, AWAY, HOME), 0, 'already warm');
    assert.equal(warmUpSlots(startInput(RADIATOR_HOUSE), {...PROFILE_LIMITS.save_most, maxBias: 0}, AWAY, HOME), MAX_WARMUP_SLOTS,
        'no pre-heat allowed: never');
    // The step lands at the horizon's end once the lead reaches the return, and not before.
    assert.equal(setpointPath(AWAY, 0, 96, {at: 200 * SLOT_MS, setpoint: HOME}, 150), AWAY);
    assert.deepEqual((setpointPath(AWAY, 0, 96, {at: 200 * SLOT_MS, setpoint: HOME}, 210) as {firmFrom: number}).firmFrom, 95);
});

for (const [name, house] of [['radiator', RADIATOR_HOUSE], ['slab', SLAB_HOUSE]] as const) {
    test(`a ${name} house is back at the setpoint when Away ends`, () => {
        const back = 96 * 4; // four days ahead: beyond the horizon, and the lead, at first
        const lead = warmUpSlots(startInput(house), PROFILE_LIMITS.save_most, AWAY, HOME);
        const {indoor, fed} = warmUp(house, back);
        if (process.env.DBG) console.log(name, lead, fed.join(','), indoor.filter((_, k) => k % 8 === 7).map((v) => v.toFixed(1)).join(' '));
        assert.ok(indoor[back - 1] >= HOME - 0.2, `indoor at the return ${indoor[back - 1].toFixed(2)} °C`);
        assert.ok(indoor[back - 1] <= HOME + 1, `not overheated for it: ${indoor[back - 1].toFixed(2)} °C`);
        const early = Math.max(0, back - lead - 8 * 4);
        assert.ok(Math.max(...indoor.slice(0, early)) < AWAY + 1, 'no warm-up long before it is needed');
        // Where the warm-up has a choice, it takes the cheap hours: less shift in the expensive ones.
        const window = fed.slice(back - 96, back).map((b, i) => ({b, p: priceAt(back - 96 + i)}));
        const avg = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / Math.max(1, xs.length);
        assert.ok(avg(window.filter((w) => w.p === 0.5).map((w) => w.b)) >= avg(window.filter((w) => w.p === 3).map((w) => w.b)),
            'leans on the cheap hours');
    });
}

test('without an end time Away keeps the house at its own temperature', () => {
    let {ti, tm} = steadyState(RADIATOR_HOUSE, AWAY, TE);
    const plan = planLive({house: RADIATOR_HOUSE, lever: 0.5 * RADIATOR_HOUSE.heatLoss, ti, tm, mean: AWAY, curve: TE, bias: 0,
        forecast: forecast(96)}, PROFILE_LIMITS.save_most);
    assert.ok(Math.max(...plan.plan.ti) < AWAY + 1, 'no warm-up');
});

test('the status names the return while it pre-heats for it', () => {
    const slot0 = 1_000_000;
    const t = (key: string, tokens?: Record<string, string | number>) =>
        key + (tokens ? `(${Object.entries(tokens).map(([k, v]) => `${k}=${v}`).join(',')})` : '');
    const time = (ms: number) => `s${ms / SLOT_MS - slot0}`;
    const s: FeedSnapshot = {mode: 'live', bias: 2, target: 2, slot: slot0, biases: [2, 2, 0, 0],
        forecast: [1, 1, 1, 5].map((price) => ({te: 3, sun: 0, price})), back: (slot0 + 3) * SLOT_MS};
    assert.equal(heatingStatus(s, slot0 * SLOT_MS, t, time).reason, 'preheating(until=s2), before(why=back(at=s3))');
});

test('Away\'s end time: stored, read and due', () => {
    assert.equal(readAwayUntil(undefined), undefined);
    assert.equal(readAwayUntil(null), undefined);
    assert.equal(readAwayUntil('x'), undefined);
    assert.equal(readAwayUntil(1_800_000_000_000), 1_800_000_000_000);
    assert.equal(awayEnded(undefined, 5), false);
    assert.equal(awayEnded(10, 5), false);
    assert.equal(awayEnded(10, 10), true);
});

test('a Flow card\'s date and time are read in the home\'s time zone', () => {
    assert.equal(localDateTime('24-12-2026', '18:30', 'Europe/Stockholm'), Date.UTC(2026, 11, 24, 17, 30));
    assert.equal(localDateTime('01-07-2026', '06:00', 'Europe/Stockholm'), Date.UTC(2026, 6, 1, 4, 0), 'summer time');
    assert.equal(localDateTime('1-7-2026', '6:00', 'UTC'), Date.UTC(2026, 6, 1, 6, 0));
    assert.equal(localDateTime('31-02-2026', '06:00', 'UTC'), undefined, 'no such day');
    assert.equal(localDateTime('2026-07-01', '06:00', 'UTC'), undefined);
    assert.equal(localDateTime('01-07-2026', '25:00', 'UTC'), undefined);
    assert.equal(localDateTime(undefined, '06:00', 'UTC'), undefined);
});

// ---- Price periods ----

const MIN = 60_000;

test('the periods are the status\'s peak and its mirror, from now on', () => {
    const slot = 1000;
    const prices = [2, 2, 1, 1, 2, 5, 5, 2];
    assert.deepEqual(pricePeriods(prices, slot, slot * SLOT_MS), [
        {kind: 'expensive', start: (slot + 5) * SLOT_MS, end: (slot + 7) * SLOT_MS},
        {kind: 'cheap', start: (slot + 2) * SLOT_MS, end: (slot + 4) * SLOT_MS},
    ]);
    // Two slots on: the plan's first slots are behind, as the status leaves them.
    const later = pricePeriods(prices, slot, (slot + 3) * SLOT_MS + MIN);
    assert.deepEqual(later.find((p) => p.kind === 'cheap'), {kind: 'cheap', start: (slot + 3) * SLOT_MS, end: (slot + 4) * SLOT_MS});
    assert.deepEqual(pricePeriods([1, 1, 1], slot, slot * SLOT_MS), [], 'flat prices: no period');
});

/** Every minute from `from` to `to`, which Flows (by minutes ahead) fired, and when. */
function run(watch: PeriodWatch, periods: () => {kind: 'expensive' | 'cheap'; start: number; end: number}[], from: number, to: number,
    leads: number[]) {
    const fired: {lead: number; at: number; kind: string}[] = [];
    for (let now = from; now <= to; now += MIN)
        for (const trigger of watch.check(periods(), now))
            for (const lead of leads) if (periodDue(trigger, lead)) fired.push({lead, at: now, kind: trigger.kind});
    return fired;
}

test('each Flow fires once per period, at its lead', () => {
    const start = 10 * 60 * MIN;
    const period = {kind: 'expensive' as const, start, end: start + 2 * 60 * MIN};
    const fired = run(new PeriodWatch(), () => [period], 0, start + 3 * 60 * MIN, [0, 30, 120]);
    assert.deepEqual(fired.map((f) => [f.lead, f.at]), [[120, start - 120 * MIN], [30, start - 30 * MIN]]);
    // 0 minutes would be the start itself, when the period has begun: nothing to warn of.
});

test('a period edge moving a slot does not fire it again', () => {
    const start = 10 * 60 * MIN;
    let shift = 0;
    const watch = new PeriodWatch();
    const periods = () => [{kind: 'cheap' as const, start: start + shift, end: start + shift + 60 * MIN}];
    const first = run(watch, periods, 0, start - 40 * MIN, [60]);
    assert.equal(first.length, 1);
    shift = 15 * MIN; // new prices: the cheap run now starts a slot later
    const again = run(watch, periods, start - 39 * MIN, start + 60 * MIN, [60]);
    assert.equal(again.length, 0);
});

test('a period that appears inside a Flow\'s lead fires it late, once; a restart fires nothing again', () => {
    const start = 10 * 60 * MIN;
    const watch = new PeriodWatch();
    let shown = false;
    const periods = () => (shown ? [{kind: 'expensive' as const, start, end: start + 60 * MIN}] : []);
    run(watch, periods, 0, start - 50 * MIN, [60]);
    shown = true; // tomorrow's prices land 49 minutes before the peak
    const late = run(watch, periods, start - 49 * MIN, start, [60, 30]);
    assert.deepEqual(late.map((f) => [f.lead, f.at]), [[60, start - 49 * MIN], [30, start - 30 * MIN]]);
    // After a restart the first check only learns what is there.
    const restarted = run(new PeriodWatch(), periods, start - 20 * MIN, start, [60, 30]);
    assert.equal(restarted.length, 0);
});

test('expensive and cheap fire on their own', () => {
    const watch = new PeriodWatch();
    const periods = () => [{kind: 'expensive' as const, start: 300 * MIN, end: 360 * MIN}, {kind: 'cheap' as const, start: 120 * MIN, end: 180 * MIN}];
    const fired = run(watch, periods, 0, 400 * MIN, [60]);
    assert.deepEqual(fired.map((f) => [f.kind, f.at]), [['cheap', 60 * MIN], ['expensive', 240 * MIN]]);
});

test('pre-heating and easing off fire on entering them, never on staying', () => {
    assert.equal(startedTrigger('holding', 'preheating'), 'preheating');
    assert.equal(startedTrigger('preheating', 'easing_off'), 'easing_off');
    assert.equal(startedTrigger('preheating', 'preheating'), undefined);
    assert.equal(startedTrigger('easing_off', 'holding'), undefined);
    assert.equal(startedTrigger(undefined, 'preheating'), undefined, 'the first status after a start is not a change');
    assert.equal(startedTrigger('paused', 'learning'), undefined);
});

test('a one-slot spike that moves a slot is still the same period', () => {
    const watch = new PeriodWatch();
    const start = 10 * 60 * MIN;
    let shift = 0;
    const periods = () => [{kind: 'expensive' as const, start: start + shift, end: start + shift + 15 * MIN}];
    const first = run(watch, periods, 0, start - 50 * MIN, [60]);
    assert.equal(first.length, 1);
    shift = 15 * MIN; // touches the old one, no longer overlaps it
    assert.equal(run(watch, periods, start - 49 * MIN, start + 30 * MIN, [60]).length, 0);
});

test('after a pause the first check only learns: moments in the gap do not all fire at once', () => {
    const watch = new PeriodWatch();
    const start = 10 * 60 * MIN;
    const periods = () => [{kind: 'cheap' as const, start, end: start + 60 * MIN}];
    run(watch, periods, 0, 60 * MIN, [120, 30]);
    watch.pause();
    const after = run(watch, periods, start - 60 * MIN, start, [120, 30]);
    assert.deepEqual(after.map((f) => f.lead), [30], 'the 2 h Flow fell in the pause; the 30 min one still fires on time');
});

test('the status names the day of a return that is not today', () => {
    const slot0 = 1_000_000;
    const t = (key: string, tokens?: Record<string, string | number>) =>
        key + (tokens ? `(${Object.entries(tokens).map(([k, v]) => `${k}=${v}`).join(',')})` : '');
    const s: FeedSnapshot = {mode: 'live', bias: 2, target: 2, slot: slot0, biases: [2, 2, 0, 0],
        forecast: [1, 1, 1, 5].map((price) => ({te: 3, sun: 0, price})), back: (slot0 + 300) * SLOT_MS};
    const reason = heatingStatus(s, slot0 * SLOT_MS, t, () => '18:00', undefined, () => 'Thu 18:00').reason;
    assert.match(reason, /back\(at=Thu 18:00\)/);
});
