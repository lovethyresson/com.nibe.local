/** The Hot water tank widget's chart (widgets/hotwater_tank): two panels on one time axis, from
 *  local midnight to 06:00 tomorrow, so the night's planned charge is on it. On top the litres in
 *  the tank, read behind now and planned from now; under it the litres used today, running total
 *  against a usual day. The charges, done and planned, run along the bottom. Pure; the device
 *  gathers the inputs and translates, the widget only draws. */
import {TankView} from './hotwater-shadow';
import {ChargeBand, niceAxis} from './widget';

export interface TankChart {
    /** Litres of 40 °C water per slot: read up to now (hourly readings joined), planned from now. */
    read: (number | undefined)[];
    plan: (number | undefined)[];
    /** Running litres used today and expected by a usual day, as [slot, litres] at each hour's end;
     *  the used line ends at now. */
    used: [number, number][];
    expected: [number, number][];
    usedTotal: number;
    expectedTotal: number;
    /** Each panel's scale: top and gridlines. */
    tankAxis: {max: number; gridlines: number[]};
    useAxis: {max: number; gridlines: number[]};
}

/** Readings this many slots apart or closer are joined; a longer gap stays a gap. */
const JOIN_SLOTS = 6;

/** The readings with the gaps between near ones filled in a straight line: Insights keeps today
 *  hourly, one reading every fourth slot. Pure. */
export function joinReadings(read: (number | undefined)[]): (number | undefined)[] {
    const out = [...read];
    let last = -1;
    read.forEach((v, k) => {
        if (v === undefined) return;
        if (last >= 0 && k - last > 1 && k - last <= JOIN_SLOTS)
            for (let j = last + 1; j < k; j++) out[j] = Math.round(read[last]! + (v - read[last]!) * (j - last) / (k - last));
        last = k;
    });
    return out;
}

/** The chart for `view`, whose slots start at local midnight; `now` is the slot now and `today`
 *  how many slots today has (96, or 92 and 100 on the clock changes). */
export function tankChart(view: TankView, now: number, today: number): TankChart {
    const joined = joinReadings(view.read);
    const read = joined.map((v, k) => (k <= now ? v : undefined));
    const plan = view.plan.map((v, k) => (k >= now ? v : undefined));
    // The plan starts at the slot it was made in; draw it from the reading now so the lines meet.
    if (read[now] !== undefined) plan[now] = read[now];
    const hours = Math.ceil(today / 4), nowHour = Math.floor(now / 4);
    const used: [number, number][] = [[0, 0]], expected: [number, number][] = [[0, 0]];
    let u = 0, e = 0;
    for (let h = 0; h < hours; h++) {
        e += view.forecast[h] ?? 0;
        expected.push([Math.min(today, (h + 1) * 4), Math.round(e)]);
        if (h < nowHour) { u += view.drawn[h] ?? 0; used.push([(h + 1) * 4, Math.round(u)]); }
    }
    // The hour now so far ends the used line at now.
    u += view.drawn[nowHour] ?? 0;
    if (now > nowHour * 4) used.push([now, Math.round(u)]);
    const tank = niceAxis(0, Math.max(100, ...[...read, ...plan].map((v) => v ?? 0)), {steps: [50, 100, 200]});
    const use = niceAxis(0, Math.max(100, u, e), {steps: [100, 200, 250, 500]});
    return {read, plan, used, expected, usedTotal: Math.round(u), expectedTotal: Math.round(e),
        tankAxis: {max: tank.hi, gridlines: tank.ticks}, useAxis: {max: use.hi, gridlines: use.ticks}};
}

/** Everything the widget draws, translated. Without `chart` it shows `empty`, or the loading state. */
export interface TankWidgetData {
    title: string;
    badge?: string;
    empty?: string;
    loading?: boolean;
    status?: string;
    reason?: string;
    chart?: TankChart;
    /** Slots on the axis, the slot now, and the hours to label at their slots. */
    slots?: number;
    now?: number;
    ticks?: {at: number; label: string}[];
    /** Charges along the bottom: done part muted, planned part full. */
    bands?: ChargeBand[];
    reserve?: number;
    labels?: {tank: string; used: string; usual: string; reserve: string};
    legend?: {done: string; planned: string};
}
