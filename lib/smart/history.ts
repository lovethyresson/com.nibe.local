/** 15-minute history of what the house model learns from. Pure: no timers, no I/O.
 *  Design: docs/smart-heating-plan.md §5.4. */
import {SLOT_MS, slotOf} from './prices';

/** Per-slot fields, in storage order. Appending is safe (a file with fewer fields loads with the
 *  new ones missing); reordering needs a VERSION bump. */
export const FIELDS = [
    'ti',      // indoor °C (mean)
    'te',      // outdoor °C, input 1 (mean); while BT1 is fed from elsewhere, the forecast (FLAG.fedOutdoor)
    'tsup',    // supply °C (mean)
    'tret',    // return °C (mean)
    'tcalc',   // calculated supply °C (mean)
    'tbrine',  // brine in °C (mean)
    'hz',      // compressor Hz (mean)
    'dm',      // degree minutes (mean)
    'pw',      // electrical power W (mean); kWh = pw × 0.25 / 1000
    'qmeter',  // produced heat for heating, kWh counter (last)
    'emeter',  // consumed electricity, kWh counter (last)
    'dhw',     // fraction of polls with hot water priority
    'aux',     // fraction of polls with the immersion heater on
    'price',   // all-in price per kWh (see FLAG.costs)
    'spot',    // spot price per kWh
    'gtiS',    // south-wall irradiance W/m²
    'ghi',     // horizontal irradiance W/m²
    'wind',    // m/s
    'rh',      // %
    'cloud',   // %
    'coverage', // polls received / polls expected
    'flags',
    'gtiE',    // east-wall irradiance W/m² (solar.ts)
    'gtiW',    // west-wall irradiance W/m²
] as const;
export type Field = typeof FIELDS[number];
export const FLAG = {partial: 1, reconnect: 2, costs: 4, fedOutdoor: 8} as const;
/** Input 1 further than this from the corrected forecast is a fed BT1, not the weather: a probe,
 *  a Flow card, another app. Forecast error after the per-hour correction is ~1–2 K; a fed
 *  offset worth testing is ≥ 5 K. */
export const FED_OUTDOOR_K = 3;

const LAST: ReadonlySet<Field> = new Set(['qmeter', 'emeter']);
export const PARTIAL_BELOW = 0.8;
export const CAPACITY = 28 * 96;
const MAGIC = 0x4e534831; // "NSH1"
export const VERSION = 1;

export type Sample = Partial<Record<'ti' | 'te' | 'tsup' | 'tret' | 'tcalc' | 'tbrine' | 'hz' | 'dm' | 'pw'
    | 'qmeter' | 'emeter', number>> & {dhw?: boolean; aux?: boolean};

export interface SlotContext {
    price?: {price: number; spot: number; costsApplied: boolean};
    weather?: {gtiS: number; gtiE: number; gtiW: number; ghi: number; wind: number; rh: number; cloud: number};
    /** The forecast's outdoor °C for the slot, corrected by what the wired sensor taught. */
    outdoor?: number;
}

/** Ring buffer of closed slots. Missing values are NaN. */
export class History {
    readonly slots: Uint32Array;
    readonly data: Float32Array;

    constructor(readonly capacity = CAPACITY) {
        this.slots = new Uint32Array(capacity);
        this.data = new Float32Array(capacity * FIELDS.length).fill(NaN);
    }

    put(slot: number, values: Record<Field, number>) {
        const i = slot % this.capacity;
        this.slots[i] = slot;
        FIELDS.forEach((field, f) => { this.data[i * FIELDS.length + f] = values[field]; });
    }

    get(slot: number): Record<Field, number> | undefined {
        const i = slot % this.capacity;
        if (this.slots[i] !== slot || slot === 0) return undefined;
        return Object.fromEntries(FIELDS.map((field, f) => [field, this.data[i * FIELDS.length + f]])) as Record<Field, number>;
    }

    /** Stored slots in time order. */
    range(): number[] {
        return [...this.slots].filter((s) => s > 0).sort((a, b) => a - b);
    }

    serialize(): Buffer {
        const header = Buffer.alloc(12);
        header.writeUInt32BE(MAGIC, 0);
        header.writeUInt8(VERSION, 4);
        header.writeUInt8(FIELDS.length, 5);
        header.writeUInt32BE(this.capacity, 8);
        return Buffer.concat([header, Buffer.from(this.slots.buffer, this.slots.byteOffset, this.slots.byteLength),
            Buffer.from(this.data.buffer, this.data.byteOffset, this.data.byteLength)]);
    }

    /** Fields per slot in a saved file, or undefined when this version can't read it. */
    static fieldCount(buffer: Buffer): number | undefined {
        if (buffer.length < 12 || buffer.readUInt32BE(0) !== MAGIC || buffer.readUInt8(4) !== VERSION) return undefined;
        const count = buffer.readUInt8(5);
        return count > 0 && count <= FIELDS.length ? count : undefined;
    }

    /** Undefined for anything this version can't read: the caller starts a new history. A file
     *  from before a field was appended loads with that field missing. */
    static deserialize(buffer: Buffer): History | undefined {
        const count = History.fieldCount(buffer);
        if (count === undefined) return undefined;
        const capacity = buffer.readUInt32BE(8);
        if (buffer.length !== 12 + capacity * 4 * (1 + count)) return undefined;
        const history = new History(capacity);
        const copy = Uint8Array.prototype.slice.call(buffer, 12);
        history.slots.set(new Uint32Array(copy.buffer, 0, capacity));
        const stored = new Float32Array(copy.buffer, capacity * 4, capacity * count);
        if (count === FIELDS.length) history.data.set(stored);
        else for (let i = 0; i < capacity; i++)
            history.data.set(stored.subarray(i * count, (i + 1) * count), i * FIELDS.length);
        return history;
    }
}

/** One closed slot as a journal record: slot (u32 BE) then the fields (f32 BE). Slots closed
 *  since the last full save are appended as these, so a process killed without `onUninit`
 *  (an app install does that) loses only the open slot, without rewriting the whole file every
 *  15 minutes. */
export const RECORD_BYTES = 4 + 4 * FIELDS.length;

export function encodeRecord(slot: number, values: Record<Field, number>): Buffer {
    const out = Buffer.alloc(RECORD_BYTES);
    out.writeUInt32BE(slot, 0);
    FIELDS.forEach((field, f) => out.writeFloatBE(values[field], 4 + 4 * f));
    return out;
}

/** Replay a journal into a history; a torn last record is ignored. Returns records applied.
 *  `fields` is how many fields the writer had: the saved file's count, since every start saves
 *  before it journals (`SmartCollector.start`). */
export function applyJournal(history: History, journal: Buffer, fields: number = FIELDS.length): number {
    const bytes = 4 + 4 * fields;
    let applied = 0;
    for (let at = 0; at + bytes <= journal.length; at += bytes) {
        const slot = journal.readUInt32BE(at);
        if (slot === 0) continue;
        const values = Object.fromEntries(FIELDS.map((field, f) => [field, f < fields ? journal.readFloatBE(at + 4 + 4 * f) : NaN]));
        history.put(slot, values as Record<Field, number>);
        applied++;
    }
    return applied;
}

/** Collects poll samples into the open slot and closes it into a History when time moves on. */
export class Aggregator {
    private slot: number | undefined;
    private sums = new Map<string, number>();
    private counts = new Map<string, number>();
    private last = new Map<string, number>();
    private polls = 0;
    private flags = 0;

    constructor(private readonly history: History, private readonly context: (slot: number) => SlotContext,
                private readonly onClose?: (slot: number, values: Record<Field, number>) => void) {}

    /** One completed poll. `pollSeconds` sets how many polls a full slot expects. */
    sample(now: number, pollSeconds: number, sample: Sample) {
        const slot = slotOf(now);
        if (this.slot !== undefined && slot !== this.slot) this.close(pollSeconds);
        this.slot = slot;
        this.polls++;
        for (const [key, value] of Object.entries(sample)) {
            const v = typeof value === 'boolean' ? Number(value) : value;
            if (typeof v !== 'number' || !Number.isFinite(v)) continue;
            if (LAST.has(key as Field)) this.last.set(key, v);
            else {
                this.sums.set(key, (this.sums.get(key) ?? 0) + v);
                this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
            }
        }
    }

    /** The connection dropped or came back: the open slot can't be complete. */
    markReconnect() {
        this.flags |= FLAG.reconnect | FLAG.partial;
    }

    /** Close the open slot early (shutdown), as partial. */
    flush(pollSeconds: number) {
        if (this.slot === undefined) return;
        this.flags |= FLAG.partial;
        this.close(pollSeconds);
        this.slot = undefined;
    }

    private close(pollSeconds: number) {
        const slot = this.slot!;
        const values = Object.fromEntries(FIELDS.map((f) => [f, NaN])) as Record<Field, number>;
        for (const [key, sum] of this.sums) values[key as Field] = sum / this.counts.get(key)!;
        for (const [key, v] of this.last) values[key as Field] = v;
        const expected = SLOT_MS / 1000 / Math.max(1, pollSeconds);
        values.coverage = Math.min(1, this.polls / expected);
        let flags = this.flags;
        if (values.coverage < PARTIAL_BELOW) flags |= FLAG.partial;
        const {price, weather, outdoor} = this.context(slot);
        // Input 1 shows whatever BT1 is fed. The house model wants the real outdoor temperature.
        if (outdoor !== undefined && Number.isFinite(outdoor) && Math.abs(values.te - outdoor) > FED_OUTDOOR_K) {
            values.te = outdoor;
            flags |= FLAG.fedOutdoor;
        }
        if (price) {
            values.price = price.price;
            values.spot = price.spot;
            if (price.costsApplied) flags |= FLAG.costs;
        }
        if (weather) Object.assign(values, weather);
        values.flags = flags;
        this.history.put(slot, values);
        this.onClose?.(slot, values);
        this.sums.clear(); this.counts.clear(); this.last.clear();
        this.polls = 0;
        this.flags = 0;
    }
}
