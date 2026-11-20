/** The Gateway: the one owner of what the app fetches from outside itself (docs/external-io.md).
 *  Step 1 of the migration: one Homey API client, one pacing rule for Insights, one backoff for
 *  "too many requests", priorities with a quiet start, and an hourly line of what was fetched.
 *  Features still say what they fetch; later steps move that into shared resources.
 *
 *  Pump Modbus is not here: PumpConnection owns the wire. */

export type Priority = 1 | 2 | 3;
/** 1: an owner is waiting (setup, Repair, a Flow card). 2: steers the pump now. 3: background. */
export const PRIORITY = {owner: 1, control: 2, background: 3} as const;

/** Insights requests run one at a time, this far apart: Homey refuses them back to back. */
export const INSIGHTS_GAP_MS = 2_000;
/** After a start, background work waits this long, so a start is not one burst of requests. */
export const QUIET_START_MS = 5 * 60_000;
/** A "too many requests" pauses every Homey request: 20 s, then 1 min, then 5 min. */
export const BACKOFF_MS = [20_000, 60_000, 300_000];
export const REPORT_EVERY_MS = 60 * 60_000;

export interface GatewayDeps {
    createClient(): Promise<any>;
    now(): number;
    sleep(ms: number): Promise<void>;
    log(...args: any[]): void;
    /** Process memory, bytes (rss). */
    memory?(): number;
}

interface Stat {calls: number; failures: number; waitMs: number}

export class Gateway {
    private client?: Promise<any>;
    private readonly startedAt: number;
    private insightsTurn: Promise<void> = Promise.resolve();
    private insightsLast = -Infinity;
    private pausedUntil = 0;
    private backoff = 0;
    private stats = new Map<string, Stat>();
    private resets = 0;

    constructor(private readonly deps: GatewayDeps) {
        this.startedAt = deps.now();
    }

    /** Run `use` with the Homey API. Every manager call inside it goes through the Gateway: counted,
     *  paced and backed off. Background work waits for the quiet start to end. */
    async call<T>(use: (api: any) => Promise<T>, priority: Priority = PRIORITY.control): Promise<T> {
        if (priority === PRIORITY.background) {
            const wait = this.startedAt + QUIET_START_MS - this.deps.now();
            if (wait > 0) await this.deps.sleep(wait);
        }
        const client = await this.api();
        return use(this.wrap(client));
    }

    private async api(): Promise<any> {
        if (!this.client) {
            this.client = this.deps.createClient();
            this.client.catch(() => { this.client = undefined; });
        }
        return this.client;
    }

    /** The client as features see it: `api.<manager>.<method>(...)` becomes a Gateway request. */
    private wrap(client: any): any {
        return new Proxy(client, {
            get: (target, manager) => {
                const real = target[manager];
                if (typeof manager !== 'string' || !real || typeof real !== 'object') return real;
                return new Proxy(real, {
                    get: (m, method) => {
                        const fn = m[method];
                        if (typeof method !== 'string' || typeof fn !== 'function') return fn;
                        return (...args: any[]) => this.request(`${manager}.${method}`, () => fn.apply(m, args));
                    },
                });
            },
        });
    }

    private async request<T>(resource: string, run: () => Promise<T>): Promise<T> {
        const queued = this.deps.now();
        const paused = this.pausedUntil - queued;
        if (paused > 0) await this.deps.sleep(paused);
        let release: (() => void) | undefined;
        if (resource.startsWith('insights.')) {
            const turn = this.insightsTurn;
            this.insightsTurn = new Promise<void>((resolve) => { release = resolve; });
            await turn;
            const gap = this.insightsLast + INSIGHTS_GAP_MS - this.deps.now();
            if (gap > 0) await this.deps.sleep(gap);
        }
        const stat = this.stat(resource);
        stat.calls++;
        stat.waitMs += this.deps.now() - queued;
        try {
            const result = await run();
            this.backoff = 0;
            return result;
        } catch (error: any) {
            stat.failures++;
            if (tooMany(error)) {
                const ms = BACKOFF_MS[Math.min(this.backoff, BACKOFF_MS.length - 1)];
                this.backoff++;
                this.pausedUntil = this.deps.now() + ms;
                this.deps.log(`Gateway: Homey said too many requests (${resource}); pausing ${Math.round(ms / 1000)} s.`);
            } else if (connectionLost(error)) {
                // Only a lost connection drops the client; one failed request (a sensor gone) does not.
                this.client = undefined;
                this.resets++;
            }
            throw error;
        } finally {
            if (release) { this.insightsLast = this.deps.now(); release(); }
        }
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
        this.stats.clear();
        const resets = this.resets; this.resets = 0;
        return `Gateway: ${calls} Homey requests in the last hour, ${Math.round(wait / 1000)} s queued`
            + `${resets ? `, ${resets} client resets` : ''}${mem}${each ? `. ${each}` : ''}.`;
    }
}

export function tooMany(error: any): boolean {
    return error?.statusCode === 429 || /too many/i.test(String(error?.message ?? error ?? ''));
}

export function connectionLost(error: any): boolean {
    if (error?.statusCode === 401 || error?.statusCode === 403) return true;
    return /ECONN|EPIPE|socket hang up|not connected|disconnected|session/i.test(String(error?.message ?? error ?? ''));
}

const gateways = new WeakMap<object, Gateway>();

/** The app's Gateway (one per Homey app process), created on first use with its hourly report. */
export function gatewayFor(homey: any): Gateway {
    let gateway = gateways.get(homey);
    if (!gateway) {
        const created = new Gateway({
            createClient: () => { const {HomeyAPI} = require('homey-api'); return HomeyAPI.createAppAPI({homey}); },
            now: () => Date.now(),
            sleep: (ms) => new Promise((resolve) => homey.setTimeout(resolve, ms)),
            log: (...args) => homey.app?.log?.(...args),
            memory: () => process.memoryUsage().rss,
        });
        gateway = created;
        gateways.set(homey, created);
        homey.setInterval?.(() => homey.app?.log?.(created.report()), REPORT_EVERY_MS);
    }
    return gateway;
}
