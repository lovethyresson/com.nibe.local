import {test} from 'node:test';
import assert from 'node:assert';
import {
    DEFAULT_LOSS, KWH_PER_LITRE, TankPoint, copAt, readHousehold, starterProfiles, intervals, learn, learnCharge, learnLoss, localClock, lossAt, profileFor,
} from '../lib/autopilot/hotwater-learner';
import {fetchTankInsights, pointsFromInsights, RESOLUTIONS} from '../lib/autopilot/hotwater-insights';

const near = (actual: number, expected: number, tolerance: number, what: string) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: expected ${expected} ± ${tolerance}, got ${actual}`);

const HOUR = 3_600_000;
const clock = localClock('UTC');
const T0 = Date.UTC(2026, 9, 5); // a Monday, 00:00 UTC

/** A simulated tank, hourly: draws by hour, a charge whenever stored heat falls under 3 kWh, a
 *  standing loss of `base + perKwh × stored`, and COP falling 0.02 per K of tank top. */
function simulate(days: number, draw: (day: number, hour: number) => number,
                  opts: {base?: number; perKwh?: number; dayType?: (day: number) => TankPoint['dayType']} = {}) {
    const {base = 0.05, perKwh = 0.005} = opts;
    const points: TankPoint[] = [];
    let s = 8, produced = 1000, used = 300, charging = false;
    for (let h = 0; h <= days * 24; h++) {
        const day = Math.floor(h / 24), hour = h % 24;
        const top = 40 + 2 * s;
        points.push({t: T0 + h * HOUR, litres: s / KWH_PER_LITRE, produced, used, top, dayType: opts.dayType?.(day)});
        if (s < 3) charging = true;
        const q = charging ? Math.min(5.5, 10.5 - s) : 0;
        if (charging && s + q >= 10) charging = false;
        const cop = 3.4 - 0.02 * (top - 40);
        s = Math.max(0.2, s + q - draw(day, hour) - (base + perKwh * s));
        produced += q; used += q / cop;
    }
    return points;
}

const workingDay = (hour: number) => hour === 6 ? 1.6 : hour >= 18 && hour <= 21 ? 1.5 : 0;
const freeDay = (hour: number) => hour >= 9 && hour <= 20 ? 1.4 : 0;

test('a draw is the fall in stored heat plus what was produced, less standing loss', () => {
    const points: TankPoint[] = [
        {t: 0, litres: 200, produced: 10},
        {t: HOUR, litres: 150, produced: 10},       // 50 L drawn, nothing charged
        {t: 2 * HOUR, litres: 250, produced: 15},   // charged 5 kWh, of which 100 L stayed
    ];
    const loss = {base: 0.1, perKwh: 0, samples: 0};
    const [a, b] = intervals(points, loss);
    near(a.draw, 50 * KWH_PER_LITRE - 0.1, 1e-9, 'plain draw');
    near(b.draw, 15 - 100 * KWH_PER_LITRE - 0.1 - 10 + 0, 1e-9, 'draw during a charge');
    near(b.produced, 5, 1e-9, 'produced');
});

test('a top below 40 °C (litres 0) or a counter reset gives no draw rather than a wrong one', () => {
    const spans = intervals([
        {t: 0, litres: 0, produced: 10},
        {t: HOUR, litres: 100, produced: 12},
        {t: 2 * HOUR, litres: 90, produced: 0}, // counter went backwards: dropped
    ]);
    assert.strictEqual(spans.length, 1);
    assert.ok(Number.isNaN(spans[0].draw));
});

test('standing loss is recovered from quiet nights, including how it grows with stored heat', () => {
    const points = simulate(28, (day, hour) => workingDay(hour), {base: 0.04, perKwh: 0.008});
    const loss = learnLoss(points, clock);
    near(loss.base + loss.perKwh * 9, 0.04 + 0.008 * 9, 0.02, 'loss at 9 kWh stored');
    assert.ok(loss.samples >= 6);
    assert.deepStrictEqual(learnLoss(points.slice(0, 3), clock), DEFAULT_LOSS, 'too little: the default');
});

test('a charge model: heat per full hour, COP, and COP falling with tank temperature', () => {
    const points = simulate(28, (day, hour) => workingDay(hour) + freeDay(hour) * 0.3);
    const charge = learnCharge(intervals(points))!;
    near(charge.heatPerHour, 5.5, 0.01, 'heat per hour');
    assert.ok(charge.cop > 2.5 && charge.cop < 3.4, `COP ${charge.cop}`);
    assert.ok(charge.copPerK < 0, 'COP falls as the tank gets hotter');
    assert.ok(copAt(charge, 60) < copAt(charge, 45));
    assert.strictEqual(learnCharge([]), undefined);
});

test('working and free days learn their own shapes; the pooled profile covers unset days', () => {
    // Weekdays working, weekends free, as the owner's Flow would set them.
    const type = (day: number): 'free' | 'working' => day % 7 >= 5 ? 'free' : 'working';
    const points = simulate(42, (day, hour) => type(day) === 'free' ? freeDay(hour) : workingDay(hour), {dayType: type});
    const model = learn(points, clock, points[points.length - 1].t);
    const working = model.profiles.working!, free = model.profiles.free!;
    near(working.daily, 1.6 + 4 * 1.5, 0.6, 'working day total');
    near(free.daily, 12 * 1.4, 1.2, 'free day total');
    assert.ok(working.hours[6] > 1 && free.hours[6] < 0.5, 'a working morning peak only');
    assert.ok(free.hours[13] > 1 && working.hours[13] < 0.3, 'a free midday only');
    assert.strictEqual(profileFor(model, 'away'), undefined, 'nothing is planned for away');
    assert.strictEqual(profileFor(model, undefined), model.profiles.any);
});

test('away days stay out of the profiles: set by the owner, or a day with almost no draw', () => {
    const points = simulate(21, (day, hour) => day === 10 || day === 11 ? 0 : workingDay(hour),
        {dayType: (day) => day === 11 ? 'away' : undefined});
    const model = learn(points, clock, points[points.length - 1].t);
    assert.deepStrictEqual(model.away.sort(), ['2026-10-15', '2026-10-16']);
    near(model.profiles.any!.daily, 1.6 + 4 * 1.5, 0.6, 'the typical day is not dragged down');
});

test('a day type with little history leans on the pooled profile', () => {
    // Free days: one labelled day only, drawing far more than the rest.
    const points = simulate(28, (day, hour) => day === 26 ? 3 * freeDay(hour) : workingDay(hour),
        {dayType: (day) => day === 26 ? 'free' : undefined});
    const model = learn(points, clock, points[points.length - 1].t);
    const free = model.profiles.free!, any = model.profiles.any!;
    assert.ok(free.daily > any.daily && free.daily < 3 * 12 * 1.4, `shrunk: ${free.daily} between ${any.daily} and ${3 * 12 * 1.4}`);
});

test('the local clock follows the time zone across the autumn change', () => {
    const stockholm = localClock('Europe/Stockholm');
    // 25 Oct 2026: clocks go back at 03:00 CEST = 01:00 UTC.
    assert.deepStrictEqual(stockholm(Date.UTC(2026, 9, 24, 23, 30)), {date: '2026-10-25', hour: 1});
    assert.deepStrictEqual(stockholm(Date.UTC(2026, 9, 25, 1, 30)), {date: '2026-10-25', hour: 2});
    assert.deepStrictEqual(stockholm(Date.UTC(2026, 9, 25, 22, 30)), {date: '2026-10-25', hour: 23});
});

test('lossAt never goes negative', () => {
    assert.strictEqual(lossAt({base: -1, perKwh: 0, samples: 0}, 5), 0);
    near(lossAt(DEFAULT_LOSS, 10), 0.1, 1e-9, 'the default at a full tank');
});

test('Insights buckets become readings at their middle; finer resolutions win where they overlap', () => {
    const iso = (h: number) => new Date(T0 + h * HOUR).toISOString();
    const hourly = (from: number, n: number, f: (h: number) => number | null) =>
        ({step: HOUR, values: Array.from({length: n}, (_, k) => ({t: iso(from + k), v: f(from + k)}))});
    const sixHourly = (from: number, n: number, f: (h: number) => number) =>
        ({step: 6 * HOUR, values: Array.from({length: n}, (_, k) => ({t: iso(from + 6 * k), v: f(from + 6 * k)}))});
    const points = pointsFromInsights({
        litres: [hourly(48, 24, (h) => h === 50 ? null : 200), sixHourly(0, 12, () => 150)],
        produced: [hourly(48, 24, (h) => h), sixHourly(0, 12, (h) => h)],
    });
    assert.ok(points.every((p) => p.produced != null && p.litres != null), 'a reading needs both fields');
    assert.strictEqual(points.find((p) => p.t === T0 + 50.5 * HOUR), undefined, 'the null hour is left out');
    assert.ok(points.some((p) => p.t === T0 + 48.5 * HOUR && p.litres === 200), 'hourly, at the bucket middle');
    assert.ok(points.some((p) => p.t === T0 + 3 * HOUR && p.litres === 150), '6-hourly before the hourly span');
    assert.ok(!points.some((p) => p.litres === 150 && p.t > T0 + 45 * HOUR), 'no 6-hourly reading inside the hourly span');
    for (let k = 1; k < points.length; k++) assert.ok(points[k].t > points[k - 1].t, 'in time order');
});

test('fetchTankInsights asks for each field at every resolution and survives a failing log', async () => {
    const calls: any[] = [];
    const api = {insights: {getLogEntries: async (args: any) => {
        calls.push(args);
        if (args.id.endsWith(':meter_power.total')) throw new Error('Not Found');
        return {step: HOUR, values: []};
    }}};
    const logs = await fetchTankInsights(api, 'dev1', {litres: 'l', produced: 'p', used: 'meter_power.total', top: 't'});
    assert.strictEqual(calls.length, 4 * RESOLUTIONS.length);
    assert.deepStrictEqual(calls[0], {uri: 'homey:device:dev1', id: 'homey:device:dev1:l', resolution: 'last14Days', $timeout: 20_000});
    assert.deepStrictEqual(logs.used, RESOLUTIONS.map(() => ({})));
});

test('the household answers give a starting day: per person, a bigger free day, peaks where they were put', () => {
    const start = starterProfiles({people: 3, morningHour: 6, freeDay: 'daytime'});
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    near(start.working.daily, 7.5, 1e-9, 'working day, 2.5 kWh a person');
    near(start.free.daily, 11.25, 1e-9, 'free day 1.5x');
    near(sum(start.working.hours), start.working.daily, 1e-9, 'the hours make the day');
    near(start.any.daily, (5 * 7.5 + 2 * 11.25) / 7, 1e-9, 'pooled five to two');
    const peak = (xs: number[]) => xs.indexOf(Math.max(...xs));
    assert.strictEqual(peak(start.working.hours), 6);
    assert.ok(start.free.hours[12] > start.free.hours[6], 'a day off leans to midday');
    assert.ok(start.working.dailyP80 > start.working.daily && start.working.p80[6] > start.working.hours[6]);
});

test('a young history leans on the household; a long one is its own', () => {
    const household = {people: 4, morningHour: 7, freeDay: 'evening' as const};
    const young = simulate(2, (_, hour) => workingDay(hour));
    const leaned = learn(young, clock, young[young.length - 1].t, undefined, household).profiles.any!;
    const own = learn(young, clock, young[young.length - 1].t).profiles.any!;
    const prior = starterProfiles(household).any.daily;
    assert.ok(Math.abs(leaned.daily - prior) < Math.abs(own.daily - prior), 'pulled toward the answers');
    assert.ok(learn(young, clock, young[young.length - 1].t, undefined, household).profiles.free, 'a free day is planned before one is seen');
    const old = simulate(42, (_, hour) => workingDay(hour));
    const long = learn(old, clock, old[old.length - 1].t, undefined, household).profiles.any!;
    near(long.daily, 1.6 + 4 * 1.5, 0.6, 'six weeks of its own days outweigh the answers');
});

test('stored household answers are checked before use', () => {
    assert.deepStrictEqual(readHousehold({people: '3', morningHour: 6.4, freeDay: 'daytime'}), {people: 3, morningHour: 6, freeDay: 'daytime'});
    assert.strictEqual(readHousehold({people: 0, morningHour: 6}), undefined);
    assert.strictEqual(readHousehold(null), undefined);
    assert.strictEqual(readHousehold({people: 2, morningHour: 7, freeDay: 'nonsense'})?.freeDay, 'evening');
});
