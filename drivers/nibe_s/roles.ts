import {GroupId, Register, Selection, isRegisterEnabled, registers} from './registers';

// A paired Homey device represents one logical function of the physical pump.
// "main" owns the core sensors (outdoor temp, priority, operating mode) plus the
// diagnostic/statistic groups; the rest each carry one function's capabilities
// and its slice of the pump's energy use.
export type Role = "main" | "heating" | "hotwater" | "pool" | "cooling";

export const functionRoles: Role[] = ["heating", "hotwater", "pool", "cooling"];

// Homey device class per role. `heater`/`boiler` give the tile its primary on/off
// control and dim-when-off state; there's no cooler/pool class so those stay "other".
export const roleClass: Record<Role, string> = {
    main: "other",
    heating: "heater",
    hotwater: "boiler",
    pool: "other",
    cooling: "other"
};

// Which feature groups belong to each role. Ventilation (FTX) folds into heating
// rather than getting its own device: its fan runs year-round and its draw is part
// of the building-heating side. Groups not listed here (core) stay on "main".
export const roleGroups: Record<Role, GroupId[]> = {
    main: ["core", "alarm", "diagnostics", "statistics", "electrical", "groundsource"],
    heating: ["heating", "ventilation", "energy"],
    hotwater: ["hotwater", "energy"],
    pool: ["pool", "energy"],
    cooling: ["cooling", "energy"]
};

// Raw value of the priority register (address 1028) → the function device that the
// pump's current energy use is charged to. 10 (Off/standby, dominated by the
// year-round ventilation fan) rolls into heating; 60 (Cooling) gets its own bucket
// so heating vs cooling can be compared over a year.
export const priorityToRole: Record<number, Role> = {
    10: "heating",
    20: "hotwater",
    30: "heating",
    40: "pool",
    60: "cooling"
};

// The register names of the software energy meter (kWh, per function device) and the
// live power draw (W, non-zero only on the currently active function). Neither is a
// Modbus register — they are derived in the connection's energy allocator — so they
// are excluded from the register-table reconciliation in syncCapabilities().
// The meter may carry a sub-capability id because the manifest's `energy` block points
// Homey at it explicitly (meterPowerImportedCapability). Live power has no such setting —
// Homey's real-time consumption reads the *base* `measure_power` id — so this must stay
// un-suffixed. As "measure_power.active" it rendered a value on the tile but never showed
// up in the device tab's energy card.
export const METER_CAPABILITY = "meter_power.total";
export const ACTIVE_POWER_CAPABILITY = "measure_power";

// The energy pair, in the order devices carry it. Exported so the selection plumbing
// can treat these two names like registers even though they aren't in the table.
export const ENERGY_CAPABILITIES = [METER_CAPABILITY, ACTIVE_POWER_CAPABILITY];

// Extra (non-register) capabilities a device of this role carries. Only the function
// devices get the energy pair; main deliberately carries no meter_power.* capability
// so it never shows up in Homey's Energy tab (the function devices' meters sum to the
// pump total there instead).
//
// The pair follows the "energy" feature group, resolved with the same precedence as
// isRegisterEnabled(): a per-capability override wins over the group, and a missing
// selection means enabled.
// Main's on/off is not a register: the pump exposes no "powered off" flag, so it is
// derived from the operating priority — off only while the pump is idle (priority 10),
// on whenever it is producing heating, hot water, pool or cooling. It reuses the bare
// `onoff` id because that is what drives a device's on/off state on the tile, which
// means it shares capabilitiesOptions with the hot water device's register-697 toggle;
// the per-role title is supplied at runtime (see NibeSDevice.extraOptions).
export const PUMP_ACTIVE_CAPABILITY = "onoff";

// Register whose value Main's on/off follows, and the raw value meaning "idle".
export const PRIORITY_REGISTER_NAME = "measure_enum_NIBE.i1028_priority";
export const PRIORITY_RAW_OFF = 10;

export function pumpActiveTitle(): {en: string; sv: string; de: string; nl: string; no: string; da: string} {
    return {en: "Active", sv: "Aktiv", de: "Aktiv", nl: "Actief", no: "Aktiv", da: "Aktiv"};
}

export function extraCapabilities(role: Role, selection?: Selection | null): string[] {
    if (role === "main")
        return [PUMP_ACTIVE_CAPABILITY];
    if (!selection)
        return [...ENERGY_CAPABILITIES];
    return ENERGY_CAPABILITIES.filter((name) =>
        selection.overrides?.[name] ?? selection.groups?.energy ?? true);
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
// Replaces the old device-wide enabledRegisters(): drives capability sync, polling
// and flow-card autocompletes so each device only ever touches its own registers.
export function registersForRole(role: Role, selection: Selection | null | undefined): Register[] {
    const groups = new Set<GroupId>(roleGroups[role]);
    return registers.filter((register) =>
        groups.has(register.group) && isRegisterEnabled(register, selection));
}

// All registers of a role regardless of selection — used to register capability
// listeners up front so a capability enabled later via repair works without a restart.
export function roleRegisters(role: Role): Register[] {
    const groups = new Set<GroupId>(roleGroups[role]);
    return registers.filter((register) => groups.has(register.group));
}

// Suggested device names and per-instance energy/power capability titles, shown in
// pairing and on the energy capabilities. Kept here (not in the compose file) because
// the same capability id (meter_power.total) needs a different title per role device.
export const roleNames: Record<Role, {en: string; sv: string}> = {
    main: {en: "Nibe Main", sv: "Nibe Main"},
    heating: {en: "Nibe Heating", sv: "Nibe Värme"},
    hotwater: {en: "Nibe Hot Water", sv: "Nibe Varmvatten"},
    pool: {en: "Nibe Pool", sv: "Nibe Pool"},
    cooling: {en: "Nibe Cooling", sv: "Nibe Kyla"}
};

// Each device carries these separately, so no per-role qualifier is needed — the
// power title matches the pump's own "Current power" (i2166) for consistency.
export function energyTitle(_role: Role): {en: string; sv: string} {
    return {en: "Total Energy", sv: "Total energi"};
}

export function powerTitle(_role: Role): {en: string; sv: string} {
    return {en: "Current power", sv: "Momentan effekt"};
}
