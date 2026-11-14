/** The heat pump during pairing, before any device exists: a short connection of its own, like
 *  detection's (detection.ts probeHost), for Smart mode's facts and Autopilot heating's Verify.
 *  Pairing sets Autopilot up for real, so Verify here does what Repair's does on a device
 *  (device.ts activateAutopilotHeating): SPA heating off, the outdoor temperature fed to BT1, and
 *  input 1 seen to follow it. Every write it makes is listed so an abandoned pairing can undo it. */
import * as net from 'net';
import {ModbusTCPClient} from 'jsmodbus';
import type {ModelProfile} from './profile';
import {Register, combineRaw, encodeRegisterValue, isUnavailableRaw} from './registers';
import {pduAddress, readNumeric} from './detection';
import {smartModeWrites} from './autopilot/smart-mode';
import {VERIFY_GAP_MS, VERIFY_TRIES} from './autopilot/live';

export interface PumpTransport {
    port: number;
    unitId: number;
    addressBase?: number;
}

export interface PairPump {
    read(name: string): Promise<number | undefined>;
    /** A holding register by address, raw (room-sensor control 2978 has no table entry). */
    readHoldingRaw(address: number): Promise<number | undefined>;
    write(name: string, value: unknown): Promise<void>;
}

/** Open the pump, run `job`, close. */
export async function withPump<T>(profile: ModelProfile, host: string, transport: PumpTransport,
    job: (pump: PairPump) => Promise<T>): Promise<T> {
    const socket = new net.Socket();
    const client = new ModbusTCPClient(socket, transport.unitId, 5000);
    const wire = {...profile, addressBase: transport.addressBase ?? profile.addressBase};
    const register = (name: string): Register => {
        const r = profile.registerByName[name];
        if (!r) throw new Error(`Unknown register ${name}`);
        return r;
    };
    try {
        await new Promise<void>((resolve, reject) => {
            socket.setTimeout(10000, () => { socket.destroy(); reject(new Error(`Connection to ${host} timed out`)); });
            socket.once('connect', () => { socket.setTimeout(0); resolve(); });
            socket.once('error', reject);
            socket.connect({port: transport.port, host});
        });
        return await job({
            read: (name) => readNumeric(client, register(name), wire),
            readHoldingRaw: async (address) => {
                const resp: any = await client.readHoldingRegisters(address - (wire.addressBase ?? 0), 1).catch(() => undefined);
                const raw = resp ? combineRaw(resp.response.body.values as number[], 16) : undefined;
                return raw === undefined || Number.isNaN(raw) || isUnavailableRaw(raw) ? undefined : raw;
            },
            write: async (name, value) => {
                const r = register(name);
                const raw = encodeRegisterValue(r, value);
                const pdu = pduAddress(r, wire);
                // Word order as the device's own write path (connection.ts writeRegisterValue).
                if (r.size === 32) await client.writeMultipleRegisters(pdu, [Math.floor(raw / 65536), raw % 65536]);
                else if (profile.singleWordWriteFunction === 16) await client.writeMultipleRegisters(pdu, [raw]);
                else await client.writeSingleRegister(pdu, raw);
            },
        });
    } finally {
        socket.on('error', () => {});
        socket.destroy();
    }
}

/** Room-sensor control for climate system 1, the low byte of 2978: any non-zero is on. */
export async function readRoomControl(pump: PairPump, profile: ModelProfile): Promise<number | undefined> {
    const address = profile.autopilotFeed?.roomControl;
    if (address === undefined) return undefined;
    const raw = await pump.readHoldingRaw(address);
    return raw === undefined ? undefined : raw & 0xff;
}

export class VerifyError extends Error {
    constructor(readonly reason: 'room_control' | 'not_followed' | 'no_outdoor') { super(reason); }
}

/** Autopilot heating's Verify, on the pump during pairing. `real` is the outdoor temperature
 *  Autopilot will feed (the owner's sensor), or undefined for the pump's own BT1 now. Returns the
 *  fed value and the writes to undo if pairing is abandoned. A fed value equal to what the pump
 *  already shows proves nothing, so it is first offset by 0.5 K and seen to move. */
export async function verifyOnPump(pump: PairPump, profile: ModelProfile, real: number | undefined,
    sleep: (ms: number) => Promise<void>): Promise<{fed: number; undo: [string, boolean][]}> {
    const spec = profile.autopilotFeed!;
    if (((await readRoomControl(pump, profile)) ?? 0) !== 0) throw new VerifyError('room_control');
    const shown = await pump.read(spec.outdoor);
    const outdoor = real ?? shown;
    if (outdoor === undefined || !Number.isFinite(outdoor)) throw new VerifyError('no_outdoor');
    const fed = Math.round(outdoor * 10) / 10;
    const undo: [string, boolean][] = [];
    const spa = profile.spaSwitches;
    try {
        if (spa) for (const [name, want] of smartModeWrites('heating', 'autopilot', spa)) {
            const now = await pump.read(name);
            if (now !== undefined && now !== 0 && want === false) {
                await pump.write(name, false);
                undo.push([name, true]);
            }
        }
        const see = async (value: number) => {
            await pump.write(spec.bt1, value);
            for (let i = 0; i < VERIFY_TRIES; i++) {
                await sleep(VERIFY_GAP_MS);
                const seen = await pump.read(spec.outdoor);
                if (seen !== undefined && Math.abs(seen - value) < 0.05) return;
            }
            throw new VerifyError('not_followed');
        };
        if (shown !== undefined && Math.abs(shown - fed) < 0.25) await see(Math.round((fed + 0.5) * 10) / 10);
        await see(fed);
        return {fed, undo};
    } catch (error) {
        for (const [name, value] of undo) await pump.write(name, value).catch(() => undefined);
        throw error;
    }
}

/** Put back what Verify changed, when pairing ends without a Heating device. */
export async function undoOnPump(pump: PairPump, undo: [string, boolean][]): Promise<void> {
    for (const [name, value] of undo) await pump.write(name, value);
}

