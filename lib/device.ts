import {Device} from 'homey';
import {Dir, Register, Selection, isUnavailableRaw, signedValue} from './registers';
import {
    ACTIVE_POWER_CAPABILITY, ALARM_ACTIVE_CAPABILITY, ALARM_TEXT_CAPABILITY,
    FUNCTION_COP_CAPABILITY, METER_CAPABILITY,
    PUMP_ACTIVE_CAPABILITY, Role, SOLAR_METER_CAPABILITY, TOTAL_COP_CAPABILITY,
    extraCapabilities, extraCapabilityOptions, functionRoles,
    registersForRole, roleClass, roleOf, roleRegisters
} from './roles';
import {ALARM_SOURCE_URL, alarmAdvice, alarmDescription} from './alarms';
import type {LocalizedText, ModelProfile} from './profile';
import {PumpConnection, PumpSubscriber, POLL_SECONDS_DEFAULT, Transport,
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
    debugEnabled(): boolean {
        return !!this.getSettings().debugLogging;
    }

    protected debug(...args: any[]) {
        if (this.debugEnabled())
            this.log(...args);
    }

    // Transport for this device: the model defaults, optionally overridden by per-device
    // port/unit-id settings (F gateways). S has no such settings → falls back to 502/1.
    private transport(): Transport {
        const settings = this.getSettings();
        return {
            port: settings.port || this.profile.transport.port,
            unitId: settings.unitId || this.profile.transport.unitId
        };
    }

    private options(name: string): any {
        return (this.profile.compose.capabilitiesOptions as any)[name];
    }

    private getSelection(): Selection | null {
        return (this.getStoreValue('selection') ?? null) as Selection | null;
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
        if (isUnavailableRaw(raw, register.size))
            return null;
        let value = signedValue(raw, register.size);
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
        // Two's complement last, mirroring fromRegisterValue() which undoes it first.
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

    async writeRegister(register: Register, value: any): Promise<void> {
        if (!this.connection)
            throw new Error('Not connected to the heat pump');
        try {
            await this.connection.writeSingleRegister(register.address, this.toRegisterValue(register, value));
        } catch (error: any) {
            // Surface a clear, user-facing message instead of failing silently.
            throw new Error(`Could not set "${this.registerTitle(register)}": ${error?.message ?? error}`);
        }
    }

    private alarmTrigger = this.homey.flow.getDeviceTriggerCard("alarm_occurred");
    private priorityChangedTrigger = this.homey.flow.getDeviceTriggerCard("priority_changed");
    private capabilityChangedTrigger = this.homey.flow.getDeviceTriggerCard("capability_changed");
    private turnedOnTrigger = this.homey.flow.getDeviceTriggerCard("capability_turned_on");
    private turnedOffTrigger = this.homey.flow.getDeviceTriggerCard("capability_turned_off");

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
        if (register.bool && value) {
            this.turnedOnTrigger.trigger(this, {register: name}, state);
        } else if (register.bool && !value) {
            this.turnedOffTrigger.trigger(this, {register: name}, state);
        } else if (register.enum) {
            this.capabilityChangedTrigger.trigger(this, {value: `${value}`, register: name}, state);
        }
    }

    async setValue(register: Register, value: any) {
        if (register.writeOnly || !this.hasCapability(register.name))
            return;
        const oldValue = this.getCapabilityValue(register.name);
        await this.setCapabilityValue(register.name, value);
        if (oldValue !== value)
            this.checkTrigger(register, value);
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
        return extraCapabilityOptions(this.role, name);
    }

    // ---- Rolling 30-day COP -------------------------------------------------------------
    private static readonly COP_WINDOW_MS = 30 * 24 * 3600 * 1000;
    private static readonly COP_SNAPSHOT_MS = 6 * 3600 * 1000;
    private copProduced: number | null = null;
    private copUsed: number | null = null;

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
        const key = `baseline.${register.name}`;
        let baseline = this.getStoreValue(key);
        if (typeof baseline !== 'number') {
            baseline = value;
            this.setStoreValue(key, baseline).catch(this.error);
        }
        return value - baseline;
    }

    private async syncCapabilities() {
        const selection = this.getSelection();
        const roleRegs = registersForRole(this.profile, this.role, selection);
        const extras = extraCapabilities(this.profile, this.role, selection);

        const wanted = new Set<string>([...roleRegs.map((r) => r.name), ...extras]);
        for (const name of this.getCapabilities()) {
            if (!wanted.has(name)) {
                this.debug(`Removing capability ${name}`);
                await this.removeCapability(name).catch(this.error);
            }
        }

        for (const register of roleRegs) {
            if (!this.hasCapability(register.name)) {
                this.debug(`Adding capability ${register.name}`);
                await this.addCapability(register.name).catch(this.error);
            }
            await this.ensureCapabilityOptions(register.name, this.options(register.name)).catch(this.error);
        }
        for (const extra of extras) {
            if (!this.hasCapability(extra)) {
                this.debug(`Adding capability ${extra}`);
                await this.addCapability(extra).catch(this.error);
            }
            await this.ensureCapabilityOptions(extra, this.extraOptions(extra)).catch(this.error);
        }
    }

    async applySelection(selection: Selection) {
        this.log("Applying selection", JSON.stringify(selection));
        await this.setStoreValue('selection', selection);
        await this.syncCapabilities();
        if (this.hasCapability(METER_CAPABILITY))
            await this.setCapabilityValue(METER_CAPABILITY, this.cumulativeEnergy).catch(this.error);
    }

    async probeForDetection(onProgress: (pass: number, passes: number) => void) {
        if (!this.connection || !this.getAvailable())
            throw new Error(this.homey.__("pair.not_connected"));
        return this.connection.probe(onProgress);
    }

    async onInit() {
        this.role = roleOf(this.getData());
        this.debug(`Device init: role ${this.role}, host ${this.host()}, groups [${this.enabledGroupsSummary()}]`);

        if (this.getClass() !== roleClass[this.role]) {
            this.debug(`Updating device class: ${this.getClass()} -> ${roleClass[this.role]}`);
            await this.setClass(roleClass[this.role]).catch(this.error);
        }

        if (this.role === 'solar')
            await this.setEnergy({meterPowerExportedCapability: SOLAR_METER_CAPABILITY}).catch(this.error);

        if (functionRoles.includes(this.role) || this.role === 'main')
            this.cumulativeEnergy = this.getSettings().cumulativeEnergy || 0;
        if (functionRoles.includes(this.role))
            this.copUsed = this.cumulativeEnergy;

        // Capability setup can fail on an individual device (a capability RPC error, a
        // stale capability type, etc.). Catch it so onInit still reaches attach() below:
        // a throw here used to leave the device unsubscribed from the pump connection, and
        // the allocator then silently charged its draw to Main/idle instead of its own
        // meter — the root cause of the inflated "idle energy".
        try {
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
                        this.checkTrigger(register, value);
                    });
                }
            }

            // Main's on/off is the bare `onoff`, pinned ON (the pump is always operating; there
            // is no whole-pump on/off command). Register a listener that snaps any manual change
            // back to on. Function devices need no listener here — their on/off is a real
            // writable enable register (Allow heating, …) whose write listener is wired above.
            if (this.role === 'main' && this.hasCapability(PUMP_ACTIVE_CAPABILITY)) {
                await this.setCapabilityValue(PUMP_ACTIVE_CAPABILITY, true).catch(this.error);
                this.registerCapabilityListener(PUMP_ACTIVE_CAPABILITY, async () => {
                    setTimeout(() => this.setCapabilityValue(PUMP_ACTIVE_CAPABILITY, true)
                        .catch(this.error), 300);
                    throw new Error(this.homey.__('pair.not_settable'));
                });
            }
        } catch (err) {
            this.error('Capability setup failed in onInit; attaching to the pump anyway so '
                + 'this device still receives its energy allocation', err);
        }

        this.connection = PumpConnection.get(this.host(), this.profile, this.transport());
        this.connection.attach(this);
    }

    // ---- PumpSubscriber ----

    pollSeconds(): number {
        const stored = this.getSettings().pollInterval;
        const seconds = typeof stored === 'number' && stored > 0 ? stored : POLL_SECONDS_DEFAULT;
        return clampPollSeconds(seconds);
    }

    wantedRegisters(): Register[] {
        return registersForRole(this.profile, this.role, this.getSelection());
    }

    // The pump switched what it is producing. Only the main device carries the priority
    // capability (and so the trigger card's $filter), so only it fires. `from` is undefined on
    // the first reading after connect — that's a "now known", not a change, so it's skipped
    // rather than firing every flow on every app restart.
    onPriorityChange(from: number | undefined, to: number | undefined,
                     _role: Role, reason: LocalizedText | undefined) {
        if (this.role !== 'main' || from === undefined || to === undefined)
            return;
        this.priorityChangedTrigger.trigger(this, {
            priority: this.priorityLabel(to),
            previous: this.priorityLabel(from),
            reason: inLanguage(reason, this.homey.i18n.getLanguage())
        }, {priority: to, previous: from}).catch(this.error);
    }

    // The priority code as the same text the capability shows ("Heating"), falling back to the
    // bare code for a value the profile doesn't map.
    private priorityLabel(raw: number): string {
        const name = this.profile.role.priorityRegisterName;
        const map = name ? this.profile.registerByName[name]?.enum : undefined;
        const key = map?.[raw];
        return key ? (this.homey.__(key) || key) : `${raw}`;
    }

    onRegisterRaw(register: Register, raw: number) {
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
        const {totalProductionRegister, totalConsumptionRegister, producedRegisterForRole} = this.profile.role;
        if (this.role === 'main') {
            if (register.name === totalProductionRegister) {
                this.copProduced = rawScaled;
                this.updateRollingCop();
            } else if (register.name === totalConsumptionRegister) {
                this.copUsed = rawScaled;
                this.updateRollingCop();
            }
        } else if (register.name === producedRegisterForRole[this.role]) {
            this.copProduced = rawScaled;
            this.updateRollingCop();
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
        if (code !== 0 && previous !== undefined)
            this.alarmTrigger.trigger(this, {code, description}, {}).catch(this.error);
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

    private renderAlarmLine(entry?: {t: number; code: number; text: string}): string {
        if (!entry)
            return '';
        // sv-SE renders as "2026-07-24 11:26" — unambiguous and sorts naturally.
        const when = new Date(entry.t).toLocaleString('sv-SE',
            {timeZone: this.homey.clock.getTimezone(), dateStyle: 'short', timeStyle: 'short'});
        return `${when}  ${entry.text}`;
    }

    onConnectionUp() {
        this.setAvailable().catch(this.error);
        // Main's on/off is pinned ON — re-assert it on every (re)connect.
        if (this.role === 'main' && this.hasCapability(PUMP_ACTIVE_CAPABILITY))
            this.setCapabilityValue(PUMP_ACTIVE_CAPABILITY, true).catch(this.error);
        if (this.role === 'main')
            this.updatePumpInfo().catch(this.error);
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
        await this.logEnergyLogSettings();
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
    }

    // Which functions the pump counts toward its own energy log and totals. This is a setting
    // on the pump, not a property of the model, so the same figures can mean different things
    // on two identical units — and a support log that shows the numbers without showing this
    // cannot explain them. Read once per connect alongside the model info.
    //
    // Absence is expected and model-dependent (cooling exists on S320/S2125 but not S1155), so
    // a register that doesn't answer reports as "n/a" rather than being treated as a fault.
    private async logEnergyLogSettings() {
        const settings = this.profile.energyLogSettings;
        if (!this.connection || !settings?.length)
            return;
        const parts: string[] = [];
        for (const setting of settings) {
            const raw = await this.connection.readRegisterRaw({
                address: setting.address,
                name: `__energylog.${setting.label}`,
                direction: Dir.Out
            } as Register);
            if (raw !== undefined)
                parts.push(`${setting.label}=${raw ? 'yes' : 'NO'}`);
        }
        // Most models expose none of these (only S320/S325 and S1156/S1256 have the pool flag,
        // only S320/S325 and S2125 the cooling one), and a line reading "n/a, n/a, n/a, n/a" on
        // every startup would be pure noise. Say nothing rather than nothing at length.
        if (!parts.length)
            return;
        this.debug(`Energy log counts: ${parts.join(', ')} — pump settings (menu 3.1) that `
            + `decide which functions its own energy totals include.`);
    }

    onConnectionDown() {
        this.setUnavailable().catch(this.error);
    }

    onEnergy(deltaKwh: number, watts: number) {
        if (deltaKwh) {
            this.cumulativeEnergy += deltaKwh;
            if (this.hasCapability(METER_CAPABILITY))
                this.setCapabilityValue(METER_CAPABILITY, this.cumulativeEnergy).catch(this.error);
            this.setSettings({cumulativeEnergy: this.cumulativeEnergy}).catch(this.error);
        }
        if (functionRoles.includes(this.role)) {
            this.copUsed = this.cumulativeEnergy;
            this.updateRollingCop();
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
        if (changedKeys.includes('pollInterval')) {
            const seconds = clampPollSeconds(newSettings.pollInterval);
            this.log(`Poll interval set to ${seconds} s`);
            this.syncPollIntervalToSiblings(seconds).catch(this.error);
            this.connection?.refreshPollInterval();
        }
        if (changedKeys.includes('debugLogging')) {
            const on = !!newSettings.debugLogging;
            this.log(`Debug logging ${on ? 'enabled' : 'disabled'}`);
            // Pump-wide diagnostic switch: mirror onto the pump's other devices so one toggle
            // covers the whole pump, and refresh the shared connection's own verbosity.
            this.syncToSiblings('debugLogging', on).catch(this.error);
            this.connection?.refreshDebug();
        }
        if (changedKeys.includes('address')) {
            this.log(`Address changed to ${newSettings.address}, reconnecting`);
            this.connection?.detach(this);
            this.connection = PumpConnection.get(newSettings.address, this.profile, this.transport());
            this.connection.attach(this);
        } else if (changedKeys.includes('port') || changedKeys.includes('unitId')) {
            this.log(`Transport changed (port/unit), reconnecting`);
            this.connection?.applyTransport(this.transport());
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
        this.connection?.detach(this);
    }

    async onDeleted() {
        this.log('Nibe device has been deleted');
        this.connection?.detach(this);
    }
}
