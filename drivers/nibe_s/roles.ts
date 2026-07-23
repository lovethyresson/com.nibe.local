import {GroupId, Register, Selection, isRegisterEnabled, registers} from './registers';

// A paired Homey device represents one logical function of the physical pump.
// "main" owns the core sensors (outdoor temp, priority, operating mode) plus the
// diagnostic/statistic groups; the rest each carry one function's capabilities
// and its slice of the pump's energy use.
export type Role = "main" | "heating" | "hotwater" | "pool" | "cooling" | "solar";

// The heat-producing function devices: each carries a slice of the pump's energy use
// (allocator) and a COP. "solar" is deliberately NOT here — it's a producer, not a heat
// function, so it gets no energy allocation and no COP.
export const functionRoles: Role[] = ["heating", "hotwater", "pool", "cooling"];

// Every role a pump can be split into, in pairing-picker order.
export const allRoles: Role[] = ["main", ...functionRoles, "solar"];

// Homey device class per role. The class drives how the tile renders — `heater`/
// `boiler`/`heatpump` give it a primary on/off control and the dim-when-off state,
// while "other" renders as a plain sensor device. Main is the pump itself, so it takes
// `heatpump`: with class "other" its derived on/off state had nothing to render into.
// There's no cooler/pool class, so those stay "other".
export const roleClass: Record<Role, string> = {
    main: "heatpump",
    heating: "heater",
    hotwater: "boiler",
    pool: "other",
    cooling: "other",
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

// Raw value of the priority register (address 1028) → the device the pump's current
// energy use is charged to. 10 (Off/standby — circulation pumps, electronics, the
// year-round ventilation fan) goes to Main as "standby energy" rather than polluting a
// function: charging idle draw to Heating made Heating's COP meaningless (used energy
// with no heat produced). An unrecognised priority also falls back to Main/standby (see
// allocateEnergy), since an unattributable draw shouldn't distort a function's COP.
export const priorityToRole: Record<number, Role> = {
    10: "main",
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

// Extra (non-register) capabilities a device of this role carries. Function devices get
// the energy pair for their active draw; main gets it too, but its slice is the pump's
// standby/idle draw (allocated when priority is Off). Together — functions (active) +
// main (standby) — the meter_power.total meters still sum to the pump total in Homey's
// Energy tab, just sliced more honestly than folding idle into Heating.
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

// Rolling 30-day COP, computed on the device from the deltas of two cumulative counters
// over the window (so it moves through the season rather than sitting at the flat lifetime
// average). Not Modbus registers — computed — so, like the energy pair, they are "extras"
// outside the register-table reconciliation.
//   - main: Total COP = production (3821) / consumption (3823), rides the statistics group.
//   - function devices: <Function> COP = that function's produced register / its used
//     energy from the allocator, rides the energy group.
export const TOTAL_COP_CAPABILITY = "measure_cop_NIBE.total";
export const FUNCTION_COP_CAPABILITY = "measure_cop_NIBE.rolling";
export const TOTAL_PRODUCTION_REGISTER = "meter_kwh_NIBE.i3821_total_production";
export const TOTAL_CONSUMPTION_REGISTER = "meter_kwh_NIBE.i3823_total_consumption";

// The delivered-energy register whose (rolling) delta is the COP numerator for each
// function device. The denominator is that device's allocator used-energy.
export const producedRegisterForRole: Partial<Record<Role, string>> = {
    heating: "meter_kwh_NIBE.i1577_heating_produced",
    hotwater: "meter_kwh_NIBE.i1575_hotwater_produced",
    pool: "meter_kwh_NIBE.i1581_pool_produced",
    cooling: "meter_kwh_NIBE.i1579_cooling_produced"
};

export function pumpActiveTitle(): {en: string; sv: string; de: string; nl: string; no: string; da: string} {
    return {en: "Active", sv: "Aktiv", de: "Aktiv", nl: "Actief", no: "Aktiv", da: "Aktiv"};
}

export function extraCapabilities(role: Role, selection?: Selection | null): string[] {
    // Solar carries only its two Modbus registers (measure_power + meter_power.solar) — no
    // allocator energy pair and no COP.
    if (role === "solar")
        return [];
    if (role === "main") {
        // Main carries the energy pair too, but its slice is standby/idle draw (allocated
        // when the pump priority is Off) — titled "Idle energy"/"Idle power". Plus the
        // Total COP. All live in the energy group.
        const energyOn = selection?.groups?.energy ?? true;
        return energyOn
            ? [PUMP_ACTIVE_CAPABILITY, ...ENERGY_CAPABILITIES, TOTAL_COP_CAPABILITY]
            : [PUMP_ACTIVE_CAPABILITY];
    }
    if (!selection)
        return [...ENERGY_CAPABILITIES, FUNCTION_COP_CAPABILITY];
    const energyCaps = ENERGY_CAPABILITIES.filter((name) =>
        selection.overrides?.[name] ?? selection.groups?.energy ?? true);
    // Rolling COP needs the used energy (from the allocator, energy group) alongside the
    // function's produced register — offer it whenever the energy pair is present.
    return energyCaps.length ? [...energyCaps, FUNCTION_COP_CAPABILITY] : energyCaps;
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
        groups.has(register.group)
        && (!register.role || register.role === role)
        && isRegisterEnabled(register, selection));
}

// All registers of a role regardless of selection — used to register capability
// listeners up front so a capability enabled later via repair works without a restart.
export function roleRegisters(role: Role): Register[] {
    const groups = new Set<GroupId>(roleGroups[role]);
    return registers.filter((register) =>
        groups.has(register.group) && (!register.role || register.role === role));
}

// Suggested device names and per-instance energy/power capability titles, shown in
// pairing and on the energy capabilities. Kept here (not in the compose file) because
// the same capability id (meter_power.total) needs a different title per role device.
export const roleNames: Record<Role, {en: string; sv: string}> = {
    main: {en: "Nibe Main", sv: "Nibe Main"},
    heating: {en: "Nibe Heating", sv: "Nibe Värme"},
    hotwater: {en: "Nibe Hot Water", sv: "Nibe Varmvatten"},
    pool: {en: "Nibe Pool", sv: "Nibe Pool"},
    cooling: {en: "Nibe Cooling", sv: "Nibe Kyla"},
    solar: {en: "Nibe Solar", sv: "Nibe Solceller"}
};

// The solar device's cumulative-generation meter, declared as exported energy via
// setEnergy() so Homey's Energy tab counts it as production, not consumption.
export const SOLAR_METER_CAPABILITY = "meter_power.solar";

// Each device carries these separately, so no per-role qualifier is needed — the
// power title matches the pump's own "Current power" (i2166) for consistency.
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
