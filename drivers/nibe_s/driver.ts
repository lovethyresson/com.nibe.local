import {Driver, FlowCard} from 'homey';
import PairSession from "homey/lib/PairSession";
import net from "net";
import {capabilities, capabilitiesOptions} from './driver.compose.json';
import {actions, conditions, triggers} from './driver.flow.compose.json';
import {
    Dir, GroupId, Register, RegisterInfo, Selection,
    groupIds, isAdjustable, isSelectableRegister, registerByName, registers
} from './registers';
import {
    ACTIVE_POWER_CAPABILITY, ENERGY_CAPABILITIES, FUNCTION_COP_CAPABILITY, METER_CAPABILITY,
    Role, TOTAL_COP_CAPABILITY, allRoles, energyTitle, extraCapabilities, functionRoles,
    powerTitle, registersForRole, roleClass, roleGroups, roleNames, roleOf, roleRegisters
} from './roles';
import {DetectionResult, PROBE_PASSES, Recommendations, RegisterSample, probeHost} from './detection';
import {destroyAllConnections, existingConnection} from './connection';
import {discoverPumps} from './discovery';

const actionSpecs: {[name: string]: any} = Object.fromEntries(actions.map((action: any) => [action.id, action]));
const conditionSpecs: {[name: string]: any} = Object.fromEntries(conditions.map((cond: any) => [cond.id, cond]));

class NibeSDriver extends Driver {
    async onInit() {
        this.log(`Driver initialised — app v${(this.homey.manifest as any).version}, `
            + `${registers.length} registers, ${this.getDevices().length} paired device(s)`);
        this.checkConfig();
        this.registerFlows();
    }

    // Compact "group:evidence" list for the pairing/repair logs — makes a user's log dump
    // show at a glance what detection saw for each feature group.
    private recommendationSummary(recs: Recommendations): string {
        return groupIds
            .map((id) => recs[id] ? `${id}:${recs[id]!.evidence}${recs[id]!.recommended ? '(rec)' : ''}` : null)
            .filter(Boolean)
            .join(' ') || '(none)';
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
        // Every flow card carries a hint (the tooltip under its title in the Flow editor).
        // Homey doesn't require one, so a card added without it fails silently in the UI.
        for (const card of [...triggers, ...actions, ...conditions] as any[]) {
            const hint = card.hint;
            if (!hint?.en || !hint?.sv)
                this.log(`Flow card ${card.id} is missing a${hint?.en ? ' Swedish' : ''} hint`);
        }
        // A writable register with no dedicated card is only reachable from the
        // Advanced-Flow escape hatches, which is rarely what we want.
        for (const register of registers) {
            if (!isAdjustable(register) || register.enum || register.bool || register.picker)
                continue;
            if (!actionSpecs[`${register.name}.set`])
                this.log(`No dedicated "set" flow card for writable register ${register.name}`);
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

    // Range-check, write and read back a numeric register. Shared by the dedicated
    // "<capability>.set" cards and the generic set_numeric_value one so the validation
    // and the write-verify only exist once.
    private async writeNumeric(device: any, register: Register, value: number) {
        this.log(`Flow: ${device.getName()} set ${register.name} = ${value}`);
        if (value < register.min! || value > register.max!)
            throw new Error("The value " + value + " is out of range. Value should be between " +
                register.min + " and " + register.max + ".");
        await device.writeRegister(register, value); // throws (shown to the user) on failure
        const newValue = await device.readRegister(register);
        if (newValue !== value)
            throw new Error("Failed setting " + value + ", got back value " + newValue);
        await device.setValue(register, newValue);
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
                        this.log(`Flow: ${args.device.getName()} set ${register.name} = ${args.mode.name}`);
                        await args.device.writeRegister(register, args.mode.id);
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

        // Dedicated per-register action cards ("Set the heat curve to 5"), scoped to the
        // devices carrying the capability via $filter in the flow compose file. These are
        // the standard-Flow way to change a setting; set_numeric_value below is the same
        // write behind an Advanced-Flow register picker.
        for (const register of registers) {
            if (!isAdjustable(register) || !(register.scale! > 0))
                continue;
            if (actionSpecs[register.name + ".set"]) {
                this.homey.flow.getActionCard(register.name + ".set")
                    .registerRunListener(async (args) => this.writeNumeric(args.device, register, args.value));
            }
        }

        // Command registers: one action, no argument, writes the trigger value.
        for (const register of registers) {
            if (!register.writeOnly || !actionSpecs[register.name + ".reset"])
                continue;
            this.homey.flow.getActionCard(register.name + ".reset")
                .registerRunListener(async (args) => {
                    this.log(`Flow: ${args.device.getName()} reset ${register.name}`);
                    await args.device.writeRegister(register, true); // throws (shown to the user) on failure
                });
        }

        this.registerAutofillFlow(this.homey.flow.getActionCard("set_numeric_value"),
            (reg) => reg.direction == Dir.Out && reg.scale! > 0 && !reg.noAction!,
            async (args: any) => this.writeNumeric(args.device, registerByName[args.register.id], args.value));

        this.registerAutofillFlow(this.homey.flow.getActionCard("enable_feature"),
            (reg) => reg.direction == Dir.Out && reg.bool! && !reg.writeOnly,
            async (args: any) => {
                const register = registerByName[args.register.id];
                this.log(`Flow: ${args.device.getName()} enable ${register.name}`);
                await args.device.writeRegister(register, true);
                await args.device.setValue(register, await args.device.readRegister(register));
            });

        this.registerAutofillFlow(this.homey.flow.getActionCard("disable_feature"),
            (reg) => reg.direction == Dir.Out && reg.bool! && !reg.writeOnly,
            async (args: any) => {
                const register = registerByName[args.register.id];
                this.log(`Flow: ${args.device.getName()} disable ${register.name}`);
                await args.device.writeRegister(register, false);
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
            (reg) => reg.bool! && !reg.writeOnly,
            (args: any) => args.device.hasCapability(args.register.id) && args.device.getCapabilityValue(args.register.id));

        // Device trigger cards: Homey already scopes trigger() to the firing device, so the
        // run listener only has to match the register (and value) carried in the state.
        this.registerAutofillFlow(this.homey.flow.getDeviceTriggerCard("capability_changed"),
            (reg) => reg.enum != undefined,
            (args: any, state: any) => args.register.id === state.register.id);

        this.registerAutofillFlow(this.homey.flow.getDeviceTriggerCard("capability_turned_on"),
            (reg) => reg.bool! && !reg.writeOnly,
            (args: any, state: any) => args.register.id === state.register.id && state.value);

        this.registerAutofillFlow(this.homey.flow.getDeviceTriggerCard("capability_turned_off"),
            (reg) => reg.bool! && !reg.writeOnly,
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
            // The energy group carries no registers — its two capabilities are derived by
            // the connection's allocator — so describe them here to make it togglable like
            // any other group.
            registers: id === 'energy'
                ? this.energyGroupEntries(role, language)
                : registers
                    .filter((register) => register.group === id
                        && (!register.role || register.role === role)
                        && isSelectableRegister(register))
                    .map((register) => ({
                        name: register.name,
                        title: title(register.name),
                        adjustable: isAdjustable(register),
                        description: (register.info as any)[language] || register.info.en
                    }))
        }));
    }

    // Title of a derived energy capability for a role, in the app's language.
    private energyCapabilityTitle(role: Role, name: string, lang: 'en' | 'sv'): string {
        const title = name === METER_CAPABILITY ? energyTitle(role) : powerTitle(role);
        return title[lang] || title.en;
    }

    // Compose title for a capability, in the app's language.
    private capabilityTitle(name: string, language: string): string {
        const option: any = (capabilitiesOptions as any)[name];
        return option?.title?.[language] || option?.title?.en || name;
    }

    // Rolling-COP display title per role (matches device.ts extraOptions).
    private copDisplayTitle(role: Role | undefined, lang: 'en' | 'sv'): string {
        const titles: Record<string, {en: string; sv: string}> = {
            main: {en: "Total COP (30-day)", sv: "Total COP (30 dagar)"},
            heating: {en: "Heating COP (30-day)", sv: "Värme COP (30 dagar)"},
            hotwater: {en: "Hot water COP (30-day)", sv: "Varmvatten COP (30 dagar)"},
            pool: {en: "Pool COP (30-day)", sv: "Pool COP (30 dagar)"},
            cooling: {en: "Cooling COP (30-day)", sv: "Kyla COP (30 dagar)"}
        };
        const t = titles[role ?? 'heating'] ?? {en: "COP (30-day)", sv: "COP (30 dagar)"};
        return t[lang] || t.en;
    }

    // Everything shown under the Energy group for a role: the production/consumption or
    // produced-energy registers pinned to this device, the derived allocator pair (used +
    // live power, function devices only), and the rolling COP. `samples`, when given (the
    // pairing picker), sets `detected` from live data. The derived pair and COP have no
    // register of their own, so they inherit the group's data presence: detected only when
    // this role actually read some energy data — otherwise a device without that function
    // (e.g. Pool on a pump with no pool) would show its energy sub-items as "detected".
    private energyGroupEntries(role: Role | undefined, language: string,
                               samples?: Record<string, RegisterSample>) {
        const lang = language as 'en' | 'sv';
        const entries: {name: string; title: string; adjustable: boolean;
                        description: string; detected: boolean}[] = [];
        for (const register of registers) {
            if (register.group !== 'energy' || !isSelectableRegister(register))
                continue;
            if (register.role && register.role !== role)
                continue;
            entries.push({
                name: register.name,
                title: this.capabilityTitle(register.name, language),
                adjustable: isAdjustable(register),
                description: (register.info as any)[language] || register.info.en,
                detected: samples ? (samples[register.name]?.read ?? false) : true
            });
        }
        // Derived pair + COP inherit whether any real energy register for this role read.
        const hasEnergyData = samples ? entries.some((e) => e.detected) : true;
        if (role && role !== 'solar') {
            const isMain = role === 'main';
            const descriptions: Record<string, RegisterInfo> = {
                [METER_CAPABILITY]: isMain ? {
                    en: "Electricity used while the pump is idle, since the device was added",
                    sv: "El som används när pumpen går på tomgång, sedan enheten lades till"
                } : {
                    en: "Electricity this function has used since the device was added (Homey Energy tab)",
                    sv: "El denna funktion använt sedan enheten lades till (Homeys energiflik)"
                },
                [ACTIVE_POWER_CAPABILITY]: isMain ? {
                    en: "Power the pump is drawing right now while idle",
                    sv: "Effekt pumpen drar just nu på tomgång"
                } : {
                    en: "Power the pump is drawing right now, when this function is the active one",
                    sv: "Effekt pumpen drar just nu, när denna funktion är den aktiva"
                }
            };
            for (const name of ENERGY_CAPABILITIES)
                entries.push({
                    name,
                    title: this.energyCapabilityTitle(role, name, lang),
                    adjustable: false,
                    description: descriptions[name][lang] || descriptions[name].en,
                    detected: hasEnergyData
                });
        }
        entries.push({
            name: role === 'main' ? TOTAL_COP_CAPABILITY : FUNCTION_COP_CAPABILITY,
            title: this.copDisplayTitle(role, lang),
            adjustable: false,
            description: lang === 'sv'
                ? "Verkningsgrad (COP) senaste 30 dagarna: levererad energi delat med använd"
                : "Efficiency (COP) over the last 30 days: delivered energy divided by energy used",
            detected: hasEnergyData
        });
        return entries;
    }

    // Build the {groups, overrides} selection from what the features view sends,
    // only keeping overrides that differ from their group's setting.
    private static cleanSelection(raw: any): Selection {
        const groups: Selection["groups"] = {};
        for (const id of groupIds)
            groups[id] = !!raw?.groups?.[id];
        const overrides: Selection["overrides"] = {};
        const keep = (name: string, group: GroupId) => {
            const override = raw?.overrides?.[name];
            if (typeof override === "boolean" && override !== groups[group])
                overrides[name] = override;
        };
        for (const register of registers) {
            if (register.group === "core")
                continue; // core registers are always enabled
            keep(register.name, register.group);
        }
        // The energy capabilities aren't registers, but the features view renders a
        // checkbox per capability for them too — honour those the same way.
        for (const name of ENERGY_CAPABILITIES)
            keep(name, "energy");
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
            // Only the primary of a picker/sensor pair carries an override — the picker
            // resolves through it (see isRegisterEnabled), so writing both would be noise.
            if (register.group !== 'core'
                && isSelectableRegister(register)
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
        // Options for every energy capability the role could carry, not just the
        // currently selected ones, so one enabled later via repair still gets its title.
        if (functionRoles.includes(role) || role === 'main')
            for (const extra of ENERGY_CAPABILITIES)
                options[extra] = this.extraOption(role, extra);
        return {
            name: roleNames[role][language as 'en' | 'sv'] || roleNames[role].en,
            class: roleClass[role],
            data: {id: `${ip}#${role}`, role},
            settings: {address: ip},
            store: {selection},
            icon: `/${role}.svg`,
            capabilities: [...roleRegs.map((r) => r.name), ...extraCapabilities(role, selection)],
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

    // The feature groups shown (and toggled) under a device in the picker's expand.
    // Only core is fixed (always included); everything else — Energy included — defaults
    // to whatever detection recommended and can be toggled by the user. Energy carries no
    // registers, so its capabilities are filled in from the derived pair.
    private candidateGroups(role: Role, recommendations: Recommendations, samples: Record<string, RegisterSample>) {
        const lang = this.homey.i18n.getLanguage() as 'en' | 'sv';
        const capsFor = (id: GroupId) => id === 'energy'
            ? this.energyGroupEntries(role, lang, samples)
                .map((entry) => ({name: entry.name, title: entry.title, detected: entry.detected}))
            : registers
                .filter((register) => register.group === id
                    && (!register.role || register.role === role)
                    && isSelectableRegister(register))
                .map((register) => ({
                    name: register.name,
                    title: this.regToAutofill(register).name,
                    detected: samples[register.name]?.read ?? false
                }));
        return (roleGroups[role] as GroupId[])
            .map((id) => ({
                id,
                name: id === 'core'
                    ? (this.homey.__('groups.core') || 'Core')
                    : (this.homey.__(`groups.${id}`) || id),
                fixed: id === 'core',
                selected: id === 'core' ? true : !!(recommendations[id] ? recommendations[id]!.recommended : true),
                caps: capsFor(id)
            }))
            .filter((group) => group.caps.length > 0);
    }

    // All candidate devices for the picker: main plus every function device, each
    // flagged with whether detection saw live data for it (so the view can highlight
    // and pre-check them while still letting the user add any). Roles already paired
    // for this pump are omitted, so re-running pairing only offers the missing ones.
    private pairingCandidates(ip: string, detection: DetectionResult | null) {
        const recommendations = detection?.recommendations ?? {};
        const samples = detection?.samples ?? {};
        const paired = new Set(this.getDevices().map((device) => String(device.getData().id)));
        return allRoles
            .filter((role) => !paired.has(`${ip}#${role}`))
            .map((role) => ({
                role,
                name: roleNames[role][this.homey.i18n.getLanguage() as 'en' | 'sv'] || roleNames[role].en,
                description: this.roleDescription(role),
                // A device is "present" based on its function-specific groups only. `energy`
                // is universal (every pump has the meters, which move), so it must NOT count
                // toward per-device detection — otherwise Pool/Cooling pre-check on pumps
                // without that hardware just because the energy group is recommended.
                detected: role === 'main'
                    ? true
                    : (roleGroups[role] as GroupId[])
                        .some((group) => group !== 'core' && group !== 'energy'
                            && recommendations[group]?.recommended),
                device: this.deviceTemplate(ip, role, recommendations, samples),
                // Feature groups for the "click to expand" section (see candidateGroups).
                groups: this.candidateGroups(role, recommendations, samples)
            }));
    }

    async onPair(session: PairSession): Promise<void> {
        this.log('onPair: pairing session started');
        let ipAddress: string | null = null;
        let detection: DetectionResult | null = null;
        let detectionRunning: Promise<DetectionResult> | null = null;

        session.setHandler('discover', async () => {
            const localAddress = await this.homey.cloud.getLocalAddress();
            const pairedAddresses = this.getDevices().map((device) => String(device.getSettings().address));
            this.log(`onPair discover: scanning subnet from ${localAddress}, skipping ${pairedAddresses.length} paired IP(s)`);
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
            this.log(`onPair discover: found ${pumps.length} pump(s):`, JSON.stringify(pumps));
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

        // Detection takes longer than Homey's ~30s pairing RPC timeout (5 passes with 6s
        // gaps, plus a read of every register per pass), so this handler only *starts* the
        // probe and returns immediately; completion is reported with detection_done /
        // detection_failed events. Awaiting the probe here instead made the view fail with
        // a spurious "Timeout after 30000ms" while the probe was still running, and only
        // appeared to work on retry because that re-awaited the already-resolved promise.
        session.setHandler('start_detection', async () => {
            if (detection) {
                session.emit('detection_done', {}).catch(() => {});
                return true;
            }
            if (detectionRunning)
                return true;
            const onProgress = (pass: number, passes: number) =>
                session.emit('detection_progress', {pass, passes}).catch(() => {});
            // If a device for this IP already holds the single allowed connection
            // (e.g. adding another logical device later), probe over it — opening a
            // second socket would be refused by the pump.
            const live = existingConnection(ipAddress!);
            const viaLive = !!(live && live.isConnected());
            this.log(`onPair detection: starting for ${ipAddress} via `
                + `${viaLive ? 'existing live connection' : 'new probe socket'} `
                + `(${registers.length} registers × ${PROBE_PASSES} passes)`);
            detectionRunning = viaLive
                ? live!.probe(onProgress)
                : probeHost(ipAddress!, onProgress);
            detectionRunning
                .then((result) => {
                    detection = result;
                    const read = Object.values(result.samples).filter((s) => s.read).length;
                    this.log(`onPair detection done: ${read}/${registers.length} registers responded — `
                        + this.recommendationSummary(result.recommendations));
                    session.emit('detection_done', {}).catch(() => {});
                })
                .catch((error) => {
                    detectionRunning = null; // allow the view's retry button to try again
                    this.error('onPair detection failed', error);
                    session.emit('detection_failed',
                        {message: error?.message ?? String(error)}).catch(() => {});
                });
            return true;
        });

        session.setHandler('get_detection', async () => detection);

        // The device-picker view renders these and calls Homey.createDevice() for the
        // ones the user keeps checked.
        session.setHandler('get_pairing_devices', async () => {
            const candidates = this.pairingCandidates(ipAddress!, detection);
            this.log(`onPair get_pairing_devices: offering ${candidates.length} device(s) —`,
                candidates.map((c) => `${c.role}${c.detected ? '*' : ''}`).join(', '),
                detection ? '' : '(detection skipped → all enabled)');
            return candidates;
        });
    }

    async onRepair(session: PairSession, device: any): Promise<void> {
        const role = roleOf(device.getData());
        this.log(`onRepair: started for role ${role} —`,
            JSON.stringify(device.getStoreValue('selection') ?? null));
        let detection: DetectionResult | null = null;
        let detectionRunning: Promise<DetectionResult> | null = null;

        session.setHandler('get_context', async () => ({
            mode: 'repair',
            groups: this.groupInfo(role),
            selection: (device.getStoreValue('selection') ?? null) as Selection | null
        }));

        // Starts the probe and returns immediately; see the pairing handler for why the
        // result comes back as an event rather than this call's return value.
        session.setHandler('start_detection', async () => {
            if (detection) {
                session.emit('detection_done', {}).catch(() => {});
                return true;
            }
            if (detectionRunning)
                return true;
            detectionRunning = device.probeForDetection((pass: number, passes: number) =>
                session.emit('detection_progress', {pass, passes}).catch(() => {}));
            detectionRunning!
                .then((result: DetectionResult) => {
                    detection = result;
                    const read = Object.values(result.samples).filter((s) => s.read).length;
                    this.log(`onRepair detection done: ${read} registers responded — `
                        + this.recommendationSummary(result.recommendations));
                    session.emit('detection_done', {}).catch(() => {});
                })
                .catch((error: any) => {
                    detectionRunning = null; // allow the view's retry button to try again
                    this.error('onRepair detection failed', error);
                    session.emit('detection_failed',
                        {message: error?.message ?? String(error)}).catch(() => {});
                });
            return true;
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
