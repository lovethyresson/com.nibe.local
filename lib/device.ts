import {CaptureSummary, logCaptureSummary} from './diagnostic-capture';
import {IndoorConfig, averageSensors, cleanIndoorConfig, indoorInventory} from './indoor-sensors';
import {Device} from 'homey';
import net from 'net';
import {analyticsConsent, setAnalyticsConsent, track} from './analytics';
import {
    Dir, Register, Selection, encodeRegisterValue, toNumericValue, enumLabel, isPollable, isUnavailableRaw, migrateSelection,
    resolvedAddress, signedValue, withResolvedAddresses
} from './registers';
import {
    ACTIVE_POWER_CAPABILITY, ALARM_ACTIVE_CAPABILITY, ALARM_TEXT_CAPABILITY,
    FUNCTION_COP_CAPABILITY, HOTWATER_VOLUME_CAPABILITY, METER_CAPABILITY,
    PUMP_ACTIVE_CAPABILITY, Role, SOLAR_METER_CAPABILITY, TOTAL_COP_CAPABILITY,
    capabilitySyncPlan, extraCapabilities, extraCapabilityOptions, functionRoles, mirrorOptions,
    mirrorsForRole, registersForRole, roleClass, roleOf, roleRegisters, deviceClass, roomThermostatActive
} from './roles';
import {ALARM_SOURCE_URL, alarmAdvice, alarmDescription} from './alarms';
import {
    ColdSample, COLD_WINDOW_DAYS, DEFAULT_INLET_C, MAX_TANK_LITRES, MIN_TANK_LITRES, MIX_C,
    dayNumber, learnedInletC, usableLitres
} from './hotwater';
import type {LocalizedText, ModelProfile} from './profile';
import {ConnectionProblem, PumpConnection, PumpSubscriber, POLL_SECONDS_DEFAULT, Transport,
    clampPollSeconds, inLanguage} from './connection';

// One logical function of the physical pump (see roles.ts). All devices share a single
// PumpConnection per pump host; this class is the Homey-facing subscriber: it maps its role's
// registers to capabilities, and — for function roles — keeps the energy bucket the
// connection's allocator feeds it. Model-specific data comes from the concrete subclass's
// `profile` (S or F).
export abstract class NibePumpDevice extends Device implements PumpSubscriber {
    abstract profile: ModelProfile;

    role: Role = 'main';
    private connection: PumpConnection | null = null;
    private thermostatSync: Promise<void> | null = null;

    private static indoorOwners = new Map<string, NibePumpDevice>();
    private indoorTimer: ReturnType<typeof setTimeout> | null = null;
    private indoorWork: Promise<any> | null = null;
    private indoorStopped = false;
    private indoorStatus: any = {state: 'idle'};

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

    protected readIndoorSensors() { return indoorInventory(this.homey); }

    private async sendIndoor(config: IndoorConfig) {
        config = cleanIndoorConfig(config);
        const value = averageSensors(config, await this.readIndoorSensors());
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
            averageSensors(config, await this.readIndoorSensors());
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
                .catch(async (error) => {
                    const notify = this.indoorStatus.state !== 'error';
                    this.indoorStatus = {state: 'error', message: error.message};
                    await this.setWarning(error.message).catch(this.error);
                    if (notify) await this.homey.notifications.createNotification({
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
            capabilitySyncPlan(this.profile, this.role, selection, this.getCapabilities());
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
        await this.setStoreValue('selection', selection);
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
            this.debug(`Device capabilities synced: ${this.getCapabilities().length} — `
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
            if (this.getStoreValue('indoorSensors')?.state === 'pending')
                await this.setWarning('Finish your Homey sensor setup in Heating → Repair.');
        }
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
        if (this.role !== 'heating' || !this.profile.roomThermostat) return selected;
        const needed = Object.values(this.profile.roomThermostat).map((n) => this.profile.registerByName[n]);
        return [...new Map([...selected, ...needed].map((r) => [r.name, r])).values()];
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
                if (this.lastProducedAddress !== register.address) this.lastProducedSeen = null;
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
        this.onEnergyUnavailable();
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

    onEnergyLogHour(used: number | undefined, _produced: number | undefined) {
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
        await this.stopIndoor();
        this.log('Nibe device has been deleted');
        track('Changed Device Set', {action: 'removed', role: roleOf(this.getData())});
        this.connection?.detach(this);
        // After detach, so the profile describes the install as it now stands. The driver still
        // lists this device at this point on some SDK versions; the debounce means the snapshot
        // taken a few seconds later is the settled one either way.
        (this.driver as any).syncInstallProfile?.();
    }
}
