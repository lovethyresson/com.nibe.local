import net from 'net';
import {ModbusTCPClient} from 'jsmodbus';
import {Dir, Register, combineRaw, isPollable, isUnavailableRaw, signedValue} from './registers';
import {Role, functionRoles} from './roles';
import type {LocalizedText, ModelProfile} from './profile';
import {DetectionResult, buildDetectionResult, readNumeric, sampleRegisters} from './detection';

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
    // Whether this device wants verbose logging (its "Debug logging" setting). The connection
    // is shared, so it logs verbosely when *any* attached device asks for it.
    debugEnabled?(): boolean;
    // The pump switched what it is producing. `from`/`to` are raw priority codes (`from` is
    // undefined for the first reading after connect); `reason` is the model's explanation of
    // why, or undefined when it can't tell. Only the main device acts on this.
    onPriorityChange?(from: number | undefined, to: number | undefined,
                      role: Role, reason: LocalizedText | undefined): void;
}

const connections = new Map<string, PumpConnection>();

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
        this.powerRegisters = this.powerGroups.flat();
        this.priorityRegister = profile.role.priorityRegisterName
            ? profile.registerByName[profile.role.priorityRegisterName]
            : undefined;
        this.consumptionRegister = profile.role.totalConsumptionRegister
            ? profile.registerByName[profile.role.totalConsumptionRegister]
            : undefined;
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
        // The reconciliation monitor needs the pump's consumption counter every poll, even when
        // no device selected that capability.
        if (this.consumptionRegister)
            byName.set(this.consumptionRegister.name, this.consumptionRegister);
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
        return reason.explain({from, to, role, previousRole, v: (id) => values.get(id)});
    }

    private pduAddress(register: Register): number {
        return this.profile.addressBase ? register.address - this.profile.addressBase : register.address;
    }

    async readRegisterRaw(register: Register): Promise<number | undefined> {
        const count = register.size === 32 ? 2 : 1;
        const address = this.pduAddress(register);
        return await ((register.direction === Dir.In)
            ? this.client.readInputRegisters(address, count)
            : this.client.readHoldingRegisters(address, count))
            .then((resp: any) => {
                const raw = combineRaw(resp.response.body.values as number[], register.size);
                // A pump can answer without returning a usable value — a short or empty value
                // array yields undefined (16-bit) or NaN (32-bit, missing high word). That is
                // a failed read, not a reading of zero, and must not be scored as a success.
                if (raw === undefined || Number.isNaN(raw)) {
                    this.noteRead(register, false);
                    return undefined;
                }
                this.noteRead(register, true);
                return raw;
            })
            .catch(() => {
                this.noteRead(register, false);
                return undefined;
            });
    }

    // Throws on failure (rather than swallowing) so the write error reaches the user who
    // triggered it. `address` is the register's logical address; the model offset is applied
    // here at the wire boundary.
    async writeSingleRegister(address: number, raw: number): Promise<void> {
        const pdu = this.profile.addressBase ? address - this.profile.addressBase : address;
        try {
            await this.client.writeSingleRegister(pdu, raw);
        } catch (reason: any) {
            this.log('Error writing register', address, reason?.message ?? reason);
            throw reason;
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

            this.reportReadFailures(rawByName.size > 0);
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
            this.log('Poll failed', error?.message ?? error);
            this.socket.end(); // triggers 'close' → reconnect
        }).finally(() => {
            this.polling = false;
        });
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
            let watts = 0;
            let any = false;
            for (const register of this.powerGroups[group]) {
                const raw = rawByName.get(register.name);
                if (raw === undefined)
                    continue;
                any = true;
                watts += signedValue(raw, register.size) / (register.scale || 1);
            }
            if (!any)
                continue;
            this.notePowerGroup(group);
            return watts;
        }
        return null;
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

    // Integrate total power into a per-function kWh bucket, charged to whichever function the
    // pump is currently prioritising, and push the live draw (watts) to the active device and 0
    // to the others. Skipped entirely on models with no power source (fixed-speed F).
    private allocateEnergy(rawByName: Map<string, number>) {
        const now = Date.now();
        const deltaTimeHours = (now - this.lastPollTime) / (1000 * 60 * 60);

        const watts = this.totalWatts(rawByName);
        this.notePowerAvailability(watts !== null);
        if (watts !== null) {
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

            // Diagnostic: dump every priority change with the code, where it's charged,
            // and the live draw — so a "heating while priority reads X" cycle reveals X.
            if (rawPriority !== this.lastLoggedPriority) {
                const mapped = rawPriority !== undefined ? this.profile.role.priorityToRole[rawPriority] : undefined;
                const from = this.lastLoggedPriority;
                this.lastLoggedPriority = rawPriority;
                this.announcePriorityChange(from, rawPriority, role,
                    `Priority change: raw=${rawPriority} -> role=${role}`
                    + `${mapped ? '' : ' (UNMAPPED)'} draw=${watts}W`);
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

            for (const subscriber of this.energySubscribers()) {
                if (activeRole && subscriber.role === activeRole)
                    subscriber.onEnergy?.(delta, watts);
                else
                    subscriber.onEnergy?.(0, 0);
            }

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
        const probes = await sampleRegisters(this.profile,
            (register) => readNumeric(this.client, register, this.profile), onProgress);
        return buildDetectionResult(this.profile, probes);
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
