import {test} from 'node:test';
import assert from 'node:assert';
import {
    DEFAULT_LOSS, KWH_PER_LITRE, TankPoint, chargeRate, readHousehold, starterProfiles, intervals, learn, learnCharge, learnLoss, localClock, lossAt, profileFor,
} from '../lib/autopilot/hotwater-learner';
import {fetchTankInsights, pointsFromInsights, RESOLUTIONS} from '../lib/autopilot/hotwater-insights';

const near = (actual: number, expected: number, tolerance: number, what: string) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: expected ${expected} ± ${tolerance}, got ${actual}`);

const HOUR = 3_600_000;
const clock = localClock('UTC');
const T0 = Date.UTC(2026, 9, 5); // a Monday, 00:00 UTC

/** A simulated tank, hourly: draws by hour, a charge whenever stored heat falls under 3 kWh and a
 *  night charge from 02:00 under 7 kWh (as Autopilot plans them, with no water running), a
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
        if (s < 1.5 || (hour === 2 && s < 9)) charging = true;
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

test('a charge model: the tank\'s own gain per hour of charging, and the electricity it takes', () => {
    // Night charges with nothing drawn show the rate; charges during draws only ever look slower.
    const points = simulate(28, (day, hour) => workingDay(hour));
    const charge = learnCharge(intervals(points))!;
    near(chargeRate(charge, 5), 5.5, 0.3, 'tank gain per hour');
    near(charge.producedPerHour!, 5.5, 0.01, 'heat counter per hour');
    assert.ok(charge.cop > 2.5 && charge.cop < 3.4, `COP ${charge.cop}`);
    assert.strictEqual(learnCharge([]), undefined);
});

test('the heat counter times how long a charge ran; the tank says what it stored, and the rest is no draw', () => {
    // The counter books 6 kWh an hour whatever the tank takes; the tank gains 6 kWh/h half empty and
    // under 2 near full. No water runs during the charges, so no draw may be booked.
    const points: TankPoint[] = [];
    let s = 2, produced = 0, used = 0;
    for (let h = 0; h < 24 * 14; h++) {
        const hour = h % 24, charging = hour >= 2 && hour < 6;
        points.push({t: T0 + h * HOUR, litres: s / KWH_PER_LITRE, produced, used, top: 40 + 2 * s});
        if (charging) { s = Math.min(10.5, s + Math.max(0.5, 6 - 0.6 * Math.max(0, s - 4))); produced += 6; used += 2; }
        if (hour === 19) s = Math.max(0.5, s - 6);
        s = Math.max(0.2, s - 0.05);
    }
    const charge = learnCharge(intervals(points))!;
    assert.ok(chargeRate(charge, 9) < chargeRate(charge, 3) - 1, `slower when fuller: ${chargeRate(charge, 3)} → ${chargeRate(charge, 9)}`);
    near(charge.kw!, 2, 0.01, 'electricity while charging');
    const night = intervals(points, DEFAULT_LOSS, charge).filter((i) => clock(i.start).hour >= 2 && clock(i.start).hour < 6);
    const booked = night.filter((i) => Number.isFinite(i.draw)).reduce((sum, i) => sum + i.draw, 0);
    assert.ok(booked < 0.1 * night.length, `night charges book ${booked} kWh drawn`);
    const old = intervals(points).filter((i) => clock(i.start).hour >= 2 && clock(i.start).hour < 6 && Number.isFinite(i.draw))
        .reduce((sum, i) => sum + i.draw, 0);
    assert.ok(old > 5 * Math.max(booked, 1), `the counter alone books ${old} kWh`);
});

test('near full the compressor slows and the tank takes little: that is the tank, not a draw', () => {
    // 2026-11-15 on the S1155: half empty the counter books 6.6 kWh an hour and the tank takes it;
    // near full the counter falls to about 2 and the tank takes 0.7. Daytime charges also run
    // while water is drawn, which only ever lowers an hour's gain. The fit must find the slow end,
    // and a near-full charging hour with nothing drawn must book (almost) no draw.
    const points: TankPoint[] = [];
    let s = 3, produced = 0, used = 0;
    for (let h = 0; h < 24 * 14; h++) {
        const hour = h % 24, charging = (hour >= 2 && hour < 5) || (hour >= 11 && hour < 14);
        points.push({t: T0 + h * HOUR, litres: s / KWH_PER_LITRE, produced, used, top: 40 + 2 * s});
        if (charging) {
            const near = s > 7;
            produced += near ? 2 : 6.6; used += near ? 1.4 : 2.3;
            s = Math.min(10.2, s + (near ? 0.7 : 6.2));
        }
        if (hour === 12 && h % 48 === 12) s = Math.max(0.5, s - 3);  // a shower during every other midday charge
        if (hour === 7 || hour === 19) s = Math.max(0.5, s - 4);
        s = Math.max(0.2, s - 0.05);
    }
    const charge = learnCharge(intervals(points))!;
    assert.ok(chargeRate(charge, 9.5) < 2.5, `near full: ${chargeRate(charge, 9.5)} kWh/h`);
    assert.ok(chargeRate(charge, 4) > 4.5, `half empty: ${chargeRate(charge, 4)} kWh/h`);
    const quiet = intervals(points, DEFAULT_LOSS, charge).filter((i) => {
        const hour = clock(i.start).hour;
        return hour >= 2 && hour < 5 && i.stored > 7 && Number.isFinite(i.draw);
    });
    assert.ok(quiet.length > 3, 'some near-full night hours');
    const booked = quiet.reduce((sum, i) => sum + i.draw, 0) / quiet.length;
    assert.ok(booked < 0.5, `a near-full charging hour books ${booked} kWh drawn on average`);
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

test('a day with its tank cold overnight still shapes its day type: each hour learns where it is known', () => {
    // Working days (Mon–Fri) whose tank reads under 40 °C from 00 to 05, so none is a full day;
    // weekends draw at midday and are full. Until 2026-11-21 the working-day shape was the pooled
    // one, weekend middays and all.
    const free = (day: number) => day % 7 >= 5;
    const points = simulate(14, (day, hour) => free(day) ? freeDay(hour) : workingDay(hour),
        {dayType: (day) => free(day) ? 'free' : 'working'})
        .map((p) => !free(Math.floor((p.t - T0) / (24 * HOUR))) && clock(p.t).hour < 5 ? {...p, litres: 0} : p);
    const model = learn(points, clock, points[points.length - 1].t);
    const working = model.profiles.working!;
    near(working.hours[12], 0, 0.2, 'no midday on a working day');
    near(working.hours[6], 1.6, 0.4, 'the morning shower');
    near(working.hours[19], 1.5, 0.4, 'the evening');
    assert.ok(model.profiles.free!.hours[12] > 1, 'free days keep their midday');
});

test('per-weekday evenings: a busy weekday stands out once it has days of its own, shrunk until then', () => {
    // T0 is a Monday. Tuesdays draw twice the evening of the other working days.
    const free = (day: number) => day % 7 >= 5;
    const tuesday = (day: number) => day % 7 === 1;
    const draw = (day: number, hour: number) => free(day) ? freeDay(hour) : workingDay(hour) * (tuesday(day) && hour >= 18 ? 2 : 1);
    const kind = {dayType: (day: number) => (free(day) ? 'free' : 'working') as 'free' | 'working'};
    const long = simulate(70, draw, kind);
    const ev = learn(long, clock, long[long.length - 1].t).evenings!;
    assert.ok(ev[2]!.mean > 1.5 * ev[1]!.mean, `Tuesday ${ev[2]!.mean} vs Monday ${ev[1]!.mean}`);
    const short = simulate(10, draw, kind);
    const young = learn(short, clock, short[short.length - 1].t).evenings!;
    assert.ok(young[2]!.mean < ev[2]!.mean, 'with two Tuesdays it leans on the working-day evening');
});

test('an evening that empties the tank counts, with its draw at least, instead of being left out', () => {
    // Tuesdays draw hard at 19 and the tank reads empty (litres 0) from 20 until midnight.
    const free = (day: number) => day % 7 >= 5;
    const tuesday = (day: number) => day % 7 === 1;
    // One bath that empties the tank at 19; nothing after it (the tank is cold).
    const draw = (day: number, hour: number) => free(day) ? freeDay(hour)
        : tuesday(day) && hour >= 19 ? (hour === 19 ? 8 : 0) : workingDay(hour);
    const points = simulate(70, draw, {dayType: (day) => (free(day) ? 'free' : 'working')})
        .map((p) => {
            const day = Math.floor((p.t - T0) / (24 * HOUR)), hour = clock(p.t).hour;
            return tuesday(day) && hour >= 20 ? {...p, litres: 0, top: 35} : p;
        });
    const model = learn(points, clock, points[points.length - 1].t);
    const ev = model.evenings!;
    assert.ok(ev[2]!.days > 3, `Tuesdays counted: ${ev[2]!.days} days`);
    // At least what the tank held: never learned lighter than a Monday that did not empty it.
    assert.ok(ev[2]!.mean > ev[1]!.mean, `Tuesday ${ev[2]!.mean} vs Monday ${ev[1]!.mean}`);
    assert.ok(model.profiles.working!.hours[19] > 1.5, `the emptying hour is not learned light: ${model.profiles.working!.hours[19]}`);
});

test('a tank cold from before the evening is unmet demand: that evening is left out, not learned light', () => {
    // Thursdays read empty from 15:00, before any evening draw: nothing says what the evening wanted.
    const free = (day: number) => day % 7 >= 5;
    const thursday = (day: number) => day % 7 === 3;
    const points = simulate(70, (day, hour) => free(day) ? freeDay(hour) : workingDay(hour),
        {dayType: (day) => (free(day) ? 'free' : 'working')})
        .map((p) => (thursday(Math.floor((p.t - T0) / (24 * HOUR))) && clock(p.t).hour >= 15 ? {...p, litres: 0, top: 35} : p));
    const ev = learn(points, clock, points[points.length - 1].t).evenings!;
    assert.strictEqual(ev[4]!.days, 0, 'no Thursday evening of its own');
    assert.ok(Math.abs(ev[4]!.mean - ev[1]!.mean) < 0.5, `leans on the working evening: ${ev[4]!.mean} vs ${ev[1]!.mean}`);
});

test('litres 0 with the top still hot is a bad reading, not an emptied tank', () => {
    const spans = intervals([{t: 0, litres: 200, produced: 10, top: 55}, {t: HOUR, litres: 0, produced: 10, top: 54}]);
    assert.strictEqual(spans[0].drawAtLeast, undefined);
    const real = intervals([{t: 0, litres: 200, produced: 10, top: 55}, {t: HOUR, litres: 0, produced: 10, top: 36}]);
    assert.ok(real[0].drawAtLeast! > 5);
});

test('part days alone make no profile: a total needs full days or a starting point', () => {
    // Every day reads empty 00–05: no full day at all.
    const points = simulate(14, (day, hour) => workingDay(hour)).map((p) => (clock(p.t).hour < 5 ? {...p, litres: 0, top: 35} : p));
    const model = learn(points, clock, points[points.length - 1].t);
    assert.strictEqual(model.profiles.any, undefined);
    assert.strictEqual(model.profiles.working, undefined);
});

test('the local clock follows the time zone across the autumn change', () => {
    const stockholm = localClock('Europe/Stockholm');
    // 25 Oct 2026: clocks go back at 03:00 CEST = 01:00 UTC.
    assert.deepStrictEqual(stockholm(Date.UTC(2026, 9, 24, 23, 30)), {date: '2026-10-25', hour: 1, minute: 30});
    assert.deepStrictEqual(stockholm(Date.UTC(2026, 9, 25, 1, 30)), {date: '2026-10-25', hour: 2, minute: 30});
    assert.deepStrictEqual(stockholm(Date.UTC(2026, 9, 25, 22, 30)), {date: '2026-10-25', hour: 23, minute: 30});
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
