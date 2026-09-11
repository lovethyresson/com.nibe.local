import {averageSensors, cleanIndoorConfig, indoorInventory} from './indoor-sensors';
import {Driver, FlowCard} from 'homey';
import PairSession from "homey/lib/PairSession";
import net from "net";
import {
    Dir, GroupId, Register, RegisterInfo, Selection,
    enumRawValue, enumLabel, flowPredicates, groupIds, isAdjustable, isSelectableRegister, signedValue
} from './registers';
import {
    ACTIVE_POWER_CAPABILITY, ENERGY_CAPABILITIES, FUNCTION_COP_CAPABILITY,
    HOTWATER_VOLUME_CAPABILITY, METER_CAPABILITY, possibleExtraCapabilities,
    Role, TOTAL_COP_CAPABILITY, allRoles, energyTitle, extraCapabilities, extraCapabilityOptions,
    extraCapabilitySupport, functionRoles, powerTitle, registersForRole, roleClass, roleGroups,
    roleNames, roleOf, roleRegisters
} from './roles';
import type {ModelProfile} from './profile';
import {
    DetectionResult, PROBE_PASSES, Recommendations, RegisterSample, SourceChoices, probeHost
} from './detection';
import {Transport, destroyAllConnections, existingConnection} from './connection';
import {DiscoveryOptions, discoverPumps} from './discovery';
import {CONSENT_SETTING, InstallProfile, analyticsConsent, reportInstallProfile, setAnalyticsConsent, track} from './analytics';
import {DEFAULT_INLET_C, MAX_TANK_LITRES, MIN_TANK_LITRES, cleanTankChoice} from './hotwater';

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
        // The consent checkbox now lives in device settings, but it can still be answered from the
        // pairing view — including while pairing a second pump, long after these devices existed.
        // Without this their checkboxes would sit stale until the next restart, and a consent
        // control that shows the wrong state is worse than none.
        this.homey.settings.on('set', (key: string) => {
            if (key !== CONSENT_SETTING)
                return;
            const consent = analyticsConsent(this.homey);
            for (const device of this.getDevices() as any[])
                if (device.getSettings?.().analyticsConsent !== consent)
                    device.setSettings({analyticsConsent: consent}).catch((e: any) => this.error(e));
        });
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
            // Internal registers are engine infrastructure with no capability — nothing to
            // declare in the compose file, so they are not a config mismatch.
            if (register.internal)
                continue;
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

    // Wraps a Flow card's run listener so every card reports through one place. Applied at the
    // registration sites rather than card by card, so a card added later is instrumented by
    // construction rather than by remembering. A failed run is tracked too (`ok: false`) and then
    // rethrown untouched — an action that fails because the model lacks the register is exactly
    // the signal worth having, and swallowing the error to report it would be worse than useless.
    private tracked(kind: 'action' | 'condition', card: string, register: Register | null,
                    run: (args: any, state: any) => any) {
        const event = kind === 'action' ? 'Ran THEN Card' : 'Checked AND Card';
        // `role` answers "which function was this run on?" — heating, hotwater, cooling, main …
        // Every device this app creates carries an explicit `role` in its data (see
        // deviceTemplate), so this is exact for real devices. It is NOT routed through roleOf()'s
        // `?? "main"` default on a missing device, though: that default is right for the app (a
        // device without a role IS main) but would silently attribute any unreadable device to
        // Main here — inflating the exact number this property exists to measure. A card that
        // somehow arrives without a device reports 'unknown', which is visible in Amplitude.
        const describe = (args: any) => {
            const data = args?.device?.getData?.();
            return {
                card,
                register: register?.name ?? args?.register?.id,
                role: data ? roleOf(data) : 'unknown'
            };
        };
        return async (args: any, state: any) => {
            try {
                const result = await run(args, state);
                track(event, {
                    ...describe(args),
                    ok: true,
                    ...(kind === 'condition' ? {result: result === true} : {})
                });
                return result;
            } catch (error) {
                track(event, {...describe(args), ok: false});
                throw error;
            }
        };
    }

    // `kind` decides whether the run listener is instrumented. Trigger cards go through here too,
    // but their run listener is a *filter* that Homey calls for every Flow listening to the card —
    // tracking there would count Flow subscriptions, not trigger fires. Triggers are instrumented
    // once at the point they actually fire, in device.ts's checkTrigger.
    private registerAutofillFlow(flow: FlowCard, registerFilter: (reg: Register) => boolean,
                                 run: (args: any, state: any) => any,
                                 kind: 'action' | 'condition' | 'trigger' = 'action') {
        return flow
            .registerArgumentAutocompleteListener("register", async (query, args) =>
                (args.device.wantedRegisters() as Register[])
                    .filter(registerFilter)
                    .map(this.regToAutofill)
                    .filter((result: any) => result.name.toLowerCase().includes(query.toLowerCase())))
            .registerRunListener(kind === 'trigger'
                ? async (args, state) => run(args, state)
                : this.tracked(kind, flow.id, null, run));
    }

    // The install as a shape rather than a stream of events: pump model, which of the six function
    // devices exist, and which feature groups each carries. Sent as user properties so the
    // cross-sectional questions ("of the S1255 installs, how many run cooling?") are answerable.
    // Gathered from the devices themselves, so it is correct after pairing, repair or deletion.
    collectInstallProfile(): InstallProfile {
        const devices = this.getDevices() as any[];
        const featuresByFunction: Record<string, string[]> = {};
        let pumpModelCode: string | undefined;
        let firmware: string | undefined;

        for (const device of devices) {
            const role = roleOf(device.getData());
            const settings = device.getSettings?.() ?? {};
            pumpModelCode = pumpModelCode ?? settings.heatpump_type;
            firmware = firmware ?? settings.firmware;
            // A missing selection means everything enabled (the upgrade path and the
            // skip-detection default), so report the role's full group list rather than nothing.
            const selection = device.getStoreValue?.('selection') as Selection | null;
            featuresByFunction[role] = selection?.groups
                ? Object.entries(selection.groups).filter(([, on]) => on).map(([id]) => id)
                : [...roleGroups[role]];
        }

        return {
            pumpModelCode: pumpModelCode ? String(pumpModelCode) : undefined,
            firmware: firmware ? String(firmware) : undefined,
            // Deduplicated so `role_count` counts parts of the installation, not devices. The
            // shared taxonomy defines `roles` as a set, and homevolt — where one role really can
            // have two devices — builds it that way. One device per role is the norm here, so this
            // is a no-op in practice and an honest shape regardless.
            roles: [...new Set(devices.map((device) => roleOf(device.getData())))].sort(),
            featuresByFunction,
            ...this.hostFacts()
        };
    }

    // What the app is running on. Every one of these is synchronous and cannot throw, but they are
    // wrapped anyway: analytics must never be the reason a device fails to initialise.
    //
    // `platform` and `platformVersion` are documented as undefined on older Homey software, where
    // the SDK says to assume 'local' and 1 — so the defaults here are the documented ones, not a
    // guess. Reported raw rather than mapped to a product name ("Homey Pro Early 2023"): that
    // mapping belongs to Athom and would rot in this file.
    private hostFacts(): Partial<InstallProfile> {
        try {
            return {
                homeyVersion: this.homey.version,
                homeyPlatform: this.homey.platform ?? 'local',
                homeyPlatformVersion: this.homey.platformVersion ?? 1,
                timezone: this.homey.clock.getTimezone(),
                language: this.homey.i18n.getLanguage(),
                units: this.homey.i18n.getUnits()
            };
        } catch (error) {
            this.error('Could not read host facts for the install profile', error);
            return {};
        }
    }

    // Called whenever the shape may have changed: a device initialised, was deleted, was repaired,
    // or the pump finally answered with its model. Debounced inside reportInstallProfile().
    syncInstallProfile(): void {
        reportInstallProfile(this.collectInstallProfile());
    }

    // Consent and click reporting, shared by pairing and repair — both are PairSessions with
    // buttons worth counting. The views run inside Homey's app, not in this process, so they can
    // never reach the SDK themselves; every click they report arrives through here.
    private registerAnalyticsHandlers(session: PairSession) {
        session.setHandler('set_analytics_consent', async (consent: any) => {
            setAnalyticsConsent(this.homey, consent === true);
            this.log(`Analytics: consent ${consent === true ? 'granted' : 'declined'} during pairing`);
            return true;
        });

        session.setHandler('track_ui', async (data: any) => {
            track('Clicked Button', {
                view: String(data?.view ?? 'unknown'),
                button: String(data?.button ?? 'unknown')
            });
            return true;
        });
    }

    // Shared by the pairing and repair detection handlers: same measurement, different entry point.
    private trackDetection(mode: 'pair' | 'repair', result: DetectionResult) {
        const recommended = Object.entries(result.recommendations)
            .filter(([, rec]) => rec?.recommended)
            .map(([group]) => group);
        track('Completed Detection', {
            mode,
            registers_responded: Object.values(result.samples).filter((s) => s.read).length,
            registers_total: this.profile.registers.length,
            groups_recommended: recommended,
            // The point of detection is whether it works on models the maintainer cannot test.
            // A pass where nothing answered is the failure worth seeing, so name it explicitly
            // rather than leaving it to be inferred from a zero.
            found_nothing: recommended.length === 0
        });
    }

    // The failure counterpart, for a detection pass that rejected instead of returning. Without
    // this, the hardest failure there is — the probe never completing on a model the maintainer
    // cannot test — was the one thing that sent nothing at all, and in Amplitude it looked
    // identical to a detection the user never started. It is a `found_nothing` pass by definition.
    //
    // `registers_responded` and `groups_recommended` are absent rather than zero, on purpose: the
    // rejected promise carries no samples, so there is no count to report, and a zero here would
    // collide with a genuinely different measurement the success path above already makes — a pass
    // that *completed* and got no answers. `registers_total` is a static profile fact, known
    // whether or not the pass got anywhere. The error message itself is never sent: it is
    // unbounded free text, which is exactly what this taxonomy keeps out.
    private trackFailedDetection(mode: 'pair' | 'repair') {
        track('Completed Detection', {
            mode,
            registers_total: this.profile.registers.length,
            found_nothing: true
        });
    }

    private async writeNumeric(device: any, register: Register, value: number) {
        this.log(`Flow: ${device.getName()} set ${register.name} = ${value}`);
        await device.writeRegister(register, value);
    }

    private registerFlows() {
        for (const register of this.profile.registers) {
            if (!register.enum)
                continue;
            const enumOptions = async (query: string) =>
                Object.entries(register.enum as any).map((parts: any) => ({
                    id: parts[0],
                    name: this.homey.__(parts[1]) || parts[1]
                })).filter((result: any) => result.name.toLowerCase().includes(query.toLowerCase()));

            if (this.actionSpecs[register.name + ".enum"]) {
                this.homey.flow.getActionCard(register.name + ".enum")
                    .registerArgumentAutocompleteListener("mode", async (query) => enumOptions(query))
                    .registerRunListener(this.tracked('action', register.name + ".enum", register,
                        async (args: any) => {
                            this.log(`Flow: ${args.device.getName()} set ${register.name} = ${args.mode.name}`);
                            await args.device.writeRegister(register, args.mode.id);
                        }));
            }
            if (this.conditionSpecs[register.name + ".enum"]) {
                this.homey.flow.getConditionCard(register.name + ".enum")
                    .registerArgumentAutocompleteListener("mode", async (query) => enumOptions(query))
                    .registerRunListener(this.tracked('condition', register.name + ".enum", register,
                        async (args: any) => {
                            const raw = enumRawValue(register, args.mode.id);
                            const expected = register.picker ? String(raw)
                                : enumLabel(register, raw, (key) => this.homey.__(key));
                            return args.device.hasCapability(register.name)
                                && args.device.getCapabilityValue(register.name) === expected;
                        }));
            }
        }

        for (const register of this.profile.registers) {
            if (!isAdjustable(register) || !(register.scale! > 0))
                continue;
            if (this.actionSpecs[register.name + ".set"]) {
                this.homey.flow.getActionCard(register.name + ".set")
                    .registerRunListener(this.tracked('action', register.name + ".set", register,
                        async (args: any) => this.writeNumeric(args.device, register, args.value)));
            }
        }

        for (const register of this.profile.registers) {
            if (!register.writeOnly || !this.actionSpecs[register.name + ".reset"])
                continue;
            this.homey.flow.getActionCard(register.name + ".reset")
                .registerRunListener(this.tracked('action', register.name + ".reset", register,
                    async (args: any) => {
                        this.log(`Flow: ${args.device.getName()} reset ${register.name}`);
                        await args.device.writeRegister(register, true);
                    }));
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
                .registerRunListener(this.tracked('action', register.name + ".onoff", register,
                    async (args: any) => {
                        const on = (args.state?.id ?? args.state) === 'on';
                        this.log(`Flow: ${args.device.getName()} set ${register.name} = ${on}`);
                        await args.device.writeRegister(register, on);
                    }));
        }

        this.registerAutofillFlow(this.homey.flow.getActionCard("set_numeric_value"),
            flowPredicates.numericAction,
            async (args: any) => this.writeNumeric(args.device, this.profile.registerByName[args.register.id], args.value));

        // `noAction` excludes a register from every generic write card, not just the numeric one:
        // it marks a holding register the app reads for context but must never write. Without
        // that check the "Room sensor regulation active" flag — legacy on zone firmware, where
        // writing it does nothing useful — would be offered as something to switch.
        this.registerAutofillFlow(this.homey.flow.getActionCard("enable_feature"),
            flowPredicates.boolAction,
            async (args: any) => {
                const register = this.profile.registerByName[args.register.id];
                this.log(`Flow: ${args.device.getName()} enable ${register.name}`);
                await args.device.writeRegister(register, true);
            });

        this.registerAutofillFlow(this.homey.flow.getActionCard("disable_feature"),
            flowPredicates.boolAction,
            async (args: any) => {
                const register = this.profile.registerByName[args.register.id];
                this.log(`Flow: ${args.device.getName()} disable ${register.name}`);
                await args.device.writeRegister(register, false);
            });

        this.registerAutofillFlow(this.homey.flow.getConditionCard("numeric_value_comparison"),
            flowPredicates.numericCondition,
            (args: any) => {
                if (!args.device.hasCapability(args.register.id))
                    return false;
                const capabilityValue = args.device.getCapabilityValue(args.register.id);
                if (typeof capabilityValue !== 'number' || !Number.isFinite(capabilityValue))
                    return false;
                return args.comparison === "<" ? capabilityValue < args.value : capabilityValue > args.value;
            }, 'condition');

        this.registerAutofillFlow(this.homey.flow.getConditionCard("feature_enabled"),
            flowPredicates.boolState,
            (args: any) => args.device.hasCapability(args.register.id) && args.device.getCapabilityValue(args.register.id),
            'condition');

        this.registerAutofillFlow(this.homey.flow.getDeviceTriggerCard("capability_changed"),
            flowPredicates.enumTrigger,
            (args: any, state: any) => args.register.id === state.register.id, 'trigger');

        this.registerAutofillFlow(this.homey.flow.getDeviceTriggerCard("capability_turned_on"),
            flowPredicates.boolState,
            (args: any, state: any) => args.register.id === state.register.id && state.value, 'trigger');

        this.registerAutofillFlow(this.homey.flow.getDeviceTriggerCard("capability_turned_off"),
            flowPredicates.boolState,
            (args: any, state: any) => args.register.id === state.register.id && !state.value, 'trigger');

        // The litres estimate is derived rather than a register, so the generic autocomplete cards
        // above cannot see it (their predicates take a Register) and it gets two cards of its own.
        // Both are scoped by the compose file's $filter to devices that actually carry it.
        this.homey.flow.getConditionCard("hotwater_volume_below")
            .registerRunListener(async (args: any) => {
                const value = args.device.getCapabilityValue(HOTWATER_VOLUME_CAPABILITY);
                // Blank until the tank has been measured. False is the safe answer: a Flow that
                // waits for hot water to run low must not fire because we cannot see it yet.
                if (typeof value !== 'number')
                    return false;
                return value < args.litres;
            });

        // Fires on the downward crossing only. The device fires this whenever the estimate falls
        // at all, so the threshold test lives here — `previous` is the value before the drop, and
        // requiring it to have been at or above the limit is what stops every subsequent poll of a
        // still-falling tank re-triggering the same Flow.
        this.homey.flow.getDeviceTriggerCard("hotwater_volume_dropped_below")
            .registerRunListener(async (args: any, state: any) => {
                const crossed = state.previous >= args.litres && state.litres < args.litres;
                // Tracked here rather than at the device, so the event counts a Flow actually
                // firing rather than the estimate ticking down a litre — see fireHotwaterDropped.
                if (crossed)
                    track('Fired WHEN Card', {
                        card: 'hotwater_volume_dropped_below',
                        role: roleOf(args.device.getData())
                    });
                return crossed;
            });
    }

    // Capabilities this pump cannot populate, according to a fresh detection pass: registers
    // that did not answer, plus the derived energy/COP extras whose sources didn't.
    //
    // Pairing reaches the same conclusion server-side in deviceTemplate(). Repair cannot: its
    // checkboxes start from the device's *stored* selection, which was decided by an earlier
    // detection pass — so without this, a correction to detection could never reach a device
    // that already exists, and a capability wrongly added once stayed forever.
    private unsupportedCapabilities(role: Role, detection: DetectionResult): string[] {
        const names = roleRegisters(this.profile, role)
            .filter((register) => register.group !== 'core'
                && isSelectableRegister(register, this.profile.pickerPrimary)
                && detection.samples[register.name]
                && !detection.samples[register.name].read)
            .map((register) => register.name);
        const support = extraCapabilitySupport(this.profile, role,
            (name) => detection.samples[name]);
        for (const name of possibleExtraCapabilities(this.profile, role))
            if (support[name] === false)
                names.push(name);
        return names;
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
        const lang = language === 'sv' ? 'sv' : 'en';
        const entriesFor = (id: GroupId) => {
            if (id === 'energy')
                return this.energyGroupEntries(role, language);
            const entries = this.profile.registers
                .filter((register) => register.group === id
                    && (!register.role || register.role === role)
                    && isSelectableRegister(register, this.profile.pickerPrimary))
                .map((register) => ({
                    name: register.name,
                    title: title(register.name),
                    adjustable: isAdjustable(register),
                    description: (register.info as any)[language] || register.info.en
                }));
            // Derived, so it is in no register group — listed here so Repair can switch it off
            // like any other capability. Without a checkbox the override cleanSelection preserves
            // could never be set in the first place.
            if (id === 'hotwater' && role === 'hotwater' && this.profile.hotwaterTank)
                entries.push({
                    name: HOTWATER_VOLUME_CAPABILITY,
                    title: this.extraDisplayTitle(role, HOTWATER_VOLUME_CAPABILITY, lang),
                    adjustable: false,
                    description: lang === 'sv'
                        ? 'Liter 40-gradigt varmvatten kvar. Kräver vald beredare nedan.'
                        : 'Litres of 40 °C water left. Needs the tank you pick below.'
                });
            return entries;
        };
        return ids.map((id) => ({
            id,
            name: this.homey.__(`groups.${id}`) || id,
            registers: entriesFor(id)
        }));
    }

    // The localized title of any derived capability, from the single source both pairing and the
    // device runtime already use.
    private extraDisplayTitle(role: Role, name: string, lang: 'en' | 'sv'): string {
        const title = extraCapabilityOptions(role, name)?.title;
        return title?.[lang] || title?.en || name;
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
        // Each derived capability is gated on the registers *it* needs, not on the energy group
        // as a whole — see extraCapabilitySupport(). Without samples everything is assumed
        // supported, matching the rest of the no-detection path.
        const support = role
            ? extraCapabilitySupport(this.profile, role,
                (name) => (samples ? samples[name] : {read: true, moved: true}))
            : {};
        const supported = (name: string) => (samples ? (support[name] ?? false) : true);
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
                    detected: supported(name)
                });
        }
        const copName = role === 'main' ? TOTAL_COP_CAPABILITY : FUNCTION_COP_CAPABILITY;
        entries.push({
            name: copName,
            title: this.copDisplayTitle(role, lang),
            adjustable: false,
            description: lang === 'sv'
                ? "Verkningsgrad (COP) senaste 30 dagarna: levererad energi delat med använd"
                : "Efficiency (COP) over the last 30 days: delivered energy divided by energy used",
            detected: supported(copName)
        });
        return entries;
    }

    // The tank dropdown's contents for a role, or null when this role/model has no tank. The
    // catalogue is model data (ModelProfile.hotwaterTank) so the views render whatever a profile
    // offers and know nothing about NIBE's product line.
    //
    // "auto" leads and is the default: the app measures the tank from the pump's own energy
    // counter, so picking a size is an accelerant, never a requirement. That is what keeps the
    // pairing screen unable to fail on this field.
    private tankChoices(role: Role) {
        const catalogue = this.profile.hotwaterTank;
        if (role !== 'hotwater' || !catalogue)
            return null;
        const lang = this.homey.i18n.getLanguage() === 'sv' ? 'sv' : 'en';
        return {
            defaultInletC: DEFAULT_INLET_C,
            minLitres: MIN_TANK_LITRES,
            maxLitres: MAX_TANK_LITRES,
            tanks: catalogue.tanks.map((tank) => ({
                id: tank.id, litres: tank.litres, name: tank.name[lang] || tank.name.en
            }))
        };
    }

    // `addresses` is mostly detection's answer rather than the user's: which address a register
    // lives at is normally a fact about the pump, stamped in server-side, and a repair that
    // skipped detection passes the device's existing map through unchanged.
    //
    // The exception is a `sources` register, where several addresses carry plausible but
    // different values and only the user can say which one they mean. Those arrive in
    // `raw.sources` from the view and are layered on top, but only for registers that actually
    // declare sources and only for an address that register actually offers — the view is
    // untrusted input, and a bad address here would silently point polling at a wrong register.
    private cleanSelection(raw: any, addresses?: Record<string, number>): Selection {
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
        // The derived energy/COP capabilities are toggled like registers in the features view,
        // so their overrides have to survive the round trip too — otherwise repair silently
        // re-enables a COP the pump has no registers for.
        for (const name of [...ENERGY_CAPABILITIES, TOTAL_COP_CAPABILITY, FUNCTION_COP_CAPABILITY])
            keep(name, "energy");
        // The litres estimate rides the hotwater group, not energy — its sensors are hotwater
        // registers.
        keep(HOTWATER_VOLUME_CAPABILITY, "hotwater");
        const resolved: Record<string, number> = {...addresses};
        for (const register of this.profile.registers) {
            if (!register.sources?.length)
                continue;
            const chosen = Number(raw?.sources?.[register.name]);
            if (register.sources.some((source) => source.address === chosen))
                resolved[register.name] = chosen;
        }
        const selection: Selection = {groups, overrides};
        if (Object.keys(resolved).length)
            selection.addresses = resolved;
        const hotwater = this.cleanTankChoice(raw?.hotwater);
        if (hotwater)
            selection.hotwater = hotwater;
        return selection;
    }

    // The tank the user picked, validated against the model's own catalogue.
    //
    // THIS FUNCTION IS A WHITELIST, and that is the trap: everything it does not copy is thrown
    // away, because applySelection() overwrites the device's whole stored selection with what
    // comes back from here. Leaving the tank out would mean a Repair silently discarding a choice
    // made at pairing — the user would tick one box about cooling and lose their tank.
    //
    // An unrecognised id declines rather than being trusted: the view is untrusted input, and a
    // bogus litre figure would bias every estimate built on it. Declining is the safe answer
    // because there is no unattended alternative — deriving the volume from delivered energy was
    // tested against hardware and measured 436 L for a 176 L tank.
    private cleanTankChoice(raw: any): Selection["hotwater"] | undefined {
        const catalogue = this.profile.hotwaterTank;
        return catalogue ? cleanTankChoice(raw, catalogue.tanks) : undefined;
    }

    private static roleSelection(role: Role, recommendations: Recommendations): Selection {
        const groups: Selection["groups"] = {};
        for (const id of groupIds)
            if ((roleGroups[role] as GroupId[]).includes(id))
                groups[id] = recommendations[id] ? !!recommendations[id]!.recommended : true;
        return {groups, overrides: {}};
    }

    private deviceTemplate(ip: string, role: Role, recommendations: Recommendations,
                           samples: Record<string, RegisterSample>, transport?: PairTransport,
                           addresses: Record<string, number> = {}) {
        const language = this.homey.i18n.getLanguage();
        const selection = NibePumpDriver.roleSelection(role, recommendations);
        // Where detection found a register at one of its alternate addresses, record it on the
        // device so the runtime reads that address instead of the one in the table.
        if (Object.keys(addresses).length)
            selection.addresses = addresses;
        for (const register of roleRegisters(this.profile, role)) {
            if (register.group !== 'core'
                && isSelectableRegister(register, this.profile.pickerPrimary)
                && selection.groups[register.group]
                && samples[register.name] && !samples[register.name].read)
                selection.overrides[register.name] = false;
        }
        // Same rule for the derived energy/COP capabilities, which have no register of their
        // own: turn one off when the registers it is computed from didn't answer. Otherwise a
        // pump whose power source register is absent (S320/S325, S330/S332, S2125 have no
        // 2166) is paired carrying "Energy used", "Current power" and a COP that can never
        // hold a value. Re-running detection via repair re-enables them if that changes.
        if (Object.keys(samples).length) {
            const support = extraCapabilitySupport(this.profile, role, (name) => samples[name]);
            for (const name of possibleExtraCapabilities(this.profile, role))
                if (support[name] === false)
                    selection.overrides[name] = false;
        }
        // Group first, then the model's declared reading order within it. Anything the model does
        // not name keeps its table position, after everything named — so an unlisted register
        // lands at the end of its group rather than somewhere arbitrary.
        const groupOrder = roleGroups[role] as GroupId[];
        const declared = this.profile.role.displayOrder?.[role] ?? [];
        const rank = (name: string) => {
            const at = declared.indexOf(name);
            return at === -1 ? Number.MAX_SAFE_INTEGER : at;
        };
        const roleRegs = registersForRole(this.profile, role, selection)
            .sort((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group)
                || rank(a.name) - rank(b.name));
        const options: {[name: string]: any} = {};
        for (const register of roleRegisters(this.profile, role))
            if (this.options(register.name))
                options[register.name] = this.options(register.name);
        // Options for every extra capability the role could carry (energy pair, COP, main's
        // on/off) so each is created with its role-specific title — otherwise
        // getCapabilityOptions() throws "Invalid Capability" for the COP sensors on first init.
        for (const extra of possibleExtraCapabilities(this.profile, role)) {
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
        this.logCapabilityMapping(role, orderedCaps, selection, samples);
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

    // What each capability on the device about to be created is actually reading, and what was
    // left off and why. Most capabilities are one register and the name says so, but the
    // derived ones — the energy pair and the COP sensors — have no register at all, and that
    // is precisely where a pump that can't populate them looks identical to one that can.
    private logCapabilityMapping(role: Role, caps: string[], selection: Selection,
                                 samples: Record<string, RegisterSample>) {
        if (!this.debugEnabled())
            return;
        const detail = (name: string): string => {
            const register = this.profile.registerByName[name];
            if (register) {
                const probe = samples[name];
                const state = !probe ? 'not sampled'
                    : probe.read ? `read${probe.moved ? ', moved' : `, steady at ${probe.value ?? '?'}`}`
                        : 'NO READ';
                const kind = register.direction === Dir.In ? 'input' : 'holding';
                return `${kind} ${register.address} (${state})`;
            }
            // The derived ones: name the registers they are computed from, since that is what
            // determines whether they can ever hold a value.
            const {powerSources, totalProductionRegister, totalConsumptionRegister} = this.profile.role;
            const power = powerSources.flat().join(' | ') || 'none declared';
            if (name === METER_CAPABILITY || name === ACTIVE_POWER_CAPABILITY)
                return `derived by the energy allocator from power source ${power}`;
            if (name === TOTAL_COP_CAPABILITY)
                return `derived from ${totalProductionRegister} / ${totalConsumptionRegister}`;
            if (name === FUNCTION_COP_CAPABILITY)
                return `derived from ${this.profile.role.producedRegisterForRole[role]} `
                    + `and the allocator's used energy (power source ${power})`;
            return 'derived (no register)';
        };

        this.debug(`Pairing ${role}: ${caps.length} capabilities`);
        for (const name of caps)
            this.debug(`    ${name}  <-  ${detail(name)}`);
        const off = Object.entries(selection.overrides ?? {})
            .filter(([, enabled]) => !enabled)
            .map(([name]) => name);
        if (off.length)
            this.debug(`  left off (nothing read during detection): ${off.join(', ')}`);
        const groupsOff = Object.entries(selection.groups)
            .filter(([, on]) => !on).map(([id]) => id);
        if (groupsOff.length)
            this.debug(`  feature groups not selected: ${groupsOff.join(', ')}`);
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
        // The pairing picker rebuilds `device.capabilities` from these lists, so this — not
        // deviceTemplate — is what decides the order a paired device ends up storing, and a
        // device's stored order is what the Homey app renders. Ordering deviceTemplate alone did
        // nothing: the picker overwrote it every time.
        const declared = this.profile.role.displayOrder?.[role] ?? [];
        const rank = (name: string) => {
            const at = declared.indexOf(name);
            return at === -1 ? Number.MAX_SAFE_INTEGER : at;
        };
        const capsFor = (id: GroupId) => {
            if (id === 'energy')
                return this.energyGroupEntries(role, lang, samples)
                    .map((entry) => ({name: entry.name, title: entry.title, detected: entry.detected}));
            const caps = this.profile.registers
                .filter((register) => register.group === id
                    && (!register.role || register.role === role)
                    && isSelectableRegister(register, this.profile.pickerPrimary))
                .sort((a, b) => rank(a.name) - rank(b.name))
                .map((register) => ({
                    name: register.name,
                    title: this.regToAutofill(register).name,
                    detected: samples[register.name]?.read ?? false
                }));
            // The litres estimate is derived, so it is in no register group and the filter above
            // cannot find it — but the picker REBUILDS device.capabilities from these lists, so a
            // capability missing here is dropped at pairing (syncCapabilities re-adds it at init,
            // which works but leaves it stranded at the end of the tile). Appended for the same
            // reason energyGroupEntries exists for the COP sensors.
            if (id === 'hotwater' && role === 'hotwater' && this.profile.hotwaterTank)
                caps.push({
                    name: HOTWATER_VOLUME_CAPABILITY,
                    title: this.extraDisplayTitle(role, HOTWATER_VOLUME_CAPABILITY, lang),
                    detected: extraCapabilitySupport(
                        this.profile, role, (name) => samples[name])[HOTWATER_VOLUME_CAPABILITY]
                });
            return caps;
        };
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

    // The source choices belonging to one role, localised for the view. Each entry becomes a
    // radio group under that capability's row; a register whose candidates all read the same
    // thing never gets here, because detection only reports two or more live candidates.
    private choicesForRole(role: Role, choices: SourceChoices) {
        const language = this.homey.i18n.getLanguage() as 'en' | 'sv';
        const mine = new Set(roleRegisters(this.profile, role).map((register) => register.name));
        const entries: Record<string, {address: number; label: string; value?: number}[]> = {};
        for (const [name, sources] of Object.entries(choices)) {
            if (!mine.has(name))
                continue;
            entries[name] = sources.map((source) => ({
                address: source.address,
                label: source.label[language] || source.label.en,
                value: source.value
            }));
        }
        return entries;
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
                device: this.deviceTemplate(ip, role, recommendations, samples, transport,
                                            detection?.addresses ?? {}),
                groups: this.candidateGroups(role, recommendations, samples),
                // Only the choices for registers this role owns — the heating device asks which
                // sensor its indoor temperature comes from, and no other role should.
                choices: this.choicesForRole(role, detection?.choices ?? {}),
                // null for every role but hot water, which is how the view knows not to render
                // a tank picker on the pool device.
                tanks: this.tankChoices(role)
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

    private registerIndoorHandlers(session: PairSession, device?: any) {
        session.setHandler('get_indoor_sensors', async () => indoorInventory(this.homey));
        session.setHandler('validate_indoor_sensors', async (raw: any) => {
            const config = cleanIndoorConfig(raw);
            return {config, value: averageSensors(config, await indoorInventory(this.homey))};
        });
        if (device && roleOf(device.getData()) === 'heating') {
            session.setHandler('indoor_status', async () => device.indoorSetupStatus());
            session.setHandler('activate_indoor', async (raw: any) => device.activateIndoor(raw));
            session.setHandler('deactivate_indoor', async () => device.deactivateIndoor());
        }
    }

    async onPair(session: PairSession): Promise<void> {
        this.log('onPair: pairing session started');
        let ipAddress: string | null = null;
        let pairTransport: PairTransport = {};
        let detection: DetectionResult | null = null;
        let detectionRunning: Promise<DetectionResult> | null = null;
        let detectionAbort: AbortController | null = null;
        session.setHandler('disconnect', async () => { detectionAbort?.abort(); });
        session.setHandler('showView', async (viewId: string) => {
            if (viewId !== 'detect') detectionAbort?.abort();
        });

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

        this.registerAnalyticsHandlers(session);
        this.registerIndoorHandlers(session);

        session.setHandler('get_context', async () => ({
            mode: 'pair',
            analyticsConsent: analyticsConsent(this.homey)
        }));

        session.setHandler('start_detection', async () => {
            if (detection) {
                session.emit('detection_done', {}).catch(() => {});
                return true;
            }
            if (detectionRunning)
                return true;
            const controller = new AbortController();
            detectionAbort = controller;
            const onProgress = (pass: number, passes: number) =>
                session.emit('detection_progress', {pass, passes}).catch(() => {});
            const live = existingConnection(ipAddress!);
            const viaLive = !!(live && live.isConnected());
            this.log(`onPair detection: starting for ${ipAddress} via `
                + `${viaLive ? 'existing live connection' : 'new probe socket'} `
                + `(${this.profile.registers.length} registers × ${PROBE_PASSES} passes)`);
            detectionRunning = viaLive
                ? live!.probe(onProgress, controller.signal)
                : probeHost(this.profile, ipAddress!, this.pairingTransport(pairTransport), onProgress, controller.signal);
            detectionRunning
                .then((result) => {
                    if (controller.signal.aborted) throw new Error('Detection cancelled');
                    detection = result;
                    const read = Object.values(result.samples).filter((s) => s.read).length;
                    this.log(`onPair detection done: ${read}/${this.profile.registers.length} registers responded — `
                        + this.recommendationSummary(result.recommendations));
                    this.trackDetection('pair', result);
                    session.emit('detection_done', {}).catch(() => {});
                })
                .catch((error) => {
                    detectionRunning = null;
                    if (controller.signal.aborted) return;
                    this.error('onPair detection failed', error);
                    this.trackFailedDetection('pair');
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
        let detectionAbort: AbortController | null = null;
        session.setHandler('disconnect', async () => { detectionAbort?.abort(); });
        session.setHandler('showView', async (viewId: string) => {
            if (viewId !== 'detect') detectionAbort?.abort();
        });

        this.registerAnalyticsHandlers(session);
        this.registerIndoorHandlers(session, device);

        session.setHandler('get_context', async () => ({
            mode: 'repair',
            role,
            indoorSensors: device.getStoreValue('indoorSensors') ?? null,
            indoorNativeAddress: device.getStoreValue('indoorNativeAddress') ?? 116,
            groups: this.groupInfo(role),
            selection: (device.getStoreValue('selection') ?? null) as Selection | null,
            // Only the hot water view uses this, but the role is right here and inferring it in
            // the view from which groups came back would break the day a group moves.
            tanks: this.tankChoices(role),
            analyticsConsent: analyticsConsent(this.homey)
        }));

        session.setHandler('start_detection', async () => {
            if (detection) {
                session.emit('detection_done', {}).catch(() => {});
                return true;
            }
            if (detectionRunning)
                return true;
            const controller = new AbortController();
            detectionAbort = controller;
            detectionRunning = device.probeForDetection((pass: number, passes: number) =>
                session.emit('detection_progress', {pass, passes}).catch(() => {}), controller.signal);
            detectionRunning!
                .then((result: DetectionResult) => {
                    if (controller.signal.aborted) throw new Error('Detection cancelled');
                    detection = result;
                    const read = Object.values(result.samples).filter((s) => s.read).length;
                    this.log(`onRepair detection done: ${read} registers responded — `
                        + this.recommendationSummary(result.recommendations));
                    this.trackDetection('repair', result);
                    session.emit('detection_done', {}).catch(() => {});
                })
                .catch((error: any) => {
                    detectionRunning = null;
                    if (controller.signal.aborted) return;
                    this.error('onRepair detection failed', error);
                    this.trackFailedDetection('repair');
                    session.emit('detection_failed',
                        {message: error?.message ?? String(error)}).catch(() => {});
                });
            return true;
        });

        // Repair hands the view the unsupported list alongside the samples, so a register the
        // pump has just told us it cannot report arrives unticked rather than pre-checked
        // purely because it is already on the device.
        session.setHandler('get_detection', async () => {
            const result = detection as DetectionResult | null;
            return result
                ? {
                    ...result,
                    unsupported: this.unsupportedCapabilities(role, result),
                    // Overwrite the raw choices with the role-filtered, localised form the view
                    // expects — same shape the pairing flow hands over in `pairingCandidates`.
                    choices: this.choicesForRole(role, result.choices)
                }
                : null;
        });

        session.setHandler('selection_done', async (raw) => {
            const resolved = (detection as DetectionResult | null)?.addresses
                ?? (device.getStoreValue('selection') as Selection | null)?.addresses;
            const selection = this.cleanSelection(raw, resolved);
            const previousTank = (device.getStoreValue('selection') as Selection | null)?.hotwater;
            if (selection.hotwater && previousTank?.inletC !== undefined && raw?.hotwater?.inletC === undefined)
                selection.hotwater.inletC = previousTank.inletC;
            this.log('onRepair: selection:', JSON.stringify(selection));
            if (role === 'heating' && device.getStoreValue('indoorSensors')?.state === 'active') {
                selection.addresses = {...selection.addresses, measure_temperature: 26};
                selection.overrides = {...selection.overrides, measure_temperature: true};
            }
            await device.applySelection(selection);
            // After the device has the new selection, not before — the profile must describe what
            // the install now is, and applySelection() can throw.
            track('Changed Device Set', {
                action: 'reconfigured',
                role,
                groups_enabled: Object.entries(selection.groups ?? {})
                    .filter(([, on]) => on).map(([id]) => id)
            });
            this.syncInstallProfile();
            return true;
        });
    }
}
