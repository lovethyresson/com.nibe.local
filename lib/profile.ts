import {GroupId, Register, buildPickerPrimary, buildRegisterByName} from './registers';
import type {Role} from './roles';

// Everything that differs between pump models (S vs F). The engine (connection, detection,
// discovery, device/driver bases) is generic and reads all model-specific data from here, so
// a new model is a new profile + register table + compose files, not new engine code.

// Helpers passed to the detection plausibility heuristics: `value(name)` is the last sampled
// numeric value (or undefined if the register never read), `inRange` is the common "read a
// non-zero value inside a sane band" test (exactly 0 is treated as a missing sensor).
export interface PlausibleHelpers {
    value: (name: string) => number | undefined;
    inRange: (name: string, min: number, max: number) => boolean;
}

export interface RoleConfig {
    // Operating-priority register (what the pump is producing) and the raw value meaning idle.
    // Used to attribute energy to a function device and to derive main's on/off. Optional: a
    // model without a priority register gets no energy split.
    priorityRegisterName?: string;
    priorityRawOff: number;

    // Register name(s) whose values (watts) are summed each poll to get the pump's total
    // instantaneous power, which the allocator integrates into per-function kWh. One register
    // on S (whole-unit power); a derived sum on inverter F (compressor + electric addition);
    // empty on fixed-speed F → the allocator is skipped and the energy/COP extras drop out.
    powerSources: string[];

    // Lifetime cumulative production/consumption counters feeding main's Total COP. Absent on
    // models that don't expose them → main carries no Total COP.
    totalProductionRegister?: string;
    totalConsumptionRegister?: string;

    // The delivered-energy register whose rolling delta is a function device's COP numerator.
    producedRegisterForRole: Partial<Record<Role, string>>;

    // Raw priority value → the device its energy is charged to.
    priorityToRole: Record<number, Role>;
}

export interface DiscoveryProbe {
    // The register read to verify a Modbus responder is a pump and to label it (outdoor temp).
    address: number;
    scale: number;
    min: number;
    max: number;
}

export interface ModelProfile {
    registers: Register[];
    registerByName: Record<string, Register>;
    // name -> primary (non-picker twin) name, for picker/sensor pair resolution.
    pickerPrimary: Record<string, string>;

    role: RoleConfig;

    // Default transport; a device may override port/unitId via its settings.
    transport: {port: number; unitId: number};

    // PDU-address offset: the value subtracted from a register's `address` before it goes on
    // the wire. Undefined/0 = the address is used as-is (S's 1-based ids). F uses Nibe
    // ModbusManager numbering, which may need an offset per the gateway.
    addressBase?: number;

    // Optional model/firmware input registers, read once per connect and written to the
    // read-only "Heat pump" settings labels. Addresses are model-specific (S: 1497/1496);
    // omitted on models where they aren't known → the info step is skipped.
    pumpInfo?: {typeAddress?: number; firmwareAddress?: number};

    detection: {
        // Fallback per-group heuristics for when nothing moved during the sampling window.
        plausible: Partial<Record<Exclude<GroupId, "core">, (helpers: PlausibleHelpers) => boolean>>;
        discoveryProbe: DiscoveryProbe;
    };

    // The driver's compose data, threaded in so the generic driver/device bases don't import a
    // specific driver's JSON.
    compose: {
        capabilities: string[];
        capabilitiesOptions: any;
        actions: any[];
        conditions: any[];
        triggers: any[];
    };
}

// What a driver supplies; the derived catalogs (registerByName, pickerPrimary) are computed
// here so every driver doesn't repeat it.
export type ProfileInput = Omit<ModelProfile, "registerByName" | "pickerPrimary">;

export function makeProfile(input: ProfileInput): ModelProfile {
    return {
        ...input,
        registerByName: buildRegisterByName(input.registers),
        pickerPrimary: buildPickerPrimary(input.registers)
    };
}
