import type {Role} from './roles';

// Model-agnostic register types + pure decode helpers + catalog builders. The actual
// `registers` array lives per-driver (drivers/<model>/registers.ts) and is threaded in via
// the ModelProfile — this file only knows the *shape* of a register and how to decode one.

export enum Dir {
    In,
    Out
}

// Feature groups a register can belong to. "core" is always enabled; the rest are
// toggled by the user during pairing/repair with recommendations from detection. Shared
// vocabulary across every pump model.
export const groupIds = [
    "heating",
    "hotwater",
    "pool",
    "cooling",
    "ventilation",
    "groundsource",
    "electrical",
    "solar",
    "alarm",
    "diagnostics",
    "statistics",
    // Carries no registers: the energy meter/power pair is derived by the connection's
    // allocator, not read over Modbus. It's a group so the selection machinery and both
    // pairing views can toggle it like any other feature.
    "energy"
] as const;

export type GroupId = typeof groupIds[number] | "core";

export interface RegisterInfo {
    en: string;
    sv: string;
}

export interface Register  {
    address: number;
    name: string;
    direction: Dir;
    group: GroupId;
    info: RegisterInfo;
    scale?: number
    // Register width in bits. Omitted/16 = a single Modbus word; 32 = a u32/s32 value
    // spanning two consecutive words (low word first, see combineRaw). Nibe's energy and
    // lifetime-counter registers are 32-bit.
    size?: 16 | 32;
    // A lifetime cumulative counter displayed relative to its value when the device was
    // paired ("since added") rather than as the pump's all-time total. The device captures
    // the first observed value as a baseline (persisted) and subtracts it, so every energy
    // figure in the app reads consistently since-pairing and the per-function meters
    // reconcile with the totals.
    relative?: boolean;
    // Pins a register to one device even though its group is shared across several roles.
    // Used for the per-function energy meters, which live in the shared "energy" group (so
    // they show up under Energy, and toggle with it) but must each land on their own
    // function device — e.g. the heating produced-energy meter only on the heating device.
    role?: Role;
    enum?: Record<number, string>
    bool?: boolean;
    // For bool registers whose raw on/off values aren't 1/0 (e.g. the "More hot water"
    // boost writes 2 = one-time increase 1h, 0 = off).
    onValue?: number;
    offValue?: number;
    picker?: boolean;
    noAction?: boolean;
    // A command register: writing acts, reading carries no state (e.g. "reset alarm",
    // where you write 1 to acknowledge and it reads back 0). Never polled, and kept out
    // of the flow cards that report or toggle a readable state.
    writeOnly?: boolean;
    // Engine infrastructure: polled and used by the connection (an energy allocator power
    // source, say), but never exposed as a capability, offered in the features view, or
    // expected in the compose file. Use this when a register's value already reaches the
    // user by another route — the allocator republishes its power source as `measure_power`,
    // so a fallback source would otherwise put a third copy of the same number on the tile.
    // Still sampled by detection, which is what decides whether it is usable on this model.
    internal?: boolean;
    // Alternate addresses to try when the primary reads the "not available" sentinel or a value
    // outside [fallbackMin, fallbackMax]. The first alternate whose decoded value is plausible is
    // used in the primary's place. Alternates must be the same quantity/direction/size/scale as
    // this register. A model-agnostic, plausibility-gated fallback (same spirit as powerSources)
    // for a sensor that lives at different registers on different models — e.g. the BT50 room
    // sensor is register 111 on S1155 but 26 on S735 — without a per-model register map.
    altAddresses?: number[];
    fallbackMin?: number;
    fallbackMax?: number;
    min?: number;
    max?: number;
}

// A register the user can change from Homey (writable holding register that
// isn't display-only) as opposed to a read-only sensor/insight value.
export function isAdjustable(register: Register): boolean {
    return register.direction === Dir.Out && !register.noAction;
}

// Whether a register is worth reading on the poll loop. Command registers carry no
// state to read back, and their capabilities (e.g. Homey's `button`) reject a value.
export function isPollable(register: Register): boolean {
    return !register.writeOnly;
}

// Combine the words of a Modbus read into one raw integer. A 32-bit register is read
// as two words, low word first (register N = low 16 bits, N+1 = high 16 bits) — verified
// against the live pump; big-endian word order yields garbage.
export function combineRaw(values: number[], size?: number): number {
    return size === 32 ? values[1] * 65536 + values[0] : values[0];
}

// Two's-complement decode of a raw register value for its width. 16-bit is the default;
// 32-bit spans two words. Everything is treated as signed (matching the 16-bit path);
// the u32 energy counters stay far below 2^31 so this is lossless for them.
export function signedValue(raw: number, size?: number): number {
    if (size === 32)
        return raw >= 0x80000000 ? raw - 0x100000000 : raw;
    return raw >= 32768 ? raw - 65536 : raw;
}

// Nibe's "value not available" sentinel (all-ones top bit): 0x8000 for 16-bit, 0x80000000
// for 32-bit. Checked on the raw (pre-sign) value.
export function isUnavailableRaw(raw: number, size?: number): boolean {
    return raw === (size === 32 ? 0x80000000 : 0x8000);
}

// Convert a raw register value to a plain number (sign + scale only, no enum/bool
// mapping) — used by detection sampling where only numeric movement and plausibility
// matter.
export function toNumericValue(register: Register, raw: number): number | undefined {
    // Nibe answers a read for a sensor that isn't fitted with the "value not available"
    // sentinel rather than an error, so the read *succeeds* and carries nothing. Decoding it
    // as a number yields a plausible-looking -3276.8 (0x8000 at scale 10), which is how the
    // hot-water circulation sensors (BT70/BT82/BT83) survived detection and arrived as
    // capabilities that render "-" forever: the runtime path checks the sentinel and the
    // detection path did not. Undefined here means "did not read", which is the truth.
    if (isUnavailableRaw(raw, register.size))
        return undefined;
    const value = signedValue(raw, register.size);
    if (register.scale)
        return value / register.scale;
    return value;
}

// The user's feature selection, stored on the device (store key "selection").
// A missing selection means everything is enabled, which keeps devices paired
// before this feature (or paired with detection skipped) behaving as before.
export interface Selection {
    groups: Partial<Record<GroupId, boolean>>;
    overrides: Record<string, boolean>;
}

// ---- Catalog helpers (derived from a specific register table) ------------------------
// These depend on the concrete register set, so they take it as an argument rather than
// closing over a module-level array — the ModelProfile precomputes and carries the results.

export function buildRegisterByName(registers: Register[]): Record<string, Register> {
    return Object.fromEntries(registers.map((register) => [register.name, register]));
}

// A `picker: true` register is a second representation of the same Modbus register as a
// non-picker twin at the same address: the settable control alongside the read-only,
// insights-logging sensor. Both are wanted (an enum picker can't be graphed and a sensor
// can't be set), but they are one thing to the user — so the feature lists show a single
// row per Modbus register and the picker follows its twin's selection instead of carrying
// an override of its own. Without that, unchecking the sensor would leave the picker
// enabled via the group default and the two would drift apart.
export function buildPickerPrimary(registers: Register[]): Record<string, string> {
    const pickerPrimary: Record<string, string> = {};
    for (const register of registers) {
        if (!register.picker)
            continue;
        const twin = registers.find((other) => other.address === register.address && !other.picker);
        if (twin)
            pickerPrimary[register.name] = twin.name;
    }
    return pickerPrimary;
}

// Registers offered in the pairing/repair feature lists — one row per Modbus register.
// Internal registers have no capability, so there is nothing to offer.
export function isSelectableRegister(register: Register, pickerPrimary: Record<string, string>): boolean {
    return !pickerPrimary[register.name] && !register.internal;
}

export function isRegisterEnabled(
    register: Register,
    selection: Selection | null | undefined,
    pickerPrimary: Record<string, string>
): boolean {
    if (register.group === "core" || !selection)
        return true;
    const key = pickerPrimary[register.name] ?? register.name;
    return selection.overrides?.[key]
        ?? selection.groups?.[register.group]
        ?? true;
}
