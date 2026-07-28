import {Dir, GroupId, Register, buildPickerPrimary, buildRegisterByName} from './registers';
import type {AlarmSeries} from './alarms';
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

    // How to read the pump's total instantaneous power (watts), which the allocator
    // integrates into per-function kWh. Ordered list of *alternative* source groups: the
    // registers within one group are summed (inverter F needs compressor + electric
    // addition), and the first group that actually reads wins.
    //
    // Alternatives rather than one flat list because no single register works across the
    // range: S1155/S1255, S1156/S1256 and S735 expose 2166, while S320/S325, S330/S332 and
    // S2125 do not and must fall back to the energy log's 2305. A pump can carry both, so
    // summing them all would double-count — hence "first group that reads", not "sum".
    //
    // Empty on fixed-speed F → the allocator is skipped and the energy/COP extras drop out.
    powerSources: string[][];

    // Lifetime cumulative production/consumption counters feeding main's Total COP. Absent on
    // models that don't expose them → main carries no Total COP.
    totalProductionRegister?: string;
    totalConsumptionRegister?: string;

    // The delivered-energy register whose rolling delta is a function device's COP numerator.
    producedRegisterForRole: Partial<Record<Role, string>>;

    // Raw priority value → the device its energy is charged to.
    priorityToRole: Record<number, Role>;

    // The capability that is each role device's primary on/off (the tile control). Function
    // roles map to their "Allow X" enable register (Allow heating, Allow hot water, …) so the
    // tile turns that function on/off; Main maps to the bare `onoff` (pinned ON — the pump is
    // always operating). Listed first in the pairing template so Homey uses it as the tile
    // on/off. Roles without an entry have no dedicated on/off control.
    primaryOnoff?: Partial<Record<Role, string>>;

    // Registers to reset (write their off value) when the raw operating priority transitions
    // between specific values — e.g. clear the one-time "More hot water" boost once the pump
    // leaves hot water (20) for idle (10), so the toggle doesn't stay on after it's delivered.
    resetOnPriorityChange?: {from: number; to: number; register: string}[];
}

// Text in both supported languages, following the same {en, sv} convention the register table
// uses for `info`.
export interface LocalizedText {
    en: string;
    sv: string;
}

// One register read to work out *why* the pump changed what it is producing. Never a
// capability — these exist only to be interpreted.
export interface ReasonInput {
    address: number;
    direction: Dir;
    scale?: number;
    size?: 16 | 32;
}

export interface ReasonContext {
    // Raw priority codes before and after the change, and the roles they map to.
    from?: number;
    to?: number;
    role: Role;
    previousRole?: Role;
    // A named input's value, scaled and sign-corrected; undefined if it didn't read (accessory
    // not fitted, register absent on this model) — every rule must tolerate that.
    v(id: string): number | undefined;
}

// Nibe exposes no "why did it do that" register — the control logic is internal. But the
// *inputs* to the decision are readable (degree minutes against the compressor start
// threshold, tank temperature against the hot-water start point, outdoor temperature against
// the heating cut-off), so a model can reconstruct the reason and state it in a sentence.
//
// The engine reads `inputs` on demand at the moment of a change — not every poll, so this
// costs nothing steady-state — and passes them to `explain()`. All the pump semantics live in
// `explain()`; the engine knows nothing about degree minutes. Returning undefined means "no
// better explanation than the priority change itself" and the reason is simply omitted.
export interface ReasonConfig {
    inputs: Record<string, ReasonInput>;
    explain(context: ReasonContext): LocalizedText | undefined;
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

    // The register carrying the pump's alarm *number*, plus WHICH numbering scheme it uses.
    // S and F number their alarms differently (the same code means different things), so the
    // series must be named explicitly — see lib/alarms.ts. When set, the main device gains a
    // derived alarm flag, a text description and an "alarm occurred" trigger.
    alarm?: {registerName: string; series: AlarmSeries};

    // How this model explains a change of operating priority — the registers to read and the
    // rules that turn them into a sentence. See ReasonConfig.
    reason?: ReasonConfig;

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
