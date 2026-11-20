/** The Gateway's Insights log store (docs/external-io.md, step 5). Every `insights.getLogEntries`
 *  goes through it, so no feature asks Homey for a log it already has:
 *  - Homey says in each answer when its next point will exist (`updatesIn`); until then the stored
 *    log is the answer, also after an app restart or a system update (logs are kept in /userdata).
 *  - A 14-day log is brought up to date with the 7-day window, which has the same hourly points,
 *    and trimmed to its 14 days.
 *  - Disk is capped: each log holds only its own window, a log nobody asked for in 7 days is
 *    deleted, and past the total budget the least recently used go first. */

import {createHash} from 'crypto';

const DAY = 24 * 60 * 60_000;
/** A resolution brought up to date by a shorter one with the same step (measured on an S1155's
 *  Homey, 2026-11-20: last7Days and last14Days are both hourly). */
export const GAP_SOURCE: Record<string, {source: string; windowMs: number; sourceWindowMs: number}> = {
    last14Days: {source: 'last7Days', windowMs: 14 * DAY, sourceWindowMs: 7 * DAY},
};
export const UNUSED_MS = 7 * DAY;
export const DISK_BUDGET_BYTES = 5_000_000;
const INDEX = 'insights-index.json';

export interface LogArgs {uri: string; id: string; resolution: string; [key: string]: unknown}
interface Point {t: string; v: number | null}
interface Stored {id: string; resolution: string; step?: number; values: Point[]; fetchedAt: number; updatesIn: number}
interface IndexRow {file: string; usedAt: number; bytes: number}

export interface LogStoreDeps {
    now(): number;
    load(name: string): Promise<any>;
    save(name: string, value: unknown): Promise<void>;
    remove(name: string): Promise<void>;
    log(...args: any[]): void;
}

export class LogStore {
    private index?: Record<string, IndexRow>;
    private asks = new Map<string, Promise<any>>();
    fetches = 0;
    served = 0;

    constructor(private readonly deps: LogStoreDeps) {}

    /** The log for these arguments: stored while Homey has nothing newer, else fetched (only the
     *  gap where a shorter window can supply it) and stored. */
    async entries(args: LogArgs, fetch: (args: LogArgs) => Promise<any>, priority = 2): Promise<any> {
        const key = `${args.id}|${args.resolution}`;
        // Shared only within a priority: an owner never waits on background work's request.
        const askKey = `${key}|${priority}`;
        const ask = this.asks.get(askKey);
        if (ask) return ask;
        const run = this.answer(key, args, fetch).finally(() => this.asks.delete(askKey));
        this.asks.set(askKey, run);
        return run;
    }

    private async answer(key: string, args: LogArgs, fetch: (args: LogArgs) => Promise<any>): Promise<any> {
        const index = await this.loadIndex();
        const now = this.deps.now();
        // Read from disk each time, never held in memory: a log is small to read, and a hundred
        // kept as objects is not (the app was stopped for memory, 2026-11-20).
        const stored: Stored | undefined = index[key] ? await this.deps.load(index[key].file).catch(() => undefined) : undefined;
        if (index[key]) index[key].usedAt = now;
        if (stored && now < stored.fetchedAt + Math.max(0, stored.updatesIn)) {
            this.served++;
            return view(stored, now);
        }
        const gap = GAP_SOURCE[args.resolution];
        const newest = stored?.values.length ? Date.parse(stored.values[stored.values.length - 1].t) : NaN;
        let next: Stored;
        this.fetches++;
        if (gap && stored && Number.isFinite(newest) && now - newest < gap.sourceWindowMs - (stored.step ?? 0)) {
            const fresh = await fetch({...args, resolution: gap.source});
            const byTime = new Map(stored.values.map((p) => [p.t, p]));
            for (const p of fresh?.values ?? []) byTime.set(p.t, p);
            // Homey's window starts at a whole step (fetched at 12:18, last14Days began 14 days
            // back at 12:00), so the trimmed log matches what a full fetch would return.
            const step = fresh?.step ?? stored.step ?? 0;
            const from = (step > 0 ? Math.floor(now / step) * step : now) - gap.windowMs;
            next = {id: args.id, resolution: args.resolution, step: fresh?.step ?? stored.step, fetchedAt: now,
                updatesIn: Number(fresh?.updatesIn) || 0,
                values: [...byTime.values()].filter((p) => Date.parse(p.t) >= from).sort((a, b) => Date.parse(a.t) - Date.parse(b.t))};
        } else {
            const full = await fetch(args);
            next = {id: args.id, resolution: args.resolution, step: full?.step, fetchedAt: now,
                updatesIn: Number(full?.updatesIn) || 0, values: Array.isArray(full?.values) ? full.values : []};
        }
        await this.keep(key, next).catch((error) => this.deps.log('Gateway: Insights log not stored:', error?.message ?? error));
        return view(next, now);
    }

    private async loadIndex(): Promise<Record<string, IndexRow>> {
        this.index ??= (await this.deps.load(INDEX).catch(() => undefined)) ?? {};
        return this.index!;
    }

    private writing: Promise<void> = Promise.resolve();

    /** Store one log, then drop what nobody uses and anything past the budget. One write at a
     *  time: two would share the index's temporary file. */
    private keep(key: string, stored: Stored): Promise<void> {
        const write = this.writing.then(() => this.write(key, stored));
        this.writing = write.catch(() => undefined);
        return write;
    }

    private async write(key: string, stored: Stored) {
        const index = await this.loadIndex();
        const file = `insights-${createHash('sha1').update(key).digest('hex').slice(0, 16)}.json`;
        const bytes = JSON.stringify(stored).length;
        await this.deps.save(file, stored);
        index[key] = {file, usedAt: this.deps.now(), bytes};
        const now = this.deps.now();
        const rows = Object.entries(index).sort((a, b) => b[1].usedAt - a[1].usedAt);
        let total = 0;
        for (const [k, row] of rows) {
            total += row.bytes;
            if (now - row.usedAt > UNUSED_MS || total > DISK_BUDGET_BYTES) {
                delete index[k];
                await this.deps.remove(row.file).catch(() => undefined);
            }
        }
        await this.deps.save(INDEX, index);
    }

    /** Bytes kept on disk, for the Gateway's hourly line. */
    diskBytes(): number {
        return Object.values(this.index ?? {}).reduce((a, r) => a + r.bytes, 0);
    }
}

/** What Homey's answer looked like, from what is stored. */
function view(stored: Stored, now: number) {
    return {step: stored.step, values: stored.values, updatesIn: Math.max(0, stored.fetchedAt + stored.updatesIn - now)};
}
