import net from 'net';
import {ModbusTCPClient} from 'jsmodbus';
import {
    Dir, GroupId, groupIds, Register, RegisterInfo, combineRaw, isPlausibleAlt, isPlausibleValue,
    toNumericValue
} from './registers';
import type {ModelProfile} from './profile';

// Samples all registers a few times over ~half a minute and recommends which
// feature groups are worth monitoring: a group whose registers move is clearly
// live, and groups that don't move in such a short window fall back to
// plausibility checks on the values themselves (from the model profile).

export const PROBE_PASSES = 5;
export const PROBE_INTERVAL_MS = 6000;

export interface RegisterProbe {
    reads: number;       // successful reads
    moved: boolean;      // value changed between passes
    last?: number;       // last numeric value (sign+scale applied, enums/bools raw)
}

export type ProbeSamples = Record<string, RegisterProbe>;

export type Evidence = "moving" | "plausible" | "none" | "unsupported";

export interface GroupRecommendation {
    recommended: boolean;
    evidence: Evidence;
}

export type Recommendations = Partial<Record<GroupId, GroupRecommendation>>;

export interface RegisterSample {
    read: boolean;       // was ever read successfully
    moved: boolean;      // value changed during sampling
    value?: number;      // last sampled numeric value
}

// One candidate source for a register that declares `sources`, as offered to the user.
export interface SourceChoice {
    address: number;
    label: RegisterInfo;
    value?: number;      // what it read, so the view can show the user what they're choosing between
}

// Register name → the candidates that actually carried a plausible value on this pump, in
// declared order. A single-candidate entry is kept: it is not a question, but the view still
// states which sensor was picked. "Indoor temperature" is meaningless on a pump that could be
// reading a climate-system average or one wired sensor, and staying silent about it was the
// thing that made pairing confusing.
export type SourceChoices = Record<string, SourceChoice[]>;

export interface DetectionResult {
    recommendations: Recommendations;
    samples: Record<string, RegisterSample>;
    // Register name → the alternate address its value was actually found at. Only registers
    // that relocated appear here; it is stored on the device as part of the selection.
    addresses: Record<string, number>;
    // Register name → the several live candidates the user must choose between. Unlike
    // `addresses` this is a question, not an answer: the view turns each entry into a radio
    // group and the pick lands back in `addresses`.
    choices: SourceChoices;
}

export interface ProbeResult {
    probes: ProbeSamples;
    addresses: Record<string, number>;
    choices: SourceChoices;
}

// The PDU address to put on the wire for a register, applying the model's address offset
// (S = identity; F may subtract a ModbusManager base).
export function pduAddress(register: Register, profile: ModelProfile): number {
    return profile.addressBase ? register.address - profile.addressBase : register.address;
}

// Bundle the group recommendations with the per-register sample detail (used by the
// pairing device picker to show which of a device's registers actually had data).
export function buildDetectionResult(
    profile: ModelProfile,
    probes: ProbeSamples,
    addresses: Record<string, number> = {},
    choices: SourceChoices = {}
): DetectionResult {
    const samples: Record<string, RegisterSample> = {};
    for (const [name, probe] of Object.entries(probes)) {
        // A register that answered with a value outside its declared band counts as not read, so
        // one decision point covers pairing, repair and the per-capability checkboxes alike. This
        // is what stops a pump with no configured room zone being handed a thermostat reading 0 °C.
        const read = probe.reads > 0 && isPlausibleValue(profile.registerByName[name], probe.last);
        samples[name] = {read, moved: probe.moved, value: probe.last};
    }
    return {recommendations: recommendGroups(profile, probes), samples, addresses, choices};
}

export async function readNumeric(
    client: ModbusTCPClient, register: Register, profile: ModelProfile
): Promise<number | undefined> {
    const count = register.size === 32 ? 2 : 1;
    const address = pduAddress(register, profile);
    return await ((register.direction === Dir.In)
        ? client.readInputRegisters(address, count)
        : client.readHoldingRegisters(address, count))
        .then((resp: any) => {
            const raw = combineRaw(resp.response.body.values as number[], register.size);
            // A short or empty value array yields undefined (16-bit) or NaN (32-bit, missing
            // high word). Like the not-available sentinel that toNumericValue screens out,
            // that is a read which carried nothing — not a reading of zero.
            if (raw === undefined || Number.isNaN(raw))
                return undefined;
            return toNumericValue(register, raw);
        })
        .catch(() => undefined);
}

export async function sampleRegisters(
    profile: ModelProfile,
    read: (register: Register) => Promise<number | undefined>,
    onProgress: (pass: number, passes: number) => void,
    passes: number = PROBE_PASSES,
    intervalMs: number = PROBE_INTERVAL_MS
): Promise<ProbeResult> {
    const probes: ProbeSamples = Object.fromEntries(
        profile.registers.map((register) => [register.name, {reads: 0, moved: false}]));
    for (let pass = 0; pass < passes; ++pass) {
        for (const register of profile.registers) {
            const value = await read(register);
            if (value === undefined)
                continue;
            const probe = probes[register.name];
            if (probe.reads > 0 && probe.last !== value)
                probe.moved = true;
            probe.reads += 1;
            probe.last = value;
        }
        onProgress(pass + 1, passes);
        if (pass < passes - 1)
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    // Sources first: a register that declares them has its own address among the candidates, so
    // resolving them can populate a probe that the sampling run left empty, and resolveAlternates
    // must see that before deciding the primary "produced nothing at all".
    const sources = await resolveSources(profile, read, probes);
    const alternates = await resolveAlternates(profile, read, probes);
    return {probes, addresses: {...sources.addresses, ...alternates}, choices: sources.choices};
}

// Probe every candidate a `sources` register declares and keep the ones carrying a plausible
// value. Unlike resolveAlternates this runs whatever the primary did, because the question isn't
// "did the primary fail" but "is there more than one true answer on this pump".
//
// Returns two different things, and conflating them is a bug worth naming:
//   - `addresses` — the first live candidate, recorded for EVERY register with at least one. This
//     is what the runtime reads. It matters most in the single-candidate case: an S735 where the
//     primary 116 is dead and only 26 answers has no choice to offer, but still must not go on
//     reading 116.
//   - `choices` — every register with at least one live candidate. Two or more is a question and
//     the view renders a radio group; exactly one is an answer, and the view states it as plain
//     text rather than as a control nobody can change.
async function resolveSources(
    profile: ModelProfile,
    read: (register: Register) => Promise<number | undefined>,
    probes: ProbeSamples
): Promise<{addresses: Record<string, number>; choices: SourceChoices}> {
    const addresses: Record<string, number> = {};
    const choices: SourceChoices = {};
    for (const register of profile.registers) {
        if (!register.sources?.length)
            continue;
        const live: SourceChoice[] = [];
        for (const source of register.sources) {
            const value = await read({...register, address: source.address});
            if (isPlausibleAlt(register, value))
                live.push({address: source.address, label: source.label, value});
        }
        if (!live.length)
            continue;
        addresses[register.name] = live[0].address;
        // Fold the winning read into the probe, exactly as resolveAlternates does: without it a
        // register whose own address is dead reads as "no data" and the capability is dropped
        // during pairing, so the choice would never reach the user.
        const probe = probes[register.name];
        if (probe && probe.reads === 0) {
            probe.reads = 1;
            probe.last = live[0].value;
        }
        choices[register.name] = live;
    }
    return {addresses, choices};
}

// Try the declared alternates for any register whose own address produced nothing usable
// across the whole sampling run, and record the first that reads inside the register's
// plausibility band.
//
// The trigger is deliberately "the primary never read at all", which covers both a register
// the model doesn't implement (no answer) and one it implements but leaves empty (the
// not-available sentinel, which toNumericValue already turns into undefined). A primary that
// answers with a real value is never second-guessed, so a model where nothing moved cannot
// regress.
//
// Runs once after sampling rather than inside the pass loop: one extra read per alternate per
// pairing, and only for the handful of registers that declare any.
async function resolveAlternates(
    profile: ModelProfile,
    read: (register: Register) => Promise<number | undefined>,
    probes: ProbeSamples
): Promise<Record<string, number>> {
    const addresses: Record<string, number> = {};
    for (const register of profile.registers) {
        const probe = probes[register.name];
        if (!register.altAddresses?.length || !probe || probe.reads > 0)
            continue;
        for (const address of register.altAddresses) {
            const value = await read({...register, address});
            if (!isPlausibleAlt(register, value))
                continue;
            addresses[register.name] = address;
            // Fold the successful read into the probe. Without this the capability is dropped
            // as "no data" during pairing and the fallback never gets used at runtime — the
            // reason a fresh pair on an S735 lost its room-temperature tile even though the
            // value was sitting at a readable address the whole time.
            probe.reads = 1;
            probe.last = value;
            break;
        }
    }
    return addresses;
}

export function recommendGroups(profile: ModelProfile, probes: ProbeSamples): Recommendations {
    const value = (name: string) => {
        const probe = probes[name];
        return probe && probe.reads > 0 ? probe.last : undefined;
    };
    const inRange = (name: string, min: number, max: number) => {
        const v = value(name);
        // Exactly 0 is what a missing sensor typically reads, so don't count it
        return v !== undefined && v !== 0 && v > min && v < max;
    };
    const helpers = {value, inRange};

    const recommendations: Recommendations = {};
    for (const groupId of groupIds) {
        const groupProbes = profile.registers
            .filter((register) => register.group === groupId)
            .map((register) => probes[register.name]);
        // A group with no registers has nothing to detect: leave it out of the
        // recommendations entirely so callers fall back to their "enabled" default.
        // Otherwise every() on the empty array returns true and it reads as unsupported.
        if (groupProbes.length === 0)
            continue;
        const plausible = profile.detection.plausible[groupId];
        let evidence: Evidence;
        if (groupProbes.every((probe) => probe.reads === 0))
            evidence = "unsupported";
        else if (groupProbes.some((probe) => probe.moved))
            evidence = "moving";
        else if (plausible && plausible(helpers))
            evidence = "plausible";
        else
            evidence = "none";
        recommendations[groupId] = {
            recommended: evidence === "moving" || evidence === "plausible",
            evidence
        };
    }
    return recommendations;
}

// Standalone probe used during pairing, before any device (and its Modbus connection)
// exists. Opens its own short-lived connection to the pump on the given transport.
export async function probeHost(
    profile: ModelProfile,
    host: string,
    transport: {port: number; unitId: number},
    onProgress: (pass: number, passes: number) => void
): Promise<DetectionResult> {
    const socket = new net.Socket();
    const client = new ModbusTCPClient(socket, transport.unitId, 5000);
    await new Promise<void>((resolve, reject) => {
        socket.setTimeout(10000, () => {
            socket.destroy();
            reject(new Error(`Connection to ${host} timed out`));
        });
        socket.once('connect', () => {
            socket.setTimeout(0);
            resolve();
        });
        socket.once('error', (error) => reject(error));
        socket.connect({port: transport.port, host});
    });
    try {
        const {probes, addresses, choices} = await sampleRegisters(
            profile, (register) => readNumeric(client, register, profile), onProgress);
        return buildDetectionResult(profile, probes, addresses, choices);
    } finally {
        socket.removeAllListeners();
        socket.end();
        socket.destroy();
    }
}
