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
    registersForRole, roleGroups, roleNames, roleOf
} from './roles';
import {DetectionResult, probeHost} from './detection';
import {existingConnection} from './connection';
import {discoverPumps} from './discovery';

const actionSpecs: {[name: string]: any} = Object.fromEntries(actions.map((action: any) => [action.id, action]));
const conditionSpecs: {[name: string]: any} = Object.fromEntries(conditions.map((cond: any) => [cond.id, cond]));

class NibeSDriver extends Driver {
    async onInit() {
        this.log('Nibe S-Series driver has been initialized');
        this.checkConfig();
        this.registerFlows();
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
    // repairs only what it owns.
    private static subsetSelection(full: Selection, role: Role): Selection {
        const roleGroupSet = new Set<GroupId>(roleGroups[role]);
        const groups: Selection["groups"] = {};
        for (const id of groupIds)
            if (roleGroupSet.has(id))
                groups[id] = full.groups[id] ?? false;
        const overrides: Selection["overrides"] = {};
        for (const [name, value] of Object.entries(full.overrides)) {
            const register = registerByName[name];
            if (register && roleGroupSet.has(register.group))
                overrides[name] = value;
        }
        return {groups, overrides};
    }

    private extraOption(role: Role, name: string): any {
        if (name === METER_CAPABILITY)
            return {title: energyTitle(role)};
        if (name === ACTIVE_POWER_CAPABILITY)
            return {title: powerTitle(role), decimals: 0};
        return undefined;
    }

    // A Homey pair "device" template for one role of the pump. The main device keeps the
    // bare-IP data.id so a pre-existing (pre-split) device dedups against it and isn't
    // offered again; function devices get an "<ip>#<role>" id.
    private deviceTemplate(ip: string, role: Role, full: Selection) {
        const language = this.homey.i18n.getLanguage();
        const selection = NibeSDriver.subsetSelection(full, role);
        const roleRegs = registersForRole(role, selection);
        const options: {[name: string]: any} = {};
        for (const register of roleRegs)
            if ((capabilitiesOptions as any)[register.name])
                options[register.name] = (capabilitiesOptions as any)[register.name];
        for (const extra of extraCapabilities(role))
            options[extra] = this.extraOption(role, extra);
        return {
            name: roleNames[role][language as 'en' | 'sv'] || roleNames[role].en,
            data: role === 'main' ? {id: ip} : {id: `${ip}#${role}`, role},
            settings: {address: ip},
            store: {selection},
            capabilities: [...roleRegs.map((r) => r.name), ...extraCapabilities(role)],
            capabilitiesOptions: options
        };
    }

    // Main is always offered; each function device is offered when any of its groups was
    // selected in the features view.
    private buildDevices(ip: string, full: Selection) {
        const devices = [this.deviceTemplate(ip, 'main', full)];
        for (const role of functionRoles) {
            const anySelected = (roleGroups[role] as GroupId[])
                .some((group) => group !== 'core' && full.groups[group]);
            if (anySelected)
                devices.push(this.deviceTemplate(ip, role, full));
        }
        return devices;
    }

    async onPair(session: PairSession): Promise<void> {
        let ipAddress: string | null = null;
        let detection: DetectionResult | null = null;
        let detectionRunning: Promise<DetectionResult> | null = null;
        let pairSelection: Selection | null = null;

        session.setHandler('discover', async () => {
            const localAddress = await this.homey.cloud.getLocalAddress();
            const alreadyPaired = new Set(this.getDevices()
                .map((device) => String(device.getSettings().address || device.getData().id)));
            const pumps = await discoverPumps(localAddress, alreadyPaired, (done, total) =>
                session.emit('discovery_progress', {done, total}).catch(() => {}));
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

        session.setHandler('get_context', async () => ({
            mode: 'pair',
            groups: this.groupInfo(),
            selection: null
        }));

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
            this.log('Detection result:', JSON.stringify(detection));
            return detection;
        });

        session.setHandler('get_detection', async () => detection);

        session.setHandler('selection_done', async (raw) => {
            pairSelection = NibeSDriver.cleanSelection(raw);
            this.log('onPair: selection:', JSON.stringify(pairSelection));
            return true;
        });

        // Called by the list_devices pair template; offers main + detected function devices.
        session.setHandler('list_devices', async () =>
            this.buildDevices(ipAddress!, pairSelection ?? NibeSDriver.cleanSelection({groups: {}})));
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
            this.log('Repair detection result:', JSON.stringify(detection));
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
