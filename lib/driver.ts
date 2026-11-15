import {averageSensors, cleanIndoorConfig, indoorInventory, withApi} from './indoor-sensors';
import {OUTDOOR_SENSOR_SETTING} from './autopilot/collector';
import {SOLAR_SETTING, SolarSurplus, readSolarAnswer, scanSolar} from './autopilot/solar-surplus';
import {Driver, FlowCard} from 'homey';
import PairSession from "homey/lib/PairSession";
import net from "net";
import {
    Dir, GroupId, Register, RegisterInfo, Selection,
    enumConditionValue, flowPredicates, groupIds, isAdjustable, isSelectableRegister, signedValue
} from './registers';
import {
    ACTIVE_POWER_CAPABILITY, ENERGY_CAPABILITIES, FUNCTION_COP_CAPABILITY,
    HOTWATER_TANK_CAPABILITIES, HOTWATER_VOLUME_CAPABILITY, METER_CAPABILITY, possibleExtraCapabilities,
    Role, TOTAL_COP_CAPABILITY, allRoles, energyTitle, extraCapabilities, extraCapabilityOptions,
    extraCapabilitySupport, functionRoles, powerTitle, registersForRole, roleClass, roleGroups, deviceClass, roomThermostatActive,
    roleNames, roleOf, roleRegisters, autopilotInputs, hiddenBySmartMode, capabilitySyncPlan, AUTOPILOT_HEATING_CAPABILITIES,
    AUTOPILOT_HOTWATER_CAPABILITIES, DAY_TYPE_CAPABILITY, changeReason
} from './roles';
import type {ModelProfile} from './profile';
import {DAY_TYPE_SETTING, DayTypeState, awayOn, dayTypeAt, isDayType, readDayType, recordAway, recordDayType, typeSet} from './autopilot/day-type';
import {DayTypeSource, analyticsSmartMode, reserveBucket} from './autopilot/analytics';
import {AWAY_UNTIL_SETTING, awayEnded, awayUntilLabel, localDateTime, readAwayUntil} from './autopilot/away';
import {PeriodTrigger, periodDue} from './autopilot/heating-flows';
import {STARTER_DAYS, localClock} from './autopilot/hotwater-learner';
import {VerifyError, readRoomControl, undoOnPump, verifyOnPump, withPump} from './pairing-pump';
import {
    AllOnesResponseError, DetectionResult, PROBE_PASSES, Recommendations, RegisterSample, SourceChoices,
    probeHost
} from './detection';
import {Transport, destroyAllConnections, existingConnection} from './connection';
import {DiscoveryOptions, choosePumpCandidate, diagnoseNoData, discoverPumps} from './discovery';
import {CONSENT_SETTING, InstallProfile, analyticsConsent, placedWidgets, reportInstallProfile, setAnalyticsConsent, track} from './analytics';
import {DEFAULT_INLET_C, MAX_TANK_LITRES, MIN_TANK_LITRES, cleanTankChoice} from './hotwater';
import {SmartMode, smartMode} from './autopilot/smart-mode';

// Optional per-device transport entered during F pairing (the gateway port / unit id).
interface PairTransport {port?: number; unitId?: number; addressMode?: string}

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
        // Away with an end time ends by itself (autopilot/away.ts): checked each minute, the first
        // time once the devices are up, so a trip that ended while Homey was off ends at the start.
        if (this.profile.autopilotHotwater || this.profile.autopilotFeed) {
            this.homey.setInterval(() => this.endAwayIfDue(), 60_000);
            this.homey.flow.createToken('away_until',
                {type: 'string', title: this.homey.__('autopilot.away_until_token'), value: this.awayUntilText()})
                .then((token: any) => { this.awayUntilToken = token; },
                    (error: unknown) => this.error('Creating the Away token failed:', error));
        }
        // Which of the app's widgets are on a dashboard: read a minute after start (the devices'
        // own profile reports come first), then every 6 h, and told only when it changed.
        this.homey.setTimeout(() => this.refreshWidgets(), 60_000);
        this.homey.setInterval(() => this.refreshWidgets(), 6 * 3_600_000);
        // The consent checkbox now lives in device settings, but it can still be answered from the
        // pairing view — including while pairing a second pump, long after these devices existed.
        // Without this their checkboxes would sit stale until the next restart, and a consent
        // control that shows the wrong state is worse than none.
        this.homey.settings.on('set', (key: string) => {
            if (key !== CONSENT_SETTING)
                return;
            const consent = analyticsConsent(this.homey);
            if (consent) this.refreshWidgets();
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
            if (register.direction !== Dir.Out || register.noAction || !register.bool || (register.writeOnly && !register.flowOnly))
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
            autopilot: this.autopilotFacts(devices),
            ...this.widgets ? {widgets: this.widgets} : {},
            ...this.hostFacts()
        };
    }

    /** How Autopilot is set up: each function's Smart mode, the hot water safety net, solar and
     *  where the day type comes from. Only what this install has; never a reading. */
    private autopilotFacts(devices: any[]): InstallProfile['autopilot'] {
        const of = (role: string) => devices.find((d) => roleOf(d.getData()) === role);
        const heating = of('heating'), hotwater = of('hotwater');
        const solar = readSolarAnswer(this.homey.settings.get(SOLAR_SETTING));
        return {
            ...heating?.smartMode ? {smartModeHeating: analyticsSmartMode(heating.smartMode())} : {},
            ...hotwater?.smartMode ? {smartModeHotwater: analyticsSmartMode(hotwater.smartMode())} : {},
            ...hotwater?.reserveLitres && this.profile.autopilotHotwater ? {reserve: reserveBucket(hotwater.reserveLitres())} : {},
            ...solar ? {solarLive: solar.live, solarForecast: solar.forecast} : {},
            ...this.profile.autopilotHotwater && hotwater
                ? {dayTypeSource: typeSet(this.dayTypeState()) ? 'set' as const : 'calendar' as const} : {},
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

    /** The app's widgets placed on the Homey's dashboards, from the last read. */
    private widgets?: string[];

    /** Read the dashboards for the app's widgets; report the install profile when they changed.
     *  Only with analytics on: nothing else needs it. */
    private async refreshWidgets() {
        if (!analyticsConsent(this.homey)) return;
        try {
            const dashboards = await withApi(this.homey, (api) => api.dashboards.getDashboards());
            const widgets = placedWidgets(dashboards, (this.homey.manifest as any).id);
            if (this.widgets && this.widgets.join() === widgets.join()) return;
            this.widgets = widgets;
            this.syncInstallProfile();
        } catch (error) {
            this.error('Reading the dashboards for the install profile failed:', error);
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
    // What the detect view shows when detection fails. An all-0xFFFF responder is the one failure
    // the user can act on, and it would otherwise read as a pump that works.
    private detectionFailure(error: any): string {
        if (error instanceof AllOnesResponseError)
            return this.homey.__('pair.detect.no_data');
        return error?.message ?? String(error);
    }

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

    private flowId(id: string): string {
        return (this.profile.flowPrefix ?? "") + id;
    }

    // A picker's choices as its capability defines them in the manifest — the same ids and
    // translated titles its own dropdown on the tile shows, so card and tile always agree.
    private pickerOptions(register: Register): {id: string; name: string}[] {
        const language = this.homey.i18n.getLanguage();
        const type = register.name.split('.')[0];
        const values = (this.homey.manifest as any)?.capabilities?.[type]?.values ?? [];
        return values.map((value: any) => ({
            id: String(value.id),
            name: value.title?.[language] || value.title?.en || String(value.id)
        }));
    }

    private registerFlows() {
        for (const register of this.profile.registers) {
            if (!register.enum && !register.picker)
                continue;
            const enumOptions = async (query: string) =>
                (register.enum
                    ? Object.entries(register.enum as any).map((parts: any) => ({
                        id: parts[0],
                        name: this.homey.__(parts[1]) || parts[1]
                    }))
                    : this.pickerOptions(register))
                    .filter((result: any) => result.name.toLowerCase().includes(query.toLowerCase()));

            if (this.actionSpecs[register.name + ".enum"]) {
                this.homey.flow.getActionCard(this.flowId(register.name + ".enum"))
                    .registerArgumentAutocompleteListener("mode", async (query) => enumOptions(query))
                    .registerRunListener(this.tracked('action', register.name + ".enum", register,
                        async (args: any) => {
                            this.log(`Flow: ${args.device.getName()} set ${register.name} = ${args.mode.name}`);
                            await args.device.writeRegister(register, args.mode.id);
                        }));
            }
            if (this.conditionSpecs[register.name + ".enum"]) {
                this.homey.flow.getConditionCard(this.flowId(register.name + ".enum"))
                    .registerArgumentAutocompleteListener("mode", async (query) => enumOptions(query))
                    .registerRunListener(this.tracked('condition', register.name + ".enum", register,
                        async (args: any) => {
                            const expected = enumConditionValue(register, args.mode.id,
                                (key) => this.homey.__(key));
                            return args.device.hasCapability(register.name)
                                && args.device.getCapabilityValue(register.name) === expected;
                        }));
            }
        }

        // Dedicated less/greater-than card for a register whose value is a number even though its
        // capability is a picker (heat curve displacement: "3" on the tile). The generic "Value
        // comparison" card stays scaled-only, since widening it to pickers would offer operating
        // mode and the hot water modes, where greater-than means nothing.
        for (const register of this.profile.registers) {
            if (!this.conditionSpecs[register.name + ".compare"])
                continue;
            this.homey.flow.getConditionCard(this.flowId(register.name + ".compare"))
                .registerRunListener(this.tracked('condition', register.name + ".compare", register,
                    async (args: any) => {
                        if (!args.device.hasCapability(register.name))
                            return false;
                        const value = Number(args.device.getCapabilityValue(register.name) ?? NaN);
                        if (!Number.isFinite(value))
                            return false;
                        return args.comparison === "<" ? value < args.value : value > args.value;
                    }));
        }

        for (const register of this.profile.registers) {
            if (!isAdjustable(register) || !(register.scale! > 0))
                continue;
            if (this.actionSpecs[register.name + ".set"]) {
                this.homey.flow.getActionCard(this.flowId(register.name + ".set"))
                    .registerRunListener(this.tracked('action', register.name + ".set", register,
                        async (args: any) => this.writeNumeric(args.device, register, args.value)));
            }
        }

        for (const register of this.profile.registers) {
            if (!register.writeOnly || !this.actionSpecs[register.name + ".reset"])
                continue;
            this.homey.flow.getActionCard(this.flowId(register.name + ".reset"))
                .registerRunListener(this.tracked('action', register.name + ".reset", register,
                    async (args: any) => {
                        this.log(`Flow: ${args.device.getName()} reset ${register.name}`);
                        await args.device.writeRegister(register, true);
                    }));
        }

        // Dedicated per-register on/off cards ("More hot water – On/Off"): the way to switch a
        // register from a Flow. The generic enable/disable-feature cards duplicated them and are
        // deprecated — hidden from new Flows, still run for existing ones. Flow-only registers
        // (SG Ready's 3032) get one too. The `state` dropdown carries id "on"/"off".
        for (const register of this.profile.registers) {
            if (register.direction !== Dir.Out || register.noAction || !register.bool || (register.writeOnly && !register.flowOnly))
                continue;
            if (!this.actionSpecs[register.name + ".onoff"])
                continue;
            this.homey.flow.getActionCard(this.flowId(register.name + ".onoff"))
                .registerRunListener(this.tracked('action', register.name + ".onoff", register,
                    async (args: any) => {
                        const on = (args.state?.id ?? args.state) === 'on';
                        this.log(`Flow: ${args.device.getName()} set ${register.name} = ${on}`);
                        await args.device.writeRegister(register, on);
                    }));
        }

        if (this.actionSpecs["set_numeric_value"])
            this.registerAutofillFlow(this.homey.flow.getActionCard(this.flowId("set_numeric_value")),
            flowPredicates.numericAction,
            async (args: any) => this.writeNumeric(args.device, this.profile.registerByName[args.register.id], args.value));

        // `noAction` excludes a register from every generic write card, not just the numeric one:
        // it marks a holding register the app reads for context but must never write. Without
        // that check the "Room sensor regulation active" flag — legacy on zone firmware, where
        // writing it does nothing useful — would be offered as something to switch.
        if (this.actionSpecs["enable_feature"])
            this.registerAutofillFlow(this.homey.flow.getActionCard(this.flowId("enable_feature")),
            flowPredicates.boolAction,
            async (args: any) => {
                const register = this.profile.registerByName[args.register.id];
                this.log(`Flow: ${args.device.getName()} enable ${register.name}`);
                await args.device.writeRegister(register, true);
            });

        if (this.actionSpecs["disable_feature"])
            this.registerAutofillFlow(this.homey.flow.getActionCard(this.flowId("disable_feature")),
            flowPredicates.boolAction,
            async (args: any) => {
                const register = this.profile.registerByName[args.register.id];
                this.log(`Flow: ${args.device.getName()} disable ${register.name}`);
                await args.device.writeRegister(register, false);
            });

        this.registerAutofillFlow(this.homey.flow.getConditionCard(this.flowId("numeric_value_comparison")),
            flowPredicates.numericCondition,
            (args: any) => {
                if (!args.device.hasCapability(args.register.id))
                    return false;
                const capabilityValue = args.device.getCapabilityValue(args.register.id);
                if (typeof capabilityValue !== 'number' || !Number.isFinite(capabilityValue))
                    return false;
                return args.comparison === "<" ? capabilityValue < args.value : capabilityValue > args.value;
            }, 'condition');

        this.registerAutofillFlow(this.homey.flow.getConditionCard(this.flowId("feature_enabled")),
            flowPredicates.boolState,
            (args: any) => args.device.hasCapability(args.register.id) && args.device.getCapabilityValue(args.register.id),
            'condition');

        this.registerAutofillFlow(this.homey.flow.getDeviceTriggerCard(this.flowId("capability_changed")),
            flowPredicates.enumTrigger,
            (args: any, state: any) => args.register.id === state.register.id, 'trigger');

        this.registerAutofillFlow(this.homey.flow.getDeviceTriggerCard(this.flowId("capability_turned_on")),
            flowPredicates.boolState,
            (args: any, state: any) => args.register.id === state.register.id && state.value, 'trigger');

        this.registerAutofillFlow(this.homey.flow.getDeviceTriggerCard(this.flowId("capability_turned_off")),
            flowPredicates.boolState,
            (args: any, state: any) => args.register.id === state.register.id && !state.value, 'trigger');

        // The litres estimate is derived rather than a register, so the generic autocomplete cards
        // above cannot see it (their predicates take a Register) and it gets two cards of its own.
        // Both are scoped by the compose file's $filter to devices that actually carry it.
        if (this.conditionSpecs["hotwater_volume_below"])
            this.homey.flow.getConditionCard(this.flowId("hotwater_volume_below"))
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
        if (this.profile.hotwaterTank)
            this.homey.flow.getDeviceTriggerCard(this.flowId("hotwater_volume_dropped_below"))
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

        // Autopilot hot water (lib/autopilot/hotwater-shadow.ts): the charge trigger is fired by the
        // device; these are the condition and the household's day type.
        if (this.profile.autopilotHotwater) {
            this.homey.flow.getConditionCard(this.flowId("hotwater_charge_planned"))
                .registerRunListener(async (args: any) => args.device.hotwaterChargePlannedWithin(Number(args.hours)));
            this.homey.flow.getActionCard(this.flowId("set_day_type"))
                .registerRunListener(async (args: any) => this.setDayType(args.type, 'flow'));
        }

        // The home's Away (Main), for hot water and heating alike. Its end time is a token (onInit).
        if (this.profile.autopilotHotwater || this.profile.autopilotFeed) {
            this.homey.flow.getActionCard(this.flowId("set_away_until"))
                .registerRunListener(async (args: any) => {
                    const until = localDateTime(args.date, args.time, this.homey.clock.getTimezone());
                    if (until === undefined) throw new Error(this.homey.__('autopilot.heating.away_time_invalid'));
                    await this.setAway(true, until, 'flow');
                });
            this.homey.flow.getActionCard(this.flowId("back_home"))
                .registerRunListener(async () => this.setAway(false, undefined, 'flow'));
        }

        // Autopilot heating (lib/autopilot/live.ts): the status trigger is fired by the device.
        if (this.profile.autopilotFeed) {
            this.homey.flow.getConditionCard(this.flowId("autopilot_heating_status_is"))
                .registerRunListener(async (args: any) => args.device.heatingStatusNow() === args.status);
            this.homey.flow.getActionCard(this.flowId("autopilot_heating_set_profile"))
                .registerRunListener(async (args: any) => args.device.setAutopilotProfile(args.profile));
            // Fired by the device each feed cycle with the window it covers; each Flow's lead decides.
            for (const id of ["autopilot_heating_expensive_soon", "autopilot_heating_cheap_soon"])
                this.homey.flow.getDeviceTriggerCard(this.flowId(id))
                    .registerRunListener(async (args: any, state: PeriodTrigger) => periodDue(state, Number(args.minutes)));
        }
    }

    /** The household's day type, set from the Main device or a Flow: one app setting for the home,
     *  shown on every Main device that carries it. Throws on a value that is not a day type, so a
     *  Flow says what went wrong. Away is left as it is (see day-type.ts). */
    async setDayType(type: unknown, source: DayTypeSource = 'device') {
        if (!isDayType(type)) throw new Error(`Unknown day type: ${String(type)}`);
        await this.storeDayType(recordDayType(this.dayTypeState(), type, Date.now()), source);
    }

    /** The home's one Away, from the Main device's switch or a Flow: hot water keeps only its
     *  safety net and every Autopilot heating device's thermostat goes to its Away temperature.
     *  With `until`, Away ends by itself then, and heating is warm again by that time; without
     *  it, Away holds until turned off. Throws on an end time that has passed. */
    async setAway(on: boolean, until?: number, source: 'device' | 'flow' | 'end' = 'device') {
        if (on) this.awayEndPending = false;
        if (on && until !== undefined && !(until > Date.now())) throw new Error(this.homey.__('autopilot.heating.away_time_past'));
        const before = awayOn(this.dayTypeState());
        if (on && until !== undefined) this.homey.settings.set(AWAY_UNTIL_SETTING, until);
        else this.homey.settings.unset(AWAY_UNTIL_SETTING);
        if (before !== on) track('Changed Autopilot Setting', {role: 'main', setting: 'away', setting_value: on ? 'on' : 'off'});
        this.log(`Away ${on ? 'on' : 'off'} (${source}${until !== undefined ? `, until ${new Date(until).toISOString()}` : ''}).`);
        await this.storeDayType(recordAway(this.dayTypeState(), on, Date.now()));
    }

    /** The "Away until" Flow token: when Away ends, empty while home or with no end time. */
    private awayUntilToken?: any;

    private awayUntilText(): string {
        const until = awayOn(this.dayTypeState()) ? readAwayUntil(this.homey.settings.get(AWAY_UNTIL_SETTING)) : undefined;
        return until === undefined ? ''
            : awayUntilLabel(until, Date.now(), this.homey.clock.getTimezone(), this.homey.i18n?.getLanguage?.() ?? 'en');
    }

    /** Ending Away by itself failed on some device (the thermostat write): retried each minute. */
    private awayEndPending = false;

    /** End Away when its end time has come. Logged, never thrown: there is nobody to tell. A device
     *  that failed to follow (pump offline) is retried each minute until it does, since the end
     *  time and the day type are already gone and nothing else would put the thermostat back. */
    private endAwayIfDue() {
        // "Thu 18:00" becomes "18:00" on the day: the token follows the clock.
        const text = this.awayUntilText();
        if (this.awayUntilToken && this.awayUntilToken.value !== text) this.awayUntilToken.setValue(text).catch(this.error);
        if (this.awayEndPending) {
            this.setAway(false, undefined, 'end').then(() => {
                this.awayEndPending = false;
                this.log('Away ended on every device.');
            }, (error: unknown) => this.error('Ending Away failed again, retrying:', error));
            return;
        }
        const until = readAwayUntil(this.homey.settings.get(AWAY_UNTIL_SETTING));
        if (!awayEnded(until, Date.now())) return;
        if (!awayOn(this.dayTypeState())) {
            this.homey.settings.unset(AWAY_UNTIL_SETTING);
            return;
        }
        this.log(`Away ends by itself (until ${new Date(until!).toISOString()}).`);
        this.setAway(false, undefined, 'end').catch((error: unknown) => {
            this.awayEndPending = true;
            this.error('Ending Away failed, retrying each minute:', error);
        });
    }

    private dayTypeState() {
        return readDayType(this.homey.settings.get(DAY_TYPE_SETTING));
    }

    /** Store the state and bring every device in line with it: Main shows the day type, Autopilot
     *  and Away, Autopilot heating follows Away. Every device is tried; the first failure is thrown afterwards. */
    private async storeDayType(state: DayTypeState | undefined, source?: DayTypeSource) {
        const before = this.dayTypeState();
        if (state) this.homey.settings.set(DAY_TYPE_SETTING, state);
        // Told when a change was logged (the day type in force, or the calendar handing over),
        // not when a nightly Flow sets what is already set.
        const last = (s?: DayTypeState) => s?.log[s.log.length - 1];
        if (source && state && last(state) && last(state)!.at !== last(before)?.at) {
            const now = Date.now();
            track('Changed Day Type', {day_type: dayTypeAt(state, now, localClock(this.homey.clock.getTimezone())), source});
            this.syncInstallProfile();
        }
        const away = awayOn(state);
        // Away ended some other way (the Main device's day type): its end time goes with it.
        if (!away) this.homey.settings.unset(AWAY_UNTIL_SETTING);
        await this.awayUntilToken?.setValue(this.awayUntilText()).catch(this.error);
        let failure: unknown;
        for (const driver of this.homey.drivers.getDrivers ? Object.values(this.homey.drivers.getDrivers()) as any[] : [this])
            for (const d of driver.getDevices() as any[]) {
                await d.showDayType?.();
                await d.applyAway?.(away).catch((error: unknown) => { failure ??= error; });
                // A new end time with Away already on changes no thermostat: plan for it now.
                d.replanHeating?.();
            }
        if (failure) throw failure;
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
                    optIn: !!register.optIn,
                    description: (register.info as any)[language] || register.info.en
                }));
            // Derived, so it is in no register group — listed here so Repair can switch it off
            // like any other capability. Without a checkbox the override cleanSelection preserves
            // could never be set in the first place.
            if (id === 'hotwater' && role === 'hotwater' && this.profile.hotwaterTank)
                for (const name of HOTWATER_TANK_CAPABILITIES)
                    entries.push({
                        name,
                        title: this.extraDisplayTitle(role, name, lang),
                        adjustable: false,
                        optIn: false,
                        description: name === HOTWATER_VOLUME_CAPABILITY
                            ? (lang === 'sv' ? 'Liter 40-gradigt varmvatten kvar. Kräver vald beredare nedan.'
                                : 'Litres of 40 °C water left. Needs the tank you pick below.')
                            : (lang === 'sv' ? 'Kallvattnet som kommer in, inlärt från beredarens nedre givare.'
                                : 'The cold water coming in, learned from the tank\'s lower sensor.')
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
        const title = extraCapabilityOptions(role, name, this.profile)?.title;
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
        const keep = (name: string, group: GroupId, optIn = false) => {
            const override = raw?.overrides?.[name];
            // An opt-in register is off without an override, so its "on" is the one worth keeping.
            if (typeof override === "boolean" && (optIn ? override : override !== groups[group]))
                overrides[name] = override;
        };
        for (const register of this.profile.registers) {
            if (register.group === "core")
                continue;
            keep(register.name, register.group, !!register.optIn);
        }
        // The derived energy/COP capabilities are toggled like registers in the features view,
        // so their overrides have to survive the round trip too — otherwise repair silently
        // re-enables a COP the pump has no registers for.
        for (const name of [...ENERGY_CAPABILITIES, TOTAL_COP_CAPABILITY, FUNCTION_COP_CAPABILITY])
            keep(name, "energy");
        // The litres estimate rides the hotwater group, not energy — its sensors are hotwater
        // registers.
        for (const name of HOTWATER_TANK_CAPABILITIES)
            keep(name, "hotwater");
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
        if (role === 'heating' && this.profile.roomThermostat)
            selection.roomThermostat = roomThermostatActive(this.profile, (name) => samples[name]?.read ? samples[name].value : undefined);
        // Where detection found a register at one of its alternate addresses, record it on the
        // device so the runtime reads that address instead of the one in the table.
        if (Object.keys(addresses).length)
            selection.addresses = addresses;
        for (const register of roleRegisters(this.profile, role)) {
            if (register.optIn) {
                if (samples[register.name]?.read)
                    selection.overrides[register.name] = true;
                continue;
            }
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
            const opt = extraCapabilityOptions(role, extra, this.profile);
            if (opt)
                options[extra] = opt;
        }
        // Only carry port/unit-id into the device settings when the model actually uses them
        // (F pairing entered them) — keeps S device settings unchanged (just {address}).
        const settings: {address: string; port?: number; unitId?: number; addressMode?: string} = {address: ip};
        if (transport?.addressMode)
            settings.addressMode = transport.addressMode;
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
            class: deviceClass(this.profile, role, selection),
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
                for (const cap of HOTWATER_TANK_CAPABILITIES)
                    caps.push({
                        name: cap,
                        title: this.extraDisplayTitle(role, cap, lang),
                        detected: extraCapabilitySupport(
                            this.profile, role, (name) => samples[name])[cap]
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
                tanks: this.tankChoices(role),
                // Smart mode is set up in pairing for the functions that have one here.
                smart: (role === 'heating' && !!this.profile.autopilotFeed)
                    || (role === 'hotwater' && (!!this.profile.autopilotHotwater || !!this.profile.spaSwitches)),
                indoorSupported: !!this.profile.indoorSensorFeed
            }));
    }

    // Discovery transport/probe for this model: sweep the profile's default port, verify with
    // the profile's probe register (offset applied).
    private discoveryOptions(transport?: PairTransport): DiscoveryOptions {
        return this.probeOptions(this.pairingTransport(transport));
    }

    private probeOptions(transport: Transport): DiscoveryOptions {
        const probe = this.profile.detection.discoveryProbe;
        const typeAddress = this.profile.pumpInfo?.typeAddress;
        return {
            ...transport,
            probeAddress: probe.address - (transport.addressBase ?? 0),
            confirmAddress: typeAddress === undefined ? undefined : typeAddress - (transport.addressBase ?? 0),
            direction: probe.direction,
            scale: probe.scale,
            min: probe.min,
            max: probe.max
        };
    }

    // The devices of one pump: everything of this driver paired at that address.
    private pumpDevices(host: string): any[] {
        return (this.getDevices() as any[]).filter((device) => device.getSettings?.().address === host);
    }

    // Every address any of this app's drivers has a device at — a pump the user paired under the
    // other series still owns its address.
    private pairedAddresses(): Set<string> {
        const drivers = Object.values(this.homey.drivers.getDrivers()) as Driver[];
        return new Set(drivers.flatMap((driver) =>
            (driver.getDevices() as any[]).map((device) => String(device.getSettings?.().address))));
    }

    // Move every device of the pump at `from` to `to`, keeping their history, settings and
    // Flows — the whole point over re-pairing. `initiator` is a device whose own settings are
    // already being saved by Homey (a user edit in onSettings); it is reconnected but not
    // written, since setSettings() from inside onSettings is overwritten by the save.
    async movePump(from: string, to: string, initiator?: any, initiatorSettings?: any): Promise<void> {
        const devices = this.pumpDevices(from);
        if (initiator && !devices.includes(initiator))
            devices.push(initiator);
        if (this.pairedAddresses().has(to))
            throw new Error(this.homey.__('connection.address_in_use', {host: to}));
        this.log(`Moving ${devices.length} device(s) from ${from} to ${to}`);
        for (const device of devices) {
            if (device !== initiator)
                await device.setSettings({address: to});
            device.reconnectTo(to, from, device === initiator ? initiatorSettings : undefined);
        }
    }

    // The subnet sweep behind relocatePump(), as a method so tests can stand in for the network.
    private sweep(localAddress: string, exclude: Set<string>, options: DiscoveryOptions) {
        return discoverPumps(localAddress, exclude, options);
    }

    // The pump at `from` has not answered a connect for minutes. Sweep the subnet the way pairing
    // does, and if exactly one unpaired pump of the same model answers, it is this one under a new
    // DHCP lease: move its devices there. Anything else changes nothing — see choosePumpCandidate.
    // Returns the new address, or undefined.
    private relocating = new Set<string>();

    async relocatePump(from: string, transport: Transport): Promise<string | undefined> {
        if (this.relocating.has(from))
            return undefined;
        this.relocating.add(from);
        try {
            const devices = this.pumpDevices(from);
            const stored = Number(devices.map((d) => d.getSettings().heatpump_type).find((v) => v));
            const modelCode = Number.isFinite(stored) && stored > 0 ? stored : undefined;
            const typeAddress = this.profile.pumpInfo?.typeAddress;
            const localAddress = await this.homey.cloud.getLocalAddress();
            this.log(`Pump at ${from} unreachable — searching the network for it `
                + `(model code ${modelCode ?? 'unknown'})`);
            const found = await this.sweep(localAddress, this.pairedAddresses(), {
                ...this.probeOptions(transport),
                identityAddress: typeAddress === undefined ? undefined
                    : typeAddress - (transport.addressBase ?? 0)
            });
            const {pick, matches} = choosePumpCandidate(found, modelCode);
            const seen = found.map((p) => `${p.address}${p.identity === undefined ? '' : ` (model ${p.identity})`}`);
            if (!pick) {
                this.log(`Search for the pump at ${from}: ${matches.length === 0
                    ? `no unpaired pump${modelCode === undefined ? '' : ' of the same model'} found`
                    : `${matches.length} candidates, not moving`}`
                    + (seen.length ? ` — responders: ${seen.join(', ')}` : ''));
                return undefined;
            }
            // Re-check: a pairing or a manual edit may have claimed the address mid-sweep.
            if (!this.pumpDevices(from).length || this.pairedAddresses().has(pick.address))
                return undefined;
            this.log(`Found the pump at ${pick.address} — it moved from ${from}`);
            await this.movePump(from, pick.address);
            await this.homey.notifications.createNotification({
                excerpt: this.homey.__('connection.moved', {from, to: pick.address})
            }).catch((error: any) => this.error('Could not post the moved-pump notice', error));
            return pick.address;
        } finally {
            this.relocating.delete(from);
        }
    }

    // A pump whose every register answers 0xFFFF: log the reads under other unit IDs, the host's
    // other ports, and every Modbus responder on the subnet. See diagnoseNoData() in discovery.ts.
    async diagnoseNoData(host: string, transport: Transport): Promise<void> {
        const base = transport.addressBase ?? 0;
        const addresses = [this.profile.detection.discoveryProbe.address, this.profile.pumpInfo?.typeAddress]
            .filter((address): address is number => address !== undefined)
            .map((address) => address - base);
        const localAddress = net.isIP(host)
            ? await this.homey.cloud.getLocalAddress().catch(() => undefined) : undefined;
        this.log(`No-data diagnostic for ${host}: reading input ${addresses.join(', ')} (wire addresses)`);
        const lines = await this.diagnose(host, localAddress, {port: transport.port, unitId: transport.unitId, addresses});
        for (const line of lines)
            this.log(`  ${line}`);
    }

    // The network side of diagnoseNoData(), as a method so tests can stand in for the network.
    private diagnose(...args: Parameters<typeof diagnoseNoData>) {
        return diagnoseNoData(...args);
    }

    private validatePairTransport(data: any): PairTransport {
        if (!this.profile.addressModes) return {};
        const port = Number(data?.port ?? 502);
        const unitId = Number(data?.unitId ?? 1);
        const addressMode = data?.addressMode ?? Object.keys(this.profile.addressModes)[0];
        if (!Number.isInteger(port) || port < 1 || port > 65535
            || !Number.isInteger(unitId) || unitId < 1 || unitId > 247
            || !this.profile.addressModes[addressMode])
            throw new Error(this.homey.__('pair.gateway.invalid'));
        return {port, unitId, addressMode};
    }

    private pairingTransport(transport?: PairTransport): Transport {
        return {
            port: transport?.port || this.profile.transport.port,
            unitId: transport?.unitId || this.profile.transport.unitId,
            addressBase: this.profile.addressModes?.[transport?.addressMode ?? ""]?.addressBase ?? this.profile.addressBase
        };
    }

    /** Repair → Smart mode (assets/pair/setup.js `smart`), on Heating and Hot water. */
    private registerSmartModeHandlers(session: PairSession, device: any) {
        session.setHandler('smart_status', async () => {
            const status = await device.smartModeStatus();
            if (status.role !== 'heating') return status;
            const facts = await this.outdoorFacts();
            return {...status, outdoorSensor: facts.outdoorSensor, outdoorName: facts.outdoorName};
        });
        session.setHandler('smart_choose', async (data: any) => {
            const value = data?.value;
            await device.chooseSmartMode(value === 'spa' || value === 'test' || value === 'autopilot' ? value : 'off');
            return true;
        });
        if (device.role === 'hotwater') {
            session.setHandler('hotwater_household', async (data: any) => { await device.setHousehold(data ?? null); return true; });
            session.setHandler('hotwater_reserve', async (data: any) => { await device.setReserve(data?.litres); return true; });
        }
        this.registerHomeSetupHandlers(session, device.role === 'heating');
        if (device.role === 'heating') session.setHandler('activate_autopilot', async () => device.activateAutopilotHeating());
    }

    /** Setup that is the home's, not a device's, so Repair and pairing share it: solar (asked in
     *  hot water's setup, read by every function) and heating's outdoor sensor. */
    private registerHomeSetupHandlers(session: PairSession, outdoor: boolean) {
        session.setHandler('solar_scan', async () => scanSolar(this.homey));
        session.setHandler('solar_save', async (data: any) => {
            if (typeof data?.live !== 'boolean' || typeof data?.forecast !== 'boolean') throw new Error('live and forecast must be on or off');
            const before = readSolarAnswer(this.homey.settings.get(SOLAR_SETTING));
            this.homey.settings.set(SOLAR_SETTING, {live: data.live, forecast: data.forecast,
                ...(typeof data.meter === 'string' ? {meter: data.meter} : {})});
            for (const [setting, on] of [['solar_live', data.live], ['solar_forecast', data.forecast]] as const)
                if (before?.[setting === 'solar_live' ? 'live' : 'forecast'] !== on)
                    track('Changed Autopilot Setting', {role: 'hotwater', setting, setting_value: on ? 'on' : 'off'});
            this.syncInstallProfile();
            SolarSurplus.refresh();
            return true;
        });
        if (!outdoor) return;
        session.setHandler('get_outdoor_sensors', async () => indoorInventory(this.homey));
        session.setHandler('set_outdoor_sensor', async (ref: any) => {
            const had = this.homey.settings.get(OUTDOOR_SENSOR_SETTING);
            const chosen = !!ref && typeof ref.deviceId === 'string' && typeof ref.capabilityId === 'string';
            if (chosen) this.homey.settings.set(OUTDOOR_SENSOR_SETTING, {deviceId: ref.deviceId, capabilityId: ref.capabilityId});
            else this.homey.settings.unset(OUTDOOR_SENSOR_SETTING);
            // Which sensor is the home's; only whether one is used is told.
            if (chosen ? had?.deviceId !== ref.deviceId || had?.capabilityId !== ref.capabilityId : !!had)
                track('Changed Autopilot Setting', {role: 'heating', setting: 'outdoor_sensor', setting_value: chosen ? 'on' : 'off'});
            return true;
        });
    }

    /** A capability's name as the owner sees it, in their language, derived ones included. */
    private ownerTitle(role: Role, name: string): string {
        const language = this.homey.i18n.getLanguage();
        const title = this.options(name)?.title ?? extraCapabilityOptions(role, name, this.profile)?.title;
        return title?.[language] || title?.en || name;
    }

    /** The changes from `before` to `after`, grouped by reason and named for the owner. */
    private changeGroups(role: Role, before: string[], after: string[], smart: SmartMode) {
        const groups = new Map<string, {kind: 'add' | 'remove'; reason: string; names: string[]}>();
        const put = (name: string, added: boolean) => {
            const reason = changeReason(this.profile, role, name, added, smart);
            const key = (added ? '+' : '-') + reason;
            if (!groups.has(key)) groups.set(key, {kind: added ? 'add' : 'remove', reason, names: []});
            groups.get(key)!.names.push(this.ownerTitle(role, name));
        };
        after.filter((n) => !before.includes(n)).forEach((n) => put(n, true));
        before.filter((n) => !after.includes(n)).forEach((n) => put(n, false));
        return [...groups.values()];
    }

    /** What pairing will add, per device: how many readings and settings, and what Autopilot and
     *  the tank bring, from the same plan the device will follow when it first runs. */
    private pairingPreview(raw: any) {
        const devices = Array.isArray(raw?.devices) ? raw.devices : [];
        return devices.map((d: any) => {
            const role = roleOf(d?.data);
            const smart = smartMode(d?.store?.pairedSmartMode?.mode);
            const wanted = capabilitySyncPlan(this.profile, role, d?.store?.selection ?? null, [], smart).wanted;
            const own = [...AUTOPILOT_HEATING_CAPABILITIES, ...AUTOPILOT_HOTWATER_CAPABILITIES, DAY_TYPE_CAPABILITY];
            const special = (n: string) => own.includes(n) || HOTWATER_TANK_CAPABILITIES.includes(n);
            const groups: any[] = [{kind: 'add', reason: 'count', count: wanted.filter((n) => !special(n)).length, names: []}];
            const autopilot = wanted.filter((n) => own.includes(n)).map((n) => this.ownerTitle(role, n));
            if (autopilot.length) groups.push({kind: 'add', reason: smart === 'test' ? 'autopilot_simulated' : 'autopilot', names: autopilot});
            const tank = wanted.filter((n) => HOTWATER_TANK_CAPABILITIES.includes(n)).map((n) => this.ownerTitle(role, n));
            if (tank.length) groups.push({kind: 'add', reason: 'tank', names: tank});
            return {name: d?.name ?? role, groups};
        });
    }

    /** The heating status's outdoor-sensor facts, from the app setting. */
    private async outdoorFacts(): Promise<{outdoorSensor: any; outdoorName: string | null; outdoor: number | null}> {
        const ref = this.homey.settings.get(OUTDOOR_SENSOR_SETTING) as {deviceId: string; capabilityId: string} | null;
        const sensor = ref ? (await indoorInventory(this.homey).catch(() => []))
            .find((s) => s.deviceId === ref.deviceId && s.capabilityId === ref.capabilityId) : undefined;
        return {outdoorSensor: ref ?? null,
            outdoorName: sensor ? `${sensor.name}${sensor.room ? ' · ' + sensor.room.split(' / ').slice(-1)[0] : ''}` : null,
            outdoor: sensor && typeof sensor.value === 'number' ? sensor.value : null};
    }

    /** Smart mode's facts during pairing, before any device exists: SPA from detection, room-sensor
     *  control read from the pump, the rest from the home. The mode shown is what the pump runs. */
    private async pairSmartStatus(role: string, host: string, transport: PairTransport, detection: DetectionResult | null) {
        const spa = this.profile.spaSwitches;
        const on = (name?: string) => {
            const v = name ? detection?.samples[name]?.value : undefined;
            return v === undefined ? undefined : v !== 0;
        };
        const fn = role === 'hotwater' ? 'hotwater' : 'heating';
        const spaIsOn = !!spa && on(spa.master) === true && on(spa[fn]) === true;
        const base = {role: fn, mode: (spaIsOn ? 'spa' : 'off') as SmartMode, spa: !!spa, spaOn: spaIsOn, autopilot: true};
        if (fn === 'hotwater') {
            const state = readDayType(this.homey.settings.get(DAY_TYPE_SETTING));
            const type = dayTypeAt(state, Date.now(), localClock(this.homey.clock.getTimezone()));
            // A new pump has no hot water history, and no Flow can target devices that do not exist yet.
            return {...base, tank: true, flows: [], historyDays: null, starterDays: STARTER_DAYS, household: null,
                dayType: {name: this.homey.__(`autopilot.hotwater_use.${type}`), set: typeSet(state)}, reserve: 40};
        }
        const room = await withPump(this.profile, host, this.pairingTransport(transport),
            (pump) => readRoomControl(pump, this.profile)).catch(() => undefined);
        const indoor = detection?.samples['measure_temperature']?.value;
        const target = detection?.samples['target_temperature']?.value;
        const prices = await withApi(this.homey, async (api) => await api.energy.getElectricityPriceType() === 'dynamic').catch(() => false);
        return {...base, verified: false, roomControl: room ?? null, indoor: typeof indoor === 'number' ? indoor : null,
            target: typeof target === 'number' ? target : null,
            prices, status: null, ...await this.outdoorFacts()};
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
            session.setHandler('read_indoor', async (raw: any) => device.readIndoorForAutopilot(raw));
            session.setHandler('stop_reading_indoor', async () => device.stopReadingIndoor());
        }
    }

    async onPair(session: PairSession): Promise<void> {
        this.log('onPair: pairing session started');
        let ipAddress: string | null = null;
        let pairTransport: PairTransport = {};
        let detection: DetectionResult | null = null;
        let detectionRunning: Promise<DetectionResult> | null = null;
        let detectionAbort: AbortController | null = null;
        session.setHandler('showView', async (viewId: string) => {
            if (viewId !== 'detect') detectionAbort?.abort();
        });

        session.setHandler('get_connection_options', async () => ({addressModes: this.profile.addressModes ?? {}}));
        session.setHandler('discover', async (options: any) => {
            if (this.profile.addressModes) pairTransport = this.validatePairTransport(options);
            const localAddress = await this.homey.cloud.getLocalAddress();
            const pairedAddresses = this.getDevices().map((device) => String(device.getSettings().address));
            this.log(`onPair discover: scanning subnet from ${localAddress}, skipping ${pairedAddresses.length} paired IP(s)`);
            const probe = this.profile.detection.discoveryProbe;
            const found = await discoverPumps(localAddress, new Set(pairedAddresses),
                this.discoveryOptions(pairTransport), (done, total) =>
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
            pairTransport = this.validatePairTransport(data);
            return true;
        });

        this.registerAnalyticsHandlers(session);
        this.registerIndoorHandlers(session);
        this.registerHomeSetupHandlers(session, !!this.profile.autopilotFeed);
        // What Verify changed on the pump, to put back if pairing ends without a Heating device.
        let verified: {undo: [string, boolean][]} | null = null;
        session.setHandler('smart_status', async (data: any) =>
            this.pairSmartStatus(data?.role, ipAddress!, pairTransport, detection));
        session.setHandler('preview_devices', async (data: any) => this.pairingPreview(data));
        session.setHandler('activate_autopilot', async () => {
            if (!this.profile.autopilotFeed) throw new Error(this.homey.__('autopilot.heating.verify.not_heating'));
            const real = (await this.outdoorFacts()).outdoor ?? undefined;
            try {
                const result = await withPump(this.profile, ipAddress!, this.pairingTransport(pairTransport),
                    (pump) => verifyOnPump(pump, this.profile, real, (ms) => new Promise((r) => this.homey.setTimeout(r, ms))));
                verified = {undo: result.undo};
                this.log(`onPair: Autopilot heating verified on the pump (fed ${result.fed} °C).`);
                return {fed: result.fed};
            } catch (error: any) {
                if (error instanceof VerifyError) throw new Error(this.homey.__(`autopilot.heating.verify.${error.reason}`));
                throw error;
            }
        });
        session.setHandler('disconnect', async () => {
            detectionAbort?.abort();
            if (!verified?.undo.length || !ipAddress) return;
            const undo = verified.undo, host = ipAddress;
            // Done pairing creates the devices before the session closes; give Homey a moment.
            this.homey.setTimeout(() => {
                if (this.getDevices().some((d: any) => d.getData()?.id === `${host}#heating`)) return;
                withPump(this.profile, host, this.pairingTransport(pairTransport), (pump) => undoOnPump(pump, undo))
                    .then(() => this.log('onPair: pairing ended without Heating; Smart price adaption put back.'))
                    .catch((error) => this.error('onPair: could not put Smart price adaption back', error));
            }, 10_000);
        });

        session.setHandler('get_context', async () => ({
            mode: 'pair',
            driverId: this.id,
            slowDetection: !!this.profile.addressModes,
            analyticsConsent: analyticsConsent(this.homey),
            indoorSupported: !!this.profile.indoorSensorFeed
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
            if (live && !live.matchesProfile(this.profile))
                throw new Error('This address is already paired with a different pump driver. Remove that device before changing series.');
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
                        {message: this.detectionFailure(error)}).catch(() => {});
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

    /** The selection Repair would save, cleaned as it will be stored: Save changes and What changes
     *  both use it, so the preview is exactly what saving does. */
    private pendingSelection(raw: any, device: any, detection: DetectionResult | null, role: Role): {selection: Selection} {
        const resolved = detection?.addresses ?? (device.getStoreValue('selection') as Selection | null)?.addresses;
        const selection = this.cleanSelection(raw, resolved);
        const previousTank = (device.getStoreValue('selection') as Selection | null)?.hotwater;
        if (selection.hotwater && previousTank?.inletC !== undefined && raw?.hotwater?.inletC === undefined)
            selection.hotwater.inletC = previousTank.inletC;
        if (role === 'heating' && device.getStoreValue('indoorSensors')?.state === 'active') {
            selection.addresses = {...selection.addresses, measure_temperature: 26};
            selection.overrides = {...selection.overrides, measure_temperature: true};
        }
        return {selection};
    }

    async onRepair(session: PairSession, device: any): Promise<void> {
        const role = roleOf(device.getData());
        const openedWith: string[] = [...device.getCapabilities()];
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
        const spa = this.profile.spaSwitches;
        const smart = (role === 'heating' && !!this.profile.autopilotFeed)
            || (role === 'hotwater' && (!!this.profile.autopilotHotwater || !!spa))
            || (role === 'pool' && !!spa?.poolInfluence) || (role === 'cooling' && !!spa?.cooling);
        if (smart) this.registerSmartModeHandlers(session, device);

        session.setHandler('get_context', async () => ({
            mode: 'repair',
            slowDetection: !!this.profile.addressModes,
            role,
            indoorSensors: device.getStoreValue('indoorSensors') ?? null,
            indoorNativeAddress: device.getStoreValue('indoorNativeAddress') ?? 116,
            smart,
            groups: this.groupInfo(role),
            selection: (device.getStoreValue('selection') ?? null) as Selection | null,
            // Only the hot water view uses this, but the role is right here and inferring it in
            // the view from which groups came back would break the day a group moves.
            tanks: this.tankChoices(role),
            analyticsConsent: analyticsConsent(this.homey),
            indoorSupported: !!this.profile.indoorSensorFeed
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
                        {message: this.detectionFailure(error)}).catch(() => {});
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

        // What changes: against what the device had when Repair opened, so a Smart mode chosen in
        // this Repair (saved at once) shows with the rest.
        session.setHandler('preview_changes', async (raw) => {
            const {selection} = this.pendingSelection(raw, device, detection, role);
            const {wanted, smart} = device.previewCapabilities(selection);
            return [{name: device.getName(), groups: this.changeGroups(role, openedWith, wanted, smart)}];
        });
        session.setHandler('selection_done', async (raw) => {
            const {selection} = this.pendingSelection(raw, device, detection, role);
            this.log('onRepair: selection:', JSON.stringify(selection));
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
