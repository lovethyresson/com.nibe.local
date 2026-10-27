import http from 'http';
import net from 'net';
import os from 'os';
import tls from 'tls';
import {Dir} from './registers';
import {ModbusTCPClient} from 'jsmodbus';

// Modbus TCP has no discovery protocol, and Nibe pumps don't announce themselves
// via mDNS/SSDP, so pairing "discovery" is a sweep of the local subnet for an open
// Modbus port. Every responder is verified by reading the model's probe register
// (outdoor temperature) — a plausible answer means it is almost certainly the pump, and
// the value doubles as a recognizable label in the pairing UI. Requires the Modbus port
// to be reachable and Homey to be on the same subnet; manual IP entry remains the fallback.

// Largest subnet we're willing to sweep. A /24 is 254 hosts; /22 is ~1022. Below
// that (e.g. a /16 with 65k hosts) a full sweep would take far too long, so we
// clamp to the /24 around Homey's own address.
const MAX_PREFIX_HOSTS = 1024;
const CLAMP_PREFIX = 24;

export interface DiscoveredPump {
    address: string;
    outdoorTemperature?: number;
    // The model code read from `identityAddress`, when one was asked for and answered.
    identity?: number;
}

// The Modbus transport + probe register to verify a responder is a pump. `probeAddress`
// is the on-the-wire PDU address (the caller applies any model address offset).
export interface DiscoveryOptions {
    direction?: Dir;
    port: number;
    unitId: number;
    probeAddress: number;
    scale: number;
    min: number;
    max: number;
    // An input register (PDU address) that identifies the model, read from every responder that
    // passes the probe. Used when looking for a pump that moved, never during pairing.
    identityAddress?: number;
    // An input register (PDU address) read only when the probe answers 0xFFFF. -0.1 °C is a
    // real outdoor temperature, but a responder that also answers 0xFFFF here is answering
    // all-ones to everything — a gateway with nothing behind it, not a pump.
    confirmAddress?: number;
}

// Which responder is the pump that went missing, if that can be told at all. Nothing on the wire
// identifies one particular pump — there is no serial — so the model code is the only evidence,
// and anything but exactly one match is ambiguous. Ambiguous means leave the devices alone:
// moving them to the wrong pump is far worse than asking the user to type an address.
export function choosePumpCandidate(found: DiscoveredPump[], modelCode?: number):
    {pick?: DiscoveredPump; matches: DiscoveredPump[]} {
    const matches = modelCode === undefined ? found : found.filter((pump) => pump.identity === modelCode);
    return {pick: matches.length === 1 ? matches[0] : undefined, matches};
}

const CONNECT_TIMEOUT_MS = 750;
const READ_TIMEOUT_MS = 2000;
const BATCH_SIZE = 51; // 254 hosts / 51 ≈ 5 progress updates

export async function tryHost(host: string, options: DiscoveryOptions): Promise<DiscoveredPump | null> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        // The client must be constructed before connecting: jsmodbus marks itself
        // connected by catching the socket's 'connect' event, so a client created
        // inside the connect handler never registers as connected and every read
        // fails with "no connection to modbus server".
        const client = new ModbusTCPClient(socket, options.unitId, READ_TIMEOUT_MS);
        let settled = false;
        const finish = (result: DiscoveredPump | null) => {
            if (settled)
                return;
            settled = true;
            socket.removeAllListeners();
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish(null));
        socket.once('error', () => finish(null));
        socket.once('connect', () => {
            socket.setTimeout(0);
            (options.direction === Dir.Out
                ? client.readHoldingRegisters(options.probeAddress, 1)
                : client.readInputRegisters(options.probeAddress, 1))
                .then(async (resp: any) => {
                    let raw = resp.response.body.values[0];
                    if (raw === 0xFFFF && options.confirmAddress !== undefined) {
                        const confirm = await client.readInputRegisters(options.confirmAddress, 1)
                            .then((r: any) => r.response.body.values[0], () => undefined);
                        if (confirm === undefined || confirm === 0xFFFF)
                            return finish(null);
                    }
                    if (raw >= 32768)
                        raw -= 65536;
                    const temperature = raw / options.scale;
                    // Anything with the Modbus port open that answers this read is Modbus,
                    // but only a sane outdoor temperature makes it a likely Nibe.
                    if (!(temperature > options.min && temperature < options.max))
                        return finish(null);
                    const pump: DiscoveredPump = {address: host, outdoorTemperature: temperature};
                    if (options.identityAddress === undefined)
                        return finish(pump);
                    // A pump whose model code does not read stays a candidate, without one.
                    client.readInputRegisters(options.identityAddress, 1)
                        .then((id: any) => finish({...pump, identity: id.response.body.values[0]}))
                        .catch(() => finish(pump));
                })
                .catch(() => finish(null));
        });
        socket.connect({port: options.port, host});
    });
}

const ipToInt = (ip: string): number =>
    ip.split('.').reduce((acc, octet) => ((acc << 8) + parseInt(octet, 10)) >>> 0, 0);

const intToIp = (n: number): string =>
    [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join('.');

const netmaskToPrefix = (netmask: string): number => {
    const int = ipToInt(netmask);
    let prefix = 0;
    for (let bit = 31; bit >= 0; --bit) {
        if ((int >>> bit) & 1)
            prefix += 1;
        else
            break;
    }
    return prefix;
};

// The CIDR prefix of Homey's own IPv4 interface, so we sweep the real subnet
// rather than assuming /24. Returns undefined if it can't be determined.
function prefixForLocalIp(localIp: string): number | undefined {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const info of interfaces[name] ?? []) {
            if ((info.family === 'IPv4' || (info.family as any) === 4) && info.address === localIp) {
                if (info.cidr)
                    return parseInt(info.cidr.split('/')[1], 10);
                if (info.netmask)
                    return netmaskToPrefix(info.netmask);
            }
        }
    }
    return undefined;
}

// The list of scannable host addresses for the subnet localIp sits in, honouring
// the detected netmask but clamping oversized subnets to a /24 around localIp.
function subnetHosts(localIp: string): string[] {
    const ipInt = ipToInt(localIp);
    const detected = prefixForLocalIp(localIp);
    let prefix = detected ?? CLAMP_PREFIX;
    if (prefix < 1 || prefix > 32)
        prefix = CLAMP_PREFIX;
    // Clamp anything with more than MAX_PREFIX_HOSTS usable hosts.
    const clamped = (2 ** (32 - prefix)) - 2 > MAX_PREFIX_HOSTS;
    if (clamped)
        prefix = CLAMP_PREFIX;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const network = (ipInt & mask) >>> 0;
    const broadcast = (network | (~mask >>> 0)) >>> 0;
    const hosts: string[] = [];
    for (let h = network + 1; h < broadcast; ++h)
        hosts.push(intToIp(h >>> 0));
    console.log(`${new Date().toISOString()} [discovery] local ${localIp}, detected prefix ${detected ?? 'unknown'}`
        + `${clamped ? ` (clamped to /${prefix})` : ''}; scanning ${intToIp(network)}/${prefix}`
        + ` — ${hosts.length} hosts (${hosts[0]}…${hosts[hosts.length - 1]})`);
    return hosts;
}

export async function discoverPumps(
    localAddress: string,
    exclude: Set<string>,
    options: DiscoveryOptions,
    onProgress?: (done: number, total: number) => void
): Promise<DiscoveredPump[]> {
    // localAddress from ManagerCloud.getLocalAddress() looks like "192.168.1.5:80".
    const localIp = localAddress.split(':')[0];
    const hosts = subnetHosts(localIp).filter((host) => host !== localIp && !exclude.has(host));
    const found: DiscoveredPump[] = [];
    for (let i = 0; i < hosts.length; i += BATCH_SIZE) {
        const batch = hosts.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map((host) => tryHost(host, options)));
        for (const result of results)
            if (result)
                found.push(result);
        onProgress?.(Math.min(i + BATCH_SIZE, hosts.length), hosts.length);
    }
    return found;
}

// ---------------------------------------------------------------------------------------------
// The no-data diagnostic. A responder that answers 0xFFFF to everything (see isAllOnesResponse)
// cannot be diagnosed from the poll alone: it says nothing about what it is, and the user can
// only tell us "yes, that's the pump's IP". So, once, look around and put it in the log: the
// same reads under other unit IDs (a gateway routes on the unit ID), which other ports that
// host has open and what its web page calls itself, and every Modbus responder on the subnet
// with what it answers — the real pump at another address shows up there with a model code.

const DIAG_UNIT_IDS = [0, 1, 2, 3, 100, 255];
const DIAG_PORTS = [80, 443, 8443];
const HTTP_TIMEOUT_MS = 2000;

export interface InspectOptions {
    port: number;
    unitId: number;
    // Input registers (PDU addresses) to read, in order.
    addresses: number[];
}

// A read's answer as the log shows it: the raw value in hex, or why there was none.
export function describeRead(result: {raw?: number; error?: any}): string {
    if (result.raw !== undefined)
        return `0x${result.raw.toString(16).toUpperCase().padStart(4, '0')}`;
    const error = result.error;
    const code = error?.response?.body?.code;
    if (code !== undefined)
        return `exception ${code}`;
    return String(error?.err ?? error?.message ?? error ?? 'no answer').toLowerCase();
}

// Connect to one host and read every address, keeping every answer — unlike tryHost, which only
// wants to know whether this is a pump. Null when nothing accepts the connection.
export async function inspectHost(host: string, options: InspectOptions): Promise<string[] | null> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        // Constructed before connecting; see tryHost.
        const client = new ModbusTCPClient(socket, options.unitId, READ_TIMEOUT_MS);
        let settled = false;
        const finish = (result: string[] | null) => {
            if (settled)
                return;
            settled = true;
            socket.removeAllListeners();
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish(null));
        socket.on('error', () => finish(null));
        socket.once('connect', async () => {
            socket.setTimeout(0);
            const answers: string[] = [];
            for (const address of options.addresses) {
                const result = await client.readInputRegisters(address, 1)
                    .then((resp: any) => {
                        const raw: number | undefined = resp.response.body.values[0];
                        return raw === undefined ? {error: 'empty answer'} : {raw};
                    }, (error: any) => ({error}));
                answers.push(`in${address}=${describeRead(result)}`);
                if (settled)
                    return;
            }
            finish(answers);
        });
        socket.connect({port: options.port, host});
    });
}

function portOpen(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        const finish = (open: boolean) => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(open);
        };
        socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish(false));
        socket.once('error', () => finish(false));
        socket.once('connect', () => finish(true));
        socket.connect({port, host});
    });
}

// What the host's web page on port 80 says about itself: status, Server header and <title>.
// A Modbus gateway almost always has a setup page that names it.
function httpIdentity(host: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        let body = '';
        const request = http.get({host, port: 80, path: '/', timeout: HTTP_TIMEOUT_MS}, (response) => {
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => {
                body += chunk;
                if (body.length > 16_384)
                    response.destroy();
            });
            const done = () => {
                const title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1]?.trim().slice(0, 80);
                const server = response.headers.server;
                resolve(`HTTP ${response.statusCode}${server ? ` server "${server}"` : ''}`
                    + `${title ? ` title "${title}"` : ''}`);
            };
            response.once('end', done);
            response.once('close', done);
        });
        request.once('timeout', () => request.destroy());
        request.once('error', () => resolve(undefined));
    });
}

// Function 17, Report Server ID. Nibe ignores function 43 (Read Device Identification, exception
// 1) but answers this one: a server ID byte, a run indicator and the controller's name — an S1155
// says `0xB4, running, "LMB3.1.11"`. Anything else answering is not a Nibe. jsmodbus has no
// function 17, so the frame is written by hand.
export function describeServerId(pdu: Buffer): string {
    if (pdu[0] === 0x91)
        return `exception ${pdu[1]}`;
    if (pdu[0] !== 0x11 || pdu.length < 2)
        return `unexpected answer ${pdu.toString('hex')}`;
    const data = pdu.subarray(2, 2 + pdu[1]);
    if (data.length >= 2 && (data[1] === 0x00 || data[1] === 0xFF)) {
        const text = data.subarray(2).toString('latin1').replace(/[^\x20-\x7E]/g, '');
        return `0x${data[0].toString(16).toUpperCase().padStart(2, '0')}, `
            + `${data[1] === 0xFF ? 'running' : 'not running'}${text ? `, "${text}"` : ''}`;
    }
    return `0x${data.toString('hex').toUpperCase()}`;
}

export function reportServerId(host: string, port: number, unitId: number): Promise<string> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let received = Buffer.alloc(0);
        const finish = (result: string) => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(READ_TIMEOUT_MS, () => finish('no answer'));
        socket.once('error', (error: any) => finish(String(error?.code ?? error?.message ?? error).toLowerCase()));
        socket.once('connect', () =>
            // MBAP header: transaction 1, protocol 0, length 2 (unit + function), unit, then FC 17.
            socket.write(Buffer.from([0, 1, 0, 0, 0, 2, unitId & 0xFF, 0x11])));
        socket.on('data', (chunk: Buffer) => {
            received = Buffer.concat([received, chunk]);
            // The MBAP length field counts the unit byte and the PDU.
            if (received.length >= 6 && received.length >= 6 + received.readUInt16BE(4))
                finish(describeServerId(received.subarray(7, 6 + received.readUInt16BE(4))));
        });
        socket.connect({port, host});
    });
}

// A certificate subject as one line, the way openssl prints it: "O=NIBE, CN=06544319324004".
export function describeSubject(subject: {[key: string]: string | string[] | undefined} | undefined): string {
    const parts = Object.entries(subject ?? {})
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('+') : value}`);
    return parts.length ? parts.join(', ') : 'no subject';
}

// The subject of the TLS certificate on `port`. A Nibe S pump with its local REST API on serves
// one on 8443 issued by NIBE, with the serial number as the common name. Not verified: the point
// is what the certificate says, and it is self-signed anyway.
export function tlsSubject(host: string, port: number): Promise<string | undefined> {
    return new Promise((resolve) => {
        const socket = tls.connect({host, port, rejectUnauthorized: false,
            servername: net.isIP(host) ? undefined : host});
        const finish = (result: string | undefined) => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(HTTP_TIMEOUT_MS, () => finish(undefined));
        socket.once('error', () => finish(undefined));
        socket.once('secureConnect', () => finish(`certificate ${describeSubject(socket.getPeerCertificate()?.subject as any)}`));
    });
}

// Every line of the diagnostic, ready to log. `localAddress` is Homey's, as getLocalAddress()
// gives it; the subnet sweep is skipped without one.
export async function diagnoseNoData(host: string, localAddress: string | undefined,
    options: InspectOptions): Promise<string[]> {
    const lines: string[] = [];
    for (const unitId of DIAG_UNIT_IDS) {
        const answers = await inspectHost(host, {...options, unitId});
        lines.push(`${host} unit ${unitId}${unitId === options.unitId ? ' (configured)' : ''}: `
            + (answers ? answers.join(' ') : 'connection refused or timed out'));
    }
    lines.push(`${host} server ID (function 17): ${await reportServerId(host, options.port, options.unitId)}`);
    const ports = await Promise.all(DIAG_PORTS.map(async (port) => {
        if (!await portOpen(host, port))
            return `${port} closed`;
        const identity = port === 80 ? await httpIdentity(host) : await tlsSubject(host, port);
        return `${port} open${identity ? ` (${identity})` : ''}`;
    }));
    lines.push(`${host} other ports: ${ports.join(', ')}`);
    if (!localAddress)
        return lines;
    const localIp = localAddress.split(':')[0];
    const hosts = subnetHosts(localIp).filter((h) => h !== localIp && h !== host);
    const responders: string[] = [];
    for (let i = 0; i < hosts.length; i += BATCH_SIZE) {
        const batch = hosts.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(async (h) => {
            const answers = await inspectHost(h, options);
            return answers && `${h} ${answers.join(' ')} id ${await reportServerId(h, options.port, options.unitId)}`;
        }));
        for (const result of results)
            if (result)
                responders.push(result);
    }
    lines.push(`Other Modbus responders on port ${options.port}, unit ${options.unitId}: `
        + (responders.length ? responders.join('; ') : 'none'));
    return lines;
}
