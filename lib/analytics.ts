import {randomUUID} from 'crypto';
import * as amplitude from '@amplitude/analytics-node';
import {Identify} from '@amplitude/analytics-node';

// Anonymous product analytics, off unless the user ticked the box during pairing.
//
// Everything analytics-related lives in this one file on purpose: it is the whole surface, so it
// is one file to read when asking "what does this app send?" and one file to delete if the answer
// should become "nothing". The call sites elsewhere are a single `track(...)` line each.
//
// State is module-level rather than carried on the app/device objects, mirroring `connections` in
// connection.ts. There is exactly one app instance per process, and it means `track()` needs no
// handle — which is what lets PumpConnection (shared per host, not a Homey device, no `homey`
// reference) report connection health without threading one through.

// Amplitude ingestion key — public by design; move to an env var when you set up environments.
//
// This key is SHARED with com.homevolt.local and any future Homey app: one Amplitude project
// serves all of them, and the `app` property below is what separates them again. That is the whole
// reason `app` exists. Do not mint a per-app key — Amplitude charts cannot span projects, so
// splitting the key would permanently foreclose every cross-app question.
const API_KEY = 'a43b0104bed25c3c0a277eda560bbe7b';

// The Amplitude project is in the EU, and an ingestion key is scoped to its project's region: the
// US endpoint rejects an EU key outright. This is NOT a default worth leaving alone — the SDK's is
// 'US' (api2.amplitude.com), which both breaks ingestion here and would ship EU heat-pump owners'
// data to a third country. Stated explicitly so the region is a decision, not an omission.
const SERVER_ZONE = 'EU';

export const CONSENT_SETTING = 'analytics_consent';
const DEVICE_ID_SETTING = 'analytics_device_id';

// The narrow slice of Homey this module needs. Declared structurally rather than importing the
// app type so the gate can be unit-tested with a plain object.
export interface AnalyticsHost {
    settings: {
        get(key: string): any;
        set(key: string, value: any): void;
    };
    manifest?: any;
}

type Logger = (...args: any[]) => void;

// null until there is both consent and a successful init(). Every track() checks it, so revoking
// consent stops the stream on the next call rather than at the next app start.
let enabled: {deviceId: string; appId: string; appVersion: string} | null = null;
// amplitude.init() is called at most once per process, whether it is reached from app start or
// from someone ticking the box during pairing. Consent granted mid-session therefore takes effect
// straight away — waiting for a restart would make the checkbox look broken.
let sdkInitialized = false;
let log: Logger = () => {};
let logError: Logger = () => {};

export function analyticsConsent(host: AnalyticsHost): boolean {
    return host.settings.get(CONSENT_SETTING) === true;
}

// Called from the pairing checkbox and the settings-page toggle. Revocation takes effect
// immediately: the local gate closes and the SDK is opted out as well, so an event already queued
// inside Amplitude's batcher is dropped rather than flushed after the user said no.
export function setAnalyticsConsent(host: AnalyticsHost, consent: boolean): void {
    host.settings.set(CONSENT_SETTING, consent === true);
    refreshConsent(host);
}

// Re-reads the stored answer and makes reality match it. Wired to Homey's settings 'set' event in
// app.ts, so consent flipped from the settings page — which writes the setting directly, the same
// way the page already reads the alarm history — is honored immediately and by the same code path
// as the pairing checkbox. There is no route that changes the setting without passing through here.
export function refreshConsent(host: AnalyticsHost): void {
    if (analyticsConsent(host)) {
        enableIfConsented(host);
        return;
    }
    if (!enabled)
        return;
    enabled = null;
    pendingProfile = null;
    if (profileTimer) {
        clearTimeout(profileTimer);
        profileTimer = null;
    }
    try {
        amplitude.setOptOut(true);
    } catch (error) {
        logError('Analytics: failed to opt out of the SDK', error);
    }
    log('Analytics: consent withdrawn — tracking stopped');
}

// Runs from NibeApp.onInit, and again if consent is granted later. Without consent it returns
// before the SDK is touched at all: no init, no client, no anonymous id minted, nothing on the wire.
export function initAnalytics(host: AnalyticsHost, logger: Logger, errorLogger: Logger): void {
    log = logger;
    logError = errorLogger;
    enableIfConsented(host);
}

function enableIfConsented(host: AnalyticsHost): void {
    if (enabled)
        return;
    if (!analyticsConsent(host)) {
        log('Analytics: no consent stored — tracking disabled');
        return;
    }

    // Minted on first use and reused afterwards. This is the *only* identifier sent, and it is
    // random: not the pump IP, not a serial, not a model. It exists because Amplitude requires a
    // device_id or user_id per event, not because we want to know who anyone is.
    let deviceId: string = host.settings.get(DEVICE_ID_SETTING);
    if (typeof deviceId !== 'string' || !deviceId) {
        deviceId = randomUUID();
        host.settings.set(DEVICE_ID_SETTING, deviceId);
    }

    try {
        amplitude.setOptOut(false);
        if (!sdkInitialized) {
            amplitude.init(API_KEY, {serverZone: SERVER_ZONE});
            sdkInitialized = true;
        }
        // appId is read from the manifest rather than hardcoded, so neither this app nor
        // com.homevolt.local names itself and a third app gets the separation for free.
        enabled = {
            deviceId,
            appId: String(host.manifest?.id ?? 'unknown'),
            appVersion: String(host.manifest?.version ?? 'unknown')
        };
        log('Analytics: enabled by consent');
    } catch (error) {
        // A failure here must not take app start with it — the pump is the point, analytics are not.
        logError('Analytics: init failed, tracking disabled', error);
        enabled = null;
    }
}

export function appVersion(): string {
    return enabled?.appVersion ?? 'unknown';
}

// What the install *is*, as opposed to what it did: pump model, and which functions and features
// are switched on. These go on the anonymous profile as user properties rather than onto each
// event, because the questions worth asking are cross-sectional — "of the S1255 installs, how
// many run cooling?" — and that is a segmentation, not an event count.
export interface InstallProfile {
    // Raw value of the heat-pump type register (1497 on S-series). Sent as the code the pump
    // reports, not a model name: the code→name mapping differs per model and firmware and is not
    // something this app knows reliably, so guessing here would poison the data it exists to give.
    pumpModelCode?: string;
    firmware?: string;
    // Which of the six role devices the user actually created — the "which functions" question.
    functions: string[];
    // Enabled feature groups per role — the "which features within a function" question.
    // e.g. {heating: ['heating', 'ventilation', 'energy'], hotwater: ['hotwater']}
    featuresByFunction: Record<string, string[]>;

    // The hub this is all running on. Same principle as pumpModelCode: send what the SDK reports,
    // not a marketing name derived from it. `platform` + `platformVersion` together identify the
    // product ('local' + 2 is a Homey Pro Early 2023, 'cloud' is Homey Cloud behind a Bridge), but
    // that mapping is Athom's to change and would rot here.
    homeyVersion?: string;
    homeyPlatform?: string;
    homeyPlatformVersion?: number;
    // Timezone is the country signal — 'Europe/Stockholm' resolves to a country for every zone that
    // matters, without embedding an IANA→ISO table that goes stale. Language and units are locale,
    // not location: plenty of Swedish users run Homey in English.
    timezone?: string;
    language?: string;
    units?: string;
}

// Six devices finishing onInit at once, or a repair touching several, would otherwise send six
// near-identical identifies. Coalesce into one — the profile is a steady-state fact, so the last
// snapshot within the window is the true one.
const PROFILE_DEBOUNCE_MS = 5000;
let profileTimer: NodeJS.Timeout | null = null;
let pendingProfile: InstallProfile | null = null;

export function reportInstallProfile(profile: InstallProfile): void {
    if (!enabled)
        return;
    pendingProfile = profile;
    if (profileTimer)
        return;
    profileTimer = setTimeout(() => {
        profileTimer = null;
        const snapshot = pendingProfile;
        pendingProfile = null;
        if (!enabled || !snapshot)
            return;
        try {
            const identity = new Identify();
            identity.set('app', enabled.appId);
            identity.set('app_version', enabled.appVersion);
            identity.set('functions', snapshot.functions);
            identity.set('function_count', snapshot.functions.length);
            if (snapshot.pumpModelCode)
                identity.set('pump_model_code', snapshot.pumpModelCode);
            if (snapshot.firmware)
                identity.set('firmware', snapshot.firmware);
            for (const [key, value] of Object.entries({
                homey_version: snapshot.homeyVersion,
                homey_platform: snapshot.homeyPlatform,
                homey_platform_version: snapshot.homeyPlatformVersion,
                timezone: snapshot.timezone,
                language: snapshot.language,
                units: snapshot.units
            }))
                if (value !== undefined)
                    identity.set(key, value);
            // One property per function so each is independently segmentable in Amplitude; a
            // single nested object would collapse into something you cannot group by.
            for (const [role, groups] of Object.entries(snapshot.featuresByFunction))
                identity.set(`features_${role}`, groups);
            amplitude.identify(identity, {device_id: enabled.deviceId})
                .promise
                .catch((error) => logError('Analytics: install profile failed to send', error));
        } catch (error) {
            logError('Analytics: install profile threw before sending', error);
        }
    }, PROFILE_DEBOUNCE_MS);
    // A pending profile must never hold the Homey process open at shutdown.
    profileTimer.unref?.();
}

// The one choke point. Fire-and-forget by design: this is called from poll chains, Flow run
// listeners and capability listeners, and none of them should wait on a network round trip to
// Amplitude. Failures are logged rather than swallowed, but can never reject into the caller.
export function track(name: string, properties?: Record<string, any>): void {
    if (!enabled)
        return;
    try {
        // `app` is merged in here rather than at every call site — that is what makes a single
        // Amplitude project able to serve every Homey app. It goes AFTER the spread so a caller
        // cannot shadow it: `app` has to be authoritative, because every cross-app chart is
        // filtered on it and one mislabelled event is one attributed to the wrong product.
        amplitude.track(name, {...properties, app: enabled.appId}, {device_id: enabled.deviceId})
            .promise
            .then((result) => {
                if (result.code >= 400)
                    logError(`Analytics: "${name}" rejected with ${result.code} ${result.message}`);
            })
            .catch((error) => logError(`Analytics: "${name}" failed to send`, error));
    } catch (error) {
        logError(`Analytics: "${name}" threw before sending`, error);
    }
}
