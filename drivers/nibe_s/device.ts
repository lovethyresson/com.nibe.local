import {Device} from 'homey';
import {capabilitiesOptions} from './driver.compose.json';
import {Dir, Register, Selection, isUnavailableRaw, signedValue} from './registers';
import {
    ACTIVE_POWER_CAPABILITY, FUNCTION_COP_CAPABILITY, METER_CAPABILITY, PRIORITY_RAW_OFF,
    PRIORITY_REGISTER_NAME, PUMP_ACTIVE_CAPABILITY, Role,
    SOLAR_METER_CAPABILITY, TOTAL_CONSUMPTION_REGISTER, TOTAL_COP_CAPABILITY,
    TOTAL_PRODUCTION_REGISTER, energyTitle, extraCapabilities, functionRoles, powerTitle,
    producedRegisterForRole, pumpActiveTitle, registersForRole, roleClass, roleOf, roleRegisters
} from './roles';
import {PumpConnection, PumpSubscriber, POLL_SECONDS_DEFAULT, clampPollSeconds} from './connection';

// One logical function of the physical pump (see roles.ts). All devices share a
// single PumpConnection per pump IP; this class is just the Homey-facing subscriber:
// it maps its role's registers to capabilities, and — for function roles — keeps the
// energy bucket the connection's allocator feeds it.
class NibeSDevice extends Device implements PumpSubscriber {
    role: Role = 'main';
    private connection: PumpConnection | null = null;

    // Energy bucket (function roles only). Charged by the connection's allocator.
    private cumulativeEnergy = 0;

    // Last derived on/off for the main device, so the transition is logged once rather
    // than on every poll.
    private lastPumpActive: boolean | null = null;

    private host(): string {
        return this.getSettings().address;
    }

    private getSelection(): Selection | null {
        return (this.getStoreValue('selection') ?? null) as Selection | null;
    }

    // Compact enabled-groups (+ overrides) summary for the init log, so a user's log dump
    // shows which features this device is configured for.
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
        // 0x8000 / 0x80000000 is Nibe's "value not available" sentinel (e.g. a room sensor
        // that isn't wired to Modbus). Show it as no value ("-") rather than -3276.8.
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
        // Two's complement last, mirroring fromRegisterValue() which undoes it first:
        // wrapping before scaling would multiply the wrapped value and overflow the
        // register (-20 °C on a scale-10 register became 655160 rather than 65336).
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
            // Surface a clear, user-facing message instead of failing silently. The pump
            // rejects some writes contextually (e.g. hot-water registers when hot water is
            // turned off) as a Modbus exception — the user needs to see that, not just the log.
            throw new Error(`Could not set "${this.registerTitle(register)}": ${error?.message ?? error}`);
        }
    }

    private capabilityChangedTrigger = this.homey.flow.getDeviceTriggerCard("capability_changed");
    private turnedOnTrigger = this.homey.flow.getDeviceTriggerCard("capability_turned_on");
    private turnedOffTrigger = this.homey.flow.getDeviceTriggerCard("capability_turned_off");

    // Human-readable capability title, for the `register` Flow token. Falls back through
    // the app language, English, then the raw capability name.
    private registerTitle(register: Register): string {
        const option: any = (capabilitiesOptions as any)[register.name];
        const language = this.homey.i18n.getLanguage();
        return option?.title?.[language] || option?.title?.en || register.name;
    }

    private checkTrigger(register: Register, value: any) {
        // A command register never "turned on" — it was pressed. Nothing to trigger on.
        if (register.writeOnly)
            return;
        // The second argument is the card's Flow tokens (what shows up under "This Flow"
        // downstream); the third is trigger state, only used to match the card's register
        // argument. Passing {} left every Nibe trigger contributing nothing to the flow.
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
        // Command registers have no state to reflect, and their capabilities (Homey's
        // `button`) are not getable — writing a value to one throws.
        if (register.writeOnly || !this.hasCapability(register.name))
            return;
        const oldValue = this.getCapabilityValue(register.name);
        await this.setCapabilityValue(register.name, value);
        if (oldValue !== value)
            this.checkTrigger(register, value);
    }

    // addCapability() only applies the base capability type's built-in defaults; the
    // per-instance title/decimals have to be pushed explicitly. getCapabilityOptions()
    // is cheap, so check-and-skip to avoid the documented-as-expensive set call.
    private async ensureCapabilityOptions(name: string, option: any) {
        if (!option || !this.hasCapability(name))
            return;
        // getCapabilityOptions() throws "Invalid Capability" when the capability id isn't in
        // the *installed* app manifest — even though the device carries the instance. This
        // happens right after a new capability *type* is added but the Homey hasn't had a
        // clean (re)install: `homey app run` hot-reloads code but doesn't register new
        // capability definitions. Skip quietly (one log line, not an onInit stack trace);
        // the options apply themselves after a clean reinstall.
        let current: any;
        try {
            current = this.getCapabilityOptions(name) ?? {};
        } catch (error) {
            this.log(`Skipping options for ${name} — ${(error as Error).message}; `
                + `a new capability type needs a clean app reinstall to register`);
            return;
        }
        // setCapabilityOptions is documented as expensive, so only push when a declared
        // option actually differs from what's stored. Compare every key we declare
        // (title, decimals, min/max, uiComponent, insights) rather than just the title —
        // otherwise a uiComponent/insights change on an already-paired device would be
        // skipped as long as its title was unchanged, and never take effect.
        const differs = Object.keys(option).some(
            (key) => JSON.stringify(current[key]) !== JSON.stringify(option[key]));
        if (!differs)
            return;
        await this.setCapabilityOptions(name, option)
            .catch((error) => this.log(`Could not set options for ${name} — ${error?.message ?? error}`));
    }

    // Per-instance options for the two non-register energy capabilities. The same
    // capability id (meter_power.total) needs a role-specific title per device, which
    // the shared compose file can't express, so it's supplied here.
    private extraOptions(name: string): any {
        if (name === METER_CAPABILITY)
            return {title: energyTitle(this.role)};
        if (name === ACTIVE_POWER_CAPABILITY)
            return {title: powerTitle(this.role), decimals: 0};
        // Main's on/off reflects the operating priority and cannot be commanded. It needs
        // its own title (the shared compose entry names register 697's "More hot water")
        // and uiComponent:null to drop the switch. `setable: false` was tried first and is
        // not honoured — it left the toggle in place and, being outside Homey's settings
        // schema, risks the stored flag rejecting our own setCapabilityValue writes.
        // setable is restored to true on purpose: an earlier build stored `false` here,
        // and since the options are merged rather than replaced, omitting it would leave
        // that stale flag on already-paired devices.
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
    // COP is produced/used over a trailing window rather than lifetime, so it tracks the
    // season instead of sitting at the flat all-time average. Both inputs are the *raw*
    // cumulative counters (pre-baseline; the baseline cancels in a delta): production/
    // consumption (3821/3823) for main, the function's produced register / allocator used
    // energy for a function device. Snapshots of the counters are kept in the device store
    // and COP = (now − ~30-days-ago) produced / used.
    private static readonly COP_WINDOW_MS = 30 * 24 * 3600 * 1000;
    private static readonly COP_SNAPSHOT_MS = 6 * 3600 * 1000; // snapshot at most every 6h
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
        if (!last || now - last.t >= NibeSDevice.COP_SNAPSHOT_MS) {
            samples.push({t: now, p: this.copProduced, u: this.copUsed});
            changed = true;
        }
        // Keep one snapshot just older than the window (the COP reference) plus everything
        // inside it; drop the rest.
        while (samples.length > 2 && now - samples[1].t > NibeSDevice.COP_WINDOW_MS) {
            samples.shift();
            changed = true;
        }
        if (changed)
            this.setStoreValue('copSamples', samples).catch(this.error);
        // Reference = oldest snapshot still within the window (or the oldest we have while
        // history is still building up toward 30 days).
        const reference = samples.find((s) => now - s.t <= NibeSDevice.COP_WINDOW_MS) ?? samples[0];
        const producedDelta = this.copProduced - reference.p;
        const usedDelta = this.copUsed - reference.u;
        if (usedDelta > 0.1) {
            const cop = Math.round((producedDelta / usedDelta) * 100) / 100;
            this.setCapabilityValue(capability, cop).catch(this.error);
        }
    }

    // A cumulative counter's value relative to the first one seen after pairing, so energy
    // reads "since added". The baseline is persisted so the figure is stable across
    // restarts.
    private applyBaseline(register: Register, value: number): number {
        const key = `baseline.${register.name}`;
        let baseline = this.getStoreValue(key);
        if (typeof baseline !== 'number') {
            baseline = value;
            this.setStoreValue(key, baseline).catch(this.error);
        }
        return value - baseline;
    }

    // Reconcile the device's capabilities with its role + feature selection: drop
    // capabilities no longer wanted (disabled, or belonging to another role, or a
    // register that left the table), add the wanted ones. Register capabilities in
    // table order so newly added ones land sensibly; energy extras go last.
    private async syncCapabilities() {
        const selection = this.getSelection();
        const roleRegs = registersForRole(this.role, selection);
        const extras = extraCapabilities(this.role, selection);

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
            await this.ensureCapabilityOptions(register.name, (capabilitiesOptions as any)[register.name])
                .catch(this.error);
        }
        for (const extra of extras) {
            if (!this.hasCapability(extra))
                await this.addCapability(extra).catch(this.error);
            await this.ensureCapabilityOptions(extra, this.extraOptions(extra)).catch(this.error);
        }
    }

    // Called from the repair flow when the user changes this device's feature selection.
    async applySelection(selection: Selection) {
        this.log("Applying selection", JSON.stringify(selection));
        await this.setStoreValue('selection', selection);
        await this.syncCapabilities();
        // The kWh total keeps accumulating while the meter capability is off (onEnergy
        // guards only the capability writes), so a meter re-enabled here would read 0
        // until the next poll charges it. Seed it the way onInit does (main included, for
        // its standby meter).
        if (this.hasCapability(METER_CAPABILITY))
            await this.setCapabilityValue(METER_CAPABILITY, this.cumulativeEnergy).catch(this.error);
    }

    // Re-run detection over the live connection (used by repair).
    async probeForDetection(onProgress: (pass: number, passes: number) => void) {
        if (!this.connection || !this.getAvailable())
            throw new Error(this.homey.__("pair.not_connected"));
        return this.connection.probe(onProgress);
    }

    async onInit() {
        this.role = roleOf(this.getData());
        this.log(`Device init: role ${this.role}, host ${this.host()}, groups [${this.enabledGroupsSummary()}]`);

        // Keep the device class in sync (heater/boiler/other) — also fixes up devices
        // paired before per-role classes existed.
        if (this.getClass() !== roleClass[this.role])
            await this.setClass(roleClass[this.role]).catch(this.error);

        // Solar reports generation to Homey's Energy tab: declare its cumulative meter as
        // exported energy (production), overriding the driver's consumption energy config.
        if (this.role === 'solar')
            await this.setEnergy({meterPowerExportedCapability: SOLAR_METER_CAPABILITY}).catch(this.error);

        // Function devices track their used energy here; main tracks its standby energy —
        // both stored in the "cumulativeEnergy" setting. Only function devices feed it into
        // a rolling COP (main's COP comes from the pump's own counters, not the allocator).
        if (functionRoles.includes(this.role) || this.role === 'main')
            this.cumulativeEnergy = this.getSettings().cumulativeEnergy || 0;
        if (functionRoles.includes(this.role))
            this.copUsed = this.cumulativeEnergy; // seed the rolling-COP used side

        await this.syncCapabilities();
        this.log(`Device capabilities synced: ${this.getCapabilities().length} — `
            + this.getCapabilities().join(', '));

        if (this.hasCapability(METER_CAPABILITY))
            await this.setCapabilityValue(METER_CAPABILITY, this.cumulativeEnergy).catch(this.error);

        // Writable capabilities of this role get a Modbus write listener. Registered for
        // every role register (not just the currently enabled ones) so a capability
        // enabled later via repair works without an app restart.
        for (const register of roleRegisters(this.role)) {
            if (register.direction === Dir.Out && !register.noAction) {
                this.registerCapabilityListener(register.name, async (value) => {
                    this.log(`Manual set ${register.name} = ${value}`);
                    await this.writeRegister(register, value);
                    this.checkTrigger(register, value);
                });
            }
        }

        // Main's on/off is derived state, not a command. setable:false should keep the
        // tile from offering a switch, but register a listener anyway: without one a
        // toggle raises "no capability listener", and this way a stray tap simply snaps
        // back to whatever the operating priority currently says.
        if (this.role === 'main') {
            this.registerCapabilityListener(PUMP_ACTIVE_CAPABILITY, async () => {
                const raw = this.connection?.lastRawFor(PRIORITY_REGISTER_NAME);
                const actual = raw === undefined ? false : raw !== PRIORITY_RAW_OFF;
                setTimeout(() => this.setCapabilityValue(PUMP_ACTIVE_CAPABILITY, actual)
                    .catch(this.error), 300);
                throw new Error(this.homey.__('pair.not_settable'));
            });
        }

        this.connection = PumpConnection.get(this.host());
        this.connection.attach(this);
    }

    // ---- PumpSubscriber ----

    // Polling rate this device asks the shared connection for. The main device owns the
    // setting; the others inherit it (see PumpConnection.desiredPollSeconds) and only
    // matter when no main device is paired.
    pollSeconds(): number {
        // Devices paired before this setting existed report 0 rather than undefined, and
        // 0 slips past ?? and then clamps up to the minimum — so a device that had never
        // seen the setting polled every 5 s instead of the intended 10. Treat anything
        // non-positive as "not set".
        const stored = this.getSettings().pollInterval;
        const seconds = typeof stored === 'number' && stored > 0 ? stored : POLL_SECONDS_DEFAULT;
        return clampPollSeconds(seconds);
    }

    wantedRegisters(): Register[] {
        return registersForRole(this.role, this.getSelection());
    }

    onRegisterRaw(register: Register, raw: number) {
        const rawValue = this.fromRegisterValue(register, raw);
        // Relative counters (energy) display as "since added"; keep the raw (pre-baseline)
        // value for COP, which uses deltas where the baseline cancels anyway.
        const value = register.relative && typeof rawValue === 'number'
            ? this.applyBaseline(register, rawValue)
            : rawValue;
        this.setValue(register, value).catch(this.error);
        // Feed the rolling COP source counters.
        const rawScaled = typeof rawValue === 'number' ? rawValue : null;
        if (this.role === 'main') {
            if (register.name === TOTAL_PRODUCTION_REGISTER) {
                this.copProduced = rawScaled;
                this.updateRollingCop();
            } else if (register.name === TOTAL_CONSUMPTION_REGISTER) {
                this.copUsed = rawScaled;
                this.updateRollingCop();
            }
        } else if (register.name === producedRegisterForRole[this.role]) {
            this.copProduced = rawScaled;
            this.updateRollingCop();
        }
        // Main has no "powered off" register, so its on/off follows the pump's operating
        // priority: idle (10) is off, anything it is actively producing is on. An
        // unrecognised priority counts as on — the pump is doing something we can't name.
        if (this.role === 'main' && register.name === PRIORITY_REGISTER_NAME
            && this.hasCapability(PUMP_ACTIVE_CAPABILITY)) {
            const active = raw !== PRIORITY_RAW_OFF;
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

    // Read the pump's identity once per connect and surface it: firmware (register 1496)
    // and heat-pump type code (1497). Not capabilities — static info — so they go to the
    // read-only "Heat pump" settings labels, written to every device on this pump so each
    // shows them, and to the log for support ("send me your logs"). This is the whole of
    // "model info": no fingerprint classifier, per the architecture decision.
    private async updatePumpInfo() {
        if (!this.connection)
            return;
        const type = await this.connection.readRegisterRaw({address: 1497, direction: Dir.In} as Register);
        const firmware = await this.connection.readRegisterRaw({address: 1496, direction: Dir.In} as Register);
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
            // Persist every poll so a crash/restart loses at most one interval's energy.
            this.setSettings({cumulativeEnergy: this.cumulativeEnergy}).catch(this.error);
        }
        // Only function devices feed the allocator's cumulative energy into a rolling COP.
        // Main receives standby energy here but its Total COP comes from the pump's own
        // production/consumption counters (set in onRegisterRaw), so don't touch copUsed.
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
            // Homey renders the driver's settings form on every device, so this field
            // appears on all five. Keep them in sync rather than leaving four copies
            // that look editable but are ignored: write the value to the siblings on
            // this pump (only where it differs, so the cascade stops after one round).
            this.syncPollIntervalToSiblings(seconds).catch(this.error);
            this.connection?.refreshPollInterval();
        }
        if (changedKeys.includes('address')) {
            this.log(`Address changed to ${newSettings.address}, reconnecting`);
            this.connection?.detach(this);
            this.connection = PumpConnection.get(newSettings.address);
            this.connection.attach(this);
        }
    }

    // Mirror the poll interval onto the other devices of the same pump. Guarded on the
    // value actually differing, so the resulting onSettings on each sibling is a no-op
    // and this doesn't recurse.
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

module.exports = NibeSDevice;
