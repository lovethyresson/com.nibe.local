import {Driver, FlowCard} from 'homey';
import PairSession from "homey/lib/PairSession";
import net from "net";
import {
    Dir, GroupId, Register, RegisterInfo, Selection,
    groupIds, isAdjustable, isSelectableRegister, signedValue
} from './registers';
import {
    ACTIVE_POWER_CAPABILITY, ENERGY_CAPABILITIES, FUNCTION_COP_CAPABILITY, METER_CAPABILITY,
    Role, TOTAL_COP_CAPABILITY, allRoles, energyTitle, extraCapabilities, extraCapabilityOptions,
    functionRoles, powerTitle, registersForRole, roleClass, roleGroups, roleNames, roleOf, roleRegisters
} from './roles';
import type {ModelProfile} from './profile';
import {DetectionResult, PROBE_PASSES, Recommendations, RegisterSample, probeHost} from './detection';
import {Transport, destroyAllConnections, existingConnection} from './connection';
import {DiscoveryOptions, discoverPumps} from './discovery';

// Optional per-device transport entered during F pairing (the gateway port / unit id).
interface PairTransport {port?: number; unitId?: number}

// Generic pump driver. All model-specific data (register table, role config, transport,
// compose files, detection heuristics) comes from the concrete subclass's `profile`.
export abstract class NibePumpDriver extends Driver {
    abstract profile: ModelProfile;

    private actionSpecs: {[name: string]: any} = {};
    private conditionSpecs: {[name: string]: any} = {};

    // Verbose logging, off unless one of this driver's devices has "Debug logging" enabled
    // (Advanced settings). Pairing/repair, Flow actions and manual changes always log.
    protected debugEnabled(): boolean {
        return (this.getDevices() as any[]).some((device) => device.getSettings?.().debugLogging);
    }

    protected debug(...args: any[]) {
        if (this.debugEnabled())
            this.log(...args);
    }

    async onInit() {
        this.actionSpecs = Object.fromEntries(this.profile.compose.actions.map((a: any) => [a.id, a]));
        this.conditionSpecs = Object.fromEntries(this.profile.compose.conditions.map((c: any) => [c.id, c]));
        this.debug(`Driver initialised — app v${(this.homey.manifest as any).version}, `
            + `${this.profile.registers.length} registers, ${this.getDevices().length} paired device(s)`);
        this.checkConfig();
        this.registerFlows();
    }

    private recommendationSummary(recs: Recommendations): string {
        return groupIds
            .map((id) => recs[id] ? `${id}:${recs[id]!.evidence}${recs[id]!.recommended ? '(rec)' : ''}` : null)
            .filter(Boolean)
            .join(' ') || '(none)';
    }

    async onUninit() {
        destroyAllConnections();
    }

    private options(name: string): any {
        return (this.profile.compose.capabilitiesOptions as any)[name];
    }

    // The compose capabilities list is the superset of everything any device can have.
    private checkConfig() {
        const {capabilities} = this.profile.compose;
        for (const register of this.profile.registers) {
            if (!capabilities.includes(register.name))
                this.debug(`Config mismatch: register ${register.name} missing from driver.compose.json capabilities`);
            if (!this.options(register.name))
                this.debug(`No options for ${register.name}`);
        }
        for (const card of [...this.profile.compose.triggers, ...this.profile.compose.actions,
                            ...this.profile.compose.conditions] as any[]) {
            const hint = card.hint;
            if (!hint?.en || !hint?.sv)
                this.debug(`Flow card ${card.id} is missing a${hint?.en ? ' Swedish' : ''} hint`);
        }
        for (const register of this.profile.registers) {
            if (!isAdjustable(register) || register.enum || register.bool || register.picker)
                continue;
            if (!this.actionSpecs[`${register.name}.set`])
                this.debug(`No dedicated "set" flow card for writable register ${register.name}`);
        }
        // Writable on/off registers should each have a dedicated ".onoff" card.
        for (const register of this.profile.registers) {
            if (register.direction !== Dir.Out || !register.bool || register.writeOnly)
                continue;
            if (!this.actionSpecs[`${register.name}.onoff`])
                this.debug(`No dedicated "onoff" flow card for writable on/off register ${register.name}`);
        }
    }

    private regToAutofill = (register: Register) => {
        const option: any = this.options(register.name);
        const language = this.homey.i18n.getLanguage();
        return {
            id: register.name,
            name: option?.title?.[language] || option?.title?.en || register.name
        };
    };

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

    private async writeNumeric(device: any, register: Register, value: number) {
        this.log(`Flow: ${device.getName()} set ${register.name} = ${value}`);
        if (value < register.min! || value > register.max!)
            throw new Error("The value " + value + " is out of range. Value should be between " +
                register.min + " and " + register.max + ".");
        await device.writeRegister(register, value);
        const newValue = await device.readRegister(register);
        if (newValue !== value)
            throw new Error("Failed setting " + value + ", got back value " + newValue);
        await device.setValue(register, newValue);
    }

    private registerFlows() {
        for (const register of this.profile.registers) {
            if (!register.enum)
                continue;
            const enumOptions = async (query: string) =>
                Object.entries(register.enum as any).map((parts: any) => ({
                    id: parts[1],
                    name: this.homey.__(parts[1]) || parts[1]
                })).filter((result: any) => result.name.toLowerCase().includes(query.toLowerCase()));

            if (this.actionSpecs[register.name + ".enum"]) {
                this.homey.flow.getActionCard(register.name + ".enum")
                    .registerArgumentAutocompleteListener("mode", async (query) => enumOptions(query))
                    .registerRunListener(async (args) => {
                        this.log(`Flow: ${args.device.getName()} set ${register.name} = ${args.mode.name}`);
                        await args.device.writeRegister(register, args.mode.id);
                        await args.device.setValue(register, args.mode.id);
                    });
            }
            if (this.conditionSpecs[register.name + ".enum"]) {
                this.homey.flow.getConditionCard(register.name + ".enum")
                    .registerArgumentAutocompleteListener("mode", async (query) => enumOptions(query))
                    .registerRunListener(async (args) =>
                        args.device.hasCapability(register.name)
                        && args.device.getCapabilityValue(register.name) === args.mode.name);
            }
        }

        for (const register of this.profile.registers) {
            if (!isAdjustable(register) || !(register.scale! > 0))
                continue;
            if (this.actionSpecs[register.name + ".set"]) {
                this.homey.flow.getActionCard(register.name + ".set")
                    .registerRunListener(async (args) => this.writeNumeric(args.device, register, args.value));
            }
        }

        for (const register of this.profile.registers) {
            if (!register.writeOnly || !this.actionSpecs[register.name + ".reset"])
                continue;
            this.homey.flow.getActionCard(register.name + ".reset")
                .registerRunListener(async (args) => {
                    this.log(`Flow: ${args.device.getName()} reset ${register.name}`);
                    await args.device.writeRegister(register, true);
                });
        }

        // Dedicated per-register on/off cards ("More hot water – On/Off"), a named counterpart
        // to the generic enable/disable-feature cards, matching the dedicated numeric ".set"
        // cards. The `state` dropdown carries id "on"/"off".
        for (const register of this.profile.registers) {
            if (register.direction !== Dir.Out || !register.bool || register.writeOnly)
                continue;
            if (!this.actionSpecs[register.name + ".onoff"])
                continue;
            this.homey.flow.getActionCard(register.name + ".onoff")
                .registerRunListener(async (args) => {
                    const on = (args.state?.id ?? args.state) === 'on';
                    this.log(`Flow: ${args.device.getName()} set ${register.name} = ${on}`);
                    await args.device.writeRegister(register, on);
                    await args.device.setValue(register, await args.device.readRegister(register));
                });
        }

        this.registerAutofillFlow(this.homey.flow.getActionCard("set_numeric_value"),
            (reg) => reg.direction == Dir.Out && reg.scale! > 0 && !reg.noAction!,
            async (args: any) => this.writeNumeric(args.device, this.profile.registerByName[args.register.id], args.value));

        this.registerAutofillFlow(this.homey.flow.getActionCard("enable_feature"),
            (reg) => reg.direction == Dir.Out && reg.bool! && !reg.writeOnly,
            async (args: any) => {
                const register = this.profile.registerByName[args.register.id];
                this.log(`Flow: ${args.device.getName()} enable ${register.name}`);
                await args.device.writeRegister(register, true);
                await args.device.setValue(register, await args.device.readRegister(register));
            });

        this.registerAutofillFlow(this.homey.flow.getActionCard("disable_feature"),
            (reg) => reg.direction == Dir.Out && reg.bool! && !reg.writeOnly,
            async (args: any) => {
                const register = this.profile.registerByName[args.register.id];
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

    private groupInfo(role?: Role) {
        const language = this.homey.i18n.getLanguage();
        const title = (name: string) => {
            const option: any = this.options(name);
            return option?.title?.[language] || option?.title?.en || name;
        };
        const ids = role
            ? groupIds.filter((id) => (roleGroups[role] as GroupId[]).includes(id))
            : groupIds;
        return ids.map((id) => ({
            id,
            name: this.homey.__(`groups.${id}`) || id,
            registers: id === 'energy'
                ? this.energyGroupEntries(role, language)
                : this.profile.registers
                    .filter((register) => register.group === id
                        && (!register.role || register.role === role)
                        && isSelectableRegister(register, this.profile.pickerPrimary))
                    .map((register) => ({
                        name: register.name,
                        title: title(register.name),
                        adjustable: isAdjustable(register),
                        description: (register.info as any)[language] || register.info.en
                    }))
        }));
    }

    private energyCapabilityTitle(role: Role, name: string, lang: 'en' | 'sv'): string {
        const title = name === METER_CAPABILITY ? energyTitle(role) : powerTitle(role);
        return title[lang] || title.en;
    }

    private capabilityTitle(name: string, language: string): string {
        const option: any = this.options(name);
        return option?.title?.[language] || option?.title?.en || name;
    }

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

    private energyGroupEntries(role: Role | undefined, language: string,
                               samples?: Record<string, RegisterSample>) {
        const lang = language as 'en' | 'sv';
        const entries: {name: string; title: string; adjustable: boolean;
                        description: string; detected: boolean}[] = [];
        for (const register of this.profile.registers) {
            if (register.group !== 'energy' || !isSelectableRegister(register, this.profile.pickerPrimary))
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

    private cleanSelection(raw: any): Selection {
        const groups: Selection["groups"] = {};
        for (const id of groupIds)
            groups[id] = !!raw?.groups?.[id];
        const overrides: Selection["overrides"] = {};
        const keep = (name: string, group: GroupId) => {
            const override = raw?.overrides?.[name];
            if (typeof override === "boolean" && override !== groups[group])
                overrides[name] = override;
        };
        for (const register of this.profile.registers) {
            if (register.group === "core")
                continue;
            keep(register.name, register.group);
        }
        for (const name of ENERGY_CAPABILITIES)
            keep(name, "energy");
        return {groups, overrides};
    }

    private static roleSelection(role: Role, recommendations: Recommendations): Selection {
        const groups: Selection["groups"] = {};
        for (const id of groupIds)
            if ((roleGroups[role] as GroupId[]).includes(id))
                groups[id] = recommendations[id] ? !!recommendations[id]!.recommended : true;
        return {groups, overrides: {}};
    }

    private deviceTemplate(ip: string, role: Role, recommendations: Recommendations,
                           samples: Record<string, RegisterSample>, transport?: PairTransport) {
        const language = this.homey.i18n.getLanguage();
        const selection = NibePumpDriver.roleSelection(role, recommendations);
        for (const register of roleRegisters(this.profile, role)) {
            if (register.group !== 'core'
                && isSelectableRegister(register, this.profile.pickerPrimary)
                && selection.groups[register.group]
                && samples[register.name] && !samples[register.name].read)
                selection.overrides[register.name] = false;
        }
        const groupOrder = roleGroups[role] as GroupId[];
        const roleRegs = registersForRole(this.profile, role, selection)
            .sort((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group));
        const options: {[name: string]: any} = {};
        for (const register of roleRegisters(this.profile, role))
            if (this.options(register.name))
                options[register.name] = this.options(register.name);
        // Options for every extra capability the role could carry (energy pair, COP, main's
        // on/off) so each is created with its role-specific title — otherwise
        // getCapabilityOptions() throws "Invalid Capability" for the COP sensors on first init.
        for (const extra of extraCapabilities(this.profile, role, null)) {
            const opt = extraCapabilityOptions(role, extra);
            if (opt)
                options[extra] = opt;
        }
        // Only carry port/unit-id into the device settings when the model actually uses them
        // (F pairing entered them) — keeps S device settings unchanged (just {address}).
        const settings: {address: string; port?: number; unitId?: number} = {address: ip};
        if (transport?.port)
            settings.port = transport.port;
        if (transport?.unitId)
            settings.unitId = transport.unitId;
        // Homey uses the first onoff-family capability as the tile's on/off, so put this role's
        // designated primary on/off (its enable register, or Main's bare `onoff`) first.
        const caps = [...roleRegs.map((r) => r.name), ...extraCapabilities(this.profile, role, selection)];
        const primary = this.profile.role.primaryOnoff?.[role];
        const orderedCaps = primary && caps.includes(primary)
            ? [primary, ...caps.filter((name) => name !== primary)]
            : caps;
        return {
            name: roleNames[role][language as 'en' | 'sv'] || roleNames[role].en,
            class: roleClass[role],
            data: {id: `${ip}#${role}`, role},
            settings,
            store: {selection},
            icon: `/${role}.svg`,
            capabilities: orderedCaps,
            capabilitiesOptions: options
        };
    }

    private roleDescription(role: Role): string {
        if (role === 'main')
            return this.homey.__('pair.devices.main_desc');
        return (roleGroups[role] as GroupId[])
            .filter((group) => group !== 'core')
            .map((group) => this.homey.__(`groups.${group}`) || group)
            .join(', ');
    }

    private candidateGroups(role: Role, recommendations: Recommendations, samples: Record<string, RegisterSample>) {
        const lang = this.homey.i18n.getLanguage() as 'en' | 'sv';
        const capsFor = (id: GroupId) => id === 'energy'
            ? this.energyGroupEntries(role, lang, samples)
                .map((entry) => ({name: entry.name, title: entry.title, detected: entry.detected}))
            : this.profile.registers
                .filter((register) => register.group === id
                    && (!register.role || register.role === role)
                    && isSelectableRegister(register, this.profile.pickerPrimary))
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

    private pairingCandidates(ip: string, detection: DetectionResult | null, transport?: PairTransport) {
        const recommendations = detection?.recommendations ?? {};
        const samples = detection?.samples ?? {};
        const paired = new Set(this.getDevices().map((device) => String(device.getData().id)));
        return allRoles
            .filter((role) => !paired.has(`${ip}#${role}`))
            .map((role) => ({
                role,
                name: roleNames[role][this.homey.i18n.getLanguage() as 'en' | 'sv'] || roleNames[role].en,
                description: this.roleDescription(role),
                detected: role === 'main'
                    ? true
                    : (roleGroups[role] as GroupId[])
                        .some((group) => group !== 'core' && group !== 'energy'
                            && recommendations[group]?.recommended),
                device: this.deviceTemplate(ip, role, recommendations, samples, transport),
                groups: this.candidateGroups(role, recommendations, samples)
            }));
    }

    // Discovery transport/probe for this model: sweep the profile's default port, verify with
    // the profile's probe register (offset applied).
    private discoveryOptions(port?: number): DiscoveryOptions {
        const probe = this.profile.detection.discoveryProbe;
        return {
            port: port || this.profile.transport.port,
            unitId: this.profile.transport.unitId,
            probeAddress: this.profile.addressBase ? probe.address - this.profile.addressBase : probe.address,
            scale: probe.scale,
            min: probe.min,
            max: probe.max
        };
    }

    private pairingTransport(transport?: PairTransport): Transport {
        return {
            port: transport?.port || this.profile.transport.port,
            unitId: transport?.unitId || this.profile.transport.unitId
        };
    }

    async onPair(session: PairSession): Promise<void> {
        this.log('onPair: pairing session started');
        let ipAddress: string | null = null;
        let pairTransport: PairTransport = {};
        let detection: DetectionResult | null = null;
        let detectionRunning: Promise<DetectionResult> | null = null;

        session.setHandler('discover', async () => {
            const localAddress = await this.homey.cloud.getLocalAddress();
            const pairedAddresses = this.getDevices().map((device) => String(device.getSettings().address));
            this.log(`onPair discover: scanning subnet from ${localAddress}, skipping ${pairedAddresses.length} paired IP(s)`);
            const probe = this.profile.detection.discoveryProbe;
            const found = await discoverPumps(localAddress, new Set(pairedAddresses),
                this.discoveryOptions(pairTransport.port), (done, total) =>
                    session.emit('discovery_progress', {done, total}).catch(() => {}));
            const byAddress = new Map(found.map((pump) => [pump.address, pump]));
            for (const address of new Set(pairedAddresses)) {
                if (byAddress.has(address))
                    continue;
                const connection = existingConnection(address);
                if (!connection?.isConnected())
                    continue;
                const raw = await connection.readRegisterRaw({address: probe.address, direction: Dir.In} as Register);
                byAddress.set(address, {
                    address,
                    outdoorTemperature: raw === undefined ? undefined : signedValue(raw) / probe.scale
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
            // F pairing may supply a gateway port / unit id alongside the IP.
            pairTransport = {
                port: data.port ? Number(data.port) : undefined,
                unitId: data.unitId ? Number(data.unitId) : undefined
            };
            return true;
        });

        session.setHandler('get_context', async () => ({mode: 'pair'}));

        session.setHandler('start_detection', async () => {
            if (detection) {
                session.emit('detection_done', {}).catch(() => {});
                return true;
            }
            if (detectionRunning)
                return true;
            const onProgress = (pass: number, passes: number) =>
                session.emit('detection_progress', {pass, passes}).catch(() => {});
            const live = existingConnection(ipAddress!);
            const viaLive = !!(live && live.isConnected());
            this.log(`onPair detection: starting for ${ipAddress} via `
                + `${viaLive ? 'existing live connection' : 'new probe socket'} `
                + `(${this.profile.registers.length} registers × ${PROBE_PASSES} passes)`);
            detectionRunning = viaLive
                ? live!.probe(onProgress)
                : probeHost(this.profile, ipAddress!, this.pairingTransport(pairTransport), onProgress);
            detectionRunning
                .then((result) => {
                    detection = result;
                    const read = Object.values(result.samples).filter((s) => s.read).length;
                    this.log(`onPair detection done: ${read}/${this.profile.registers.length} registers responded — `
                        + this.recommendationSummary(result.recommendations));
                    session.emit('detection_done', {}).catch(() => {});
                })
                .catch((error) => {
                    detectionRunning = null;
                    this.error('onPair detection failed', error);
                    session.emit('detection_failed',
                        {message: error?.message ?? String(error)}).catch(() => {});
                });
            return true;
        });

        session.setHandler('get_detection', async () => detection);

        session.setHandler('get_pairing_devices', async () => {
            const candidates = this.pairingCandidates(ipAddress!, detection, pairTransport);
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
                    detectionRunning = null;
                    this.error('onRepair detection failed', error);
                    session.emit('detection_failed',
                        {message: error?.message ?? String(error)}).catch(() => {});
                });
            return true;
        });

        session.setHandler('get_detection', async () => detection);

        session.setHandler('selection_done', async (raw) => {
            const selection = this.cleanSelection(raw);
            this.log('onRepair: selection:', JSON.stringify(selection));
            await device.applySelection(selection);
            return true;
        });
    }
}
