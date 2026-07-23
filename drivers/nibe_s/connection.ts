import net from 'net';
import {ModbusTCPClient} from 'jsmodbus';
import {Dir, Register, combineRaw, isPollable, registerByName} from './registers';
import {Role, functionRoles, priorityToRole} from './roles';
import {DetectionResult, buildDetectionResult, readNumeric, sampleRegisters} from './detection';

// A Nibe pump accepts only a single Modbus TCP client, but the app now
// pairs several logical devices (main + heating/hot water/pool/cooling) that all
// talk to the same pump. PumpConnection is the one shared connection per pump IP:
// devices attach/detach, it owns the single socket, one 5 s poll loop over the
// union of everyone's registers, energy integration/allocation by operating
// priority, and availability fan-out. It is refcounted — the first attach opens
// the socket, the last detach tears it down — and independent of device init
// order (Homey guarantees none).

// Poll interval bounds, in seconds. The floor is set by the pump, the ceiling by the
// energy split. Reads are one Modbus request per register (not batched) fired as one
// burst, and Nibe M12676EN allows 100 registers/second: a fully populated pump polls
// ~77 registers, so 5 s is ~15/s — roughly 6x under the limit and enough time for the
// burst to land. Above 60 s the per-function energy split degrades, because
// allocateEnergy() charges a whole interval to whichever function was prioritised at
// the sampling instant, so any priority change in between is misattributed.
export const POLL_SECONDS_MIN = 5;
export const POLL_SECONDS_MAX = 60;
export const POLL_SECONDS_DEFAULT = 10;

export function clampPollSeconds(seconds: any): number {
    const n = Number(seconds);
    if (!Number.isFinite(n))
        return POLL_SECONDS_DEFAULT;
    return Math.min(POLL_SECONDS_MAX, Math.max(POLL_SECONDS_MIN, Math.round(n)));
}

// A device subscribing to a pump connection. Homey's Device already provides log/error.
export interface PumpSubscriber {
    role: Role;
    wantedRegisters(): Register[];
    onRegisterRaw(register: Register, raw: number): void;
    onConnectionUp(): void;
    onConnectionDown(): void;
    // Poll interval this device asks for, in seconds. The main device's value wins (see
    // desiredPollSeconds); the rest only matter when no main device is paired.
    pollSeconds(): number;
    // Only the function devices implement this — see PumpConnection.allocateEnergy().
    onEnergy?(deltaKwh: number, watts: number): void;
}

// The two registers the energy allocator always needs, regardless of which devices
// are attached: total instantaneous power (integrated into kWh) and operating
// priority (which decides the bucket).
const POWER_REGISTER = registerByName["measure_watt_NIBE.i2166_energy_usage"];
const PRIORITY_REGISTER = registerByName["measure_enum_NIBE.i1028_priority"];

function signed(raw: number): number {
    return raw >= 32768 ? raw - 65536 : raw;
}

const connections = new Map<string, PumpConnection>();

export class PumpConnection {
    private socket: net.Socket;
    private client: ModbusTCPClient;
    private subscribers = new Set<PumpSubscriber>();
    private pollInterval: NodeJS.Timeout | null = null;
    private pollSeconds = POLL_SECONDS_DEFAULT;
    // Guards against overlapping polls: a cycle is a burst of one Modbus request per
    // register, and at a short interval (or on a slow pump) the next tick can arrive
    // before the previous burst has landed. Without this the bursts would stack.
    private polling = false;
    private retryTimer: NodeJS.Timeout | null = null;
    private connected = false;
    private destroyed = false;

    // Energy integrator state (moved out of the old single device). lastPowerReading
    // is null right after every (re)connect so a connection gap isn't counted as
    // continuous runtime at whatever power the first poll happens to read.
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

    // Last successfully read raw value per register, so a device that attaches after
    // the connection is already up gets current values without waiting for a poll.
    private lastRaw = new Map<string, number>();

    private constructor(private host: string) {
        this.socket = new net.Socket();
        this.client = new ModbusTCPClient(this.socket, 1, 5000);
        this.socket.on('connect', () => this.onConnect());
        this.socket.on('error', (error) => this.onSocketError(error));
        this.socket.on('close', () => this.onClose());
        this.log('Connecting');
        this.socket.connect({port: 502, host});
    }

    static get(host: string): PumpConnection {
        let connection = connections.get(host);
        if (!connection) {
            connection = new PumpConnection(host);
            connections.set(host, connection);
        }
        return connection;
    }

    private log(...args: any[]) {
        console.log(`[PumpConnection ${this.host}]`, ...args);
    }

    attach(subscriber: PumpSubscriber) {
        this.subscribers.add(subscriber);
        // Attaching can change who owns the interval (a main device taking over) or the
        // lowest requested value, so re-evaluate before replaying cached values.
        this.refreshPollInterval();
        if (this.connected) {
            subscriber.onConnectionUp();
            // Replay cached values so a late attach reflects state immediately.
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
        if (this.subscribers.size === 0)
            this.destroy();
        else
            this.refreshPollInterval(); // the main device may have just left
    }

    private destroy() {
        this.log('Last device detached, closing connection');
        this.destroyed = true;
        if (this.pollInterval) clearInterval(this.pollInterval);
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.socket.removeAllListeners();
        this.socket.end();
        this.socket.destroy();
        connections.delete(this.host);
    }

    // The interval to run at: the main device owns the setting and the function devices
    // inherit it, so the pump is polled once at one rate no matter how many devices are
    // paired. Falls back to the lowest requested value when no main device is paired
    // (adding one later takes over), and to the default when nothing is attached.
    private desiredPollSeconds(): number {
        const main = [...this.subscribers].find((subscriber) => subscriber.role === 'main');
        if (main)
            return clampPollSeconds(main.pollSeconds());
        const asked = [...this.subscribers].map((subscriber) => clampPollSeconds(subscriber.pollSeconds()));
        return asked.length ? Math.min(...asked) : POLL_SECONDS_DEFAULT;
    }

    // Restart the timer if the wanted interval changed. Called when devices attach or
    // detach (which can change who owns the setting) and from the settings handler.
    refreshPollInterval() {
        const wanted = this.desiredPollSeconds();
        if (wanted === this.pollSeconds && this.pollInterval)
            return;
        this.pollSeconds = wanted;
        if (!this.connected)
            return;
        if (this.pollInterval)
            clearInterval(this.pollInterval);
        this.log(`Polling every ${wanted} s`);
        this.pollInterval = setInterval(() => this.poll(), wanted * 1000);
    }

    private onConnect() {
        this.log('Connected');
        this.connected = true;
        this.lastPowerReading = null;
        this.lastPollTime = Date.now();
        this.polling = false;
        this.subscribers.forEach((subscriber) => subscriber.onConnectionUp());
        setTimeout(() => this.poll(), 200);
        this.pollSeconds = this.desiredPollSeconds();
        this.log(`Polling every ${this.pollSeconds} s`);
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
        this.log('Socket closed, reconnecting in 5 seconds ...');
        this.retryTimer = setTimeout(() => {
            if (!this.destroyed)
                this.socket.connect({port: 502, host: this.host});
        }, 5000);
    }

    // The registers to read this cycle: everyone's wanted registers, deduped by name,
    // plus power+priority which the allocator needs even when no main device is paired.
    // Command registers are skipped — there's nothing to read back. The pump allows
    // 100 registers/second and 20 per query (Nibe M12676EN); at ~56 registers per 5 s
    // poll that's ~11/s, so keep an eye on both limits if this list grows or batches.
    private unionRegisters(): Register[] {
        const byName = new Map<string, Register>();
        for (const subscriber of this.subscribers)
            for (const register of subscriber.wantedRegisters().filter(isPollable))
                byName.set(register.name, register);
        byName.set(POWER_REGISTER.name, POWER_REGISTER);
        byName.set(PRIORITY_REGISTER.name, PRIORITY_REGISTER);
        return [...byName.values()];
    }

    // Last polled raw value for a register, by capability name. Used by Main's derived
    // on/off to re-assert the true state if the capability is written to.
    lastRawFor(name: string): number | undefined {
        return this.lastRaw.get(name);
    }

    async readRegisterRaw(register: Register): Promise<number | undefined> {
        const count = register.size === 32 ? 2 : 1;
        return await ((register.direction === Dir.In)
            ? this.client.readInputRegisters(register.address, count)
            : this.client.readHoldingRegisters(register.address, count))
            .then((resp: any) => combineRaw(resp.response.body.values as number[], register.size))
            .catch(() => undefined);
    }

    // Throws on failure (rather than swallowing) so the write error reaches the user who
    // triggered it, instead of only appearing in the log.
    async writeSingleRegister(address: number, raw: number): Promise<void> {
        try {
            await this.client.writeSingleRegister(address, raw);
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

            this.allocateEnergy(rawByName);

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

    // Devices that receive an energy allocation each poll: the heat-producing functions
    // (their active draw) plus 'main' (the standby/idle draw, allocated when priority is
    // Off). Excludes 'solar' — a producer whose measure_power is its own generation, which
    // charging the pump's draw would clobber.
    private energySubscribers(): PumpSubscriber[] {
        return [...this.subscribers].filter((subscriber) =>
            functionRoles.includes(subscriber.role) || subscriber.role === 'main');
    }

    private deviceForRole(role: Role): PumpSubscriber | undefined {
        return [...this.subscribers].find((subscriber) => subscriber.role === role);
    }

    private logUnknownPriority(raw: number) {
        if (this.loggedUnknownPriority.has(raw))
            return;
        this.loggedUnknownPriority.add(raw);
        this.log(`Unknown priority value ${raw}, charging its energy to Main (standby)`);
    }

    // The pump is producing <role> but no device of that role is attached, so its draw is
    // being charged to Main (idle) — misattribution that otherwise leaves no trace. Logged
    // at most once per 5 min per role so a persistent case keeps reminding without spamming.
    private warnMissingRoleDevice(role: Role, watts: number) {
        const now = Date.now();
        if (now - (this.lastMissingRoleWarn.get(role) ?? 0) < 5 * 60 * 1000)
            return;
        this.lastMissingRoleWarn.set(role, now);
        this.log(`No '${role}' device attached; charging its ${watts}W draw to Main (idle) `
            + `instead — energy misattributed. Is the ${role} device paired and available?`);
    }

    // Integrate total power into a per-function kWh bucket, charged to whichever
    // function the pump is currently prioritising, and push the live draw (watts) to
    // the active device and 0 to the others.
    private allocateEnergy(rawByName: Map<string, number>) {
        const now = Date.now();
        const deltaTimeHours = (now - this.lastPollTime) / (1000 * 60 * 60);

        const rawPower = rawByName.get(POWER_REGISTER.name);
        if (rawPower !== undefined) {
            const watts = signed(rawPower);
            const rawPriority = rawByName.get(PRIORITY_REGISTER.name);

            // Default (and unknown-priority fallback) is 'main' = standby: an idle or
            // unattributable draw is charged to Main, not to a function whose COP it would
            // distort.
            let role: Role = 'main';
            if (rawPriority !== undefined) {
                const mapped = priorityToRole[rawPriority];
                if (mapped) role = mapped;
                else this.logUnknownPriority(rawPriority);
            }

            // Diagnostic: dump every priority change with the code, where it's charged,
            // and the live draw — so a "heating while priority reads X" cycle reveals X.
            if (rawPriority !== this.lastLoggedPriority) {
                const mapped = rawPriority !== undefined ? priorityToRole[rawPriority] : undefined;
                this.log(`Priority change: raw=${rawPriority} -> role=${role}`
                    + `${mapped ? '' : ' (UNMAPPED)'} draw=${watts}W`);
                this.lastLoggedPriority = rawPriority;
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
                this.log(`No device for role ${role} (or Main fallback); dropping ${delta.toFixed(5)} kWh`);

            this.lastPowerReading = watts;
        }

        this.lastPollTime = now;
    }

    // Re-run feature detection over the live connection (used by repair and by pairing
    // when a device for this pump already holds the single allowed connection).
    async probe(onProgress: (pass: number, passes: number) => void): Promise<DetectionResult> {
        if (!this.connected)
            throw new Error('Not connected to the heat pump');
        const probes = await sampleRegisters((register) => readNumeric(this.client, register), onProgress);
        return buildDetectionResult(probes);
    }

    isConnected(): boolean {
        return this.connected;
    }

    // Force teardown regardless of refcount (used on app/driver shutdown).
    shutdown() {
        this.destroy();
    }
}

// Close every open pump connection — called on driver unload so the pump's single
// Modbus slot is released promptly instead of lingering until it times out.
export function destroyAllConnections() {
    for (const connection of [...connections.values()])
        connection.shutdown();
}

// Look up an existing connection without creating one — used by pairing to decide
// whether it must probe over a live device connection instead of opening its own.
export function existingConnection(host: string): PumpConnection | undefined {
    return connections.get(host);
}
