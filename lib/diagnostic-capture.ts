import {Register, combineRaw, isPollable, toNumericValue} from './registers';
import {ReadDiagnostic, formatReadDiagnostic} from './read-diagnostics';

type Job = {register: Register; kind: 'sweep' | 'energy'; pass?: number; started: number};

// Diagnostic evidence only. No writes, capability updates, or accounting inputs.
export class DiagnosticCapture {
    private readonly registers: Register[];
    private readonly energy: Register[];
    private readonly until: number;
    private cursor = 0;
    private energyTurn = true;
    private stopped = false;
    private completed = 0;
    private loggedAt = new Map<string, number>();
    private attemptedAt = new Map<string, number>();
    private previous = new Map<string, {value: number; receivedAt: string}>();

    constructor(config: {registers: Register[]; energy: Register[]},
        private log: (line: string) => void, now: number) {
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
        this.log(`F diagnostic capture stopped (${reason}): ${this.completed}/${this.registers.length * 2} sweep replies recorded.`);
    }

    private active(now: number) {
        if (now >= this.until) this.stop('two-hour limit');
        return !this.stopped;
    }

    next(now: number): Job | undefined {
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
        const prev = this.previous.get(r.name);
        this.log(`${label} NIBE=${r.address} ${r.name}: ${formatReadDiagnostic(sample)} `
            + `raw=${raw ?? 'missing'} decoded=${value ?? 'unavailable'}`
            + (prev && value !== undefined ? ` delta=${value - prev.value} since=${prev.receivedAt}` : ''));
        if (value !== undefined) this.previous.set(r.name, {value, receivedAt: sample.receivedAt});
    }
}
