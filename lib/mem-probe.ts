// TEMP(mem): memory over the first minutes after start, and markers around the heavy start-up
// tasks, to find what pushes the app over the Homey Pro (2026)'s memory limit (2026-11-21).
// Remove before the release is packaged (tasks/todo.md, "Before the release").
import {getHeapStatistics} from 'v8';
const mb = (v: number) => Math.round(v / 1048576);
/** Homey's sandbox refuses process.memoryUsage() (no resident set size): V8's own figures. */
export function memNow(): string {
    try {
        const h = getHeapStatistics();
        return `heap ${mb(h.used_heap_size)}/${mb(h.total_heap_size)} ext ${mb(h.external_memory)} malloc ${mb(h.malloced_memory)}`;
    } catch (error: any) {
        return `mem n/a (${error?.message ?? error})`;
    }
}
let log: (...args: any[]) => void = () => undefined;
export function startMemProbe(logger: (...args: any[]) => void, setInterval: (fn: () => void, ms: number) => any, clearInterval: (t: any) => void) {
    log = logger;
    const t0 = Date.now();
    const timer = setInterval(() => {
        log(`TEMP(mem) +${Math.round((Date.now() - t0) / 1000)}s ${memNow()}`);
        if (Date.now() - t0 > 8 * 60_000) clearInterval(timer);
    }, 5000);
}
/** Logs memory before and after `task`, with its name. */
export async function memMark<T>(name: string, task: () => Promise<T>): Promise<T> {
    log(`TEMP(mem) start ${name}: ${memNow()}`);
    try { return await task(); } finally { log(`TEMP(mem) end ${name}: ${memNow()}`); }
}
