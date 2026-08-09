import {GroupId, Register, Selection, isRegisterEnabled, withResolvedAddresses} from './registers';
import type {CapabilityMirror, ModelProfile} from './profile';

// A paired Homey device represents one logical function of the physical pump.
// "main" owns the core sensors (outdoor temp, priority, operating mode) plus the
// diagnostic/statistic groups; the rest each carry one function's capabilities
// and its slice of the pump's energy use. Shared across every pump model.
export type Role = "main" | "heating" | "hotwater" | "pool" | "cooling" | "solar";

// The heat-producing function devices: each carries a slice of the pump's energy use
// (allocator) and a COP. "solar" is deliberately NOT here — it's a producer, not a heat
// function, so it gets no energy allocation and no COP.
export const functionRoles: Role[] = ["heating", "hotwater", "pool", "cooling"];

// Every role a pump can be split into, in pairing-picker order.
export const allRoles: Role[] = ["main", ...functionRoles, "solar"];

// Homey device class per role. The class drives how the tile renders — all of these give a
// primary on/off control and the dim-when-off state that the derived Active capability needs.
// Main is the pump itself → `heatpump`; cooling maps to `airconditioning`; pool is heating
// too (just of pool water) so it uses `heater`. Hot water is a `waterheater` (Swedish
// "Varmvattenberedare" — exactly a Nibe DHW tank — vs `boiler`/"Värmepanna", a furnace).
// Each device keeps its own custom icon regardless of class (see deviceTemplate `icon`).
export const roleClass: Record<Role, string> = {
    main: "heatpump",
    // `thermostat`, not `heater`, and that is what renders the compact current/target row on the
    // tile. The root `measure_temperature` + `target_temperature` pair is necessary but not
    // sufficient: with them present on a `heater` the device joins Homey's Climate view and still
    // shows two separate sensor rows. Homey's own class description names the combination —
    // "usually together with the measure_temperature, target_temperature and thermostat_mode
    // capabilities" — and the class is the remaining discriminator for the tile. Heating is the
    // only role that carries the pair, so it is the only one that changes.
    heating: "thermostat",
    // Deliberately NOT a thermostat, unlike heating and pool. `waterheater` is exactly what a
    // Nibe DHW tank is (Swedish "Varmvattenberedare"), and the alternatives are the wrong
    // appliance: `boiler` is a furnace, `heater` a radiator.
    //
    // It has no dial, and that is the real cost: a thermostat needs one honest target to mirror,
    // and hot water has three stop temperatures whose relevance depends on the demand mode.
    // Mirroring any one of them is wrong in the other two. Correct class, no dial.
    //
    // This comment used to add that the class also cost the tile its on/off state. That was
    // wrong. The tile's on/off appearance is `ui.quickAction`, not the class — heating greys
    // because its quick action is its enable toggle. Hot water had `uiQuickAction` pinned to
    // "More hot water", which displaced the enable toggle from that one slot. The class was
    // never involved.
    hotwater: "waterheater",
    // Also a thermostat: it measures a temperature and controls it. Its root capability pair is
    // mirrored from the pool temperature and stop setpoint (see `mirrors` in the S profile),
    // since the register table's own names already own those ids.
    pool: "thermostat",
    cooling: "airconditioning",
    solar: "solarpanel"
};

// Which feature groups belong to each role. Ventilation (FTX) folds into heating
// rather than getting its own device: its fan runs year-round and its draw is part
// of the building-heating side. Groups not listed here (core) stay on "main".
export const roleGroups: Record<Role, GroupId[]> = {
    main: ["core", "alarm", "diagnostics", "statistics", "electrical", "groundsource", "energy"],
    heating: ["heating", "ventilation", "energy"],
    hotwater: ["hotwater", "energy"],
    pool: ["pool", "energy"],
    cooling: ["cooling", "energy"],
    solar: ["solar"]
};

// The register names of the software energy meter (kWh, per function device) and the
// live power draw (W, non-zero only on the currently active function). Neither is a
// Modbus register — they are derived in the connection's energy allocator — so they
// are excluded from the register-table reconciliation in syncCapabilities().
// The meter may carry a sub-capability id because the manifest's `energy` block points
// Homey at it explicitly (meterPowerImportedCapability). Live power has no such setting —
// Homey's real-time consumption reads the *base* `measure_power` id — so this must stay
// un-suffixed.
export const METER_CAPABILITY = "meter_power.total";
export const ACTIVE_POWER_CAPABILITY = "measure_power";

// The energy pair, in the order devices carry it. Exported so the selection plumbing
// can treat these two names like registers even though they aren't in the table.
export const ENERGY_CAPABILITIES = [METER_CAPABILITY, ACTIVE_POWER_CAPABILITY];

// Main's on/off is not a register: the pump exposes no "powered off" flag, so it is
// derived from the operating priority. It reuses the bare `onoff` id because that is what
// drives a device's on/off state on the tile; the per-role title is supplied at runtime.
export const PUMP_ACTIVE_CAPABILITY = "onoff";

// Rolling 30-day COP capability ids (values computed on the device from cumulative-counter
// deltas). Not Modbus registers — computed — so, like the energy pair, they are "extras".
export const TOTAL_COP_CAPABILITY = "measure_cop_NIBE.total";
export const FUNCTION_COP_CAPABILITY = "measure_cop_NIBE.rolling";

// The solar device's cumulative-generation meter, declared as exported energy via
// setEnergy() so Homey's Energy tab counts it as production, not consumption.
export const SOLAR_METER_CAPABILITY = "meter_power.solar";

// Alarm state on the main device. `alarm_text_NIBE` is the profile's alarm *register* itself
// (the raw code, rendered as text by lib/alarms.ts), so it comes from the register table.
// `alarm_generic` is derived from the same register — Homey's official alarm boolean, so the
// pump gets native alarm treatment in the UI and works with Homey's built-in alarm Flow cards
// — and being derived, it's an "extra".
export const ALARM_ACTIVE_CAPABILITY = "alarm_generic";
export const ALARM_TEXT_CAPABILITY = "alarm_text_NIBE";
export const ALARM_CAPABILITIES = [ALARM_ACTIVE_CAPABILITY];

// Main's on/off is pinned ON (the pump is always operating), so it reads simply as "On".
export function pumpActiveTitle(): {en: string; sv: string; de: string; nl: string; no: string; da: string} {
    return {en: "On", sv: "På", de: "Ein", nl: "Aan", no: "På", da: "Til"};
}

// The mirrors this model declares for a role. See `mirrors` on ModelProfile: a bare capability
// carrying a register's value so Homey's own features (the thermostat tile, Climate) can see it.
export function mirrorsForRole(profile: ModelProfile, role: Role): CapabilityMirror[] {
    return (profile.mirrors ?? []).filter((mirror) => mirror.role === role);
}

// The mirror that publishes a given capability on a role, if any.
export function mirrorFor(
    profile: ModelProfile, role: Role, capability: string
): CapabilityMirror | undefined {
    return mirrorsForRole(profile, role).find((mirror) => mirror.capability === capability);
}

// Which derived energy/COP capabilities this pump can actually produce a value for, given
// which registers answered during detection. `read(name)` reports whether a register was read
// (callers pass `() => true` when there is no detection data, preserving the "assume
// everything" default used throughout the selection machinery).
//
// This exists because "is the energy group supported?" is not one question. The group's
// registers have different dependencies, and on an S320 most of them read while the one the
// energy pair actually needs — the power source — does not. Detection used to ask only
// whether *any* energy register read, so it offered the energy pair and the COP on hardware
// that can never populate them, and the devices were created carrying capabilities that
// stayed permanently empty.
export function extraCapabilitySupport(
    profile: ModelProfile, role: Role,
    sample: (name: string) => {read: boolean; moved: boolean; value?: number} | undefined
): Record<string, boolean> {
    const read = (name: string) => sample(name)?.read ?? false;
    // The pump's electrical draw. Everything the allocator produces depends on it.
    //
    // Stricter than a plain "did it answer": a power register that answers every read and
    // sits at exactly zero throughout the sampling window is not wired up on this pump. That
    // is not hypothetical — register 2727 "Current power" answers 31/31 reads on an S1155 and
    // stays at 0 straight through a 3.3 kW compressor run, because it belongs to the external
    // energy-meter accessory. Same reasoning as `inRange`'s "exactly 0 means missing sensor".
    const usablePower = (name: string) => {
        const probe = sample(name);
        return !!probe?.read && (probe.moved || (probe.value ?? 0) !== 0);
    };
    const powerOk = profile.role.powerSources.some((group) => group.some(usablePower));
    // The lifetime counters behind Main's Total COP — deliberately independent of the power
    // source, which is why Total COP still works on a model with no readable power register.
    const {totalProductionRegister, totalConsumptionRegister} = profile.role;
    const totalsOk = !!totalProductionRegister && !!totalConsumptionRegister
        && read(totalProductionRegister) && read(totalConsumptionRegister);
    // A function's COP needs the used energy (allocator → power source) and its own delivered
    // energy counter.
    const produced = profile.role.producedRegisterForRole[role];
    const support: Record<string, boolean> = {
        [METER_CAPABILITY]: powerOk,
        [ACTIVE_POWER_CAPABILITY]: powerOk,
        [TOTAL_COP_CAPABILITY]: totalsOk,
        [FUNCTION_COP_CAPABILITY]: powerOk && !!produced && read(produced)
    };
    // A mirror is exactly as supported as the register behind it — offering a thermostat dial
    // for a pool the pump never reported would be a control over nothing.
    for (const mirror of mirrorsForRole(profile, role))
        support[mirror.capability] = read(mirror.register);
    return support;
}

export function extraCapabilities(profile: ModelProfile, role: Role, selection?: Selection | null): string[] {
    // The energy-group extras all follow the same rule: an explicit per-capability override
    // wins, then the group toggle, then "on". A missing selection means everything is enabled
    // (the upgrade path for devices paired before selections existed).
    const enabled = (name: string) =>
        selection?.overrides?.[name] ?? selection?.groups?.energy ?? true;
    // Mirrors ride the selection of the register they copy, not their own: they are the same
    // value, so a user who switched the source off must not still get a dial for it.
    const mirrored = mirrorsForRole(profile, role)
        .filter((mirror) => {
            const source = profile.registerByName[mirror.register];
            return source && isRegisterEnabled(source, selection ?? null, profile.pickerPrimary);
        })
        .map((mirror) => mirror.capability);
    // Solar carries only its two Modbus registers (measure_power + meter_power.solar) — no
    // allocator energy pair and no COP.
    if (role === "solar")
        return [];
    // A COP/energy extra is only meaningful if the pump exposes the source registers it is
    // derived from. On S all are present (identical to before); on a fixed-speed F with no
    // consumed-power source they drop out cleanly.
    const hasConsumedPower = profile.role.powerSources.length > 0;
    const hasTotalCounters = !!profile.role.totalProductionRegister
        && !!profile.role.totalConsumptionRegister;
    if (role === "main") {
        // Main carries the energy pair too, but its slice is standby/idle draw (allocated
        // when the pump priority is Off) — titled "Idle energy"/"Idle power". Plus the
        // Total COP. All live in the energy group.
        const caps = [PUMP_ACTIVE_CAPABILITY];
        // Derived alarm state + description, riding the alarm group (where the alarm
        // register itself lives), when the model declares an alarm register.
        if (profile.alarm && (selection?.groups?.alarm ?? true))
            caps.push(...ALARM_CAPABILITIES);
        if (hasConsumedPower)
            caps.push(...ENERGY_CAPABILITIES.filter(enabled));
        if (hasTotalCounters && enabled(TOTAL_COP_CAPABILITY))
            caps.push(TOTAL_COP_CAPABILITY);
        return [...caps, ...mirrored];
    }
    // Function roles: the tile on/off is a real register (the "Allow X" enable capability), so
    // there is no derived on/off extra here — just the energy pair + rolling COP, following the
    // power source and the energy selection.
    // Mirrors are independent of the energy machinery — a pool thermostat has nothing to do with
    // whether the pump exposes a power source — so they survive this early return.
    if (!hasConsumedPower)
        return mirrored;
    const energyCaps = ENERGY_CAPABILITIES.filter(enabled);
    // Rolling COP needs the used energy (from the allocator, energy group) alongside the
    // function's produced register — offer it whenever the energy pair is present and the
    // function has a produced register.
    const hasProduced = !!profile.role.producedRegisterForRole[role];
    return energyCaps.length && hasProduced && enabled(FUNCTION_COP_CAPABILITY)
        ? [...energyCaps, FUNCTION_COP_CAPABILITY, ...mirrored]
        : [...energyCaps, ...mirrored];
}

// Read the role off a device's `data`. Defaults to "main" defensively; every device
// paired by this driver carries an explicit role.
export function roleOf(data: any): Role {
    return (data?.role ?? "main") as Role;
}

export function groupsForRole(role: Role): GroupId[] {
    return roleGroups[role];
}

// Registers this role is responsible for, filtered by the user's feature selection.
// Drives capability sync, polling and flow-card autocompletes so each device only ever
// touches its own registers.
// Registers come back on their *resolved* addresses, so polling, the register dump and the
// flow autocompletes all follow a relocated register without knowing it moved. Writes resolve
// separately, at the moment of the write (see NibePumpDevice.writeRegister) — a capability
// listener is registered once at init and closes over its register, so resolving there would
// keep writing to the old address after a repair changed it.
export function registersForRole(profile: ModelProfile, role: Role, selection: Selection | null | undefined): Register[] {
    const groups = new Set<GroupId>(roleGroups[role]);
    return withResolvedAddresses(profile.registers.filter((register) =>
        !register.internal
        && groups.has(register.group)
        && (!register.role || register.role === role)
        && isRegisterEnabled(register, selection, profile.pickerPrimary)), selection);
}

// All registers of a role regardless of selection — used to register capability
// listeners up front so a capability enabled later via repair works without a restart.
export function roleRegisters(profile: ModelProfile, role: Role): Register[] {
    const groups = new Set<GroupId>(roleGroups[role]);
    return profile.registers.filter((register) =>
        !register.internal && groups.has(register.group) && (!register.role || register.role === role));
}

// Suggested device names, shown in pairing. Generic across models (the driver name
// distinguishes S from F).
export const roleNames: Record<Role, {en: string; sv: string}> = {
    main: {en: "Nibe Main", sv: "Nibe Main"},
    heating: {en: "Nibe Heating", sv: "Nibe Värme"},
    hotwater: {en: "Nibe Hot Water", sv: "Nibe Varmvatten"},
    pool: {en: "Nibe Pool", sv: "Nibe Pool"},
    cooling: {en: "Nibe Cooling", sv: "Nibe Kyla"},
    solar: {en: "Nibe Solar", sv: "Nibe Solceller"}
};

// The Homey Energy-tab meter for a function = electricity this function has used since the
// device was added (from the allocator). Titled "Energy used" to read clearly next to the
// "Energy delivered" produced meter and the rolling COP on the same device.
export function energyTitle(role: Role): {en: string; sv: string} {
    return role === 'main'
        ? {en: "Idle energy", sv: "Tomgångsenergi"}
        : {en: "Energy used", sv: "Använd energi"};
}

export function powerTitle(role: Role): {en: string; sv: string} {
    return role === 'main'
        ? {en: "Idle power", sv: "Tomgångseffekt"}
        : {en: "Current power", sv: "Momentan effekt"};
}

// Per-instance capabilitiesOptions for the non-register "extra" capabilities (the energy pair,
// the COP sensors, main's derived on/off). They share one capability id across role devices but
// need a role-specific title, which the compose file can't express — so both the device
// (runtime) and the pairing template use this single source. Returning them at pairing time is
// what stops getCapabilityOptions() throwing "Invalid Capability" for the COP sensors.
export function mirrorOptions(
    profile: ModelProfile, role: Role, name: string
): any | undefined {
    return mirrorFor(profile, role, name)?.options;
}

export function extraCapabilityOptions(role: Role, name: string): any {
    if (name === METER_CAPABILITY)
        return {title: energyTitle(role)};
    if (name === ACTIVE_POWER_CAPABILITY)
        return {title: powerTitle(role), decimals: 0};
    // Not settable: the pump has no whole-pump on/off command, so this exists only to give the
    // tile an on state and is pinned there. Declared settable it was offered as a quick action
    // called "On", which did nothing but throw when pressed.
    if (name === PUMP_ACTIVE_CAPABILITY)
        return {title: pumpActiveTitle(), uiComponent: null, setable: false};
    if (name === ALARM_ACTIVE_CAPABILITY)
        return {title: {en: "Alarm active", sv: "Larm aktivt", de: "Alarm aktiv",
                        nl: "Alarm actief", no: "Alarm aktivt", da: "Alarm aktivt"}};
    if (name === ALARM_TEXT_CAPABILITY)
        return {title: {en: "Alarm", sv: "Larm", de: "Alarm", nl: "Alarm", no: "Alarm", da: "Alarm"}};
    if (name === TOTAL_COP_CAPABILITY)
        return {title: {en: "Total COP (30-day)", sv: "Total COP (30 dagar)"}, decimals: 2};
    if (name === FUNCTION_COP_CAPABILITY) {
        const titles: Partial<Record<Role, {en: string; sv: string}>> = {
            heating: {en: "Heating COP (30-day)", sv: "Värme COP (30 dagar)"},
            hotwater: {en: "Hot water COP (30-day)", sv: "Varmvatten COP (30 dagar)"},
            pool: {en: "Pool COP (30-day)", sv: "Pool COP (30 dagar)"},
            cooling: {en: "Cooling COP (30-day)", sv: "Kyla COP (30 dagar)"}
        };
        return {title: titles[role] ?? {en: "COP (30-day)", sv: "COP (30 dagar)"}, decimals: 2};
    }
    return undefined;
}
