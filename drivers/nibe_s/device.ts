import {Device} from 'homey';
import {capabilitiesOptions} from './driver.compose.json';
import {Dir, Register, Selection} from './registers';
import {
    ACTIVE_POWER_CAPABILITY, METER_CAPABILITY, Role,
    energyTitle, extraCapabilities, powerTitle, registersForRole, roleClass, roleOf, roleRegisters
} from './roles';
import {PumpConnection, PumpSubscriber} from './connection';

// One logical function of the physical pump (see roles.ts). All devices share a
// single PumpConnection per pump IP; this class is just the Homey-facing subscriber:
// it maps its role's registers to capabilities, and — for function roles — keeps the
// energy bucket the connection's allocator feeds it.
class NibeSDevice extends Device implements PumpSubscriber {
    role: Role = 'main';
    private connection: PumpConnection | null = null;

    // Energy bucket (function roles only). Charged by the connection's allocator.
    private cumulativeEnergy = 0;

    private host(): string {
        return this.getSettings().address;
    }

    private getSelection(): Selection | null {
        return (this.getStoreValue('selection') ?? null) as Selection | null;
    }

    private fromRegisterValue(register: Register, value: number) {
        if (value >= 32768)
            value -= 65536;
        // -32768 (0x8000) is Nibe's "value not available" sentinel (e.g. a room sensor
        // that isn't wired to Modbus). Show it as no value ("-") rather than -3276.8.
        if (value === -32768)
            return null;
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

    async writeRegister(register: Register, value: any): Promise<boolean> {
        if (!this.connection)
            return false;
        return await this.connection.writeSingleRegister(register.address, this.toRegisterValue(register, value));
    }

    private capabilityChangedTrigger = this.homey.flow.getDeviceTriggerCard("capability_changed");
    private turnedOnTrigger = this.homey.flow.getDeviceTriggerCard("capability_turned_on");
    private turnedOffTrigger = this.homey.flow.getDeviceTriggerCard("capability_turned_off");

    private checkTrigger(register: Register, value: any) {
        // A command register never "turned on" — it was pressed. Nothing to trigger on.
        if (register.writeOnly)
            return;
        if (register.bool && value) {
            this.turnedOnTrigger.trigger(this, {}, {register: {id: register.name}, value: value});
        } else if (register.bool && !value) {
            this.turnedOffTrigger.trigger(this, {}, {register: {id: register.name}, value: value});
        } else if (register.enum) {
            this.capabilityChangedTrigger.trigger(this, {}, {register: {id: register.name}, value: value});
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
        if (!option)
            return;
        const current = this.getCapabilityOptions(name);
        if (JSON.stringify(current?.title) === JSON.stringify(option.title))
            return;
        await this.setCapabilityOptions(name, option);
    }

    // Per-instance options for the two non-register energy capabilities. The same
    // capability id (meter_power.total) needs a role-specific title per device, which
    // the shared compose file can't express, so it's supplied here.
    private extraOptions(name: string): any {
        if (name === METER_CAPABILITY)
            return {title: energyTitle(this.role)};
        if (name === ACTIVE_POWER_CAPABILITY)
            return {title: powerTitle(this.role), decimals: 0};
        return undefined;
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
        // until the next poll charges it. Seed it the way onInit does.
        if (this.role !== 'main' && this.hasCapability(METER_CAPABILITY))
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
        this.log(`NibeSDevice initialised (role ${this.role})`);

        // Keep the device class in sync (heater/boiler/other) — also fixes up devices
        // paired before per-role classes existed.
        if (this.getClass() !== roleClass[this.role])
            await this.setClass(roleClass[this.role]).catch(this.error);

        if (this.role !== 'main')
            this.cumulativeEnergy = this.getSettings().cumulativeEnergy || 0;

        await this.syncCapabilities();

        if (this.role !== 'main' && this.hasCapability(METER_CAPABILITY))
            await this.setCapabilityValue(METER_CAPABILITY, this.cumulativeEnergy).catch(this.error);

        // Writable capabilities of this role get a Modbus write listener. Registered for
        // every role register (not just the currently enabled ones) so a capability
        // enabled later via repair works without an app restart.
        for (const register of roleRegisters(this.role)) {
            if (register.direction === Dir.Out && !register.noAction) {
                this.registerCapabilityListener(register.name, async (value) => {
                    await this.writeRegister(register, value);
                    this.checkTrigger(register, value);
                });
            }
        }

        this.connection = PumpConnection.get(this.host());
        this.connection.attach(this);
    }

    // ---- PumpSubscriber ----

    wantedRegisters(): Register[] {
        return registersForRole(this.role, this.getSelection());
    }

    onRegisterRaw(register: Register, raw: number) {
        this.setValue(register, this.fromRegisterValue(register, raw)).catch(this.error);
    }

    onConnectionUp() {
        this.setAvailable().catch(this.error);
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
        if (changedKeys.includes('address')) {
            this.log(`Address changed to ${newSettings.address}, reconnecting`);
            this.connection?.detach(this);
            this.connection = PumpConnection.get(newSettings.address);
            this.connection.attach(this);
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
