import {CaptureSummary, DiagnosticCapture} from './diagnostic-capture';
import {ReadDiagnostic, formatReadDiagnostic} from './read-diagnostics';
import {frequentRegisterNames, planPoll} from './poll-plan';
import net from 'net';
import {ModbusTCPClient} from 'jsmodbus';
import {Dir, Register, combineRaw, isPollable, isUnavailableRaw, signedValue, toNumericValue} from './registers';
import {Role, functionRoles} from './roles';
import type {LocalizedText, ModelProfile, ReasonState} from './profile';
import {DetectionResult, buildDetectionResult, sampleRegisters} from './detection';
import {track} from './analytics';

// A Nibe pump accepts only a single Modbus client, but the app pairs several logical
// devices (main + heating/hot water/pool/cooling/solar) that all talk to the same pump.
// PumpConnection is the one shared connection per pump host: devices attach/detach, it
// owns the single socket, one poll loop over the union of everyone's registers, energy
// integration/allocation by operating priority, and availability fan-out. It is refcounted
// — the first attach opens the socket, the last detach tears it down — and independent of
// device init order (Homey guarantees none). All model-specific data comes from the profile.

// Poll interval bounds, in seconds. The floor is set by the pump, the ceiling by the energy
// split (allocateEnergy charges a whole interval to whichever function was prioritised at the
// sampling instant, so any priority change in between is misattributed above ~60 s).
export const POLL_SECONDS_MIN = 5;
export const POLL_SECONDS_MAX = 60;
export const POLL_SECONDS_DEFAULT = 10;

// How many consecutive polls may read nothing at all before the connection is dropped and
// rebuilt. Two rather than one: a single empty poll is what a pump busy with its own menu
// or a momentary stall looks like, and reconnecting on that would churn. Two at the default
// interval is ~20 s of silence, well inside what a user would call "it stopped updating".
export const DEAD_POLLS_BEFORE_RECONNECT = 2;
export const POLL_DEADLINE_MS = 30_000;

// How long a connect attempt may take before it is abandoned. Without one, a SYN that nothing
// answers (the pump's old address now on another subnet, or held by a device that drops it) is
// left to the kernel, which gives up after about two minutes — and nothing is logged meanwhile.
export const CONNECT_TIMEOUT_MS = 10_000;
// Wait before each reconnect attempt, by how many attempts in a row have failed. The first retry
// after a drop is quick; a pump that stays away is tried once a minute rather than every 5 s.
export const RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000, 60_000];
// A pump that cannot be reached for this long is searched for on the subnet, in case the router
// gave it a new address; see NibePumpDriver.relocatePump(). Repeated at most this often.
export const SEARCH_AFTER_MS = 3 * 60_000;
export const SEARCH_EVERY_MS = 30 * 60_000;
// While the pump stays unreachable, one reminder line this often instead of one per attempt.
const OUTAGE_LOG_EVERY_MS = 10 * 60_000;

// Why the devices are unavailable, as far as this end can tell. Drives the message on the tile.
//   connecting  — no answer yet, nothing has failed
//   unreachable — connect failed or timed out: nothing answered at that address
//   refused     — something is at that address, but its Modbus port is closed
//   silent      — the connection was up but the pump stopped answering (watchdog)
//   searching   — unreachable long enough that the subnet is being searched for the pump
export type ConnectionProblem = 'connecting' | 'unreachable' | 'refused' | 'silent' | 'searching';

export function classifyConnectError(error: any): ConnectionProblem {
    return error?.code === 'ECONNREFUSED' ? 'refused' : 'unreachable';
}

export interface Transport {
    addressBase?: number;
    port: number;
    unitId: number;
}

export function clampPollSeconds(seconds: any): number {
    const n = Number(seconds);
    if (!Number.isFinite(n))
        return POLL_SECONDS_DEFAULT;
    return Math.min(POLL_SECONDS_MAX, Math.max(POLL_SECONDS_MIN, Math.round(n)));
}

// Pick a language out of a LocalizedText, falling back to English for anything but Swedish.
export function inLanguage(text: LocalizedText | undefined, language: string): string {
    if (!text)
        return '';
    return language === 'sv' ? text.sv : text.en;
}

// A device subscribing to a pump connection. Homey's Device already provides log/error.
export interface PumpSubscriber {
    role: Role;
    onDiagnosticSummary?(summary: CaptureSummary): void;
    wantedRegisters(): Register[];
    onRegisterRaw(register: Register, raw: number): void;
    onConnectionUp(): void;
    // Called when the devices go down and again when the reason changes — not per failed attempt.
    onConnectionDown(problem: ConnectionProblem): void;
    // Registers this pump has said it doesn't have, remembered across restarts (Main keeps them).
    // Seeded at attach; the connection reports the set whenever it grows or Repair clears it.
    absentRegisters?(): string[];
    onAbsentRegisters?(names: string[]): void;
    // Look for the pump at another address and move its devices there if it is found. The
    // connection calls this on one subscriber (main if paired) after a long run of failed
    // connects; see SEARCH_AFTER_MS.
    searchForPump?(): Promise<void>;
    onPollComplete?(readNames: Set<string>): void;
    // Poll interval this device asks for, in seconds. The main device's value wins; the rest
    // only matter when no main device is paired.
    pollSeconds(): number;
    // Only the function devices implement this — see PumpConnection.allocateEnergy().
    onEnergy?(deltaKwh: number, watts: number): void;
    // Called instead of onEnergy on a poll where no power source read, so the allocator could
    // measure nothing. Devices need this to know their used-energy series has a hole in it —
    // without it they cannot tell "this function used nothing" from "we were not looking".
    onEnergyUnavailable?(): void;
    // The pump has published its own accounting for a completed hour. `used` and `produced` are
    // this role's kWh for that hour, straight from the pump's books — the figures myUplink
    // shows. Devices steer their live-integrated meter onto these rather than replacing it, so
    // sub-hour timing survives for tariffs while the total converges on the pump's.
    onEnergyLogHour?(used: number | undefined, produced: number | undefined): void;
    // Whether this device wants verbose logging (its "Debug logging" setting). The connection
    // is shared, so it logs verbosely when *any* attached device asks for it.
    debugEnabled?(): boolean;
    // The pump switched what it is producing. `from`/`to` are raw priority codes (`from` is
    // undefined for the first reading after connect); `reason` is the model's explanation of
    // why, or undefined when it can't tell. Only the main device acts on this.
    onPriorityChange?(from: number | undefined, to: number | undefined,
                      role: Role, reason: LocalizedText | undefined): void;
}

// Modbus exception codes (MODBUS Application Protocol v1.1b, section 7). jsmodbus surfaces
// these only as "A Modbus Exception Occurred - See Response Body", so without decoding them a
// failed request says nothing at all about why it failed. Worded for reads and writes alike:
// Nibe answers 1 for a register this pump doesn't have, on either.
const MODBUS_EXCEPTIONS: Record<number, string> = {
    1: 'Illegal function — this pump doesn\'t have this register, or a pump setting has switched it off',
    2: 'Illegal data address — no such register on this model',
    3: 'Illegal data value — the value is outside the range the pump accepts',
    4: 'Server device failure — the pump hit an error carrying out the request',
    5: 'Acknowledge — accepted but still processing',
    6: 'Server device busy — the pump is busy; retry later',
    8: 'Memory parity error',
    10: 'Gateway path unavailable',
    11: 'Gateway target device failed to respond'
};

// Everything an error carries, without throwing on circular references or losing an Error's
// non-enumerable message/stack — a diagnostic that swallows the diagnosis is worse than none.
export function safeJson(value: unknown): string {
    const seen = new WeakSet();
    try {
        return JSON.stringify(value, (_key, v) => {
            if (v instanceof Error)
                return {name: v.name, message: v.message, stack: v.stack};
            if (typeof v === 'object' && v !== null) {
                if (seen.has(v as object))
                    return '[circular]';
                seen.add(v as object);
            }
            return typeof v === 'bigint' ? v.toString() : v;
        }, 2) ?? String(value);
    } catch (error: any) {
        return `[unserialisable: ${error?.message ?? error}]`;
    }
}

// Pull the Modbus exception code out of a jsmodbus rejection and say what it means. The shape
// varies by failure mode (exception response, timeout, socket error), so probe rather than assume.
export function describeModbusError(reason: any): {summary: string; code?: number} {
    const code: number | undefined =
        reason?.response?.body?.code ?? reason?.body?.code ?? reason?.code;
    const known = typeof code === 'number' ? MODBUS_EXCEPTIONS[code] : undefined;
    if (known)
        return {summary: `Modbus exception ${code}: ${known}`, code};
    if (typeof code === 'number')
        return {summary: `Modbus exception ${code} (not in the standard table)`, code};
    if (reason?.err === 'OutOfSync') {
        const request = reason.request;
        const response = reason.response;
        return {summary: 'Modbus response out of sync (transaction ID or function code mismatch); '
            + `request transaction=${request?.id ?? 'unknown'} FC=${request?.body?.fc ?? 'unknown'}; `
            + (response ? `response transaction=${response.id ?? 'unknown'} FC=${response.body?.fc ?? 'unknown'}`
                : 'response details not supplied by Modbus library')};
    }
    if (reason?.err === 'Timeout' || /timeout/i.test(reason?.message ?? ''))
        return {summary: 'the pump did not answer in time'};
    return {summary: reason?.message ?? String(reason)};
}

const connections = new Map<string, PumpConnection>();

// Which lane a wire request queues in. Writes are user-triggered and latency-sensitive; reads
// arrive a hundred at a time from the poll loop. See withWireAccess().
type WireLane = 'read' | 'write';

interface WireJob {
    run: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
}

export class PumpConnection {
    private socket!: net.Socket;
    private client!: ModbusTCPClient;
    private subscribers = new Set<PumpSubscriber>();
    private pollInterval: NodeJS.Timeout | null = null;
    private pollSeconds = POLL_SECONDS_DEFAULT;
    private polling = false;
    private generation = 0;
    private unsupportedUntil = new Map<string, number>();
    // Registers this pump answered exception 1/2 for that nobody selected as a capability —
    // reason inputs, internal energy-log registers. Never asked again, across restarts too (Main
    // stores the set), until Repair's detection re-learns what the pump has.
    private knownAbsent = new Set<string>();
    private backgroundAttempted = new Map<string, number>();
    private pollDeadlineMs = POLL_DEADLINE_MS;
    private pollDeadline: NodeJS.Timeout | null = null;
    private retryTimer: NodeJS.Timeout | null = null;
    private connected = false;
    private destroyed = false;
    // Set by the watchdog just before it drops the socket, so the resulting 'close' is reported as
    // the watchdog trip it is rather than as an anonymous disconnect. Cleared once consumed.
    private closeCause: {cause: string; dead_polls?: number} | null = null;
    // Consecutive polls where not one register answered. See the watchdog in poll().
    private deadPolls = 0;
    // Whether the current socket ever connected, which tells a drop from a failed attempt.
    private established = false;
    // The error the current socket failed with; 'close' follows and acts on it.
    private socketError: any = null;
    // What subscribers were last told. null while up (or before anything was said).
    private problem: ConnectionProblem | null = null;
    // The current outage: when it started, how many connects have failed since, the last error
    // logged (so a change of error is logged and a repeat is not) and when it was last logged.
    private outageSince: number | null = null;
    private failedAttempts = 0;
    private outageError: string | undefined;
    private outageLoggedAt = 0;
    private searching = false;
    private lastSearch = 0;
    // Instance copies of the timing constants, so the integration tests can shorten them.
    private connectTimeoutMs = CONNECT_TIMEOUT_MS;
    private retryDelaysMs = RETRY_DELAYS_MS;
    private searchAfterMs = SEARCH_AFTER_MS;
    private searchEveryMs = SEARCH_EVERY_MS;

    // Every request to the pump — read or write — funnels through here, one at a time.
    // Confirmed live: a batch of ~17 read failures, all in one topical group, landed within a
    // second of a manual write every single time it happened. jsmodbus and the pump's own
    // Modbus TCP stack are both given no reason to expect that; a poll's dozens of concurrent
    // reads and an independent write share one client on one socket with nothing coordinating
    // them. This makes that impossible: whatever calls next just waits its turn.
    //
    // Two lanes, not one. Serializing alone was not enough: poll() enqueues the whole register
    // union — around a hundred requests — in a single synchronous burst, and a user's write
    // queued behind all of them. Each request can take up to the jsmodbus timeout (5 s), so on a
    // pump that has gone slow a write could wait minutes. Homey's flow-card timeout fires long
    // before that, so the user is told their action failed while it is still sitting in the
    // queue, and it then lands out of order. Writes now jump ahead of queued reads; the
    // one-request-at-a-time guarantee that made this class necessary is unchanged.
    private wireHigh: WireJob[] = [];
    private wireLow: WireJob[] = [];
    private wireRunning = false;

    private withWireAccess<T>(fn: () => Promise<T>, lane: WireLane = 'read'): Promise<T> {
        if (!this.connected || this.destroyed)
            return Promise.reject(new Error('Not connected to the heat pump'));
        const generation = this.generation;
        return new Promise<T>((resolve, reject) => {
            (lane === 'write' ? this.wireHigh : this.wireLow)
                .push({run: async () => {
                    if (generation !== this.generation || !this.connected || this.destroyed)
                        throw new Error('Connection changed before request could run');
                    const result = await fn();
                    if (generation !== this.generation)
                        throw new Error('Connection changed during request');
                    return result;
                }, resolve: resolve as (value: unknown) => void, reject});
            void this.drainWire();
        });
    }

    private async drainWire(): Promise<void> {
        if (this.wireRunning)
            return;
        this.wireRunning = true;
        try {
            for (;;) {
                // Re-checked every iteration rather than snapshotted: a write arriving while a
                // poll's reads are draining takes the next slot, which is the whole point.
                const job = this.wireHigh.shift() ?? this.wireLow.shift();
                if (!job)
                    return;
                // One failed request must not stop the ones behind it — the caller still sees
                // the real rejection through its own promise.
                try {
                    job.resolve(await job.run());
                } catch (error) {
                    job.reject(error);
                }
            }
        } finally {
            this.wireRunning = false;
        }
    }

    // Retire queued work and prevent an old poll from publishing into a new connection.
    private invalidateWork() {
        this.generation++;
        this.polling = false;
        if (this.pollDeadline) clearTimeout(this.pollDeadline);
        this.pollDeadline = null;
        const error = new Error('Connection closed before request could run');
        for (const job of [...this.wireHigh, ...this.wireLow]) job.reject(error);
        this.wireHigh = [];
        this.wireLow = [];
        this.lastRaw.clear();
        this.unsupportedUntil.clear();
        this.backgroundAttempted.clear();
    }

    // Energy integrator state. lastPowerReading is null right after every (re)connect so a
    // connection gap isn't counted as continuous runtime at whatever power the first poll reads.
    private lastPowerReading: number | null = null;
    private lastPollTime = Date.now();
    private loggedUnknownPriority = new Set<number>();
    // Diagnostic: last raw priority we logged a transition for, so the log shows every
    // change (not just idle<->active flips) with its mapped role and the live draw —
    // used to discover which raw code a producing pump actually reports per function.
    private lastLoggedPriority: number | undefined = undefined;
    // Throttle (per role) for the "function device missing, charging to Main" warning, so
    // a persistent misattribution re-surfaces periodically without spamming every poll.
    private lastMissingRoleWarn = new Map<Role, number>();
    // Previous raw priority, to detect transitions for the profile's reset rules (e.g. clear
    // "More hot water" once the pump leaves hot water for idle). Cleared on (re)connect.
    private lastPriority: number | undefined = undefined;

    // Last successfully read raw value per register, so a device that attaches after the
    // connection is already up gets current values without waiting for a poll.
    private lastRaw = new Map<string, number>();

    // Registers that are not answering, keyed by capability name. readRegisterRaw() swallows
    // read errors by design (a superset register table means "absent on this model" is normal,
    // not exceptional) — but swallowing it *silently* is how a model shipped with its only
    // power source register missing and nothing in the log said so.
    //
    // The map's lifetime is the connection object, i.e. one app start. That is deliberate: a
    // register missing on this model fails on the very first poll, long before anyone thinks
    // to switch on debug logging, so "first failure" has to mean "first since the app started"
    // — otherwise the one line that explains everything has already scrolled past unrecorded.
    private readFailures = new Map<string, {address: number; since: number; count: number; reported: boolean}>();
    private recoveredReads: string[] = [];

    // Whether the last poll had a usable power reading, so the transition is logged once
    // instead of every poll. Undefined until the first allocateEnergy().
    private powerAvailable: boolean | undefined = undefined;

    // Model-specific registers the energy allocator needs, resolved from the profile.
    // Alternative source groups in preference order; the registers within a group are summed,
    // and the first group that reads is the one used (see RoleConfig.powerSources).
    private readonly powerGroups: Register[][];
    // Optional second chain for the live tile only — see ModelProfile.displayPowerSources.
    private readonly displayGroups: Register[][];
    // Every power register across all groups — what the poll loop must fetch, since which
    // group is usable isn't known until the values come back.
    private readonly powerRegisters: Register[];
    // Which group answered last, so a change of source is logged rather than silently swapped.
    private activePowerGroup: number | undefined = undefined;
    private readonly priorityRegister?: Register;
    // The undocumented 3804 register (see registers.ts), absent on some models (registerByName
    // returns undefined). Used to correct an idle 1028 — see applyEnergyLogPriorityOverride().
    private readonly energyLogPriorityRegister?: Register;

    private constructor(private host: string, private profile: ModelProfile, private transport: Transport) {
        this.pollDeadlineMs = profile.pollDeadlineMs ?? POLL_DEADLINE_MS;
        this.powerGroups = profile.role.powerSources
            .map((group) => group
                .map((name) => profile.registerByName[name])
                .filter((register): register is Register => !!register))
            .filter((group) => group.length > 0);
        this.displayGroups = (profile.role.displayPowerSources ?? [])
            .map((group) => group
                .map((name) => profile.registerByName[name])
                .filter((register): register is Register => !!register))
            .filter((group) => group.length > 0);
        this.powerRegisters = [...this.powerGroups, ...this.displayGroups].flat();
        this.priorityRegister = profile.role.priorityRegisterName
            ? profile.registerByName[profile.role.priorityRegisterName]
            : undefined;
        this.energyLogPriorityRegister =
            profile.registerByName['measure_priority_NIBE.i3804_energylog_priority'];
        this.openSocket();
    }

    private openSocket() {
        const socket = new net.Socket();
        this.socket = socket;
        this.client = new ModbusTCPClient(socket, this.transport.unitId, 5000);
        this.established = false;
        this.socketError = null;
        socket.setTimeout(this.connectTimeoutMs, () => {
            if (this.socket !== socket || this.established) return;
            socket.destroy(Object.assign(
                new Error(`connect timed out after ${Math.round(this.connectTimeoutMs / 1000)} s`),
                {code: 'ETIMEDOUT'}));
        });
        socket.on('connect', () => {
            socket.setTimeout(0);
            if (this.socket === socket) this.onConnect();
        });
        socket.on('error', (error) => { if (this.socket === socket) this.onSocketError(error); });
        socket.on('close', () => { if (this.socket === socket) this.onClose(); });
        this.debug(`Connecting (port ${this.transport.port}, unit ${this.transport.unitId})`);
        socket.connect({port: this.transport.port, host: this.host});
    }

    static get(host: string, profile: ModelProfile, transport: Transport): PumpConnection {
        let connection = connections.get(host);
        if (!connection) {
            connection = new PumpConnection(host, profile, transport);
            connections.set(host, connection);
        }
        if (connection.profile !== profile)
            throw new Error('This address is already paired with a different pump driver. Remove that device before changing series.');
        return connection;
    }

    matchesProfile(profile: ModelProfile): boolean { return this.profile === profile; }


    // The connection isn't a Homey Device/Driver, so its output goes through console.log and
    // doesn't get the ISO timestamp that Homey prefixes onto device/driver logs. Add one in the
    // same format, so connection lines interleave readably with the rest of the app log.
    private log(...args: any[]) {
        console.log(`${new Date().toISOString()} [PumpConnection ${this.host}]`, ...args);
    }

    // Verbose logging (polling, priority changes, energy allocation). Off unless one of the
    // attached devices has "Debug logging" enabled; errors always log via this.log().
    private debugOn = false;
    private readDiagnostics = new Map<string, ReadDiagnostic>();
    private diagnosticCapture?: DiagnosticCapture;
    private captureUntil = 0;
    private captureCounts = new Map<string, number>();
    private captureRemaining = 0;

    describeLastRead(name: string): string {
        const sample = this.readDiagnostics.get(name);
        return sample ? formatReadDiagnostic(sample) : 'not sampled';
    }

    private recordRead(register: Register, sample: ReadDiagnostic) {
        this.diagnosticCapture?.observe(register, sample, Date.now());
        const previous = this.readDiagnostics.get(register.name);
        this.readDiagnostics.set(register.name, sample);
        const count = this.captureCounts.get(register.name) ?? 0;
        if (this.debugOn && Date.now() <= this.captureUntil && count < 3 && this.captureRemaining > 0) {
            this.captureCounts.set(register.name, count + 1);
            this.captureRemaining--;
            this.log(`Read sample ${count + 1}/3 ${register.name} NIBE=${register.address}: `
                + formatReadDiagnostic(sample));
        } else if (this.debugOn && sample.error && sample.error !== previous?.error) {
            this.log(`Read failed ${register.name}: ${formatReadDiagnostic(sample)}`);
        }
    }

    refreshDebug() {
        const on = [...this.subscribers].some((subscriber) => subscriber.debugEnabled?.() ?? false);
        const turnedOn = on && !this.debugOn;
        this.debugOn = on;
        if (!on) {
            this.diagnosticCapture?.stop('debug disabled');
            this.diagnosticCapture = undefined;
        }
        // Someone just switched debug logging on — almost always *after* the thing they are
        // chasing already happened. Restate the standing read failures so the log they are
        // about to send actually contains them.
        if (turnedOn) {
            if (this.profile.diagnosticSweep)
                this.diagnosticCapture = new DiagnosticCapture(this.profile.diagnosticSweep,
                    (line) => this.log(line), Date.now(), (summary) => {
                        for (const subscriber of this.subscribers)
                            subscriber.onDiagnosticSummary?.(summary);
                    });
            this.traceUntil = Date.now() + 2 * 3600_000;
            this.lastEnergyTestAt = 0;
            this.captureUntil = Date.now() + 60_000;
            this.captureCounts.clear();
            this.captureRemaining = 200;
            this.log(`Read capture started: up to 3 samples per register / 200 total over 60 seconds; `
                + `port=${this.transport.port} unit=${this.transport.unitId} `
                + `addressBase=${this.transport.addressBase ?? this.profile.addressBase ?? 0}. `
                + 'Samples use existing reads; receipt time does not establish gateway cache freshness.');
            this.logStandingFailures();
        }
    }

    private traceUntil = 0;
    private lastEnergyTestAt = 0;
    private traceSnapshot(raws: Map<string, number>) {
        const now = Date.now();
        if (!this.debugOn || now > this.traceUntil || now - this.lastEnergyTestAt < 60_000 || !this.profile.diagnosticTrace) return;
        this.lastEnergyTestAt = now;
        const frequentNames = this.profile.polling ? frequentRegisterNames(this.profile) : undefined;
        this.log(`Energy test ${new Date(now).toISOString()}: ` + this.profile.diagnosticTrace.map((name) => {
            const r = this.profile.registerByName[name];
            const frequent = !frequentNames || frequentNames.has(name);
            const raw = frequent ? raws.get(name) : this.lastRaw.get(name);
            const receipt = this.readDiagnostics.get(name)?.receivedAt;
            return `${r.address}=${raw === undefined ? 'missing' : `${raw}/${toNumericValue(r, raw) ?? 'unavailable'}`}`
                + (frequent ? '' : `[last-observed; latest-attempt=${receipt ?? 'never'}]`);
        }).join(' '));
    }

    private logStandingFailures() {
        if (!this.readFailures.size) {
            this.log('Debug logging on — every polled register is reading.');
            return;
        }
        const list = [...this.readFailures.entries()].map(([name, failure]) =>
            `${failure.address} ${name} (${failure.count}× since ${new Date(failure.since).toISOString()})`);
        this.log(`Debug logging on — ${list.length} register(s) still not reading: ${list.join(', ')}`);
    }

    // Record the outcome of one register read. Reporting is batched into reportReadFailures()
    // so a model that legitimately lacks 20 of the superset's registers produces one line
    // rather than twenty.
    private noteRead(register: Register, ok: boolean) {
        // The `__reason.*` inputs are read on demand at a priority change, in a burst, and are
        // best-effort by contract — explain() is written to degrade when one is missing, and
        // several are for functions this pump may not have (pool, cooling). A miss there is
        // neither news nor evidence that the register is absent, so don't report it as such.
        if (register.name?.startsWith('__'))
            return;
        // updatePumpInfo() reads bare address-only registers, which carry no capability name —
        // key those by address so they can't collide.
        const key = register.name ?? `@${register.address}`;
        const failure = this.readFailures.get(key);
        if (ok) {
            if (!failure)
                return;
            this.readFailures.delete(key);
            if (failure.reported)
                this.recoveredReads.push(`${failure.address} ${key}`);
            return;
        }
        if (failure)
            failure.count += 1;
        else
            this.readFailures.set(key,
                {address: register.address, since: Date.now(), count: 1, reported: false});
    }

    // One line per poll covering everything that started failing since the last one. Logged
    // un-gated: this is the difference between a diagnosable report and a forum thread, and
    // it must land whether or not debug logging happens to be on.
    private reportReadFailures(pollHealthy: boolean) {
        // Nothing read at all: the socket is going down, not 94 registers vanishing at once.
        // Stay quiet — the entries clear themselves as each register succeeds again, and
        // anything genuinely absent is still unreported and gets its line on the next good poll.
        if (!pollHealthy)
            return;
        const fresh = [...this.readFailures.entries()].filter(([, failure]) => !failure.reported);
        if (fresh.length) {
            for (const [, failure] of fresh)
                failure.reported = true;
            this.log(`${fresh.length} register(s) did not read (first failure since app start): `
                + fresh.map(([name, failure]) => `${failure.address} ${name}`).join(', ')
                + ' — absent on this pump model, or unsupported by its firmware.');
        }
        if (this.recoveredReads.length) {
            this.log(`${this.recoveredReads.length} register(s) reading again: `
                + this.recoveredReads.join(', '));
            this.recoveredReads = [];
        }
    }

    private debug(...args: any[]) {
        if (this.debugOn)
            this.log(...args);
    }

    // Change transport (port/unit id) and reconnect with the new parameters. Called from the
    // device settings handler; a no-op if nothing changed.
    applyTransport(transport: Transport) {
        if (transport.port === this.transport.port && transport.unitId === this.transport.unitId
            && transport.addressBase === this.transport.addressBase)
            return;
        this.debug(`Transport changed to port ${transport.port}, unit ${transport.unitId} — reconnecting`);
        this.transport = transport;
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        this.connected = false;
        this.invalidateWork();
        this.socket.destroy();
        this.notifyDown('connecting');
        this.openSocket();
    }

    attach(subscriber: PumpSubscriber) {
        this.subscribers.add(subscriber);
        for (const name of subscriber.absentRegisters?.() ?? [])
            this.knownAbsent.add(name);
        this.refreshDebug();
        this.refreshPollInterval();
        if (this.connected) {
            subscriber.onConnectionUp();
            for (const register of subscriber.wantedRegisters().filter(isPollable)) {
                const raw = this.lastRaw.get(register.name);
                if (raw !== undefined)
                    subscriber.onRegisterRaw(register, raw);
            }
        } else {
            subscriber.onConnectionDown(this.problem ?? 'connecting');
        }
    }

    detach(subscriber: PumpSubscriber) {
        this.subscribers.delete(subscriber);
        this.refreshDebug();
        if (this.subscribers.size === 0)
            this.destroy();
        else
            this.refreshPollInterval(); // the main device may have just left
    }

    private destroy() {
        this.debug('Last device detached, closing connection');
        this.destroyed = true;
        // Stop new work immediately; leave socket listeners attached until close so the
        // Modbus client can reject its in-flight request.
        this.connected = false;
        this.invalidateWork();
        if (this.pollInterval) clearInterval(this.pollInterval);
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.socket.destroy();
        connections.delete(this.host);
    }

    // The interval to run at: the main device owns the setting and the function devices
    // inherit it. Falls back to the lowest requested value when no main device is paired,
    // and to the default when nothing is attached.
    private desiredPollSeconds(): number {
        const main = [...this.subscribers].find((subscriber) => subscriber.role === 'main');
        if (main)
            return clampPollSeconds(main.pollSeconds());
        const asked = [...this.subscribers].map((subscriber) => clampPollSeconds(subscriber.pollSeconds()));
        return asked.length ? Math.min(...asked) : POLL_SECONDS_DEFAULT;
    }

    refreshPollInterval() {
        const wanted = this.desiredPollSeconds();
        if (wanted === this.pollSeconds && this.pollInterval)
            return;
        this.pollSeconds = wanted;
        if (!this.connected)
            return;
        if (this.pollInterval)
            clearInterval(this.pollInterval);
        this.debug(`Polling every ${wanted} s`);
        this.pollInterval = setInterval(() => this.poll(), wanted * 1000);
    }

    private onConnect() {
        this.debug('Connected');
        if (this.outageSince !== null) {
            // Un-gated, like the failure it closes: a report that shows the pump going away
            // must also show whether and when it came back.
            const seconds = Math.round((Date.now() - this.outageSince) / 1000);
            this.log(`Reconnected after ${seconds} s`
                + (this.failedAttempts ? ` and ${this.failedAttempts} failed attempt(s).` : '.'));
        }
        this.established = true;
        this.connected = true;
        this.problem = null;
        this.outageSince = null;
        this.failedAttempts = 0;
        this.outageError = undefined;
        this.lastPowerReading = null;
        this.lastPriority = undefined;
        this.lastPollTime = Date.now();
        this.polling = false;
        this.deadPolls = 0;
        this.subscribers.forEach((subscriber) => subscriber.onConnectionUp());
        setTimeout(() => this.poll(), 200);
        this.pollSeconds = this.desiredPollSeconds();
        this.debug(`Polling every ${this.pollSeconds} s`);
        this.pollInterval = setInterval(() => this.poll(), this.pollSeconds * 1000);
    }

    // Node always follows 'error' with 'close', and onClose() does the work — a failed connect
    // attempt reports here and there, so acting in both marked every device down twice per try.
    private onSocketError(error: any) {
        this.socketError = error;
        this.connected = false;
    }

    // Tell subscribers the devices are down, once per reason rather than once per attempt:
    // every call re-runs setUnavailable() and the energy-gap bookkeeping on up to six devices.
    private notifyDown(problem: ConnectionProblem) {
        if (this.problem === problem)
            return;
        this.problem = problem;
        this.subscribers.forEach((subscriber) => subscriber.onConnectionDown(problem));
    }

    private onClose() {
        const wasEstablished = this.established;
        const error = this.socketError;
        this.established = false;
        this.socketError = null;
        this.connected = false;
        this.invalidateWork();
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        if (this.destroyed) {
            this.notifyDown('connecting');
            return;
        }
        const detail = error?.message ?? 'closed by the pump';
        const now = Date.now();
        let problem: ConnectionProblem;
        if (wasEstablished) {
            // A live connection went away. Only these are reported: a destroyed connection is the
            // app shutting down or the last device detaching, and a failed reconnect attempt is
            // the same outage continuing, not a new loss.
            track('Lost Connection', this.closeCause ?? {cause: 'socket_close'});
            problem = this.closeCause ? 'silent' : classifyConnectError(error);
            if (!this.closeCause)
                this.log(`Connection lost: ${detail}. Reconnecting.`);
            this.closeCause = null;
            this.outageSince = now;
            this.failedAttempts = 0;
            this.outageError = undefined;
        } else {
            problem = classifyConnectError(error);
            this.outageSince ??= now;
            this.failedAttempts += 1;
        }
        const delay = this.retryDelaysMs[Math.min(this.failedAttempts, this.retryDelaysMs.length - 1)];
        if (!wasEstablished) {
            // First failure of an outage, or a different failure: say so. The same failure
            // again: stay quiet, with one reminder every OUTAGE_LOG_EVERY_MS. One line per
            // attempt is what filled a whole diagnostic report and pushed out everything
            // before the outage — the part that would have explained it.
            if (detail !== this.outageError) {
                this.outageError = detail;
                this.outageLoggedAt = now;
                this.log(`Cannot connect: ${detail}. Retrying in ${delay / 1000} s.`);
            } else if (now - this.outageLoggedAt >= OUTAGE_LOG_EVERY_MS) {
                this.outageLoggedAt = now;
                this.log(`Still cannot connect: ${detail} — ${this.failedAttempts} attempts since `
                    + `${new Date(this.outageSince!).toISOString()}. Retrying every ${delay / 1000} s.`);
            }
        }
        if (!this.searching)
            this.notifyDown(problem);
        if (!wasEstablished)
            this.maybeSearch(now);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (!this.destroyed)
                this.openSocket();
        }, delay);
    }

    // After a long enough run of failed connects, ask a device to look for the pump elsewhere on
    // the subnet — a DHCP lease that moved it is the one cause of this that can fix itself.
    // Only failed connects count: a pump that connects but stays silent is still at this address.
    private maybeSearch(now: number) {
        if (this.searching || this.outageSince === null
            || now - this.outageSince < this.searchAfterMs || now - this.lastSearch < this.searchEveryMs)
            return;
        const subscribers = [...this.subscribers];
        const searcher = subscribers.find((s) => s.role === 'main' && s.searchForPump)
            ?? subscribers.find((s) => s.searchForPump);
        if (!searcher)
            return;
        this.searching = true;
        this.lastSearch = now;
        const previous = this.problem;
        this.notifyDown('searching');
        searcher.searchForPump!()
            .catch((error) => this.log('Searching for the pump failed:', error?.message ?? error))
            .finally(() => {
                this.searching = false;
                // A pump that was found has had its devices moved off this connection, which
                // destroyed it. Otherwise put back the reason the search replaced.
                if (!this.destroyed && !this.connected && this.problem === 'searching')
                    this.notifyDown(previous && previous !== 'searching' ? previous : 'unreachable');
            });
    }

    // The registers to read this cycle: everyone's wanted registers, deduped by name, plus
    // the allocator's power source(s) + priority register (which it needs even when no main
    // device is paired). Command registers are skipped — there's nothing to read back.
    private unionRegisters(): Register[] {
        const byName = new Map<string, Register>();
        if (this.debugOn && Date.now() <= this.traceUntil)
            for (const name of this.profile.diagnosticTrace ?? [])
                byName.set(name, this.profile.registerByName[name]);
        for (const subscriber of this.subscribers)
            for (const register of subscriber.wantedRegisters().filter(isPollable))
                byName.set(register.name, register);
        for (const register of this.powerRegisters)
            byName.set(register.name, register);
        if (this.priorityRegister)
            byName.set(this.priorityRegister.name, this.priorityRegister);
        // The hourly energy log needs the pump's own totals every poll, even when no device
        // selected those capabilities: Main's standby share is the consumption counter's movement
        // less what the functions booked. Relying on Main happening to carry them as capabilities
        // would lose that share the moment a user unticked one during pairing.
        for (const name of [this.profile.role.totalConsumptionRegister,
                            this.profile.role.totalProductionRegister]) {
            const register = name ? this.profile.registerByName[name] : undefined;
            if (register && isPollable(register))
                byName.set(register.name, register);
        }
        // Internal registers have no capability, so no subscriber ever asks for them — but they
        // are engine infrastructure and have to be read. The energy log lives here.
        for (const register of this.profile.registers)
            if (register.internal && isPollable(register))
                byName.set(register.name, register);
        return [...byName.values()];
    }

    lastRawFor(name: string): number | undefined {
        return this.lastRaw.get(name);
    }

    // The profile's reason inputs as Register objects, so they go through the same read path as
    // everything else. Synthetic names (`__reason.*`) keep them out of every capability path.
    private readonly reasonRegisters: [string, Register][] =
        Object.entries(this.profile.reason?.inputs ?? {}).map(([id, input]) => [id, {
            address: input.address,
            name: `__reason.${id}`,
            direction: input.direction,
            group: 'core',
            info: {en: id, sv: id},
            scale: input.scale,
            size: input.size
        }]);

    // What the model's rules remembered from earlier priority changes on this pump — e.g. that
    // the hot water charge now ending was fired by a boost rather than by the tank running down.
    // One bag per connection (so per pump, shared by its devices), deliberately not persisted:
    // it describes a run in progress, and a run the app did not watch start is one the rules
    // already have to explain without it.
    private readonly reasonState: ReasonState = {};

    // Read the pump's decision inputs and let the model turn them into a sentence. Done on
    // demand at a priority change rather than every poll, so a handful of transitions a day
    // cost a handful of extra reads. Inputs that don't read are left undefined for explain().
    async explainPriorityChange(from: number | undefined, to: number | undefined,
                                role: Role): Promise<LocalizedText | undefined> {
        const reason = this.profile.reason;
        if (!reason || this.reasonRegisters.length === 0)
            return undefined;
        const raws = await Promise.all(this.reasonRegisters.map(([, register]) =>
            this.onCooldown(register.name) ? undefined : this.readRegisterRaw(register)));
        const values = new Map<string, number>();
        this.reasonRegisters.forEach(([id, register], i) => {
            const raw = raws[i];
            if (raw === undefined || isUnavailableRaw(raw, register.size, register.unavailableRaw))
                return;
            values.set(id, signedValue(raw, register.size) / (register.scale || 1));
        });
        const previousRole = from !== undefined ? this.profile.role.priorityToRole[from] : undefined;
        return reason.explain({from, to, role, previousRole, v: (id) => values.get(id),
            state: this.reasonState});
    }

    private pduAddress(register: Register): number {
        return register.address - (this.transport.addressBase ?? this.profile.addressBase ?? 0);
    }

    // `track` records the outcome for the read-failure report. Pass false for deliberate
    // one-off probes of registers the poll loop never touches — the register dump reads the
    // whole table, and its misses are the expected answer to a question we chose to ask, not
    // faults. Without this a dump adds a second "N registers did not read" line naming things
    // the dump has already printed as "no answer", which reads like new breakage.
    async readRegisterRaw(register: Register, track = true, lane: WireLane = 'read'): Promise<number | undefined> {
        const generation = this.generation;
        const count = register.size === 32 ? 2 : 1;
        const address = this.pduAddress(register);
        const queued = Date.now();
        let started = queued;
        const evidence = (words: number[], error?: string): ReadDiagnostic => ({
            receivedAt: new Date().toISOString(), address,
            functionCode: register.direction === Dir.In ? 4 : 3, count, words,
            durationMs: Date.now() - started, queueMs: started - queued, error
        });
        return await this.withWireAccess<any>(() => {
            started = Date.now();
            return register.direction === Dir.In
                ? this.client.readInputRegisters(address, count)
                : this.client.readHoldingRegisters(address, count);
        }, lane)
            .then((resp: any) => {
                if (generation !== this.generation) return undefined;
                const words = Array.from(resp.response.body.values as number[]);
                const raw = combineRaw(words, register.size);
                if (words.length !== count || raw === undefined || Number.isNaN(raw)) {
                    this.recordRead(register, evidence(words, `Short response: expected ${count} words, got ${words.length}`));
                    if (track) this.noteRead(register, false);
                    return undefined;
                }
                this.recordRead(register, evidence(words));
                if (track) this.noteRead(register, true);
                return raw;
            })
            .catch((error) => {
                if (generation !== this.generation) return undefined;
                this.recordRead(register, evidence([], describeModbusError(error).summary));
                if (track) {
                    this.noteRead(register, false);
                    const code = describeModbusError(error).code;
                    // Only explicit unsupported-address/function errors, never timeouts, so a
                    // transient loss recovers on the next poll. A capability someone selected
                    // answered at detection, so its exception usually means a pump setting blocked
                    // it (Allow hot water off blocks 56/697): retry in 5 minutes so it comes back
                    // with the setting. Anything else — reason inputs, internal registers — was
                    // never confirmed on this pump: remembered as absent (see knownAbsent).
                    if (code === 1 || code === 2) {
                        if (this.isSelectedCapability(register.name))
                            this.unsupportedUntil.set(register.name, Date.now() + 5 * 60_000);
                        else
                            this.learnAbsent(register.name);
                    }
                }
                return undefined;
            });
    }

    // Write a register at its own width. A 32-bit register spans two words and takes ONE FC16
    // request carrying both — assembled HIGH WORD FIRST, which is the opposite of the order
    // combineRaw() reads them back in.
    //
    // That asymmetry is the pump's, and it was measured, not deduced. The pump answers every
    // plausible shape without a Modbus exception and silently discards all but one:
    //
    //   FC16 [high, low]          -> accepted, value took effect
    //   FC16 [low, high]          -> accepted, value unchanged   (mirrors the READ order)
    //   FC6 at the address        -> accepted, value unchanged
    //   FC6 at the address + 1    -> accepted, value unchanged
    //
    // Confirmed on two models and two owners: halderex's S735 (PR #5) and the maintainer's S1155,
    // each writing the zone-1 room setpoint (2505) with the original value restored between
    // attempts. Because three of the four shapes are ACKed, a partial test looks *exactly* like a
    // read-only register — this code previously sent [low, high] and the register was written off
    // as unwritable on that evidence. Do not "correct" the order to match the read path.
    async writeRegisterValue(register: Register, raw: number): Promise<void> {
        if (this.profile.readOnly) throw new Error("This driver is currently read-only.");
        if (register.noAction && !register.writeOnly) throw new Error('This register is read-only');
        const address = register.address;
        if (register.size !== 32) {
            if (this.profile.singleWordWriteFunction === 16)
                await this.writeMultipleRegisters(address, [raw]);
            else await this.writeSingleRegister(address, raw);
            return;
        }
        // Two's complement across both words, so a negative value writes 0xFFFF high rather
        // than being truncated to a large positive one. Plain arithmetic rather than bitwise
        // operators, which coerce to *signed* 32 bits — the wrong shape for an unsigned raw.
        const encoded = raw < 0 ? raw + 0x100000000 : raw;
        await this.writeMultipleRegisters(address,
            [Math.floor(encoded / 65536), encoded % 65536]);
    }

    // Throws on failure (rather than swallowing) so the write error reaches the user who
    // triggered it. `address` is the register's logical address; the model offset is applied
    // here at the wire boundary.
    async writeSingleRegister(address: number, raw: number): Promise<void> {
        if (this.profile.readOnly) throw new Error("This driver is currently read-only.");
        const pdu = address - (this.transport.addressBase ?? this.profile.addressBase ?? 0);
        try {
            await this.withWireAccess(() => this.client.writeSingleRegister(pdu, raw), 'write');
        } catch (reason: any) {
            const detail = describeModbusError(reason);
            // The whole error, verbatim, after the readable summary. jsmodbus says "A Modbus
            // Exception Occurred - See Response Body" and then we used to throw the body away,
            // which left a write failure with literally no way to tell an out-of-range value
            // from a register the pump refuses in its current state.
            this.log(`Error writing register ${address} (value ${raw}): ${detail.summary}`,
                '\n  raw error:', safeJson(reason));
            throw new Error(detail.summary);
        }
    }

    // The two-word form, for 32-bit registers. Same error handling as the single-word write:
    // throws with a readable summary rather than swallowing.
    async writeMultipleRegisters(address: number, values: number[]): Promise<void> {
        if (this.profile.readOnly) throw new Error("This driver is currently read-only.");
        const pdu = address - (this.transport.addressBase ?? this.profile.addressBase ?? 0);
        try {
            await this.withWireAccess(() => this.client.writeMultipleRegisters(pdu, values), 'write');
        } catch (reason: any) {
            const detail = describeModbusError(reason);
            this.log(`Error writing register ${address} (values ${values.join(', ')}): ${detail.summary}`,
                '\n  raw error:', safeJson(reason));
            throw new Error(detail.summary);
        }
    }

    private poll() {
        if (!this.connected || this.polling)
            return;
        this.polling = true;
        const generation = this.generation;
        this.pollDeadline = setTimeout(() => {
            if (generation !== this.generation || !this.polling) return;
            this.log('Poll exceeded its deadline — dropping the connection and reconnecting.');
            this.closeCause = {cause: 'watchdog'};
            this.connected = false;
            this.invalidateWork();
            this.notifyDown('silent');
            this.socket.destroy();
        }, this.pollDeadlineMs);
        const critical = new Set([
            this.priorityRegister?.name, ...this.powerRegisters.map((r) => r.name),
            this.profile.role.totalConsumptionRegister, this.profile.role.totalProductionRegister
        ]);
        // Keep priority and power close together, before slower diagnostic reads. Critical
        // energy inputs are never put on cooldown, even when an optional fallback is absent.
        const eligible = this.unionRegisters()
            .filter((r) => critical.has(r.name) || !this.onCooldown(r.name))
            .sort((a, b) => Number(critical.has(b.name)) - Number(critical.has(a.name)));
        const {frequent: toPoll, background} = planPoll(this.profile, eligible, this.backgroundAttempted, Date.now());
        Promise.all(toPoll.map((register) => this.readRegisterRaw(register))).then(async (raws) => {
            if (generation !== this.generation || !this.connected) return;
            const rawByName = new Map<string, number>();
            toPoll.forEach((register, i) => {
                if (raws[i] !== undefined) {
                    rawByName.set(register.name, raws[i]!);
                    this.lastRaw.set(register.name, raws[i]!);
                }
            });

            // Nothing answered at all. Not "this model lacks these registers" — the pump has
            // stopped talking while leaving the TCP connection up, which is what a pump reboot,
            // a Modbus slot taken by myUplink, or a wedged firmware looks like from here.
            // Nothing else notices: readRegisterRaw() resolves undefined rather than rejecting,
            // so this chain never fails, and setUnavailable() is only ever driven by socket
            // 'error'/'close'. Without this the device sits "online" with frozen values forever
            // and logs not one line about it.
            if (rawByName.size === 0) {
                this.deadPolls += 1;
                if (this.deadPolls >= DEAD_POLLS_BEFORE_RECONNECT) {
                    // Un-gated: this is the difference between a diagnosable report and a forum
                    // thread, and the user has no reason to have debug logging on beforehand.
                    this.log(`No register answered in ${this.deadPolls} consecutive polls — the `
                        + 'connection is up but the pump has stopped responding. Dropping it and '
                        + 'reconnecting.');
                    // Attribute the close that this end() is about to cause, rather than tracking
                    // here: otherwise a watchdog trip reports twice, once as itself and once as
                    // the socket close it deliberately caused.
                    this.closeCause = {cause: 'watchdog', dead_polls: this.deadPolls};
                    this.deadPolls = 0;
                    this.polling = false;
                    this.socket.destroy(); // 'close' → subscribers marked down, reconnect in 5 s
                    return;
                }
            } else {
                this.deadPolls = 0;
            }

            // Corrects rawByName itself, before anything below reads it — see the method
            // comment for why this is the one place this decision gets made.
            this.applyEnergyLogPriorityOverride(rawByName);

            this.reportReadFailures(rawByName.size > 0);
            this.reportEnergyLogSteps(rawByName);
            this.traceSnapshot(rawByName);
            this.allocateEnergy(rawByName);

            // Profile reset rules on priority transitions (e.g. clear "More hot water" once the
            // pump goes hot water -> idle), before dispatching so the cleared value shows.
            const rawPriority = this.priorityRegister ? rawByName.get(this.priorityRegister.name) : undefined;
            if (rawPriority !== undefined) {
                if (this.lastPriority !== undefined && rawPriority !== this.lastPriority)
                    this.applyPriorityResets(this.lastPriority, rawPriority);
                this.lastPriority = rawPriority;
            }

            for (const subscriber of this.subscribers)
                for (const register of subscriber.wantedRegisters().filter(isPollable)) {
                    const raw = rawByName.get(register.name);
                    if (raw !== undefined)
                        subscriber.onRegisterRaw(register, raw);
                }
            const readNames = new Set([...rawByName.keys()].filter((name) => {
                const register = toPoll.find((r) => r.name === name);
                return !isUnavailableRaw(rawByName.get(name)!, register?.size, register?.unavailableRaw);
            }));
            for (const subscriber of this.subscribers)
                subscriber.onPollComplete?.(readNames);

            // Publish allocation/COP before spending time on a slow parameter. These values
            // update their own capabilities, without creating another energy integration step.
            for (const register of background) {
                this.backgroundAttempted.set(register.name, Date.now());
                const raw = await this.readRegisterRaw(register);
                if (generation !== this.generation || !this.connected) return;
                if (raw === undefined) continue;
                this.lastRaw.set(register.name, raw);
                for (const subscriber of this.subscribers)
                    if (subscriber.wantedRegisters().some((r) => r.name === register.name))
                        subscriber.onRegisterRaw(register, raw);
            }
            // Bounded diagnostic probes run after normal values have been published. They
            // never enter lastRaw, discovery, subscriber values or the allocator.
            const capture = this.diagnosticCapture;
            if (capture) for (let i = 0; i < 2; i++) {
                if (generation !== this.generation || !this.connected || !this.debugOn
                    || capture !== this.diagnosticCapture) break;
                const job = capture.next(Date.now());
                if (!job) break;
                await this.readRegisterRaw(job.register, false);
                if (generation !== this.generation || capture !== this.diagnosticCapture) break;
                capture.complete(job, this.readDiagnostics.get(job.register.name), Date.now());
            }
        }).catch((error) => {
            // Not the "pump stopped answering" path — readRegisterRaw() never rejects, so this
            // only ever sees a genuine bug in the poll body above (a decode throwing, a
            // subscriber's onRegisterRaw throwing). Recovering by dropping the socket used to
            // live here; it could not fire, and the comment saying it did was worse than no
            // comment. The unresponsive-pump case is handled by the deadPolls watchdog.
            this.log('Poll failed', error?.message ?? error);
        }).finally(() => {
            if (generation !== this.generation) return;
            if (this.pollDeadline) clearTimeout(this.pollDeadline);
            this.pollDeadline = null;
            this.polling = false;
        });
    }

    // Last seen value of each energy-log register, so a step can be told from a steady reading.
    // Undefined until the first poll — the value standing when the app starts describes an hour
    // we did not watch, so it is recorded as the baseline and not reported as a step.
    private lastEnergyLog = new Map<string, number>();
    private energyLogStarted = false;
    // UTC hour of the last step, so an hour whose figures happen to repeat still closes.
    private lastReportedHour: number | null = null;
    private firstStepSeen = false;
    // The pump's consumption counter as it stood at the previous hourly step.
    private usedAtLastStep: number | undefined;
    // What the functions booked at the previous step, held back because the counter lags the log
    // by about an hour: Main's standby share is next step's counter movement less this.
    private pendingUsed: number | undefined;

    // The pump publishes its own per-function energy for each completed hour. Hand each function
    // its hour, and Main whatever the counter moved beyond them.
    private reportEnergyLogSteps(rawByName: Map<string, number>) {
        const entries = this.profile.energyLog;
        if (!entries?.length)
            return;
        // Two triggers, and the second one exists because the first is not sufficient.
        //
        // A value *change* is the precise trigger: it fires exactly when the pump publishes,
        // so both sides of the comparison cover the same hour with no drift. But two
        // consecutive hours can book identical figures — a quiet summer night books 0 to
        // everything, hour after hour — and then nothing changes, nothing fires, and the
        // accumulators run on into the next hour while the pump's figure still describes one.
        // The next report then compares two hours of ours against one of theirs.
        //
        // Found by halderex on an S735 (issue #4), where three of nine hours were skipped. Our
        // own S1155 log has the same gaps: 16:00, then 19:00, then 21:00.
        //
        // So: clock rollover is the safety net, held a minute past the hour to let the pump
        // publish before we look.
        const now = new Date();
        const nowHour = now.getUTCHours();
        const rolled = this.lastReportedHour !== null
            && nowHour !== this.lastReportedHour
            && now.getUTCMinutes() >= 1;
        let stepped = false;
        const values = new Map<string, number>();
        for (const entry of entries) {
            const register = this.profile.registerByName[entry.name];
            const raw = register ? rawByName.get(entry.name) : undefined;
            if (raw === undefined || isUnavailableRaw(raw, register!.size, register!.unavailableRaw))
                continue;
            const value = signedValue(raw, register!.size) / (register!.scale || 1);
            const previous = this.lastEnergyLog.get(entry.name);
            this.lastEnergyLog.set(entry.name, value);
            values.set(entry.label, value);
            if (previous !== undefined && value !== previous && this.energyLogStarted)
                stepped = true;
        }
        // Sum the per-function figures by side. Anything the additional heater used is
        // electricity, so it belongs on the used side.
        const sumOf = (pick: (label: string) => boolean) =>
            [...values.entries()].filter(([label]) => pick(label))
                .reduce((acc, [, v]) => acc + v, 0);

        // The pump's own consumption counter, read the same poll.
        const counter = this.profile.role.totalConsumptionRegister
            ? this.profile.registerByName[this.profile.role.totalConsumptionRegister] : undefined;
        const counterRaw = counter ? rawByName.get(counter.name) : undefined;
        const used = counterRaw === undefined || isUnavailableRaw(counterRaw, counter!.size, counter!.unavailableRaw)
            ? undefined : signedValue(counterRaw, counter!.size) / (counter!.scale || 1);

        if (!this.energyLogStarted) {
            this.energyLogStarted = true;
            this.lastReportedHour = nowHour;
            this.usedAtLastStep = used;
            return;
        }
        if ((stepped || rolled) && !this.firstStepSeen) {
            // The first step after startup covers an hour the app only saw part of, so it only
            // anchors the counter on a true :00 boundary.
            this.firstStepSeen = true;
            this.lastReportedHour = nowHour;
            this.usedAtLastStep = used;
            return;
        }
        if (stepped || rolled) {
            this.lastReportedHour = nowHour;
            // The counter lags the log by about an hour: measured on a live S1155, the log booked
            // 1.44 kWh of hot water at 11:00 while 3823 had not moved at all, and 3823 then gained
            // 1.40 over the following hour. So the movement measured now belongs with the split
            // booked at the PREVIOUS step.
            const dUsed = used !== undefined && this.usedAtLastStep !== undefined
                ? used - this.usedAtLastStep : undefined;
            const pending = this.pendingUsed;
            // Hand each function its own hour. The log is prompt at :00 — it is the lifetime
            // counters that lag — so these need no shifting and can drive the meters directly.
            const perRole = new Map<Role, {used?: number; produced?: number}>();
            for (const entry of entries) {
                const value = values.get(entry.label);
                if (value === undefined)
                    continue;
                const slot = perRole.get(entry.role) ?? {};
                // Several entries can feed one side (a function's own use plus whatever the
                // additional heater drew for it), so accumulate rather than overwrite.
                slot[entry.flow] = (slot[entry.flow] ?? 0) + value;
                perRole.set(entry.role, slot);
            }
            for (const subscriber of this.subscribers) {
                const slot = perRole.get(subscriber.role);
                if (slot)
                    subscriber.onEnergyLogHour?.(slot.used, slot.produced);
            }
            // Main's share is what the pump attributed to no function at all — real standby,
            // and the reason idle stays broken out. Uses the counter delta, which lags, so it
            // describes the previous hour; that is what `pendingUsed` is holding.
            const main = [...this.subscribers].find((s) => s.role === 'main');
            if (main && pending !== undefined && dUsed !== undefined)
                main.onEnergyLogHour?.(Math.max(0, dUsed - pending), undefined);

            this.pendingUsed = sumOf((label) => label.includes('used') || label.startsWith('add.heat'));
            this.usedAtLastStep = used;
        }
    }

    private energySubscribers(): PumpSubscriber[] {
        return [...this.subscribers].filter((subscriber) =>
            functionRoles.includes(subscriber.role) || subscriber.role === 'main');
    }

    private deviceForRole(role: Role): PumpSubscriber | undefined {
        return [...this.subscribers].find((subscriber) => subscriber.role === role);
    }

    // Apply the profile's reset-on-priority-change rules: when the raw priority moves from
    // `from` to `to`, write the configured registers to their off value (e.g. clear the
    // one-time "More hot water" boost after the pump has delivered it and returned to idle).
    // Skips registers that aren't polled or are already off, and swallows write errors — a
    // contextual Modbus rejection shouldn't break the poll.
    private applyPriorityResets(from: number, to: number) {
        for (const rule of this.profile.role.resetOnPriorityChange ?? []) {
            if (rule.from !== from || rule.to !== to)
                continue;
            const register = this.profile.registerByName[rule.register];
            if (!register)
                continue;
            const off = register.offValue ?? 0;
            const current = this.lastRaw.get(rule.register);
            if (current === undefined || current === off)
                continue; // not polled, or already off — nothing to reset
            this.debug(`Priority ${from} -> ${to}: resetting ${rule.register}`);
            this.lastRaw.set(rule.register, off); // reflect immediately so it can't re-fire
            this.writeSingleRegister(register.address, off)
                .catch((error) => this.log(`Reset of ${rule.register} failed: ${error?.message ?? error}`));
        }
    }

    // Work out why the pump changed priority, log it, and hand it to the subscribers so the
    // main device can fire its trigger. Fire-and-forget: the extra reads must not hold up the
    // poll, and a failed read just means no reason rather than a broken poll.
    private announcePriorityChange(from: number | undefined, to: number | undefined,
                                   role: Role, headline: string) {
        this.explainPriorityChange(from, to, role)
            .catch(() => undefined)
            .then((reason) => {
                this.debug(headline + (reason ? ` — ${reason.en}` : ''));
                for (const subscriber of this.subscribers)
                    subscriber.onPriorityChange?.(from, to, role, reason);
            });
    }

    // A priority code the model doesn't map means this pump is producing something the app
    // cannot name, and every watt of it is charged to Main as standby. That is a functional
    // fault — the user sees idle energy climbing while their heating or hot water device sits
    // near zero — so it is logged un-gated, like a missing power source. Once per code.
    private logUnknownPriority(raw: number) {
        if (this.loggedUnknownPriority.has(raw))
            return;
        this.loggedUnknownPriority.add(raw);
        const known = Object.entries(this.profile.role.priorityToRole)
            .map(([code, role]) => `${code}=${role}`).join(', ');
        this.log(`Unknown operating-priority value ${raw} — its energy is being charged to Main `
            + `(idle), so per-function energy will read low. Known codes for this model: ${known}.`);
    }

    // The pump is producing <role> but no device of that role is attached, so its draw is
    // being charged to Main (idle) — misattribution that otherwise leaves no trace. Logged
    // at most once per 5 min per role so a persistent case keeps reminding without spamming.
    private warnMissingRoleDevice(role: Role, watts: number) {
        const now = Date.now();
        if (now - (this.lastMissingRoleWarn.get(role) ?? 0) < 5 * 60 * 1000)
            return;
        this.lastMissingRoleWarn.set(role, now);
        // Un-gated for the same reason as an unknown priority code: the visible symptom is
        // idle energy climbing while a function device reads near zero, and nothing else in
        // the log would say why.
        this.log(`No '${role}' device attached; charging its ${watts}W draw to Main (idle) `
            + `instead — energy misattributed. Is the ${role} device paired and available?`);
    }

    // Total instantaneous power (watts) from the model's power source register(s), each
    // converted to watts via its scale (S: one whole-unit register; inverter F: compressor +
    // electric addition). Returns null when the model has no power source or none read.
    private totalWatts(rawByName: Map<string, number>): number | null {
        // Resolved per poll rather than latched at connect or frozen at pairing: detection is
        // skippable, the connection is shared by every device of this pump, and a stored
        // choice would go stale on a firmware change. The preference order makes this stable
        // in practice — a pump either has the preferred register or it never does.
        for (let group = 0; group < this.powerGroups.length; ++group) {
            const watts = this.groupWatts(group, rawByName);
            if (watts === null)
                continue;
            this.notePowerGroup(group);
            return watts;
        }
        return null;
    }

    // What the tiles should show, which is not always what the meters integrate. Falls back to
    // the metered figure so a tile is never blanker than the meter is.
    private displayWatts(rawByName: Map<string, number>, fallback: number): number {
        for (let group = 0; group < this.displayGroups.length; ++group) {
            const watts = this.groupWatts(group, rawByName, this.displayGroups);
            if (watts !== null)
                return watts;
        }
        return fallback;
    }

    // The summed reading of one power group, or null when none of its registers answered.
    private groupWatts(group: number, rawByName: Map<string, number>,
                       groups: Register[][] = this.powerGroups): number | null {
        let watts = 0;
        let any = false;
        for (const register of groups[group] ?? []) {
            const raw = rawByName.get(register.name);
            if (raw === undefined || isUnavailableRaw(raw, register.size, register.unavailableRaw))
                return null;
            const value = toNumericValue(register, raw);
            if (value === undefined || !Number.isFinite(value) || value < 0) return null;
            any = true;
            watts += value;
        }
        return any ? watts : null;
    }

    private notePowerGroup(group: number) {
        if (group === this.activePowerGroup)
            return;
        const previous = this.activePowerGroup;
        this.activePowerGroup = group;
        const names = this.powerGroups[group].map((r) => `${r.address} ${r.name}`).join(' + ');
        this.log(previous === undefined
            ? `Energy allocator power source: ${names}.`
            : `Energy allocator power source changed to ${names}.`);
    }

    // A null power reading disables the whole energy path — no allocation, no per-function
    // meter, no per-function COP — and used to do so in complete silence. It is not an
    // exotic case: register 2166 is the only power source declared for S, and it does not
    // exist on S320/S325, S330/S332 or S2125, so every VVM/split install lands here. Logged
    // un-gated on transition, because the user who needs this line has not enabled debug
    // logging yet.
    private notePowerAvailability(available: boolean) {
        // A model that declares no power source at all (fixed-speed F) is meant to skip the
        // allocator — that is configuration, not a fault, so say nothing.
        if (this.powerRegisters.length === 0 || available === this.powerAvailable)
            return;
        this.powerAvailable = available;
        // The recovery case is already covered by notePowerGroup(), which names the source
        // that answered — so only the failure needs saying here.
        if (available)
            return;
        const sources = this.powerRegisters.map((r) => `${r.address} ${r.name}`).join(', ');
        this.log(`No power reading from any candidate source (${sources}) — the pump's electrical draw cannot be `
                + `measured, so per-function energy and every COP will stay empty. This register `
                + `is absent on some S models (S320/S325, S330/S332, S2125).`);
    }

    // 3804 (see registers.ts) has been observed naming an active function while the documented
    // priority register (1028) reports idle — confirmed live against myUplink's own "Priority"
    // reading, which agreed with 3804 and not with 1028 during exactly that state (both read
    // 30 within ~1s of each other; 1028 read 10 throughout). Rather than have the tile, the
    // priority_changed trigger, the reset rules and the energy allocator each separately decide
    // whether to trust 1028 or 3804, this corrects rawByName itself — once, here, before any of
    // them read it — so everything downstream just sees one already-correct value. That's the
    // whole rule: one correction point, not four places that each have to agree on the logic.
    //
    // Only ever steps in for that one proven failure mode: 1028 reads idle (main) AND 3804
    // names something else. An active 1028 reading is never overridden — every observation so
    // far has 1028 and 3804 agreeing once 1028 is off idle (a "More hot water" boost had both
    // read 20 in the same poll), so there's no evidence to act on in that direction, only this
    // one. Absent on some models (registerByName lookup fails) — a no-op there, same as today.
    private applyEnergyLogPriorityOverride(rawByName: Map<string, number>) {
        if (!this.priorityRegister || !this.energyLogPriorityRegister)
            return;
        const rawPriority = rawByName.get(this.priorityRegister.name);
        if (rawPriority === undefined || this.profile.role.priorityToRole[rawPriority] !== 'main')
            return;
        const rawEnergyLog = rawByName.get(this.energyLogPriorityRegister.name);
        if (rawEnergyLog === undefined)
            return;
        const mapped = this.profile.role.priorityToRole[rawEnergyLog];
        if (!mapped || mapped === 'main')
            return;
        // Every capability sharing the priority register's address (the enum tile and its raw
        // Insights-charted twin) has to move together, or they'd disagree with each other on
        // top of disagreeing with the pump.
        for (const register of this.profile.registers)
            if (register.address === this.priorityRegister.address)
                rawByName.set(register.name, rawEnergyLog);
    }

    // Integrate total power into a per-function kWh bucket, charged to whichever function the
    // pump is currently prioritising, and push the live draw (watts) to the active device and 0
    // to the others. Skipped entirely on models with no power source (fixed-speed F).
    private allocateEnergy(rawByName: Map<string, number>) {
        const now = Date.now();
        const deltaTimeHours = (now - this.lastPollTime) / (1000 * 60 * 60);

        const watts = this.totalWatts(rawByName);
        this.notePowerAvailability(watts !== null);
        if (watts === null) {
            this.lastPowerReading = null;
            // Tell the energy subscribers their series has a gap here, rather than leaving them
            // to assume the last reading still holds.
            for (const subscriber of this.energySubscribers())
                subscriber.onEnergyUnavailable?.();
        }
        if (watts !== null) {
            // Already corrected by applyEnergyLogPriorityOverride() if 3804 disagreed with an
            // idle 1028 — this is not necessarily what 1028 itself is reporting right now.
            const rawPriority = this.priorityRegister
                ? rawByName.get(this.priorityRegister.name)
                : undefined;

            // Default (and unknown-priority fallback) is 'main' = standby.
            let role: Role = 'main';
            if (rawPriority !== undefined) {
                const mapped = this.profile.role.priorityToRole[rawPriority];
                if (mapped) role = mapped;
                else this.logUnknownPriority(rawPriority);
            }

            // Diagnostic: dump every priority change with the code, where it's charged, and
            // the live draw. When rawPriority differs from what 1028 itself actually read
            // (lastRaw, set before the override ran), the line says so — a correction should
            // never be silently indistinguishable from a genuine 1028 reading in the log.
            if (rawPriority !== this.lastLoggedPriority) {
                const mapped = rawPriority !== undefined ? this.profile.role.priorityToRole[rawPriority] : undefined;
                const from = this.lastLoggedPriority;
                this.lastLoggedPriority = rawPriority;
                const trueRaw = this.priorityRegister ? this.lastRaw.get(this.priorityRegister.name) : undefined;
                const corrected = trueRaw !== undefined && trueRaw !== rawPriority;
                this.announcePriorityChange(from, rawPriority, role,
                    `Priority change: raw=${rawPriority} -> role=${role}`
                    + `${mapped ? '' : ' (UNMAPPED)'} draw=${watts}W`
                    + `${corrected ? ` (1028 itself still reads ${trueRaw}; corrected via 3804)` : ''}`);
            }

            // Resolve to an attached device, falling back to Main (which always exists when
            // energy is being tracked, and is the standby catch-all).
            const wanted = this.deviceForRole(role);
            const target = wanted ?? this.deviceForRole('main');
            const activeRole = target?.role ?? null;

            // A function role that resolved but whose device isn't attached silently dumps
            // its draw into Main (idle) — this is exactly the bug that inflated idle energy
            // when the Heating device wasn't subscribed. Warn loudly (throttled) rather than
            // charge it to idle without a trace.
            if (!wanted && role !== 'main')
                this.warnMissingRoleDevice(role, watts);

            const delta = this.lastPowerReading !== null
                ? ((this.lastPowerReading + watts) / 2) * deltaTimeHours / 1000
                : 0;

            // The meter gets `delta` (integrated from the metered source); the tile gets the
            // display source, which reacts faster. Separate on purpose — see displayPowerSources.
            const shown = this.displayWatts(rawByName, watts);
            for (const subscriber of this.energySubscribers()) {
                if (activeRole && subscriber.role === activeRole)
                    subscriber.onEnergy?.(delta, shown);
                else
                    subscriber.onEnergy?.(0, 0);
            }
            if (!target && delta > 0)
                this.debug(`No device for role ${role} (or Main fallback); dropping ${delta.toFixed(5)} kWh`);

            this.lastPowerReading = watts;
        }

        this.lastPollTime = now;
    }

    // Re-run feature detection over the live connection (used by repair and by pairing when a
    // device for this pump already holds the single allowed connection).
    async probe(onProgress: (pass: number, passes: number) => void,
                signal?: AbortSignal): Promise<DetectionResult> {
        if (!this.connected)
            throw new Error('Not connected to the heat pump');
        // Detection is where the pump is asked what it has again, so forget what it said before:
        // a register that answers now (a firmware update, a feature switched on) is read again.
        if (this.knownAbsent.size) {
            this.knownAbsent.clear();
            this.reportAbsent();
        }
        const generation = this.generation;
        const {probes, addresses, choices} = await sampleRegisters(this.profile,
            async (register) => {
                if (generation !== this.generation || !this.connected)
                    throw new Error('Connection changed during detection');
                const raw = await this.readRegisterRaw(register, false);
                return raw === undefined ? undefined : toNumericValue(register, raw);
            }, onProgress, undefined, undefined, signal);
        return buildDetectionResult(this.profile, probes, addresses, choices);
    }

    isConnected(): boolean {
        return this.connected;
    }

    private isSelectedCapability(name: string): boolean {
        return [...this.subscribers].some((subscriber) =>
            subscriber.wantedRegisters().some((register) => register.name === name));
    }

    // Absent on this pump, or answered exception 1 or 2 recently — left alone either way. Every
    // path that reads on its own schedule honours this, not just the poll, or the same absent
    // register is re-asked (and re-logged) from each of them.
    onCooldown(name: string): boolean {
        return this.knownAbsent.has(name) || Date.now() < (this.unsupportedUntil.get(name) ?? 0);
    }

    private learnAbsent(name: string) {
        if (this.knownAbsent.has(name))
            return;
        this.knownAbsent.add(name);
        this.reportAbsent();
    }

    private reportAbsent() {
        const names = [...this.knownAbsent];
        for (const subscriber of this.subscribers)
            subscriber.onAbsentRegisters?.(names);
    }

    shutdown() {
        this.destroy();
    }
}

// Close every open pump connection — called on driver unload so the pump's single Modbus
// slot is released promptly instead of lingering until it times out.
export function destroyAllConnections() {
    for (const connection of [...connections.values()])
        connection.shutdown();
}

// Look up an existing connection without creating one — used by pairing to decide whether it
// must probe over a live device connection instead of opening its own.
export function existingConnection(host: string): PumpConnection | undefined {
    return connections.get(host);
}
