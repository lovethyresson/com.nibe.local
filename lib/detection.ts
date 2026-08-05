import net from 'net';
import {ModbusTCPClient} from 'jsmodbus';
import {Dir, GroupId, groupIds, Register, combineRaw, isPlausibleAlt, isPlausibleValue,
    toNumericValue} from './registers';
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

export interface DetectionResult {
    recommendations: Recommendations;
    samples: Record<string, RegisterSample>;
    // Register name → the alternate address its value was actually found at. Only registers
    // that relocated appear here; it is stored on the device as part of the selection.
    addresses: Record<string, number>;
}

export interface ProbeResult {
    probes: ProbeSamples;
    addresses: Record<string, number>;
}

// The PDU address to put on the wire for a register, applying the model's address offset
// (S = identity; F may subtract a ModbusManager base).
export function pduAddress(register: Register, profile: ModelProfile): number {
    return profile.addressBase ? register.address - profile.addressBase : register.address;
}

// Bundle the group recommendations with the per-register sample detail (used by the
// pairing device picker to show which of a device's registers actually had data).
export function buildDetectionResult(
    profile: ModelProfile, probes: ProbeSamples, addresses: Record<string, number> = {}
): DetectionResult {
    const samples: Record<string, RegisterSample> = {};
    for (const [name, probe] of Object.entries(probes)) {
        // A register that answered with a value outside its declared band counts as not read, so
        // the one decision point covers pairing, repair and the per-capability checkboxes alike.
        const read = probe.reads > 0 && isPlausibleValue(profile.registerByName[name], probe.last);
        samples[name] = {read, moved: probe.moved, value: probe.last};
    }
    return {recommendations: recommendGroups(profile, probes), samples, addresses};
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
    return {probes, addresses: await resolveAlternates(profile, read, probes)};
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
        const {probes, addresses} = await sampleRegisters(
            profile, (register) => readNumeric(client, register, profile), onProgress);
        return buildDetectionResult(profile, probes, addresses);
    } finally {
        socket.removeAllListeners();
        socket.end();
        socket.destroy();
    }
}
