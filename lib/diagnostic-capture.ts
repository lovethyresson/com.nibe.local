import {Register, combineRaw, isPollable, toNumericValue} from './registers';
import {ReadDiagnostic, formatReadDiagnostic} from './read-diagnostics';

export type CapturePoint = {at: string; words: number[]; value: number};
export type CaptureSummary = {
    startedAt: string; stopped: boolean; completed: number; expected: number;
    registers: {address: number; name: string; samples: number; errors: number;
        first?: CapturePoint; last?: CapturePoint; min?: number; max?: number;
        decreases: number; lastError?: string}[];
};

export function logCaptureSummary(summary: CaptureSummary, log: (line: string) => void) {
    const {registers, ...coverage} = summary;
    log('F diagnostic summary: ' + JSON.stringify(coverage));
    for (let i = 0; i < registers.length; i += 8)
        log('F diagnostic summary registers: ' + JSON.stringify(registers.slice(i, i + 8)));
}

type Job = {register: Register; kind: 'sweep' | 'energy'; pass?: number; started: number};

// Diagnostic evidence only. No writes, capability updates, or accounting inputs.
export class DiagnosticCapture {
    private readonly registers: Register[];
    private readonly energy: Register[];
    private readonly until: number;
    private lastSummaryAt: number;
    private summary = new Map<string, CaptureSummary['registers'][number]>();
    snapshot(): CaptureSummary {
        return JSON.parse(JSON.stringify({startedAt: new Date(this.until - 2 * 3600_000).toISOString(),
            stopped: this.stopped, completed: this.completed, expected: this.registers.length * 2,
            registers: [...this.summary.values()]}));
    }
    report(now: number, force = false) {
        if (!force && now - this.lastSummaryAt < 5 * 60_000) return;
        this.lastSummaryAt = now;
        const snapshot = this.snapshot();
        logCaptureSummary(snapshot, this.log);
        this.retain?.(snapshot);
    }
    private cursor = 0;
    private energyTurn = true;
    private stopped = false;
    private completed = 0;
    private loggedAt = new Map<string, number>();
    private attemptedAt = new Map<string, number>();
    private previous = new Map<string, {value: number; receivedAt: string}>();

    constructor(config: {registers: Register[]; energy: Register[]},
        private log: (line: string) => void, now: number,
        private retain?: (summary: CaptureSummary) => void) {
        this.lastSummaryAt = now;
        const unique = (regs: Register[]) => [...new Map(regs.filter(isPollable)
            .map((r) => [`${r.direction}:${r.address}`, r])).values()];
        this.registers = unique(config.registers);
        this.energy = unique(config.energy);
        this.until = now + 2 * 3600_000;
        this.log(`F diagnostic capture started: two sweeps of ${this.registers.length} known readable registers; `
            + `${this.energy.length} energy inputs for up to two hours. At most two extra reads per poll; `
            + 'normal polling first. Receipt time does not prove pump-side freshness.');
    }

    stop(reason: string) {
        if (this.stopped) return;
        this.stopped = true;
        this.report(Date.now(), true);
        this.log(`F diagnostic capture stopped (${reason}): ${this.completed}/${this.registers.length * 2} sweep replies recorded.`);
    }

    private active(now: number) {
        if (now >= this.until) this.stop('two-hour limit');
        return !this.stopped;
    }

    next(now: number): Job | undefined {
        this.report(now);
        if (!this.active(now)) return;
        const energyJob = () => {
            const r = this.energy.filter((r) => now - Math.max(this.attemptedAt.get(r.name) ?? -Infinity,
                this.loggedAt.get(r.name) ?? -Infinity) >= 60_000)
                .sort((a, b) => (this.attemptedAt.get(a.name) ?? -Infinity)
                    - (this.attemptedAt.get(b.name) ?? -Infinity))[0];
            if (!r) return;
            this.attemptedAt.set(r.name, now);
            return {register: r, kind: 'energy' as const, started: now};
        };
        const sweepJob = () => {
            if (this.cursor >= this.registers.length * 2) return;
            const index = this.cursor++;
            return {register: this.registers[index % this.registers.length], kind: 'sweep' as const,
                pass: Math.floor(index / this.registers.length) + 1, started: now};
        };
        const job = this.energyTurn ? energyJob() ?? sweepJob() : sweepJob() ?? energyJob();
        this.energyTurn = !this.energyTurn;
        return job;
    }

    observe(r: Register, sample: ReadDiagnostic, now: number) {
        if (!this.active(now) || !this.energy.some((e) => e.address === r.address && e.direction === r.direction)
            || now - (this.loggedAt.get(r.name) ?? -Infinity) < 60_000) return;
        this.logSample('F energy sample', r, sample);
        this.loggedAt.set(r.name, now);
    }

    complete(job: Job, sample: ReadDiagnostic | undefined, now: number) {
        if (!this.active(now)) return;
        // A reconnect can cancel a request without recording a new reply. Never reuse an old one.
        if (!sample || Date.parse(sample.receivedAt) < job.started) {
            this.log(`F ${job.kind} NIBE=${job.register.address}: no new reply (connection changed)`);
            return;
        }
        if (job.kind === 'sweep') {
            this.logSample(`F sweep ${job.pass}/2`, job.register, sample);
            this.completed++;
            if (this.completed === this.registers.length * 2)
                this.log('F diagnostic sweeps complete; energy capture continues until the two-hour limit.');
        }
    }

    private logSample(label: string, r: Register, sample: ReadDiagnostic) {
        const raw = sample.error ? undefined : combineRaw(sample.words, r.size);
        const decoded = raw === undefined ? undefined : toNumericValue(r, raw);
        const value = typeof decoded === 'number' && Number.isFinite(decoded) ? decoded : undefined;
        const key = r.direction + ':' + r.address;
        const entry = this.summary.get(key) ?? {address: r.address, name: r.name,
            samples: 0, errors: 0, decreases: 0};
        entry.samples++;
        if (value === undefined) {
            entry.errors++;
            entry.lastError = (sample.error ?? 'unavailable').slice(0, 200);
        } else {
            const point = {at: sample.receivedAt, words: sample.words.slice(0, 2), value};
            if (entry.last && value < entry.last.value) entry.decreases++;
            entry.first ??= point;
            entry.last = point;
            entry.min = Math.min(entry.min ?? value, value);
            entry.max = Math.max(entry.max ?? value, value);
        }
        this.summary.set(key, entry);
        const prev = this.previous.get(r.name);
        this.log(`${label} NIBE=${r.address} ${r.name}: ${formatReadDiagnostic(sample)} `
            + `raw=${raw ?? 'missing'} decoded=${value ?? 'unavailable'}`
            + (prev && value !== undefined ? ` delta=${value - prev.value} since=${prev.receivedAt}` : ''));
        if (value !== undefined) this.previous.set(r.name, {value, receivedAt: sample.receivedAt});
    }
}
