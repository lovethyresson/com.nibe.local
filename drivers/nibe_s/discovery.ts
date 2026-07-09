import net from 'net';
import {ModbusTCPClient} from 'jsmodbus';

// Modbus TCP has no discovery protocol, and Nibe S-series pumps don't announce
// themselves via mDNS/SSDP, so pairing "discovery" is a sweep of the local /24
// subnet for open port 502. Every responder is verified by reading input
// register 1 (outdoor temperature) — a plausible answer means it is almost
// certainly the pump, and the value doubles as a recognizable label in the
// pairing UI. Requires Modbus TCP to be enabled on the pump (menu 7.5.9) and
// Homey to be on the same subnet; manual IP entry remains the fallback.

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
            const client = new ModbusTCPClient(socket, 1, READ_TIMEOUT_MS);
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

export async function discoverPumps(
    localAddress: string,
    exclude: Set<string>,
    onProgress?: (done: number, total: number) => void
): Promise<DiscoveredPump[]> {
    // localAddress from ManagerCloud.getLocalAddress() looks like "192.168.1.5:80";
    // assume a /24, which is what home LANs practically always are.
    const base = localAddress.split(':')[0].split('.').slice(0, 3).join('.');
    const hosts: string[] = [];
    for (let i = 1; i <= 254; ++i) {
        const host = `${base}.${i}`;
        if (!exclude.has(host))
            hosts.push(host);
    }
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
