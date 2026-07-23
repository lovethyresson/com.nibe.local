import {GroupId, Register, Selection, isRegisterEnabled} from './registers';
import type {ModelProfile} from './profile';

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

export function pumpActiveTitle(): {en: string; sv: string; de: string; nl: string; no: string; da: string} {
    return {en: "Active", sv: "Aktiv", de: "Aktiv", nl: "Actief", no: "Aktiv", da: "Aktiv"};
}

export function extraCapabilities(profile: ModelProfile, role: Role, selection?: Selection | null): string[] {
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
        const energyOn = (selection?.groups?.energy ?? true) && hasConsumedPower;
        const caps = [PUMP_ACTIVE_CAPABILITY];
        if (energyOn)
            caps.push(...ENERGY_CAPABILITIES);
        if ((selection?.groups?.energy ?? true) && hasTotalCounters)
            caps.push(TOTAL_COP_CAPABILITY);
        return caps;
    }
    if (!hasConsumedPower)
        return [];
    if (!selection)
        return [...ENERGY_CAPABILITIES, FUNCTION_COP_CAPABILITY];
    const energyCaps = ENERGY_CAPABILITIES.filter((name) =>
        selection.overrides?.[name] ?? selection.groups?.energy ?? true);
    // Rolling COP needs the used energy (from the allocator, energy group) alongside the
    // function's produced register — offer it whenever the energy pair is present and the
    // function has a produced register.
    const hasProduced = !!profile.role.producedRegisterForRole[role];
    return energyCaps.length && hasProduced
        ? [...energyCaps, FUNCTION_COP_CAPABILITY]
        : energyCaps;
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
export function registersForRole(profile: ModelProfile, role: Role, selection: Selection | null | undefined): Register[] {
    const groups = new Set<GroupId>(roleGroups[role]);
    return profile.registers.filter((register) =>
        groups.has(register.group)
        && (!register.role || register.role === role)
        && isRegisterEnabled(register, selection, profile.pickerPrimary));
}

// All registers of a role regardless of selection — used to register capability
// listeners up front so a capability enabled later via repair works without a restart.
export function roleRegisters(profile: ModelProfile, role: Role): Register[] {
    const groups = new Set<GroupId>(roleGroups[role]);
    return profile.registers.filter((register) =>
        groups.has(register.group) && (!register.role || register.role === role));
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
