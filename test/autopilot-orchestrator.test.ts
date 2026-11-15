import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    PumpRound, deliveryFree, heatingWindows, mainStatusText, preheatAdders, preheatSlots, spanText, statusEvents,
} from '../lib/autopilot/orchestrator';
import {PlanSlot, plan, reserveKwh} from '../lib/autopilot/hotwater-planner';
import {PROFILE_LIMITS, ShiftInput, planLive, withHotwater} from '../lib/autopilot/live';
import {ForecastSlot, steadyState} from '../lib/autopilot/planner';
import {SLOT_MS} from '../lib/autopilot/prices';
import {RADIATOR_HOUSE} from './autopilot-house-sim';

const S0 = 2_000_000; // an arbitrary slot, so absolute slots are exercised
const at = (k: number) => (S0 + k) * SLOT_MS;

// The hot water planner's S1155 fixture (autopilot-hotwater-planner.test.ts).
const tank = {litres: 176, inletC: 10};
const charge = {heatPerHour: 6, cop: 2.9, copPerK: -0.02, atTop: 48, samples: 50};
const loss = {base: 0.03, perKwh: 0.01, samples: 50};
const price = (h: number) => h < 6 ? 1.9 : h >= 11 && h < 15 ? 2.2 : h >= 16 && h < 21 ? 3.3 : 2.7;
const evening = (h: number) => h === 6 ? 1.6 : h >= 18 && h <= 21 ? 1.6 : 0;
const day = (adders: number[] = [], over: (k: number) => Partial<PlanSlot> = () => ({})): PlanSlot[] =>
    Array.from({length: 96}, (_, k) => ({price: price(Math.floor(k / 4)), draw: evening(Math.floor(k / 4)) / 4,
        adder: adders[k] || undefined, ...over(k)}));
const hwInput = (slots: PlanSlot[], stored = reserveKwh(80)) =>
    ({slots, stored, charging: false, tank, charge, loss, reserve: reserveKwh(60), minC: 45, maxC: 60});
const inside = (c: {start: number; end: number}, set: Set<number>) => {
    for (let k = c.start; k < c.end; k++) if (set.has(k)) return true;
    return false;
};

test('a charge holds the compressor from its start to its end, slot by slot', () => {
    assert.deepEqual(deliveryFree([{at: at(2), minutes: 45}], S0, 6), [false, false, true, true, true, false]);
    // A charge starting mid-slot still takes that slot.
    assert.deepEqual(deliveryFree([{at: at(1) + 60_000, minutes: 10}], S0, 3), [false, true, false]);
    assert.deepEqual(deliveryFree([], S0, 2), [false, false]);
});

test('heating\'s plan reads as pre-heat and ease-off stretches from now on', () => {
    const plan = {slot: S0, biases: [0, 1, 2, 1, 0, -1, -2, 0, 3]};
    assert.deepEqual(heatingWindows(plan, S0), [
        {kind: 'preheat', start: S0 + 1, end: S0 + 4}, {kind: 'ease', start: S0 + 5, end: S0 + 7}, {kind: 'preheat', start: S0 + 8, end: S0 + 9}]);
    // From slot 2 on, the first stretch is cut at now.
    assert.deepEqual(heatingWindows(plan, S0 + 2)[0], {kind: 'preheat', start: S0 + 2, end: S0 + 4});
});

test('hot water\'s own charge slots never count as pre-heat against it', () => {
    const plan = {slot: S0, biases: [2, 2, 2, 2, 2, 2]};
    const set = preheatSlots(plan, [{at: at(2), minutes: 30}], S0);
    assert.deepEqual([...set].sort((a, b) => a - b), [S0, S0 + 1, S0 + 4, S0 + 5]);
});

test('a pre-heat slot costs the day\'s spread on top, so it is never the cheapest place for a charge', () => {
    const slots = [S0, S0 + 1, S0 + 2, S0 + 3];
    assert.deepEqual(preheatAdders(slots, [1, 3, 2, 2], new Set([S0])), [2, 0, 0, 0]);
    assert.deepEqual(preheatAdders(slots, [1, 3, 2, 2], undefined), [0, 0, 0, 0]);
    // Flat prices: a token adder, so a pre-heat slot still loses the tie.
    assert.ok(preheatAdders(slots, [1, 1, 1, 1], new Set([S0 + 1]))[1] > 0);
});

test('a charge moves out of heating\'s pre-heat, and the reserve still holds', () => {
    const free = plan(hwInput(day()));
    assert.ok(free.charges.length >= 1);
    // Heating pre-heats over the night the charge would take.
    const preheat = new Set<number>();
    for (const c of free.charges) for (let k = c.start; k < c.end; k++) preheat.add(k);
    const adders = preheatAdders(day().map((_, k) => k), day().map((s) => s.price), preheat);
    const moved = plan(hwInput(day(adders)));
    assert.ok(moved.charges.length >= 1);
    for (const c of moved.charges) assert.ok(!inside(c, preheat), `charge at slot ${c.start} still in the pre-heat`);
    assert.equal(moved.shortfall, 0, 'the reserve holds');
});

test('a charge stays in a pre-heat when there is nowhere else to put it', () => {
    const all = new Set(day().map((_, k) => k));
    const adders = preheatAdders([...all], day().map((s) => s.price), all);
    const free = plan(hwInput(day()));
    const boxed = plan(hwInput(day(adders)));
    assert.deepEqual(boxed.charges.map((c) => c.start), free.charges.map((c) => c.start));
    assert.equal(boxed.shortfall, 0);
    // The adder moves the plan, never the costs it reports: what a charge costs is bought at the
    // run's own prices.
    for (const c of boxed.charges) {
        const prices = day().slice(c.start, c.end).map((x) => x.price);
        assert.ok(c.cost <= c.electricity * Math.max(...prices) + 1e-9 && c.cost >= c.electricity * Math.min(...prices) - 1e-9,
            `${c.cost} for ${c.electricity} kWh at ${prices}`);
    }
});

test('the safety net wins: under the reserve it charges now, inside a pre-heat or a reserved slot', () => {
    const adders = new Array(96).fill(5);
    for (const over of [{}, {reserved: true}] as Partial<PlanSlot>[]) {
        const p = plan({...hwInput(day(adders, (k) => (k === 0 ? over : {})), reserveKwh(20)), topC: 38});
        assert.ok(p.rescue, 'rescue');
        assert.ok(p.startNow, `starts now (${JSON.stringify(over)})`);
        assert.equal(p.charges[0].start, 0);
    }
});

test('heating pre-heats around a charge the round hands it, and plans no heat during it', () => {
    const house = RADIATOR_HOUSE;
    const te = -5;
    const s = steadyState(house, 21.5, te);
    const round = new PumpRound();
    round.setHotwater([{at: at(24), minutes: 120}]);
    const forecast: ForecastSlot[] = Array.from({length: 96}, (_, k) => ({te, sun: 0, price: k >= 40 && k < 56 ? 3 : 1}));
    const input = (fc: ForecastSlot[]): ShiftInput =>
        ({house, lever: 0.5 * house.heatLoss, ti: s.ti, tm: s.tm, mean: 21.5, curve: te, bias: 0, forecast: fc});
    const busy = round.deliveryFree(S0, 96)!;
    assert.deepEqual(busy.map((b, k) => b ? k : -1).filter((k) => k >= 0), [24, 25, 26, 27, 28, 29, 30, 31]);
    const blind = planLive(input(forecast), PROFILE_LIMITS.comfortable);
    const aware = planLive(input(withHotwater(forecast, busy)), PROFILE_LIMITS.comfortable);
    for (let k = 24; k < 32; k++) assert.equal(aware.plan.heat[k], 0, `no heat planned in slot ${k}`);
    const preheat = (biases: number[]) => biases.slice(20, 28).reduce((sum, b) => sum + Math.max(0, b), 0);
    assert.ok(preheat(aware.biases) > preheat(blind.biases),
        `pre-heats into the charge: ${aware.biases.slice(20, 28)} against ${blind.biases.slice(20, 28)} blind`);
    // Heating's plan goes back into the round: hot water then sees that pre-heat, less its own charge.
    round.setHeating({slot: S0, biases: aware.biases});
    const set = round.preheat(S0)!;
    for (let k = 24; k < 32; k++) assert.ok(!set.has(S0 + k), `charge slot ${k} is not a pre-heat to hot water`);
    assert.ok(set.size > 0);
});

test('heating hears of moved charges only when the slots it loses change', () => {
    const round = new PumpRound();
    let heard = 0, changed = 0;
    const off = round.onCharges(() => heard++);
    round.onChange(() => changed++);
    round.setHotwater([{at: at(4), minutes: 60}]);
    round.setHotwater([{at: at(4), minutes: 60}]);
    round.setHotwater([{at: at(8), minutes: 60}]);
    assert.equal(heard, 2);
    assert.equal(changed, 3);
    off();
    round.setHotwater(undefined);
    assert.equal(heard, 2);
    assert.equal(round.deliveryFree(S0, 2), undefined, 'no reservations once hot water stops');
});

test('a failing round plans with no reservations, and Main says so', () => {
    const round = new PumpRound();
    round.setHeating({slot: S0, biases: [1, 1]});
    // A plan that cannot be read: a charge list that throws when walked.
    (round as any).hotwater = {plan: {some() { throw new Error('boom'); }}, simulated: false};
    assert.equal(round.deliveryFree(S0, 2), undefined);
    assert.equal(round.status(at(0))!.failed, true);
    round.setHotwater([]);
    assert.deepEqual(round.deliveryFree(S0, 2), [false, false]);
    assert.equal(round.status(at(0))!.failed, undefined, 'the next answer that works clears it');
});

test('the round per host is shared by its devices and separate across pumps', () => {
    assert.equal(PumpRound.for('10.0.0.1'), PumpRound.for('10.0.0.1'));
    assert.notEqual(PumpRound.for('10.0.0.1'), PumpRound.for('10.0.0.2'));
});

const t = (key: string, tokens?: Record<string, string | number>) => {
    const en: Record<string, string> = {
        'first.hotwater': 'Hot water __time__', 'first.hotwater_now': 'Hot water now', 'first.preheat': 'Heating pre-heats __span__',
        'first.ease': 'Heating eases off __span__', 'then.hotwater': 'then hot water __time__', 'then.hotwater_now': 'then hot water now',
        'then.preheat': 'then heating pre-heats __span__', 'then.ease': 'then heating eases off __span__', none: 'Nothing planned',
        failed: 'Hot water and heating plan apart for now', test: 'Simulation: __text__'};
    return en[key].replace(/__(\w+)__/g, (_, k) => String(tokens?.[k]));
};
const hhmm = (ms: number) => {
    const m = Math.round((ms - at(0)) / 60_000) + 13 * 60;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const text = (s: Parameters<typeof mainStatusText>[0]) => mainStatusText(s, t, hhmm, (a, b) => spanText(a, b, hhmm));

test('Main reads what runs next and why: "Hot water 13:15, then heating eases off 17–20"', () => {
    const biases = new Array(32).fill(0);
    for (let k = 16; k < 28; k++) biases[k] = -2;
    const events = statusEvents([{at: at(1), minutes: 90}], {slot: S0, biases}, at(0));
    assert.equal(text({events}), 'Hot water 13:15, then heating eases off 17–20');
    // A charge running now comes first, whatever starts sooner.
    biases[0] = 1;
    assert.equal(text({events: statusEvents([{at: at(-1), minutes: 60}], {slot: S0, biases}, at(0))}),
        'Hot water now, then heating pre-heats 13:00–13:15');
    assert.equal(text({events: []}), 'Nothing planned');
    assert.equal(text({events: [], failed: true}), 'Hot water and heating plan apart for now');
    assert.equal(text({events, simulated: true}), 'Simulation: Hot water 13:15, then heating eases off 17–20');
});

test('a round with only test runs reads as a simulation, a live one does not', () => {
    const round = new PumpRound();
    assert.equal(round.status(at(0)), undefined);
    round.setHotwater([{at: at(1), minutes: 30}], true);
    assert.equal(round.status(at(0))!.simulated, true);
    round.setHeating({slot: S0, biases: [0]}, false);
    assert.equal(round.status(at(0))!.simulated, undefined);
});
