import {Device, FlowCard} from 'homey';
import net from 'net';
import {ModbusTCPClient} from 'jsmodbus';
import {capabilities, capabilitiesOptions} from './driver.compose.json';
import {actions, conditions} from './driver.flow.compose.json';
import {
    Dir, Register, Selection,
    isRegisterEnabled, registerByName, registers, staticRegisters
} from './registers';
import {DetectionResult, readNumeric, recommendGroups, sampleRegisters} from './detection';

const socket = new net.Socket();

const actionSpecs: {[name: string]: any} = Object.fromEntries(actions.map((action: any) => [action.id, action]));
const conditionSpecs: {[name: string]: any} = Object.fromEntries(conditions.map((cond: any) => [cond.id, cond]));

class NibeSDevice extends Device {
    private pollInterval: NodeJS.Timeout | null = null;
    private retryInterval: NodeJS.Timeout | null = null;
    private client: ModbusTCPClient | null = null;

    // Energy meter tracking
    private cumulativeEnergy: number = 0; // kWh
    private lastPowerReading: number | null = null; // W, null = no previous reading to integrate from yet
    private lastPollTime: number = Date.now();

    private getSelection(): Selection | null {
        return (this.getStoreValue('selection') ?? null) as Selection | null;
    }

    private isEnabled(register: Register): boolean {
        return isRegisterEnabled(register, this.getSelection());
    }

    private enabledRegisters(): Register[] {
        const selection = this.getSelection();
        return registers.filter((register) => isRegisterEnabled(register, selection));
    }

    private fromRegisterValue(register: Register, value: number) {
        if (value >= 32768)
            value -= 65536;
        if (register.scale)
            return value / register.scale;
        if (register.enum)
            return this.homey.__(register.enum[value]) || register.enum[value];
        if (register.picker)
            return ""+ value;
        if (register.bool)
            return value === 1;
        return value;
    }

    private toRegisterValue(register: Register, value: any) {
        if (register.picker)
            value = parseInt(value);
        if (value < 0)
            value += 65536;
        if (register.scale)
            return Math.round(value * register.scale);
        if (register.enum)
            return parseInt(Object.entries(register.enum).filter(pair => pair[1] == value)[0][0]);
        if (register.bool)
            return value ? 1 : 0;
        return value;
    }

    private async readRegister(register: Register) {
        return await ((register.direction === Dir.In)
            ? this.client!.readInputRegisters(register.address, 1)
            : this.client!.readHoldingRegisters(register.address, 1))
        .then((resp) =>
            this.fromRegisterValue(register, resp.response.body.values[0]))
        .catch((reason: any) =>
            undefined
        );
    }

    private async readRegisters(toRead: Register[]) {
        return await Promise.all(toRead.map((register) =>
            this.readRegister(register))
        );
    }

    private async writeRegister(register: Register, value: any) {
        return await this.client!.writeSingleRegister(register.address, this.toRegisterValue(register, value))
            .then(result => {
                this.log("Wrote", JSON.stringify(result));
                return true;
            }).catch((reason: any) => {
                this.log("Error writing to register", reason);
                return false;
            });
    }

    // Create an autofill object for a register
    private regToAutofill = (register: Register) => {
        const option: any = (capabilitiesOptions as any)[register.name];
        return {
            id: register.name,
            name: option.title[this.homey.i18n.getLanguage()] || option.title["en"]
        };
    };

    private registerAutofillFlow(flow: FlowCard, registerFilter: (reg: Register) => boolean, cond: (args: any, state: any) => any) {
        return flow
            .registerArgumentAutocompleteListener(
                "register",
                async (query, args) =>
                    registers
                        .filter((reg) => this.isEnabled(reg) && registerFilter(reg))
                        .map(this.regToAutofill)
                        .filter((result: any) => result.name.toLowerCase().includes(query.toLowerCase()))
            )
            .registerRunListener(async (args, state) => cond(args, state));
    }

    private capabilityChangedTrigger = this.homey.flow.getDeviceTriggerCard("capability_changed");
    private turnedOnTrigger = this.homey.flow.getDeviceTriggerCard("capability_turned_on");
    private turnedOffTrigger = this.homey.flow.getDeviceTriggerCard("capability_turned_off");

    private checkTrigger(register: Register, value: any) {
        if (register.bool && value) {
            this.turnedOnTrigger.trigger(this, {}, {register: { id: register.name}, value: value});
        } else if (register.bool && !value) {
            this.turnedOffTrigger.trigger(this, {}, {register: {id: register.name}, value: value});
        } else if (register.enum) {
            this.capabilityChangedTrigger.trigger(this, {}, {register: {id: register.name}, value: value});
        }
    }

    async setValue(register: Register, value: any) {
        if (!this.hasCapability(register.name))
            return;
        const oldValue = this.getCapabilityValue(register.name);
        await this.setCapabilityValue(register.name, value);
        if (oldValue !== value)
            this.checkTrigger(register, value);
    }

    private poll() {
        this.log("Polling");
        const toPoll = this.enabledRegisters();
        this.readRegisters(toPoll).then((results: any) => {
            this.log(`Got ${toPoll.length} results`);

            // Update cumulative energy meter using i2166 (current power)
            const currentTime = Date.now();
            const deltaTimeHours = (currentTime - this.lastPollTime) / (1000 * 60 * 60);

            // Find i2166 (measure_power.i2166_energy_usage_v2) in results (always polled — core group)
            const i2166Index = toPoll.findIndex(r => r.name === "measure_power.i2166_energy_usage_v2");
            const currentPower = results[i2166Index];

            if (currentPower !== undefined && this.lastPowerReading !== null) {
                // Use trapezoidal integration for better accuracy
                const avgPower = (this.lastPowerReading + currentPower) / 2;
                const energyDelta = (avgPower * deltaTimeHours) / 1000; // Convert Wh to kWh

                this.cumulativeEnergy += energyDelta;

                // Update meter_power.total capability
                this.setCapabilityValue('meter_power.total', this.cumulativeEnergy).catch(this.error);

                // Persist every poll so a crash/restart loses at most one poll interval's energy,
                // rather than the previously batched 3-minute window.
                this.setSettings({ cumulativeEnergy: this.cumulativeEnergy }).catch(this.error);
            }

            if (currentPower !== undefined) {
                this.lastPowerReading = currentPower;
            }
            this.lastPollTime = currentTime;

            for (let i = 0; i < toPoll.length; ++i)
                if (results[i] !== undefined) {
                    this.setValue(toPoll[i], results[i]);
                }
        }).catch((error) => {
            this.log(error);
            socket.end();
            this.setUnavailable();
        });
    }

    private checkConfig() {
        // The compose capabilities list is the superset of everything a device can have;
        // each register must be declared there (order no longer matters since devices
        // carry only the user-selected subset).
        for (const register of registers) {
            if (!capabilities.includes(register.name)) {
                this.log(`Config mismatch: register ${register.name} missing from driver.compose.json capabilities`);
            }
            if (!(capabilitiesOptions as any)[register.name]) {
                this.log(`No options for ${register.name}`);
            }
        }
    }

    // addCapability() only applies the base capability type's built-in defaults (e.g. official
    // measure_power capabilities default to the generic title "Power"); the per-instance
    // title/decimals from driver.compose.json have to be pushed explicitly via
    // setCapabilityOptions(). getCapabilityOptions() is cheap, so check-and-skip here to avoid
    // needlessly calling the documented-as-expensive setCapabilityOptions() once already correct.
    private async ensureCapabilityOptions(name: string, option: any) {
        if (!option)
            return;
        const current = this.getCapabilityOptions(name);
        if (JSON.stringify(current?.title) === JSON.stringify(option.title))
            return;
        await this.setCapabilityOptions(name, option);
    }

    // Bring the device's capabilities in line with the current selection: drop
    // capabilities that no longer exist in the register table or that the user
    // has disabled, add the enabled ones. Kept in register-table order so newly
    // added capabilities land in a sensible position.
    private async syncCapabilities() {
        const selection = this.getSelection();

        for (const name of this.getCapabilities()) {
            const stale = name !== 'meter_power.total' && !registerByName[name];
            const disabled = registerByName[name] && !isRegisterEnabled(registerByName[name], selection);
            if (stale || disabled) {
                this.log(`Removing capability ${name} (${stale ? "stale" : "disabled"})`);
                await this.removeCapability(name).catch(this.error);
            }
        }

        for (const register of registers) {
            if (!isRegisterEnabled(register, selection))
                continue;
            if (!this.hasCapability(register.name))
                await this.addCapability(register.name).catch(this.error);
            await this.ensureCapabilityOptions(register.name, (capabilitiesOptions as any)[register.name])
                .catch(this.error);
        }
    }

    // Called from the repair flow when the user changes their feature selection.
    async applySelection(selection: Selection) {
        this.log("Applying selection", JSON.stringify(selection));
        await this.setStoreValue('selection', selection);
        await this.syncCapabilities();
    }

    // Called from the repair flow to re-run detection over the live connection.
    // Polling continues meanwhile; jsmodbus queues the requests.
    async probeForDetection(onProgress: (pass: number, passes: number) => void): Promise<DetectionResult> {
        if (!this.client || !this.getAvailable())
            throw new Error(this.homey.__("pair.not_connected"));
        const probes = await sampleRegisters((register) => readNumeric(this.client!, register), onProgress);
        return {recommendations: recommendGroups(probes)};
    }

    // Static configuration registers (fuse size etc.) are shown as read-only
    // labels in the advanced settings instead of capabilities.
    private async updateStaticSettings() {
        for (const staticRegister of staticRegisters) {
            const raw = await ((staticRegister.direction === Dir.In)
                ? this.client!.readInputRegisters(staticRegister.address, 1)
                : this.client!.readHoldingRegisters(staticRegister.address, 1))
                .then((resp: any) => resp.response.body.values[0])
                .catch(() => undefined);
            if (raw !== undefined)
                await this.setSettings({[staticRegister.settingId]: staticRegister.format(raw)})
                    .catch(this.error);
        }
    }

    async onInit() {
        this.log('NibeSDevice has been initialized');

        // Restore cumulative energy from settings
        const settings = this.getSettings();
        this.cumulativeEnergy = settings.cumulativeEnergy || 0;
        this.lastPollTime = Date.now();
        this.log(`Restored cumulative energy: ${this.cumulativeEnergy} kWh`);

        // Ensure meter_power.total capability exists
        if (!this.hasCapability('meter_power.total')) {
            await this.addCapability('meter_power.total');
        }
        await this.ensureCapabilityOptions('meter_power.total', (capabilitiesOptions as any)['meter_power.total']);
        await this.setCapabilityValue('meter_power.total', this.cumulativeEnergy);

        this.checkConfig();
        await this.syncCapabilities();

        await Promise.all(registers.map(async (register: Register) => {
            if (register.direction == Dir.Out) {
                // Write capability value change to device. Registered regardless of
                // the current selection so a capability enabled later via repair
                // works without an app restart.
                this.registerCapabilityListener(register.name, async (value) => {
                    await this.writeRegister(register, value);
                    this.checkTrigger(register, value);
                });
                // Flow controls for enums
                if (register.enum && actionSpecs[register.name + ".enum"]) {
                    this.homey.flow.getActionCard(register.name + ".enum")
                        .registerArgumentAutocompleteListener(
                            "mode",
                            async (query, args) =>
                                Object.entries(register.enum as any).map((parts: any) => {
                                    return {
                                        id: parts[1],
                                        name:  this.homey.__(parts[1]) || parts[1]
                                    }
                                }).filter((result: any) => result.name.toLowerCase().includes(query.toLowerCase()))
                        )
                        .registerRunListener(async (args, state) => {
                            if (await this.writeRegister(register, args.mode.id))
                                await this.setValue(register, args.mode.id);
                        });
                }
            }
            if (register.enum && conditionSpecs[register.name + ".enum"]) {
                this.homey.flow.getConditionCard(register.name + ".enum")
                    .registerArgumentAutocompleteListener(
                        "mode",
                        async (query, args) =>
                            Object.entries(register.enum as any).map((parts: any) => {
                                return {
                                    id: parts[1],
                                    name:  this.homey.__(parts[1]) || parts[1]
                                }
                            }).filter((result: any) => result.name.toLowerCase().includes(query.toLowerCase()))
                    )
                    .registerRunListener(async (args, state) => {
                        return this.getCapabilityValue(register.name) === args.mode.name;
                    });
            }
        }));

        // Flow control for setting values of numeric registers
        this.registerAutofillFlow(this.homey.flow.getActionCard("set_numeric_value"),
            (reg) => reg.direction == Dir.Out && reg.scale! > 0  && !reg.noAction!,
            async (args: any, state: any) => {
                const register = registerByName[args.register.id];
                if (args.value < register.min! || args.value > register.max!)
                    throw new Error("The value " + args.value + " is out of range. Value should be between " +
                        register.min + " and " + register.max + ".");
                if (await this.writeRegister(register, args.value)) {
                    const newValue = await this.readRegister(register);
                    if (newValue === args.value)
                        await this.setValue(register, newValue);
                    else
                        throw new Error("Failed setting " + args.value + ", got back value " + newValue);
                } else
                    throw new Error("Could not set value " + args.value);
            }
        );

        // Flow control for enabling boolean registers
        this.registerAutofillFlow(this.homey.flow.getActionCard("enable_feature"),
            (reg) => reg.direction == Dir.Out && reg.bool!,
            async (args: any, state: any) => {
                const register = registerByName[args.register.id];
                if (await this.writeRegister(register, true))
                    await this.setValue(register, await this.readRegister(register));
            }
        );

        // Flow control for disabling boolean registers
        this.registerAutofillFlow(this.homey.flow.getActionCard("disable_feature"),
            (reg) => reg.direction == Dir.Out && reg.bool!,
            async (args: any, state: any) => {
                const register = registerByName[args.register.id];
                if (await this.writeRegister(register, false))
                    await this.setValue(register, await this.readRegister(register));
            }
        );

        // Flow condition for numeric comparisons
        this.registerAutofillFlow(this.homey.flow.getConditionCard("numeric_value_comparison"),
            (reg) => reg.scale! > 0,
            (args: any, state: any) => {
                const capabilityValue = this.getCapabilityValue(args.register.id);
                return args.comparison === "<" ? capabilityValue < args.value : capabilityValue > args.value;
            }
        );

        this.registerAutofillFlow(this.homey.flow.getConditionCard("feature_enabled"),
            (reg) => reg.bool!,
            (args: any, state: any) => this.getCapabilityValue(args.register.id)
        );

        this.registerAutofillFlow(this.capabilityChangedTrigger,
            (reg) => reg.enum != undefined,
            (args: any, state: any) => args.device === this && args.register.id === state.register.id
        );

        this.registerAutofillFlow(this.turnedOnTrigger,
            (reg) => reg.bool!,
            (args: any, state: any) => args.device === this && args.register.id === state.register.id && state.value
        );

        this.registerAutofillFlow(this.turnedOffTrigger,
            (reg) => reg.bool!,
            (args: any, state: any) => args.device === this && args.register.id === state.register.id && !state.value
        );

        this.client = new ModbusTCPClient(socket, 1, 5000);
        clearInterval(this.pollInterval!);
        this.log("Connecting");
        socket.connect({port: 502, host: this.getSettings().address});

        socket.on('connect', () => {
            this.setAvailable();
            this.log("Connected");
            // Reset the energy integration baseline so a connection gap (initial connect or a
            // reconnect after a drop) isn't counted as continuous runtime at whatever power the
            // first poll after reconnecting happens to read.
            this.lastPowerReading = null;
            this.lastPollTime = Date.now();
            // Start polling, delay a bit the first time
            setTimeout(() => this.poll(), 200);
            setTimeout(() => this.updateStaticSettings().catch(this.error), 2000);
            this.pollInterval = setInterval(() => this.poll(), 5000);
        });

        socket.on('error', (error) => {
            this.log(error);
            this.setUnavailable();
        })

        // Close socket and retry
        socket.on('close', () => {
            this.log('Socket closed, retrying in 5 seconds ...');

            clearInterval(this.pollInterval!);

            this.retryInterval = setTimeout(() => {
                socket.connect({port: 502, host: this.getSettings().address});
                this.log('Reconnecting now ...');
            }, 5000);
        });
    }

    async onSettings({oldSettings, newSettings, changedKeys}: {
        oldSettings: {[key: string]: any}, newSettings: {[key: string]: any}, changedKeys: string[]
    }) {
        if (changedKeys.includes('cumulativeEnergy')) {
            // Manual meter adjustment from the settings page
            this.cumulativeEnergy = newSettings.cumulativeEnergy || 0;
            this.setCapabilityValue('meter_power.total', this.cumulativeEnergy).catch(this.error);
        }
        if (changedKeys.includes('address')) {
            // Reconnect to the new address; the close handler re-reads settings
            this.log(`Address changed to ${newSettings.address}, reconnecting`);
            socket.end();
        }
    }

    async onAdded() {
        this.log('MyDevice has been added');
        clearInterval(this.pollInterval!);
        clearInterval(this.retryInterval!);
    }

    async onDeleted() {
        this.log('Nibe S-series device has been deleted');
        clearInterval(this.pollInterval!);
        clearInterval(this.retryInterval!);
        socket.removeAllListeners();
        socket.end();
    }
}

module.exports = NibeSDevice;
