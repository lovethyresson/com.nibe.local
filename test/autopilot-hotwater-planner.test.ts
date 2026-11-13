import {test} from 'node:test';
import assert from 'node:assert';
import {DEFAULT_RESERVE_LITRES, PlanInput, PlanSlot, SLOT_H, drawsFor, heatAt, plan, plannedHours, reserveKwh, tempOf} from '../lib/autopilot/hotwater-planner';
import {DayProfile} from '../lib/autopilot/hotwater-learner';

const near = (actual: number, expected: number, tolerance: number, what: string) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: expected ${expected} ± ${tolerance}, got ${actual}`);

// The S1155's numbers: 176 L tank, 6 kWh heat an hour, COP 2.9 at 48 °C falling 0.02 per K.
const tank = {litres: 176, inletC: 10};
const charge = {heatPerHour: 6, cop: 2.9, copPerK: -0.02, atTop: 48, samples: 50};
const loss = {base: 0.03, perKwh: 0.01, samples: 50};

/** 24 h from midnight, 15-min slots: price by hour, draw kWh per hour by hour. */
function day(price: (h: number) => number, draw: (h: number) => number, extra: (h: number) => Partial<PlanSlot> = () => ({})): PlanSlot[] {
    return Array.from({length: 96}, (_, k) => {
        const h = Math.floor(k / 4);
        return {price: price(h), draw: draw(h) / 4, ...extra(h)};
    });
}
const input = (slots: PlanSlot[], over: Partial<PlanInput> = {}): PlanInput => ({
    slots, stored: heatAt(tank, 45), charging: false, tank, charge, loss, reserve: reserveKwh(60), minC: 45, maxC: 60, ...over,
});
const hourOf = (slot: number) => Math.floor(slot / 4);

// Night cheap, a cheap midday, an expensive evening: the S1155's November shape.
const price = (h: number) => h < 6 ? 1.9 : h >= 11 && h < 15 ? 2.2 : h >= 16 && h < 21 ? 3.3 : 2.7;
const evening = (h: number) => h === 6 ? 1.6 : h >= 18 && h <= 21 ? 1.6 : 0;

test('heatAt and tempOf are inverses', () => {
    near(tempOf(tank, heatAt(tank, 55)), 55, 1e-9, 'round trip');
    near(heatAt(tank, 60), 176 * 50 * 4.186 / 3600, 1e-9, 'heat at 60 °C');
});

test('charges land in cheap hours before the peaks, never in the expensive evening', () => {
    const p = plan(input(day(price, evening)));
    assert.ok(p.charges.length >= 1);
    for (const c of p.charges)
        for (let k = c.start; k < c.end; k++) assert.ok(!(hourOf(k) >= 16 && hourOf(k) < 21), `charge in the evening at slot ${k}`);
    assert.strictEqual(p.shortfall, 0, 'the reserve holds');
    assert.ok(p.stored.every((s) => s >= reserveKwh(60) - 1e-6), 'never below the reserve');
});

test('the target follows what has to be covered: a bigger evening needs a hotter charge', () => {
    // Start near the reserve, so both evenings need a charge before them.
    const low = {stored: reserveKwh(80)};
    const small = plan(input(day(price, (h) => h >= 18 && h <= 19 ? 1.2 : 0), low));
    const big = plan(input(day(price, (h) => h >= 17 && h <= 21 ? 1.9 : 0), low));
    const lastBefore = (p: ReturnType<typeof plan>) => p.charges.filter((c) => hourOf(c.start) < 17).pop()!;
    assert.ok(lastBefore(big).targetC > lastBefore(small).targetC,
        `big ${lastBefore(big).targetC} °C vs small ${lastBefore(small).targetC} °C`);
    for (const c of [...small.charges, ...big.charges]) assert.ok(c.targetC >= 45 && c.targetC <= 60);
});

test('solar surplus pulls the charge into the sunny hours and makes it hotter', () => {
    const sunny = day(() => 2.5, evening, (h) => h >= 11 && h < 15 ? {surplusKw: 3, exportPrice: 0.6} : {});
    const p = plan(input(sunny));
    const midday = p.charges.find((c) => hourOf(c.start) >= 11 && hourOf(c.start) < 15);
    assert.ok(midday, 'a charge in the surplus');
    assert.ok(midday!.surplusShare > 0.9, `surplus share ${midday!.surplusShare}`);
    const cloudy = plan(input(day(() => 2.5, evening)));
    const hottest = (q: ReturnType<typeof plan>) => Math.max(...q.charges.map((c) => c.targetC));
    assert.ok(hottest(p) >= hottest(cloudy), 'surplus is stored hotter, never cooler');
    assert.ok(p.cost < cloudy.cost);
});

test('no charge starts in a reserved slot', () => {
    const slots = day(price, evening, (h) => h < 6 || (h >= 11 && h < 15) ? {reserved: true} : {});
    const p = plan(input(slots));
    for (const c of p.charges) assert.ok(!slots[c.start].reserved, `started in reserved slot ${c.start}`);
});

test('a charge already running goes on to the Large stop in force', () => {
    const p = plan(input(day(() => 3.3, () => 0), {charging: true, runningTargetC: 55, stored: heatAt(tank, 40)}));
    assert.strictEqual(p.charges[0].start, 0);
    near(p.charges[0].targetC, 55, 1, 'ends at the running stop');
    assert.strictEqual(p.startNow, false, 'nothing new to start');
});

test('a running charge ends at its stop instead of holding the tank there through the day\'s draws', () => {
    const p = plan(input(day(() => 2.7, evening), {charging: true, runningTargetC: 50, stored: heatAt(tank, 30)}));
    const run = p.charges[0];
    assert.strictEqual(run.start, 0);
    assert.ok(run.end <= 8, `ran until slot ${run.end}`);
    near(run.targetC, 50, 1, 'ends at the running stop');
});

test('a tank under the reserve charges now at any price; one above it waits for the hour it is needed', () => {
    const draws = (h: number) => h < 3 ? 2 : 0;
    const under = plan(input(day(() => 3.3, draws), {stored: reserveKwh(50)}));
    assert.ok(under.startNow, 'below the reserve: now');
    const above = plan(input(day(() => 3.3, draws), {stored: reserveKwh(80)}));
    assert.ok(above.charges[0].start < 4, 'within the hour');
    assert.strictEqual(above.shortfall, 0, 'and the reserve holds');
});

test('a small top-up waits for a proper charge', () => {
    // Prices flat, a slow trickle of draws: the plan would add a sliver now; it is not started.
    const p = plan(input(day(() => 2.5, () => 0.3), {stored: reserveKwh(66)}));
    if (p.charges[0]?.start === 0) assert.ok(p.charges[0].heat >= 4 || p.startNow === false);
});

test('a full tank and no draws: nothing to do', () => {
    const p = plan(input(day(price, () => 0), {stored: heatAt(tank, 58)}));
    assert.strictEqual(p.charges.length, 0);
    assert.strictEqual(p.startNow, false);
});

test('a hot top vouches for the reserve: a settling estimate is not rescued at a peak price', () => {
    // After the bath: the estimate under the reserve, the top still at 49 °C, a cheap slot later.
    const slots = day((h) => h < 3 ? 3.3 : 1.5, (h) => h === 20 ? 1.5 : 0);
    const low = {stored: reserveKwh(30), reserve: reserveKwh(DEFAULT_RESERVE_LITRES)};
    assert.ok(plan(input(slots, low)).startNow, 'trusting the estimate alone: charge now');
    const p = plan(input(slots, {...low, topC: 49}));
    assert.strictEqual(p.startNow, false, 'the top says the water is there: wait');
    assert.ok(p.charges.length >= 1 && hourOf(p.charges[0].start) >= 3, 'and charge when it is cheap');
    assert.ok(plan(input(slots, {...low, topC: 40})).startNow, 'a cold top: the reserve really is gone');
});

test('the reserve is on by default at about a shower, and 0 turns it off', () => {
    assert.strictEqual(DEFAULT_RESERVE_LITRES, 40);
    const p = plan(input(day(() => 3.3, () => 0), {stored: reserveKwh(10), reserve: 0}));
    assert.strictEqual(p.startNow, false, 'off: nothing bought at a peak to hold a floor');
});

/** A day with a morning and an evening peak whose hours sum past the day totals, as clipped
 *  hourly draws do (measured: 21.8 kWh of hours against a 13.9 kWh mean day). */
const noisyDay = (): DayProfile => {
    const hours = new Array(24).fill(0.4), p80 = new Array(24).fill(1.2);
    hours[7] = hours[19] = 3; p80[7] = p80[19] = 6;
    return {days: 20, hours, p80, daily: 14, dailyP80: 21};
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

test('a planned day adds up to between the mean day and the busy day, not to every hour busy at once', () => {
    const p = noisyDay();
    assert.ok(sum(p.hours) + 0.5 * sum(p.p80.map((v, h) => v - p.hours[h])) > 25, 'read hour by hour it plans over 25 kWh');
    const planned = plannedHours(p);
    assert.ok(Math.abs(sum(planned) - (14 + 0.5 * 7)) < 1e-9, `planned ${sum(planned)}`);
    assert.ok(Math.abs(sum(plannedHours(p, 0)) - 14) < 1e-9, 'blend 0 is the mean day');
    assert.ok(Math.abs(sum(plannedHours(p, 1)) - 21) < 1e-9, 'blend 1 is the busy day');
});

test('the planned draws keep the profile\'s shape: the peaks stay the peaks', () => {
    const planned = plannedHours(noisyDay());
    const order = planned.map((v, h) => [v, h]).sort((a, b) => b[0] - a[0]).map(([, h]) => h);
    assert.deepStrictEqual(order.slice(0, 2).sort((a, b) => a - b), [7, 19]);
});

test('without day totals the hours are planned as they are', () => {
    const p = {...noisyDay(), daily: NaN, dailyP80: NaN};
    assert.deepStrictEqual(plannedHours(p), p.hours.map((m, h) => m + 0.5 * (p.p80[h] - m)));
});

test('drawsFor gives each slot a quarter of its hour, and nothing on an away day', () => {
    const p = noisyDay(), planned = plannedHours(p);
    assert.deepStrictEqual(drawsFor([p, p, undefined], [7, 19, 7]), [planned[7] * SLOT_H, planned[19] * SLOT_H, 0]);
});
