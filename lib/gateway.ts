/** The Gateway: the one owner of what the app fetches from outside itself (docs/external-io.md).
 *  One Homey API client; paced lanes for the request families Homey refuses back to back
 *  (Insights, Energy), served by priority; a "too many requests" backoff per family; a quiet
 *  start for background work; and an hourly line of what was fetched.
 *
 *  Pump Modbus is not here: PumpConnection owns the wire. */

import {LogArgs, LogStore} from './gateway-insights';
import {deleteFile, loadJson, saveJson} from './autopilot/store-file';

export type Priority = 1 | 2 | 3;
/** 1: an owner is waiting (setup, Repair, a Flow card). 2: steers the pump now. 3: background. */
export const PRIORITY = {owner: 1, control: 2, background: 3} as const;

/** Families Homey refuses back to back, and the gap kept between two of their requests (from the
 *  end of one to the start of the next). One request at a time per family, by priority. */
export const LANE_GAP_MS: Record<string, number> = {insights: 2_000, energy: 2_000, web: 1_000};
export const INSIGHTS_GAP_MS = LANE_GAP_MS.insights;
/** After a start, background work waits this long, so a start is not one burst of requests. */
export const QUIET_START_MS = 5 * 60_000;
/** A "too many requests" pauses that family only: 20 s, then 1 min, then 5 min in a row. Other
 *  families (a room sensor read behind the BT50 feed, say) are never held by it. */
export const BACKOFF_MS = [20_000, 60_000, 300_000];
export const REPORT_EVERY_MS = 60 * 60_000;
/** The family of single-device reads (sensors): never backed off. */
export const SENSOR_FAMILY = 'sensor';

export interface GatewayDeps {
    createClient(): Promise<any>;
    now(): number;
    sleep(ms: number): Promise<void>;
    log(...args: any[]): void;
    /** Process memory, bytes (rss). */
    memory?(): number;
}

interface Stat {calls: number; failures: number; waitMs: number}
interface Waiter {priority: Priority; order: number; go: () => void}
interface Lane {busy: boolean; last: number; waiting: Waiter[]}
interface Backoff {until: number; step: number}

export class Gateway {
    private client?: Promise<any>;
    private readonly startedAt: number;
    private lanes = new Map<string, Lane>();
    private backoffs = new Map<string, Backoff>();
    private order = 0;
    private stats = new Map<string, Stat>();
    /** The Insights log store (gateway-insights.ts), when the app has one. */
    logs?: LogStore;
    private resets = 0;

    constructor(private readonly deps: GatewayDeps) {
        this.startedAt = deps.now();
    }

    /** Run `use` with the Homey API. Every manager call inside it goes through the Gateway at this
     *  priority: counted, paced and backed off. Background work waits for the quiet start to end. */
    async call<T>(use: (api: any) => Promise<T>, priority: Priority = PRIORITY.control): Promise<T> {
        if (priority === PRIORITY.background) {
            const wait = this.startedAt + QUIET_START_MS - this.deps.now();
            if (wait > 0) await this.deps.sleep(wait);
        }
        const client = this.api();
        return use(this.wrap(await client, client, priority));
    }

    /** A web request (Open-Meteo), counted and paced like the Homey families: one lane, by
     *  priority, a backoff when the service says too many. */
    async web<T>(name: string, run: () => Promise<T>, priority: Priority = PRIORITY.control): Promise<T> {
        if (priority === PRIORITY.background) {
            const wait = this.startedAt + QUIET_START_MS - this.deps.now();
            if (wait > 0) await this.deps.sleep(wait);
        }
        return this.request('web', name, priority, null, run);
    }

    private api(): Promise<any> {
        if (!this.client) {
            const created = this.deps.createClient();
            this.client = created;
            created.catch(() => { if (this.client === created) this.client = undefined; });
        }
        return this.client;
    }

    /** The client as features see it: `api.<manager>.<method>(...)` becomes a Gateway request.
     *  The proxies wrap empty objects, never the client: homey-api defines its managers' methods
     *  as read-only, non-configurable properties, and a proxy on such an object may only return
     *  the property itself (a wrapped method there throws on every call: 2026-11-20). */
    private wrap(client: any, from: Promise<any>, priority: Priority): any {
        return new Proxy({}, {
            get: (_, manager) => {
                const real = client[manager];
                if (typeof manager !== 'string' || !real || typeof real !== 'object') return real;
                return new Proxy({}, {
                    get: (__, method) => {
                        const fn = real[method];
                        if (typeof method !== 'string' || typeof fn !== 'function') return fn;
                        // One device read (a room or outdoor sensor, the BT50 feed) is its own family: a
                        // refusal of a whole-home device list never holds it.
                        const family = manager === 'devices' && method === 'getDevice' ? SENSOR_FAMILY : manager;
                        const send = (...args: any[]) => this.request(family, method, priority, from, () => fn.apply(real, args));
                        // Every Insights log read goes through the store: kept on disk, only the gap fetched.
                        if (manager === 'insights' && method === 'getLogEntries' && this.logs)
                            return (args: any) => (isLogArgs(args) ? this.logs!.entries(args, (a) => send(a), priority) : send(args));
                        return send;
                    },
                });
            },
        });
    }

    private async request<T>(family: string, method: string, priority: Priority, from: Promise<any> | null, run: () => Promise<T>): Promise<T> {
        const queued = this.deps.now();
        const lane = family in LANE_GAP_MS ? this.lane(family) : undefined;
        if (lane) await this.turn(lane, priority);
        try {
            // Waited for after the turn too: a pause that began while this request queued holds it.
            for (let paused = this.pausedFor(family); paused > 0; paused = this.pausedFor(family)) await this.deps.sleep(paused);
            if (lane) {
                const gap = lane.last + LANE_GAP_MS[family] - this.deps.now();
                if (gap > 0) await this.deps.sleep(gap);
            }
            const stat = this.stat(`${family}.${method}`);
            stat.calls++;
            stat.waitMs += this.deps.now() - queued;
            try {
                const result = await run();
                this.backoffs.delete(family);
                return result;
            } catch (error: any) {
                stat.failures++;
                // A sensor read is never paused: waiting can't help the BT50 feed, only stop it.
                if (tooMany(error) && family !== SENSOR_FAMILY) this.backOff(family, method);
                else if (from && connectionLost(error) && this.client === from) {
                    // Only a lost connection drops the client, and only the one this request used.
                    this.client = undefined;
                    this.resets++;
                }
                throw error;
            }
        } finally {
            if (lane) this.release(lane);
        }
    }

    private lane(family: string): Lane {
        let lane = this.lanes.get(family);
        if (!lane) { lane = {busy: false, last: -Infinity, waiting: []}; this.lanes.set(family, lane); }
        return lane;
    }

    /** Wait for this lane's turn: the lowest priority number first, then the order asked. */
    private turn(lane: Lane, priority: Priority): Promise<void> {
        if (!lane.busy) { lane.busy = true; return Promise.resolve(); }
        return new Promise<void>((go) => {
            lane.waiting.push({priority, order: this.order++, go});
            lane.waiting.sort((a, b) => a.priority - b.priority || a.order - b.order);
        });
    }

    private release(lane: Lane) {
        lane.last = this.deps.now();
        const next = lane.waiting.shift();
        if (next) next.go(); else lane.busy = false;
    }

    private pausedFor(family: string): number {
        return (this.backoffs.get(family)?.until ?? 0) - this.deps.now();
    }

    private backOff(family: string, method: string) {
        const was = this.backoffs.get(family);
        // Requests already sent when the first refusal came back don't escalate it further.
        if (was && was.until > this.deps.now()) return;
        const step = was ? was.step + 1 : 0;
        const ms = BACKOFF_MS[Math.min(step, BACKOFF_MS.length - 1)];
        this.backoffs.set(family, {until: this.deps.now() + ms, step});
        this.deps.log(`Gateway: Homey said too many requests (${family}.${method}); pausing ${family} ${Math.round(ms / 1000)} s.`);
    }

    private stat(resource: string): Stat {
        let stat = this.stats.get(resource);
        if (!stat) { stat = {calls: 0, failures: 0, waitMs: 0}; this.stats.set(resource, stat); }
        return stat;
    }

    /** The hour's line: calls per resource (failures in brackets), queue wait, resets, memory.
     *  Counts start over after each report. */
    report(): string {
        const rows = [...this.stats.entries()].sort((a, b) => b[1].calls - a[1].calls);
        const calls = rows.reduce((a, [, s]) => a + s.calls, 0);
        const wait = rows.reduce((a, [, s]) => a + s.waitMs, 0);
        const each = rows.map(([r, s]) => `${r} ${s.calls}${s.failures ? ` (${s.failures} failed)` : ''}`).join(', ');
        const mem = this.deps.memory ? `, memory ${Math.round(this.deps.memory() / 1e6)} MB` : '';
        const logs = this.logs ? `, Insights logs ${this.logs.served} from store / ${this.logs.fetches} fetched, ${Math.round(this.logs.diskBytes() / 1000)} KB on disk` : '';
        if (this.logs) { this.logs.served = 0; this.logs.fetches = 0; }
        this.stats.clear();
        const resets = this.resets; this.resets = 0;
        return `Gateway: ${calls} Homey requests in the last hour, ${Math.round(wait / 1000)} s queued`
            + `${resets ? `, ${resets} client resets` : ''}${mem}${logs}${each ? `. ${each}` : ''}.`;
    }
}

function isLogArgs(args: any): args is LogArgs {
    return typeof args?.uri === 'string' && typeof args?.id === 'string' && typeof args?.resolution === 'string';
}

export function tooMany(error: any): boolean {
    return error?.statusCode === 429 || /too many/i.test(String(error?.message ?? error ?? ''));
}

export function connectionLost(error: any): boolean {
    if (error?.statusCode === 401 || error?.statusCode === 403) return true;
    const text = `${error?.message ?? error ?? ''} ${error?.cause?.code ?? ''} ${error?.cause?.message ?? ''}`;
    return /ECONN|EPIPE|socket hang up|not connected|disconnected|fetch failed/i.test(text);
}

/** One Gateway per app process (a Homey app is one process), whichever `homey` asks first. */
let shared: Gateway | undefined;

export function gatewayFor(homey: any): Gateway {
    if (!shared) {
        const created = new Gateway({
            createClient: () => { const {HomeyAPI} = require('homey-api'); return HomeyAPI.createAppAPI({homey}); },
            now: () => Date.now(),
            sleep: (ms) => new Promise((resolve) => homey.setTimeout(resolve, ms)),
            log: (...args) => homey.app?.log?.(...args),
            memory: () => process.memoryUsage().rss,
        });
        created.logs = new LogStore({now: () => Date.now(), load: loadJson, save: saveJson, remove: deleteFile,
            log: (...args) => homey.app?.log?.(...args)});
        shared = created;
        homey.setInterval?.(() => homey.app?.log?.(created.report()), REPORT_EVERY_MS);
    }
    return shared;
}

/** Tests only: put a Gateway in place of the app's (or remove it with undefined). */
export function useGatewayForTests(gateway: Gateway | undefined) { shared = gateway; }
