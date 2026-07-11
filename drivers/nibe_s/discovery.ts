import net from 'net';
import os from 'os';
import {ModbusTCPClient} from 'jsmodbus';

// Modbus TCP has no discovery protocol, and Nibe pumps don't announce themselves
// via mDNS/SSDP, so pairing "discovery" is a sweep of the local subnet for open
// port 502. Every responder is verified by reading input register 1 (outdoor
// temperature) — a plausible answer means it is almost certainly the pump, and
// the value doubles as a recognizable label in the pairing UI. Requires Modbus
// TCP to be enabled on the pump (menu 7.5.9) and Homey to be on the same subnet;
// manual IP entry remains the fallback.

// Largest subnet we're willing to sweep. A /24 is 254 hosts; /22 is ~1022. Below
// that (e.g. a /16 with 65k hosts) a full sweep would take far too long, so we
// clamp to the /24 around Homey's own address.
const MAX_PREFIX_HOSTS = 1024;
const CLAMP_PREFIX = 24;

export interface DiscoveredPump {
    address: string;
    outdoorTemperature?: number;
}

const MODBUS_PORT = 502;
const CONNECT_TIMEOUT_MS = 750;
const READ_TIMEOUT_MS = 2000;
const BATCH_SIZE = 51; // 254 hosts / 51 ≈ 5 progress updates

async function tryHost(host: string): Promise<DiscoveredPump | null> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        // The client must be constructed before connecting: jsmodbus marks itself
        // connected by catching the socket's 'connect' event, so a client created
        // inside the connect handler never registers as connected and every read
        // fails with "no connection to modbus server".
        const client = new ModbusTCPClient(socket, 1, READ_TIMEOUT_MS);
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
            client.readInputRegisters(1, 1)
                .then((resp: any) => {
                    let raw = resp.response.body.values[0];
                    if (raw >= 32768)
                        raw -= 65536;
                    const temperature = raw / 10;
                    // Anything with port 502 open that answers this read is Modbus,
                    // but only a sane outdoor temperature makes it a likely Nibe.
                    finish(temperature > -60 && temperature < 60
                        ? {address: host, outdoorTemperature: temperature}
                        : null);
                })
                .catch(() => finish(null));
        });
        socket.connect({port: MODBUS_PORT, host});
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
    console.log(`[discovery] local ${localIp}, detected prefix ${detected ?? 'unknown'}`
        + `${clamped ? ` (clamped to /${prefix})` : ''}; scanning ${intToIp(network)}/${prefix}`
        + ` — ${hosts.length} hosts (${hosts[0]}…${hosts[hosts.length - 1]})`);
    return hosts;
}

export async function discoverPumps(
    localAddress: string,
    exclude: Set<string>,
    onProgress?: (done: number, total: number) => void
): Promise<DiscoveredPump[]> {
    // localAddress from ManagerCloud.getLocalAddress() looks like "192.168.1.5:80".
    const localIp = localAddress.split(':')[0];
    const hosts = subnetHosts(localIp).filter((host) => host !== localIp && !exclude.has(host));
    const found: DiscoveredPump[] = [];
    for (let i = 0; i < hosts.length; i += BATCH_SIZE) {
        const batch = hosts.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(tryHost));
        for (const result of results)
            if (result)
                found.push(result);
        onProgress?.(Math.min(i + BATCH_SIZE, hosts.length), hosts.length);
    }
    return found;
}
