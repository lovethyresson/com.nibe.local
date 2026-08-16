import net from 'net';
import {ModbusTCPClient} from 'jsmodbus';
import {Dir, Register, combineRaw, isPollable, isUnavailableRaw, signedValue} from './registers';
import {Role, functionRoles} from './roles';
import type {LocalizedText, ModelProfile, ReasonState} from './profile';
import {DetectionResult, buildDetectionResult, readNumeric, sampleRegisters} from './detection';
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

export interface Transport {
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
    wantedRegisters(): Register[];
    onRegisterRaw(register: Register, raw: number): void;
    onConnectionUp(): void;
    onConnectionDown(): void;
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
// failed write says nothing at all about why it failed.
const MODBUS_EXCEPTIONS: Record<number, string> = {
    1: 'Illegal function — the pump does not support writing this register',
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
    private retryTimer: NodeJS.Timeout | null = null;
    private connected = false;
    private destroyed = false;
    // Set by the watchdog just before it drops the socket, so the resulting 'close' is reported as
    // the watchdog trip it is rather than as an anonymous disconnect. Cleared once consumed.
    private closeCause: {cause: string; dead_polls?: number} | null = null;
    // Consecutive polls where not one register answered. See the watchdog in poll().
    private deadPolls = 0;

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
        return new Promise<T>((resolve, reject) => {
            (lane === 'write' ? this.wireHigh : this.wireLow)
                .push({run: fn, resolve: resolve as (value: unknown) => void, reject});
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

    // Energy integrator state. lastPowerReading is null right after every (re)connect so a
    // connection gap isn't counted as continuous runtime at whatever power the first poll reads.
    private lastPowerReading: number | null = null;
    private lastPollTime = Date.now();
    private loggedUnknownPriority = new Set<number>();
    // Diagnostic: last raw priority we logged a transition for, so the log shows every
    // change (not just idle<->active flips) with its mapped role and the live draw —
    // used to discover which raw code a producing pump actually reports per function.
    private lastLoggedPriority: number | undefined = undefined;
    // Diagnostic: same, for the undocumented 3804 register (see registers.ts) — tracked
    // independently so a 3804 transition logs even on a poll where 1028 doesn't move, which
    // is exactly the case under investigation (1028 stuck at 10 while the pump is heating).
    private lastLoggedEnergyLogPriority: number | undefined = undefined;
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
    // The pump's own cumulative consumption counter (S: register 3823), when the model has
    // one. Only present on models that expose it — F derives consumption from power registers
    // and has no such counter, so it keeps pure trapezoidal integration with no reconciliation.
    private readonly consumptionRegister?: Register;
    // The undocumented 3804 register (see registers.ts) — diagnostic only, absent on some
    // models (registerByName returns undefined), same graceful-degradation as the above.
    private readonly energyLogPriorityRegister?: Register;

    // ---- Reconciliation shadow monitor (diagnostic only; does not touch the live meters) ----
    // The live meters accumulate the trapezoidal integral. Alongside that we track what two
    // candidate strategies WOULD have accumulated, so their drift against the pump's own
    // counter can be compared from the logs before either is adopted:
    //   trapezoid — today's behaviour: integrate instantaneous power over real elapsed time.
    //   A (counter) — allocate the pump counter's own delta each poll (exact by construction,
    //                 but a coarse staircase since the counter steps in 0.1 kWh).
    //   B (feed-forward) — integrate, but steer the running error back toward the counter with
    //                 a clamped correction so the meter stays smooth AND tracks the counter.
    private shadowTrapezoid = 0;   // Σ integrated kWh since the monitor started
    private shadowCounterA = 0;    // Σ pump-counter deltas over the same span
    private shadowB = 0;           // Σ feed-forward-corrected kWh
    private shadowErrorB = 0;      // running (ours − pump) error driving B's correction
    private lastConsumptionRaw: number | undefined = undefined;
    private shadowStarted = 0;     // timestamp of the first reconciled poll
    private lastShadowLog = 0;
    private static readonly SHADOW_LOG_MS = 30 * 60 * 1000; // summarise every 30 min
    private static readonly SHADOW_B_GAIN = 0.2;            // k: fraction of error corrected per poll

    private constructor(private host: string, private profile: ModelProfile, private transport: Transport) {
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
        this.consumptionRegister = profile.role.totalConsumptionRegister
            ? profile.registerByName[profile.role.totalConsumptionRegister]
            : undefined;
        this.energyLogPriorityRegister =
            profile.registerByName['measure_priority_NIBE.i3804_energylog_priority'];
        this.openSocket();
    }

    private openSocket() {
        this.socket = new net.Socket();
        this.client = new ModbusTCPClient(this.socket, this.transport.unitId, 5000);
        this.socket.on('connect', () => this.onConnect());
        this.socket.on('error', (error) => this.onSocketError(error));
        this.socket.on('close', () => this.onClose());
        this.debug(`Connecting (port ${this.transport.port}, unit ${this.transport.unitId})`);
        this.socket.connect({port: this.transport.port, host: this.host});
    }

    static get(host: string, profile: ModelProfile, transport: Transport): PumpConnection {
        let connection = connections.get(host);
        if (!connection) {
            connection = new PumpConnection(host, profile, transport);
            connections.set(host, connection);
        }
        return connection;
    }

    // The connection isn't a Homey Device/Driver, so its output goes through console.log and
    // doesn't get the ISO timestamp that Homey prefixes onto device/driver logs. Add one in the
    // same format, so connection lines interleave readably with the rest of the app log.
    private log(...args: any[]) {
        console.log(`${new Date().toISOString()} [PumpConnection ${this.host}]`, ...args);
    }

    // Verbose logging (polling, priority changes, energy allocation). Off unless one of the
    // attached devices has "Debug logging" enabled; errors always log via this.log().
    private debugOn = false;

    refreshDebug() {
        const on = [...this.subscribers].some((subscriber) => subscriber.debugEnabled?.() ?? false);
        const turnedOn = on && !this.debugOn;
        this.debugOn = on;
        // Someone just switched debug logging on — almost always *after* the thing they are
        // chasing already happened. Restate the standing read failures so the log they are
        // about to send actually contains them.
        if (turnedOn)
            this.logStandingFailures();
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
        if (transport.port === this.transport.port && transport.unitId === this.transport.unitId)
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
        this.socket.removeAllListeners();
        this.socket.destroy();
        this.subscribers.forEach((subscriber) => subscriber.onConnectionDown());
        this.openSocket();
    }

    attach(subscriber: PumpSubscriber) {
        this.subscribers.add(subscriber);
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
            subscriber.onConnectionDown();
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
        // Also clear `connected`: removeAllListeners() below means onClose() will never run, so
        // nothing else ever would. Without it poll() — including the one already scheduled by
        // onConnect()'s 200 ms timer — passes its `!this.connected` guard and runs against a
        // destroyed socket, which the watchdog would then try to end() a second time.
        this.connected = false;
        if (this.pollInterval) clearInterval(this.pollInterval);
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.socket.removeAllListeners();
        this.socket.end();
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
        this.connected = true;
        this.lastPowerReading = null;
        this.lastPriority = undefined;
        // Drop the counter reference too: across a connection gap the pump kept consuming, and
        // that whole offline delta would otherwise land on the first poll after reconnect and
        // skew the comparison (the trapezoid side deliberately counts nothing for the gap).
        this.lastConsumptionRaw = undefined;
        this.lastPollTime = Date.now();
        this.polling = false;
        this.deadPolls = 0;
        this.subscribers.forEach((subscriber) => subscriber.onConnectionUp());
        setTimeout(() => this.poll(), 200);
        this.pollSeconds = this.desiredPollSeconds();
        this.debug(`Polling every ${this.pollSeconds} s`);
        this.pollInterval = setInterval(() => this.poll(), this.pollSeconds * 1000);
    }

    private onSocketError(error: any) {
        this.log('Socket error', error?.message ?? error);
        this.connected = false;
        this.subscribers.forEach((subscriber) => subscriber.onConnectionDown());
    }

    private onClose() {
        this.connected = false;
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        this.subscribers.forEach((subscriber) => subscriber.onConnectionDown());
        if (this.destroyed)
            return;
        // Only unexpected closes are reported. A destroyed connection is the app shutting down or
        // the last device detaching, which is not a pump losing its socket.
        track('Lost Connection', this.closeCause ?? {cause: 'socket_close'});
        this.closeCause = null;
        this.debug('Socket closed, reconnecting in 5 seconds ...');
        this.retryTimer = setTimeout(() => {
            if (!this.destroyed)
                this.socket.connect({port: this.transport.port, host: this.host});
        }, 5000);
    }

    // The registers to read this cycle: everyone's wanted registers, deduped by name, plus
    // the allocator's power source(s) + priority register (which it needs even when no main
    // device is paired). Command registers are skipped — there's nothing to read back.
    private unionRegisters(): Register[] {
        const byName = new Map<string, Register>();
        for (const subscriber of this.subscribers)
            for (const register of subscriber.wantedRegisters().filter(isPollable))
                byName.set(register.name, register);
        for (const register of this.powerRegisters)
            byName.set(register.name, register);
        if (this.priorityRegister)
            byName.set(this.priorityRegister.name, this.priorityRegister);
        // The reconciliation monitors need the pump's own totals every poll, even when no device
        // selected those capabilities — consumption for the shadow monitor, and both for the
        // energy-log reconciliation. Relying on Main happening to carry them as capabilities
        // would make the comparison vanish the moment a user unticked one during pairing.
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
        const raws = await Promise.all(
            this.reasonRegisters.map(([, register]) => this.readRegisterRaw(register)));
        const values = new Map<string, number>();
        this.reasonRegisters.forEach(([id, register], i) => {
            const raw = raws[i];
            if (raw === undefined || isUnavailableRaw(raw, register.size))
                return;
            values.set(id, signedValue(raw, register.size) / (register.scale || 1));
        });
        const previousRole = from !== undefined ? this.profile.role.priorityToRole[from] : undefined;
        return reason.explain({from, to, role, previousRole, v: (id) => values.get(id),
            state: this.reasonState});
    }

    private pduAddress(register: Register): number {
        return this.profile.addressBase ? register.address - this.profile.addressBase : register.address;
    }

    // `track` records the outcome for the read-failure report. Pass false for deliberate
    // one-off probes of registers the poll loop never touches — the register dump reads the
    // whole table, and its misses are the expected answer to a question we chose to ask, not
    // faults. Without this a dump adds a second "N registers did not read" line naming things
    // the dump has already printed as "no answer", which reads like new breakage.
    async readRegisterRaw(register: Register, track = true): Promise<number | undefined> {
        const count = register.size === 32 ? 2 : 1;
        const address = this.pduAddress(register);
        return await this.withWireAccess<any>(() => (register.direction === Dir.In)
            ? this.client.readInputRegisters(address, count)
            : this.client.readHoldingRegisters(address, count))
            .then((resp: any) => {
                const raw = combineRaw(resp.response.body.values as number[], register.size);
                // A pump can answer without returning a usable value — a short or empty value
                // array yields undefined (16-bit) or NaN (32-bit, missing high word). That is
                // a failed read, not a reading of zero, and must not be scored as a success.
                if (raw === undefined || Number.isNaN(raw)) {
                    if (track) this.noteRead(register, false);
                    return undefined;
                }
                if (track) this.noteRead(register, true);
                return raw;
            })
            .catch(() => {
                if (track) this.noteRead(register, false);
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
        const address = register.address;
        if (register.size !== 32) {
            await this.writeSingleRegister(address, raw);
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
        const pdu = this.profile.addressBase ? address - this.profile.addressBase : address;
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
        const pdu = this.profile.addressBase ? address - this.profile.addressBase : address;
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
        const toPoll = this.unionRegisters();
        Promise.all(toPoll.map((register) => this.readRegisterRaw(register))).then((raws) => {
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
                    this.socket.end(); // 'close' → subscribers marked down, reconnect in 5 s
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
        }).catch((error) => {
            // Not the "pump stopped answering" path — readRegisterRaw() never rejects, so this
            // only ever sees a genuine bug in the poll body above (a decode throwing, a
            // subscriber's onRegisterRaw throwing). Recovering by dropping the socket used to
            // live here; it could not fire, and the comment saying it did was worse than no
            // comment. The unresponsive-pump case is handled by the deadPolls watchdog.
            this.log('Poll failed', error?.message ?? error);
        }).finally(() => {
            this.polling = false;
        });
    }

    // Last seen value of each energy-log register, so a step can be told from a steady reading.
    // Undefined until the first poll — the value standing when the app starts describes an hour
    // we did not watch, so it is recorded as the baseline and not reported as a step.
    private lastEnergyLog = new Map<string, number>();
    private energyLogStarted = false;
    // UTC hour of the last report, so an hour whose figures happen to repeat still closes.
    private lastReportedHour: number | null = null;
    private firstStepSeen = false;
    // The pump's lifetime counters as they stood at the previous hourly step, so each logged
    // hour can carry its own total alongside the per-function split. Without this the split is
    // unverifiable from the log alone — you would need a second source to know what it should
    // add up to, which is exactly the round trip this logging exists to avoid.
    private totalsAtLastStep: {produced?: number; used?: number} = {};
    // The previous step's per-function totals, held back so they can be reconciled against the
    // counter movement measured at the NEXT step — the counters lag the log by about an hour.
    private pendingSplit: {hour: string; used: number; produced: number} | undefined;

    // The pump publishes its own per-function energy for each completed hour. Report each step
    // once, as one line covering the whole hour, so a support log shows what the pump itself
    // booked next to what the allocator estimated. Observation only for now — nothing depends
    // on these values yet, which is the point: they have never been seen on an S320-class pump,
    // and `cooling=NO` governs this very block.
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
        // own S1155 log has the same gaps: 16:00, then 19:00, then 21:00. It corrupts only the
        // diagnostics — the meters never read these figures — but the diagnostics are what the
        // 2166-vs-2305 decision rests on, so it matters now.
        //
        // So: clock rollover is the safety net, held a minute past the hour to let the pump
        // publish before we look.
        const now = new Date();
        const nowHour = now.getUTCHours();
        const rolled = this.lastReportedHour !== null
            && nowHour !== this.lastReportedHour
            && now.getUTCMinutes() >= 1;
        const stepped: string[] = [];
        const values = new Map<string, number>();
        for (const entry of entries) {
            const register = this.profile.registerByName[entry.name];
            const raw = register ? rawByName.get(entry.name) : undefined;
            if (raw === undefined || isUnavailableRaw(raw, register!.size))
                continue;
            const value = signedValue(raw, register!.size) / (register!.scale || 1);
            const previous = this.lastEnergyLog.get(entry.name);
            this.lastEnergyLog.set(entry.name, value);
            values.set(entry.label, value);
            if (previous !== undefined && value !== previous && this.energyLogStarted)
                stepped.push(`${entry.label}=${value}`);
        }
        // Sum the per-function figures by side. Anything the additional heater used is
        // electricity, so it belongs on the used side.
        const sumOf = (pick: (label: string) => boolean) =>
            [...values.entries()].filter(([label]) => pick(label))
                .reduce((acc, [, v]) => acc + v, 0);

        // The pump's own lifetime counters, read the same poll.
        const totalNow = (name?: string) => {
            const register = name ? this.profile.registerByName[name] : undefined;
            const raw = register ? rawByName.get(register.name) : undefined;
            return raw === undefined || isUnavailableRaw(raw, register!.size)
                ? undefined : signedValue(raw, register!.size) / (register!.scale || 1);
        };
        const produced = totalNow(this.profile.role.totalProductionRegister);
        const used = totalNow(this.profile.role.totalConsumptionRegister);

        if (!this.energyLogStarted) {
            this.energyLogStarted = true;
            this.lastReportedHour = nowHour;
            this.totalsAtLastStep = {produced, used};
            this.debug(`Energy log baseline recorded for ${this.lastEnergyLog.size} register(s) `
                + `— steps will be reported from the next completed hour.`);
            return;
        }
        if ((stepped.length || rolled) && !this.firstStepSeen) {
            // The first step after startup is not comparable. The pump's figure covers the whole
            // hour it reports, but the lifetime counters were only sampled from whenever the app
            // connected — part-way through it. Reporting the two side by side would show the
            // split exceeding the total for reasons that have nothing to do with the pump. Use
            // this step to anchor the counters on a true :00 boundary instead; every line from
            // here on has both sides covering exactly the same hour.
            this.firstStepSeen = true;
            this.lastReportedHour = nowHour;
            this.totalsAtLastStep = {produced, used};
            this.debug('Energy log stepped for the first time — the app connected part-way '
                + 'through that hour, so it is used to align the counters rather than reported. '
                + 'Full hours follow.');
            return;
        }
        if (stepped.length || rolled) {
            this.lastReportedHour = nowHour;
            const hour = `${now.toISOString().slice(11, 13)}:00`;
            this.debug(`Energy log — the pump's own figures for the hour ending ${hour} UTC: `
                + `${stepped.length ? stepped.join(', ') : 'unchanged from last hour'} kWh`);

            // The lifetime counters lag the log by about an hour: measured on a live S1155, the
            // log booked 1.44 kWh of hot water at 11:00 while 3823 had not moved at all, and
            // 3823 then gained 1.40 over the following hour. So the counter movement measured
            // now reconciles the split reported at the PREVIOUS step, not this one. Comparing
            // them same-hour reads 1.44 against 0.00 and looks catastrophic; comparing them one
            // step apart reads 1.44 against 1.40, which is the counter's 0.1 kWh quantisation.
            const dUsed = used !== undefined && this.totalsAtLastStep.used !== undefined
                ? used - this.totalsAtLastStep.used : undefined;
            const dProduced = produced !== undefined && this.totalsAtLastStep.produced !== undefined
                ? produced - this.totalsAtLastStep.produced : undefined;
            const pending = this.pendingSplit;
            if (pending && dUsed !== undefined && dProduced !== undefined) {
                const err = (split: number, counter: number) =>
                    counter === 0 ? (split === 0 ? 'exact' : 'counter still at 0')
                        : `${(((split - counter) / counter) * 100).toFixed(1)}%`;
                this.debug(`Energy log reconciliation — the ${pending.hour} hour: `
                    + `split used ${pending.used.toFixed(2)} vs counter ${dUsed.toFixed(2)} `
                    + `(${err(pending.used, dUsed)}), produced ${pending.produced.toFixed(2)} vs `
                    + `${dProduced.toFixed(2)} (${err(pending.produced, dProduced)}). `
                    + `Compared one step back because the lifetime counters lag the log.`);
            }
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
            // describes the previous hour; that is what `pendingSplit` is holding.
            const main = [...this.subscribers].find((s) => s.role === 'main');
            if (main && pending && dUsed !== undefined)
                main.onEnergyLogHour?.(Math.max(0, dUsed - pending.used), undefined);

            this.reportShadowSource(perRole);
            this.hourAllocation.clear();
            this.shadowHourAllocation.clear();
            this.pendingSplit = {
                hour,
                used: sumOf((label) => label.includes('used') || label.startsWith('add.heat')),
                produced: sumOf((label) => label.includes('produced'))
            };
            this.totalsAtLastStep = {produced, used};
        }
    }

    // ---- Within-hour attribution trace (diagnostic only) ---------------------------------
    // The hourly comparison against the pump's own books gives the SIZE of any attribution
    // error. It cannot give the mechanism, and the candidates need opposite fixes: excess
    // accrued during the compressor cycle points at the allocator charging overheads (pumps,
    // fans, electronics) to whichever function is prioritised, while excess accrued during idle
    // points at standby being charged to a function instead of Main, and excess at transitions
    // points at lag. A single endpoint per hour cannot tell those apart.
    //
    // So trace where the hour's energy accrues — but only while the pump is actually drawing,
    // which is where the question lives and which keeps an idle night near-silent.
    private static readonly TRACE_INTERVAL_MS = 5 * 60 * 1000;
    private static readonly TRACE_MIN_WATTS = 100;
    private hourAllocation = new Map<Role, number>();
    private lastTraceAt = 0;

    private traceAllocation(role: Role, delta: number, watts: number) {
        if (delta > 0)
            this.hourAllocation.set(role, (this.hourAllocation.get(role) ?? 0) + delta);
        const now = Date.now();
        if (watts < PumpConnection.TRACE_MIN_WATTS
            || now - this.lastTraceAt < PumpConnection.TRACE_INTERVAL_MS)
            return;
        this.lastTraceAt = now;
        const split = [...this.hourAllocation.entries()]
            .filter(([, kwh]) => kwh > 0.001)
            .map(([r, kwh]) => `${r} ${kwh.toFixed(3)}`).join(', ') || 'nothing yet';
        this.debug(`Attribution so far this hour: ${split} kWh — drawing ${watts} W right now, `
            + `charged to ${role}.`);
    }

    // ---- Shadow power source (diagnostic) ----
    //
    // Only meaningful on a pump that carries more than one power source, which is exactly the
    // situation that lets us answer a question we otherwise cannot: how much does the *choice*
    // of power register skew the per-function split?
    //
    // 2166 is instantaneous; 2305 is the energy log's averaged reading, and models with no 2166
    // (S320/S325, S330/S332, S2125) run on it. Measured side by side on a live S1155 over one
    // hot-water cycle, 2305's integral came to 0.1293 kWh against 2166's 0.1311 — 1.4% — so a
    // pump's TOTAL is right either way. But averaging lags the compressor ramp (920 W against
    // 2166's 1621 W) and overruns on the way down, and the allocator charges every poll to
    // whichever function the priority register named at that instant. After a switch, an
    // averaged signal is still carrying the *previous* function's power. Total preserved, split
    // skewed — and a single-function run cannot show it, which is why the July comparison
    // (integrals over one uninterrupted cycle) did not answer this.
    //
    // So: run the fallback source through the same trapezoid and the same role, accumulate per
    // hour, and print it beside the real one against the pump's own books. The live meters never
    // see this. Debug-gated at the reporting end; the arithmetic is a few adds per poll.
    private shadowHourAllocation = new Map<Role, number>();
    private lastShadowWatts: number | null = null;

    private trackShadowSource(role: Role | null, rawByName: Map<string, number>,
                              deltaTimeHours: number) {
        // Nothing to shadow unless a fallback exists AND the preferred source is the one
        // actually in use — on a pump that only has 2305, group 1 *is* the real source and
        // shadowing it would just restate the live figure.
        if (this.powerGroups.length < 2 || this.activePowerGroup !== 0)
            return;
        const watts = this.groupWatts(1, rawByName);
        if (watts === null) {
            // Same rule as the real integrator: a gap must not be integrated across.
            this.lastShadowWatts = null;
            return;
        }
        if (this.lastShadowWatts !== null && role) {
            const delta = ((this.lastShadowWatts + watts) / 2) * deltaTimeHours / 1000;
            if (delta > 0)
                this.shadowHourAllocation.set(role, (this.shadowHourAllocation.get(role) ?? 0) + delta);
        }
        this.lastShadowWatts = watts;
    }

    // One line per function at each :00, comparing both power sources against the figure the
    // pump booked itself. `perRole` carries the pump's own hourly split.
    private reportShadowSource(perRole: Map<Role, {used?: number; produced?: number}>) {
        if (this.powerGroups.length < 2 || this.activePowerGroup !== 0
            || this.shadowHourAllocation.size === 0)
            return;
        const label = (group: number) =>
            this.powerGroups[group].map((r) => r.address).join('+');
        const off = (ours: number, pump: number) =>
            pump === 0 ? 'pump booked nothing' : `${(((ours - pump) / pump) * 100).toFixed(1)}%`;
        // Every role either source credited, not just the ones the pump's log names — Main is
        // the one that matters and the log has no line for it. halderex measured 2166 reading
        // 10 W against 2305's 50 W while idle on an S735, because 2166 does not see the
        // continuously-running exhaust-air fan (issue #4). Whether our pump shows the same gap
        // is not answerable without printing standby, and it decides whether that finding is a
        // property of 2166 or of exhaust-air models.
        const roles = new Set<Role>([...perRole.keys(),
            ...this.hourAllocation.keys(), ...this.shadowHourAllocation.keys()]);
        for (const role of roles) {
            const pump = perRole.get(role)?.used;
            const real = this.hourAllocation.get(role) ?? 0;
            const shadow = this.shadowHourAllocation.get(role) ?? 0;
            if (pump === undefined) {
                if (real < 0.001 && shadow < 0.001)
                    continue;
                // No line in the pump's log to score against — which is not the same as the
                // energy being unattributed. An exhaust-air pump books its idle draw under
                // *heating*, so read this against the heating row rather than alone.
                this.debug(`Power-source comparison — ${role} last hour: `
                    + `${label(0)} ${real.toFixed(3)}, ${label(1)} ${shadow.toFixed(3)} kWh. `
                    + `The pump's log has no line for this role — compare with heating before `
                    + `calling it unattributed.`);
                continue;
            }
            if (pump === 0 && real < 0.01 && shadow < 0.01)
                continue;
            this.debug(`Power-source comparison — ${role} last hour: pump ${pump.toFixed(3)}, `
                + `${label(0)} ${real.toFixed(3)} (${off(real, pump)}), `
                + `${label(1)} ${shadow.toFixed(3)} (${off(shadow, pump)}) kWh. `
                + `What the split would look like on a model that has only ${label(1)}.`);
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
            if (raw === undefined)
                continue;
            any = true;
            watts += signedValue(raw, register.size) / (register.scale || 1);
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
        if (watts === null)
            // Tell the energy subscribers their series has a gap here, rather than leaving them
            // to assume the last reading still holds.
            for (const subscriber of this.energySubscribers())
                subscriber.onEnergyUnavailable?.();
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

            // Diagnostic: 3804's own raw value, independent of any correction already folded
            // into rawPriority above — always the true, un-corrected reading (the override
            // never touches this register's own rawByName entry), so it stays honest even
            // while a correction is active.
            const rawEnergyLogPriority = this.energyLogPriorityRegister
                ? rawByName.get(this.energyLogPriorityRegister.name)
                : undefined;

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
            if (this.energyLogPriorityRegister
                && rawEnergyLogPriority !== this.lastLoggedEnergyLogPriority) {
                const from = this.lastLoggedEnergyLogPriority;
                this.lastLoggedEnergyLogPriority = rawEnergyLogPriority;
                this.debug(`3804 change: raw=${rawEnergyLogPriority} (was ${from ?? '?'}) `
                    + `— 1028 currently raw=${rawPriority} role=${role} draw=${watts}W`);
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
            if (activeRole)
                this.traceAllocation(activeRole, delta, watts);
            this.trackShadowSource(activeRole, rawByName, deltaTimeHours);

            if (!target && delta > 0)
                this.debug(`No device for role ${role} (or Main fallback); dropping ${delta.toFixed(5)} kWh`);

            this.trackReconciliation(delta, rawByName);

            this.lastPowerReading = watts;
        }

        this.lastPollTime = now;
    }

    // Diagnostic shadow monitor for the two reconciliation candidates. Runs only on models that
    // expose their own consumption counter (S register 3823) — F derives consumption from power
    // registers and has no counter to reconcile against, so it stays on pure trapezoid and this
    // is a no-op there. Accumulates only; the live meters are untouched.
    private trackReconciliation(integratedDelta: number, rawByName: Map<string, number>) {
        if (!this.consumptionRegister)
            return;
        const raw = rawByName.get(this.consumptionRegister.name);
        if (raw === undefined)
            return;
        const now = Date.now();
        const scale = this.consumptionRegister.scale || 1;

        // First reading only establishes the reference point.
        if (this.lastConsumptionRaw === undefined) {
            this.lastConsumptionRaw = raw;
            this.shadowStarted = now;
            this.lastShadowLog = now;
            return;
        }

        // A: the pump counter's own delta. Negative deltas (counter reset/rollover) are ignored
        // rather than propagated, so a glitch can't corrupt the comparison.
        const pumpDelta = (raw - this.lastConsumptionRaw) / scale;
        this.lastConsumptionRaw = raw;
        if (pumpDelta < 0)
            return;

        // B: integrate, then steer the running error back toward the counter. Clamped at 0 so a
        // meter fed this way could never step backwards (Homey reads that as a meter reset).
        const corrected = Math.max(0, integratedDelta - PumpConnection.SHADOW_B_GAIN * this.shadowErrorB);
        this.shadowErrorB += corrected - pumpDelta;

        this.shadowTrapezoid += integratedDelta;
        this.shadowCounterA += pumpDelta;
        this.shadowB += corrected;

        if (now - this.lastShadowLog < PumpConnection.SHADOW_LOG_MS)
            return;
        this.lastShadowLog = now;
        const hours = (now - this.shadowStarted) / 3600000;
        const pump = this.shadowCounterA; // A is exact by construction
        const pct = (v: number) => pump > 0 ? `${(((v - pump) / pump) * 100).toFixed(1)}%` : 'n/a';
        this.debug(`Energy reconciliation after ${hours.toFixed(1)} h — `
            + `pump(3823)=${pump.toFixed(3)} kWh | `
            + `trapezoid=${this.shadowTrapezoid.toFixed(3)} (${pct(this.shadowTrapezoid)}) | `
            + `B feed-forward=${this.shadowB.toFixed(3)} (${pct(this.shadowB)}) | `
            + `B residual error=${this.shadowErrorB.toFixed(4)} kWh`);
    }

    // Re-run feature detection over the live connection (used by repair and by pairing when a
    // device for this pump already holds the single allowed connection).
    async probe(onProgress: (pass: number, passes: number) => void): Promise<DetectionResult> {
        if (!this.connected)
            throw new Error('Not connected to the heat pump');
        const {probes, addresses} = await sampleRegisters(this.profile,
            (register) => readNumeric(this.client, register, this.profile), onProgress);
        return buildDetectionResult(this.profile, probes, addresses);
    }

    isConnected(): boolean {
        return this.connected;
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
