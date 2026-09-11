/** Homey sensor selection and read-only discovery. No pump writes happen here. */
export interface SensorRef { deviceId: string; capabilityId: string }
export interface IndoorConfig {
    sensors: SensorRef[];
    maxAgeMinutes: number;
    state: 'pending' | 'active';
}
export interface SensorReading extends SensorRef {
    name: string; room: string; zoneId: string; type: string; app: string;
    value: number | null; updatedAt: number | null; available: boolean;
}
export function cleanIndoorConfig(raw: any): IndoorConfig {
    if (!Array.isArray(raw?.sensors) || !raw.sensors.length || raw.sensors.length > 30)
        throw new Error('Choose between 1 and 30 temperature sensors.');
    const sensors: SensorRef[] = [];
    for (const item of raw.sensors) {
        if (typeof item?.deviceId !== 'string' || !item.deviceId
            || typeof item.capabilityId !== 'string'
            || !/^measure_temperature(?:\.[\w-]+)?$/.test(item.capabilityId))
            throw new Error('Invalid temperature sensor.');
        if (sensors.some(s => s.deviceId === item.deviceId && s.capabilityId === item.capabilityId))
            throw new Error('A sensor can only be selected once.');
        sensors.push({deviceId: item.deviceId, capabilityId: item.capabilityId});
    }
    const maxAgeMinutes = Number(raw.maxAgeMinutes ?? 120);
    if (!Number.isInteger(maxAgeMinutes) || maxAgeMinutes < 5 || maxAgeMinutes > 1440)
        throw new Error('Reading age must be between 5 and 1440 minutes.');
    // Only a device-owned activation can promote a pending selection to active.
    return {sensors, maxAgeMinutes, state: 'pending'};
}
export function averageSensors(config: IndoorConfig, readings: SensorReading[], now = Date.now()): number {
    const values = config.sensors.map(ref => {
        const s = readings.find(r => r.deviceId === ref.deviceId && r.capabilityId === ref.capabilityId);
        if (!s || !s.available || typeof s.value !== 'number' || !Number.isFinite(s.value)
            || s.value < 5 || s.value > 40)
            throw new Error('A selected room sensor is missing, unavailable or outside 5–40 °C.');
        if (!s.updatedAt || s.updatedAt > now + 60000 || now - s.updatedAt > config.maxAgeMinutes * 60000)
            throw new Error('A selected sensor has no recent temperature update. Check its app or the reading-age limit.');
        return s.value;
    });
    if (!values.length) throw new Error('Choose at least one sensor.');
    return Math.round(values.reduce((sum, n) => sum + n, 0) / values.length * 10) / 10;
}

export function sensorInventory(devices: Record<string, any>, zones: Record<string, any>, language = 'en'): SensorReading[] {
    const order: string[] = [];
    const paths = new Map<string, string>();
    const walk = (parent: string | null, path: string, seen: Set<string>) => {
        Object.values(zones).filter((z: any) => (z.parent ?? null) === parent)
            .sort((a: any, b: any) => (a.sortIndex ?? Infinity) - (b.sortIndex ?? Infinity)
                || String(a.name).localeCompare(String(b.name), language))
            .forEach((z: any) => {
                if (seen.has(z.id)) return;
                seen.add(z.id);
                const full = path ? `${path} / ${z.name}` : z.name;
                order.push(z.id); paths.set(z.id, full); walk(z.id, full, seen);
            });
    };
    walk(null, '', new Set());
    const readings: SensorReading[] = [];
    for (const d of Object.values(devices)) {
        if (String(d.driverId).includes('com.nibe.local')) continue;
        for (const [id, cap] of Object.entries(d.capabilitiesObj ?? {}) as [string, any][]) {
            if (!/^measure_temperature(?:\.[\w-]+)?$/.test(id)) continue;
            const units = typeof cap.units === 'object' ? cap.units.en : cap.units;
            // Standard capability values are Celsius; reject explicitly different units.
            if (units && units !== '°C' && units !== 'C') continue;
            const stamp = cap.lastUpdated ? new Date(cap.lastUpdated).getTime() : NaN;
            readings.push({deviceId: d.id, capabilityId: id, name: String(d.name),
                room: paths.get(d.zone) ?? '', zoneId: d.zone ?? '', type: d.class ?? '',
                app: d.driverId?.split(':')[2] ?? d.driverId ?? '',
                value: typeof cap.value === 'number' && Number.isFinite(cap.value) ? cap.value : null,
                updatedAt: Number.isFinite(stamp) ? stamp : null, available: d.available === true});
        }
    }
    return readings.sort((a, b) => {
        const rank = (id: string) => order.includes(id) ? order.indexOf(id) : order.length;
        return rank(a.zoneId) - rank(b.zoneId) || a.name.localeCompare(b.name, language)
            || a.capabilityId.localeCompare(b.capabilityId);
    });
}

const clients = new WeakMap<object, Promise<any>>();
export async function indoorInventory(homey: any): Promise<SensorReading[]> {
    let client = clients.get(homey);
    if (!client) {
        const {HomeyAPI} = require('homey-api');
        client = HomeyAPI.createAppAPI({homey}) as Promise<any>;
        clients.set(homey, client);
    }
    try {
        const api = await client;
        const [devices, zones] = await Promise.all([
            api.devices.getDevices({$cache: false, $timeout: 10000}), api.zones.getZones({$cache: false, $timeout: 10000})
        ]);
        return sensorInventory(devices, zones, homey.i18n.getLanguage());
    } catch (error) {
        clients.delete(homey);
        throw error;
    }
}
