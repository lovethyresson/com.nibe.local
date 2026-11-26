// TEMP(tank trace): a per-minute log of the tank and the house water meter, for the litres
// investigation (tasks/hotwater-estimate-ground-truth.md, step 1). Reads only. Remove before the
// release is packaged.
//
// Insights keeps 5-minute detail for a day only, and a draw is 5-15 minutes, so the ground truth
// has to be kept here. One line a minute, a month kept:
// /userdata/tank-trace-<pump>.jsonl, served at http://<homey>/app/com.nibe.local/userdata/….

import {appendLine, trimLines} from './store-file';

export const TRACE_EVERY_MS = 60_000;
/** A month of minutes. */
export const TRACE_KEEP = 31 * 24 * 60;
/** Trim once a day, not every line. */
const TRIM_EVERY = 24 * 60;

export interface TraceHooks {
    /** The pump's values as last polled, already scaled; undefined where not read. */
    pump(): Record<string, number | undefined>;
    /** The water meter: litres on its counter and the flow, or undefined without one. */
    water(): Promise<{litres?: number; flow?: number} | undefined>;
    log(...args: any[]): void;
    now(): number;
    setInterval(fn: () => void, ms: number): any;
    clearInterval(timer: any): void;
}

/** One line, the numbers rounded to what the sensors resolve. Pure. */
export function traceLine(at: number, pump: Record<string, number | undefined>,
    water: {litres?: number; flow?: number} | undefined): Record<string, number | string> {
    const line: Record<string, number | string> = {t: new Date(at).toISOString()};
    for (const [key, value] of Object.entries(pump))
        if (typeof value === 'number' && Number.isFinite(value)) line[key] = Math.round(value * 100) / 100;
    if (water?.litres !== undefined && Number.isFinite(water.litres)) line.water = Math.round(water.litres * 10) / 10;
    if (water?.flow !== undefined && Number.isFinite(water.flow)) line.flow = Math.round(water.flow * 100) / 100;
    return line;
}

export class TankTrace {
    private timer: any;
    private lines = 0;
    private busy = false;
    private failed = false;

    constructor(private readonly name: string, private readonly hooks: TraceHooks) {}

    start() {
        if (this.timer) return;
        this.hooks.log(`Tank trace (test only): /userdata/${this.name}, a line a minute.`);
        // Also at each start: a relaunch resets the line count the daily trim waits for.
        trimLines(this.name, TRACE_KEEP).catch(() => undefined);
        this.timer = this.hooks.setInterval(() => { this.tick().catch(() => undefined); }, TRACE_EVERY_MS);
    }

    stop() {
        if (this.timer) this.hooks.clearInterval(this.timer);
        this.timer = undefined;
    }

    async tick() {
        if (this.busy) return;
        this.busy = true;
        try {
            const water = await this.hooks.water().catch(() => undefined);
            await appendLine(this.name, traceLine(this.hooks.now(), this.hooks.pump(), water));
            if (++this.lines % TRIM_EVERY === 0) await trimLines(this.name, TRACE_KEEP);
            this.failed = false;
        } catch (error: any) {
            // Told once per run of failures, not every minute.
            if (!this.failed) this.hooks.log('Tank trace: write failed:', error?.message ?? error);
            this.failed = true;
        } finally {
            this.busy = false;
        }
    }
}
