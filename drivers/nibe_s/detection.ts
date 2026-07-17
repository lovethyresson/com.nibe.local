import net from 'net';
import {ModbusTCPClient} from 'jsmodbus';
import {Dir, GroupId, groupIds, Register, registers, toNumericValue} from './registers';

// Samples all registers a few times over ~half a minute and recommends which
// feature groups are worth monitoring: a group whose registers move is clearly
// live, and groups that don't move in such a short window fall back to
// plausibility checks on the values themselves (e.g. a pool temperature stuck
// at exactly 0 usually means there is no pool sensor).

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
}

// Bundle the group recommendations with the per-register sample detail (used by the
// pairing device picker to show which of a device's registers actually had data).
export function buildDetectionResult(probes: ProbeSamples): DetectionResult {
    const samples: Record<string, RegisterSample> = {};
    for (const [name, probe] of Object.entries(probes))
        samples[name] = {read: probe.reads > 0, moved: probe.moved, value: probe.last};
    return {recommendations: recommendGroups(probes), samples};
}

export async function readNumeric(client: ModbusTCPClient, register: Register): Promise<number | undefined> {
    return await ((register.direction === Dir.In)
        ? client.readInputRegisters(register.address, 1)
        : client.readHoldingRegisters(register.address, 1))
        .then((resp: any) => toNumericValue(register, resp.response.body.values[0]))
        .catch(() => undefined);
}

export async function sampleRegisters(
    read: (register: Register) => Promise<number | undefined>,
    onProgress: (pass: number, passes: number) => void,
    passes: number = PROBE_PASSES,
    intervalMs: number = PROBE_INTERVAL_MS
): Promise<ProbeSamples> {
    const probes: ProbeSamples = Object.fromEntries(
        registers.map((register) => [register.name, {reads: 0, moved: false}]));
    for (let pass = 0; pass < passes; ++pass) {
        for (const register of registers) {
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
    return probes;
}

export function recommendGroups(probes: ProbeSamples): Recommendations {
    const value = (name: string) => {
        const probe = probes[name];
        return probe && probe.reads > 0 ? probe.last : undefined;
    };
    const inRange = (name: string, min: number, max: number) => {
        const v = value(name);
        // Exactly 0 is what a missing sensor typically reads, so don't count it
        return v !== undefined && v !== 0 && v > min && v < max;
    };

    // Fallbacks for groups where nothing moved during the sampling window.
    // Heating, diagnostics and statistics apply to every pump, so they default
    // to recommended; the rest depend on optional accessories/sensors.
    const plausible: Record<Exclude<GroupId, "core">, () => boolean> = {
        heating: () => true,
        diagnostics: () => true,
        statistics: () => true,
        // Alarm settings exist on every pump and sit still at 0/1, so they never show
        // "moving" evidence and would otherwise never be recommended.
        alarm: () => true,
        // Carries no registers, so it never reaches this fallback (recommendGroups skips
        // register-less groups) — but the record is total, so it needs an entry.
        energy: () => true,
        hotwater: () =>
            (value("measure_temperature.i8_warmwater_top") ?? 0) > 20
            || (value("measure_temperature.i9_hot_water") ?? 0) > 20,
        pool: () =>
            value("onoff.h691_pool_active") === 1
            || inRange("measure_temperature.i27_pool", 5, 45),
        // The cooling enable register (h182) reads successfully on essentially every
        // S-series pump whether or not cooling hardware is fitted, so it can't confirm
        // cooling support. Only recommend cooling when the pump is actually prioritising
        // cooling during sampling (priority == 60); otherwise it stays available but
        // un-checked, so a pump without cooling doesn't get a false match.
        cooling: () => value("measure_enum_NIBE.i1028_priority") === 60,
        ventilation: () =>
            inRange("measure_temperature.i19_return_air", 5, 40)
            || inRange("measure_temperature.i20_supply_air", -25, 40),
        groundsource: () =>
            inRange("measure_temperature.i10_source_in", -15, 25)
            || inRange("measure_temperature.i11_source_out", -15, 25),
        electrical: () =>
            ["measure_current.i50_sensor_v2", "measure_current.i48_sensor_v2", "measure_current.i46_sensor_v2"]
                .some((name) => (value(name) ?? 0) > 0)
    };

    const recommendations: Recommendations = {};
    for (const groupId of groupIds) {
        const groupProbes = registers
            .filter((register) => register.group === groupId)
            .map((register) => probes[register.name]);
        // A group with no registers (energy) has nothing to detect: leave it out of the
        // recommendations entirely so callers fall back to their "enabled" default.
        // Otherwise every() on the empty array returns true and it reads as unsupported.
        if (groupProbes.length === 0)
            continue;
        let evidence: Evidence;
        if (groupProbes.every((probe) => probe.reads === 0))
            evidence = "unsupported";
        else if (groupProbes.some((probe) => probe.moved))
            evidence = "moving";
        else if (plausible[groupId]())
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

// Standalone probe used during pairing, before any device (and its Modbus
// connection) exists. Opens its own short-lived connection to the pump.
export async function probeHost(
    host: string,
    onProgress: (pass: number, passes: number) => void
): Promise<DetectionResult> {
    const socket = new net.Socket();
    const client = new ModbusTCPClient(socket, 1, 5000);
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
        socket.connect({port: 502, host});
    });
    try {
        const probes = await sampleRegisters((register) => readNumeric(client, register), onProgress);
        return buildDetectionResult(probes);
    } finally {
        socket.removeAllListeners();
        socket.end();
        socket.destroy();
    }
}
