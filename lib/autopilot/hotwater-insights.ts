/** The hot water learner's starting point: the app's own Homey Insights for the Hot water
 *  device, read through `homey-api` (`homey:manager:api`). A household that has had the app a
 *  while gets a profile on the first day instead of after weeks. Design:
 *  docs/autopilot-hot-water.md §4.1. */

import {TankPoint} from './hotwater-learner';

/** What one Insights log returns: `values` are bucket means, `step` the bucket length in ms. */
export interface InsightsLog {
    step?: number;
    values?: {t: string; v: number | null}[];
}

export type TankField = 'litres' | 'produced' | 'used' | 'top' | 'aux' | 'charge';
export type TankLogs = Partial<Record<TankField, InsightsLog[]>>;

/** Finest first: where two resolutions overlap, the finer one is kept. Hourly reaches 14 days
 *  back, 6-hourly about three months (`last3Months` stops at a month boundary, so `last31Days`
 *  fills the weeks since). */
export const RESOLUTIONS = ['last14Days', 'last31Days', 'last3Months'] as const;

/** Bucket means → readings at each bucket's middle, one log per field per resolution, finest
 *  first. A coarser bucket is dropped where finer readings already cover its time. */
export function pointsFromInsights(logs: TankLogs): TankPoint[] {
    // Each resolution's readings by time, then merged: finer readings win their span.
    const byResolution: Map<number, TankPoint>[] = [];
    const steps: number[] = [];
    for (const field of ['litres', 'produced', 'used', 'top', 'aux', 'charge'] as TankField[]) {
        (logs[field] ?? []).forEach((log, r) => {
            const step = log.step ?? 0;
            if (!(step > 0)) return;
            steps[r] = steps[r] ? Math.min(steps[r], step) : step;
            const map = byResolution[r] ??= new Map();
            for (const {t, v} of log.values ?? []) {
                if (typeof v !== 'number' || !Number.isFinite(v)) continue;
                const at = Date.parse(t) + step / 2;
                if (!Number.isFinite(at)) continue;
                const point = map.get(at) ?? {t: at};
                point[field] = v;
                map.set(at, point);
            }
        });
    }
    const out: TankPoint[] = [];
    let coveredFrom = Infinity;
    byResolution.forEach((map, r) => {
        if (!map) return;
        const sorted = [...map.values()].sort((a, b) => a.t - b.t);
        // A reading only feeds the learner alongside the others, so require the counter and the
        // litres: without both, no interval comes out of it.
        const usable = sorted.filter((p) => p.t + steps[r] / 2 <= coveredFrom && p.produced != null && p.litres != null);
        out.push(...usable);
        if (usable.length) coveredFrom = Math.min(coveredFrom, usable[0].t - steps[r] / 2);
    });
    return out.sort((a, b) => a.t - b.t);
}

/** Capability ids on the Hot water device that feed each field. */
export interface TankCapabilities {
    litres: string;
    produced: string;
    used: string;
    top: string;
    /** Immersion heater hours for hot water (1069) and the charge sensor (BT6): what the
     *  compressor ceiling is learned from (hotwater-ceiling.ts). Optional per model. */
    aux?: string;
    charge?: string;
}

/** Reads every resolution of every field. A log that is missing or fails is left out: the
 *  learner works with what there is, and the caller logs how much that was. */
export async function fetchTankInsights(api: any, deviceId: string, caps: TankCapabilities,
                                        pause: (ms: number) => Promise<void> = async () => {}): Promise<TankLogs> {
    const uri = `homey:device:${deviceId}`;
    const logs: TankLogs = {};
    for (const field of (Object.keys(caps) as TankField[]).filter((f) => caps[f])) {
        logs[field] = [];
        for (const resolution of RESOLUTIONS) {
            const log = await api.insights.getLogEntries({uri, id: `${uri}:${caps[field]!}`, resolution, $timeout: 20_000})
                .catch(() => undefined);
            // Pacing is the Gateway's (one Insights request at a time, 2 s apart), and a log
            // served from its store needs none.
            logs[field]!.push(log ?? {});
        }
    }
    return logs;
}
