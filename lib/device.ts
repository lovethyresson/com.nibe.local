import {CaptureSummary, logCaptureSummary} from './diagnostic-capture';
import {dateFormat, localeDate, localeTime, numberFormat} from './intl';
import {memMark, memNow} from './mem-probe';
import {pricesFor} from './gateway-prices';
import {PRIORITY} from './gateway';
import {IndoorConfig, averageSensors, cleanIndoorConfig, readOnlyIndoorConfig, selectedReadings, withApi} from './indoor-sensors';
import {Controls, AutopilotCollector, LOCATION_SETTING, OUTDOOR_SENSOR_SETTING} from './autopilot/collector';
import {BACKFILL_FIELDS, BackfillField, LogSource, anyLogRead, backfillSources, fetchHeatingInsights} from './autopilot/heating-insights';
import {newHistoryFileName} from './autopilot/store-file';
import {DEFAULT_BASE_C, seasonCurve} from './autopilot/season';
import {weatherFor} from './gateway-weather';
import {BASELINE_DAYS, Baseline, LEDGER_DAYS, boostDays, kwhPerLitreOf, moneyText, partialDay, ModeMark, SavingsData, SavingsDay, baselineOf, dayHours, firstLiveFrom, hourlyPrices, hourlyUse, liveAt, liveShare, mergeDays, savingsData, savingsDay, savingsLive} from './autopilot/savings';
import {LEGIONELLA_DATES_KEY, ChargeEvent, HotwaterAutopilot, HotwaterMode, LEGIONELLA_STATE_KEY, TankView, ownDeviceId} from './autopilot/hotwater-shadow';
import {DEFAULT_INTERVAL_DAYS, MAX_FAILURES, OwnerHotwater, RestoreKey, TakeoverRecord, TakeoverWrite, gaveUp, noteFailure, noteRestored, noteTaken,
    noteWrite, readTakeover, restoreAll, restorePlan, retryDelayMs, same, takeoverPlan} from './autopilot/hotwater-takeover';
import {LEGIONELLA_WHEN_PERIODIC_OFF, LegionellaState, readSetting as readLegionella, readState as readLegionellaState,
    validSetting as validLegionella} from './autopilot/legionella';
import {FlowConflict, moreHotwaterFlows} from './autopilot/hotwater-flows';
import {KWH_PER_LITRE, STARTER_DAYS, localClock, readHousehold} from './autopilot/hotwater-learner';
import {DAY_TYPE_SETTING, DEFAULT_DAY_TYPE, DayTypeState, awayOn, dayTypeAt, homeDayTypeAt, readDayType, typeSet} from './autopilot/day-type';
import {Sample} from './autopilot/history';
import {DEFAULT_PROFILE, HeatingFeed, LiveMode, PumpFacts, StopReason, VERIFY_GAP_MS, VERIFY_TRIES, liveMode, profileLimits, rangeLimits, rangeFacts, CUSTOM_SETTINGS, customPresets, customValues, sunTrust, surplusPrices, withHotwater} from './autopilot/live';
import {AUTOPILOT_FUNCTIONS, SMART_MODE_STORE, SmartFunction, SmartMode, autopilotRuns, shownSmartMode, smartMode, smartModeWrites, spaOn} from './autopilot/smart-mode';
import {HeatingStatus, heatingStatus, learningText} from './autopilot/heating-status';
import {PeriodWatch, pricePeriods, startedTrigger} from './autopilot/heating-flows';
import {AWAY_UNTIL_SETTING, awayUntilLabel, readAwayUntil} from './autopilot/away';
import {forecastCorrection} from './autopilot/outdoor';
import {readTrim} from './autopilot/setpoint';
import {CurveStore, REPEAT_DAYS, addSample, curveAdvice, isNews, readCurveStore, trimShiftFor} from './autopilot/curve-advice';
import {WidgetData, aimingFor, chargeBands, symmetricAxis, formatDuration, heatingSlots, niceAxis, shiftBars, stripLead, ticks, todaySlots} from './autopilot/widget';
import {HotwaterUseData, TodayRow, hotwaterWeek, useRuns} from './autopilot/hotwater-use';
import {TankWidgetData, tankChart} from './autopilot/hotwater-tank';
import {ComfortDay, ComfortSlot, addComfortSlot, readComfortDays} from './autopilot/comfort-days';
import {ENERGY_ROLES, EnergyWidgetData, energyChart, useToday} from './autopilot/energy';
import {OVERVIEW_KINDS, OverviewData, OverviewRow, overviewData, priceThirds} from './autopilot/overview';
import {SLOT_MS, localDate, slotOf} from './autopilot/prices';
import {CostCheckData, CostDay, PlannedCost, addDay, chargeCosts, costCheckData, costDay, fillActual} from './autopilot/cost-check';
import {COP} from './autopilot/planner';
import {Edge, FORECAST_SLOTS, BlockedBy, HeatingDay, analyticsSmartMode, heatingBlock, reserveBucket} from './autopilot/analytics';
import {SOLAR_SETTING, SolarSurplus, readSolarAnswer, solarOn} from './autopilot/solar-surplus';
import {PumpRound, mainStatusText, spanText} from './autopilot/orchestrator';
import {DayPlanData, dayPlanData} from './autopilot/day-plan';
import {Device} from 'homey';
import net from 'net';
import {analyticsConsent, setAnalyticsConsent, track} from './analytics';
import {
    Dir, Register, Selection, encodeRegisterValue, toNumericValue, enumLabel, isPollable, isUnavailableRaw, migrateSelection,
    resolvedAddress, signedValue, withResolvedAddresses
} from './registers';
import {
    ACTIVE_POWER_CAPABILITY, ALARM_ACTIVE_CAPABILITY, ALARM_TEXT_CAPABILITY, AWAY_CAPABILITY,
    AUTOPILOT_AWAY_TEMPERATURE_CAPABILITY, AUTOPILOT_FED_CAPABILITY, AUTOPILOT_OUTDOOR_CAPABILITY, AUTOPILOT_RANGE_CAPABILITY,
    AUTOPILOT_REASON_CAPABILITY, AUTOPILOT_SHIFT_CAPABILITY, AUTOPILOT_STATUS_CAPABILITY,
    DAY_TYPE_CAPABILITY, FUNCTION_COP_CAPABILITY, HOTWATER_INLET_CAPABILITY, HOTWATER_VOLUME_CAPABILITY, METER_CAPABILITY,
    PUMP_ACTIVE_CAPABILITY, Role, SOLAR_METER_CAPABILITY, TOTAL_COP_CAPABILITY,
    capabilitySyncPlan, extraCapabilities, extraCapabilityOptions, functionRoles, mirrorOptions,
    mirrorsForRole, registersForRole, roleClass, roleOf, roleRegisters, deviceClass, roomThermostatActive,
    GroupMove, adoptMovedGroup, movedGroups, withAutopilotInputs
} from './roles';
import {ALARM_SOURCE_URL, alarmAdvice, alarmDescription} from './alarms';
import {
    ColdSample, COLD_WINDOW_DAYS, DEFAULT_INLET_C, MAX_TANK_LITRES, MIN_TANK_LITRES, MIX_C,
    dayNumber, learnedInletC, usableLitres
} from './hotwater';
import type {LocalizedText, ModelProfile} from './profile';
import {ConnectionProblem, PumpConnection, PumpSubscriber, POLL_SECONDS_DEFAULT, Transport,
    clampPollSeconds, inLanguage} from './connection';

/** Device store key (Heating): when the one-time Insights backfill of Autopilot's history ran
 *  (autopilot/heating-insights.ts) and how many slots it put in. Set once it ran, found or not. */
const BACKFILL_STORE = 'autopilotBackfill';
/** The backfill waits for init to settle, then retries while the device has no Homey id yet. */
const BACKFILL_FIRST_MS = 3 * 60_000;
const BACKFILL_RETRY_MS = 10 * 60_000;
const BACKFILL_TRIES = 6;
/** The setpoint trim's integral (autopilot/setpoint.ts), kept across restarts. */
const TRIM_STORE = 'autopilotTrim';
// The Away return whose warm-up has started (live.ts `warmingFor`).
const WARMING_STORE = 'autopilotWarmingFor';
// The Away temperature until the owner sets one.
const AWAY_DEFAULT_C = 17;
/** Device store key (Hot water): setup's household answers, Autopilot hot water's starting profile. */
const HOUSEHOLD_STORE = 'autopilotHotwaterHousehold';
/** Hot water device store: "Always keep at least", litres of 40 °C water; 0 leaves it to the pump.
 *  Set in Repair → Smart mode next to the other hot water choices (2026-11-14); it was a device
 *  setting shown, and mirrored, on every device of the pump. */
const RESERVE_STORE = 'autopilotReserve';
/** The owner's hot water settings from before Autopilot took them over, and what it wrote
 *  (autopilot/hotwater-takeover.ts): present only while Autopilot holds them. */
const TAKEOVER_STORE = 'hotwaterOwnerSettings';
/** The legionella temperature chosen in setup (autopilot/legionella.ts). */
const LEGIONELLA_STORE = 'autopilotLegionella';

/** Smart mode chosen in pairing, applied once when the device first runs (applyPairedSmartMode). */
const PAIRED_SMART_STORE = 'pairedSmartMode';
/** Heat curve advice (autopilot/curve-advice.ts): the owner's choice, daily samples, the last change. */
const CURVE_STORE = 'autopilotHeatCurve';
/** The Custom comfort range's values, set in Heating setup (live.ts CUSTOM_SETTINGS). */
const CUSTOM_RANGE_STORE = 'autopilotCustomRange';
/** The comfort range, set in Heating setup (no capability: it is not changed from the device). */
const RANGE_STORE = 'autopilotRange';
/** Heating's time in range, day by day (comfort-days.ts). */
const COMFORT_DAYS_STORE = 'autopilotComfortDays';
/** The savings widget's complete days, its currency, and the Smart mode changes it sorts days by. */
const SAVINGS_STORE = 'autopilotSavingsDays';
const SAVINGS_CURRENCY_STORE = 'autopilotSavingsCurrency';
const MODE_MARKS_STORE = 'autopilotModeMarks';
/** When Autopilot first ran live on this device (ms), and the baseline frozen from the days before. */
const FIRST_LIVE_STORE = 'autopilotFirstLive';
const BASELINE_STORE = 'autopilotSavingsBaseline';
/** Hot water's immersion heater hours (1069): a rise is a legionella boost day. */
const IMMERSION_HOURS_CAPABILITY = 'measure_hour_NIBE.i1069_additive_usage_hotwater';
/** Heating's season where the heat pump is (season.ts): the curve, the base it was made with, when. */
const SEASON_STORE = 'autopilotSeason';
/** The stored season is asked for again daily: the weather book goes to the network only when the
 *  place or the year's window changed, or a month passed, so a moved Homey gets its own season. */
const SEASON_KEEP_MS = 86_400_000;
/** This device's Homey id, for Insights URIs: looked up once (homeyDeviceId), it never changes. */
const HOMEY_ID_STORE = 'homeyDeviceId';
/** The indoor sensor read or feed set the device warning (clearIndoorWarning). */
const INDOOR_WARNING_STORE = 'indoorWarning';
/** Today so far, recounted every hour. */
const SAVINGS_TODAY_STORE = 'autopilotSavingsToday';
/** Plan vs actual (cost-check.ts): each day's first plan from local midnight on, hour by hour, and what it cost. */
export const COST_CHECK_STORE = 'autopilotCostCheck';
/** Days back the ledger is filled from: what Insights keeps hourly. */
const SAVINGS_BACK_DAYS = 13;
/** Seconds after the app starts during which missing prices or plans are still on their way. */
const STARTING_SECONDS = 300;
const HOUR_MS = 3_600_000;
/** A failed meter read is tried again this soon, this many times, before the hourly rhythm. */
const SAVINGS_RETRY_MS = 4 * 60_000;
const SAVINGS_RETRIES = 4;
const DEFAULT_RESERVE_LITRES = 40;
/** Pauses the Autopilot widget has an "what to do" line for (autopilot.widget.paused.*). */
const WIDGET_PAUSES = ['no_outdoor', 'spa_on', 'room_control', 'immersion_only', 'feed_failed', 'cooling'];
const MAX_RESERVE_LITRES = 500;

// How long the indoor feed may keep failing before the user is told (10 missed 30 s updates).
const INDOOR_ALERT_AFTER_MS = 5 * 60 * 1000;

// One logical function of the physical pump (see roles.ts). All devices share a single
// PumpConnection per pump host; this class is the Homey-facing subscriber: it maps its role's
// registers to capabilities, and — for function roles — keeps the energy bucket the
// connection's allocator feeds it. Model-specific data comes from the concrete subclass's
// `profile` (S or F).
/** A line's first letter in lower case, for a phrase that follows another ("Tomorrow · about 45 min"). */
function lowerFirst(text: string): string {
    return text ? text[0].toLowerCase() + text.slice(1) : text;
}

export abstract class NibePumpDevice extends Device implements PumpSubscriber {
    abstract profile: ModelProfile;

    role: Role = 'main';
    private capabilitiesSynced = false;
    private connection: PumpConnection | null = null;
    private thermostatSync: Promise<void> | null = null;

    private static indoorOwners = new Map<string, NibePumpDevice>();
    // Autopilot history, collected on Heating (lib/autopilot). Reads only.
    private autopilot: AutopilotCollector | null = null;
    private backfillTimer: any;
    // Hot water Autopilot in shadow, on Hot water, while the app setting below is on. Reads only.
    private hotwaterAutopilot: HotwaterAutopilot | null = null;
    private heatingFeed: HeatingFeed | null = null;
    /** The expensive and cheap periods' Flow triggers (heating-flows.ts), checked each minute. */
    private periodWatch = new PeriodWatch();
    // The heating Smart mode as a feed mode, as last applied (syncHeatingFeed).
    private heatingMode: LiveMode = 'off';
    /** The advice shown as the device warning, and whether a problem's warning is up instead
     *  (problems always win; advice shows only with the adviceWarnings setting on). */
    private adviceWarning?: string;
    private problemWarning = false;
    private adviceShown = false;
    /** The device warning and the unavailable reason as last set, for the Overview widget (Homey
     *  gives neither back). */
    private warningText?: string;
    private unavailableText?: string;
    /** A "paused" line went to the timeline, so the "resumed" after it is told too. */
    private pauseAnnounced = false;
    private heatingStatusShown?: HeatingStatus;
    /** Analytics, edge-triggered: the heating status and block last reported, and heating's day. */
    private heatingStateTold = new Edge<HeatingStatus>();
    private heatingBlockTold = new Edge<BlockedBy | undefined>();
    private heatingDay = new HeatingDay();
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
    /** Homey sensors read for Autopilot (indoor state `read`): their average and when it was taken. */
    private homeyIndoor?: {value: number; at: number};
    private indoorReadTimer: ReturnType<typeof setTimeout> | null = null;

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
        if (!register || !this.connection || this.indoorStopped) throw new Error('Can\'t send the indoor temperature right now.');
        await this.connection.writeRegisterValue(register, encodeRegisterValue(register, value));
        let measured: number | null = null;
        for (let attempt = 0; attempt < 16; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 750));
            measured = await this.indoorRaw(26);
            if (measured === Math.round(value * 10)) break;
        }
        if (measured !== Math.round(value * 10))
            throw new Error(`Your heat pump hasn't confirmed BT50 yet. Sent ${value.toFixed(1)} °C. `
                + (measured === null ? 'No BT50 reading came back.' : `Your heat pump reports ${(measured / 10).toFixed(1)} °C.`)
                + ' Homey keeps trying in the background.');
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
        if (this.role !== 'heating') throw new Error('Only the Heating device can send BT50.');
        if (this.indoorWork) throw new Error('A temperature update is running. Try again in a moment.');
        const owner = NibePumpDevice.indoorOwners.get(this.host());
        if (owner && owner !== this) throw new Error('Another Heating device already sends temperatures to this heat pump.');
        NibePumpDevice.indoorOwners.set(this.host(), this);
        const job = (async () => {
            const duplicate = (this.driver.getDevices() as any[]).some(d => d !== this
                && d.getSettings().address === this.host()
                && d.getStoreValue('indoorSensors')?.state === 'active');
            if (duplicate) throw new Error('Another Heating device already sends temperatures to this heat pump.');
            const config = cleanIndoorConfig(raw);
            averageSensors(config, await this.readIndoorSensors(config));
            if (await this.indoorRaw(5986) !== 1)
                throw new Error('Turn on external BT50 on your heat pump first.');
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
        if (this.indoorWork) throw new Error('A temperature update is running. Try again in a moment.');
        const job = (async () => {
            if (await this.indoorRaw(5986) !== 0)
                throw new Error('Choose your NIBE sensor for the zone and turn off external BT50 on your heat pump first.');
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

    private indoorReadOnly(): boolean {
        return this.role === 'heating' && this.getStoreValue('indoorSensors')?.state === 'read';
    }

    /** Autopilot's indoor temperature from Homey sensors, read every minute and never written to
     *  the pump. Shown as the device's indoor temperature, so what Autopilot acts on is visible. */
    private scheduleIndoorRead(delay = 0) {
        if (this.indoorReadTimer) clearTimeout(this.indoorReadTimer);
        this.indoorReadTimer = null;
        if (this.indoorStopped || !this.indoorReadOnly()) { this.homeyIndoor = undefined; return; }
        this.indoorReadTimer = setTimeout(async () => {
            this.indoorReadTimer = null;
            try {
                const config = this.getStoreValue('indoorSensors') as IndoorConfig;
                const value = averageSensors(config, await this.readIndoorSensors(config));
                this.homeyIndoor = {value, at: Date.now()};
                // External BT50 still enabled on the pump (menu 7.5.9.2): keep sending it, or the pump
                // raises a BT50 sensor fault (alarm 153, seen 2026-11-14). With room-sensor control
                // off the pump only shows it; it does not regulate on it.
                if (await this.indoorRaw(5986) === 1) {
                    const bt50 = this.profile.registerByName['external_temperature.h5987_bt50'];
                    if (bt50 && this.connection) await this.connection.writeRegisterValue(bt50, encodeRegisterValue(bt50, value));
                }
                if (this.hasCapability('measure_temperature') && this.getCapabilityValue('measure_temperature') !== value)
                    await this.setCapabilityValue('measure_temperature', value);
                await this.clearIndoorWarning();
                this.indoorFailingSince = null;
            } catch (error: any) {
                if (this.indoorFailingSince === null) {
                    this.indoorFailingSince = Date.now();
                    this.log('Reading the Homey indoor sensors failed, retrying:', error.message);
                } else if (Date.now() - this.indoorFailingSince >= INDOOR_ALERT_AFTER_MS) {
                    await this.setIndoorWarning(error.message);
                }
            } finally {
                this.scheduleIndoorRead(60_000);
            }
        }, delay);
    }

    /** The Homey sensors' average while fresh (10 min), for Autopilot's history. */
    private homeyIndoorNow(): number | undefined {
        return this.homeyIndoor && Date.now() - this.homeyIndoor.at < 10 * 60_000 ? this.homeyIndoor.value : undefined;
    }

    /** Read the chosen Homey sensors for Autopilot. While the pump still has external BT50 enabled
     *  the read loop keeps sending their average as BT50, or the pump raises a BT50 sensor fault
     *  (alarm 153, 2026-11-14); with room-sensor control off it only shows it. */
    async readIndoorForAutopilot(raw: any) {
        if (this.role !== 'heating') throw new Error('Only the Heating device reads the indoor temperature.');
        const config = readOnlyIndoorConfig(raw);
        const value = averageSensors(config, await this.readIndoorSensors(config));
        await this.stopFeedingBt50();
        await this.setStoreValue('indoorSensors', config);
        // The read loop keeps BT50 fed while the pump has external BT50 enabled (scheduleIndoorRead).
        this.scheduleIndoorRead();
        return {value};
    }

    /** Autopilot reads the pump's own sensor: stop reading Homey sensors, or sending them as BT50. */
    async stopReadingIndoor() {
        const state = this.getStoreValue('indoorSensors')?.state;
        if (state !== 'read' && state !== 'active') return;
        await this.stopFeedingBt50();
        await this.unsetStoreValue('indoorSensors');
        this.scheduleIndoorRead();
    }

    /** Stop sending Homey sensors as BT50, for Autopilot only (room-sensor control is off): the
     *  device reads its indoor temperature from the pump's own sensor again. */
    private async stopFeedingBt50() {
        if (this.getStoreValue('indoorSensors')?.state !== 'active') return;
        if (this.indoorWork) await this.indoorWork.catch(() => undefined);
        if (this.indoorTimer) clearTimeout(this.indoorTimer);
        this.indoorTimer = null;
        if (NibePumpDevice.indoorOwners.get(this.host()) === this) NibePumpDevice.indoorOwners.delete(this.host());
        const selection = this.getSelection();
        if (selection) await this.applySelection({...selection, addresses: {...selection.addresses,
            measure_temperature: this.getStoreValue('indoorNativeAddress') ?? 116}});
        this.indoorStatus = {state: 'idle'};
        this.log('Indoor: stopped sending Homey sensors as BT50; Autopilot reads them instead.');
    }

    private scheduleIndoor() {
        if (this.indoorTimer) clearTimeout(this.indoorTimer);
        if (this.indoorStopped || this.getStoreValue('indoorSensors')?.state !== 'active') return;
        this.indoorTimer = setTimeout(() => {
            this.indoorTimer = null;
            if (this.indoorWork) { this.scheduleIndoor(); return; }
            this.indoorWork = this.sendIndoor(this.getStoreValue('indoorSensors'))
                .then(async () => { this.indoorFailingSince = null; this.indoorAlerted = false; await this.clearIndoorWarning(); })
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
                    await this.setIndoorWarning(error.message);
                    await this.homey.notifications.createNotification({
                        excerpt: 'Nibe Live can\'t send the indoor temperature. Open Heating → Repair. ' + error.message
                    }).catch(this.error);
                }).finally(() => { this.indoorWork = null; this.scheduleIndoor(); });
        }, 30000);
    }

    private async stopIndoor() {
        this.indoorStopped = true;
        if (this.indoorTimer) clearTimeout(this.indoorTimer);
        this.indoorTimer = null;
        if (this.indoorReadTimer) clearTimeout(this.indoorReadTimer);
        this.indoorReadTimer = null;
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
        if (this.profile.readOnly) throw new Error("Settings on this heat pump model are read-only in Nibe Live.");
        if (register.name === 'external_temperature.h5987_bt50' && this.getStoreValue('indoorSensors')?.state === 'active')
            throw new Error('BT50 is set automatically from your Homey sensors.');
        if (register.name === this.profile.autopilotFeed?.bt1 && this.heatingFeed?.running)
            throw new Error('BT1 is managed by Autopilot heating.');
        if (register.role && register.role !== this.role)
            throw new Error('This action isn\'t available on this device');
        if (!this.connection)
            throw new Error('Not connected to your heat pump');
        if (register.noAction && !register.writeOnly)
            throw new Error('This setting is read-only');
        const room = this.profile.roomThermostat;
        if (room && (register.name === room.target || (register.name === room.enabled && value === true))) {
            const sensor = await this.readRegister(this.profile.registerByName[room.sensor]);
            if (typeof sensor !== 'number' || sensor < 5 || sensor > 40)
                throw new Error('Room temperature control requires a working indoor sensor.');
            if (register.name === room.target && await this.readRegister(this.profile.registerByName[room.enabled]) !== true)
                throw new Error('Room-sensor control is off. Adjust the heating curve instead.');
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
                    throw new Error('Your heat pump did not confirm the new value');
                this.recentWrites.set(register.name, {value: canonical, at: Date.now()});
                await this.setValue(register, canonical);
                await this.applyClearOnDisable(register, canonical);
            }
        } catch (error: any) {
            // Surface a clear, user-facing message instead of failing silently.
            throw new Error(`Couldn't set "${this.registerTitle(register)}": ${error?.message ?? error}`);
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
        // Homey sensors read for Autopilot are this device's indoor temperature: the pump's own
        // sensor does not overwrite what Autopilot acts on.
        if (register.name === 'measure_temperature' && this.indoorReadOnly()) return;
        await this.publishMirrors(register, value);
        const spa = this.profile.spaSwitches;
        // Awaited: a write by heat curve advice or Undo reads its own change back through here.
        if (register.name === this.profile.autopilotFeed?.curveOffset && this.role === 'heating')
            await this.curveOffsetRead(value === null || value === undefined ? NaN : Number(value)).catch(this.error);
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

    // The inlet we worked out, as a capability: an input to the litres figure, so a figure that
    // looks wrong has no invisible terms behind it. Blank until learned; the litres use
    // DEFAULT_INLET_C meanwhile. The tank size is shown and changed in Repair.
    private publishTankState() {
        if (!this.hasCapability(HOTWATER_INLET_CAPABILITY))
            return;
        const learned = this.learnedInlet();
        if (this.getCapabilityValue(HOTWATER_INLET_CAPABILITY) !== learned)
            this.setCapabilityValue(HOTWATER_INLET_CAPABILITY, learned).catch(this.error);
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
            capabilitySyncPlan(this.profile, this.role, selection, this.getCapabilities(), this.capabilitySmartMode(), this.carriesAway());
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
                this.registerCapabilityListener('target_temperature', async (value) => {
                    await this.writeRegister(source, value);
                    this.heatingFeed?.replanSoon(); // the thermostat is Autopilot's comfort target
                });
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
        // and the inlet, which a newly added capability shows only once it is written.
        if (this.role === 'hotwater' && this.profile.hotwaterTank) {
            this.publishTankState();
            this.updateHotwaterVolume();
        }
        if (failed.length)
            throw new Error(`Some readings couldn't be added: ${failed.join(', ')}. Your choice is saved. `
                + 'Run Repair again, and report it with the app logs if it keeps happening.');
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
        this.migrateSolarSetting();
        await this.migrateReserve();
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
            // The learned inlet, once the capability exists: on the first start after an update
            // that adds it, it does only now.
            if (this.role === 'hotwater' && this.profile.hotwaterTank)
                this.publishTankState();
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
            if (this.role === 'main' && (this.profile.autopilotHotwater || this.profile.autopilotFeed)) {
                this.registerCapabilityListener(DAY_TYPE_CAPABILITY, async (value) => {
                    this.log(`Day type set to ${value}`);
                    await (this.driver as any).setDayType(value);
                });
                this.registerCapabilityListener(AWAY_CAPABILITY, async (value) => (this.driver as any).setAway(value === true));
                await this.showDayType();
            }
            // Autopilot heating's own controls: registered whether or not the device carries them.
            if (this.role === 'heating' && this.profile.autopilotFeed) {
                this.registerCapabilityListener(AUTOPILOT_AWAY_TEMPERATURE_CAPABILITY, async (value) => {
                    this.log(`Away temperature set to ${value}`);
                    // A temperature is a setpoint: only that it changed is told, never to what.
                    if (value !== this.getCapabilityValue(AUTOPILOT_AWAY_TEMPERATURE_CAPABILITY)) this.trackSetting('away_temperature');
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
            // TEMP(warning clear): the 12:36 build's Proxy error was left as Heating's warning by code
            // that didn't store it (clearIndoorWarning came later). Cleared once, before this start's
            // own warnings are set. Remove with the other TEMP code.
            if (this.getStoreValue('proxyWarningCleared') !== 1) {
                await this.unsetWarning().catch(this.error);
                await this.setStoreValue('proxyWarningCleared', 1).catch(this.error);
            }
            this.indoorStopped = false;
            if (this.getStoreValue('indoorSensors')?.state === 'active') {
                const owner = NibePumpDevice.indoorOwners.get(this.host());
                if (owner && owner !== this) {
                    this.indoorStopped = true;
                    await this.setWarning('Another Heating device already sends temperatures to this heat pump.');
                } else NibePumpDevice.indoorOwners.set(this.host(), this);
            }
            this.scheduleIndoor();
            this.scheduleIndoorRead();
            await this.startAutopilotHistory().catch(this.error);
            if (this.getStoreValue('indoorSensors')?.state === 'pending')
                await this.setWarning('Finish your Homey sensor setup in Heating → Repair.');
        }
        if (this.role === 'hotwater') await this.syncHotwaterAutopilot().catch(this.error);
        if (this.role === 'heating' || this.role === 'hotwater') {
            if (!Array.isArray(this.getStoreValue(MODE_MARKS_STORE))) await this.markMode(this.smartMode()).catch(this.error);
            // TEMP(savings reset): heating's start date and baseline were stored by the code before
            // b870c03 (at the switch, not when the house model was ready). Read again once from
            // Insights. Remove with the other TEMP code (tasks/todo.md).
            if (this.role === 'heating' && this.getStoreValue('autopilotSavingsReset') !== 1) {
                for (const key of [FIRST_LIVE_STORE, BASELINE_STORE, SAVINGS_STORE]) await this.unsetStoreValue(key).catch(this.error);
                await this.setStoreValue('autopilotSavingsReset', 1);
                this.log('Savings: heating start, baseline and days reset, to be read again from Insights.');
            }
            // Heating and Hot water read Insights a few minutes apart, so their requests don't meet.
            this.scheduleSavings(this.role === 'heating' ? 90_000 : 3 * 60_000);
        }
        // Main reads only its idle meter, for Energy today, after Hot water: Energy today waits for all three.
        if (this.role === 'main' && this.hasCapability(METER_CAPABILITY)) this.scheduleSavings(4.5 * 60_000);
        if (this.getStoreValue(PAIRED_SMART_STORE)) this.homey.setTimeout(() => this.applyPairedSmartMode().catch(this.error), 15_000);
    }

    /** Pairing chose this function's Smart mode before the device existed: apply it once, through
     *  the same writes Repair makes, now the device has its connection. Autopilot heating was
     *  verified on the pump in pairing (pairing-pump.ts), so it is stored as verified. A failure
     *  is said on the device, never dropped: the owner can finish it in Repair. */
    private async applyPairedSmartMode() {
        const paired = this.getStoreValue(PAIRED_SMART_STORE) as {mode?: string; verified?: boolean; range?: string; custom?: unknown; curve?: string} | null;
        if (!paired?.mode) return;
        await this.unsetStoreValue(PAIRED_SMART_STORE);
        const mode = smartMode(paired.mode);
        try {
            if (this.role === 'heating' && mode === 'autopilot') {
                if (!paired.verified) throw new Error(this.homey.__('autopilot.smart.verify_first'));
                await this.setStoreValue('autopilotHeatingVerified', true);
                await this.writeSmartMode('autopilot');
                await this.storeSmartMode('autopilot');
            } else {
                await this.chooseSmartMode(mode);
            }
            this.log(`Smart mode from pairing applied: ${this.role} = ${mode}`);
            // The comfort range chosen in setup, once Autopilot's controls are on the device.
            if (this.role === 'heating' && paired.range && (mode === 'autopilot' || mode === 'test')) {
                if (paired.range === 'custom') await this.setCustomRange(paired.custom);
                else await this.setAutopilotProfile(paired.range);
            }
            if (this.role === 'heating' && (paired.curve === 'auto' || paired.curve === 'self')) await this.setCurveChoice(paired.curve);
        } catch (error: any) {
            this.error('Smart mode from pairing could not be applied:', error?.message ?? error);
            await this.setWarning(this.homey.__('autopilot.smart.paired_failed', {reason: error?.message ?? String(error)})).catch(this.error);
        }
    }

    /** What applySelection would leave this device with, for Repair's What changes: the same plan
     *  syncCapabilities follows, with this device's Smart mode as it now is. */
    previewCapabilities(selection: Selection): {wanted: string[]; smart: SmartMode} {
        const smart = this.capabilitySmartMode();
        return {wanted: capabilitySyncPlan(this.profile, this.role, selection, this.getCapabilities(), smart).wanted, smart};
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

    /** Whether this device carries the home's Away: Main, while Autopilot runs for hot water or heating. */
    private carriesAway(): boolean {
        return this.role === 'main' && (autopilotRuns(this.smartModeOf('hotwater')) || autopilotRuns(this.smartModeOf('heating')));
    }

    /** What the hot water setup step says about the day type: today's, by name, and whether it
     *  was set (by the owner or a Flow) or is the calendar's. */
    private dayTypeToday(): {name: string; set: boolean} {
        const state = readDayType(this.homey.settings.get(DAY_TYPE_SETTING));
        const type = dayTypeAt(state, Date.now(), localClock(this.homey.clock.getTimezone()));
        return {name: this.homey.__(`autopilot.hotwater_use.${type}`), set: typeSet(state)};
    }

    private dayTypeTimer?: any;
    /** The household's day type on Main while Autopilot hot water runs: the one set, or where none
     *  is, the calendar's (weekends free), so it is checked again at each hour's turn. The setting
     *  always exists: when none was ever set, Main stores a placeholder with no change logged. */
    async showDayType() {
        if (!readDayType(this.homey.settings.get(DAY_TYPE_SETTING)))
            this.homey.settings.set(DAY_TYPE_SETTING, {type: DEFAULT_DAY_TYPE, log: []} satisfies DayTypeState);
        if (this.dayTypeTimer) this.homey.clearTimeout(this.dayTypeTimer);
        this.dayTypeTimer = undefined;
        if (!this.hasCapability(DAY_TYPE_CAPABILITY) && !this.hasCapability(AWAY_CAPABILITY)) return;
        const now = Date.now();
        const state = readDayType(this.homey.settings.get(DAY_TYPE_SETTING));
        const type = homeDayTypeAt(state, now, localClock(this.homey.clock.getTimezone()));
        if (this.getCapabilityValue(DAY_TYPE_CAPABILITY) !== type)
            await this.setCapabilityValue(DAY_TYPE_CAPABILITY, type).catch(this.error);
        if (this.hasCapability(AWAY_CAPABILITY) && this.getCapabilityValue(AWAY_CAPABILITY) !== awayOn(state))
            await this.setCapabilityValue(AWAY_CAPABILITY, awayOn(state)).catch(this.error);
        this.dayTypeTimer = this.homey.setTimeout(() => this.showDayType().catch(this.error), 3_600_000 - now % 3_600_000 + 5_000);
        this.showRoundStatus();
    }

    /** Applies the pump's Smart modes to this device: its capabilities follow them, the Hot water
     *  device starts or stops Autopilot, the Heating device its feed. */
    async applyAutopilot() {
        if ((this.role === 'main' || this.role === 'heating' || this.role === 'hotwater') && this.capabilitiesSynced) {
            const {toAdd, toRemove} = capabilitySyncPlan(this.profile, this.role, this.getSelection(), this.getCapabilities(),
                this.capabilitySmartMode(), this.carriesAway());
            if (toAdd.length || toRemove.length) await this.syncCapabilities();
            if (this.role === 'main') await this.showDayType();
            if (this.role === 'heating') {
                await this.initAutopilotControls();
                // Autopilot heating turned on while the home is away goes away with it.
                await this.applyAway(awayOn(readDayType(this.homey.settings.get(DAY_TYPE_SETTING)))).catch(this.error);
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
            const devices = await api.devices.getDevices({$cache: false, $timeout: 10_000});
            const deviceIds = Object.entries(devices ?? {}).filter(([, d]: [string, any]) =>
                String(d?.driverId ?? '').startsWith(`homey:app:${appId}:`) && dataIds.has(String(d?.data?.id))).map(([id]) => id);
            const [flows, advanced] = await Promise.all([api.flow.getFlows({$timeout: 10_000}), api.flow.getAdvancedFlows({$timeout: 10_000})]);
            return moreHotwaterFlows(flows, advanced, {deviceIds, capabilities, prefix: this.profile.flowPrefix});
        }, PRIORITY.owner).catch((error: any) => {
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
            const id = await this.homeyDeviceId(api);
            if (!id) return undefined;
            const uri = `homey:device:${id}`;
            const log = await api.insights.getLogEntries({uri, id: `${uri}:${litres}`, resolution: 'last3Months', $timeout: 20_000});
            const dates = new Set((log?.values ?? []).filter((v: any) => typeof v?.v === 'number').map((v: any) => String(v.t).slice(0, 10)));
            return dates.size;
        }, PRIORITY.owner).catch(() => undefined);
    }

    /** Setup's answers for a home with a short history: stored, and learned from at once. */
    /** "Always keep at least", litres: the stored choice, else the old setting, else 40. */
    reserveLitres(): number {
        for (const raw of [this.getStoreValue(RESERVE_STORE), this.getSettings().autopilotReserve]) {
            const v = Number(raw);
            if (raw !== null && raw !== undefined && Number.isFinite(v) && v >= 0 && v <= MAX_RESERVE_LITRES) return v;
        }
        return DEFAULT_RESERVE_LITRES;
    }

    async setReserve(raw: any) {
        const litres = Number(raw);
        if (!Number.isInteger(litres) || litres < 0 || litres > MAX_RESERVE_LITRES)
            throw new Error(this.homey.__('pair.setup.smart.hw_reserve_invalid'));
        if (litres === this.getStoreValue(RESERVE_STORE)) return;
        await this.setStoreValue(RESERVE_STORE, litres);
        this.log(`Autopilot hot water: always keep at least ${litres} L`);
        this.trackSetting('reserve', reserveBucket(litres));
        (this.driver as any).syncInstallProfile?.();
    }

    /** One-off: the old setting's value becomes the stored choice, so the move loses nothing. */
    private async migrateReserve() {
        if (this.role !== 'hotwater' || this.getStoreValue(RESERVE_STORE) != null) return;
        const v = Number(this.getSettings().autopilotReserve);
        if (Number.isFinite(v) && v >= 0 && v <= MAX_RESERVE_LITRES)
            await this.setStoreValue(RESERVE_STORE, Math.round(v)).catch(this.error);
    }

    async setHousehold(raw: any) {
        const household = raw == null ? undefined : readHousehold(raw);
        if (raw != null && !household) throw new Error(this.homey.__('pair.setup.smart.household_invalid'));
        // Only whether the household was answered or cleared: the answers are the home's.
        if (!!household !== !!readHousehold(this.getStoreValue(HOUSEHOLD_STORE))) this.trackSetting('household', household ? 'on' : 'off');
        await this.setStoreValue(HOUSEHOLD_STORE, household ?? null);
        this.log(`Autopilot hot water household: ${household ? JSON.stringify(household) : 'cleared'}`);
        this.hotwaterAutopilot?.relearn();
    }

    /** The slots hot water's plan has the compressor, from `from`; undefined while it is off. */
    hotwaterChargeSlots(from: number, n: number): boolean[] | undefined {
        return this.hotwaterAutopilot?.chargeSlots(from, n);
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
            this.round().setHotwater(undefined);
            await this.unsetWarning().catch(this.error);
            await this.syncHotwaterTakeover();
            return;
        }
        // Live takes over the pump's own charging, a test run gives it back.
        await this.syncHotwaterTakeover();
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
                    stopC: mode === undefined ? undefined : number(spec.stops[mode]), largeStopC: number(spec.largeStop), produced: number(spec.tank.produced)},
                tank: litres === null ? undefined : {litres, inletC},
            };
        }, (...args) => this.log(...args), {
            homeyId: (api) => this.homeyDeviceId(api),
            mode: live,
            reserveLitres: () => this.reserveLitres(),
            solar: () => this.solarAllowed(),
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
                if (what === 'boost' && !spec.moreHours) throw new Error('More hot water in hours is not available on this heat pump');
                const name = what === 'stop' ? spec.largeStop : what === 'boost' ? spec.moreHours! : spec.more;
                this.log(`Autopilot hot water: writing ${name} = ${value}`);
                if (what !== 'boost') return this.writeRegister(register(name), value);
                await this.writeBoost(Number(value));
            },
            legionella: () => this.legionellaRun(),
            periodicBoost: (on) => this.setPeriodicBoost(on),
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
            track: (event, properties) => track(event, properties),
            planned: (from, charges) => this.noteCostPlan(from, chargeCosts(charges, SLOT_MS)),
            status: (text) => {
                if (this.hasCapability(AUTOPILOT_REASON_CAPABILITY) && this.getCapabilityValue(AUTOPILOT_REASON_CAPABILITY) !== text)
                    this.setCapabilityValue(AUTOPILOT_REASON_CAPABILITY, text).catch(this.error);
            },
            preheat: (slot) => this.round().preheat(slot),
            replanned: (charges) => this.round().setHotwater(charges, live() !== 'live'),
        });
        // A charge's own draw is what the meter would otherwise export: added back to the live reading.
        this.solarSurplus().draw(this, () => number(spec.power));
        this.log(`Autopilot hot water started (${live() === 'live' ? 'live' : 'test run'}).`);
        await this.hotwaterAutopilot.start();
        // After a restart with no plan for today yet: the plan in force stands in for it.
        const kept = this.hotwaterAutopilot.dayPlan();
        if (kept?.charges.length) this.noteCostPlan(Date.now(), chargeCosts(kept.charges, SLOT_MS));
    }

    /** More hot water for `hours` (697's hours picker, as text, as a Flow card sends it). Its
     *  read-back may not match: the pump may report the hours left rather than the hours written
     *  (not verified on hardware). So a boost that reads on afterwards has started, and a mismatch
     *  is only logged. */
    async writeBoost(hours: number) {
        const spec = this.profile.autopilotHotwater;
        if (!spec?.moreHours) throw new Error('More hot water in hours is not available on this heat pump');
        try {
            await this.writeRegister(this.register(spec.moreHours), String(hours));
        } catch (error: any) {
            if ((await this.readNamed(spec.more)) !== true) throw error;
            this.log(`Autopilot hot water: More hot water is on after writing ${hours} h, though the read-back differed:`,
                error?.message ?? error);
        }
    }

    /** The pump's hot water settings Autopilot takes over, read now; missing where one did not answer. */
    private async readOwnerHotwater(): Promise<OwnerHotwater> {
        const spec = this.profile.autopilotHotwater, t = spec?.takeover;
        if (!spec || !t) return {};
        return {demandMode: await this.readTakenValue('demandMode'), startSmallC: await this.readTakenValue('startSmallC'),
            periodic: await this.readTakenValue('periodic') as boolean | undefined, largeStopC: await this.readTakenValue('largeStopC') as number | undefined,
            intervalDays: await this.readNumber(t.interval), periodicStopC: await this.readNumber(t.periodicStop)};
    }

    private async readNumber(name: string): Promise<number | undefined> {
        // A picker (demand mode, interval) reads back as its id in text: "0".
        const v = await this.readNamed(name);
        const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
        return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
    }

    private takenRegister(key: RestoreKey): string {
        const spec = this.profile.autopilotHotwater!, t = spec.takeover!;
        return key === 'demandMode' ? spec.demandMode : key === 'startSmallC' ? t.startSmall : key === 'periodic' ? t.periodic : spec.largeStop;
    }

    private async readTakenValue(key: RestoreKey): Promise<any> {
        const name = this.takenRegister(key);
        if (key !== 'periodic') return this.readNumber(name);
        const v = await this.readNamed(name);
        return typeof v === 'boolean' ? v : undefined;
    }

    /** Writes one setting and reads it back: what the pump holds afterwards, whether or not the
     *  write itself reported a problem (a clamped value fails writeRegister's check, yet it is
     *  what the pump now holds). Undefined when it does not read. */
    private async writeTaken(w: TakeoverWrite): Promise<number | boolean | undefined> {
        const name = this.takenRegister(w.key);
        this.log(`Autopilot hot water: writing ${name} = ${w.value}`);
        await this.writeRegister(this.register(name), w.key === 'demandMode' ? String(w.value) : w.value)
            .catch((error) => this.error(`Autopilot hot water: writing ${name} failed:`, error?.message ?? error));
        return this.readTakenValue(w.key);
    }

    private takeoverQueue: Promise<void> = Promise.resolve();
    private takeoverTimer?: any;
    private takeoverWaiting?: string;
    /** Tries in a row that left something undone, for the back-off. */
    private takeoverAttempts = 0;
    /** Set while the device is being deleted: Autopilot gives the settings back whatever its mode. */
    private removing = false;

    /** Live Autopilot holds the pump's own charging and periodic boost; anything else gives them
     *  back. One at a time; whatever is left undone is tried again after a back-off. */
    private syncHotwaterTakeover(): Promise<void> {
        const run = this.takeoverQueue.then(() => this.applyTakeover());
        this.takeoverQueue = run.catch(() => undefined);
        return run;
    }

    /** Something is left undone: again in 5 min, 30 min, 2 h, then every 6 h. */
    private retryTakeover(why: string) {
        if (this.takeoverWaiting !== why) this.log(`Autopilot hot water: the heat pump's own charging not ${why}; trying again later.`);
        this.takeoverWaiting = why;
        if (this.removing) return;
        const ms = retryDelayMs(this.takeoverAttempts++);
        this.takeoverTimer = this.homey.setTimeout(() => {
            this.takeoverTimer = undefined;
            this.syncHotwaterTakeover().catch(this.error);
        }, ms);
    }

    private takeoverDone() {
        this.takeoverWaiting = undefined;
        this.takeoverAttempts = 0;
    }

    /** Settings Autopilot stopped writing after MAX_FAILURES tries, said once on the device by name. */
    private async warnGaveUp(saved: TakeoverRecord, key: string) {
        const keys = (Object.keys(saved.failures ?? {}) as RestoreKey[]).filter((k) => gaveUp(saved, k));
        if (!keys.length) return;
        const names = keys.map((k) => this.registerTitle(this.register(this.takenRegister(k)))).join(', ');
        this.error(`Autopilot hot water: stopped writing ${names} after ${MAX_FAILURES} failed tries.`);
        await this.setWarning(this.homey.__(key, {setting: names})).catch(this.error);
    }

    private async applyTakeover() {
        if (this.takeoverTimer) this.homey.clearTimeout(this.takeoverTimer);
        this.takeoverTimer = undefined;
        if (!this.profile.autopilotHotwater?.takeover) return;
        let saved = readTakeover(this.getStoreValue(TAKEOVER_STORE));
        if (this.removing) return saved ? this.restoreOnDelete(saved) : undefined;
        const live = this.autopilotMode() === 'live';
        if (!live && !saved) return this.takeoverDone();
        if (live) {
            const plan = takeoverPlan(await this.readOwnerHotwater(), saved, Date.now());
            if ('skip' in plan) return this.retryTakeover(plan.skip === 'unread' ? 'taken over (no reading)' : 'taken over (Smart control)');
            // The owner's values are kept before anything is written, so a cut-short takeover still restores.
            if (plan.save) {
                saved = plan.save;
                await this.setStoreValue(TAKEOVER_STORE, saved);
                // The legionella interval carries on from an earlier takeover; only the safety net ends.
                const state = readLegionellaState(this.getStoreValue(LEGIONELLA_STATE_KEY));
                const next: LegionellaState = state ? {...state} : {since: saved.at};
                delete next.fallbackAt;
                await this.setStoreValue(LEGIONELLA_STATE_KEY, next);
                this.log(`Autopilot hot water took over the heat pump's own charging; the owner's settings: ${JSON.stringify(saved.owner)}`);
            }
            for (const c of plan.confirmed) saved = noteTaken(saved!, c.key, c.value);
            for (const w of plan.writes) {
                saved = noteTaken(saved!, w.key, await this.writeTaken(w));
                await this.setStoreValue(TAKEOVER_STORE, saved);
            }
            if (plan.confirmed.length) await this.setStoreValue(TAKEOVER_STORE, saved);
            const left = plan.writes.filter((w) => saved!.wrote[w.key] === undefined);
            if (!left.length) return this.takeoverDone();
            await this.warnGaveUp(saved!, 'autopilot.hotwater_takeover.gave_up');
            if (left.every((w) => gaveUp(saved, w.key))) return this.takeoverDone();
            await this.setWarning(this.homey.__('autopilot.hotwater_takeover.write_failed',
                {settings: left.map((w) => this.registerTitle(this.register(this.takenRegister(w.key)))).join(', ')})).catch(this.error);
            return this.retryTakeover('taken over (write failed)');
        }
        const plan = restorePlan(await this.readOwnerHotwater(), saved!);
        if (plan.unread.length) return this.retryTakeover('given back (no reading)');
        const failed: TakeoverWrite[] = [];
        for (const w of plan.writes) {
            // 56 back to Large only once Large's own stop is back.
            if (w.key === 'demandMode' && failed.length) continue;
            const back = await this.writeTaken(w);
            saved = same(back, w.value) ? noteRestored(saved!, w.key) : noteFailure(saved!, w.key);
            if (!same(back, w.value) && !gaveUp(saved, w.key)) failed.push(w);
            await this.setStoreValue(TAKEOVER_STORE, saved);
        }
        await this.warnGaveUp(saved!, 'autopilot.hotwater_takeover.gave_up');
        if (failed.length) {
            await this.setWarning(this.homey.__('autopilot.hotwater_takeover.restore_failed',
                {settings: failed.map((w) => this.registerTitle(this.register(this.takenRegister(w.key)))).join(', ')})).catch(this.error);
            return this.retryTakeover('given back (write failed)');
        }
        await this.unsetStoreValue(TAKEOVER_STORE);
        // Kept: the interval carries on if Autopilot goes live again. The safety net ends with the restore.
        const state = readLegionellaState(this.getStoreValue(LEGIONELLA_STATE_KEY));
        if (state?.fallbackAt !== undefined) {
            const next = {...state};
            delete next.fallbackAt;
            await this.setStoreValue(LEGIONELLA_STATE_KEY, next);
        }
        this.takeoverDone();
        this.log(`Autopilot hot water gave the heat pump its own charging back: ${plan.writes.length
            ? plan.writes.map((w) => `${w.key} = ${w.value}`).join(', ') : 'nothing to put back'}.`);
    }

    /** The device is being deleted: one attempt to write every owner value back without reading
     *  first (an unreachable pump reads nothing). There is no device left to warn on, so a failure
     *  goes to the log and the timeline with the values to set by hand. */
    private async restoreOnDelete(saved: TakeoverRecord) {
        const writes = restoreAll(saved);
        const failed: string[] = [];
        for (const w of writes) {
            const back = await this.writeTaken(w).catch(() => undefined);
            if (!same(back, w.value)) failed.push(`${this.registerTitle(this.register(this.takenRegister(w.key)))} = ${w.value}`);
        }
        if (!failed.length) return this.log('Autopilot hot water: the device was deleted; the heat pump has its own hot water settings back.');
        this.error(`AUTOPILOT HOT WATER: the device was deleted but these settings could not be put back on the heat pump: ${failed.join(', ')}`);
        await this.homey.notifications?.createNotification({excerpt: this.homey.__('autopilot.hotwater_takeover.deleted_failed',
            {settings: failed.join(', ')})}).catch(this.error);
    }

    /** The legionella run's temperature and interval while live Autopilot holds the periodic
     *  boost, and the pump's own boost temperature (61) for ending the safety net. */
    private legionellaRun(): {targetC: number; intervalDays: number; pumpC?: number} | undefined {
        if (this.autopilotMode() !== 'live') return undefined;
        const saved = readTakeover(this.getStoreValue(TAKEOVER_STORE));
        if (!saved) return undefined;
        // An owner who had the periodic boost off: the one branch the maintainer may change.
        if (!LEGIONELLA_WHEN_PERIODIC_OFF && saved.owner.periodic === false) return undefined;
        return {targetC: readLegionella(this.getStoreValue(LEGIONELLA_STORE)).c,
            intervalDays: saved.owner.intervalDays ?? DEFAULT_INTERVAL_DAYS, pumpC: saved.owner.periodicStopC};
    }

    /** The legionella safety net: the pump's own periodic boost on, or off again once a charge got
     *  there (only if it is still on as Autopilot left it). Recorded as what the pump confirmed, so
     *  stopping Autopilot puts the owner's value back. Throws when the pump does not take it. */
    private async setPeriodicBoost(on: boolean) {
        const saved = readTakeover(this.getStoreValue(TAKEOVER_STORE));
        if (!this.profile.autopilotHotwater?.takeover || !saved) return;
        const now = await this.readTakenValue('periodic');
        if (now === on || (!on && saved.wrote.periodic !== true)) return;
        const back = await this.writeTaken({key: 'periodic', value: on});
        if (back !== on) throw new Error(`Couldn't set "${this.registerTitle(this.register(this.takenRegister('periodic')))}"`);
        await this.setStoreValue(TAKEOVER_STORE, noteWrite(readTakeover(this.getStoreValue(TAKEOVER_STORE)) ?? saved, 'periodic', on));
    }

    /** Setup's legionella step: the choice and temperature. */
    async setLegionella(raw: any) {
        const setting = validLegionella(raw);
        if (!setting) throw new Error(this.homey.__('pair.setup.smart.hw_legionella_invalid'));
        await this.setStoreValue(LEGIONELLA_STORE, setting);
        this.log(`Autopilot hot water legionella: ${setting.choice}, ${setting.c} °C`);
    }

    /** What the legionella step shows: the choice, the pump's own temperature (61) and interval (66). */
    private async legionellaStatus() {
        const t = this.profile.autopilotHotwater?.takeover;
        const saved = readTakeover(this.getStoreValue(TAKEOVER_STORE));
        const read = t ? await this.readOwnerHotwater() : {} as OwnerHotwater;
        const stored = this.getStoreValue(LEGIONELLA_STORE);
        return {legionella: stored == null ? null : readLegionella(stored),
            legionellaPumpC: read.periodicStopC ?? saved?.owner.periodicStopC ?? null,
            legionellaDays: saved?.owner.intervalDays ?? read.intervalDays ?? DEFAULT_INTERVAL_DAYS};
    }

    /** This poll for the hot water compressor ceiling: is a charge running, is the immersion heater
     *  on, and the charge sensor (BT6, else the top). */
    private pollHotwaterCeiling(readNames: Set<string>) {
        const spec = this.profile.autopilotHotwater;
        if (!this.hotwaterAutopilot || !spec) return;
        const power = this.hasCapability(spec.power) ? Number(this.getCapabilityValue(spec.power)) : NaN;
        const immersion = this.autopilotValue(readNames, spec.immersion);
        this.hotwaterAutopilot.poll({at: Date.now(), charging: Number.isFinite(power) ? power > 0 : undefined,
            immersion: immersion === undefined ? undefined : immersion !== 0, c: this.tankLowerC ?? this.tankTopC ?? undefined});
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
        const selected = registersForRole(this.profile, this.role, withAutopilotInputs(this.profile, this.role, this.getSelection(), this.capabilitySmartMode()));
        // Hot water Autopilot follows the immersion heater (1029, Main's) for the compressor ceiling.
        const immersion = this.profile.autopilotHotwater?.immersion;
        if (this.role === 'hotwater' && immersion && this.autopilotMode() !== 'off' && this.profile.registerByName[immersion]
            && !selected.some((r) => r.name === immersion))
            return [...selected, this.profile.registerByName[immersion]];
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
        this.autopilot.onFit = () => this.checkHeatCurve().catch((error) => this.log('Heat curve advice:', error?.message ?? error));
        await this.autopilot.start();
        this.scheduleBackfill(BACKFILL_FIRST_MS, BACKFILL_TRIES);
        this.startHeatingFeed();
    }

    private scheduleBackfill(ms: number, tries: number) {
        if (this.getStoreValue(BACKFILL_STORE) != null) return;
        this.backfillTimer = this.homey.setTimeout(() => {
            this.backfillTimer = undefined;
            this.backfillAutopilotHistory(tries).catch((error) => this.log('Autopilot history: backfill failed:', error?.message ?? error));
        }, ms);
    }

    /** Once per device: fill Autopilot's history before its first polled slot from this pump's
     *  Insights, so the house model fits on day one. Runs off init; needs the device's Homey id,
     *  which a just-paired device may not have yet, so it retries a few times and otherwise tries
     *  again at the next start. Reads only. */
    // TEMP(mem)
    private backfillAutopilotHistory(tries: number) { return memMark('history backfill', () => this.backfillAutopilotHistoryInner(tries)); }
    private async backfillAutopilotHistoryInner(tries: number) {
        const collector = this.autopilot;
        const spec = this.profile.autopilotHistory;
        if (!collector || !spec || this.getStoreValue(BACKFILL_STORE) != null) return;
        const done = (slots: number) => this.setStoreValue(BACKFILL_STORE, {at: Date.now(), slots});
        if (!collector.backfillWindow()) return done(0);
        const appId = this.homey.manifest?.id ?? 'com.nibe.local';
        const dataIds = new Set(this.pumpDevices().map((d) => String(d.getData().id)));
        const {te, ...rest} = spec.numeric;
        const named: Record<string, string | undefined> = {...rest, bt1: te};
        const capabilities = Object.fromEntries(BACKFILL_FIELDS.filter((f) => named[f]).map((f) => [f, named[f]])) as
            Partial<Record<BackfillField, string>>;
        const ref = this.homey.settings.get(OUTDOOR_SENSOR_SETTING) as LogSource | null;
        const sensor = ref?.deviceId && ref.capabilityId ? ref : undefined;
        const found = await withApi(this.homey, async (api) => {
            const devices = await api.devices.getDevices({$cache: false, $timeout: 10_000});
            const ownId = ownDeviceId(devices, appId, String(this.getData().id));
            if (!ownId) return undefined;
            const pumpIds = Object.entries(devices ?? {}).filter(([, d]: [string, any]) =>
                String(d?.driverId ?? '').startsWith(`homey:app:${appId}:`) && dataIds.has(String(d?.data?.id))).map(([id]) => id);
            const sources = backfillSources(devices, ownId, pumpIds, capabilities, sensor);
            const pause = (ms: number) => new Promise<void>((resolve) => this.homey.setTimeout(resolve, ms));
            return fetchHeatingInsights(api, sources, pause);
        }, PRIORITY.background).catch((error: any) => {
            this.log('Autopilot history: could not read Insights for the backfill:', error?.message ?? error);
            return undefined;
        });
        if (this.autopilot !== collector) return;
        if (!found || !anyLogRead(found)) {
            if (tries > 1) this.scheduleBackfill(BACKFILL_RETRY_MS, tries - 1);
            return;
        }
        await done(await collector.backfill(found, sensor && `${sensor.deviceId}/${sensor.capabilityId}`));
    }

    /** Autopilot heating (live.ts), run by heating's Smart mode: `test` plans and reports,
     *  `autopilot` feeds BT1. */
    private startHeatingFeed() {
        const spec = this.profile.autopilotFeed;
        const collector = this.autopilot;
        if (!spec || !collector || this.heatingFeed) return;
        this.heatingFeed = new HeatingFeed({
            mode: () => this.heatingMode,
            limits: () => this.heatingLimits(),
            neutral: () => this.heatingRange() === 'off',
            sunTrust: () => this.autopilot?.sunReady()
                ? sunTrust(this.autopilotAway() ? 'save_most' : this.heatingRange()) : 0,
            indoorMean: (slot) => this.autopilot?.indoorMeanAt(slot),
            plan: (slot) => {
                const planned = this.autopilot?.liveInputs(slot);
                if (!planned) return planned;
                this.scoreHeatingSlot(slot, planned.ti, planned.forecast[0]?.te, planned.forecast[0]?.sun);
                // Hot water goes first (the plan round, orchestrator.ts): while it has the compressor,
                // the house gets nothing from it.
                const busy = this.round().deliveryFree(slot, planned.forecast.length);
                const input = {...planned, forecast: withHotwater(planned.forecast, busy)};
                // Solar surplus left for heating after hot water took its share makes those slots cheap.
                if (!this.solarAllowed()) return input;
                return {...input, forecast: surplusPrices(input.forecast, slot, this.solarSurplus().forUser('heating', slot), input.lever)};
            },
            // The thermostat is the goal (setpoint.ts): Away sets it to the Away temperature.
            setpoint: () => {
                const v = Number(this.getCapabilityValue('target_temperature'));
                return this.hasCapability('target_temperature') && Number.isFinite(v) ? v : undefined;
            },
            // Away with an end time: back to the thermostat's own temperature then (autopilot/away.ts).
            awayReturn: () => {
                const at = this.autopilotAway() ? readAwayUntil(this.homey.settings.get(AWAY_UNTIL_SETTING)) : undefined;
                const home = Number(this.getStoreValue('autopilotHome'));
                return at !== undefined && Number.isFinite(home) ? {at, setpoint: home} : undefined;
            },
            // The warm-up for a return holds across a restart (live.ts `warmingFor`).
            loadWarming: () => {
                const v = Number(this.getStoreValue(WARMING_STORE));
                return Number.isFinite(v) && v > 0 ? v : undefined;
            },
            saveWarming: (at) => { (at === undefined ? this.unsetStoreValue(WARMING_STORE) : this.setStoreValue(WARMING_STORE, at)).catch(this.error); },
            loadTrim: () => readTrim(this.getStoreValue(TRIM_STORE)),
            saveTrim: (state) => { this.setStoreValue(TRIM_STORE, state).catch(this.error); },
            pump: () => this.heatingPumpFacts(),
            outdoor: () => collector.outdoorNow(),
            write: (celsius) => this.writeBt1(celsius),
            readBack: () => this.readFedOutdoor(),
            feeding: (on) => collector.setFeeding(on),
            // Waiting on the forecast with a model in hand is not a problem to warn about.
            warn: (reason) => {
                this.problemWarning = !!reason && !(reason === 'no_model' && this.autopilot?.houseSummary());
                (this.problemWarning ? this.setWarning(this.homey.__(`autopilot.heating.warning.${reason}`)) : this.showAdviceWarning(true))
                    .catch(this.error);
            },
            changed: () => {
                const state = this.heatingFeed?.state;
                this.round().setHeating(state?.slot !== undefined && state.biases ? {slot: state.slot, biases: state.biases} : undefined,
                    this.heatingMode === 'test');
                this.showHeatingStatus().catch(this.error);
            },
            tick: () => this.checkPricePeriods(),
            log: (...args) => this.log(...args),
            record: (entry) => collector.recordLive(entry),
            planned: (slot, forecast, heat) => {
                const cop = Number(this.getCapabilityValue('measure_cop_NIBE.rolling'));
                const use = Number.isFinite(cop) && cop > 1 ? cop : COP;
                this.noteCostPlan(slot * SLOT_MS, forecast.map((f, k) => ({at: (slot + k) * SLOT_MS, cost: (heat[k] ?? 0) / use * f.price})));
            },
            setTimeout: (fn, ms) => this.homey.setTimeout(fn, ms),
            clearTimeout: (timer) => this.homey.clearTimeout(timer),
            sleep: (ms) => new Promise((resolve) => this.homey.setTimeout(resolve, ms)),
            now: () => Date.now(),
        });
        // Hot water's charges moved: replan around them within the slot (§2.1's order).
        this.roundOff?.();
        this.roundOff = this.round().onCharges(() => this.heatingFeed?.replanSoon());
        this.syncHeatingFeed();
    }

    /** This pump's plan round (orchestrator.ts). */
    private round(): PumpRound {
        return PumpRound.for(this.host());
    }

    private roundOff?: () => void;
    private roundHost?: string;

    /** Main's "Autopilot now" line: what the pump does next across hot water and heating. It
     *  follows the round of the pump's current address. */
    private showRoundStatus() {
        if (this.role !== 'main') return;
        if (this.roundHost !== this.host()) {
            this.roundOff?.();
            this.roundHost = this.host();
            this.roundOff = this.round().onChange(() => this.showRoundStatus());
        }
        if (!this.hasCapability(AUTOPILOT_REASON_CAPABILITY)) return;
        const text = this.roundStatusText();
        if (text !== undefined && this.getCapabilityValue(AUTOPILOT_REASON_CAPABILITY) !== text)
            this.setCapabilityValue(AUTOPILOT_REASON_CAPABILITY, text).catch(this.error);
    }

    /** The plan round's line, worded, or undefined while no controller has a plan. */
    private roundStatusText(): string | undefined {
        const status = this.round().status(Date.now());
        if (!status) return undefined;
        const clock = localClock(this.homey.clock.getTimezone());
        const today = clock(Date.now()).date;
        const when = (ms: number) => clock(ms).date === today ? this.clock(ms)
            : this.homey.__('autopilot.hotwater_daily.tomorrow_bare', {time: this.clock(ms)});
        return mainStatusText(status, (key, tokens) => this.homey.__(`autopilot.orchestrator.${key}`, tokens), when,
            (from, to) => {
                const span = spanText(from, to, this.clock);
                return clock(from).date === today ? span : this.homey.__('autopilot.hotwater_daily.tomorrow_bare', {time: span});
            });
    }

    // ---- The Day plan widget (widgets/day_plan) ----

    /** What the Day plan widget draws: the pump's whole plan today, from Main. It reuses the two
     *  Autopilot widgets' data, so the three cards always agree. */
    dayPlanWidget(): DayPlanData {
        const t = (key: string, tokens?: Record<string, string | number>) => this.homey.__(`autopilot.day_plan.${key}`, tokens);
        const w = (key: string, tokens?: Record<string, string | number>) => this.homey.__(`autopilot.widget.${key}`, tokens);
        const slot = slotOf(Date.now());
        const day = todaySlots(slot, (ms) => localClock(this.homey.clock.getTimezone())(ms).date);
        const now = slot - day.from;
        const sibling = (role: string) => this.pumpDevices().find((d) => d.role === role);
        const heating = sibling('heating'), hotwater = sibling('hotwater');
        // Heating's prices fill the price lane when hot water has no Autopilot: its plan's forecast.
        const feed = heating?.heatingFeed?.state;
        const heatingPrices = feed?.slot === undefined || !feed.forecast ? undefined
            : Array.from({length: day.n}, (_, k) => feed.forecast![day.from + k - feed.slot!]?.price);
        return dayPlanData({title: this.getName(), status: this.roundStatusText(), hotwater: hotwater?.autopilotWidget(),
            heating: heating?.autopilotWidget(), heatingPrices, ticks: ticks(day.from * SLOT_MS, day.n, this.clock),
            n: day.n, now, t, w});
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
        if (!this.connection) throw new Error('Not connected to your heat pump');
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
        this.roundOff?.();
        this.roundOff = undefined;
        if (this.role === 'heating') this.round().setHeating(undefined);
    }

    /** Plan heating again now: Away's end time changed (driver `setAway`). */
    replanHeating() {
        this.heatingFeed?.replanSoon();
    }

    /** The "expensive / cheap period starts in …" triggers: the periods the Heating status names,
     *  from the plan in force, each fired once per Flow at its lead (heating-flows.ts). After each
     *  30 s feed cycle, so only while Autopilot heating plans, live or Simulated. */
    private checkPricePeriods() {
        const state = this.heatingFeed?.state;
        if (!state || state.mode === 'off' || state.stopped || state.slot === undefined || !state.forecast?.length) {
            this.periodWatch.pause();
            return;
        }
        const now = Date.now();
        const periods = pricePeriods(state.forecast.map((f) => f.price), state.slot, now);
        for (const trigger of this.periodWatch.check(periods, now)) {
            this.homey.flow.getDeviceTriggerCard((this.profile.flowPrefix ?? '') + `autopilot_heating_${trigger.kind}_soon`)
                .trigger(this, {start: this.clock(trigger.start), end: this.clock(trigger.end)}, trigger).catch(this.error);
        }
    }

    private clock = (ms: number) => localeTime(ms, 'sv-SE', {timeZone: this.homey.clock.getTimezone(), hour: '2-digit', minute: '2-digit'});

    /** A time, with the weekday in the owner's language when it is not today: "Thu 18:00". */
    private clockOn(ms: number): string {
        const timeZone = this.homey.clock.getTimezone();
        const date = (t: number) => localeDate(t, 'en-CA', {timeZone});
        if (date(ms) === date(Date.now())) return this.clock(ms);
        const day = localeDate(ms, this.homey.i18n?.getLanguage?.() ?? 'en', {timeZone, weekday: 'short'});
        return `${day} ${this.clock(ms)}`;
    }

    /** When Away ends, for the widgets (`awayUntilLabel`). Undefined while the home is not away
     *  or Away has no end time. */
    awayUntilText(): string | undefined {
        if (!awayOn(readDayType(this.homey.settings.get(DAY_TYPE_SETTING)))) return undefined;
        const until = readAwayUntil(this.homey.settings.get(AWAY_UNTIL_SETTING));
        return until === undefined ? undefined
            : awayUntilLabel(until, Date.now(), this.homey.clock.getTimezone(), this.homey.i18n?.getLanguage?.() ?? 'en');
    }

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
            house, (ms) => this.clockOn(ms));
        const set = async (name: string, value: any) => {
            if (this.hasCapability(name) && this.getCapabilityValue(name) !== value) await this.setCapabilityValue(name, value);
        };
        await set(AUTOPILOT_STATUS_CAPABILITY, status);
        // The one Autopilot tile: the status has no tile of its own, so a reason-less status (Off) shows its name.
        await set(AUTOPILOT_REASON_CAPABILITY, reason || this.homey.__(`autopilot.heating.status_name.${status}`));
        const feeding = !state.stopped && state.fed !== undefined;
        await set(AUTOPILOT_FED_CAPABILITY, feeding ? Math.round(state.fed! * 10) / 10 : null);
        // What BT1 is fed minus the real outdoor temperature: below 0, the pump sees it colder and heats more.
        await set(AUTOPILOT_SHIFT_CAPABILITY, feeding ? Math.round(-state.bias * 10) / 10 + 0 : 0);
        // The real outdoor temperature; the last one stays while there is none (a restart, a pause).
        if (state.real !== undefined && Number.isFinite(state.real)) await set(AUTOPILOT_OUTDOOR_CAPABILITY, Math.round(state.real * 10) / 10);
        this.trackHeating(status, state.stopped);
        const predicted = state.indoor?.[FORECAST_SLOTS - 1];
        if (state.slot !== undefined && predicted !== undefined) this.heatingDay.predict(state.slot, predicted);
        const before = this.heatingStatusShown;
        this.heatingStatusShown = status;
        if (before === undefined || before === status) return;
        this.homey.flow.getDeviceTriggerCard((this.profile.flowPrefix ?? '') + 'autopilot_heating_status_changed')
            .trigger(this, {status: this.homey.__(`autopilot.heating.status_name.${status}`), reason}).catch(this.error);
        const started = startedTrigger(before, status);
        if (started) this.homey.flow.getDeviceTriggerCard((this.profile.flowPrefix ?? '') + `autopilot_heating_${started}_started`)
            .trigger(this, {reason}).catch(this.error);
        const line = status === 'paused' ? 'timeline.paused'
            : before === 'paused' && status !== 'off' ? (this.pauseAnnounced ? 'timeline.resumed' : undefined)
                : before === 'learning' && status !== 'off' ? 'timeline.learned' : undefined;
        if (status === 'paused') this.pauseAnnounced = true;
        else if (before === 'paused') this.pauseAnnounced = false;
        if (line) this.homey.notifications.createNotification({excerpt: this.homey.__(`autopilot.heating.${line}`, {reason})})
            .catch(this.error);
    }

    /** Analytics: heating's status and what blocks it, each once per change. */
    private trackHeating(status: HeatingStatus, stopped: StopReason | undefined) {
        const simulation = this.heatingMode === 'test';
        if (this.heatingStateTold.changed(status)) track('Changed Autopilot State', {role: 'heating', state: status, simulation});
        const block = heatingBlock(stopped);
        if (this.heatingBlockTold.changed(block) && block) track('Blocked Autopilot', {role: 'heating', blocked_by: block, simulation});
    }

    /** Analytics: one slot of heating's day against comfort; the day before is sent when a new
     *  one starts. The range is the one the plan works inside. */
    private scoreHeatingSlot(slot: number, ti: number, te?: number, sun?: number) {
        const limits = this.heatingLimits();
        const date = localClock(this.homey.clock.getTimezone())(slot * SLOT_MS).date;
        const comfort = Number(this.getCapabilityValue('target_temperature'));
        const score = this.heatingDay.observe({slot, date, ti, comfort, lower: limits.lower, upper: limits.upper,
            simulation: this.heatingMode === 'test'});
        if (score) track('Scored Autopilot Day', score);
        this.recordComfortSlot(slot, {date, ti, comfort, lower: limits.lower, upper: limits.upper, te, sun});
    }

    // ---- Heating's comfort promise, day by day (comfort-days.ts) ----
    private comfortDays?: ComfortDay[];
    private comfortSlot?: number;
    /** The last 14 days of time in range, loaded from the store on first use. */
    comfortLog(): ComfortDay[] {
        return this.comfortDays ??= readComfortDays(this.getStoreValue(COMFORT_DAYS_STORE));
    }
    /** One plan step's indoor against the range; saved hourly and when the day turns. Not while
     *  the range is Off: there is no promise to keep then. */
    private recordComfortSlot(slot: number, s: ComfortSlot) {
        if (this.comfortSlot === slot || this.heatingRange() === 'off') return;
        this.comfortSlot = slot;
        const before = this.comfortLog();
        const after = addComfortSlot(before, s);
        this.comfortDays = after;
        const newDay = after[after.length - 1]?.date !== before[before.length - 1]?.date;
        if (newDay || slot % 4 === 0) this.setStoreValue(COMFORT_DAYS_STORE, after).catch(this.error);
    }

    /** Analytics: an Autopilot setting changed, with a bounded value (never a reading or a setpoint).
     *  With `from`, nothing is told when the value did not change. */
    trackSetting(setting: string, value?: string, from?: unknown) {
        if (value !== undefined && from !== undefined && String(from) === value) return;
        track('Changed Autopilot Setting', {role: this.role, setting, ...value === undefined ? {} : {setting_value: value}});
    }

    private surplusService?: SolarSurplus;
    /** The home's solar surplus (solar-surplus.ts), shared by every function's Autopilot. */
    private solarSurplus(): SolarSurplus {
        return this.surplusService ??= SolarSurplus.acquire(this.homey, (...args: any[]) => this.log(...args), this);
    }

    /** Whether Autopilot may use solar surplus: the owner's answer in setup, home-wide. Before
     *  they answered, the old per-pump setting (on unless turned off), which the first
     *  start after the update carries into the answer when it was off. */
    private solarAllowed(): boolean {
        const answer = readSolarAnswer(this.homey.settings.get(SOLAR_SETTING));
        return answer ? solarOn(answer) : this.getSettings().autopilotSolar !== false;
    }

    /** One-off: an owner who had turned the old "Use solar surplus" setting off has answered no. */
    private migrateSolarSetting() {
        if (this.getSettings().autopilotSolar === false && !readSolarAnswer(this.homey.settings.get(SOLAR_SETTING)))
            this.homey.settings.set(SOLAR_SETTING, {live: false, forecast: false});
    }

    /** This device and its siblings: every device of the pump. */
    private pumpDevices(): NibePumpDevice[] {
        const host = this.host();
        return (this.driver.getDevices() as NibePumpDevice[]).filter((d) => d === this || d.getSettings?.().address === host);
    }

    /** Store this function's Smart mode and apply it on every device of the pump: Main's day type
     *  follows hot water's. */
    private async storeSmartMode(mode: SmartMode) {
        const from = this.smartMode();
        if (from !== mode) {
            await this.setStoreValue(SMART_MODE_STORE, mode);
            this.log(`Smart mode: ${this.role} = ${mode}`);
            await this.markMode(mode);
            track('Changed Smart Mode', {role: this.role, smart_mode: analyticsSmartMode(mode), from_smart_mode: analyticsSmartMode(from)});
            (this.driver as any).syncInstallProfile?.();
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
        if (!this.connection) throw new Error('Not connected to your heat pump');
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
                starterDays: STARTER_DAYS, household: readHousehold(this.getStoreValue(HOUSEHOLD_STORE)) ?? null,
                dayType: this.dayTypeToday(),
                reserve: this.reserveLitres(), ...await this.legionellaStatus()};
        }
        if (this.role !== 'heating') return {...base, tank: undefined};
        const indoor = Number(this.getCapabilityValue('measure_temperature'));
        return {
            ...base,
            verified: this.getStoreValue('autopilotHeatingVerified') === true,
            roomControl: await this.readRoomControl() ?? null,
            indoor: Number.isFinite(indoor) ? indoor : null,
            target: Number.isFinite(Number(this.getCapabilityValue('target_temperature'))) ? Number(this.getCapabilityValue('target_temperature')) : null,
            outdoor: this.autopilot?.outdoorNow().sensor ?? null,
            prices: this.autopilot?.hasPrices() ?? false,
            status: this.hasCapability(AUTOPILOT_REASON_CAPABILITY) ? this.getCapabilityValue(AUTOPILOT_REASON_CAPABILITY) : null,
            range: this.heatingRange(),
            curve: this.heatCurveStatus(),
            ranges: rangeFacts(),
            custom: {spec: CUSTOM_SETTINGS, values: customValues(this.getStoreValue(CUSTOM_RANGE_STORE)), presets: customPresets()},
        };
    }

    // ---- Heat curve advice (autopilot/curve-advice.ts) ----

    private heatCurveStore(): CurveStore {
        return readCurveStore(this.getStoreValue(CURVE_STORE));
    }

    /** For Heating setup: the owner's choice, the change Autopilot made (for Undo), the advice now. */
    heatCurveStatus() {
        const store = this.heatCurveStore();
        return {choice: store.choice, offset: store.offset ?? null,
            adjusted: store.adjusted ? {from: store.adjusted.from, to: store.adjusted.to, at: store.adjusted.at} : null,
            advice: store.told && dayNumber(Date.now()) - store.told.day < REPEAT_DAYS ? store.told : null};
    }

    /** Setup's choice: Autopilot changes the offset, or tells the owner to. */
    async setCurveChoice(value: unknown) {
        if (value !== 'auto' && value !== 'self') throw new Error(`Unknown heat curve choice ${value}`);
        await this.setStoreValue(CURVE_STORE, {...this.heatCurveStore(), choice: value});
    }

    /** Hourly, after the house fit: today's sample of the trim, and the advice once it is steady.
     *  With the owner's "auto", the offset is written once (at most every 30 days); otherwise the
     *  advice goes to the timeline once and, with the setting on, to the device warning. */
    private async checkHeatCurve() {
        const name = this.profile.autopilotFeed?.curveOffset;
        const collector = this.autopilot;
        if (this.role !== 'heating' || !name || !collector || !this.heatingFeed || this.heatingMode !== 'live') return;
        // Read the pump first: the store is read after it, so an offset change a poll saved meanwhile
        // (curveOffsetRead) is not overwritten. Nibe's "not available" reads as null, not offset 0.
        const raw = await this.readNamed(name);
        const offset = raw === null || raw === undefined ? NaN : Number(raw);
        const store = this.heatCurveStore();
        const facts = collector.curveFacts();
        const today = dayNumber(Date.now());
        if (facts.te !== undefined) store.samples = addSample(store.samples, {day: today, integral: this.heatingFeed.learnedTrim, te: facts.te});
        const advice = curveAdvice({today, samples: store.samples, offset: Number.isFinite(offset) ? offset : undefined,
            readyDays: facts.readyAt === undefined ? undefined : (Date.now() - facts.readyAt) / 86_400_000,
            curveGain: facts.curveGain, stepK: facts.stepK, changed: store.changed, wrote: store.wrote});
        const fmt = (v: number) => (v > 0 ? `+${v}` : String(v));
        const say = (key: string, tokens?: Record<string, string>) =>
            this.homey.notifications.createNotification({excerpt: this.homey.__(`autopilot.heating.curve.${key}`, tokens)}).catch(this.error);
        let warning: string | undefined;
        if (advice && advice.to !== advice.from && store.choice === 'auto') {
            // The write reads itself back through setValue → curveOffsetRead, which moves the trim
            // once from the offset stored here. The change is dated before the write, so the 30-day
            // wait holds even if the read-back never comes (offset not polled, a failed confirm).
            await this.setStoreValue(CURVE_STORE, {...store, offset: advice.from, changed: today, wrote: today,
                adjusted: {day: today, at: Date.now(), from: advice.from, to: advice.to}});
            await this.writeRegister(this.profile.registerByName[name], advice.to);
            this.log(`Heat curve advice: offset ${advice.from} -> ${advice.to} (learned trim ${advice.integral.toFixed(2)} K, `
                + `${advice.supplyK.toFixed(1)} K of supply).`);
            await say('adjusted', {from: fmt(advice.from), to: fmt(advice.to)});
        } else if (advice && isNews(advice, store.told, today)) {
            if (advice.to !== advice.from) await say('advise', {from: fmt(advice.from), to: fmt(advice.to)});
            if (advice.slope) await say(`slope_${advice.slope}`);
            this.log(`Heat curve advice told: offset ${advice.from} -> ${advice.to}${advice.slope ? `, curve ${advice.slope}` : ''}.`);
        }
        let told = store.told;
        if (advice) {
            told = {day: told && !isNews(advice, told, today) ? told.day : today,
                ...advice.to !== advice.from && store.choice !== 'auto' ? {to: advice.to} : {}, ...advice.slope ? {slope: advice.slope} : {}};
            if (told.to !== undefined) warning = this.homey.__('autopilot.heating.curve.warning_offset', {from: fmt(advice.from), to: fmt(told.to)});
            else if (told.slope) warning = this.homey.__(`autopilot.heating.curve.warning_${told.slope}`);
        }
        // Fresh again after the awaits: only the samples and what was told are this job's to save.
        await this.setStoreValue(CURVE_STORE, {...this.heatCurveStore(), samples: store.samples, told});
        this.adviceWarning = warning;
        await this.showAdviceWarning();
    }

    /** The offset as polled: a change from the last one seen, by anyone (Autopilot, Undo, the
     *  owner on the pump or in myUplink), moves the trim, so curve and trim never give the same
     *  heat twice. Kept in the store, so a change while Homey was off counts too. */
    /** This device's Homey id, which Insights needs and the SDK does not give. The whole device
     *  list is fetched once for it, uncached (184 devices is about 1 MB, and a cached list is kept
     *  and updated for every change in the home); after that the stored id is used. */
    async homeyDeviceId(api: any): Promise<string | undefined> {
        const kept = this.getStoreValue(HOMEY_ID_STORE);
        if (typeof kept === 'string' && kept) return kept;
        const appId = this.homey.manifest?.id ?? 'com.nibe.local';
        const id = ownDeviceId(await api.devices.getDevices({$cache: false, $timeout: 10_000}), appId, String(this.getData().id));
        if (id) await this.setStoreValue(HOMEY_ID_STORE, id);
        return id;
    }

    private async curveOffsetRead(value: number) {
        if (!Number.isFinite(value)) return;
        const store = this.heatCurveStore();
        if (store.offset === value) return;
        if (store.offset !== undefined) {
            this.offsetMoved(store.offset, value, store, this.autopilot?.curveFacts() ?? {});
            this.log(`Heat curve offset ${store.offset} -> ${value}.`);
        }
        store.offset = value;
        await this.setStoreValue(CURVE_STORE, store);
    }

    /** One offset change, counted once: the trim moves, and advice waits for the new curve. */
    private offsetMoved(from: number, to: number, store: CurveStore, facts: {curveGain?: number; stepK?: number}) {
        if (from === to) return;
        const shift = trimShiftFor(to - from, facts.curveGain, facts.stepK);
        if (this.heatingFeed) this.heatingFeed.shiftTrim(shift);
        else if (shift) {
            const trim = readTrim(this.getStoreValue(TRIM_STORE));
            this.setStoreValue(TRIM_STORE, {integral: readTrim({integral: trim.integral + shift}).integral}).catch(this.error);
        }
        store.offset = to;
        store.changed = dayNumber(Date.now());
        store.told = undefined;
    }

    /** Heating setup's Undo: the offset back to what it was before Autopilot changed it, and
     *  from then on only told, never changed. */
    async undoCurveAdjust() {
        const name = this.profile.autopilotFeed?.curveOffset;
        const store = this.heatCurveStore();
        if (!name || !store.adjusted) throw new Error(this.homey.__('autopilot.heating.curve.nothing_to_undo'));
        // The trim moves back through setValue → curveOffsetRead, as for any change.
        await this.writeRegister(this.profile.registerByName[name], store.adjusted.from);
        await this.setStoreValue(CURVE_STORE, {...this.heatCurveStore(), choice: 'self', adjusted: undefined, wrote: dayNumber(Date.now())});
        this.adviceWarning = undefined;
        await this.showAdviceWarning();
    }

    /** The device warning when no problem holds it: the advice, if the owner wants advice there. */
    /** `clearing`: the feed's problem has ended, and its warning goes either way (as before). */
    private async showAdviceWarning(clearing = false) {
        if (this.problemWarning) return;
        const on = this.getSettings().adviceWarnings !== false;
        if (on && this.adviceWarning) {
            await this.setWarning(this.adviceWarning);
            this.adviceShown = true;
        } else if (this.adviceShown || clearing) {
            // Only what this device put there: another warning (an indoor alert, a failed pairing
            // step) is not advice's to clear.
            this.adviceShown = false;
            await this.unsetWarning();
        }
    }

    /** The Custom range from setup: its values kept on the device (clamped), then the range. */
    async setCustomRange(values: unknown) {
        const stored = customValues(values && typeof values === 'object' ? values as any : {});
        await this.setStoreValue(CUSTOM_RANGE_STORE, stored);
        this.log(`Custom range values set: ${JSON.stringify(stored)}`);
        await this.setAutopilotProfile('custom');
    }

    async setAutopilotProfile(profile: string) {
        if (this.role !== 'heating') throw new Error(this.homey.__('autopilot.heating.not_on'));
        const from = this.heatingRange();
        await this.setStoreValue(RANGE_STORE, profile);
        this.trackSetting('comfort_range', String(profile), from);
        this.log(`Comfort range set to ${profile}.`);
        this.heatingFeed?.replanSoon();
    }

    // ---- The Autopilot dashboard widget (widgets/autopilot) ----

    /** What the widget draws for this device: its Autopilot now, the next 24 h, and for heating
     *  the house in plain terms. Every string translated here. */
    autopilotWidget(): WidgetData {
        const t = (key: string, tokens?: Record<string, string | number>) => this.homey.__(`autopilot.widget.${key}`, tokens);
        const title = this.getName();
        const slot = slotOf(Date.now());
        const slotStart = (k: number) => k * 15 * 60_000;
        const local = localClock(this.homey.clock.getTimezone());
        const dayOf = (ms: number) => local(ms).date;
        const mode = this.role === 'heating' || this.role === 'hotwater' ? this.smartMode() : 'off';
        const base = {title, chips: [] as string[], slots: [], ticks: [], legend: {}};
        if (!autopilotRuns(mode)) return {...base, kind: 'none', empty: t(this.role === 'heating' || this.role === 'hotwater' ? 'off' : 'not_function')};
        const chips = [...(mode === 'test' ? [t('test')] : [])];
        // Both charts show today, 00:00 to 24:00, local.
        const day = todaySlots(slot, dayOf);
        const now = slot - day.from;
        if (this.role === 'hotwater') {
            const o = this.hotwaterAutopilot?.outlook(day.from, day.n);
            // Right after a start the plan is still being made: say so, and hold the chart's place.
            const starting = {...base, kind: 'hotwater' as const, chips, test: mode === 'test', loading: true,
                status: t('starting_title'), reason: t('starting_hotwater')};
            if (!o) return starting;
            const reason = o.next ? this.homey.__(`autopilot.hotwater_charge.reason.${o.next.reason}`) : undefined;
            const solar = o.slots.some((s) => s.surplus !== undefined);
            const share = o.next ? Math.round(o.next.solar * 100) : 0;
            const charges = o.slots.filter((s, k) => k >= now && s.charge !== undefined);
            const fromSolar = charges.length ? charges.reduce((a, s) => a + s.charge!, 0) / charges.length : 0;
            if (!this.solarAllowed()) chips.push(t('hotwater.solar_off'));
            else if (this.solarSurplus().forecastPaused) chips.push(t('hotwater.solar_paused'));
            // The tank now, as the figure beside the status (heating shows indoor there).
            const tankLitres = this.tankLitresNow(o.litres);
            const litres = tankLitres === undefined ? undefined : t('hotwater.litres', {l: Math.round(tankLitres)});
            const tank = tankLitres === undefined ? {} : {nowValue: `${Math.round(tankLitres)} L`, nowNote: t('hotwater.litres_note')};
            // No prices: while starting, the prices are on their way. Later they are missing: say where to look.
            if (!o.slots.some((s) => s.price !== undefined))
                return process.uptime() < STARTING_SECONDS ? {...starting, detail: litres}
                    : {...base, kind: 'hotwater', chips, test: mode === 'test', status: t('hotwater.no_prices'),
                        reason: t('hotwater.no_prices_hint'), detail: litres};
            const start = slotStart(day.from);
            // The heading keeps to the time; the day, when it is not today, leads the line under it.
            const later = !!o.next && dayOf(o.next.at) !== dayOf(Date.now());
            const duration = o.next ? formatDuration(o.next.minutes, (key, tokens) => this.homey.__(`autopilot.hotwater_charge.${key}`, tokens)) : '';
            const prices = o.slots.flatMap((s) => (s.price === undefined ? [] : [s.price]));
            const surplus = o.slots.flatMap((s) => (s.surplus === undefined ? [] : [s.surplus]));
            const bands = chargeBands(o.slots, start, this.clock, (from, to) => t('hotwater.band', {from, to}));
            return {...base, kind: 'hotwater', chips, test: mode === 'test', slots: o.slots, now, ...tank,
                ticks: ticks(start, day.n, this.clock),
                scale: {left: niceAxis(0, Math.max(0, ...prices), {steps: [0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100]}),
                    right: solar ? niceAxis(0, Math.max(1, ...surplus), {steps: [0.5, 1, 2, 5, 10]}) : undefined},
                bands,
                // A charge that has started is running (the outlook only keeps one that has while the
                // tank charges): say so and when it ends, not "next" with its start.
                status: !o.next ? t('hotwater.none') : o.next.running ? t('hotwater.charging_now')
                    : t('hotwater.next', {when: this.clock(o.next.at)}),
                reason: !o.next ? undefined : o.next.running
                    ? t('hotwater.until', {time: this.clock(o.next.at + o.next.minutes * 60_000)})
                    : [later ? t('hotwater.day_tomorrow') : undefined, later ? lowerFirst(t('hotwater.about', {duration})) : t('hotwater.about', {duration})]
                        .filter(Boolean).join(' · '),
                detail: o.next ? [reason, share > 0 ? t('hotwater.share', {share}) : undefined].filter(Boolean).join(' · ') || undefined : undefined,
                legend: {price: t('price'), surplus: solar ? t('surplus') : '', grid: t('charge_grid'), solar: solar ? t('charge_solar') : '',
                    done: bands.some((b) => b.doneTo !== undefined) ? t('charge_done') : ''},
                axes: {left: t('axis_price'), right: solar ? t('axis_surplus') : ''},
                // The plan counts the surplus it expects; a live surplus the forecast missed still starts or
                // tops up a charge (solar-surplus.ts: the live reading replaces the forecast for the next slots), so the owner is told it is not a cap.
                footnote: solar && this.solarAllowed() ? [bands.length > 1 ? Math.round(fromSolar * 100) > 0 ? t('hotwater.solar_total', {share: Math.round(fromSolar * 100)}) : t('hotwater.solar_none') : '',
                    t('hotwater.solar_live')].filter(Boolean).join(' ') : undefined};
        }
        const status = this.getCapabilityValue(AUTOPILOT_STATUS_CAPABILITY) as HeatingStatus | null;
        const range = this.heatingRange();
        chips.push(t(`range.${range}`));
        if (this.autopilotAway()) {
            const c = this.getCapabilityValue(AUTOPILOT_AWAY_TEMPERATURE_CAPABILITY) ?? AWAY_DEFAULT_C;
            const until = this.awayUntilText();
            chips.push(until ? t('away_until', {c, until}) : t('away', {c}));
        }
        const from = day.from;
        const past = this.autopilot?.recent(from, now) ?? [];
        const indoorNow = this.getCapabilityValue('measure_temperature') ?? NaN;
        const summary = this.autopilot?.houseSummary();
        const slots = heatingSlots(past, this.heatingFeed?.state, slot, day.n - now);
        const statusName = status ? this.homey.__(`autopilot.heating.status_name.${status}`) : undefined;
        const testLead = this.homey.__('autopilot.heating.status.test', {text: '§'}).split('§')[0].replace(/[\s.:·]+$/, '');
        const stopped = this.heatingFeed?.state?.stopped;
        // The reason, without the words the status or the Simulation chip already say. A pause says what to do.
        const stored = (this.getCapabilityValue(AUTOPILOT_REASON_CAPABILITY) as string | null) ?? undefined;
        const reason = status === 'learning' && summary && !summary.ready
            ? learningText(summary, t, 'learning')
            : status === 'paused' && stopped && WIDGET_PAUSES.includes(stopped) ? t(`paused.${stopped}`)
                : stored === undefined || stored === statusName ? undefined : stripLead(stored, [testLead, statusName ?? '']);
        const aim = aimingFor(slots, now, this.heatingFeed?.state?.setpoint);
        // Started, house learned, no plan yet: the forecast and prices are being read. Or the
        // first outdoor reading after a start is still on its way.
        const waiting = (stopped === 'no_model' && !!summary?.ready) || !!this.heatingFeed?.state?.startingUp;
        const indoors = [...slots.flatMap((s) => (s.indoor === undefined ? [] : [s.indoor]))];
        const shifts = slots.flatMap((s) => (s.offset === undefined ? [] : [s.offset]));
        return {
            ...base, kind: 'heating', chips, test: mode === 'test',
            slots, now,
            ticks: ticks(slotStart(from), day.n, this.clock),
            scale: {left: indoors.length ? niceAxis(Math.min(...indoors) - 0.3, Math.max(...indoors) + 0.3, {minSpan: 2, steps: [0.5, 1, 2, 5]})
                    : niceAxis(19, 23, {steps: [0.5, 1, 2]}),
                // The shift axis is symmetric, so 0 sits mid-height: bars read as above or below it.
                right: symmetricAxis(shifts)},
            status: waiting ? t('starting_title') : statusName,
            reason: waiting ? t('starting_heating') : reason,
            loading: waiting || undefined,
            bars: shiftBars(slots),
            legend: {indoor: t('indoor'), planned: t('expected'), offset: t('offset')},
            axes: {left: t('axis_indoor'), right: t('axis_offset')},
            indoorNow: Number.isFinite(indoorNow) ? Math.round(indoorNow * 10) / 10 : undefined,
            aim: aim === undefined ? undefined : t('aiming', {c: aim.toFixed(1)}),
            footnote: !summary || summary.ready ? undefined : t('learning'),
            // Not drawn: the log is for reviewing the comfort promise through the debug route.
            comfortDays: this.comfortLog(),
        };
    }

    // ---- The Energy today widget (widgets/energy) ----

    /** What the Energy today widget draws for this pump (picked by its Main device): the hourly
     *  use of its Heating and Hot water, and Main's idle use, against today's price. Every string translated here. */
    energyWidget(): EnergyWidgetData {
        const t = (key: string, tokens?: Record<string, string | number>) => this.homey.__(`autopilot.energy.${key}`, tokens);
        const title = this.getName();
        const host = String(this.getData().id).split('#')[0];
        const siblings = (this.driver.getDevices() as any[]).filter((d) => String(d.getData().id).split('#')[0] === host);
        // Main only where it carries an idle meter (a model with no power source has none).
        const byRole = new Map(siblings.filter((d) => d.role !== 'main' || d.hasCapability(METER_CAPABILITY)).map((d) => [d.role, d]));
        if (!byRole.has('heating') && !byRole.has('hotwater')) return {title, empty: t('no_functions')};
        const reads = ENERGY_ROLES.filter((role) => byRole.has(role)).map((role) => [role, byRole.get(role).energyToday?.()] as const);
        const known = reads.filter(([, r]) => r);
        // A function not read yet (they read minutes apart after a start) would look like one that
        // used nothing: wait for every function this pump has, for the start-up minutes at least.
        if (known.length < reads.length && process.uptime() < 15 * 60) return {title, loading: true};
        // The meters are read a few minutes after a start, then hourly. Past that, nothing read means
        // no dynamic prices in Homey Energy (the read stops there).
        // A new day not read yet (minutes after midnight) is loading, not missing prices: this
        // Homey had dynamic prices at the last read.
        const pending = process.uptime() < 15 * 60 || siblings.some((d) => d.hadDynamicPrices);
        if (!known.length) return pending ? {title, loading: true} : {title, empty: t('no_prices')};
        const prices = known.find(([, r]) => r!.prices)?.[1]!.prices;
        if (!prices) return pending ? {title, loading: true} : {title, empty: t('no_prices')};
        const timeZone = this.homey.clock.getTimezone();
        const hours = dayHours(localDate(Date.now(), timeZone), (ms) => localDate(ms, timeZone));
        const slotPrices = known.find(([, r]) => r!.slotPrices)?.[1]!.slotPrices;
        const chart = energyChart(hours, Object.fromEntries(known.map(([role, r]) => [role, r!.use])), prices,
            {slots: Object.fromEntries(known.map(([role, r]) => [role, r!.slots])), prices: slotPrices});
        const currency = known.find(([, r]) => r!.currency)?.[1]!.currency ?? '';
        const language = this.homey.i18n.getLanguage();
        const kwh = numberFormat(language, {maximumFractionDigits: 1}).format(chart.kwh);
        // Now in hours from midnight, at the start of its 15-minute slot, where the other day charts
        // draw it: the line falls inside the hour's bar, which holds the use so far.
        const hour = Math.max(0, hours.findIndex((at) => at > Date.now()) - 1);
        const now = hour + Math.floor((Date.now() - hours[hour]) / (15 * 60_000)) / 4;
        return {title, chart, now,
            numbers: [
                {value: `${kwh} kWh`, label: t('used')},
                // Two decimals, as Homey Energy shows the same cost.
                {value: moneyText(chart.cost, 2, language, currency), label: t('cost')},
                ...chart.cheapShare === undefined ? [] : [{value: `${Math.round(chart.cheapShare * 100)} %`, label: t('cheap'), good: true}],
            ],
            ticks: [0, 6, 12, 18].map((k) => ({at: k, label: this.clock(hours[0] + k * HOUR_MS)})),
            legend: {heating: t('heating'), hotwater: t('hotwater'), main: t('idle'), price: t('price')},
            axes: {kwh: 'kWh', price: t('price_axis')}};
    }

    // ---- The Overview widget (widgets/overview) ----

    /** One heat pump at a glance, from its Main device: today's use by price third, this month's
     *  savings, a row per function and what needs the owner. Each figure is the one another widget
     *  or tile shows, so they agree: the ring and cost from Energy today, the month from the two
     *  savings widgets, the rows from the devices' own capabilities. */
    // TEMP(mem)
    overviewWidget(): OverviewData {
        this.log(`TEMP(mem) start overview: ${memNow()}`);
        const out = this.overviewWidgetInner();
        this.log(`TEMP(mem) end overview: ${memNow()}`);
        return out;
    }
    private overviewWidgetInner(): OverviewData {
        const t = (key: string, tokens?: Record<string, string | number>) => this.homey.__(`autopilot.overview.${key}`, tokens);
        const title = this.getName();
        const host = String(this.getData().id).split('#')[0];
        const siblings = (this.driver.getDevices() as any[]).filter((d) => String(d.getData().id).split('#')[0] === host);
        const byRole = new Map<string, any>(siblings.map((d) => [d.role, d]));
        const offline = this.getAvailable() ? undefined : this.unavailableText ?? t('offline');
        const local = localClock(this.homey.clock.getTimezone());
        const rows: OverviewRow[] = OVERVIEW_KINDS.filter((k) => byRole.has(k)).map((kind) => {
            const d = byRole.get(kind);
            const row: OverviewRow = {kind, name: this.homey.__(`groups.${kind}`)};
            if (offline) return {...row, muted: true};
            const mode = d.smartMode() as SmartMode;
            // Only what is known: Off in the app may still be SPA on the pump itself (Repair reads that).
            const modeName = mode === 'spa' ? t('mode_spa') : undefined;
            if (kind === 'heating') {
                const indoor = Number(d.getCapabilityValue('measure_temperature'));
                const set = Number(d.getCapabilityValue('target_temperature'));
                const runs = autopilotRuns(mode);
                const limits = runs ? d.heatingLimits() : undefined;
                row.state = runs ? d.autopilotWidget().status : modeName;
                if (Number.isFinite(indoor)) {
                    row.value = `${indoor.toFixed(1)} °C`;
                    const mid = Number.isFinite(set) ? set : indoor;
                    row.bar = {type: 'range', min: mid - 3, max: mid + 3, value: indoor,
                        ...Number.isFinite(set) ? {set} : {},
                        ...limits && Number.isFinite(set) && limits.lower + limits.upper > 0 ? {lo: set - limits.lower, hi: set + limits.upper} : {}};
                }
            } else if (kind === 'hotwater') {
                const litres = d.tankLitresNow();
                const size = d.tankConfig().litres;
                const runs = autopilotRuns(mode);
                const day = todaySlots(slotOf(Date.now()), (ms) => local(ms).date);
                const view = runs ? d.hotwaterAutopilot?.tank(day.from, day.n) : undefined;
                const next: string | undefined = runs ? d.nextChargeText(view?.next, local) : undefined;
                row.state = runs ? next && next.charAt(0).toLocaleUpperCase() + next.slice(1) : modeName;
                if (typeof litres === 'number') {
                    row.value = `${Math.round(litres)} L`;
                    if (size) row.bar = {type: 'fill', value: litres, max: size};
                }
            } else {
                row.state = modeName;
                const cap = (d.getCapabilities() as string[]).find((c) => c.startsWith('measure_temperature'));
                const v = cap ? Number(d.getCapabilityValue(cap)) : NaN;
                if (Number.isFinite(v)) row.value = `${v.toFixed(1)} °C`;
            }
            if (!row.value) row.muted = true;
            return row;
        });
        // The ring and today's cost, as Energy today has them.
        const energy = this.energyWidget();
        let tiers: [number, number, number] | undefined;
        if (energy.chart) {
            const timeZone = this.homey.clock.getTimezone();
            const hours = dayHours(localDate(Date.now(), timeZone), (ms) => localDate(ms, timeZone));
            const prices = new Map<number, number>();
            hours.forEach((at, k) => { const p = energy.chart!.hours[k]?.price; if (p !== undefined) prices.set(at, p); });
            // Heating's own use when there is a Heating device: its share of cheap hours is what Autopilot
            // moves; hot water's is not a saving (savings.ts). Without one, the whole use, as before.
            const heatingOnly = byRole.has('heating');
            tiers = priceThirds(hours, (at) => {
                const h = energy.chart!.hours[hours.indexOf(at)];
                if (!h) return 0;
                return heatingOnly ? Number((h.use as Record<string, number | undefined>).heating ?? 0)
                    : Object.values(h.use).reduce((a: number, b) => a + (b ?? 0), 0);
            }, prices);
        }
        // The savings widgets' own figures, each worked out once: the year's estimates when every
        // function with a figure has one, else this month's, as before.
        const figures = (['heating', 'hotwater'] as const).flatMap((role) => {
            const d = byRole.get(role);
            // As the savings widget shows it: a month with counted days stays, whatever the mode now.
            if (!d) return [];
            const data = d.savingsWidget() as SavingsData;
            const currency = String(d.getStoreValue(SAVINGS_CURRENCY_STORE) ?? '');
            return data.yearValue === undefined && data.monthValue === undefined ? [] : [{data, currency}];
        });
        const language = this.homey.i18n.getLanguage();
        const allYears = figures.length > 0 && figures.every((f) => f.data.yearValue !== undefined);
        const months = allYears ? [] : figures.filter((f) => f.data.monthValue !== undefined)
            .map((f) => ({value: f.data.monthValue!, month: f.data.valueNote ?? '', currency: f.currency}));
        // Each part as its widget shows it (one decimal under 10, whole above), so 11 + 2.4 reads 13, not 14.
        const shown = (v: number) => (Math.abs(v) < 10 ? Math.round(v * 10) / 10 : Math.round(v));
        const sum = months.reduce((a, m) => a + shown(m.value), 0);
        const saved = months.length ? {value: moneyText(sum, Math.abs(sum) < 10 ? 1 : 0, language, months[0].currency),
            month: months[0].month, good: sum >= 0} : undefined;
        const yearMoney = (v: number) => moneyText(v, Math.abs(v) < 10 ? 1 : 0, language, figures[0]?.currency ?? '');
        const yearTotal = figures.reduce((a, f) => a + (f.data.yearValue ?? 0), 0);
        const yearSaved = figures.reduce((a, f) => a + (f.data.yearSaved ?? 0), 0);
        const year = allYears ? {value: `~${yearMoney(yearTotal)}`, saved: yearMoney(yearSaved),
            year: localDate(Date.now(), this.homey.clock.getTimezone()).slice(0, 4), good: yearTotal >= 0} : undefined;
        const alarm = this.hasCapability(ALARM_ACTIVE_CAPABILITY) && this.getCapabilityValue(ALARM_ACTIVE_CAPABILITY) === true
            ? String(this.getCapabilityValue(ALARM_TEXT_CAPABILITY) ?? '') || undefined : undefined;
        const warnings = OVERVIEW_KINDS.flatMap((k) => {
            const d = byRole.get(k);
            return d?.warningText ? [{text: d.warningText as string, advice: !!d.adviceShown}] : [];
        });
        if (this.warningText) warnings.unshift({text: this.warningText, advice: false});
        if (!rows.length) return {title, empty: this.homey.__('autopilot.energy.no_functions'), rows: [], attention: []};
        if (energy.loading && !offline) return {title, loading: true, rows, attention: []};
        return overviewData({title, autopilot: siblings.some((d) => autopilotRuns(d.smartMode?.())), offline, alarm, warnings,
            tiers, cheapShare: byRole.has('heating') ? undefined : energy.chart?.cheapShare, spent: energy.numbers?.[1]?.value, saved, year,
            heatingOnly: byRole.has('heating'), rows}, t);
    }

    /** The tank now, as its tile shows it (read every poll). The planner's own figure is from the
     *  start of its 15-minute slot, up to 100 L or more behind during a shower: only a fallback. */
    private tankLitresNow(planned?: number): number | undefined {
        const read = this.hasCapability(HOTWATER_VOLUME_CAPABILITY) ? this.getCapabilityValue(HOTWATER_VOLUME_CAPABILITY) : null;
        return typeof read === 'number' && Number.isFinite(read) ? read : planned;
    }

    /** The tank's next charge, worded: "next charge 04:15", tomorrow's, or "charging now". */
    private nextChargeText(next: {at: number; running?: boolean} | undefined, local: ReturnType<typeof localClock>): string | undefined {
        const t = (key: string, tokens?: Record<string, string | number>) => this.homey.__(`autopilot.tank.${key}`, tokens);
        if (next?.running) return t('charging');
        if (!next) return undefined;
        return t(local(next.at).date === local(Date.now()).date ? 'next' : 'next_tomorrow', {time: this.clock(next.at)});
    }

    // ---- The Hot water tank widget (widgets/hotwater_tank) ----

    /** What the Hot water tank widget draws, today from local midnight to midnight like the other
     *  day charts: the tank, the use against a usual day, and the charges. Every string translated here. */
    hotwaterTankWidget(): TankWidgetData {
        const t = (key: string, tokens?: Record<string, string | number>) => this.homey.__(`autopilot.tank.${key}`, tokens);
        const title = this.getName();
        if (this.role !== 'hotwater') return {title, empty: t('pick')};
        if (!autopilotRuns(this.smartMode())) return {title, empty: this.homey.__('autopilot.hotwater_use.off')};
        const local = localClock(this.homey.clock.getTimezone());
        const slot = slotOf(Date.now());
        const day = todaySlots(slot, (ms) => local(ms).date);
        const SLOT = 15 * 60_000, start = day.from * SLOT, n = day.n;
        const view = this.hotwaterAutopilot?.tank(day.from, n);
        if (!view) return {title, loading: true, status: this.homey.__('autopilot.hotwater_use.loading')};
        const now = slot - day.from;
        const chart = tankChart(view, now, day.n);
        const bands = chargeBands(view.slots, start, this.clock, (from, to) => this.homey.__('autopilot.widget.hotwater.band', {from, to}));
        const reserve = this.reserveLitres();
        const tankNow = this.tankLitresNow(view.litres);
        const litres = tankNow === undefined ? undefined : Math.round(tankNow);
        const next = this.nextChargeText(view.next, local);
        return {title, chart, slots: n, now, bands, reserve: reserve > 0 ? reserve : undefined,
            ticks: ticks(start, n, this.clock),
            status: litres === undefined ? undefined : t('now', {l: litres}),
            reason: [t('used', {used: chart.usedTotal, expected: chart.expectedTotal}), next].filter(Boolean).join(' · '),
            labels: {tank: t('panel_tank'), used: t('panel_used'), usual: t('usual', {l: chart.expectedTotal}), reserve: t('reserve')},
            legend: {done: t('done'), planned: t('planned')}};
    }

    // ---- The Hot water use widget (widgets/hotwater_use) ----

    /** What the Hot water use widget draws: the use Autopilot expects today, against the last six
     *  days and a typical day of each type. Every string translated here. */
    hotwaterUseWidget(): HotwaterUseData {
        const t = (key: string, tokens?: Record<string, string | number>) => this.homey.__(`autopilot.hotwater_use.${key}`, tokens);
        const title = this.getName();
        if (this.role !== 'hotwater') return {title, empty: t('pick')};
        if (!autopilotRuns(this.smartMode())) return {title, empty: t('off')};
        const usage = this.hotwaterAutopilot?.usage();
        // Right after a start the model and the day's readings are still being read: say so,
        // rather than "Learning", which means too little history.
        const reading = !this.hotwaterAutopilot?.historyReady() && process.uptime() < 15 * 60;
        if (reading) return {title, loading: true, status: t('loading')};
        if (!usage) return {title, empty: t('learning')};
        const format = dateFormat(this.homey.i18n.getLanguage(), {weekday: 'short', timeZone: 'UTC'});
        const week = hotwaterWeek(usage, (date) => format.format(new Date(`${date}T12:00:00Z`)));
        // No full day yet: one line, not a week of dashes.
        if (!week.bars.some((bar) => !bar.today && bar.litres !== undefined)) return {title, empty: t('learning')};
        const has = (kind: string) => week.bars.some((bar) => bar.kind === kind);
        const today = week.bars[week.bars.length - 1];
        const local = localClock(this.homey.clock.getTimezone());
        const day = todaySlots(slotOf(Date.now()), (ms) => local(ms).date);
        const view = this.hotwaterAutopilot?.tank(day.from, day.n);
        // Today's bar fills up to what has been used so far.
        if (view) today.used = Math.round(view.drawn.reduce<number>((sum, v) => sum + (v ?? 0), 0) / 5) * 5;
        const typical = today.kind === 'away' ? undefined : week.typical[today.kind];
        return {title, ...week,
            status: today.litres === undefined ? undefined : t(today.kind === 'away' ? 'expected_away' : 'expected', {l: today.litres}),
            reason: today.kind === 'away' ? [this.awayUntilText() ? t('away_until', {until: this.awayUntilText()!}) : undefined, t('away_keeps')]
                .filter(Boolean).join(' · ')
                : [t(today.kind), typical === undefined ? undefined : t('typical_of', {l: typical})].filter(Boolean).join(' · '),
            legend: {title: t('title'), working: has('working') ? t('working') : '', free: has('free') ? t('free') : '',
                away: has('away') ? t('away') : '', typical: t('typical')},
            today: view && this.hotwaterToday(t, view, day)};
    }

    /** Today's lines for the Hot water use widget: the use in runs of hours, the charges done or
     *  running, the tank now and the next charge. Undefined when there is nothing to tell. */
    private hotwaterToday(t: (key: string, tokens?: Record<string, string | number>) => string, view: TankView,
        day: {from: number; n: number}): HotwaterUseData['today'] {
        const local = localClock(this.homey.clock.getTimezone());
        const slot = slotOf(Date.now());
        const SLOT = 15 * 60_000, start = day.from * SLOT, now = slot - day.from;
        const at = (k: number) => this.clock(start + k * SLOT);
        const duration = (slots: number) => formatDuration(slots * 15, (key, tokens) => this.homey.__(`autopilot.hotwater_charge.${key}`, tokens));
        const rows: {order: number; row: TodayRow}[] = [];
        for (const r of useRuns(view.drawn))
            rows.push({order: r.hour * 4, row: {time: at(r.hour * 4), kind: 'use', text: t('row_used'), value: `${r.litres} L`}});
        for (const b of chargeBands(view.slots, start, this.clock, () => '')) {
            if (b.doneTo === undefined) continue;
            const running = b.doneTo < b.to || b.to > now;
            rows.push({order: b.from, row: {time: at(b.from), kind: 'charge',
                text: running ? t('row_charging', {end: at(b.to)}) : t('row_charged', {end: at(b.doneTo)}),
                value: duration((running ? b.to : b.doneTo) - b.from)}});
        }
        rows.sort((x, y) => x.order - y.order);
        const out = rows.map((r) => r.row);
        const tankNow = this.tankLitresNow(view.litres);
        if (tankNow !== undefined) out.push({time: at(now), kind: 'now', text: t('row_tank'), value: `${Math.round(tankNow)} L`});
        if (view.next && !view.next.running) {
            const tomorrow = local(view.next.at).date !== local(Date.now()).date;
            out.push({time: this.clock(view.next.at), kind: 'next', text: t(tomorrow ? 'row_next_tomorrow' : 'row_next'),
                value: this.homey.__(`autopilot.hotwater_charge.reason.${view.next.reason}`)});
        }
        return out.length ? {title: t('today_title'), rows: out} : undefined;
    }

    // ---- The Autopilot savings widget (widgets/savings) ----

    private savingsTimer?: NodeJS.Timeout;
    private savingsStopped = false;
    /** A refresh has finished since the app started, whether or not it found days. */
    private savingsReadOnce = false;
    /** Quick retries left of a failed meter read (scheduleSavings). */
    private savingsRetries = 0;
    /** Today's prices, fetched once a day: per hour (the mean of its quarters) and per 15-minute
     *  slot (slot start, ms). */
    private savingsTodayPrices?: {date: string; prices: Map<number, number>; slots: Map<number, number>};
    /** Insights' hourly points of the meter, the last two days, as of the last savings refresh. */
    private meterPoints: {at: number; v: number}[] = [];
    /** What the meter added in each 15-minute slot since the app started (slot start, ms), the
     *  last two days; the slot the app started in, and the meter at the first whole slot after it. */
    private liveSlots = new Map<number, number>();
    private liveStartSlot?: number;
    private liveFrom?: {at: number; v: number};
    /** Homey Energy had dynamic prices at the last savings refresh. */
    hadDynamicPrices = false;

    /** Called on every allocation, after `cumulativeEnergy` took `kwh`. */
    private noteLiveSlot(kwh: number) {
        const at = Math.floor(Date.now() / SLOT_MS) * SLOT_MS;
        this.liveStartSlot ??= at;
        if (!this.liveFrom && at > this.liveStartSlot) this.liveFrom = {at, v: this.cumulativeEnergy - kwh};
        if (!kwh) return;
        this.liveSlots.set(at, (this.liveSlots.get(at) ?? 0) + kwh);
        for (const k of this.liveSlots.keys()) if (k < at - 48 * HOUR_MS) this.liveSlots.delete(k);
    }

    /** Today's use up to now (per hour, and per slot where the meter counted it) and today's
     *  prices, for the Energy today and savings widgets; undefined while nothing is known. */
    energyToday(): {use: Map<number, number>; slots: Map<number, number>; prices?: Map<number, number>;
        slotPrices?: Map<number, number>; currency?: string} | undefined {
        if (!this.meterPoints.length && !this.liveFrom) return undefined;
        const timeZone = this.homey.clock.getTimezone();
        const today = localDate(Date.now(), timeZone);
        const p = this.savingsTodayPrices?.date === today ? this.savingsTodayPrices : undefined;
        const currency = this.getStoreValue(SAVINGS_CURRENCY_STORE);
        const {use, slots} = useToday({points: this.meterPoints, liveFrom: this.liveFrom, slots: this.liveSlots, meterNow: this.cumulativeEnergy},
            dayHours(today, (ms) => localDate(ms, timeZone)));
        return {use, slots, prices: p?.prices, slotPrices: p?.slots, currency: typeof currency === 'string' ? currency : undefined};
    }
    /** Dates a refresh could not complete (a gap in the meter, no prices), and when. They are tried
     *  again once a day, so a day that never completes costs no hourly Homey API calls. */
    private savingsTried = new Map<string, number>();

    /** Keep the Smart mode changes the savings widget sorts days by: Autopilot live or not. */
    private async markMode(mode: SmartMode) {
        const stored = this.getStoreValue(MODE_MARKS_STORE);
        const marks: ModeMark[] = Array.isArray(stored) ? stored : [];
        const live = mode === 'autopilot';
        if (marks.length && marks[marks.length - 1].live === live) return;
        // A real switch to Live is the moment the savings count from. The first mark on a device
        // that already ran Autopilot is not: refreshSavings() dates that from the hours before it.
        // Heating's starts when the house model is ready, not at the switch: refreshSavings() dates
        // it, so its learning days are the starting point.
        if (live && this.role !== 'heating' && Array.isArray(stored) && typeof this.getStoreValue(FIRST_LIVE_STORE) !== 'number')
            await this.setStoreValue(FIRST_LIVE_STORE, Date.now());
        const keepFrom = Date.now() - (LEDGER_DAYS + 2) * 86_400_000;
        // The last mark before the kept window still says what the window's first hours were.
        const older = marks.filter((m) => m.at < keepFrom).slice(-1);
        await this.setStoreValue(MODE_MARKS_STORE, [...older, ...marks.filter((m) => m.at >= keepFrom), {at: Date.now(), live}]);
    }

    private scheduleSavings(ms: number) {
        if (this.savingsTimer) this.homey.clearTimeout(this.savingsTimer);
        if (this.savingsStopped) return;
        // A new day reads its prices and meter minutes after midnight, not up to an hour later: until
        // then the Energy today widget has nothing for the day while Homey Energy already does.
        // Heating first, the others later, as at a start: Homey refuses back-to-back Insights reads.
        const timeZone = this.homey.clock.getTimezone();
        const midnight = dayHours(localDate(Date.now(), timeZone, 1), (at) => localDate(at, timeZone))[0];
        const after = midnight + ({heating: 2, hotwater: 7, main: 12}[this.role as string] ?? 7) * 60_000 - Date.now();
        if (after > 0) ms = Math.min(ms, after);
        this.savingsTimer = this.homey.setTimeout(() => {
            let failed = false;
            this.refreshSavings()
                .catch((error) => { failed = true; this.log('Savings widget: refresh failed:', error?.message ?? error); return HOUR_MS; })
                .then((next) => {
                    this.savingsReadOnce = true;
                    // A read that failed or brought no meter (Homey busy after a start or an update)
                    // is tried again in a few minutes, a few times: Energy today and the overview wait
                    // for it, and an hour of "Loading" reads as broken.
                    const retry = (failed || (next === HOUR_MS && !this.meterPoints.length)) && this.savingsRetries < SAVINGS_RETRIES;
                    this.savingsRetries = retry ? this.savingsRetries + 1 : 0;
                    this.scheduleSavings(retry ? SAVINGS_RETRY_MS : next);
                });
        }, ms);
    }

    /** Add the complete days the ledger lacks, from Insights' hourly meter (14 days back) and the
     *  day's prices. A day once written is final, so a refresh only reads what is new. Returns when
     *  to look again: an hour, or six when this Homey has no dynamic prices or the device is not found. */
    // TEMP(mem)
    private refreshSavings(): Promise<number> { return memMark(`savings ${this.role}`, () => this.refreshSavingsInner()); }
    private async refreshSavingsInner(): Promise<number> {
        const timeZone = this.homey.clock.getTimezone();
        const now = Date.now();
        const today = localDate(now, timeZone);
        for (const [date, at] of this.savingsTried) if (now - at > SAVINGS_BACK_DAYS * 86_400_000) this.savingsTried.delete(date);
        const stored: SavingsDay[] = Array.isArray(this.getStoreValue(SAVINGS_STORE)) ? this.getStoreValue(SAVINGS_STORE) : [];
        const have = new Set(stored.map((d) => d.date));
        const wanted = Array.from({length: SAVINGS_BACK_DAYS}, (_, k) => localDate(now, timeZone, -(k + 1)))
            .filter((date) => !have.has(date) && date < today && now - (this.savingsTried.get(date) ?? 0) > 86_400_000);
        // Every refresh reads the meter, even with no past day missing: today so far is counted
        // hourly, and a device that ran Autopilot before this was recorded dates its first live hour.
        const appId = this.homey.manifest?.id ?? 'com.nibe.local';
        const marks: ModeMark[] = Array.isArray(this.getStoreValue(MODE_MARKS_STORE)) ? this.getStoreValue(MODE_MARKS_STORE) : [];
        const result = await withApi(this.homey, async (api) => {
            // Prices come from the Gateway's price book, shared with heating and hot water.
            const book = pricesFor(this.homey);
            const info = await book.info();
            this.hadDynamicPrices = info.dynamic;
            if (!this.hadDynamicPrices) return undefined;
            const id = await this.homeyDeviceId(api);
            if (!id) return undefined;
            const uri = `homey:device:${id}`;
            /** A log's hourly points; undefined when it could not be read. Paced by the Gateway,
             *  and served from its store while Homey has no newer point. */
            const log = async (cap: string, resolution = 'last14Days') => {
                const entries = await api.insights.getLogEntries({uri, id: `${uri}:${cap}`, resolution, $timeout: 20_000})
                    .catch(() => undefined);
                return entries ? (entries.values ?? []) as {t: string; v: number | null}[] : undefined;
            };
            const meter = await log('meter_power.total');
            if (!meter) return [];
            // The meter's hourly points, for today up to now (energyToday).
            this.meterPoints = meter.flatMap((p) => typeof p.v === 'number' && Number.isFinite(p.v) && Number.isFinite(Date.parse(p.t))
                ? [{at: Date.parse(p.t), v: p.v}] : []).filter((p) => p.at > now - 48 * HOUR_MS);
            // Main has no savings: its idle meter is read for Energy today only.
            if (this.role === 'main') return [];
            const use = hourlyUse(meter);
            // Hot water: which days the immersion heater ran (a legionella boost), from its hours
            // counter; read only while a day in the ledger, or one about to be added, is not known.
            // Before Autopilot, any day the immersion heater ran is left out: the pump's own boosts
            // and tests. From Autopilot's first live day, only its own legionella runs are: any other
            // immersion use is a cost the comparison must see.
            if (this.role === 'hotwater' && this.hasCapability(IMMERSION_HOURS_CAPABILITY)
                && (wanted.length || stored.some((d) => d.boost === undefined))) {
                const older = await log(IMMERSION_HOURS_CAPABILITY, 'last3Months');
                const recent = await log(IMMERSION_HOURS_CAPABILITY);
                const firstLive = this.getStoreValue(FIRST_LIVE_STORE);
                const firstDate = typeof firstLive === 'number' ? localDate(firstLive, timeZone) : undefined;
                const runs = this.getStoreValue(LEGIONELLA_DATES_KEY);
                const legionella = new Set(Array.isArray(runs) ? runs : []);
                if (older || recent) this.boostByDate = new Map([...boostDays([...older ?? [], ...recent ?? []], (ms) => localDate(ms, timeZone))]
                    .map(([date, ran]) => [date, firstDate !== undefined && date >= firstDate ? legionella.has(date) : ran]));
            }
            // Heating: an hour ran live when the pump showed the BT1 Autopilot fed. That catches a
            // halt or pause the Smart mode alone does not, and dates the hours before the marks.
            // Either log unread: nothing is known from them.
            let fedLive: Map<number, boolean> | undefined;
            if (this.role === 'heating') {
                const fedLog = await log('measure_temperature.autopilot_fed');
                const shown = fedLog && await log('measure_temperature.i1_outside');
                if (fedLog && shown) {
                    const fed = new Map(fedLog.filter((p) => typeof p.v === 'number').map((p) => [Date.parse(p.t), p.v as number]));
                    fedLive = new Map(shown.filter((p) => typeof p.v === 'number').map((p) => {
                        const f = fed.get(Date.parse(p.t));
                        return [Date.parse(p.t), f !== undefined && Math.abs(f - (p.v as number)) <= 0.2];
                    }));
                }
            }
            // Heating saves from the hour it first shifts heat. While it learns, it feeds BT1 only to
            // hold the thermostat temperature and moves nothing to cheaper hours: those days are the
            // starting point the savings are counted against. Still learning: no hour counts yet.
            const shiftsFrom = this.role === 'heating' ? this.autopilot?.curveFacts().readyAt ?? Infinity : -Infinity;
            const fedShifting = (at: number) => (at < shiftsFrom ? false : fedLive?.get(at));
            const liveHour = (at: number) => savingsLive(at, shiftsFrom, liveAt(marks, at), fedLive?.get(at));
            const firstMark = marks.find((m) => m.live);
            if (firstMark && shiftsFrom !== Infinity && typeof this.getStoreValue(FIRST_LIVE_STORE) !== 'number')
                await this.setStoreValue(FIRST_LIVE_STORE, firstLiveFrom(Math.max(firstMark.at, shiftsFrom), fedShifting));
            if (!this.getStoreValue(SAVINGS_CURRENCY_STORE) && info.currency) await this.setStoreValue(SAVINGS_CURRENCY_STORE, info.currency);
            // Today so far: the hours that have a reading, ranked against today's whole price list.
            if (this.savingsTodayPrices?.date !== today) {
                const slots = (await book.day(today)).slots;
                if (slots?.length) this.savingsTodayPrices = {date: today, prices: hourlyPrices(slots, SLOT_MS),
                    slots: new Map(slots.map((x: {slot: number; price: number}) => [x.slot * SLOT_MS, x.price]))};
            }
            const todayPrices = this.savingsTodayPrices?.date === today ? this.savingsTodayPrices.prices : undefined;
            const todayHours = dayHours(today, (ms) => localDate(ms, timeZone));
            if (todayPrices?.size) {
                const hours = todayHours;
                const sofar = hours.filter((at) => use.has(at));
                const day = partialDay(today, hours, use, todayPrices, liveShare(sofar, liveHour), this.role === 'hotwater');
                if (!this.savingsStopped) await this.setStoreValue(SAVINGS_TODAY_STORE, day ?? null);
            }
            // Plan vs actual: the hours since the morning plans, at each hour's price.
            const ledger = this.costLedger();
            const open = [...new Set(ledger.filter((d) => !d.done).flatMap((d) => [d.date, localDate(d.until - 1, timeZone)]))];
            if (open.length) {
                const prices = new Map<number, number>(todayPrices ?? []);
                for (const date of open.filter((d) => d !== today || !todayPrices)) {
                    for (const [at, p] of hourlyPrices((await book.day(date)).slots, SLOT_MS)) prices.set(at, p);
                }
                const filled = fillActual(ledger, use, prices, now);
                if (filled !== ledger && !this.savingsStopped) await this.setStoreValue(COST_CHECK_STORE, filled);
            }
            const days: SavingsDay[] = [];
            for (const date of wanted) {
                const response = await book.day(date);
                const hours = dayHours(date, (ms) => localDate(ms, timeZone));
                const day = response.slots.length > 0 && savingsDay(date, hours, use, hourlyPrices(response.slots, SLOT_MS),
                    liveShare(hours, liveHour), this.role === 'hotwater');
                if (day) days.push(day);
                else this.savingsTried.set(date, now);
            }
            return days;
        });
        if (!result) return 6 * HOUR_MS;
        const merged = result.length ? mergeDays(stored, result) : stored;
        const ledger = this.withBoosts(this.withLitres(merged));
        if ((result.length || ledger !== merged) && !this.savingsStopped) await this.setStoreValue(SAVINGS_STORE, ledger);
        if (!this.savingsStopped) await this.freezeBaseline(ledger);
        return HOUR_MS;
    }

    /** Hot water: whether the immersion heater ran, on the days the counter's log knows and the
     *  ledger does not yet. The same array back when nothing was added. */
    private withBoosts(days: SavingsDay[]): SavingsDay[] {
        const known = this.boostByDate;
        if (!known?.size || !days.some((d) => d.boost === undefined && known.has(d.date))) return days;
        return days.map((d) => (d.boost === undefined && known.has(d.date) ? {...d, boost: known.get(d.date)} : d));
    }
    private boostByDate?: Map<string, boolean>;

    /** Hot water: the litres drawn each day, from the tank model, on the days that lack them. The
     *  same array back when nothing was added. */
    private withLitres(days: SavingsDay[]): SavingsDay[] {
        const drawn = new Map((this.hotwaterAutopilot?.usage()?.recent ?? []).filter((d) => !d.partial && !d.away && d.draw > 0)
            .map((d) => [d.date, Math.round(d.draw / KWH_PER_LITRE)]));
        if (!drawn.size || !days.some((d) => d.litres === undefined && drawn.has(d.date))) return days;
        return days.map((d) => (d.litres === undefined && drawn.has(d.date) ? {...d, litres: drawn.get(d.date)} : d));
    }

    /** Fix the baseline once Autopilot has run live and the days before it are in the ledger. With
     *  too few days before it, and none left to fetch, the day's average stands in (ratio 1). */
    private async freezeBaseline(ledger: SavingsDay[]) {
        const firstLive = this.getStoreValue(FIRST_LIVE_STORE);
        if (typeof firstLive !== 'number') return;
        const kept = this.getStoreValue(BASELINE_STORE) as Baseline | null;
        if (kept) {
            // A baseline frozen before kWh per litre was kept gets it once, from the same days
            // (2026-11-21); the rest of it stays as frozen.
            // ...and again without the immersion heater's boost days, once (2026-11-21).
            if (this.role === 'hotwater' && kept.days > 0 && (kept.kwhPerLitre === undefined || !kept.perLitreNoBoost)
                && ledger.some((d) => d.boost !== undefined)) {
                const firstDate = localDate(firstLive, this.homey.clock.getTimezone());
                const perLitre = kwhPerLitreOf(ledger.filter((d) => d.date < firstDate).slice(-BASELINE_DAYS));
                if (perLitre !== undefined) await this.setStoreValue(BASELINE_STORE, {...kept, kwhPerLitre: perLitre, perLitreNoBoost: true});
            }
            return;
        }
        const found = baselineOf(ledger, localDate(firstLive, this.homey.clock.getTimezone()));
        if (found) await this.setStoreValue(BASELINE_STORE, found);
        else if (Date.now() - firstLive > SAVINGS_BACK_DAYS * 86_400_000) await this.setStoreValue(BASELINE_STORE, {days: 0, ratio: 1});
    }

    /** Plan vs actual: hold the day to its first plan, from local midnight (the night's pre-heating
     *  and cheap charges count, and the day matches Energy today and Homey Energy) to the next. */
    private noteCostPlan(from: number, planned: PlannedCost[]) {
        const timeZone = this.homey.clock.getTimezone();
        const date = localDate(from, timeZone);
        const ledger = this.costLedger();
        if (ledger.some((d) => d.date === date)) return;
        const hours = dayHours(date, (ms) => localDate(ms, timeZone));
        const until = hours[hours.length - 1] + HOUR_MS;
        const day = costDay(date, from, until, planned);
        if (!day.expected.some((v) => v > 0)) return;
        this.log(`Plan vs actual: ${date} expected ${day.expected.reduce((a, b) => a + b, 0).toFixed(2)} from ${new Date(day.from).toISOString()}.`);
        this.setStoreValue(COST_CHECK_STORE, addDay(ledger, day)).catch(this.error);
    }

    /** What the Plan vs actual widget draws: this pump's Heating and Hot water, side by side. */
    costCheckWidget(): CostCheckData {
        const t = (key: string, tokens?: Record<string, string | number>) => this.homey.__(`autopilot.cost_check.${key}`, tokens);
        const address = this.getSettings().address;
        const pump = (this.driver.getDevices() as NibePumpDevice[]).filter((d) => d.getSettings().address === address);
        const of = (role: string) => pump.find((d) => d.role === role);
        const ledgers = (['heating', 'hotwater'] as const).flatMap((role) => {
            const d = of(role);
            return d ? [{label: t(role), days: d.costLedger()}] : [];
        });
        const timeZone = this.homey.clock.getTimezone();
        const language = this.homey.i18n.getLanguage();
        const currency = String(pump.map((d) => d.getStoreValue(SAVINGS_CURRENCY_STORE)).find(Boolean) ?? '');
        const dayLabel = dateFormat(language, {weekday: 'short', timeZone: 'UTC'});
        return costCheckData(t('title'), ledgers, localDate(Date.now(), timeZone), Date.now(), t,
            (v) => moneyText(v, Math.abs(v) < 100 ? 2 : 0, language, currency),
            (date) => dayLabel.format(new Date(`${date}T12:00:00Z`)));
    }

    costLedger(): CostDay[] {
        const v = this.getStoreValue(COST_CHECK_STORE);
        return Array.isArray(v) ? v : [];
    }

    /** Heating's season where the heat pump is, from the store; fetched again (in the background)
     *  when missing, a month old, or made with another base. The base is the heat pump's own
     *  "stop heating" temperature (184) when it reads, else DEFAULT_BASE_C. Undefined until the
     *  first fetch lands: the widget shows the month meanwhile, never a guessed season. */
    private heatingSeason(today: string): number[] | undefined {
        const stop = this.hasCapability('target_temperature.h184_auto_stop_heating')
            ? Number(this.getCapabilityValue('target_temperature.h184_auto_stop_heating')) : NaN;
        const base = Number.isFinite(stop) && stop > 0 && stop < 30 ? stop : DEFAULT_BASE_C;
        const kept = this.getStoreValue(SEASON_STORE) as {curve?: number[]; base?: number; at?: number} | null;
        const fresh = kept?.curve?.length === 12 && kept.base === base && Date.now() - (kept.at ?? 0) < SEASON_KEEP_MS;
        if (!fresh && !this.seasonAsking) {
            this.seasonAsking = true;
            weatherFor(this.homey, LOCATION_SETTING).seasonDays(today)
                .then(async (days) => {
                    const curve = days && seasonCurve(days, base);
                    if (curve) {
                        this.seasonTold = false;
                        await this.setStoreValue(SEASON_STORE, {curve, base, at: Date.now()});
                    } else if (!this.seasonTold) {
                        // Once, not at every widget refresh, until a season lands.
                        this.seasonTold = true;
                        this.log('Heating savings: no season for this location yet; the month is shown.');
                    }
                })
                .catch((error) => this.log('Heating savings: season not read:', error?.message ?? error))
                .finally(() => { this.seasonAsking = false; });
        }
        return kept?.curve?.length === 12 && kept.base === base ? kept.curve : undefined;
    }
    private seasonAsking = false;
    private seasonTold = false;

    /** What the Autopilot savings widget draws. Every string translated here. */
    // TEMP(mem)
    savingsWidget(): SavingsData {
        this.log(`TEMP(mem) start savings widget ${this.role}: ${memNow()}`);
        const out = this.savingsWidgetInner();
        this.log(`TEMP(mem) end savings widget ${this.role}: ${memNow()}`);
        return out;
    }
    private savingsWidgetInner(): SavingsData {
        const t = (key: string, tokens?: Record<string, string | number>) => this.homey.__(`autopilot.savings.${key}`, tokens);
        const title = this.getName();
        if (this.role !== 'heating' && this.role !== 'hotwater') return {title, empty: t('pick')};
        const days: SavingsDay[] = Array.isArray(this.getStoreValue(SAVINGS_STORE)) ? this.getStoreValue(SAVINGS_STORE) : [];
        // The first read of the last two weeks is still running: say so, and hold the chart's place.
        if (!days.length && !this.savingsReadOnce) return {title,
            status: this.homey.__('autopilot.widget.starting_title'), reason: t('loading'), loading: true};
        const timeZone = this.homey.clock.getTimezone();
        const language = this.homey.i18n.getLanguage();
        const currency = String(this.getStoreValue(SAVINGS_CURRENCY_STORE) ?? '');
        const amount = (v: number, digits: number) => moneyText(v, digits, language, currency);
        const firstLive = this.getStoreValue(FIRST_LIVE_STORE);
        const baseline = this.getStoreValue(BASELINE_STORE) as Baseline | null;
        const dayLabel = dateFormat(language, {weekday: 'short', timeZone: 'UTC'});
        const monthName = dateFormat(language, {month: 'long', timeZone: 'UTC'});
        const dayMonth = dateFormat(language, {day: 'numeric', month: 'short', timeZone: 'UTC'});
        const today = localDate(Date.now(), timeZone);
        const stored = this.getStoreValue(SAVINGS_TODAY_STORE) as SavingsDay | null;
        // Today so far, up to now as Energy today counts it; the stored one (as of the hourly
        // refresh) gives how much of the day ran live, and stands in when the meter is not read yet.
        const sofarUse = this.energyToday();
        const sofar = (sofarUse?.prices && partialDay(today, dayHours(today, (ms) => localDate(ms, timeZone)), sofarUse.use, sofarUse.prices,
            stored?.date === today ? stored.live : undefined, this.role === 'hotwater')) || (stored?.date === today ? stored : undefined);
        return savingsData(title, days, t, {
            role: this.role,
            sofar,
            liveNow: this.smartMode() === 'autopilot',
            firstLiveDate: typeof firstLive === 'number' ? localDate(firstLive, timeZone) : undefined,
            baseline: baseline ?? undefined,
            today: localDate(Date.now(), timeZone),
            label: (date) => dayLabel.format(new Date(`${date}T12:00:00Z`)),
            month: (date) => monthName.format(new Date(`${date}T12:00:00Z`)),
            price: (v) => amount(v, 2),
            money: (v) => amount(v, Math.abs(v) < 10 ? 1 : 0),
            dayMonth: (date) => dayMonth.format(new Date(`${date}T12:00:00Z`)),
            season: this.role === 'heating' ? this.heatingSeason(today) : undefined,

        });
    }

    // ---- Away: the thermostat goes to the Away temperature and comes back ----

    /** Whether this Heating device is away: it runs Autopilot heating and the home is away. */
    private autopilotAway(): boolean {
        return this.hasCapability(AUTOPILOT_AWAY_TEMPERATURE_CAPABILITY) && awayOn(readDayType(this.homey.settings.get(DAY_TYPE_SETTING)));
    }

    /** Set the thermostat as the owner would: through its own listener, which writes the pump. */
    private async setThermostat(celsius: number) {
        if (!this.hasCapability('target_temperature')) throw new Error(this.homey.__('autopilot.heating.no_thermostat'));
        await this.triggerCapabilityListener('target_temperature', celsius);
        await this.setCapabilityValue('target_temperature', celsius);
    }

    /** Follow the home's Away (driver `setAway`). On: the thermostat's temperature is kept and the
     *  thermostat set to the Away temperature, and Autopilot may use the widest range. Off: the
     *  thermostat goes back. Nothing on a device not running Autopilot heating. The kept
     *  temperature marks Away as applied, so a repeat changes nothing. */
    async applyAway(on: boolean) {
        if (!this.hasCapability(AUTOPILOT_AWAY_TEMPERATURE_CAPABILITY)) return;
        const applied = this.getStoreValue('autopilotHome') != null;
        if (on === applied) return;
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
    }

    /** Defaults for Autopilot's own controls when they first appear. */
    private async initAutopilotControls() {
        const init = async (name: string, value: any) => {
            if (this.hasCapability(name) && this.getCapabilityValue(name) === null)
                await this.setCapabilityValue(name, value).catch(this.error);
        };
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
        // Homey sensors read for Autopilot are its indoor temperature; stale, there is none.
        if (this.indoorReadOnly()) sample.ti = this.homeyIndoorNow();
        const priority = value(autopilot.priority.register);
        if (priority !== undefined) sample.dhw = priority === autopilot.priority.hotwater;
        if (priority !== undefined && autopilot.priority.heating !== undefined) sample.heat = priority === autopilot.priority.heating;
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
            this.hotwaterAutopilot?.noteTop(value ?? undefined);
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
        const when = dateFormat('sv-SE', {timeZone: this.homey.clock.getTimezone(), dateStyle: 'short', timeStyle: 'short'}).format(new Date(entry.t));
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

    async setWarning(message?: string | null) {
        this.warningText = message || undefined;
        return super.setWarning(message);
    }

    /** The indoor sensor warning, remembered in the store: Homey keeps a device warning across a
     *  restart, so the first good read after one must still know to clear it. */
    private async setIndoorWarning(message: string) {
        await this.setStoreValue(INDOOR_WARNING_STORE, true).catch(this.error);
        await this.setWarning(message).catch(this.error);
    }

    private async clearIndoorWarning() {
        if (!this.getStoreValue(INDOOR_WARNING_STORE)) return;
        await this.unsetStoreValue(INDOOR_WARNING_STORE).catch(this.error);
        await this.unsetWarning().catch(this.error);
    }

    async unsetWarning() {
        this.warningText = undefined;
        return super.unsetWarning();
    }

    async setUnavailable(message?: string | null) {
        this.unavailableText = message || undefined;
        return super.setUnavailable(message);
    }

    async setAvailable() {
        this.unavailableText = undefined;
        return super.setAvailable();
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
            this.pollHotwaterCeiling(readNames);
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
        this.noteLiveSlot(deltaKwh);
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

    /** The comfort range heating Autopilot plans in, set in Heating setup and kept in the store.
     *  A device that still carries the old capability starts from its value. */
    heatingRange(): string {
        const stored = this.getStoreValue(RANGE_STORE);
        if (typeof stored === 'string') return stored;
        const old = this.hasCapability(AUTOPILOT_RANGE_CAPABILITY) ? this.getCapabilityValue(AUTOPILOT_RANGE_CAPABILITY) : null;
        return typeof old === 'string' ? old : DEFAULT_PROFILE;
    }

    /** The limits heating Autopilot plans with: Save most while Away, else the comfort range's,
     *  or the Custom range's own settings. */
    private heatingLimits() {
        if (this.autopilotAway()) return profileLimits('save_most');
        return rangeLimits(this.heatingRange(), this.getStoreValue(CUSTOM_RANGE_STORE) ?? {});
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
        if (changedKeys.includes('adviceWarnings') && this.role === 'heating')
            this.homey.setTimeout(() => this.showAdviceWarning().catch(this.error), 1000);
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
                throw new Error('Return to your NIBE sensor in Repair before changing your heat pump\'s address.');
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
        if (this.backfillTimer) this.homey.clearTimeout(this.backfillTimer);
        await this.autopilot?.stop(this.connection?.currentPollSeconds() ?? 10).catch(this.error);
        this.autopilot = null;
        this.hotwaterAutopilot?.stop();
        if (this.hotwaterAutopilot) this.round().setHotwater(undefined);
        this.hotwaterAutopilot = null;
        if (this.takeoverTimer) this.homey.clearTimeout(this.takeoverTimer);
        this.roundOff?.();
        if (this.dayTypeTimer) this.homey.clearTimeout(this.dayTypeTimer);
        this.savingsStopped = true;
        if (this.savingsTimer) this.homey.clearTimeout(this.savingsTimer);
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
        if (this.backfillTimer) this.homey.clearTimeout(this.backfillTimer);
        await this.autopilot?.remove().catch(this.error);
        this.autopilot = null;
        await this.hotwaterAutopilot?.remove().catch(this.error);
        if (this.hotwaterAutopilot) this.round().setHotwater(undefined);
        this.hotwaterAutopilot = null;
        // The heat pump gets its own charging back while the connection is still up.
        this.removing = true;
        if (this.role === 'hotwater') await this.syncHotwaterTakeover().catch(this.error);
        if (this.takeoverTimer) this.homey.clearTimeout(this.takeoverTimer);
        this.roundOff?.();
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
