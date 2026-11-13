import {CaptureSummary, logCaptureSummary} from './diagnostic-capture';
import {IndoorConfig, averageSensors, cleanIndoorConfig, selectedReadings, withApi} from './indoor-sensors';
import {Controls, AutopilotCollector} from './autopilot/collector';
import {newHistoryFileName} from './autopilot/store-file';
import {ChargeEvent, HotwaterAutopilot, HotwaterMode, ownDeviceId} from './autopilot/hotwater-shadow';
import {FlowConflict, moreHotwaterFlows} from './autopilot/hotwater-flows';
import {STARTER_DAYS, readHousehold} from './autopilot/hotwater-learner';
import {DAY_TYPE_SETTING, readDayType} from './autopilot/day-type';
import {Sample} from './autopilot/history';
import {DEFAULT_PROFILE, HeatingFeed, LiveMode, PumpFacts, VERIFY_GAP_MS, VERIFY_TRIES, liveMode, profileLimits, sunTrust, surplusPrices} from './autopilot/live';
import {AUTOPILOT_FUNCTIONS, SMART_MODE_STORE, SmartFunction, SmartMode, autopilotRuns, shownSmartMode, smartMode, smartModeWrites, spaOn} from './autopilot/smart-mode';
import {HeatingStatus, heatingStatus} from './autopilot/heating-status';
import {forecastCorrection} from './autopilot/outdoor';
import {AHEAD_SLOTS, BACK_SLOTS, HOTWATER_SLOTS, WidgetData, heatingSlots, ticks} from './autopilot/widget';
import {slotOf} from './autopilot/prices';
import {SolarSurplus} from './autopilot/solar-surplus';
import {Device} from 'homey';
import net from 'net';
import {analyticsConsent, setAnalyticsConsent, track} from './analytics';
import {
    Dir, Register, Selection, encodeRegisterValue, toNumericValue, enumLabel, isPollable, isUnavailableRaw, migrateSelection,
    resolvedAddress, signedValue, withResolvedAddresses
} from './registers';
import {
    ACTIVE_POWER_CAPABILITY, ALARM_ACTIVE_CAPABILITY, ALARM_TEXT_CAPABILITY, AUTOPILOT_AWAY_CAPABILITY,
    AUTOPILOT_AWAY_TEMPERATURE_CAPABILITY, AUTOPILOT_FED_CAPABILITY, AUTOPILOT_RANGE_CAPABILITY,
    AUTOPILOT_REASON_CAPABILITY, AUTOPILOT_SHIFT_CAPABILITY, AUTOPILOT_STATUS_CAPABILITY,
    DAY_TYPE_CAPABILITY, FUNCTION_COP_CAPABILITY, HOTWATER_VOLUME_CAPABILITY, METER_CAPABILITY,
    PUMP_ACTIVE_CAPABILITY, Role, SOLAR_METER_CAPABILITY, TOTAL_COP_CAPABILITY,
    capabilitySyncPlan, extraCapabilities, extraCapabilityOptions, functionRoles, mirrorOptions,
    mirrorsForRole, registersForRole, roleClass, roleOf, roleRegisters, deviceClass, roomThermostatActive,
    GroupMove, adoptMovedGroup, movedGroups
} from './roles';
import {ALARM_SOURCE_URL, alarmAdvice, alarmDescription} from './alarms';
import {
    ColdSample, COLD_WINDOW_DAYS, DEFAULT_INLET_C, MAX_TANK_LITRES, MIN_TANK_LITRES, MIX_C,
    dayNumber, learnedInletC, usableLitres
} from './hotwater';
import type {LocalizedText, ModelProfile} from './profile';
import {ConnectionProblem, PumpConnection, PumpSubscriber, POLL_SECONDS_DEFAULT, Transport,
    clampPollSeconds, inLanguage} from './connection';

// The Away temperature until the owner sets one.
const AWAY_DEFAULT_C = 17;
/** Device store key (Hot water): setup's household answers, Autopilot hot water's starting profile. */
const HOUSEHOLD_STORE = 'autopilotHotwaterHousehold';

// How long the indoor feed may keep failing before the user is told (10 missed 30 s updates).
const INDOOR_ALERT_AFTER_MS = 5 * 60 * 1000;

// One logical function of the physical pump (see roles.ts). All devices share a single
// PumpConnection per pump host; this class is the Homey-facing subscriber: it maps its role's
// registers to capabilities, and — for function roles — keeps the energy bucket the
// connection's allocator feeds it. Model-specific data comes from the concrete subclass's
// `profile` (S or F).
export abstract class NibePumpDevice extends Device implements PumpSubscriber {
    abstract profile: ModelProfile;

    role: Role = 'main';
    private capabilitiesSynced = false;
    private connection: PumpConnection | null = null;
    private thermostatSync: Promise<void> | null = null;

    private static indoorOwners = new Map<string, NibePumpDevice>();
    // Autopilot history, collected on Heating (lib/autopilot). Reads only.
    private autopilot: AutopilotCollector | null = null;
    // Hot water Autopilot in shadow, on Hot water, while the app setting below is on. Reads only.
    private hotwaterAutopilot: HotwaterAutopilot | null = null;
    private heatingFeed: HeatingFeed | null = null;
    // The heating Smart mode as a feed mode, as last applied (syncHeatingFeed).
    private heatingMode: LiveMode = 'off';
    private heatingStatusShown?: HeatingStatus;
    // Hosts whose SPA switches Smart mode is writing right now, so its own writes are not taken
    // for the pump (or the owner) turning SPA on.
    private static smartWriting = new Set<string>();
    // The SPA switches as last polled, also on a device that hides them (Autopilot runs), so the
    // pump turning SPA on is still seen.
    private spaSeen = new Map<string, any>();
    private indoorTimer: ReturnType<typeof setTimeout> | null = null;
    // When a selection was last applied. A Repair can move a register to another address (a
    // different zone or sensor), and the first read there is not a change made on the pump.
    private selectionAppliedAt = 0;
    private indoorWork: Promise<any> | null = null;
    private indoorStopped = false;
    private indoorStatus: any = {state: 'idle'};
    private indoorFailingSince: number | null = null;
    private indoorAlerted = false;

    async indoorSetupStatus() {
        const config = this.getStoreValue('indoorSensors') as IndoorConfig | undefined;
        return {...this.indoorStatus, config, enabled: await this.indoorRaw(5986),
            measured: await this.indoorCelsius(26), zone: await this.indoorCelsius(116)};
    }

    private async indoorRaw(address: number) {
        const raw = await this.connection?.readRegisterRaw({address, direction: Dir.In} as Register, false, 'write');
        return raw === undefined || isUnavailableRaw(raw) ? null : signedValue(raw);
    }

    private async indoorCelsius(address: number) {
        const raw = await this.indoorRaw(address);
        return raw === null ? null : raw / 10;
    }

    protected readIndoorSensors(config: IndoorConfig) { return selectedReadings(this.homey, config.sensors); }

    private async sendIndoor(config: IndoorConfig) {
        config = cleanIndoorConfig(config);
        const value = averageSensors(config, await this.readIndoorSensors(config));
        const register = this.profile.registerByName['external_temperature.h5987_bt50'];
        if (!register || !this.connection || this.indoorStopped) throw new Error('Heating feed is unavailable.');
        await this.connection.writeRegisterValue(register, encodeRegisterValue(register, value));
        let measured: number | null = null;
        for (let attempt = 0; attempt < 16; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 750));
            measured = await this.indoorRaw(26);
            if (measured === Math.round(value * 10)) break;
        }
        if (measured !== Math.round(value * 10))
            throw new Error(`BT50 confirmation is still pending. Sent ${value.toFixed(1)} °C; `
                + (measured === null ? 'no BT50 reading was returned.' : `the pump reports ${(measured / 10).toFixed(1)} °C.`)
                + ' The saved feed will retry in the background.');
        const selection = this.getSelection() ?? {groups: {}, overrides: {}};
        if (selection.addresses?.measure_temperature !== 26 || selection.overrides.measure_temperature !== true)
            await this.applySelection({...selection, addresses: {...selection.addresses, measure_temperature: 26},
                overrides: {...selection.overrides, measure_temperature: true}});
        this.indoorStatus = {state: 'active', sent: value, measured: measured / 10, deliveredAt: Date.now()};
        await this.unsetWarning();
        return this.indoorStatus;
    }

    // Persist before the first write. Closing Repair cannot cancel an established feed.
    // Replacements are validated while the previous configuration remains the durable fallback.
    async activateIndoor(raw: any) {
        if (this.role !== 'heating') throw new Error('Only Heating can supply BT50.');
        if (this.indoorWork) throw new Error('A temperature update is in progress. Please try again.');
        const owner = NibePumpDevice.indoorOwners.get(this.host());
        if (owner && owner !== this) throw new Error('Another Heating device already supplies this pump.');
        NibePumpDevice.indoorOwners.set(this.host(), this);
        const job = (async () => {
            const duplicate = (this.driver.getDevices() as any[]).some(d => d !== this
                && d.getSettings().address === this.host()
                && d.getStoreValue('indoorSensors')?.state === 'active');
            if (duplicate) throw new Error('Another Heating device already supplies this pump.');
            const config = cleanIndoorConfig(raw);
            averageSensors(config, await this.readIndoorSensors(config));
            if (await this.indoorRaw(5986) !== 1)
                throw new Error('Enable external BT50 on the heat pump before verifying.');
            const previous = this.getStoreValue('indoorSensors') as IndoorConfig | undefined;
            config.state = 'active';
            if (previous?.state !== 'active') {
                await this.setStoreValue('indoorNativeAddress', this.getSelection()?.addresses?.measure_temperature ?? 116);
                await this.setStoreValue('indoorSensors', config);
            }
            try {
                const status = await this.sendIndoor(config);
                await this.setStoreValue('indoorSensors', config);
                return status;
            } finally {
                this.scheduleIndoor();
            }
        })();
        this.indoorWork = job;
        try { return await job; } finally {
            this.indoorWork = null;
            if (this.getStoreValue('indoorSensors')?.state !== 'active') NibePumpDevice.indoorOwners.delete(this.host());
        }
    }

    async deactivateIndoor() {
        if (this.indoorWork) throw new Error('A temperature update is in progress. Please try again.');
        const job = (async () => {
            if (await this.indoorRaw(5986) !== 0)
                throw new Error('First select your NIBE sensor for the zone and disable external BT50 on the heat pump.');
            const selection = this.getSelection();
            if (selection) await this.applySelection({...selection, addresses: {...selection.addresses,
                measure_temperature: this.getStoreValue('indoorNativeAddress') ?? 116}});
            await this.unsetStoreValue('indoorSensors');
            if (this.indoorTimer) clearTimeout(this.indoorTimer);
            this.indoorTimer = null;
            NibePumpDevice.indoorOwners.delete(this.host());
            this.indoorStatus = {state: 'idle'};
            await this.unsetWarning();
        })();
        this.indoorWork = job;
        try { return await job; } finally { this.indoorWork = null; }
    }

    private scheduleIndoor() {
        if (this.indoorTimer) clearTimeout(this.indoorTimer);
        if (this.indoorStopped || this.getStoreValue('indoorSensors')?.state !== 'active') return;
        this.indoorTimer = setTimeout(() => {
            this.indoorTimer = null;
            if (this.indoorWork) { this.scheduleIndoor(); return; }
            this.indoorWork = this.sendIndoor(this.getStoreValue('indoorSensors'))
                .then(() => { this.indoorFailingSince = null; this.indoorAlerted = false; })
                .catch(async (error) => {
                    this.indoorStatus = {state: 'error', message: error.message};
                    // A missed cycle or two is routine (a slow Homey API call, a pump reconnect) and the
                    // next one recovers. Warn and notify once, only when the feed has stayed down.
                    if (this.indoorFailingSince === null) {
                        this.indoorFailingSince = Date.now();
                        this.log('Indoor feed update failed, retrying:', error.message);
                    }
                    if (this.indoorAlerted || Date.now() - this.indoorFailingSince < INDOOR_ALERT_AFTER_MS) return;
                    this.indoorAlerted = true;
                    await this.setWarning(error.message).catch(this.error);
                    await this.homey.notifications.createNotification({
                        excerpt: 'Nibe Live: indoor temperature feed needs attention. Open Heating → Repair. ' + error.message
                    }).catch(this.error);
                }).finally(() => { this.indoorWork = null; this.scheduleIndoor(); });
        }, 30000);
    }

    private async stopIndoor() {
        this.indoorStopped = true;
        if (this.indoorTimer) clearTimeout(this.indoorTimer);
        this.indoorTimer = null;
        await this.indoorWork?.catch(() => {});
        if (this.role === 'heating' && NibePumpDevice.indoorOwners.get(this.host()) === this) NibePumpDevice.indoorOwners.delete(this.host());
    }

    // Energy bucket (function roles only). Charged by the connection's allocator.
    private cumulativeEnergy = 0;

    // Last seen alarm code, so the trigger fires once per new alarm rather than every poll.
    // Undefined until the first read — a standing alarm at startup is reflected but not
    // announced as if it had just occurred.
    private lastAlarmCode: number | undefined = undefined;

    private host(): string {
        return this.getSettings().address;
    }

    // Verbose logging, off by default. Without it the app logs only the things a user acts on
    // — pairing/repair, Flow actions, manual changes and alarms — so a log dump stays readable.
    // Turn on "Debug logging" (Advanced settings) for polling, connection and energy detail.
    private debugLoggingOverride?: boolean;

    onDiagnosticSummary(summary: CaptureSummary) {
        if (this.role !== 'main') return;
        void this.setStoreValue('fDiagnosticSummary', summary).catch(this.error);
    }

    debugEnabled(): boolean {
        return this.debugLoggingOverride ?? !!this.getSettings().debugLogging;
    }

    protected debug(...args: any[]) {
        if (this.debugEnabled())
            this.log(...args);
    }

    // Transport for this device: the model defaults, optionally overridden by per-device
    // port/unit-id settings (F gateways). S has no such settings → falls back to 502/1.
    private transport(settings = this.getSettings()): Transport {
        return {
            port: settings.port || this.profile.transport.port,
            unitId: settings.unitId || this.profile.transport.unitId,
            addressBase: this.profile.addressModes?.[settings.addressMode]?.addressBase ?? this.profile.addressBase
        };
    }

    private options(name: string): any {
        return (this.profile.compose.capabilitiesOptions as any)[name];
    }

    private getSelection(): Selection | null {
        return (this.getStoreValue('selection') ?? null) as Selection | null;
    }

    // One-shot and idempotent: rewrite the stored selection's keys for registers this model has
    // renamed. A device with no stored selection has everything enabled and nothing to carry.
    private async migrateRenamedRegisters() {
        const selection = this.getSelection();
        if (!selection)
            return;
        const migrated = migrateSelection(selection, this.profile.renamedRegisters);
        if (migrated === selection)
            return;
        this.log('Migrating stored selection onto renamed registers: '
            + Object.entries(this.profile.renamedRegisters ?? {})
                .map(([from, to]) => `${from} -> ${to}`).join(', '));
        await this.setStoreValue('selection', migrated).catch(this.error);
    }

    // Hand a moved feature group's selection from the device it left to the device it joined
    // (see movedGroups). Devices of one pump initialise in no guaranteed order, so both ends try
    // and whichever comes second completes it:
    //   - the destination adopts from the source if the source exists yet, and otherwise stores
    //     the group as off, flagged 'default' — the status quo for an owner without that device;
    //   - the source pushes its state to a destination that has no key yet or only the default.
    // A Repair on the destination flags it 'set', after which nothing overwrites the owner's choice.
    private async migrateMovedGroups() {
        for (const move of movedGroups) {
            if (this.role === move.to) {
                const selection = this.getSelection();
                if (!selection || selection.groups?.[move.group] !== undefined)
                    continue;
                const source = this.sibling(move.from);
                await this.adoptMoved(move, source ? source.getStoreValue('selection') ?? null : undefined);
            } else if (this.role === move.from) {
                const target = this.sibling(move.to);
                const pending = target?.getStoreValue(`moved.${move.group}`) === 'default'
                    || (target?.getStoreValue('selection')
                        && target.getStoreValue('selection').groups?.[move.group] === undefined);
                if (target && pending)
                    await target.adoptMoved(move, this.getSelection()).catch(this.error);
            }
        }
    }

    async adoptMoved(move: GroupMove, source: Selection | null | undefined) {
        const selection = this.getSelection();
        if (!selection)
            return;
        const next = adoptMovedGroup(this.profile, selection, source, move.group);
        this.log(`Moving the ${move.group} selection from ${move.from} to ${move.to}: `
            + (source === undefined ? `no ${move.from} device, so it stays off` : `${next.groups[move.group] ? 'on' : 'off'}, as on ${move.from}`));
        await this.setStoreValue('selection', next);
        await this.setStoreValue(`moved.${move.group}`, source === undefined ? 'default' : 'adopted');
        // Before this device's own onInit has synced, that sync will pick the selection up.
        if (this.capabilitiesSynced)
            await this.syncCapabilities();
    }

    private sibling(role: Role): any {
        return (this.driver.getDevices() as any[]).find((device) => device !== this
            && device.getSettings?.().address === this.host() && roleOf(device.getData()) === role);
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
        if (isUnavailableRaw(raw, register.size, register.unavailableRaw))
            return null;
        let value = register.signed === false ? raw : signedValue(raw, register.size);
        if (register.scale)
            return value / register.scale;
        // Picker before enum, because a register can carry both: the operating mode is a picker
        // capability (whose own definition holds the labels) while still needing `enum` so the
        // mode-specific Flow cards can build their autocomplete. Checking enum first returned the
        // label where the capability wanted the raw id — "Manual" against "Expected: 0,1,2".
        if (register.picker)
            return "" + value;
        if (register.enum) {
            if (register.enum[value] === undefined)
                this.noteUnnamedCode(register, value);
            return enumLabel(register, value, (key) => this.homey.__(key));
        }
        if (register.bool)
            return value !== (register.offValue ?? 0);
        return value;
    }

    private toRegisterValue(register: Register, value: unknown) {
        return encodeRegisterValue(register, value);
    }

    // Resolves the address for the same reason writeRegister() does — and it has to, because the
    // two are used as a pair. Every Flow card that writes then reads back to confirm
    // (writeNumeric, the .onoff and enable/disable cards) went through writeRegister here and
    // readRegister there, so on a pump where detection relocated a register the write landed at
    // the resolved address and the confirmation read the *unresolved* one. That reads the wrong
    // register — or nothing — and the card then reports a failure for a write that worked.
    async readRegister(register: Register): Promise<any> {
        if (!this.connection)
            return undefined;
        const address = resolvedAddress(register, this.getSelection());
        const raw = await this.connection.readRegisterRaw({...register, address}, true, 'write');
        return raw === undefined ? undefined : this.fromRegisterValue(register, raw);
    }

    // The address is resolved here rather than baked into the register when the capability
    // listener was created: listeners are registered once at init, but a repair can re-run
    // detection and move a relocated register, and reading the selection at write time picks
    // that up without a restart.
    async writeRegister(register: Register, value: any): Promise<void> {
        if (this.profile.readOnly) throw new Error("This driver is currently read-only.");
        if (register.name === 'external_temperature.h5987_bt50' && this.getStoreValue('indoorSensors')?.state === 'active')
            throw new Error('BT50 is managed by the automatic indoor sensor feed.');
        if (register.name === this.profile.autopilotFeed?.bt1 && this.heatingFeed?.running)
            throw new Error('BT1 is managed by Autopilot heating.');
        if (register.role && register.role !== this.role)
            throw new Error('This action is not available for this device');
        if (!this.connection)
            throw new Error('Not connected to the heat pump');
        if (register.noAction && !register.writeOnly)
            throw new Error('This register is read-only');
        const room = this.profile.roomThermostat;
        if (room && (register.name === room.target || (register.name === room.enabled && value === true))) {
            const sensor = await this.readRegister(this.profile.registerByName[room.sensor]);
            if (typeof sensor !== 'number' || sensor < 5 || sensor > 40)
                throw new Error('A working indoor sensor is required for room temperature control.');
            if (register.name === room.target && await this.readRegister(this.profile.registerByName[room.enabled]) !== true)
                throw new Error('Room regulation is disabled. Adjust the heating curve instead.');
        }
        const requirement = this.profile.writeRequirements?.[register.name];
        if (requirement && !requirement.values.includes(Number(await this.readRegister(this.profile.registerByName[requirement.register]))))
            throw new Error(inLanguage(requirement.message, this.homey.i18n.getLanguage()));
        try {
            const raw = this.toRegisterValue(register, value);
            const canonical = this.fromRegisterValue(register, raw);
            for (const mirror of mirrorsForRole(this.profile, this.role)) {
                if (mirror.register !== register.name || !mirror.writable)
                    continue;
                const problem = mirror.validate?.(value, (name) => this.getCapabilityValue(name));
                if (problem)
                    throw new Error(inLanguage(problem, this.homey.i18n.getLanguage()));
            }
            const address = resolvedAddress(register, this.getSelection());
            await this.connection.writeRegisterValue({...register, address}, raw);
            if (!register.writeOnly) {
                // Verify on the write lane, so confirmation cannot sit behind a full poll.
                let confirmed = false;
                for (let attempt = 0; attempt < 3; attempt++) {
                    const actual = await this.readRegister(register);
                    if (actual === canonical) {
                        confirmed = true;
                        break;
                    }
                    if (attempt < 2)
                        await new Promise((resolve) => setTimeout(resolve, this.profile.writeReadbackIntervalMs ?? 100));
                }
                if (!confirmed)
                    throw new Error('The pump did not confirm the requested value');
                this.recentWrites.set(register.name, {value: canonical, at: Date.now()});
                await this.setValue(register, canonical);
                await this.applyClearOnDisable(register, canonical);
            }
        } catch (error: any) {
            // Surface a clear, user-facing message instead of failing silently.
            throw new Error(`Could not set "${this.registerTitle(register)}": ${error?.message ?? error}`);
        }
    }

    // See profile.role.clearOnDisable: the complement to connection.ts's priority-change reset
    // rules, for the case those can never fire — the pump never makes the transition on its own
    // once Homey has already cut the function off. Cheap to call unconditionally from every
    // writable register's listener; only ever does anything for a bool register turned off that
    // the profile actually names.
    private async applyClearOnDisable(register: Register, value: any) {
        if (!register.bool || value !== false)
            return;
        for (const rule of this.profile.role.clearOnDisable ?? []) {
            if (rule.register !== register.name)
                continue;
            for (const name of rule.clears) {
                const target = this.profile.registerByName[name];
                if (!target || !this.hasCapability(target.name))
                    continue;
                if (this.getCapabilityValue(target.name) === false)
                    continue; // already off — nothing to clear
                this.log(`${register.name} disabled — also clearing ${target.name}`);
                await this.writeRegister(target, false)
                    .catch((error) => this.error(`Failed to clear ${target.name} after disabling ${register.name}`, error));
            }
        }
    }

    private get alarmTrigger() {
        return this.homey.flow.getDeviceTriggerCard((this.profile.flowPrefix ?? "") + "alarm_occurred");
    }
    private get priorityChangedTrigger() {
        return this.homey.flow.getDeviceTriggerCard((this.profile.flowPrefix ?? "") + "priority_changed");
    }
    private get capabilityChangedTrigger() {
        return this.homey.flow.getDeviceTriggerCard((this.profile.flowPrefix ?? "") + "capability_changed");
    }
    private get hotwaterDroppedTrigger() {
        return this.homey.flow.getDeviceTriggerCard((this.profile.flowPrefix ?? "") + "hotwater_volume_dropped_below");
    }
    private get turnedOnTrigger() {
        return this.homey.flow.getDeviceTriggerCard((this.profile.flowPrefix ?? "") + "capability_turned_on");
    }
    private get turnedOffTrigger() {
        return this.homey.flow.getDeviceTriggerCard((this.profile.flowPrefix ?? "") + "capability_turned_off");
    }

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
        // .catch on every one of these, like alarmTrigger and priorityChangedTrigger already do:
        // trigger() returns a promise, and a Flow whose card throws would otherwise surface as an
        // unhandled rejection from inside a poll rather than a line naming the register.
        //
        // Analytics get which trigger fired and for which register, never the reading. The
        // register name is a fact about the model; the value would be a timestamped record of when
        // the compressor ran and when someone drew hot water — not what the consent box asks for.
        const report = (card: string) => track('Fired WHEN Card', {
            card, register: register.name, role: this.role
        });
        if (register.bool && value) {
            report('capability_turned_on');
            this.turnedOnTrigger.trigger(this, {register: name}, state).catch(this.error);
        } else if (register.bool && !value) {
            report('capability_turned_off');
            this.turnedOffTrigger.trigger(this, {register: name}, state).catch(this.error);
        } else if (register.enum) {
            report('capability_changed');
            this.capabilityChangedTrigger.trigger(this, {value: `${value}`, register: name}, state)
                .catch(this.error);
        }
    }

    // A register with its own "<name>.changed" card fires it with the new value: a mode's label
    // (operating mode, fan mode) or a number (heat curve displacement). These replace the generic
    // "Register changed" card, which most devices offered for a single register. Only stepwise
    // registers get one, so it fires per change and stays out of the poll-loop firehose
    // docs/analytics.md warns of. A missing old value is the first reading of a new device, a
    // "now known", not a change.
    private checkChangedTrigger(register: Register, oldValue: any, value: any) {
        const id = register.name + ".changed";
        if (oldValue === null || oldValue === undefined
            || !this.profile.compose.triggers.some((card: any) => card.id === id))
            return;
        let token: string | number;
        if (register.enum) {
            // A picker holds the raw id ("0"), an enum capability its label already.
            token = register.picker
                ? enumLabel(register, Number(value), (key) => this.homey.__(key)) : `${value}`;
        } else {
            token = Number(value);
            if (!Number.isFinite(token))
                return;
        }
        track('Fired WHEN Card', {card: id, register: register.name, role: this.role});
        this.homey.flow.getDeviceTriggerCard((this.profile.flowPrefix ?? "") + id)
            .trigger(this, {value: token}).catch(this.error);
    }

    // Pickers whose current pump value is outside the shortlist they offer, so the warning is
    // logged once per register rather than on every poll.
    private unlistedPickerValues = new Set<string>();

    // Enum codes the register table has no name for, keyed by register AND code so a pump that
    // later moves to a second unknown code still says so once — the code is the whole point of
    // the line, since naming it is the fix.
    private unnamedEnumCodes = new Set<string>();

    private noteUnnamedCode(register: Register, value: number) {
        const seen = `${register.name}:${value}`;
        if (this.unnamedEnumCodes.has(seen))
            return;
        this.unnamedEnumCodes.add(seen);
        this.log(`Register ${register.address} reads ${value}, which "${register.name}" has no `
            + `name for. Showing the bare code — add it to the register table's map to give it `
            + `one. Nibe adds codes per model and firmware, so this is a gap, not a fault.`);
    }

    // Values this app has just written, so the poll that reads them back is not mistaken for the
    // pump acting on its own. The timestamp lets an entry expire rather than suppressing a
    // genuine later change that happens to land on the same value.
    private recentWrites = new Map<string, {value: any; at: number}>();
    private static readonly WRITE_ECHO_MS = 30_000;
    // At most one pump-side line per register per this interval.
    private lastExternalNote = new Map<string, number>();
    private static readonly EXTERNAL_NOTE_MS = 10 * 60 * 1000;

    // Publish a register's value into any bare capability mirroring it (the thermostat tile and
    // Homey's Climate view read root ids, which the register itself cannot own — see `mirrors`
    // on ModelProfile). Separate capabilities with their own presence test, so this runs before
    // setValue()'s early return for a register this device doesn't carry.
    private async publishMirrors(register: Register, value: any) {
        for (const mirror of mirrorsForRole(this.profile, this.role)) {
            if (mirror.register !== register.name || !this.hasCapability(mirror.capability))
                continue;
            await this.setCapabilityValue(mirror.capability, value).catch(this.error);
        }
    }

    // A settable register that changed without this app writing it was changed by something
    // else: the pump's own schedule, its front panel, or myUplink. None of those are readable
    // over Modbus, and their absence from the log is what let a blocking schedule hide for a
    // day — every setting read correct, and nothing recorded that the pump had overridden them.
    //
    // Writes from Homey are already attributed at their own call sites ("Manual set …" from a
    // tile, "Flow: … set …" from a Flow card), so this is the third case and the only one the
    // app can otherwise not see.
    private noteExternalChange(register: Register, oldValue: any, value: any) {
        if (register.direction !== Dir.Out || oldValue === null || oldValue === undefined)
            return;
        // `noAction` marks a holding register that is a reading rather than a setting — Nibe puts
        // degree minutes in one — and nobody "changed" those, the pump just recomputed them.
        if (register.noAction)
            return;
        // Right after Repair the "old" value may belong to another address: switching the
        // thermostat from zone 1 to zone 2 logged zone 2's setpoint as a pump-side change.
        if (Date.now() - this.selectionAppliedAt < NibePumpDevice.WRITE_ECHO_MS)
            return;
        const ours = this.recentWrites.get(register.name);
        if (ours && ours.value === value && Date.now() - ours.at < NibePumpDevice.WRITE_ECHO_MS)
            return;
        // Rate limit whatever is left. A register that turns out to move on its own would
        // otherwise flood the log with one line per poll: degree minutes and its limit twin
        // produced a line a minute each until this was added, drowning the events worth seeing.
        const lastSaid = this.lastExternalNote.get(register.name) ?? 0;
        if (Date.now() - lastSaid < NibePumpDevice.EXTERNAL_NOTE_MS)
            return;
        this.lastExternalNote.set(register.name, Date.now());
        this.log(`Pump-side change: ${this.registerTitle(register)} (register ${register.address}) `
            + `went ${oldValue} -> ${value}, not set from Homey. A schedule, the pump's own panel `
            + `or myUplink can do this.`);
    }

    async setValue(register: Register, value: any) {
        await this.publishMirrors(register, value);
        const spa = this.profile.spaSwitches;
        if (spa && Object.values(spa).includes(register.name)) {
            const before = this.spaSeen.has(register.name) ? this.spaSeen.get(register.name) : null;
            this.spaSeen.set(register.name, value);
            if (value === true && before === false) this.spaSwitchedOn().catch(this.error);
        }
        if (register.writeOnly || !this.hasCapability(register.name))
            return;
        // A picker offers a curated shortlist; the register's domain is wider. Homey rejects an
        // enum value it was never told about, and the resulting throw happens on every poll for
        // as long as the pump holds that value. Leave the picker alone instead — none of its
        // options describe the truth — and say so once. The numeric twin of the same register
        // carries the real value, so nothing is actually hidden from the user.
        if (register.picker && register.pickerValues
            && !register.pickerValues.map(String).includes(String(value))) {
            if (!this.unlistedPickerValues.has(register.name)) {
                this.unlistedPickerValues.add(register.name);
                this.log(`Register ${register.address} reads ${value}, which "${register.name}" `
                    + `does not offer (${register.pickerValues.join(', ')}). Leaving that picker `
                    + `unset — the pump accepts values this shortlist does not list.`);
            }
            return;
        }
        this.unlistedPickerValues.delete(register.name);
        const oldValue = this.getCapabilityValue(register.name);
        await this.setCapabilityValue(register.name, value);
        if (oldValue !== value) {
            this.noteExternalChange(register, oldValue, value);
            this.checkTrigger(register, value);
            this.checkChangedTrigger(register, oldValue, value);
        }
    }

    private async ensureCapabilityOptions(name: string, option: any) {
        if (!option || !this.hasCapability(name))
            return;
        // getCapabilityOptions() throws "Invalid Capability" for a capability instance that has
        // no options stored yet (the COP sensors, when a device was created without them). Don't
        // give up in that case — fall through and set them (which is what creates them). Freshly
        // paired devices now carry these options from the start (deviceTemplate), so this path is
        // only the self-heal for devices paired before that.
        let current: any = null;
        try {
            current = this.getCapabilityOptions(name) ?? {};
        } catch {
            current = null;
        }
        if (current) {
            const differs = Object.keys(option).some(
                (key) => JSON.stringify(current[key]) !== JSON.stringify(option[key]));
            if (!differs)
                return;
        }
        await this.setCapabilityOptions(name, option)
            .catch((error) => this.log(`Could not set options for ${name} — ${error?.message ?? error}`));
    }

    // Per-instance options for the non-register energy/COP capabilities (same capability id,
    // role-specific title — which the shared compose file can't express).
    private extraOptions(name: string): any {
        return mirrorOptions(this.profile, this.role, name)
            ?? extraCapabilityOptions(this.role, name, this.profile);
    }

    // ---- Rolling 30-day COP -------------------------------------------------------------
    private static readonly COP_WINDOW_MS = 30 * 24 * 3600 * 1000;
    private static readonly COP_SNAPSHOT_MS = 6 * 3600 * 1000;
    private copProduced: number | null = null;
    private copUsed: number | null = null;

    // ---- Keeping the COP's two halves over the same span ---------------------------------
    // A function's COP divides delivered energy by electricity used. Those came from sources
    // that measure different spans of time: the produced counter is the pump's own and runs
    // whether or not we are watching, while `cumulativeEnergy` only advances when the app is
    // running AND a power source reads. Divide one by the other and the ratio is inflated by
    // however long the pump ran unobserved.
    //
    // That is not theoretical. On a pump with no register 2166 the allocator measured nothing
    // at all until the 2305 fallback shipped, so weeks of produced energy met hours of measured
    // consumption: 40 kWh / 2.64 kWh = 15.15, reported as a hot water "COP" of 14.96. Cooling
    // came out at 10.17 the same way.
    //
    // So the numerator gets its own accumulator that only advances on polls where the allocator
    // could measure — the same condition the denominator already obeys. `lastProducedSeen`
    // resets whenever measurement stops (including app restart, since it starts null), which is
    // what keeps energy accrued during a blind stretch from ever being counted.
    //
    // Main is deliberately untouched: it divides 3821 by 3823, two pump counters that advance
    // together, and that symmetry is exactly what the function roles lack.
    private copProducedAccum = 0;
    private persistedProducedAccum = 0;
    private lastProducedSeen: number | null = null;
    private lastProducedAddress?: number;
    private allocationLive = false;

    // --- Hot water available, in litres -------------------------------------------------
    //
    // Two cached sensor readings and the tank the user picked. That is the entire state: an earlier
    // design also watched the pump's delivered-energy counter across charge cycles to measure the
    // tank and how it divides between the sensors, and neither survived contact with hardware — see
    // lib/hotwater.ts and docs/hot-water-estimate.md.
    private tankTopC: number | null = null;
    private tankLowerC: number | null = null;
    private lastPublishedLitres: number | null = null;

    // Range-checked here as well as in the driver's cleanSelection(), because the two arrive by
    // different routes: repair goes through the driver, but pairing writes the store value
    // client-side via Homey.createDevice() and never passes through a server-side validator.
    private tankConfig(): {tankId: string; litres: number | null; inletC: number} {
        const stored = this.getSelection()?.hotwater;
        const litres = Number(stored?.litres);
        const inletC = Number(stored?.inletC);
        return {
            tankId: stored?.tankId ?? 'none',
            litres: Number.isFinite(litres) && litres >= MIN_TANK_LITRES && litres <= MAX_TANK_LITRES
                ? litres : null,
            // Learned in preference to guessed. `inletC` in the selection is a stored override that
            // nothing writes any more — the picker used to ask for this and no longer does, because
            // almost nobody knows their mains temperature. Honoured if present so a device
            // configured by the old picker keeps its answer.
            inletC: Number.isFinite(inletC) && inletC >= 0 && inletC < MIX_C
                ? inletC
                : (this.learnedInlet() ?? DEFAULT_INLET_C)
        };
    }

    // --- the cold-water inlet, observed rather than asked for ---------------------------
    private coldDay: number | null = null;
    private coldDayMin: number | null = null;

    private coldSamples(): ColdSample[] {
        const stored = this.getStoreValue('coldSamples');
        return Array.isArray(stored)
            ? stored.filter((s: any) => typeof s?.day === 'number' && typeof s?.minC === 'number')
            : [];
    }

    private learnedInlet(): number | null {
        return learnedInletC(this.coldSamples(), dayNumber(Date.now()));
    }

    // Track the day's low-water mark on the lower tank sensor, and roll it into the window when
    // the day turns. Persisted once a day rather than per poll: this is a flash write, and the
    // figure it feeds moves over weeks.
    private noteColdWater(value: number) {
        const today = dayNumber(Date.now());
        if (this.coldDay === null) {
            this.coldDay = today;
            this.coldDayMin = value;
            return;
        }
        if (today === this.coldDay) {
            if (this.coldDayMin === null || value < this.coldDayMin)
                this.coldDayMin = value;
            return;
        }
        const finished = {day: this.coldDay, minC: this.coldDayMin ?? value};
        this.coldDay = today;
        this.coldDayMin = value;
        const kept = [...this.coldSamples().filter((s) => s.day !== finished.day), finished]
            .filter((s) => today - s.day < COLD_WINDOW_DAYS)
            .sort((a, b) => a.day - b.day);
        this.setStoreValue('coldSamples', kept).catch(this.error);
        this.debug(`Hot water: cold-water inlet estimated at ${learnedInletC(kept, today) ?? '?'} °C `
            + `(lowest the bottom sensor reached across ${kept.length} days)`);
        this.publishTankState();
    }

    // Two read-only rows: the tank the owner told us, and the inlet we worked out. Both are inputs
    // to the litres figure, so a figure that looks wrong has no invisible terms behind it.
    private publishTankState() {
        const {litres} = this.tankConfig();
        const tank = litres === null
            ? this.homey.__('hotwater.tank_setup')
            : `${Math.round(litres)} L`;
        const learned = this.learnedInlet();
        const inlet = learned === null
            ? `${DEFAULT_INLET_C} °C (${this.homey.__('hotwater.inlet_assumed')})`
            : `${learned} °C`;
        for (const device of this.driver.getDevices() as any[]) {
            if (device.getSettings?.().address !== this.host())
                continue;
            const current = device.getSettings();
            // Guarded: setSettings writes to flash, and this is reached whenever a day rolls.
            if (current.hotwater_tank === tank && current.hotwater_inlet === inlet)
                continue;
            device.setSettings({hotwater_tank: tank, hotwater_inlet: inlet}).catch(this.error);
        }
    }

    private updateHotwaterVolume() {
        if (!this.hasCapability(HOTWATER_VOLUME_CAPABILITY))
            return;
        const {litres, inletC} = this.tankConfig();
        if (litres === null || this.tankTopC === null || this.tankLowerC === null) {
            this.lastPublishedLitres = null;
            this.setCapabilityValue(HOTWATER_VOLUME_CAPABILITY, null).catch(this.error);
            return;
        }
        const available = usableLitres(litres, this.tankTopC, this.tankLowerC, inletC);
        if (available === null)
            return;
        const rounded = Math.round(available * 10) / 10;
        const previous = this.lastPublishedLitres;
        this.lastPublishedLitres = rounded;
        this.setCapabilityValue(HOTWATER_VOLUME_CAPABILITY, rounded).catch(this.error);
        if (previous !== null && rounded < previous)
            this.fireHotwaterDropped(previous, rounded);
    }

    // First run on a version that has the accumulator: the stored copSamples pair an absolute
    // pump counter with an app-accumulated series and cannot be reconciled with it, so they are
    // discarded rather than migrated. The COP goes blank and rebuilds within a day or two —
    // better than continuing to publish a number we know to be wrong.
    private async loadCopAccumulator() {
        const stored = this.getStoreValue('copProducedAccum');
        if (typeof stored === 'number') {
            this.copProducedAccum = stored;
            this.persistedProducedAccum = stored;
            return;
        }
        this.copProducedAccum = 0;
        this.persistedProducedAccum = 0;
        await this.setStoreValue('copProducedAccum', 0).catch(this.error);
        if ((this.getStoreValue('copSamples') ?? []).length) {
            this.log('Discarding COP history: it was measured against the pump\'s own counter, '
                + 'which keeps running while the app cannot. The COP will rebuild over the next '
                + 'day or two.');
            await this.setStoreValue('copSamples', []).catch(this.error);
        }
    }

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
        const canonical = this.profile.registerByName[register.name];
        const suffix = canonical && register.address !== canonical.address ? '.' + register.address : '';
        const key = `baseline.${register.name}${suffix}`;
        let baseline = this.getStoreValue(key);
        if (typeof baseline !== 'number') {
            baseline = value;
            this.setStoreValue(key, baseline).catch(this.error);
        }
        return value - baseline;
    }

    // Reconcile the device's capabilities with its selection. Returns the capabilities that
    // failed, so a repair can tell the user rather than claiming success it didn't have.
    //
    // Every step here still continues past a failure — one capability the SDK won't add must not
    // abandon the twenty after it, and at onInit there is nobody to tell anyway. What changed is
    // that the failures are no longer only logged: repair used to report success unconditionally
    // while the device silently lacked exactly the capabilities the user had just ticked.
    private async syncCapabilities(): Promise<string[]> {
        const selection = this.getSelection();
        const {registers: roleRegs, extras, toRemove} =
            capabilitySyncPlan(this.profile, this.role, selection, this.getCapabilities(), this.capabilitySmartMode());
        const failed: string[] = [];
        const note = (name: string, what: string) => (error: any) => {
            this.error(`Failed to ${what} capability ${name}:`, error);
            if (!failed.includes(name))
                failed.push(name);
        };

        for (const name of toRemove) {
            this.debug(`Removing capability ${name}`);
            await this.removeCapability(name).catch(note(name, 'remove'));
        }

        for (const register of roleRegs) {
            if (!this.hasCapability(register.name)) {
                this.debug(`Adding capability ${register.name}`);
                await this.addCapability(register.name).catch(note(register.name, 'add'));
            }
            await this.ensureCapabilityOptions(register.name, this.options(register.name))
                .catch(note(register.name, 'set options on'));
        }
        for (const extra of extras) {
            if (!this.hasCapability(extra)) {
                this.debug(`Adding capability ${extra}`);
                await this.addCapability(extra).catch(note(extra, 'add'));
            }
            await this.ensureCapabilityOptions(extra, this.extraOptions(extra))
                .catch(note(extra, 'set options on'));
        }
        if (this.profile.roomThermostat && this.role === 'heating') {
            const wanted = deviceClass(this.profile, this.role, selection);
            if (this.getClass() !== wanted) await this.setClass(wanted as any).catch(note('class', 'set'));
            if (this.hasCapability('target_temperature')) {
                const source = this.profile.registerByName[this.profile.roomThermostat.target];
                this.registerCapabilityListener('target_temperature', async (value) => this.writeRegister(source, value));
                const value = this.getCapabilityValue(source.name);
                if (typeof value === 'number') await this.setCapabilityValue('target_temperature', value);
            }
        }
        return failed;
    }

    async applySelection(selection: Selection) {
        this.log("Applying selection", JSON.stringify(selection));
        this.selectionAppliedAt = Date.now();
        await this.setStoreValue('selection', selection);
        // The owner has now chosen moved groups here themselves; no handover may overwrite that.
        for (const move of movedGroups)
            if (this.role === move.to && selection.groups?.[move.group] !== undefined)
                await this.setStoreValue(`moved.${move.group}`, 'set');
        const failed = await this.syncCapabilities();
        if (this.hasCapability(METER_CAPABILITY))
            await this.setCapabilityValue(METER_CAPABILITY, this.cumulativeEnergy).catch(this.error);
        // A repair can change the tank, and everything downstream of it is now stale: the litres
        // and the settings labels. Without this the capability appeared and published correctly
        // while the settings still read "Pick your tank in Repair" — exactly the sort of
        // contradiction that makes an app look broken.
        if (this.role === 'hotwater' && this.profile.hotwaterTank) {
            this.publishTankState();
            this.updateHotwaterVolume();
        }
        if (failed.length)
            throw new Error(`${failed.length} capability/capabilities could not be applied: `
                + `${failed.join(', ')}. The selection was saved — try Repair again, and if it `
                + 'keeps failing please report it with the app logs.');
    }

    async probeForDetection(onProgress: (pass: number, passes: number) => void, signal?: AbortSignal) {
        if (!this.connection || !this.getAvailable())
            throw new Error(this.homey.__("pair.not_connected"));
        return this.connection.probe(onProgress, signal);
    }

    async onInit() {
        this.role = roleOf(this.getData());
        // Before anything reads the selection: carry it across any register this model has
        // renamed, so an upgraded device keeps its overrides and its resolved addresses.
        await this.migrateRenamedRegisters();
        await this.migrateMovedGroups().catch(this.error);
        this.debug(`Device init: role ${this.role}, host ${this.host()}, groups [${this.enabledGroupsSummary()}]`);

        const wantedClass = deviceClass(this.profile, this.role, this.getSelection());
        if (this.getClass() !== wantedClass) {
            this.debug(`Updating device class: ${this.getClass()} -> ${roleClass[this.role]}`);
            await this.setClass(wantedClass as any).catch(this.error);
        }

        if (this.role === 'solar')
            await this.setEnergy({meterPowerExportedCapability: SOLAR_METER_CAPABILITY}).catch(this.error);

        if (functionRoles.includes(this.role) || this.role === 'main') {
            this.cumulativeEnergy = this.getSettings().cumulativeEnergy || 0;
            this.persistedCumulativeEnergy = this.cumulativeEnergy;
            // Tidy a total stored before it was rounded. persistCumulativeEnergy() only writes
            // once the figure has moved 0.01 kWh, so an idle device would otherwise keep showing
            // the full float for as long as it stays idle. Guarded, so this is a no-op after the
            // first start rather than a flash write on every one.
            const tidy = Math.round(this.cumulativeEnergy * 1000) / 1000;
            if (tidy !== this.cumulativeEnergy)
                await this.setSettings({cumulativeEnergy: tidy}).catch(this.error);
        }
        if (functionRoles.includes(this.role)) {
            this.copUsed = this.cumulativeEnergy;
            await this.loadCopAccumulator();
        }
        // Restore the measured tank. The cycles themselves are persisted, so a restart costs the
        // estimate nothing — unlike the COP numerator, which deliberately cannot carry across one.
        // The distinction is that a cycle is a completed, self-contained measurement, whereas the
        // COP accumulator is an open integral against a counter that keeps running while the app
        // is down.
        if (this.role === 'hotwater' && this.profile.hotwaterTank)
            this.publishTankState();
        // Re-render the alarm line from the stored log. It is otherwise written only when a NEW
        // alarm arrives, so a device that has been quiet for weeks keeps whatever format it was
        // last written in — and a change to renderAlarmLine would never reach it.
        this.republishAlarmLine();
        // The consent checkbox in device settings is a VIEW of the app-level answer, which is the
        // single source of truth every track() reads. Mirror it in at init so the box shows what
        // is actually true — including for a device paired before the box existed, or one whose
        // sibling flipped it.
        this.syncConsentFromApp();

        // Capability setup can fail on an individual device (a capability RPC error, a
        // stale capability type, etc.). Catch it so onInit still reaches attach() below:
        // a throw here used to leave the device unsubscribed from the pump connection, and
        // the allocator then silently charged its draw to Main/idle instead of its own
        // meter — the root cause of the inflated "idle energy".
        try {
            // Failures are already logged by syncCapabilities(); at init there is no user
            // waiting on an answer, so unlike applySelection() this does not escalate them.
            await this.syncCapabilities();
            this.capabilitiesSynced = true;
            this.debug(`Device capabilities synced:${this.getCapabilities().length} — `
                + this.getCapabilities().join(', '));

            if (this.hasCapability(METER_CAPABILITY))
                await this.setCapabilityValue(METER_CAPABILITY, this.cumulativeEnergy).catch(this.error);

            for (const register of roleRegisters(this.profile, this.role)) {
                if (register.direction === Dir.Out && !register.noAction) {
                    this.registerCapabilityListener(register.name, async (value) => {
                        this.log(`Manual set ${register.name} = ${value}`);
                        await this.writeRegister(register, value);
                        // After the write, so the event means the value changed rather than that
                        // someone tried. A capability listener only fires for a set from outside
                        // the app — the tile, the mobile app, the web API; polls write through
                        // setValue() and do not come through here. So this is a hand on a control.
                        track('Changed Capability', {capability: register.name, role: this.role});
                    });
                }
            }

            // A writable mirror is the same setting as its source register, reached through the
            // bare capability the thermostat tile renders. Forward the write, then update the
            // source capability too so the tile's dial and the named row underneath never
            // disagree while waiting for the next poll.
            for (const mirror of mirrorsForRole(this.profile, this.role)) {
                const source = this.profile.registerByName[mirror.register];
                if (!mirror.writable || !source || !this.hasCapability(mirror.capability))
                    continue;
                this.registerCapabilityListener(mirror.capability, async (value) => {
                    // Validated before the write, not after: the tile makes an invalid value one
                    // gesture away, and the pump would accept a crossed band without complaint.
                    const problem = mirror.validate?.(value,
                        (name) => this.getCapabilityValue(name));
                    if (problem)
                        throw new Error(inLanguage(problem, this.homey.i18n.getLanguage()));
                    this.log(`Manual set ${mirror.capability} (${mirror.register}) = ${value}`);
                    await this.writeRegister(source, value);
                    track('Changed Capability', {capability: mirror.capability, role: this.role});
                });
            }

            // Main's on/off is the bare `onoff`, pinned ON: the pump is always operating and has
            // no whole-pump on/off command. It is declared not settable (see
            // extraCapabilityOptions), so there is nothing to listen for — it just holds its
            // value. Function devices are different: their on/off is a real writable enable
            // register whose listener is wired above.
            if (this.role === 'main' && this.hasCapability(PUMP_ACTIVE_CAPABILITY))
                await this.setCapabilityValue(PUMP_ACTIVE_CAPABILITY, true).catch(this.error);

            // The day type is household state in an app setting; the capability only shows and
            // sets it. Registered whether or not the device carries it yet, like the registers
            // above, so turning Autopilot on later needs no restart.
            if (this.role === 'main' && this.profile.autopilotHotwater) {
                this.registerCapabilityListener(DAY_TYPE_CAPABILITY, async (value) => {
                    this.log(`Day type set to ${value}`);
                    await (this.driver as any).setDayType(value);
                });
                await this.showDayType();
            }
            // Autopilot heating's own controls: registered whether or not the device carries them.
            if (this.role === 'heating' && this.profile.autopilotFeed) {
                this.registerCapabilityListener(AUTOPILOT_RANGE_CAPABILITY, async (value) => {
                    this.log(`Comfort range set to ${value}`);
                });
                this.registerCapabilityListener(AUTOPILOT_AWAY_CAPABILITY, async (value) => this.setAutopilotAway(value === true));
                this.registerCapabilityListener(AUTOPILOT_AWAY_TEMPERATURE_CAPABILITY, async (value) => {
                    this.log(`Away temperature set to ${value}`);
                    if (this.autopilotAway()) await this.setThermostat(Number(value));
                });
                await this.initAutopilotControls();
            }
        } catch (err) {
            this.error('Capability setup failed in onInit; attaching to the pump anyway so '
                + 'this device still receives its energy allocation', err);
        }

        if (this.role === 'main' && this.profile.diagnosticSweep && this.debugEnabled()) {
            const retained = this.getStoreValue('fDiagnosticSummary') as CaptureSummary | undefined;
            if (retained?.registers) {
                this.log('Retained F diagnostic capture from before restart:');
                logCaptureSummary(retained, (line) => this.log(line));
            }
        }
        this.connection = PumpConnection.get(this.host(), this.profile, this.transport());
        this.connection.attach(this);
        if (this.role === 'heating') {
            this.indoorStopped = false;
            if (this.getStoreValue('indoorSensors')?.state === 'active') {
                const owner = NibePumpDevice.indoorOwners.get(this.host());
                if (owner && owner !== this) {
                    this.indoorStopped = true;
                    await this.setWarning('Another Heating device already supplies this pump.');
                } else NibePumpDevice.indoorOwners.set(this.host(), this);
            }
            this.scheduleIndoor();
            await this.startAutopilotHistory().catch(this.error);
            if (this.getStoreValue('indoorSensors')?.state === 'pending')
                await this.setWarning('Finish your Homey sensor setup in Heating → Repair.');
        }
        if (this.role === 'hotwater') await this.syncHotwaterAutopilot().catch(this.error);
    }

    /** This function's Smart mode, stored on its own device (Heating or Hot water). */
    smartMode(): SmartMode {
        return smartMode(this.getStoreValue(SMART_MODE_STORE));
    }

    /** The Smart mode of one of this pump's functions, from its device; Off without one. */
    private smartModeOf(fn: SmartFunction): SmartMode {
        const device = this.role === fn ? this : this.sibling(fn);
        return device ? device.smartMode() : 'off';
    }

    /** Autopilot hot water for this pump: off, a test run, or live, from hot water's Smart mode. */
    autopilotMode(): 'off' | HotwaterMode {
        const mode = this.smartModeOf('hotwater');
        return mode === 'test' ? 'shadow' : mode === 'autopilot' ? 'live' : 'off';
    }

    /** Whether this device's function has a Smart mode: heating, hot water, pool and cooling. */
    private smartFunction(): SmartFunction | undefined {
        const fn = this.role as SmartFunction;
        return fn === 'heating' || fn === 'hotwater' || fn === 'pool' || fn === 'cooling' ? fn : undefined;
    }

    /** The Smart mode that decides this device's capabilities: its own for a function (Autopilot's
     *  capabilities, or SPA's), hot water's for Main (the day type). */
    private capabilitySmartMode(): SmartMode {
        if (this.smartFunction()) return this.smartMode();
        if (this.role === 'main') return this.smartModeOf('hotwater');
        return 'off';
    }

    /** The household's day type on Main while Autopilot hot water runs. */
    async showDayType() {
        if (!this.hasCapability(DAY_TYPE_CAPABILITY)) return;
        const type = readDayType(this.homey.settings.get(DAY_TYPE_SETTING))?.type ?? null;
        if (this.getCapabilityValue(DAY_TYPE_CAPABILITY) !== type)
            await this.setCapabilityValue(DAY_TYPE_CAPABILITY, type).catch(this.error);
    }

    /** Applies the pump's Smart modes to this device: its capabilities follow them, the Hot water
     *  device starts or stops Autopilot, the Heating device its feed. */
    async applyAutopilot() {
        if ((this.role === 'main' || this.role === 'heating' || this.role === 'hotwater') && this.capabilitiesSynced) {
            const {toAdd, toRemove} = capabilitySyncPlan(this.profile, this.role, this.getSelection(), this.getCapabilities(),
                this.capabilitySmartMode());
            if (toAdd.length || toRemove.length) await this.syncCapabilities();
            if (this.role === 'main') await this.showDayType();
            if (this.role === 'heating') {
                await this.initAutopilotControls();
                // Autopilot heating turned on while the home is away goes away with it.
                await this.applyAway(readDayType(this.homey.settings.get(DAY_TYPE_SETTING))?.type === 'away').catch(this.error);
            }
        }
        if (this.role === 'hotwater') await this.syncHotwaterAutopilot();
        if (this.role === 'heating') this.syncHeatingFeed();
    }

    /** Enabled Flows that switch More hot water on by themselves, on any of this pump's devices.
     *  Undefined when the Flows could not be read. */
    async hotwaterFlowConflicts(): Promise<FlowConflict[] | undefined> {
        const spec = this.profile.autopilotHotwater;
        if (!spec) return [];
        const more = this.profile.registerByName[spec.more];
        const capabilities = this.profile.registers.filter((r) => r.address === more?.address && r.direction === more?.direction)
            .map((r) => r.name);
        const dataIds = new Set(this.pumpDevices().map((d) => String(d.getData().id)));
        const appId = this.homey.manifest?.id ?? 'com.nibe.local';
        return withApi(this.homey, async (api) => {
            const devices = await api.devices.getDevices({$timeout: 10_000});
            const deviceIds = Object.entries(devices ?? {}).filter(([, d]: [string, any]) =>
                String(d?.driverId ?? '').startsWith(`homey:app:${appId}:`) && dataIds.has(String(d?.data?.id))).map(([id]) => id);
            const [flows, advanced] = await Promise.all([api.flow.getFlows({$timeout: 10_000}), api.flow.getAdvancedFlows({$timeout: 10_000})]);
            return moreHotwaterFlows(flows, advanced, {deviceIds, capabilities, prefix: this.profile.flowPrefix});
        }).catch((error: any) => {
            this.log('Autopilot hot water: could not read the Flows:', error?.message ?? error);
            return undefined;
        });
    }

    /** Days of tank history: the running model's full days, else the days the tank's Insights
     *  hold. Undefined when neither can be read. */
    async hotwaterHistoryDays(): Promise<number | undefined> {
        const learned = this.hotwaterAutopilot?.historyDays();
        if (learned !== undefined) return learned;
        const litres = this.profile.autopilotHotwater?.tank.litres;
        if (!litres) return undefined;
        const appId = this.homey.manifest?.id ?? 'com.nibe.local';
        return withApi(this.homey, async (api) => {
            const id = ownDeviceId(await api.devices.getDevices({$timeout: 10_000}), appId, String(this.getData().id));
            if (!id) return undefined;
            const uri = `homey:device:${id}`;
            const log = await api.insights.getLogEntries({uri, id: `${uri}:${litres}`, resolution: 'last3Months', $timeout: 20_000});
            const dates = new Set((log?.values ?? []).filter((v: any) => typeof v?.v === 'number').map((v: any) => String(v.t).slice(0, 10)));
            return dates.size;
        }).catch(() => undefined);
    }

    /** Setup's answers for a home with a short history: stored, and learned from at once. */
    async setHousehold(raw: any) {
        const household = raw == null ? undefined : readHousehold(raw);
        if (raw != null && !household) throw new Error(this.homey.__('pair.setup.smart.household_invalid'));
        await this.setStoreValue(HOUSEHOLD_STORE, household ?? null);
        this.log(`Autopilot hot water household: ${household ? JSON.stringify(household) : 'cleared'}`);
        this.hotwaterAutopilot?.relearn();
    }

    /** For the Flow condition. False while Autopilot hot water is off. */
    hotwaterChargePlannedWithin(hours: number): boolean {
        return this.hotwaterAutopilot?.chargePlannedWithin(hours) ?? false;
    }

    private async syncHotwaterAutopilot() {
        const spec = this.profile.autopilotHotwater;
        if (!spec) return;
        if (this.autopilotMode() === 'off') {
            this.hotwaterAutopilot?.stop();
            if (this.hotwaterAutopilot) this.log('Autopilot hot water stopped.');
            this.hotwaterAutopilot = null;
            await this.unsetWarning().catch(this.error);
            return;
        }
        if (this.hotwaterAutopilot) return;
        let file = this.getStoreValue('autopilotHotwaterFile') as string | undefined;
        if (!file) await this.setStoreValue('autopilotHotwaterFile', file = newHistoryFileName());
        // Mirrored to an app setting so the log can be found through the Homey API.
        this.homey.settings.set(`autopilotHotwaterFile.${this.getData().id}`, file);
        const number = (name?: string) => {
            if (!name || !this.hasCapability(name)) return undefined;
            const value = Number(this.getCapabilityValue(name));
            return Number.isFinite(value) ? value : undefined;
        };
        const register = (name: string) => this.profile.registerByName[name];
        const readPump = async (name: string) => {
            const value = register(name) ? await this.readRegister(register(name)).catch(() => undefined) : undefined;
            return value ?? undefined;
        };
        const live = () => this.autopilotMode() === 'live' ? 'live' : 'shadow';
        this.hotwaterAutopilot = new HotwaterAutopilot(this.homey, String(this.getData().id), file, spec.tank, () => {
            const mode = number(spec.demandMode);
            const {litres, inletC} = this.tankConfig();
            return {
                now: {litres: number(spec.tank.litres), top: number(spec.tank.top), powerW: number(spec.power),
                    more: this.hasCapability(spec.more) ? this.getCapabilityValue(spec.more) === true : undefined,
                    stopC: mode === undefined ? undefined : number(spec.stops[mode]), largeStopC: number(spec.largeStop)},
                tank: litres === null ? undefined : {litres, inletC},
            };
        }, (...args) => this.log(...args), {
            mode: live,
            reserveLitres: () => {
                const v = Number(this.getSettings().autopilotReserve);
                return Number.isFinite(v) && v >= 0 ? v : 40;
            },
            solar: () => this.getSettings().autopilotSolar !== false,
            surplus: (slot) => this.solarSurplus().forUser('hotwater', slot),
            reserveSurplus: (kw) => this.solarSurplus().budget.reserve('hotwater', kw),
            dayType: () => readDayType(this.homey.settings.get(DAY_TYPE_SETTING)),
            pumpFacts: async () => {
                const num = async (name: string) => {
                    const v = Number(await readPump(name));
                    return Number.isFinite(v) ? v : undefined;
                };
                const spa = await Promise.all(spec.spa.map((name) => readPump(name)));
                return {top: await num(spec.tank.top), largeStopC: await num(spec.largeStop), demandMode: await num(spec.demandMode),
                    allowed: (await readPump(spec.allowed)) as boolean | undefined, spaHotwater: spa.every((on) => on === true)};
            },
            write: async (what, value) => {
                const name = what === 'stop' ? spec.largeStop : spec.more;
                this.log(`Autopilot hot water: writing ${name} = ${value}`);
                await this.writeRegister(register(name), value);
            },
            store: {get: (key) => this.getStoreValue(key), set: (key, value) => this.setStoreValue(key, value)},
            charged: (e: ChargeEvent, text) => {
                this.homey.flow.getDeviceTriggerCard((this.profile.flowPrefix ?? '') + 'hotwater_charge_started')
                    .trigger(this, {reason: text.reason, detailed_reason: text.detailedReason, autopilot: e.by === 'autopilot'})
                    .catch(this.error);
            },
            warn: (text) => {
                (text ? this.setWarning(text) : this.unsetWarning()).catch(this.error);
            },
            household: () => readHousehold(this.getStoreValue(HOUSEHOLD_STORE)),
            status: (text) => {
                if (this.hasCapability(AUTOPILOT_REASON_CAPABILITY) && this.getCapabilityValue(AUTOPILOT_REASON_CAPABILITY) !== text)
                    this.setCapabilityValue(AUTOPILOT_REASON_CAPABILITY, text).catch(this.error);
            },
        });
        this.log(`Autopilot hot water started (${live() === 'live' ? 'live' : 'test run'}).`);
        await this.hotwaterAutopilot.start();
    }

    // ---- PumpSubscriber ----

    pollSeconds(): number {
        const stored = this.getSettings().pollInterval;
        const seconds = typeof stored === 'number' && stored > 0 ? stored : POLL_SECONDS_DEFAULT;
        return clampPollSeconds(seconds);
    }

    // See PumpSubscriber.absentRegisters. Main keeps the pump's answer; one copy is enough.
    absentRegisters(): string[] {
        return this.role === 'main' ? (this.getStoreValue('absentRegisters') ?? []) : [];
    }

    onAbsentRegisters(names: string[]) {
        if (this.role === 'main')
            this.setStoreValue('absentRegisters', names).catch(this.error);
    }

    wantedRegisters(): Register[] {
        const selected = registersForRole(this.profile, this.role, this.getSelection());
        if (this.role !== 'heating') return selected;
        const names = Object.values(this.profile.roomThermostat ?? {});
        const autopilot = this.profile.autopilotHistory;
        if (autopilot) names.push(...Object.values(autopilot.numeric) as string[], autopilot.priority.register, autopilot.immersion,
            ...Object.values(autopilot.controls ?? {}) as string[]);
        const needed = names.map((n) => this.profile.registerByName[n]).filter((r) => r);
        // Selected last, so a register the user moved (Selection.addresses) keeps its address:
        // onRegisterRaw drops a reply from any other one, which froze the indoor reading.
        return [...new Map([...needed, ...selected].map((r) => [r.name, r])).values()];
    }

    private async startAutopilotHistory() {
        if (!this.profile.autopilotHistory || this.autopilot) return;
        // Collected before the feature was named Autopilot under `smartHistoryFile`; carried over so
        // that history keeps its file (whose name stays `smart-…`).
        let file = (this.getStoreValue('autopilotHistoryFile') ?? this.getStoreValue('smartHistoryFile')) as string | undefined;
        file ??= newHistoryFileName();
        if (this.getStoreValue('autopilotHistoryFile') !== file) await this.setStoreValue('autopilotHistoryFile', file);
        if (this.getStoreValue('smartHistoryFile') != null) await this.unsetStoreValue('smartHistoryFile');
        // Mirrored to an app setting so dev/read-autopilot-history.mjs can find it through the Homey
        // API (`homey api apps get-app-setting`); a device store is not readable from outside.
        this.homey.settings.unset(`smartHistoryFile.${this.getData().id}`);
        this.homey.settings.set(`autopilotHistoryFile.${this.getData().id}`, file);
        this.autopilot = new AutopilotCollector(this.homey, file, (...args) => this.log(...args));
        await this.autopilot.start();
        this.startHeatingFeed();
    }

    /** Autopilot heating (live.ts), run by heating's Smart mode: `test` plans and reports,
     *  `autopilot` feeds BT1. */
    private startHeatingFeed() {
        const spec = this.profile.autopilotFeed;
        const collector = this.autopilot;
        if (!spec || !collector || this.heatingFeed) return;
        this.heatingFeed = new HeatingFeed({
            mode: () => this.heatingMode,
            limits: () => profileLimits(this.autopilotAway() ? 'save_most' : this.getCapabilityValue(AUTOPILOT_RANGE_CAPABILITY)),
            neutral: () => this.getCapabilityValue(AUTOPILOT_RANGE_CAPABILITY) === 'off',
            sunTrust: () => this.autopilot?.sunReady()
                ? sunTrust(this.autopilotAway() ? 'save_most' : this.getCapabilityValue(AUTOPILOT_RANGE_CAPABILITY)) : 0,
            plan: (slot) => {
                const input = this.autopilot?.liveInputs(slot);
                // Solar surplus left for heating after hot water took its share makes those slots cheap.
                if (!input || this.getSettings().autopilotSolar === false) return input;
                return {...input, forecast: surplusPrices(input.forecast, slot, this.solarSurplus().forUser('heating', slot), input.lever)};
            },
            pump: () => this.heatingPumpFacts(),
            outdoor: () => collector.outdoorNow(),
            write: (celsius) => this.writeBt1(celsius),
            readBack: () => this.readFedOutdoor(),
            feeding: (on) => collector.setFeeding(on),
            warn: (reason) => (reason ? this.setWarning(this.homey.__(`autopilot.heating.warning.${reason}`))
                : this.unsetWarning()).catch(this.error),
            changed: () => { this.showHeatingStatus().catch(this.error); },
            log: (...args) => this.log(...args),
            record: (entry) => collector.recordLive(entry),
            setTimeout: (fn, ms) => this.homey.setTimeout(fn, ms),
            clearTimeout: (timer) => this.homey.clearTimeout(timer),
            sleep: (ms) => new Promise((resolve) => this.homey.setTimeout(resolve, ms)),
            now: () => Date.now(),
        });
        this.syncHeatingFeed();
    }

    private register(name: string): Register {
        return this.profile.registerByName[name];
    }

    private async readNamed(name: string): Promise<any> {
        return this.register(name) ? await this.readRegister(this.register(name)).catch(() => undefined) : undefined;
    }

    /** Room-sensor control for climate system 1 (2978), or undefined where it does not read. */
    private async readRoomControl(): Promise<number | undefined> {
        const address = this.profile.autopilotFeed?.roomControl;
        if (address === undefined) return undefined;
        const raw = await this.connection?.readRegisterRaw({address, direction: Dir.Out} as Register, false, 'write');
        return raw === undefined || isUnavailableRaw(raw) ? undefined : raw & 0xff;
    }

    private async heatingPumpFacts(): Promise<PumpFacts> {
        const spec = this.profile.autopilotFeed!;
        const c = this.profile.autopilotHistory?.controls;
        const priority = this.profile.autopilotHistory?.priority;
        const num = async (name?: string) => {
            // A picker register (operating mode) reads back as its id in text: "0".
            const v = name ? await this.readNamed(name) : undefined;
            const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
            return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
        };
        const spa = await Promise.all(spec.spa.map((name) => this.readNamed(name)));
        return {
            mode: await num(c?.mode),
            thresholds: {stopHeating: await num(c?.stopHeating), stopAddHeat: await num(c?.stopAddHeat),
                startCooling: await num(c?.startCooling)},
            spaHeating: spa.every((v) => v === true),
            roomControl: await this.readRoomControl(),
            addHeat: (await this.readNamed(spec.addHeat)) === true,
            cooling: priority?.cooling !== undefined && await num(priority.register) === priority.cooling,
        };
    }

    /** Write BT1 (5217) directly: the feed and Verify own it; Flows are locked out (writeRegister). */
    private async writeBt1(celsius: number) {
        const spec = this.profile.autopilotFeed!;
        if (!this.connection) throw new Error('Not connected to the heat pump');
        await this.connection.writeRegisterValue(this.register(spec.bt1), encodeRegisterValue(this.register(spec.bt1), celsius));
    }

    /** What the pump takes as outdoor temperature (input 1), °C. */
    private async readFedOutdoor(): Promise<number | undefined> {
        const raw = await this.connection?.readRegisterRaw(this.register(this.profile.autopilotFeed!.outdoor), false, 'write');
        return raw === undefined || isUnavailableRaw(raw) ? undefined : signedValue(raw) / 10;
    }

    /** Start or stop the feed to match heating's Smart mode. */
    private syncHeatingFeed() {
        const feed = this.heatingFeed;
        this.heatingMode = liveMode(this.smartMode());
        if (!feed) return;
        const on = this.heatingMode !== 'off';
        if (on && !feed.running) feed.start();
        else if (!on && feed.running) feed.stop('mode_off').catch(this.error);
        this.showHeatingStatus().catch(this.error);
    }

    private async stopHeatingFeed() {
        await this.heatingFeed?.stop('mode_off').catch(this.error);
        this.heatingFeed = null;
    }

    private clock = (ms: number) => new Date(ms).toLocaleTimeString('sv-SE',
        {timeZone: this.homey.clock.getTimezone(), hour: '2-digit', minute: '2-digit'});

    /** For the Flow condition: what Autopilot heating is doing now. */
    heatingStatusNow(): HeatingStatus {
        return (this.getCapabilityValue(AUTOPILOT_STATUS_CAPABILITY) as HeatingStatus | null) ?? 'off';
    }

    /** Status, reason, fed temperature and shift on the Heating device, a Flow trigger when the
     *  status changes, and a timeline line only when it pauses, resumes or finishes learning. */
    private async showHeatingStatus() {
        const feed = this.heatingFeed;
        if (!feed || !this.hasCapability(AUTOPILOT_STATUS_CAPABILITY)) return;
        const house = this.autopilot?.houseSummary();
        const t = (key: string, tokens?: Record<string, string | number>) => this.homey.__(`autopilot.heating.status.${key}`, tokens);
        const state = feed.state;
        const {status, reason} = heatingStatus(state, Date.now(), t, this.clock,
            house ? {days: house.days, needed: house.needed} : undefined);
        const set = async (name: string, value: any) => {
            if (this.hasCapability(name) && this.getCapabilityValue(name) !== value) await this.setCapabilityValue(name, value);
        };
        await set(AUTOPILOT_STATUS_CAPABILITY, status);
        await set(AUTOPILOT_REASON_CAPABILITY, reason);
        const feeding = !state.stopped && state.fed !== undefined;
        await set(AUTOPILOT_FED_CAPABILITY, feeding ? Math.round(state.fed! * 10) / 10 : null);
        // What BT1 is fed minus the real outdoor temperature: below 0, the pump sees it colder and heats more.
        await set(AUTOPILOT_SHIFT_CAPABILITY, feeding ? Math.round(-state.bias * 10) / 10 + 0 : 0);
        const before = this.heatingStatusShown;
        this.heatingStatusShown = status;
        if (before === undefined || before === status) return;
        this.homey.flow.getDeviceTriggerCard((this.profile.flowPrefix ?? '') + 'autopilot_heating_status_changed')
            .trigger(this, {status: this.homey.__(`autopilot.heating.status_name.${status}`), reason}).catch(this.error);
        const line = status === 'paused' ? 'timeline.paused'
            : before === 'paused' && status !== 'off' ? 'timeline.resumed'
                : before === 'learning' && status !== 'off' ? 'timeline.learned' : undefined;
        if (line) this.homey.notifications.createNotification({excerpt: this.homey.__(`autopilot.heating.${line}`, {reason})})
            .catch(this.error);
    }

    private surplusService?: SolarSurplus;
    /** The home's solar surplus (solar-surplus.ts), shared by every function's Autopilot. */
    private solarSurplus(): SolarSurplus {
        return this.surplusService ??= SolarSurplus.acquire(this.homey, (...args: any[]) => this.log(...args), this);
    }

    /** This device and its siblings: every device of the pump. */
    private pumpDevices(): NibePumpDevice[] {
        const host = this.host();
        return (this.driver.getDevices() as NibePumpDevice[]).filter((d) => d === this || d.getSettings?.().address === host);
    }

    /** Store this function's Smart mode and apply it on every device of the pump: Main's day type
     *  follows hot water's. */
    private async storeSmartMode(mode: SmartMode) {
        if (this.smartMode() !== mode) {
            await this.setStoreValue(SMART_MODE_STORE, mode);
            this.log(`Smart mode: ${this.role} = ${mode}`);
        }
        // Leaving Autopilot while Away: the thermostat goes back before its controls do. The home
        // stays away: hot water keeps following it.
        if (this.role === 'heating' && !autopilotRuns(mode) && this.getStoreValue('autopilotHome') != null)
            await this.applyAway(false);
        for (const device of this.pumpDevices()) await device.applyAutopilot();
    }

    /** Refuse a Smart mode this function cannot take; throws the owner-facing reason. */
    private checkSmartMode(value: SmartMode) {
        const t = (key: string) => this.homey.__(`autopilot.smart.${key}`);
        if (value === 'spa' && !this.profile.spaSwitches) throw new Error(t('no_spa'));
        if (!autopilotRuns(value)) return;
        if (!AUTOPILOT_FUNCTIONS.includes(this.role as SmartFunction)) throw new Error(t('soon'));
        if (this.role === 'hotwater') {
            if (!this.profile.autopilotHotwater) throw new Error(this.homey.__('autopilot.hotwater_setting.no_device'));
            if (this.tankConfig().litres === null) throw new Error(this.homey.__('autopilot.hotwater_setting.no_tank'));
            return;
        }
        if (this.role !== 'heating' || !this.profile.autopilotFeed) throw new Error(t('no_heating'));
        if (value === 'autopilot' && this.getStoreValue('autopilotHeatingVerified') !== true) throw new Error(t('verify_first'));
    }

    /** Write SPA's switches for this function's Smart mode, through the device that carries each
     *  (or this one: a hidden switch is still written). */
    private async writeSmartMode(value: SmartMode) {
        const spa = this.profile.spaSwitches;
        const fn = this.smartFunction();
        if (!spa || !fn) return;
        NibePumpDevice.smartWriting.add(this.host());
        try {
            // The pool's SPA off is its influence at 0: keep what the owner had, to put it back.
            if (fn === 'pool' && spa.poolInfluence && value !== 'spa') {
                const had = Number(await this.readNamed(spa.poolInfluence));
                if (had > 0) await this.setStoreValue('spaPoolInfluence', had);
            }
            const restore = Number(this.getStoreValue('spaPoolInfluence')) || undefined;
            for (const [name, want] of smartModeWrites(fn, value, spa, restore)) {
                const holder = this.pumpDevices().find((d) => d.hasCapability(name)) ?? this;
                const now = await holder.readNamed(name);
                if (typeof want === 'number') {
                    if (Number(now) === want) continue;
                } else if (now === want || (!want && now !== true)) {
                    // Turning a switch off that does not read on is nothing to do: with SPA's master
                    // off the S1155 refuses a write to 844 with Modbus exception 1 (seen 2026-11-12).
                    continue;
                }
                this.log(`Smart mode (${fn} = ${value}): writing ${name} = ${want}`);
                await holder.writeRegister(this.register(name), typeof want === 'number' ? String(want) : want);
            }
        } finally {
            NibePumpDevice.smartWriting.delete(this.host());
        }
    }

    /** Repair → Smart mode on Heating or Hot water. Autopilot for heating goes through Verify
     *  (activateAutopilotHeating) instead; everything else is checked, written and stored here. */
    async chooseSmartMode(value: SmartMode) {
        if (this.role === 'heating' && value === 'autopilot') throw new Error(this.homey.__('autopilot.smart.verify_first'));
        this.checkSmartMode(value);
        await this.writeSmartMode(value);
        // Off or SPA after live Autopilot heating: the pump's own BT1 takes over again, so Verify
        // has to prove it again next time.
        if (this.role === 'heating' && !autopilotRuns(value)) await this.unsetStoreValue('autopilotHeatingVerified');
        await this.storeSmartMode(value);
    }

    /** The pump stays the truth: SPA for a function turned on (pump display, myUplink, a tile)
     *  while Autopilot runs it flips that function to SPA, said once. */
    private async spaSwitchedOn() {
        const spa = this.profile.spaSwitches;
        if (!spa || NibePumpDevice.smartWriting.has(this.host())) return;
        const master = await this.readNamed(spa.master);
        for (const fn of ['heating', 'hotwater'] as const) {
            const device = (this.role === fn ? this : this.sibling(fn)) as NibePumpDevice | undefined;
            if (!device || !autopilotRuns(device.smartMode()) || !spaOn(master, await this.readNamed(spa[fn]))) continue;
            this.log(`Smart mode: Smart price adaption turned on for ${fn}; Autopilot steps aside.`);
            if (fn === 'heating') await device.unsetStoreValue('autopilotHeatingVerified');
            await device.storeSmartMode('spa');
            await this.homey.notifications.createNotification({excerpt: this.homey.__(`autopilot.smart.spa_took_over.${fn}`)})
                .catch(this.error);
        }
    }

    /** Repair → Smart mode → Autopilot → Verify: SPA heating off, the real outdoor temperature
     *  fed once and seen on input 1, then heating's Smart mode set to Autopilot. On failure SPA
     *  heating is put back and nothing is saved. */
    async activateAutopilotHeating(): Promise<{fed: number}> {
        const t = (key: string) => this.homey.__(`autopilot.heating.verify.${key}`);
        if (this.role !== 'heating' || !this.profile.autopilotFeed || !this.autopilot) throw new Error(t('not_heating'));
        if (!this.connection) throw new Error('Not connected to the heat pump');
        if ((await this.readRoomControl() ?? 0) !== 0) throw new Error(t('room_control'));
        const o = this.autopilot.outdoorNow();
        const real = o.sensor ?? (o.forecast === undefined ? undefined : o.forecast + forecastCorrection(o.bias, o.localHour));
        if (real === undefined) throw new Error(t('no_outdoor'));
        const fed = Math.round(real * 10) / 10;
        const spa = this.profile.spaSwitches;
        const spaWas = spa ? await this.readNamed(spa.heating) : undefined;
        try {
            if (spaWas === true) await this.writeSmartMode('autopilot');
            await this.writeBt1(fed);
            let seen: number | undefined;
            for (let i = 0; i < VERIFY_TRIES; i++) {
                await new Promise((resolve) => this.homey.setTimeout(resolve, VERIFY_GAP_MS));
                seen = await this.readFedOutdoor();
                if (seen !== undefined && Math.abs(seen - fed) < 0.05) break;
            }
            if (seen === undefined || Math.abs(seen - fed) >= 0.05) throw new Error(t('not_followed'));
        } catch (error) {
            if (spaWas === true) await this.writeSmartMode('spa').catch(this.error);
            throw error;
        }
        await this.setStoreValue('autopilotHeatingVerified', true);
        await this.storeSmartMode('autopilot');
        this.log(`Autopilot heating verified: fed ${fed} °C, the pump took it.`);
        return {fed};
    }

    /** What Repair → Smart mode shows: the choice, and for heating the checklist's facts. */
    async smartModeStatus() {
        const spa = this.profile.spaSwitches;
        const fn = this.smartFunction() ?? 'heating';
        const master = spa ? await this.readNamed(spa.master) : undefined;
        // The pool's SPA is on when the master is and its influence is above 0.
        const own = !spa ? undefined : fn === 'pool' ? (spa.poolInfluence ? Number(await this.readNamed(spa.poolInfluence)) > 0 : undefined)
            : await this.readNamed(fn === 'cooling' ? spa.cooling ?? '' : spa[fn]);
        const spaIsOn = spa ? spaOn(master, own) : false;
        const base = {role: fn, mode: shownSmartMode(this.smartMode(), spaIsOn), spa: !!spa && (fn !== 'cooling' || !!spa.cooling)
            && (fn !== 'pool' || !!spa.poolInfluence), spaOn: spaIsOn, autopilot: AUTOPILOT_FUNCTIONS.includes(fn)};
        if (this.role === 'hotwater') {
            const [flows, historyDays] = await Promise.all([this.hotwaterFlowConflicts(), this.hotwaterHistoryDays()]);
            return {...base, tank: this.tankConfig().litres !== null, flows: flows ?? null, historyDays: historyDays ?? null,
                starterDays: STARTER_DAYS, household: readHousehold(this.getStoreValue(HOUSEHOLD_STORE)) ?? null};
        }
        if (this.role !== 'heating') return {...base, tank: undefined};
        const indoor = Number(this.getCapabilityValue('measure_temperature'));
        return {
            ...base,
            verified: this.getStoreValue('autopilotHeatingVerified') === true,
            roomControl: await this.readRoomControl() ?? null,
            indoor: Number.isFinite(indoor) ? indoor : null,
            outdoor: this.autopilot?.outdoorNow().sensor ?? null,
            prices: this.autopilot?.hasPrices() ?? false,
            status: this.hasCapability(AUTOPILOT_REASON_CAPABILITY) ? this.getCapabilityValue(AUTOPILOT_REASON_CAPABILITY) : null,
        };
    }

    async setAutopilotProfile(profile: string) {
        if (!this.hasCapability(AUTOPILOT_RANGE_CAPABILITY)) throw new Error(this.homey.__('autopilot.heating.not_on'));
        await this.setCapabilityValue(AUTOPILOT_RANGE_CAPABILITY, profile);
        this.log(`Comfort range set to ${profile}.`);
    }

    // ---- The Autopilot dashboard widget (widgets/autopilot) ----

    /** What the widget draws for this device: its Autopilot now, the next 24 h, and for heating
     *  the house in plain terms. Every string translated here. */
    autopilotWidget(): WidgetData {
        const t = (key: string, tokens?: Record<string, string | number>) => this.homey.__(`autopilot.widget.${key}`, tokens);
        const title = this.getName();
        const slot = slotOf(Date.now());
        const slotStart = (k: number) => k * 15 * 60_000;
        const mode = this.role === 'heating' || this.role === 'hotwater' ? this.smartMode() : 'off';
        const base = {title, chips: [] as string[], slots: [], ticks: [], legend: {}};
        if (!autopilotRuns(mode)) return {...base, kind: 'none', empty: t(this.role === 'heating' || this.role === 'hotwater' ? 'off' : 'not_function')};
        const chips = [t('experimental'), ...(mode === 'test' ? [t('test')] : [])];
        if (this.role === 'hotwater') {
            const o = this.hotwaterAutopilot?.outlook(slot, HOTWATER_SLOTS);
            if (!o) return {...base, kind: 'hotwater', chips, empty: t('starting')};
            const reason = o.next ? this.homey.__(`autopilot.hotwater_charge.reason.${o.next.reason}`) : undefined;
            const solar = o.slots.some((s) => s.surplus !== undefined);
            const share = o.next ? Math.round(o.next.solar * 100) : 0;
            const charges = o.slots.filter((s) => s.charge !== undefined);
            const fromSolar = charges.length ? charges.reduce((a, s) => a + s.charge!, 0) / charges.length : 0;
            if (this.getSettings().autopilotSolar === false) chips.push(t('hotwater.solar_off'));
            return {...base, kind: 'hotwater', chips, test: mode === 'test', slots: o.slots,
                ticks: ticks(slotStart(slot), HOTWATER_SLOTS, this.clock),
                status: o.next ? t('hotwater.next', {time: this.clock(o.next.at), m: o.next.minutes}) : t('hotwater.none'),
                reason: [reason, share > 0 ? t('hotwater.share', {share}) : undefined,
                    o.litres === undefined ? undefined : t('hotwater.litres', {l: Math.round(o.litres)})].filter(Boolean).join(' · '),
                legend: {price: t('price'), surplus: solar ? t('surplus') : '', grid: t('charge_grid'), solar: solar ? t('charge_solar') : ''},
                axes: {left: t('axis_price'), right: solar ? t('axis_surplus') : ''},
                footnote: charges.length && solar ? t('hotwater.solar_total', {share: Math.round(fromSolar * 100)}) : undefined};
        }
        const status = this.getCapabilityValue(AUTOPILOT_STATUS_CAPABILITY) as HeatingStatus | null;
        const range = String(this.getCapabilityValue(AUTOPILOT_RANGE_CAPABILITY) ?? DEFAULT_PROFILE);
        chips.push(t(`range.${range}`));
        if (this.autopilotAway()) chips.push(t('away', {c: this.getCapabilityValue(AUTOPILOT_AWAY_TEMPERATURE_CAPABILITY) ?? AWAY_DEFAULT_C}));
        const from = slot - BACK_SLOTS;
        const past = this.autopilot?.recent(from, BACK_SLOTS) ?? [];
        const thermostat = Number(this.getCapabilityValue('target_temperature'));
        const summary = this.autopilot?.houseSummary();
        return {
            ...base, kind: 'heating', chips, test: mode === 'test',
            slots: heatingSlots(past, this.heatingFeed?.state, slot), now: BACK_SLOTS,
            ticks: ticks(slotStart(from), BACK_SLOTS + AHEAD_SLOTS, this.clock),
            status: status ? this.homey.__(`autopilot.heating.status_name.${status}`) : undefined,
            reason: (this.getCapabilityValue(AUTOPILOT_REASON_CAPABILITY) as string | null) ?? undefined,
            legend: {indoor: t('indoor'), planned: t('expected'), offset: t('offset'), comfort: t('comfort')},
            axes: {left: t('axis_indoor'), right: t('axis_offset')},
            comfort: Number.isFinite(thermostat) ? thermostat : undefined,
            footnote: !summary || summary.ready ? undefined
                : t('learning', {day: Math.min(summary.days, summary.needed), of: summary.needed}),
        };
    }

    // ---- Away: the thermostat goes to the Away temperature and comes back ----

    private autopilotAway(): boolean {
        return this.hasCapability(AUTOPILOT_AWAY_CAPABILITY) && this.getCapabilityValue(AUTOPILOT_AWAY_CAPABILITY) === true;
    }

    /** Set the thermostat as the owner would: through its own listener, which writes the pump. */
    private async setThermostat(celsius: number) {
        if (!this.hasCapability('target_temperature')) throw new Error(this.homey.__('autopilot.heating.no_thermostat'));
        await this.triggerCapabilityListener('target_temperature', celsius);
        await this.setCapabilityValue('target_temperature', celsius);
    }

    /** Away, from the switch or the Flow card: the home's one Away, so hot water and every
     *  Autopilot heating device follow (lib/autopilot/day-type.ts). */
    async setAutopilotAway(on: boolean) {
        if (!this.hasCapability(AUTOPILOT_AWAY_CAPABILITY)) throw new Error(this.homey.__('autopilot.heating.not_on'));
        await (this.driver as any).setAway(on);
    }

    /** Follow the home's Away. On: the thermostat's temperature is kept and the thermostat set to
     *  the Away temperature, and Autopilot may use the widest range. Off: the thermostat goes back.
     *  Nothing on a device not running Autopilot heating. */
    async applyAway(on: boolean) {
        if (!this.hasCapability(AUTOPILOT_AWAY_CAPABILITY)) return;
        if (on === this.autopilotAway() && (on ? this.getStoreValue('autopilotHome') != null : true)) return;
        if (on) {
            const home = Number(this.getCapabilityValue('target_temperature'));
            if (!Number.isFinite(home)) throw new Error(this.homey.__('autopilot.heating.no_thermostat'));
            const away = Number(this.getCapabilityValue(AUTOPILOT_AWAY_TEMPERATURE_CAPABILITY) ?? AWAY_DEFAULT_C);
            await this.setStoreValue('autopilotHome', home);
            await this.setThermostat(away);
            this.log(`Away on: thermostat ${home} -> ${away} °C.`);
        } else {
            const home = Number(this.getStoreValue('autopilotHome'));
            if (Number.isFinite(home)) await this.setThermostat(home);
            await this.unsetStoreValue('autopilotHome');
            this.log(`Away off: thermostat back to ${home} °C.`);
        }
        await this.setCapabilityValue(AUTOPILOT_AWAY_CAPABILITY, on);
    }

    /** Defaults for Autopilot's own controls when they first appear. */
    private async initAutopilotControls() {
        const init = async (name: string, value: any) => {
            if (this.hasCapability(name) && this.getCapabilityValue(name) === null)
                await this.setCapabilityValue(name, value).catch(this.error);
        };
        await init(AUTOPILOT_RANGE_CAPABILITY, DEFAULT_PROFILE);
        await init(AUTOPILOT_AWAY_CAPABILITY, false);
        await init(AUTOPILOT_AWAY_TEMPERATURE_CAPABILITY, AWAY_DEFAULT_C);
    }

    // A register's value from this poll, decoded the same way capabilities are.
    private autopilotValue(readNames: Set<string>, name?: string): number | undefined {
        if (!name) return undefined;
        const raw = readNames.has(name) ? this.connection?.lastRawFor(name) : undefined;
        const register = this.profile.registerByName[name];
        return raw === undefined || !register ? undefined : toNumericValue(register, raw);
    }

    // The settings Autopilot plans with, from this poll.
    private autopilotControls(readNames: Set<string>): Controls {
        const c = this.profile.autopilotHistory?.controls;
        const value = (name?: string) => this.autopilotValue(readNames, name);
        return {comfort: value(c?.comfort), mode: value(c?.mode), thresholds: {
            stopHeating: value(c?.stopHeating), stopAddHeat: value(c?.stopAddHeat), startCooling: value(c?.startCooling)}};
    }

    // One poll's values for the Autopilot history.
    private autopilotSample(readNames: Set<string>): Sample {
        const autopilot = this.profile.autopilotHistory!;
        const value = (name: string) => this.autopilotValue(readNames, name);
        const sample: Sample = {};
        for (const [field, name] of Object.entries(autopilot.numeric)) sample[field as keyof typeof autopilot.numeric] = value(name!);
        const priority = value(autopilot.priority.register);
        if (priority !== undefined) sample.dhw = priority === autopilot.priority.hotwater;
        const immersion = value(autopilot.immersion);
        if (immersion !== undefined) sample.aux = immersion !== 0;
        return sample;
    }

    // The pump switched what it is producing. Only the main device carries the priority
    // capability (and so the trigger card's $filter), so only it fires. `from` is undefined on
    // the first reading after connect — that's a "now known", not a change, so it's skipped
    // rather than firing every flow on every app restart.
    onPriorityChange(from: number | undefined, to: number | undefined,
                     _role: Role, reason: LocalizedText | undefined) {
        if (this.role !== 'main' || from === undefined || to === undefined)
            return;
        track('Fired WHEN Card', {card: 'priority_changed', register: 'priority', role: this.role});
        this.priorityChangedTrigger.trigger(this, {
            priority: this.priorityLabel(to),
            previous: this.priorityLabel(from),
            reason: inLanguage(reason, this.homey.i18n.getLanguage())
        }, {priority: to, previous: from}).catch(this.error);
    }

    // Cache whichever of the two tank sensors this was, and republish. They arrive on separate
    // calls. Cache both and compute the estimate only when the poll is complete.
    private noteTankReading(register: Register, value: number | null) {
        const tank = this.profile.hotwaterTank;
        if (this.role !== 'hotwater' || !tank)
            return;
        if (register.name === tank.topRegister) {
            this.tankTopC = value;
        } else if (register.name === tank.lowerRegister) {
            this.tankLowerC = value;
            if (value !== null) this.noteColdWater(value);
        }
    }

    private fireHotwaterDropped(previous: number, litres: number) {
        this.hotwaterDroppedTrigger.trigger(this, {litres}, {litres, previous}).catch(this.error);
    }

    // The priority code as the same text the capability shows ("Heating"), falling back to the
    // bare code for a value the profile doesn't map — which is enumLabel's job, and the reason
    // this no longer spells the fallback out for itself.
    private priorityLabel(raw: number): string {
        const name = this.profile.role.priorityRegisterName;
        return enumLabel(name ? this.profile.registerByName[name] : undefined, raw,
            (key) => this.homey.__(key));
    }

    onRegisterRaw(register: Register, raw: number) {
        if (register.sources?.length) {
            const canonical = this.profile.registerByName[register.name];
            // A reply from before Repair may still be in flight.
            if (canonical && register.address !== resolvedAddress(canonical, this.getSelection())) return;
            if (register.name === this.profile.role.producedRegisterForRole[this.role]) {
                if (this.lastProducedAddress !== register.address) {
                    this.lastProducedSeen = null;
                    this.resetDeliveredCheck();
                }
                this.lastProducedAddress = register.address;
            }
        }
        const rawValue = this.fromRegisterValue(register, raw);

        // The alarm register carries a bare fault code. Its capability is the *text*
        // (alarm_text_NIBE), and it also drives the derived alarm_generic flag and the alarm
        // log — so updateAlarm owns the capability value; don't write the raw number over it.
        if (this.profile.alarm && register.name === this.profile.alarm.registerName) {
            this.updateAlarm(typeof rawValue === 'number' ? rawValue : 0);
            return;
        }

        const value = register.relative && typeof rawValue === 'number'
            ? this.applyBaseline(register, rawValue)
            : rawValue;
        this.setValue(register, value).catch(this.error);

        const rawScaled = typeof rawValue === 'number' ? rawValue : null;
        this.noteTankReading(register, rawScaled);
        const {totalProductionRegister, totalConsumptionRegister, producedRegisterForRole} = this.profile.role;
        if (this.role === 'main') {
            if (register.name === totalProductionRegister) {
                this.copProduced = rawScaled;
            } else if (register.name === totalConsumptionRegister) {
                this.copUsed = rawScaled;
            }
        } else if (register.name === producedRegisterForRole[this.role]) {
            this.noteDeliveredCounter(rawScaled);
            // Advance the numerator only across intervals the allocator could measure, so it
            // covers the same span as `cumulativeEnergy`. A negative step (counter reset) is
            // ignored rather than propagated.
            if (rawScaled === null) this.lastProducedSeen = null;
            if (rawScaled !== null) {
                if (this.allocationLive && this.lastProducedSeen !== null) {
                    this.copProducedAccum += Math.max(0, rawScaled - this.lastProducedSeen);
                    // Persist in 0.01 kWh steps rather than every poll: an ungraceful restart
                    // then loses at most that much, which moves the COP by nothing.
                    if (this.copProducedAccum - this.persistedProducedAccum >= 0.01) {
                        this.persistedProducedAccum = this.copProducedAccum;
                        this.setStoreValue('copProducedAccum', this.copProducedAccum).catch(this.error);
                    }
                }
                this.lastProducedSeen = rawScaled;
            }
            this.copProduced = this.copProducedAccum;
        }
    }

    // Reflect the pump's alarm number as a native alarm flag + a human-readable description,
    // and fire the "alarm occurred" trigger when a *new* alarm appears (code 0 = cleared).
    private updateAlarm(code: number) {
        if (code === this.lastAlarmCode)
            return;
        const previous = this.lastAlarmCode;
        this.lastAlarmCode = code;
        const series = this.profile.alarm!.series;
        const description = alarmDescription(series, code, this.homey.i18n.getLanguage());
        this.log(`Alarm ${previous ?? '?'} -> ${code}: ${description}`);
        if (this.hasCapability(ALARM_ACTIVE_CAPABILITY))
            this.setCapabilityValue(ALARM_ACTIVE_CAPABILITY, code !== 0).catch(this.error);
        if (this.hasCapability(ALARM_TEXT_CAPABILITY))
            this.setCapabilityValue(ALARM_TEXT_CAPABILITY, description).catch(this.error);
        // Only fire on a real alarm, not on the initial read or when one clears. `previous`
        // is undefined on the first poll after start — don't re-announce a standing alarm.
        if (code !== 0 && previous !== undefined) {
            // The code, not the description: the code is the model's own identifier and is what
            // makes "which alarms actually occur in the wild" answerable across languages.
            track('Raised Alarm', {code});
            this.alarmTrigger.trigger(this, {code, description}, {}).catch(this.error);
        }
        // Record every alarm (including one already standing at startup) in the log.
        if (code !== 0)
            this.appendAlarmLog(code, description, alarmAdvice(series, code)).catch(this.error);
    }

    // Rolling alarm history, kept in the device store and rendered into the read-only
    // "Alarm log" setting. This is the app's own record — the pump's Modbus interface exposes
    // only the *current* alarm number, not its internal alarm history — so it covers the time
    // the app has been running.
    private static readonly ALARM_LOG_MAX = 20;

    private async appendAlarmLog(code: number, description: string, advice?: string) {
        const log: {t: number; code: number; text: string}[] = this.getStoreValue('alarmLog') ?? [];
        log.unshift({t: Date.now(), code, text: description});
        log.length = Math.min(log.length, NibePumpDevice.ALARM_LOG_MAX);
        await this.setStoreValue('alarmLog', log).catch(this.error);
        // Device settings can only render a flat label, so they show just the newest alarm as
        // an at-a-glance line; the full history with NIBE's cause/action lives in the app's own
        // settings page (the label's hint points there). Homey renders the driver's settings
        // form on every device of this driver, so mirror it onto all devices of this pump —
        // the alarm is pump-wide and should read the same wherever you open it.
        const latest = this.renderAlarmLine(log[0]);
        for (const device of this.driver.getDevices() as any[])
            if (device.getSettings?.().address === this.host())
                await device.setSettings({alarm_log: latest}).catch(this.error);
        await this.publishAlarmHistory(code, description, advice);
    }

    // The app-level alarm history behind the "Alarms" app settings page. Device settings can
    // only render a flat label, so the richer view (per-alarm cause and suggested action) lives
    // in the app's own settings page and reads this list. Kept in app settings rather than
    // fetched from the devices so the page needs no app API.
    private static readonly ALARM_HISTORY_MAX = 50;

    private async publishAlarmHistory(code: number, description: string, advice?: string) {
        const key = 'alarmHistory';
        const history: any[] = this.homey.settings.get(key) ?? [];
        history.unshift({
            t: Date.now(),
            code,
            text: description,
            advice: advice ?? null,
            device: this.getName(),
            host: this.host(),
            source: ALARM_SOURCE_URL
        });
        history.length = Math.min(history.length, NibePumpDevice.ALARM_HISTORY_MAX);
        this.homey.settings.set(key, history);
    }

    private republishAlarmLine() {
        const log: {t: number; code: number; text: string}[] = this.getStoreValue('alarmLog') ?? [];
        if (!log.length)
            return;
        const latest = this.renderAlarmLine(log[0]);
        for (const device of this.driver.getDevices() as any[])
            if (device.getSettings?.().address === this.host()
                && device.getSettings().alarm_log !== latest)
                device.setSettings({alarm_log: latest}).catch(this.error);
    }

    private renderAlarmLine(entry?: {t: number; code: number; text: string}): string {
        if (!entry)
            return '';
        // sv-SE renders as "2026-07-24 11:26" — unambiguous and sorts naturally.
        const when = new Date(entry.t).toLocaleString('sv-SE',
            {timeZone: this.homey.clock.getTimezone(), dateStyle: 'short', timeStyle: 'short'});
        // Timestamp on its own line: the alarm text runs long enough that a single line wraps
        // mid-sentence and the date stops being scannable.
        return `${when}\n${entry.text}`;
    }

    onConnectionUp() {
        this.setAvailable().catch(this.error);
        // A feed a connection loss stopped (three failed cycles) resumes once the pump answers.
        if (this.role === 'heating') this.syncHeatingFeed();
        // Main's on/off is pinned ON — re-assert it on every (re)connect.
        if (this.role === 'main' && this.hasCapability(PUMP_ACTIVE_CAPABILITY))
            this.setCapabilityValue(PUMP_ACTIVE_CAPABILITY, true).catch(this.error);
        if (this.role === 'main') {
            this.updatePumpInfo().catch(this.error);
            this.dumpAfterPoll = 'connected';
        }
    }

    // Read the pump's identity once per connect and surface it to the read-only "Heat pump"
    // settings labels + the log. Addresses come from the profile; skipped if the model doesn't
    // declare them.
    private async updatePumpInfo() {
        if (!this.connection || !this.profile.pumpInfo)
            return;
        const {typeAddress, firmwareAddress} = this.profile.pumpInfo;
        // Synthetic `__` names: these are optional one-shot info reads, not capabilities, and
        // a model that doesn't publish them is normal. The prefix keeps them out of the
        // read-failure report (which otherwise announced them as broken registers, and printed
        // the address twice — "1496 @1496" — because an unnamed register is keyed by address).
        const type = typeAddress === undefined ? undefined
            : await this.connection.readRegisterRaw(
                {address: typeAddress, name: '__pumpinfo.type', direction: Dir.In} as Register);
        const firmware = firmwareAddress === undefined ? undefined
            : await this.connection.readRegisterRaw(
                {address: firmwareAddress, name: '__pumpinfo.firmware', direction: Dir.In} as Register);
        this.debug(`Pump info: heat-pump type ${type ?? '?'}, firmware ${firmware ?? '?'}`);
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
        // The model code is only known once the pump has answered, which is why the install
        // profile is (re)sent from here rather than from onInit — at onInit there is no model yet.
        (this.driver as any).syncInstallProfile?.();
    }

    // A one-shot read of every register the model knows about, logged when debug logging is on.
    //
    // Nearly every problem in this app's history has been "the pump doesn't report what we
    // assumed", and each one cost two or three round-trips with a user to establish something
    // the pump could have said in one. This turns a support thread into a single report.
    //
    // Deliberately ignores the user's feature selection: what matters is what the *pump* can
    // report, not what this device happens to display, and a register missing from the
    // selection is exactly the kind of thing worth seeing.
    //
    // Raw and decoded values are both printed, because the decode is as likely to be wrong as
    // the reading. Every decode bug found so far — the 0x8000 "not available" sentinel
    // rendering as a plausible -3276.8, register 2727 sitting at zero while the compressor
    // pulled 3.3 kW, 32-bit counters read as 16-bit — is obvious with both and invisible with
    // only the decoded value.
    private dumping = false;
    // Set at connect and when debug is switched on; the dump runs after the next completed poll.
    private dumpAfterPoll: string | null = null;

    // What the last poll read, for every register this model knows. It makes no reads of its own:
    // it used to re-read the whole table — every group the pump doesn't have included — and each
    // of those answered "Illegal function". Which registers a pump has is Repair's question.
    async dumpRegisters(reason: string) {
        // Main only. The debug setting is mirrored onto every device of the pump.
        if (this.role !== 'main' || !this.connection || !this.debugEnabled() || this.dumping)
            return;
        this.dumping = true;
        try {
            const selection = this.getSelection();
            const all = withResolvedAddresses(this.profile.registers.filter(isPollable), selection);
            const enabled = new Set(registersForRole(this.profile, this.role, selection)
                .map((r) => r.name));
            const primary = new Map(this.profile.registers.map((r) => [r.name, r.address]));
            const byGroup = new Map<string, string[]>();
            let answered = 0;
            for (const register of all) {
                const raw = this.connection.lastRawFor(register.name);
                const value = raw === undefined ? undefined : this.fromRegisterValue(register, raw);
                if (raw !== undefined)
                    answered += 1;
                const shown = raw !== undefined ? `${value === null ? 'n/a' : value} (raw ${raw})`
                    : this.connection.onCooldown(register.name) ? 'absent' : 'not polled';
                // `internal` registers are engine infrastructure with no capability, so they
                // are never "enabled" — say so rather than implying the user switched them off.
                const mark = register.internal ? ' [internal]'
                    : enabled.has(register.name) ? '' : ' [off]';
                // Say so when detection put this register somewhere other than its own address,
                // so a support log answers "which address is it actually reading?" outright.
                const moved = primary.get(register.name);
                const from = moved !== undefined && moved !== register.address ? ` [was ${moved}]` : '';
                const list = byGroup.get(register.group) ?? [];
                list.push(`${register.address} ${register.name}=${shown}${mark}${from} {${this.connection.describeLastRead(register.name)}}`);
                byGroup.set(register.group, list);
            }
            // Grouped into a dozen long lines rather than a hundred short ones: a diagnostic
            // report is a rolling buffer of unknown size, and fewer lines survive it better.
            this.log(`Register dump (${reason}) — ${answered}/${all.length} read by the last poll. `
                + `[off] marks one this device is not currently showing.`);
            for (const [group, lines] of byGroup)
                this.log(`  ${group}: ${lines.join(' | ')}`);
        } catch (error) {
            this.error('Register dump failed', error);
        } finally {
            this.dumping = false;
        }
    }

    onConnectionDown(problem: ConnectionProblem) {
        this.autopilot?.markReconnect();
        this.onEnergyUnavailable();
        this.resetDeliveredCheck();
        this.tankTopC = null;
        this.tankLowerC = null;
        this.lastPublishedLitres = null;
        this.copProduced = null;
        this.copUsed = null;
        // Say why on the tile. A bare greyed-out device is what turned "the router gave the pump
        // a new address" into a support mail.
        this.setUnavailable(this.homey.__(`connection.${problem}`, {host: this.host()})).catch(this.error);
    }

    // The connection has failed to reach the pump for minutes. The driver sweeps the subnet and
    // moves this pump's devices if it finds it elsewhere. A host name is the user's own answer
    // to changing addresses, so it is never replaced with a number.
    async searchForPump(): Promise<void> {
        if (!net.isIP(this.host()))
            return;
        await (this.driver as any).relocatePump(this.host(), this.transport());
    }

    // Every register answers 0xFFFF. The driver logs what is at this address and on the subnet.
    async diagnoseNoData(): Promise<void> {
        await (this.driver as any).diagnoseNoData(this.host(), this.transport());
    }

    // Point this device at another address. Called for every device of the pump by
    // NibePumpDriver.movePump(), after its `address` setting has been written (or, for the
    // device the user is editing, with the settings Homey is about to save).
    reconnectTo(host: string, from: string, settings?: {[key: string]: any}) {
        if (NibePumpDevice.indoorOwners.get(from) === this) {
            NibePumpDevice.indoorOwners.delete(from);
            NibePumpDevice.indoorOwners.set(host, this);
        }
        this.connection?.detach(this);
        this.connection = PumpConnection.get(host, this.profile, this.transport(settings));
        this.connection.attach(this);
    }

    onPollComplete(readNames: Set<string>) {
        if (this.autopilot && this.connection) {
            this.autopilot.setControls(this.autopilotControls(readNames));
            this.autopilot.sample(this.connection.currentPollSeconds(), this.autopilotSample(readNames));
        }
        if (this.dumpAfterPoll) {
            const reason = this.dumpAfterPoll;
            this.dumpAfterPoll = null;
            this.dumpRegisters(reason).catch(this.error);
        }
        if (this.profile.roomThermostat && this.role === 'heating' && !this.thermostatSync) {
            const active = roomThermostatActive(this.profile, (name) => {
                if (!readNames.has(name)) return undefined;
                const raw = this.connection?.lastRawFor(name);
                return raw === undefined ? undefined : toNumericValue(this.profile.registerByName[name], raw);
            });
            if (active !== !!this.getSelection()?.roomThermostat) {
                this.thermostatSync = this.applySelection({...this.getSelection()!, roomThermostat: active})
                    .catch(this.error).finally(() => { this.thermostatSync = null; });
            }
        }
        const tank = this.profile.hotwaterTank;
        if (tank && this.role === 'hotwater') {
            if (!readNames.has(tank.topRegister)) this.tankTopC = null;
            if (!readNames.has(tank.lowerRegister)) this.tankLowerC = null;
            this.updateHotwaterVolume();
        }
        const produced = this.profile.role.producedRegisterForRole[this.role];
        if (produced && !readNames.has(produced)) this.lastProducedSeen = null;
        const required = this.role === 'main'
            ? [this.profile.role.totalProductionRegister, this.profile.role.totalConsumptionRegister]
            : [produced];
        if (required.some((name) => !name || !readNames.has(name)) ||
            (this.role !== 'main' && !this.allocationLive)) {
            const capability = this.copCapability();
            if (capability && this.hasCapability(capability))
                this.setCapabilityValue(capability, null).catch(this.error);
            return;
        }
        this.updateRollingCop();
    }

    // No power source read this poll, so nothing could be measured. Drop the produced reference
    // so the energy the pump delivers during the blind stretch is never added to the COP
    // numerator — the denominator cannot see it either.
    onEnergyUnavailable() {
        this.allocationLive = false;
        this.lastProducedSeen = null;
    }

    // ---- Measuring the allocator against the pump's own books ----------------------------
    // OBSERVATION ONLY. Nothing here changes a meter; it exists to find out how far the
    // allocator's per-function attribution actually drifts from the pump's own accounting,
    // because that has never been measured.
    //
    // What IS measured: the whole-pump integral tracks the pump's counter within a few percent
    // over a day (a since-removed shadow monitor measured -5.3% at 24 h). So the integration is sound.
    //
    // What is NOT measured, and what this logs: how well that good total is *split* between
    // functions. A single 24 h comparison suggested hot water was over-attributed by 37%, but
    // its reference was 3823 — which lags about an hour and steps in 0.1 kWh — and it produced
    // the impossible result of one function exceeding the whole pump's consumption, which says
    // the reference was understated rather than the allocator inflated.
    //
    // The likely mechanism, if a real gap shows up: the allocator charges the ENTIRE pump draw
    // to whichever function is prioritised, including circulation pumps and electronics that
    // the pump books separately or to no function at all. If the numbers bear that out, the
    // fix is to subtract a measured standby baseline before attributing — not to scale the
    // result blindly.
    private bookedThisHour = 0;   // what the allocator credited this function since the last hour
    private loggedEnergyComparison = false;

    // ---- Measuring the delivered counter against the pump's hourly log --------------------
    // OBSERVATION ONLY, like the used-side check above. A ground-source S-series owner on
    // firmware 536 saw 1575 (hot water delivered) climb ~53 kWh in a day that the pump's own
    // hourly log booked ~3 kWh of hot-water electricity for — a COP near 15, while the used side
    // matched the log within 0.5%. Both delivered figures are the pump's; this logs them side
    // by side so a diagnostic report says which one is wrong.
    //
    // The cumulative pair is the one to read. The lifetime counters lag the hourly log by about
    // an hour (measured for 3823) and 1575 steps in 0.1 kWh, so single hours can disagree from
    // timing alone; a day of them cannot.
    private deliveredCounterLast: number | null = null;  // last 1575/1577/... reading
    private deliveredCounterHour = 0;                     // its movement since the last log step
    private deliveredCheckPrimed = false;                 // false = the current hour is partial
    private deliveredTotals = {counter: 0, log: 0, hours: 0};

    private noteDeliveredCounter(value: number | null) {
        if (value !== null && this.deliveredCounterLast !== null)
            this.deliveredCounterHour += value - this.deliveredCounterLast;
        this.deliveredCounterLast = value;
    }

    // A gap or a source switch leaves the current hour covered by the log but only partly by
    // the counter, so that hour is discarded rather than compared. Totals so far are kept.
    private resetDeliveredCheck() {
        this.deliveredCounterLast = null;
        this.deliveredCounterHour = 0;
        this.deliveredCheckPrimed = false;
    }

    private compareDelivered(logged: number | undefined) {
        const counter = this.deliveredCounterHour;
        this.deliveredCounterHour = 0;
        if (logged === undefined)
            return;
        // The first step after start or a gap closes an hour the counter only partly saw.
        if (!this.deliveredCheckPrimed) {
            this.deliveredCheckPrimed = this.deliveredCounterLast !== null;
            return;
        }
        const totals = this.deliveredTotals;
        totals.counter += counter;
        totals.log += logged;
        totals.hours += 1;
        // An idle hour adds nothing and, on a function that never runs (a pool), was half of a
        // debug report's lines. The totals carry on and print with the next hour that moved.
        if (logged === 0 && counter === 0)
            return;
        const name = this.profile.role.producedRegisterForRole[this.role] ?? 'delivered counter';
        const ratio = totals.log >= 0.5
            ? ` (counter ÷ log ${(totals.counter / totals.log).toFixed(2)})`
            : '';
        this.debug(`Delivered check — the pump's hourly log booked ${logged.toFixed(2)} kWh delivered `
            + `last hour, ${name} moved ${counter.toFixed(2)} kWh. Over ${totals.hours} h: log `
            + `${totals.log.toFixed(2)} kWh, counter ${totals.counter.toFixed(2)} kWh${ratio}.`);
    }

    onEnergyLogHour(used: number | undefined, produced: number | undefined) {
        this.compareDelivered(produced);
        const booked = this.bookedThisHour;
        this.bookedThisHour = 0;
        if (used === undefined)
            return;
        if (!this.loggedEnergyComparison) {
            this.loggedEnergyComparison = true;
            this.log('Now comparing this function\'s energy against the pump\'s own hourly '
                + 'figures. Nothing is being changed by this — it is measurement, so the real '
                + 'attribution error can be seen before anything is built on it.');
        }
        // An idle hour is dominated by the pump's own 0.01 kWh resolution, so a ratio from it
        // would be noise. Report the pair anyway; just do not dress it up as a ratio.
        const ratio = booked >= 0.05 && used >= 0.01
            ? ` (ratio ${(used / booked).toFixed(3)}, we are `
              + `${(((booked - used) / used) * 100).toFixed(1)}% ${booked >= used ? 'high' : 'low'})`
            : ' (too small to draw a ratio from)';
        this.debug(`Attribution check — the pump booked ${used} kWh for this function last hour, `
            + `the allocator credited ${booked.toFixed(3)} kWh${ratio}.`);
    }

    onEnergy(deltaKwh: number, watts: number) {
        this.allocationLive = true;
        if (deltaKwh) {
            // Record what the allocator credited, for the hourly comparison. The meter itself
            // is untouched — this is measurement, not correction.
            this.bookedThisHour += deltaKwh;
            this.cumulativeEnergy += deltaKwh;
            if (this.hasCapability(METER_CAPABILITY))
                this.setCapabilityValue(METER_CAPABILITY, this.cumulativeEnergy).catch(this.error);
            this.persistCumulativeEnergy();
        }
        if (functionRoles.includes(this.role)) {
            this.copUsed = this.cumulativeEnergy;
        }
        if (this.hasCapability(ACTIVE_POWER_CAPABILITY))
            this.setCapabilityValue(ACTIVE_POWER_CAPABILITY, watts).catch(this.error);
    }

    // Persist the meter in 0.01 kWh steps rather than on every poll, mirroring how
    // `copProducedAccum` is stored. This used to write the setting whenever the allocator
    // credited anything at all — i.e. every poll while the pump drew power, which at the
    // default 10 s interval across four function devices is tens of thousands of flash writes
    // a day, forever, on a Homey Pro. The capability itself still updates every poll, so
    // nothing the user looks at moves any more slowly; only the durable copy is batched, and
    // an ungraceful restart loses at most 0.01 kWh. onUninit() flushes, so an orderly restart
    // or a repair loses nothing at all.
    private persistedCumulativeEnergy = 0;

    private persistCumulativeEnergy(force = false) {
        if (!force && Math.abs(this.cumulativeEnergy - this.persistedCumulativeEnergy) < 0.01)
            return Promise.resolve();
        // Rounded to milli-kWh on the way out. A settings number field renders the value exactly
        // as stored — `decimals` is a capability option and is ignored here — so the raw
        // accumulator showed as 99.39351378333367 in a box the user is invited to edit. The
        // in-memory total keeps full precision; only the visible, editable copy is rounded, and
        // reading it back at start-up costs at most half a milli-kWh.
        const snapshot = this.cumulativeEnergy;
        return this.setSettings({cumulativeEnergy: Math.round(snapshot * 1000) / 1000})
            .then(() => { this.persistedCumulativeEnergy = snapshot; })
            .catch(this.error);
    }

    // ---- lifecycle ----

    // App answer -> this device's checkbox. Guarded on a real difference: setSettings writes to
    // flash, and this runs at every init.
    private syncConsentFromApp() {
        const consent = analyticsConsent(this.homey);
        if (this.getSettings().analyticsConsent === consent)
            return;
        this.setSettings({analyticsConsent: consent}).catch(this.error);
    }

    async onSettings({oldSettings, newSettings, changedKeys}: {
        oldSettings: {[key: string]: any}, newSettings: {[key: string]: any}, changedKeys: string[]
    }) {
        // Autopilot hot water's settings are pump-wide: every device of the pump shows the same.
        for (const key of ['autopilotReserve', 'autopilotSolar'].filter((k) => changedKeys.includes(k)))
            await this.syncToSiblings(key, newSettings[key]);
        if (changedKeys.includes('cumulativeEnergy')) {
            this.cumulativeEnergy = newSettings.cumulativeEnergy || 0;
            // The user just set the durable copy by hand; don't let the next poll's debounce
            // think it still owes a write of the old value.
            this.persistedCumulativeEnergy = this.cumulativeEnergy;
            if (this.hasCapability(METER_CAPABILITY))
                this.setCapabilityValue(METER_CAPABILITY, this.cumulativeEnergy).catch(this.error);
        }
        if (changedKeys.includes('pollInterval')) {
            const seconds = clampPollSeconds(newSettings.pollInterval);
            this.log(`Poll interval set to ${seconds} s`);
            this.syncPollIntervalToSiblings(seconds).catch(this.error);
            this.connection?.refreshPollInterval();
        }
        if (changedKeys.includes('analyticsConsent')) {
            const consent = !!newSettings.analyticsConsent;
            this.log(`Anonymous usage data ${consent ? 'enabled' : 'disabled'}`);
            // Writes the app-level setting, which closes or opens the gate immediately rather than
            // at the next restart, and opts the Amplitude SDK out as well so anything already in
            // its batcher is dropped rather than flushed after the user said no.
            setAnalyticsConsent(this.homey, consent);
            // One answer for the whole install, so every device of this app shows it — not just
            // this pump's, unlike the pump-wide settings above.
            for (const device of this.driver.getDevices() as any[])
                if (device !== this && device.getSettings?.().analyticsConsent !== consent)
                    await device.setSettings({analyticsConsent: consent}).catch(this.error);
        }
        if (changedKeys.includes('debugLogging')) {
            const on = !!newSettings.debugLogging;
            this.log(`Debug logging ${on ? 'enabled' : 'disabled'}`);
            // Pump-wide diagnostic switch: mirror onto the pump's other devices so one toggle
            // covers the whole pump, and refresh the shared connection's own verbosity.
            // Homey still exposes the old settings during onSettings. Apply the new
            // pump-wide value in memory before refreshDebug inspects any subscriber.
            this.debugLoggingOverride = on;
            for (const device of this.driver.getDevices() as NibePumpDevice[]) {
                if (device !== this && device.getSettings().address === this.host())
                    device.debugLoggingOverride = on;
            }
            this.syncToSiblings('debugLogging', on).catch(this.error);
            this.connection?.refreshDebug();
            // Dump again on enable, not only at connect. A diagnostic report is a rolling
            // buffer, so a dump written at startup is the first thing an hour of debug output
            // pushes out — toggling debug off and on just before submitting puts a fresh one
            // at the end, where a tail keeps it.
            if (on)
                this.dumpAfterPoll = 'debug logging enabled';
        }
        if (changedKeys.includes('address')) {
            const from = String(oldSettings.address);
            // Not trimmed: Homey saves the value as typed, and siblings must match it exactly.
            const to = String(newSettings.address ?? '');
            if (!to.trim())
                throw new Error(this.homey.__('pair.valid_ip_address'));
            // Pump-wide, because the whole pump moves: the BT50 feed is owned by Heating, but
            // editing Main's address moves Heating too.
            const feeding = (this.driver.getDevices() as any[]).some((device) =>
                (device === this || device.getSettings?.().address === from)
                && device.getStoreValue?.('indoorSensors')?.state === 'active');
            if (feeding)
                throw new Error('Return to your NIBE sensor in Repair before changing the pump address.');
            // An address and port edited in one save: siblings take the port first, or they
            // would reconnect at the new address with the old one.
            for (const key of ['port', 'unitId', 'addressMode'])
                if (changedKeys.includes(key)) await this.syncToSiblings(key, newSettings[key]);
            this.log(`Address changed from ${from} to ${to}, moving the pump's devices`);
            // One edit moves every device of the pump. Doing only this one left the pump's other
            // devices on the old address, each needing the same edit by hand.
            await (this.driver as any).movePump(from, to, this, newSettings);
        } else if (changedKeys.includes('port') || changedKeys.includes('unitId') || changedKeys.includes('addressMode')) {
            this.log(`Transport changed (port/unit), reconnecting`);
            const transport = this.transport(newSettings);
            for (const key of ['port', 'unitId', 'addressMode']) {
                if (changedKeys.includes(key)) await this.syncToSiblings(key, newSettings[key]);
            }
            this.connection?.applyTransport(transport);
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

    // Mirror a setting onto the other devices of the same pump. Guarded on the value actually
    // differing, so the resulting onSettings on each sibling is a no-op and this can't recurse.
    private async syncToSiblings(key: string, value: any) {
        const host = this.host();
        for (const device of this.driver.getDevices() as any[]) {
            if (device === this || device.getSettings?.().address !== host)
                continue;
            if (device.getSettings()[key] === value)
                continue;
            await device.setSettings({[key]: value}).catch(this.error);
        }
    }

    async onUninit() {
        // BT1 back to the real outdoor temperature first, while the connection is still up.
        await this.stopHeatingFeed();
        // History first: an app update may not wait for the rest. If it doesn't wait at all, the
        // hourly save bounds the loss to an hour, and the model re-anchors across the gap.
        await this.autopilot?.stop(this.connection?.currentPollSeconds() ?? 10).catch(this.error);
        this.autopilot = null;
        this.hotwaterAutopilot?.stop();
        this.hotwaterAutopilot = null;
        this.surplusService?.release(this);
        this.surplusService = undefined;
        await this.stopIndoor();
        // Flush the debounced meter before going away, so an orderly restart or a repair keeps
        // the fraction of a kWh the 0.01 step was still holding.
        this.connection?.detach(this);
        await this.persistCumulativeEnergy(true);
    }

    // onAdded, not onInit: onInit runs on every app start, so counting devices there would report
    // an "install" each time the hub reboots. onAdded fires once, when the device is really created.
    async onAdded() {
        track('Changed Device Set', {action: 'added', role: roleOf(this.getData())});
        (this.driver as any).syncInstallProfile?.();
    }

    async onDeleted() {
        await this.stopHeatingFeed();
        await this.stopIndoor();
        await this.autopilot?.remove().catch(this.error);
        this.autopilot = null;
        await this.hotwaterAutopilot?.remove().catch(this.error);
        this.hotwaterAutopilot = null;
        this.homey.settings.unset(`autopilotHotwaterFile.${this.getData().id}`);
        this.homey.settings.unset(`autopilotHistoryFile.${this.getData().id}`);
        this.log('Nibe device has been deleted');
        track('Changed Device Set', {action: 'removed', role: roleOf(this.getData())});
        this.connection?.detach(this);
        // After detach, so the profile describes the install as it now stands. The driver still
        // lists this device at this point on some SDK versions; the debounce means the snapshot
        // taken a few seconds later is the settled one either way.
        (this.driver as any).syncInstallProfile?.();
    }
}
