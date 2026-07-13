import {Driver, FlowCard} from 'homey';
import PairSession from "homey/lib/PairSession";
import net from "net";
import {capabilities, capabilitiesOptions} from './driver.compose.json';
import {actions, conditions} from './driver.flow.compose.json';
import {
    Dir, GroupId, Register, Selection,
    groupIds, isAdjustable, registerByName, registers
} from './registers';
import {
    ACTIVE_POWER_CAPABILITY, METER_CAPABILITY, Role,
    energyTitle, extraCapabilities, functionRoles, powerTitle,
    registersForRole, roleGroups, roleNames, roleOf, roleRegisters
} from './roles';
import {DetectionResult, Recommendations, RegisterSample, probeHost} from './detection';
import {destroyAllConnections, existingConnection} from './connection';
import {discoverPumps} from './discovery';

const actionSpecs: {[name: string]: any} = Object.fromEntries(actions.map((action: any) => [action.id, action]));
const conditionSpecs: {[name: string]: any} = Object.fromEntries(conditions.map((cond: any) => [cond.id, cond]));

class NibeSDriver extends Driver {
    async onInit() {
        this.log('Nibe heat pump driver has been initialized');
        this.checkConfig();
        this.registerFlows();
    }

    async onUninit() {
        // Release the pump's single Modbus slot promptly on app unload.
        destroyAllConnections();
    }

    // The compose capabilities list is the superset of everything any device can have.
    private checkConfig() {
        for (const register of registers) {
            if (!capabilities.includes(register.name))
                this.log(`Config mismatch: register ${register.name} missing from driver.compose.json capabilities`);
            if (!(capabilitiesOptions as any)[register.name])
                this.log(`No options for ${register.name}`);
        }
    }

    // Autofill entry (id + localized title) for a register in a flow autocomplete.
    private regToAutofill = (register: Register) => {
        const option: any = (capabilitiesOptions as any)[register.name];
        const language = this.homey.i18n.getLanguage();
        return {
            id: register.name,
            name: option?.title?.[language] || option?.title?.en || register.name
        };
    };

    // Wire a register-autocomplete flow card. The autocomplete is scoped to the flow's
    // own device (args.device), so each device only offers its own role's registers.
    private registerAutofillFlow(flow: FlowCard, registerFilter: (reg: Register) => boolean,
                                 run: (args: any, state: any) => any) {
        return flow
            .registerArgumentAutocompleteListener("register", async (query, args) =>
                (args.device.wantedRegisters() as Register[])
                    .filter(registerFilter)
                    .map(this.regToAutofill)
                    .filter((result: any) => result.name.toLowerCase().includes(query.toLowerCase())))
            .registerRunListener(async (args, state) => run(args, state));
    }

    // All flow cards are registered once here on the driver (not per device): Homey flow
    // cards are singletons, so every run listener must dispatch through args.device.
    private registerFlows() {
        // Enum action/condition cards are per-register (fixed register, `mode` autocomplete).
        for (const register of registers) {
            if (!register.enum)
                continue;
            const enumOptions = async (query: string) =>
                Object.entries(register.enum as any).map((parts: any) => ({
                    id: parts[1],
                    name: this.homey.__(parts[1]) || parts[1]
                })).filter((result: any) => result.name.toLowerCase().includes(query.toLowerCase()));

            if (actionSpecs[register.name + ".enum"]) {
                this.homey.flow.getActionCard(register.name + ".enum")
                    .registerArgumentAutocompleteListener("mode", async (query) => enumOptions(query))
                    .registerRunListener(async (args) => {
                        if (await args.device.writeRegister(register, args.mode.id))
                            await args.device.setValue(register, args.mode.id);
                    });
            }
            if (conditionSpecs[register.name + ".enum"]) {
                this.homey.flow.getConditionCard(register.name + ".enum")
                    .registerArgumentAutocompleteListener("mode", async (query) => enumOptions(query))
                    .registerRunListener(async (args) =>
                        args.device.hasCapability(register.name)
                        && args.device.getCapabilityValue(register.name) === args.mode.name);
            }
        }

        this.registerAutofillFlow(this.homey.flow.getActionCard("set_numeric_value"),
            (reg) => reg.direction == Dir.Out && reg.scale! > 0 && !reg.noAction!,
            async (args: any) => {
                const register = registerByName[args.register.id];
                if (args.value < register.min! || args.value > register.max!)
                    throw new Error("The value " + args.value + " is out of range. Value should be between " +
                        register.min + " and " + register.max + ".");
                if (await args.device.writeRegister(register, args.value)) {
                    const newValue = await args.device.readRegister(register);
                    if (newValue === args.value)
                        await args.device.setValue(register, newValue);
                    else
                        throw new Error("Failed setting " + args.value + ", got back value " + newValue);
                } else
                    throw new Error("Could not set value " + args.value);
            });

        this.registerAutofillFlow(this.homey.flow.getActionCard("enable_feature"),
            (reg) => reg.direction == Dir.Out && reg.bool!,
            async (args: any) => {
                const register = registerByName[args.register.id];
                if (await args.device.writeRegister(register, true))
                    await args.device.setValue(register, await args.device.readRegister(register));
            });

        this.registerAutofillFlow(this.homey.flow.getActionCard("disable_feature"),
            (reg) => reg.direction == Dir.Out && reg.bool!,
            async (args: any) => {
                const register = registerByName[args.register.id];
                if (await args.device.writeRegister(register, false))
                    await args.device.setValue(register, await args.device.readRegister(register));
            });

        this.registerAutofillFlow(this.homey.flow.getConditionCard("numeric_value_comparison"),
            (reg) => reg.scale! > 0,
            (args: any) => {
                if (!args.device.hasCapability(args.register.id))
                    return false;
                const capabilityValue = args.device.getCapabilityValue(args.register.id);
                return args.comparison === "<" ? capabilityValue < args.value : capabilityValue > args.value;
            });

        this.registerAutofillFlow(this.homey.flow.getConditionCard("feature_enabled"),
            (reg) => reg.bool!,
            (args: any) => args.device.hasCapability(args.register.id) && args.device.getCapabilityValue(args.register.id));

        // Device trigger cards: Homey already scopes trigger() to the firing device, so the
        // run listener only has to match the register (and value) carried in the state.
        this.registerAutofillFlow(this.homey.flow.getDeviceTriggerCard("capability_changed"),
            (reg) => reg.enum != undefined,
            (args: any, state: any) => args.register.id === state.register.id);

        this.registerAutofillFlow(this.homey.flow.getDeviceTriggerCard("capability_turned_on"),
            (reg) => reg.bool!,
            (args: any, state: any) => args.register.id === state.register.id && state.value);

        this.registerAutofillFlow(this.homey.flow.getDeviceTriggerCard("capability_turned_off"),
            (reg) => reg.bool!,
            (args: any, state: any) => args.register.id === state.register.id && !state.value);
    }

    // Group/register metadata for the features view. When repairing a specific device we
    // pass its role so only that device's groups are shown.
    private groupInfo(role?: Role) {
        const language = this.homey.i18n.getLanguage();
        const title = (name: string) => {
            const option: any = (capabilitiesOptions as any)[name];
            return option?.title?.[language] || option?.title?.en || name;
        };
        const ids = role
            ? groupIds.filter((id) => (roleGroups[role] as GroupId[]).includes(id))
            : groupIds;
        return ids.map((id) => ({
            id,
            name: this.homey.__(`groups.${id}`) || id,
            registers: registers
                .filter((register) => register.group === id)
                .map((register) => ({
                    name: register.name,
                    title: title(register.name),
                    adjustable: isAdjustable(register),
                    description: (register.info as any)[language] || register.info.en
                }))
        }));
    }

    // Build the {groups, overrides} selection from what the features view sends,
    // only keeping overrides that differ from their group's setting.
    private static cleanSelection(raw: any): Selection {
        const groups: Selection["groups"] = {};
        for (const id of groupIds)
            groups[id] = !!raw?.groups?.[id];
        const overrides: Selection["overrides"] = {};
        for (const register of registers) {
            if (register.group === "core")
                continue; // core registers are always enabled
            const override = raw?.overrides?.[register.name];
            if (typeof override === "boolean" && override !== groups[register.group])
                overrides[register.name] = override;
        }
        return {groups, overrides};
    }

    // Narrow a pump-wide selection to just one role's groups, so each device stores and
    private extraOption(role: Role, name: string): any {
        if (name === METER_CAPABILITY)
            return {title: energyTitle(role)};
        if (name === ACTIVE_POWER_CAPABILITY)
            return {title: powerTitle(role), decimals: 0};
        return undefined;
    }

    // Default group selection for a freshly paired device: enable the groups detection
    // recommended (skipped detection → enable all). The device picker lets the user
    // toggle these per group before adding, and they can change it later via repair.
    private static roleSelection(role: Role, recommendations: Recommendations): Selection {
        const groups: Selection["groups"] = {};
        for (const id of groupIds)
            if ((roleGroups[role] as GroupId[]).includes(id))
                groups[id] = recommendations[id] ? !!recommendations[id]!.recommended : true;
        return {groups, overrides: {}};
    }

    // A Homey pair "device" template for one role of the pump. Each device gets an
    // "<ip>#<role>" data.id, so re-running pairing on the same pump dedups against the
    // devices already added and only offers the missing ones.
    private deviceTemplate(ip: string, role: Role, recommendations: Recommendations,
                           samples: Record<string, RegisterSample>) {
        const language = this.homey.i18n.getLanguage();
        const selection = NibeSDriver.roleSelection(role, recommendations);
        // Within an enabled group, drop registers that returned no data during detection
        // so the device doesn't carry dead capabilities (e.g. the FTX air-temperature
        // sensors on a pump that only exposes the fan-mode register). Recorded as
        // overrides so they stay off but can be re-enabled later via repair.
        for (const register of roleRegisters(role)) {
            if (register.group !== 'core'
                && selection.groups[register.group]
                && samples[register.name] && !samples[register.name].read)
                selection.overrides[register.name] = false;
        }
        // Order capabilities by the role's group order (stable within a group) so that,
        // e.g., the heating device's ventilation/FTX capabilities are grouped together
        // at the end rather than interleaved with the heating ones.
        const groupOrder = roleGroups[role] as GroupId[];
        const roleRegs = registersForRole(role, selection)
            .sort((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group));
        // Options for every register the role could carry (not just the default-enabled
        // ones), so a capability the user enables via the picker still gets its title.
        const options: {[name: string]: any} = {};
        for (const register of roleRegisters(role))
            if ((capabilitiesOptions as any)[register.name])
                options[register.name] = (capabilitiesOptions as any)[register.name];
        for (const extra of extraCapabilities(role))
            options[extra] = this.extraOption(role, extra);
        return {
            name: roleNames[role][language as 'en' | 'sv'] || roleNames[role].en,
            data: {id: `${ip}#${role}`, role},
            settings: {address: ip},
            store: {selection},
            icon: `/drivers/nibe_s/assets/${role}.svg`,
            capabilities: [...roleRegs.map((r) => r.name), ...extraCapabilities(role)],
            capabilitiesOptions: options
        };
    }

    // Short "what's in this device" summary for the pairing device picker.
    private roleDescription(role: Role): string {
        if (role === 'main')
            return this.homey.__('pair.devices.main_desc');
        return (roleGroups[role] as GroupId[])
            .filter((group) => group !== 'core')
            .map((group) => this.homey.__(`groups.${group}`) || group)
            .join(', ');
    }

    // The feature groups shown (and toggled) under a device in the picker's expand:
    // each role group plus, for function devices, a fixed "Energy" group listing the
    // meter/power capabilities. Core and Energy are fixed (always included); the rest
    // default to whatever detection recommended and can be toggled by the user.
    private candidateGroups(role: Role, recommendations: Recommendations, samples: Record<string, RegisterSample>) {
        const lang = this.homey.i18n.getLanguage() as 'en' | 'sv';
        const groups: any[] = (roleGroups[role] as GroupId[])
            .map((id) => ({
                id,
                name: id === 'core'
                    ? (this.homey.__('groups.core') || 'Core')
                    : (this.homey.__(`groups.${id}`) || id),
                fixed: id === 'core',
                selected: id === 'core' ? true : !!(recommendations[id] ? recommendations[id]!.recommended : true),
                caps: registers.filter((register) => register.group === id).map((register) => ({
                    name: register.name,
                    title: this.regToAutofill(register).name,
                    detected: samples[register.name]?.read ?? false
                }))
            }))
            .filter((group) => group.caps.length > 0);
        if (role !== 'main')
            groups.push({
                id: '_energy',
                name: this.homey.__('pair.devices.energy') || 'Energy',
                fixed: true,
                selected: true,
                caps: extraCapabilities(role).map((cap) => ({
                    name: cap,
                    title: (cap === METER_CAPABILITY ? energyTitle(role) : powerTitle(role))[lang],
                    detected: true
                }))
            });
        return groups;
    }

    // All candidate devices for the picker: main plus every function device, each
    // flagged with whether detection saw live data for it (so the view can highlight
    // and pre-check them while still letting the user add any). Roles already paired
    // for this pump are omitted, so re-running pairing only offers the missing ones.
    private pairingCandidates(ip: string, detection: DetectionResult | null) {
        const recommendations = detection?.recommendations ?? {};
        const samples = detection?.samples ?? {};
        const paired = new Set(this.getDevices().map((device) => String(device.getData().id)));
        return ([...['main'] as Role[], ...functionRoles])
            .filter((role) => !paired.has(`${ip}#${role}`))
            .map((role) => ({
                role,
                name: roleNames[role][this.homey.i18n.getLanguage() as 'en' | 'sv'] || roleNames[role].en,
                description: this.roleDescription(role),
                detected: role === 'main'
                    ? true
                    : (roleGroups[role] as GroupId[])
                        .some((group) => group !== 'core' && recommendations[group]?.recommended),
                device: this.deviceTemplate(ip, role, recommendations, samples),
                // Feature groups for the "click to expand" section (see candidateGroups).
                groups: this.candidateGroups(role, recommendations, samples)
            }));
    }

    async onPair(session: PairSession): Promise<void> {
        let ipAddress: string | null = null;
        let detection: DetectionResult | null = null;
        let detectionRunning: Promise<DetectionResult> | null = null;

        session.setHandler('discover', async () => {
            const localAddress = await this.homey.cloud.getLocalAddress();
            const pairedAddresses = this.getDevices().map((device) => String(device.getSettings().address));
            // Skip already-paired IPs in the subnet scan: the pump allows only one Modbus
            // client, so a fresh probe socket to a connected pump is refused anyway.
            const found = await discoverPumps(localAddress, new Set(pairedAddresses), (done, total) =>
                session.emit('discovery_progress', {done, total}).catch(() => {}));
            const byAddress = new Map(found.map((pump) => [pump.address, pump]));
            // Re-add paired pumps via their existing live connection (which the scan can't
            // duplicate), so a pump you've already added still shows up and you can pair
            // more of its function devices.
            for (const address of new Set(pairedAddresses)) {
                if (byAddress.has(address))
                    continue;
                const connection = existingConnection(address);
                if (!connection?.isConnected())
                    continue;
                const raw = await connection.readRegisterRaw({address: 1, direction: Dir.In} as Register);
                byAddress.set(address, {
                    address,
                    outdoorTemperature: raw === undefined ? undefined : (raw >= 32768 ? raw - 65536 : raw) / 10
                });
            }
            const pumps = [...byAddress.values()];
            this.log('Discovered pumps:', JSON.stringify(pumps));
            return pumps;
        });

        session.setHandler('ip_address_entered', async (data) => {
            this.log('onPair: ip_address_entered:', data);
            if (!net.isIP(data.ipaddress))
                throw new Error(this.homey.__('pair.valid_ip_address'));
            ipAddress = data.ipaddress;
            return true;
        });

        // detect.js reads the mode to decide where to go after detection.
        session.setHandler('get_context', async () => ({mode: 'pair'}));

        session.setHandler('start_detection', async () => {
            if (!detectionRunning) {
                const onProgress = (pass: number, passes: number) =>
                    session.emit('detection_progress', {pass, passes}).catch(() => {});
                // If a device for this IP already holds the single allowed connection
                // (e.g. adding another logical device later), probe over it — opening a
                // second socket would be refused by the pump.
                const live = existingConnection(ipAddress!);
                detectionRunning = (live && live.isConnected()
                    ? live.probe(onProgress)
                    : probeHost(ipAddress!, onProgress))
                    .catch((error) => {
                        detectionRunning = null; // allow the view's retry button to try again
                        throw error;
                    });
            }
            detection = await detectionRunning;
            this.log('Detection result:', JSON.stringify(detection.recommendations));
            return detection;
        });

        session.setHandler('get_detection', async () => detection);

        // The device-picker view renders these and calls Homey.createDevice() for the
        // ones the user keeps checked.
        session.setHandler('get_pairing_devices', async () =>
            this.pairingCandidates(ipAddress!, detection));
    }

    async onRepair(session: PairSession, device: any): Promise<void> {
        const role = roleOf(device.getData());
        let detection: DetectionResult | null = null;
        let detectionRunning: Promise<DetectionResult> | null = null;

        session.setHandler('get_context', async () => ({
            mode: 'repair',
            groups: this.groupInfo(role),
            selection: (device.getStoreValue('selection') ?? null) as Selection | null
        }));

        session.setHandler('start_detection', async () => {
            if (!detectionRunning) {
                detectionRunning = device.probeForDetection((pass: number, passes: number) =>
                    session.emit('detection_progress', {pass, passes}).catch(() => {}))
                    .catch((error: any) => {
                        detectionRunning = null; // allow the view's retry button to try again
                        throw error;
                    });
            }
            detection = await detectionRunning;
            this.log('Repair detection result:', JSON.stringify(detection?.recommendations));
            return detection;
        });

        session.setHandler('get_detection', async () => detection);

        session.setHandler('selection_done', async (raw) => {
            const selection = NibeSDriver.cleanSelection(raw);
            this.log('onRepair: selection:', JSON.stringify(selection));
            await device.applySelection(selection);
            return true;
        });
    }
}

module.exports = NibeSDriver;
