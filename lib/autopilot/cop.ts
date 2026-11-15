/** The pump's COP, learned from its own energy counters. Pure.
 *  Design: docs/autopilot-plan.md §13.
 *
 *  A heat pump's COP is a fraction of the Carnot COP between where it lifts heat from (the brine
 *  for ground source, the outdoor air for air source) and where it delivers it (the supply). The
 *  fraction η is near constant for one compressor over its working range, so one number learned
 *  from the counters gives the COP at any supply: what the planner needs to see that a pre-heat,
 *  which raises the supply, buys its heat at a worse COP than the same heat spread out.
 *
 *  The counters: produced (3821, total production) and used (3823, total consumption), both
 *  cumulative kWh. Over a stretch where the pump only heated the house (priority 1028 = heating,
 *  the immersion heater off), produced over used is the heating COP. 3823 steps unevenly
 *  (0.3–2.5 kWh seen on the S1155), so a window runs between two of its steps and needs a few kWh
 *  before its ratio means anything. Without 3821, the heating-only counter 1577 stands in: over a
 *  heating-only stretch the two count the same heat.
 *
 *  Each condenser and evaporator works a few K beyond the water it touches; `APPROACH_K` on each
 *  side keeps η near constant across lifts, where a bare Carnot COP of the water temperatures
 *  makes η fall as the lift shrinks. Defrost (air source) is not modelled yet: its cost lands in η. */
import {FLAG, Field, History} from './history';

/** What the planner prices heat at until a model is trusted. */
export const COP_FALLBACK = 3;
const KELVIN = 273.15;
export const APPROACH_K = 5;
/** The lift never counts as less than this, so a warm source never promises an absurd COP. */
const MIN_LIFT_K = 15;
export const COP_RANGE = [1, 8] as const;
/** A heating-only slot: at least this share of polls on heating, and the immersion heater off. */
const HEATING_SHARE = 0.95;
/** A window needs this much electricity between two steps of the consumption counter. */
export const MIN_USED_KWH = 2;
/** A long run is cut into windows of about this many slots, so days weigh by how much they ran. */
const WINDOW_SLOTS = 24;
/** A ground-source window: brine read in this share of its slots. */
const GROUND_SHARE = 0.8;
/** η outside this is a fit gone wrong (a counter reset, the wrong source), not a pump. */
const ETA_RANGE = [0.2, 0.8] as const;

// Trusted, after the house model's readiness (house.ts `readiness`): enough windows, on enough
// days, that agree with each other, and an η that has stopped moving.
export const TRUST_WINDOWS = 12;
export const TRUST_DAYS = 3;
/** Energy-weighted RMS of each window's η around the fit, as a share of it. */
export const TRUST_SPREAD = 0.15;
/** The last three days' own η within this of each other. */
export const TRUST_STABLE = 0.15;

export type CopSource = 'ground' | 'air';

export interface CopWindow {
    /** First and last slot whose electricity the window counts. */
    from: number;
    to: number;
    produced: number;
    used: number;
    /** The window's Carnot COP: per slot, weighted by electrical power where read. */
    carnot: number;
    /** Mean supply and source °C, for the log and tests. */
    supply: number;
    source: number;
    kind: CopSource;
}

export interface CopModel {
    /** The Carnot fraction. */
    eta: number;
    source: CopSource;
    /** Ground source: the brine temperature the planner prices with, °C (mean of the last day's
     *  heating). Brine moves over days, not hours, so it is held over the horizon. */
    brine?: number;
    windows: number;
    days: number;
    /** Energy-weighted relative RMS of the windows' η around `eta`. */
    spread: number;
    trusted: boolean;
    /** What trust still needs, for the log. */
    missing: ('windows' | 'days' | 'spread' | 'stability')[];
}

/** The Carnot COP for heating between `source` and `supply`, °C, with the approach on each side. */
export function carnotCop(supply: number, source: number): number {
    const hot = supply + APPROACH_K + KELVIN;
    const lift = Math.max(MIN_LIFT_K, supply - source + 2 * APPROACH_K);
    return hot / lift;
}

/** The COP at `supply` °C, with outdoor `te` °C as the source for air source. */
export function copAt(model: CopModel, supply: number, te: number): number {
    const source = model.source === 'ground' && model.brine !== undefined ? model.brine : te;
    const cop = model.eta * carnotCop(supply, source);
    return Math.min(COP_RANGE[1], Math.max(COP_RANGE[0], cop));
}

/** Heating-only windows from the history, each between two steps of the consumption counter. */
export function copWindows(history: History): CopWindow[] {
    const out: CopWindow[] = [];
    const slots = history.range();
    let run: {slot: number; v: Record<Field, number>}[] = [];
    const flush = () => {
        if (run.length > 1) out.push(...windowsOf(run));
        run = [];
    };
    let last: number | undefined;
    for (const slot of slots) {
        const v = history.get(slot)!;
        if (last !== undefined && slot !== last + 1) flush();
        last = slot;
        if (!heatingOnly(v)) {
            flush();
            continue;
        }
        run.push({slot, v});
    }
    flush();
    return out;
}

const produced = (v: Record<Field, number>) => (Number.isFinite(v.pmeter) ? v.pmeter : v.qmeter);

function heatingOnly(v: Record<Field, number>): boolean {
    if (v.flags & FLAG.partial) return false;
    if (!(v.aux < 0.05)) return false;
    // Since `heat` is recorded, the share of polls on heating; before it, no hot water and the
    // compressor running.
    const heating = Number.isFinite(v.heat) ? v.heat >= HEATING_SHARE : v.dhw < 0.05 && v.hz > 0;
    return heating && Number.isFinite(v.emeter) && Number.isFinite(produced(v)) && Number.isFinite(v.tsup);
}

/** A run of heating-only slots cut into windows that start and end on a step of 3823. The first
 *  slot of a run is only a reference: its step may hold electricity from before the run. */
function windowsOf(run: {slot: number; v: Record<Field, number>}[]): CopWindow[] {
    const out: CopWindow[] = [];
    let start: number | undefined;
    const last = lastStep(run);
    for (let i = 1; i < run.length; i++) {
        if (!(run[i].v.emeter > run[i - 1].v.emeter)) continue;
        if (start === undefined) {
            start = i;
            continue;
        }
        // Long enough and enough electricity to mean something, or the run's last step.
        if ((i - start < WINDOW_SLOTS || run[i].v.emeter - run[start].v.emeter < MIN_USED_KWH) && i !== last) continue;
        const w = windowBetween(run, start, i);
        if (w) out.push(w);
        start = i;
    }
    return out;
}

function lastStep(run: {v: Record<Field, number>}[]): number {
    for (let i = run.length - 1; i > 0; i--) if (run[i].v.emeter > run[i - 1].v.emeter) return i;
    return -1;
}

function windowBetween(run: {slot: number; v: Record<Field, number>}[], a: number, b: number): CopWindow | undefined {
    const used = run[b].v.emeter - run[a].v.emeter;
    const made = produced(run[b].v) - produced(run[a].v);
    if (!(used >= MIN_USED_KWH) || !(made > 0)) return undefined;
    const slots = run.slice(a + 1, b + 1);
    const ground = slots.filter((s) => Number.isFinite(s.v.tbrine)).length >= GROUND_SHARE * slots.length;
    const source = (v: Record<Field, number>) => (ground ? v.tbrine : v.te);
    const ok = slots.filter((s) => Number.isFinite(s.v.tsup) && Number.isFinite(source(s.v)));
    if (ok.length < slots.length / 2) return undefined;
    const weight = (v: Record<Field, number>) => (v.pw > 0 ? v.pw : 1);
    const total = ok.reduce((a, s) => a + weight(s.v), 0);
    const mean = (f: (v: Record<Field, number>) => number) => ok.reduce((a, s) => a + weight(s.v) * f(s.v), 0) / total;
    return {
        from: slots[0].slot, to: slots[slots.length - 1].slot, produced: made, used,
        carnot: mean((v) => carnotCop(v.tsup, source(v))), supply: mean((v) => v.tsup), source: mean(source),
        kind: ground ? 'ground' : 'air',
    };
}

const DAY_SLOTS = 96;

/** η over windows: heat made over what a pump at η = 1 would have made from the same electricity. */
function etaOf(windows: CopWindow[]): number {
    return windows.reduce((a, w) => a + w.produced, 0) / windows.reduce((a, w) => a + w.carnot * w.used, 0);
}

/** The Carnot fraction from the windows, and whether it is trusted yet. Undefined without a
 *  window, or with an η no pump has. */
export function fitCop(all: CopWindow[], brine?: number): CopModel | undefined {
    if (!all.length) return undefined;
    // One kind of source: a pump that reads brine is ground source, whatever an odd window says.
    const source: CopSource = all.filter((w) => w.kind === 'ground').length * 2 >= all.length ? 'ground' : 'air';
    const windows = all.filter((w) => w.kind === source);
    const eta = etaOf(windows);
    if (!(eta >= ETA_RANGE[0] && eta <= ETA_RANGE[1])) return undefined;
    const usedTotal = windows.reduce((a, w) => a + w.used, 0);
    const spread = Math.sqrt(windows.reduce((a, w) => a + w.used * (w.produced / (w.carnot * w.used) / eta - 1) ** 2, 0) / usedTotal);
    const byDay = new Map<number, CopWindow[]>();
    for (const w of windows) {
        const day = Math.floor(w.to / DAY_SLOTS);
        byDay.set(day, [...byDay.get(day) ?? [], w]);
    }
    const lastDays = [...byDay.keys()].sort((a, b) => a - b).slice(-3).map((d) => etaOf(byDay.get(d)!));
    const stable = lastDays.length === 3 && Math.max(...lastDays) / Math.min(...lastDays) - 1 <= TRUST_STABLE;
    const missing: CopModel['missing'] = [];
    if (windows.length < TRUST_WINDOWS) missing.push('windows');
    if (byDay.size < TRUST_DAYS) missing.push('days');
    if (!(spread <= TRUST_SPREAD)) missing.push('spread');
    if (!stable) missing.push('stability');
    const ground = source === 'ground' && brine !== undefined;
    // Ground source without a brine reading to plan with can't price a slot: not trusted.
    if (source === 'ground' && !ground && !missing.length) missing.push('windows');
    return {eta, source, ...(ground ? {brine} : {}), windows: windows.length, days: byDay.size, spread,
        trusted: missing.length === 0, missing};
}

/** The brine temperature to plan with: mean over the last day's heating-only slots, else the
 *  last reading. */
export function planningBrine(history: History): number | undefined {
    const slots = history.range();
    const recent = slots.slice(-DAY_SLOTS).map((s) => history.get(s)!).filter((v) => heatingOnly(v) && Number.isFinite(v.tbrine));
    if (recent.length) return recent.reduce((a, v) => a + v.tbrine, 0) / recent.length;
    for (let i = slots.length - 1; i >= 0; i--) {
        const t = history.get(slots[i])!.tbrine;
        if (Number.isFinite(t)) return t;
    }
    return undefined;
}

export function copFromHistory(history: History): CopModel | undefined {
    return fitCop(copWindows(history), planningBrine(history));
}

/** One line for the app log. */
export function copLine(model: CopModel | undefined): string {
    if (!model) return 'COP learning';
    const at = model.source === 'ground' ? `brine ${model.brine?.toFixed(1) ?? '?'} °C` : 'air source';
    return `COP ${model.eta.toFixed(2)} of Carnot (${at}, ${model.windows} windows over ${model.days} days, ±${(model.spread * 100).toFixed(0)} %)`
        + (model.trusted ? '' : `, not trusted yet: ${model.missing.join(', ')}`);
}
