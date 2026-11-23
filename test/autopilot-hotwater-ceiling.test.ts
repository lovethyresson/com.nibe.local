import {test} from 'node:test';
import assert from 'node:assert';
import {CEILING_WINDOW_MS, CeilingObservation, ChargeWatch, DEFAULT_CEILING_C, PollReading, ceilingFromHistory, learnCeiling,
    mergeObservations, targetCap, watchCharge} from '../lib/autopilot/hotwater-ceiling';
import {ChargeEvent, MAX_C, Translate, chargeText, immersionInCharge, recapLines} from '../lib/autopilot/hotwater-shadow';
import {PlanInput, PlanSlot, heatAt, plan, reserveKwh} from '../lib/autopilot/hotwater-planner';

const H = 3_600_000, DAY = 24 * H;
const NOW = Date.UTC(2026, 10, 15, 12);
const obs = (hoursAgo: number, c: number, kind: CeilingObservation['kind'], source: CeilingObservation['source'] = 'live'): CeilingObservation =>
    ({at: NOW - hoursAgo * H, c, kind, source});

test('the ceiling is 58 °C until something is learned, and the plan stays a degree under it', () => {
    const c = learnCeiling([], NOW);
    assert.deepStrictEqual(c, {c: DEFAULT_CEILING_C, maxC: 57, from: 'default'});
    assert.strictEqual(MAX_C, 57);
    assert.strictEqual(targetCap(57.6), 56);
});

test('an onset lowers the ceiling, a later charge that got above it on the compressor alone lifts it again', () => {
    assert.deepStrictEqual(learnCeiling([obs(48, 56.5, 'onset')], NOW), {c: 56.5, maxC: 55, from: 'onset'});
    // The lowest recent onset counts.
    assert.strictEqual(learnCeiling([obs(48, 57.5, 'onset'), obs(24, 56, 'onset')], NOW).c, 56);
    // A later clean end at 57 means the compressor gets past 56.5 now (a warmer brine).
    assert.strictEqual(learnCeiling([obs(48, 56.5, 'onset'), obs(10, 57, 'clean')], NOW).c, DEFAULT_CEILING_C);
    // A clean end before the onset says nothing about it.
    assert.strictEqual(learnCeiling([obs(48, 57, 'clean'), obs(10, 56.5, 'onset')], NOW).c, 56.5);
});

test('clean ends above the default raise the ceiling up to 60 °C; noise and old readings do not count', () => {
    assert.deepStrictEqual(learnCeiling([obs(5, 59.4, 'clean')], NOW), {c: 59.4, maxC: 58, from: 'clean'});
    assert.strictEqual(learnCeiling([obs(5, 63, 'clean')], NOW).c, 60);
    // An immersion heater on a cold tank is heating's or a degree-minute deficit, not the ceiling.
    assert.strictEqual(learnCeiling([obs(5, 35, 'onset')], NOW).c, DEFAULT_CEILING_C);
    // Older than the window.
    assert.strictEqual(learnCeiling([{at: NOW - CEILING_WINDOW_MS - H, c: 55, kind: 'onset', source: 'live'}], NOW).c, DEFAULT_CEILING_C);
});

test('merging replaces the history and keeps live observations', () => {
    const stored = [obs(30, 56, 'onset', 'history'), obs(20, 57, 'onset', 'live'), {junk: true} as any];
    const merged = mergeObservations(stored, [obs(1, 55, 'onset')], NOW, [obs(10, 58, 'clean', 'history')]);
    assert.deepStrictEqual(merged.map((o) => [o.source, o.c]), [['live', 57], ['history', 58], ['live', 55]]);
});

test('the poll watcher sees the immersion heater come on in a charge, and a clean end without it', () => {
    let w: ChargeWatch = {running: false};
    const seen: CeilingObservation[] = [];
    const step = (r: Omit<PollReading, 'at'>, minutes: number) => {
        const out = watchCharge(w, {at: NOW + minutes * 60_000, ...r});
        w = out.watch;
        if (out.observation) seen.push(out.observation);
    };
    // A charge from 40 to 57.3 °C, then the immersion heater, then it ends.
    step({charging: true, immersion: false, c: 40}, 0);
    step({charging: true, immersion: false, c: 57.3}, 60);
    step({charging: true, c: 57.4}, 61);              // 1029 not read this poll: no onset yet
    step({charging: true, immersion: true, c: 57.5}, 62);
    step({charging: true, immersion: true, c: 59}, 80);
    step({charging: false, immersion: false, c: 59}, 90);
    assert.deepStrictEqual(seen.map((o) => [o.kind, o.c]), [['onset', 57.5]], 'one onset, and no clean end after it');
    // The next charge stops on the compressor at 55.
    step({charging: true, immersion: false, c: 45}, 300);
    step({charging: true, immersion: false, c: 55}, 360);
    step({charging: undefined, c: 55}, 361);
    step({charging: false, c: 54.8}, 362);
    assert.deepStrictEqual(seen.map((o) => [o.kind, o.c]), [['onset', 57.5], ['clean', 55]]);
});

test('Insights history gives an onset where 1069 rose in a charge, a clean end where it did not', () => {
    const at = (h: number) => NOW - 48 * H + h * H;
    const points = [
        // Charge 1: 02–04, compressor only, BT6 up to 56.
        {t: at(1), produced: 100, aux: 10, charge: 20},
        {t: at(2), produced: 103, aux: 10, charge: 40},
        {t: at(3), produced: 106, aux: 10, charge: 52},
        {t: at(4), produced: 108, aux: 10, charge: 56},
        {t: at(5), produced: 108, aux: 10, charge: 55},
        // Charge 2: 13–15, the immersion heater for the last half hour.
        {t: at(13), produced: 108, aux: 10, charge: 47},
        {t: at(14), produced: 111, aux: 10, charge: 54},
        {t: at(15), produced: 113, aux: 10.5, charge: 58.4},
        {t: at(16), produced: 113, aux: 10.5, charge: 58},
        // Charge 3: the heater runs from a cold tank only (a degree-minute deficit): nothing learned.
        {t: at(30), produced: 113, aux: 10.5, charge: 15},
        {t: at(31), produced: 116, aux: 11, charge: 30},
        {t: at(32), produced: 116, aux: 11, charge: 30},
        // 6-hourly buckets are too coarse to tell anything.
        {t: at(38), produced: 116, aux: 11, charge: 40},
        {t: at(44), produced: 125, aux: 11.5, charge: 58},
    ];
    assert.deepStrictEqual(ceilingFromHistory(points).map((o) => [o.kind, o.c, (o.at - at(0)) / H]),
        [['clean', 56, 4], ['onset', 58.4, 15]]);
});

/** A translator that shows the key and its tokens, so a test can see what was said. */
const t: Translate = (key, tokens) => `${key}${tokens ? JSON.stringify(tokens) : ''}`;
const charge: ChargeEvent = {at: NOW - H, by: 'autopilot', reason: 'cheap', targetC: 57, minutes: 120, price: 1.5, meanPrice: 2,
    surplusShare: 0, litres: 60, top: 45, reserveLitres: 40, plan: 'as_planned'};

test('an immersion heater in an Autopilot charge is recorded on it, lowers the ceiling under its target and is said', () => {
    const out = immersionInCharge(charge, {at: NOW, c: 57.6}, [], NOW);
    // The compressor did not reach the 57 °C target, so the ceiling goes under it.
    assert.deepStrictEqual(out.ceiling, {c: 57, maxC: 56, from: 'onset'});
    assert.deepStrictEqual(out.event.immersion, {at: NOW, c: 57.6, capC: 56});
    assert.strictEqual(out.observations.length, 1);
    assert.strictEqual(charge.immersion, undefined, 'the stored event is not changed in place');
    const text = chargeText(out.event, t, () => '12:00', (v: number) => `${v.toFixed(2)} kr`);
    assert.ok(text.detailedReason.endsWith('plan.as_planned detail.immersion{"at":58,"cap":56}'), text.detailedReason);
    const recap = recapLines([out.event], t, () => '11:00', false, () => '2026-11-15', '2026-11-15');
    assert.ok(recap[1].endsWith('recap.immersion{"at":58}'), recap[1]);
    // The pump's own charge counts where the heater came on: it had no target of Autopilot's.
    const pump = immersionInCharge({...charge, by: 'pump', reason: 'pump', targetC: 60}, {at: NOW, c: 57.6}, [], NOW);
    assert.strictEqual(pump.ceiling.c, 57.6);
});

test('a charge without the immersion heater reads as before', () => {
    assert.ok(!chargeText(charge, t, () => '12:00', (v: number) => `${v.toFixed(2)} kr`).detailedReason.includes('immersion'));
});

// The S1155's tank, learned 2026-11-14: 6.5 kWh/h half empty, under 2 near full, 2.3 kW.
const tank = {litres: 176, inletC: 10};
const tankRate = {heatPerHour: 6.1, perKwh: -1.4, atStored: 7, producedPerHour: 6.5, kw: 2.3, cop: 2, copPerK: 0, atTop: 50, samples: 20};
const loss = {base: 0.03, perKwh: 0.01, samples: 50};
/** 24 h from midnight, `price` by hour, with a morning and an evening use (kWh heat). */
function useDay(morning: number, evening: number, price: (h: number) => number = () => 2): PlanSlot[] {
    return Array.from({length: 96}, (_, k) => {
        const h = Math.floor(k / 4);
        return {price: price(h), draw: (h === 7 ? morning : h === 19 ? evening : 0) / 4};
    });
}
const input = (slots: PlanSlot[], over: Partial<PlanInput> = {}): PlanInput => ({slots, stored: 2, topC: 50, charging: false,
    tank, charge: tankRate, loss, reserve: reserveKwh(40), minC: 45, maxC: 60, ...over});
const perKwh = (p: ReturnType<typeof plan>) =>
    p.charges.reduce((s, c) => s + c.electricity, 0) / p.charges.reduce((s, c) => s + c.heat, 0);

test('two cooler charges beat one at the ceiling: the plan prefers them even when a hot one is allowed', () => {
    // 9 kWh of use, about what a 58 °C tank holds. At one price all day, the plan could fill to
    // 60 °C at night, yet it charges twice and cooler, start cost and all: the tank fills slower
    // the fuller it is, so the last degrees cost far more electricity than a second charge.
    const split = plan(input(useDay(4, 5)));
    assert.strictEqual(split.shortfall, 0);
    assert.ok(split.charges.length >= 2, `two charges, got ${split.charges.map((c) => c.targetC)}`);
    assert.ok(split.charges.every((c) => c.targetC <= 55), `cooler: ${split.charges.map((c) => c.targetC)}`);
    // The hot alternative, forced by making the day dear: one charge to the top at night.
    const hot = plan(input(useDay(4, 5, (h) => h < 6 ? 2 : 20)));
    assert.strictEqual(hot.charges[0].targetC, 60);
    const night = hot.charges[0];
    assert.ok(perKwh(split) < night.electricity / night.heat,
        `two cooler ${perKwh(split).toFixed(2)} kWh el per kWh heat against ${(night.electricity / night.heat).toFixed(2)} for one to 60 °C`);
});

test('when the day needs more heat than fits under the cap, the plan charges twice and never past it', () => {
    // 11 kWh a day is more than the tank holds at 57 °C (9.6 kWh).
    const p = plan(input(useDay(5, 6), {maxC: 57}));
    assert.ok(heatAt(tank, 57) < 11);
    assert.strictEqual(p.shortfall, 0, 'nothing short');
    assert.ok(p.charges.length >= 2, `charges ${p.charges.map((c) => c.targetC)}`);
    assert.ok(p.charges.every((c) => c.targetC <= 57), 'never past the cap');
});
