import {Device} from 'homey';
import {Dir, Register, Selection, isUnavailableRaw, signedValue} from './registers';
import {
    ACTIVE_POWER_CAPABILITY, FUNCTION_COP_CAPABILITY, METER_CAPABILITY,
    PUMP_ACTIVE_CAPABILITY, Role, SOLAR_METER_CAPABILITY, TOTAL_COP_CAPABILITY,
    energyTitle, extraCapabilities, functionRoles, powerTitle,
    pumpActiveTitle, registersForRole, roleClass, roleOf, roleRegisters
} from './roles';
import type {ModelProfile} from './profile';
import {PumpConnection, PumpSubscriber, POLL_SECONDS_DEFAULT, Transport, clampPollSeconds} from './connection';

// One logical function of the physical pump (see roles.ts). All devices share a single
// PumpConnection per pump host; this class is the Homey-facing subscriber: it maps its role's
// registers to capabilities, and — for function roles — keeps the energy bucket the
// connection's allocator feeds it. Model-specific data comes from the concrete subclass's
// `profile` (S or F).
export abstract class NibePumpDevice extends Device implements PumpSubscriber {
    abstract profile: ModelProfile;

    role: Role = 'main';
    private connection: PumpConnection | null = null;

    // Energy bucket (function roles only). Charged by the connection's allocator.
    private cumulativeEnergy = 0;

    // Last derived on/off for the main device, so the transition is logged once.
    private lastPumpActive: boolean | null = null;

    private host(): string {
        return this.getSettings().address;
    }

    // Transport for this device: the model defaults, optionally overridden by per-device
    // port/unit-id settings (F gateways). S has no such settings → falls back to 502/1.
    private transport(): Transport {
        const settings = this.getSettings();
        return {
            port: settings.port || this.profile.transport.port,
            unitId: settings.unitId || this.profile.transport.unitId
        };
    }

    private options(name: string): any {
        return (this.profile.compose.capabilitiesOptions as any)[name];
    }

    private getSelection(): Selection | null {
        return (this.getStoreValue('selection') ?? null) as Selection | null;
    }

    private enabledGroupsSummary(): string {
        const selection = this.getSelection();
        if (!selection)
            return 'all (no selection stored)';
        const on = Object.entries(selection.groups).filter(([, v]) => v).map(([g]) => g);
        const overrides = Object.entries(selection.overrides ?? {});
        return (on.join(',') || 'none')
            + (overrides.length ? ` | overrides: ${overrides.map(([k, v]) => `${k}=${v}`).join(',')}` : '');
    }

    private fromRegisterValue(register: Register, raw: number) {
        // 0x8000 / 0x80000000 is Nibe's "value not available" sentinel. Show as no value.
        if (isUnavailableRaw(raw, register.size))
            return null;
        let value = signedValue(raw, register.size);
        if (register.scale)
            return value / register.scale;
        if (register.enum)
            return this.homey.__(register.enum[value]) || register.enum[value];
        if (register.picker)
            return "" + value;
        if (register.bool)
            return value !== (register.offValue ?? 0);
        return value;
    }

    private toRegisterValue(register: Register, value: any) {
        if (register.picker)
            value = parseInt(value);
        if (register.enum)
            value = parseInt(Object.entries(register.enum).filter(pair => pair[1] == value)[0][0]);
        else if (register.bool)
            value = value ? (register.onValue ?? 1) : (register.offValue ?? 0);
        else if (register.scale)
            value = Math.round(value * register.scale);
        // Two's complement last, mirroring fromRegisterValue() which undoes it first.
        if (value < 0)
            value += 65536;
        return value;
    }

    async readRegister(register: Register): Promise<any> {
        if (!this.connection)
            return undefined;
        const raw = await this.connection.readRegisterRaw(register);
        return raw === undefined ? undefined : this.fromRegisterValue(register, raw);
    }

    async writeRegister(register: Register, value: any): Promise<void> {
        if (!this.connection)
            throw new Error('Not connected to the heat pump');
        try {
            await this.connection.writeSingleRegister(register.address, this.toRegisterValue(register, value));
        } catch (error: any) {
            // Surface a clear, user-facing message instead of failing silently.
            throw new Error(`Could not set "${this.registerTitle(register)}": ${error?.message ?? error}`);
        }
    }

    private capabilityChangedTrigger = this.homey.flow.getDeviceTriggerCard("capability_changed");
    private turnedOnTrigger = this.homey.flow.getDeviceTriggerCard("capability_turned_on");
    private turnedOffTrigger = this.homey.flow.getDeviceTriggerCard("capability_turned_off");

    private registerTitle(register: Register): string {
        const option: any = this.options(register.name);
        const language = this.homey.i18n.getLanguage();
        return option?.title?.[language] || option?.title?.en || register.name;
    }

    private checkTrigger(register: Register, value: any) {
        if (register.writeOnly)
            return;
        const name = this.registerTitle(register);
        const state = {register: {id: register.name}, value: value};
        if (register.bool && value) {
            this.turnedOnTrigger.trigger(this, {register: name}, state);
        } else if (register.bool && !value) {
            this.turnedOffTrigger.trigger(this, {register: name}, state);
        } else if (register.enum) {
            this.capabilityChangedTrigger.trigger(this, {value: `${value}`, register: name}, state);
        }
    }

    async setValue(register: Register, value: any) {
        if (register.writeOnly || !this.hasCapability(register.name))
            return;
        const oldValue = this.getCapabilityValue(register.name);
        await this.setCapabilityValue(register.name, value);
        if (oldValue !== value)
            this.checkTrigger(register, value);
    }

    private async ensureCapabilityOptions(name: string, option: any) {
        if (!option || !this.hasCapability(name))
            return;
        let current: any;
        try {
            current = this.getCapabilityOptions(name) ?? {};
        } catch (error) {
            this.log(`Skipping options for ${name} — ${(error as Error).message}; `
                + `a new capability type needs a clean app reinstall to register`);
            return;
        }
        const differs = Object.keys(option).some(
            (key) => JSON.stringify(current[key]) !== JSON.stringify(option[key]));
        if (!differs)
            return;
        await this.setCapabilityOptions(name, option)
            .catch((error) => this.log(`Could not set options for ${name} — ${error?.message ?? error}`));
    }

    // Per-instance options for the non-register energy/COP capabilities (same capability id,
    // role-specific title — which the shared compose file can't express).
    private extraOptions(name: string): any {
        if (name === METER_CAPABILITY)
            return {title: energyTitle(this.role)};
        if (name === ACTIVE_POWER_CAPABILITY)
            return {title: powerTitle(this.role), decimals: 0};
        if (name === PUMP_ACTIVE_CAPABILITY && this.role === 'main')
            return {title: pumpActiveTitle(), uiComponent: null, setable: true};
        if (name === TOTAL_COP_CAPABILITY)
            return {title: {en: "Total COP (30-day)", sv: "Total COP (30 dagar)"}, decimals: 2};
        if (name === FUNCTION_COP_CAPABILITY) {
            const titles: Partial<Record<Role, {en: string; sv: string}>> = {
                heating: {en: "Heating COP (30-day)", sv: "Värme COP (30 dagar)"},
                hotwater: {en: "Hot water COP (30-day)", sv: "Varmvatten COP (30 dagar)"},
                pool: {en: "Pool COP (30-day)", sv: "Pool COP (30 dagar)"},
                cooling: {en: "Cooling COP (30-day)", sv: "Kyla COP (30 dagar)"}
            };
            return {title: titles[this.role] ?? {en: "COP (30-day)", sv: "COP (30 dagar)"}, decimals: 2};
        }
        return undefined;
    }

    // ---- Rolling 30-day COP -------------------------------------------------------------
    private static readonly COP_WINDOW_MS = 30 * 24 * 3600 * 1000;
    private static readonly COP_SNAPSHOT_MS = 6 * 3600 * 1000;
    private copProduced: number | null = null;
    private copUsed: number | null = null;

    private copCapability(): string | null {
        if (this.role === 'main')
            return TOTAL_COP_CAPABILITY;
        return functionRoles.includes(this.role) ? FUNCTION_COP_CAPABILITY : null;
    }

    private updateRollingCop() {
        const capability = this.copCapability();
        if (!capability || !this.hasCapability(capability))
            return;
        if (this.copProduced === null || this.copUsed === null)
            return;
        const now = Date.now();
        const samples: {t: number; p: number; u: number}[] = this.getStoreValue('copSamples') ?? [];
        const last = samples[samples.length - 1];
        let changed = false;
        if (!last || now - last.t >= NibePumpDevice.COP_SNAPSHOT_MS) {
            samples.push({t: now, p: this.copProduced, u: this.copUsed});
            changed = true;
        }
        while (samples.length > 2 && now - samples[1].t > NibePumpDevice.COP_WINDOW_MS) {
            samples.shift();
            changed = true;
        }
        if (changed)
            this.setStoreValue('copSamples', samples).catch(this.error);
        const reference = samples.find((s) => now - s.t <= NibePumpDevice.COP_WINDOW_MS) ?? samples[0];
        const producedDelta = this.copProduced - reference.p;
        const usedDelta = this.copUsed - reference.u;
        if (usedDelta > 0.1) {
            const cop = Math.round((producedDelta / usedDelta) * 100) / 100;
            this.setCapabilityValue(capability, cop).catch(this.error);
        }
    }

    private applyBaseline(register: Register, value: number): number {
        const key = `baseline.${register.name}`;
        let baseline = this.getStoreValue(key);
        if (typeof baseline !== 'number') {
            baseline = value;
            this.setStoreValue(key, baseline).catch(this.error);
        }
        return value - baseline;
    }

    private async syncCapabilities() {
        const selection = this.getSelection();
        const roleRegs = registersForRole(this.profile, this.role, selection);
        const extras = extraCapabilities(this.profile, this.role, selection);

        const wanted = new Set<string>([...roleRegs.map((r) => r.name), ...extras]);
        for (const name of this.getCapabilities()) {
            if (!wanted.has(name)) {
                this.log(`Removing capability ${name}`);
                await this.removeCapability(name).catch(this.error);
            }
        }

        for (const register of roleRegs) {
            if (!this.hasCapability(register.name))
                await this.addCapability(register.name).catch(this.error);
            await this.ensureCapabilityOptions(register.name, this.options(register.name)).catch(this.error);
        }
        for (const extra of extras) {
            if (!this.hasCapability(extra))
                await this.addCapability(extra).catch(this.error);
            await this.ensureCapabilityOptions(extra, this.extraOptions(extra)).catch(this.error);
        }
    }

    async applySelection(selection: Selection) {
        this.log("Applying selection", JSON.stringify(selection));
        await this.setStoreValue('selection', selection);
        await this.syncCapabilities();
        if (this.hasCapability(METER_CAPABILITY))
            await this.setCapabilityValue(METER_CAPABILITY, this.cumulativeEnergy).catch(this.error);
    }

    async probeForDetection(onProgress: (pass: number, passes: number) => void) {
        if (!this.connection || !this.getAvailable())
            throw new Error(this.homey.__("pair.not_connected"));
        return this.connection.probe(onProgress);
    }

    async onInit() {
        this.role = roleOf(this.getData());
        this.log(`Device init: role ${this.role}, host ${this.host()}, groups [${this.enabledGroupsSummary()}]`);

        if (this.getClass() !== roleClass[this.role])
            await this.setClass(roleClass[this.role]).catch(this.error);

        if (this.role === 'solar')
            await this.setEnergy({meterPowerExportedCapability: SOLAR_METER_CAPABILITY}).catch(this.error);

        if (functionRoles.includes(this.role) || this.role === 'main')
            this.cumulativeEnergy = this.getSettings().cumulativeEnergy || 0;
        if (functionRoles.includes(this.role))
            this.copUsed = this.cumulativeEnergy;

        // Capability setup can fail on an individual device (a capability RPC error, a
        // stale capability type, etc.). Catch it so onInit still reaches attach() below:
        // a throw here used to leave the device unsubscribed from the pump connection, and
        // the allocator then silently charged its draw to Main/idle instead of its own
        // meter — the root cause of the inflated "idle energy".
        try {
            await this.syncCapabilities();
            this.log(`Device capabilities synced: ${this.getCapabilities().length} — `
                + this.getCapabilities().join(', '));

            if (this.hasCapability(METER_CAPABILITY))
                await this.setCapabilityValue(METER_CAPABILITY, this.cumulativeEnergy).catch(this.error);

            for (const register of roleRegisters(this.profile, this.role)) {
                if (register.direction === Dir.Out && !register.noAction) {
                    this.registerCapabilityListener(register.name, async (value) => {
                        this.log(`Manual set ${register.name} = ${value}`);
                        await this.writeRegister(register, value);
                        this.checkTrigger(register, value);
                    });
                }
            }

            // Main's on/off is derived state, not a command. Register a listener anyway so a
            // stray tap snaps back to whatever the operating priority currently says.
            if (this.role === 'main' && this.profile.role.priorityRegisterName) {
                const priorityName = this.profile.role.priorityRegisterName;
                const rawOff = this.profile.role.priorityRawOff;
                this.registerCapabilityListener(PUMP_ACTIVE_CAPABILITY, async () => {
                    const raw = this.connection?.lastRawFor(priorityName);
                    const actual = raw === undefined ? false : raw !== rawOff;
                    setTimeout(() => this.setCapabilityValue(PUMP_ACTIVE_CAPABILITY, actual)
                        .catch(this.error), 300);
                    throw new Error(this.homey.__('pair.not_settable'));
                });
            }
        } catch (err) {
            this.error('Capability setup failed in onInit; attaching to the pump anyway so '
                + 'this device still receives its energy allocation', err);
        }

        this.connection = PumpConnection.get(this.host(), this.profile, this.transport());
        this.connection.attach(this);
    }

    // ---- PumpSubscriber ----

    pollSeconds(): number {
        const stored = this.getSettings().pollInterval;
        const seconds = typeof stored === 'number' && stored > 0 ? stored : POLL_SECONDS_DEFAULT;
        return clampPollSeconds(seconds);
    }

    wantedRegisters(): Register[] {
        return registersForRole(this.profile, this.role, this.getSelection());
    }

    onRegisterRaw(register: Register, raw: number) {
        const rawValue = this.fromRegisterValue(register, raw);
        const value = register.relative && typeof rawValue === 'number'
            ? this.applyBaseline(register, rawValue)
            : rawValue;
        this.setValue(register, value).catch(this.error);

        const rawScaled = typeof rawValue === 'number' ? rawValue : null;
        const {totalProductionRegister, totalConsumptionRegister, producedRegisterForRole,
               priorityRegisterName, priorityRawOff} = this.profile.role;
        if (this.role === 'main') {
            if (register.name === totalProductionRegister) {
                this.copProduced = rawScaled;
                this.updateRollingCop();
            } else if (register.name === totalConsumptionRegister) {
                this.copUsed = rawScaled;
                this.updateRollingCop();
            }
        } else if (register.name === producedRegisterForRole[this.role]) {
            this.copProduced = rawScaled;
            this.updateRollingCop();
        }
        // Main's on/off follows the pump's operating priority: idle is off, producing is on.
        if (this.role === 'main' && register.name === priorityRegisterName
            && this.hasCapability(PUMP_ACTIVE_CAPABILITY)) {
            const active = raw !== priorityRawOff;
            if (active !== this.lastPumpActive) {
                this.lastPumpActive = active;
                this.log(`Priority ${raw} -> ${active ? 'active' : 'idle'}`);
            }
            this.setCapabilityValue(PUMP_ACTIVE_CAPABILITY, active)
                .catch((error) => this.error(`Could not set ${PUMP_ACTIVE_CAPABILITY}`, error));
        }
    }

    onConnectionUp() {
        this.setAvailable().catch(this.error);
        if (this.role === 'main')
            this.updatePumpInfo().catch(this.error);
    }

    // Read the pump's identity once per connect and surface it to the read-only "Heat pump"
    // settings labels + the log. Addresses come from the profile; skipped if the model doesn't
    // declare them.
    private async updatePumpInfo() {
        if (!this.connection || !this.profile.pumpInfo)
            return;
        const {typeAddress, firmwareAddress} = this.profile.pumpInfo;
        const type = typeAddress === undefined ? undefined
            : await this.connection.readRegisterRaw({address: typeAddress, direction: Dir.In} as Register);
        const firmware = firmwareAddress === undefined ? undefined
            : await this.connection.readRegisterRaw({address: firmwareAddress, direction: Dir.In} as Register);
        this.log(`Pump info: heat-pump type ${type ?? '?'}, firmware ${firmware ?? '?'}`);
        const info: {firmware?: string; heatpump_type?: string} = {};
        if (typeof firmware === 'number')
            info.firmware = String(firmware);
        if (typeof type === 'number')
            info.heatpump_type = String(type);
        if (!Object.keys(info).length)
            return;
        for (const device of this.driver.getDevices() as any[])
            if (device.getSettings?.().address === this.host())
                await device.setSettings(info).catch(this.error);
    }

    onConnectionDown() {
        this.setUnavailable().catch(this.error);
    }

    onEnergy(deltaKwh: number, watts: number) {
        if (deltaKwh) {
            this.cumulativeEnergy += deltaKwh;
            if (this.hasCapability(METER_CAPABILITY))
                this.setCapabilityValue(METER_CAPABILITY, this.cumulativeEnergy).catch(this.error);
            this.setSettings({cumulativeEnergy: this.cumulativeEnergy}).catch(this.error);
        }
        if (functionRoles.includes(this.role)) {
            this.copUsed = this.cumulativeEnergy;
            this.updateRollingCop();
        }
        if (this.hasCapability(ACTIVE_POWER_CAPABILITY))
            this.setCapabilityValue(ACTIVE_POWER_CAPABILITY, watts).catch(this.error);
    }

    // ---- lifecycle ----

    async onSettings({newSettings, changedKeys}: {
        oldSettings: {[key: string]: any}, newSettings: {[key: string]: any}, changedKeys: string[]
    }) {
        if (changedKeys.includes('cumulativeEnergy')) {
            this.cumulativeEnergy = newSettings.cumulativeEnergy || 0;
            if (this.hasCapability(METER_CAPABILITY))
                this.setCapabilityValue(METER_CAPABILITY, this.cumulativeEnergy).catch(this.error);
        }
        if (changedKeys.includes('pollInterval')) {
            const seconds = clampPollSeconds(newSettings.pollInterval);
            this.log(`Poll interval set to ${seconds} s`);
            this.syncPollIntervalToSiblings(seconds).catch(this.error);
            this.connection?.refreshPollInterval();
        }
        if (changedKeys.includes('address')) {
            this.log(`Address changed to ${newSettings.address}, reconnecting`);
            this.connection?.detach(this);
            this.connection = PumpConnection.get(newSettings.address, this.profile, this.transport());
            this.connection.attach(this);
        } else if (changedKeys.includes('port') || changedKeys.includes('unitId')) {
            this.log(`Transport changed (port/unit), reconnecting`);
            this.connection?.applyTransport(this.transport());
        }
    }

    private async syncPollIntervalToSiblings(seconds: number) {
        const host = this.host();
        for (const device of this.driver.getDevices() as any[]) {
            if (device === this || device.getSettings?.().address !== host)
                continue;
            if (clampPollSeconds(device.getSettings().pollInterval) === seconds)
                continue;
            await device.setSettings({pollInterval: seconds}).catch(this.error);
        }
    }

    async onUninit() {
        this.connection?.detach(this);
    }

    async onDeleted() {
        this.log('Nibe device has been deleted');
        this.connection?.detach(this);
    }
}
