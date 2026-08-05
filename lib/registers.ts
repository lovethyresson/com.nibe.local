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
    // Addresses to fall back to, in order, when this register carries no usable value on a
    // model. Two different situations need this, and only one of them is predictable from
    // Nibe's register maps:
    //   (a) relocation — the register genuinely lives elsewhere on some models, e.g. heating
    //       medium pump speed at 1636 instead of 1102 on the S330/S332. The primary simply
    //       does not answer there.
    //   (b) present but dead — the address is listed for the model and answers, but always
    //       with the not-available sentinel, while the real value sits at another address.
    //       Room temperature on the S735 is this: 111 is documented and empty, 26 is not
    //       documented for that model and reads correctly.
    // Case (b) is why a model-code lookup table cannot solve this and a live read must:
    // only reading the pump finds it. Resolved once during detection (pairing/repair), never
    // per poll — `Selection.addresses` records what won.
    altAddresses?: number[];
    // The band a candidate must read within to be accepted, required alongside altAddresses.
    // Guards against an undocumented address answering with something that merely decodes as
    // a number — register 2727 answered 31 of 31 reads and was flat zero throughout a 3.3 kW
    // run, which is how it nearly became the energy allocator's power source.
    // Choose bounds that make a dead reading implausible: an indoor sensor uses 5..40 rather
    // than -10..50 precisely so a disconnected sensor's 0 falls outside. Where 0 is genuine
    // data (a pulse meter that has counted nothing yet) let the band include it.
    altPlausible?: {min: number; max: number};
    // The band this register's OWN value must fall in for the capability to be offered at all.
    // Distinct from altPlausible, which vets a candidate *address*: this vets the value found at
    // the address the register already has, and a register outside its band is treated exactly
    // like one that never answered — not offered during pairing, flagged unsupported at repair.
    //
    // For registers a pump answers even when the underlying function is not configured. The
    // desired-room-temperature setpoint is the case in point: unconfigured zones read a flat 0
    // rather than the not-available sentinel, so without a band a pump whose room sensor does not
    // control heating would present a thermostat dial reading 0 °C. Same reasoning as `inRange`'s
    // and `usablePower`'s "an exact zero means the thing isn't wired up", applied per register.
    plausible?: {min: number; max: number};
    min?: number;
    max?: number;
}

// Whether a value read from a candidate address is good enough to accept as this register's
// real source. A register without a band never resolves to an alternate.
export function isPlausibleAlt(register: Register, value: number | undefined): boolean {
    const band = register.altPlausible;
    if (!band || value === undefined)
        return false;
    return value >= band.min && value <= band.max;
}

// Whether a value read at the register's own address is worth offering as a capability. A
// register that declares no band always is — this must not quietly filter the whole table.
export function isPlausibleValue(register: Register | undefined, value: number | undefined): boolean {
    const band = register?.plausible;
    if (!band)
        return true;
    return value !== undefined && value >= band.min && value <= band.max;
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
// A raw value split into the words a WRITE puts on the wire — high word first, which is NOT the
// order combineRaw() reads them back in. That asymmetry is the pump's, not a bug here, and it was
// measured rather than assumed. On a live S735, writing the 32-bit setpoint 2505:
//
//   FC16 [220, 0]  (low word first, i.e. mirroring the read order)  -> accepted, value unchanged
//   FC16 [0, 220]  (high word first)                                -> accepted, value took effect
//   FC06 220 at 2505, and FC06 at 2506                              -> accepted, value unchanged
//
// So the pump answers every one of these without a Modbus exception and silently discards three of
// them: a 32-bit register takes one two-word FC16 write assembled big-endian, and nothing else.
// Reads of the same register return the value in the *first* word. Verified twice, restoring the
// original value in between; n=1 register on one model, since 2505 is currently the only writable
// 32-bit register in any table.
//
// Plain arithmetic rather than shifts because JS bitwise operators coerce to *signed* 32 bits,
// which is the wrong shape for a value that is unsigned by the time it reaches here.
export function splitRawForWrite(raw: number, size?: number): number[] {
    return size === 32 ? [Math.floor(raw / 65536), raw % 65536] : [raw];
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
    // Register name → the address detection actually found the value at, recorded only when
    // it wasn't the register's own. Absent for every register on every model that doesn't
    // relocate, which is nearly all of them. A device paired before this existed has no entry
    // and reads the primary exactly as it did — running Repair re-runs detection and fills
    // this in.
    addresses?: Record<string, number>;
}

// The address to actually put on the wire for a register, honouring what detection resolved.
export function resolvedAddress(register: Register, selection: Selection | null | undefined): number {
    return selection?.addresses?.[register.name] ?? register.address;
}

// Carry a stored selection across a register RENAME. Both maps in a Selection are keyed by
// register name, so renaming a register silently orphans that register's entries: its per-capability
// override reverts to the group default, and — the one that actually breaks a pump — its resolved
// alternate address is lost, sending the read back to a primary that answers with the not-available
// sentinel. On an S735 that is exactly the room-temperature register, so a rename without this would
// leave the renamed capability empty until the owner happened to run Repair.
//
// Returns the same object when there is nothing to carry, so devices on models that never renamed
// anything neither allocate nor re-save. Idempotent: applying it to an already-migrated selection
// finds no old keys and changes nothing.
export function migrateSelection(
    selection: Selection, renames: Record<string, string> | undefined
): Selection {
    const pairs = Object.entries(renames ?? {})
        .filter(([from]) => selection.overrides?.[from] !== undefined
            || selection.addresses?.[from] !== undefined);
    if (!pairs.length)
        return selection;
    const migrated: Selection = {
        ...selection,
        overrides: {...selection.overrides},
        ...(selection.addresses ? {addresses: {...selection.addresses}} : {})
    };
    for (const [from, to] of pairs) {
        // The new name wins if it somehow already has a value — a re-run must never undo itself.
        if (migrated.overrides[from] !== undefined) {
            if (migrated.overrides[to] === undefined)
                migrated.overrides[to] = migrated.overrides[from];
            delete migrated.overrides[from];
        }
        if (migrated.addresses?.[from] !== undefined) {
            if (migrated.addresses[to] === undefined)
                migrated.addresses[to] = migrated.addresses[from];
            delete migrated.addresses[from];
        }
    }
    return migrated;
}

// Rewrite a list of registers onto their resolved addresses. Returns the originals untouched
// when nothing was resolved, so the common case allocates nothing.
export function withResolvedAddresses(
    registers: Register[], selection: Selection | null | undefined
): Register[] {
    const addresses = selection?.addresses;
    if (!addresses)
        return registers;
    return registers.map((register) => {
        const address = addresses[register.name];
        return address === undefined || address === register.address
            ? register
            : {...register, address};
    });
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
