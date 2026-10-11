import type Homey from 'homey';
import type {Role} from './roles';

export interface Announcement {
    // Stable across copy edits and patch releases; replace when announcing a new feature release.
    id: string;
    snippets: {
        driverIds?: string[];
        roles?: Role[];
        text: {en: string; [language: string]: string};
    }[];
}

// Opt in deliberately at release time. Keep only the latest announcement, never a backlog.
export const CURRENT_ANNOUNCEMENT: Announcement | null = {
    "id": "1.4.4-setting-triggers",
    "snippets": [
        {
            "driverIds": [
                "nibe_s"
            ],
            "roles": [
                "heating"
            ],
            "text": {
                "en": "New Flow cards react when the heat curve displacement, operating mode or fan mode changes. Add them to a Flow from your Nibe devices.",
                "sv": "Nya Flödeskort reagerar när värmeförskjutning, driftläge eller fläktläge ändras. Lägg till dem i ett Flöde från dina Nibe-enheter.",
                "de": "Neue Flow-Karten reagieren, wenn sich Parallelverschiebung, Betriebsmodus oder Lüfterstufe ändern. Füge sie über deine Nibe-Geräte zu einem Flow hinzu.",
                "nl": "Nieuwe Flow-kaarten reageren wanneer de verschuiving van de stooklijn, de bedrijfsstand of de ventilatorstand verandert. Voeg ze toe aan een Flow via je Nibe-apparaten.",
                "no": "Nye Flow-kort reagerer når varmeforskyvning, driftsmodus eller viftetrinn endres. Legg dem til i en Flow fra Nibe-enhetene dine.",
                "da": "Nye Flow-kort reagerer, når varmeforskydning, driftsindstilling eller ventilatortrin ændres. Tilføj dem til et Flow fra dine Nibe-enheder."
            }
        },
        {
            "driverIds": [
                "nibe_s"
            ],
            "roles": [
                "cooling"
            ],
            "text": {
                "en": "Night cooling has moved to your Nibe heating device. Pick that device again in Flows that switch night cooling.",
                "sv": "Nattsvalka har flyttat till din Nibe-värmeenhet. Välj den enheten igen i Flöden som styr nattsvalka.",
                "de": "Die Nachtkühlung ist zu deinem Nibe-Heizungsgerät umgezogen. Wähle dieses Gerät in Flows, die die Nachtkühlung schalten, neu aus.",
                "nl": "Nachtkoeling is verhuisd naar je Nibe-verwarmingsapparaat. Kies dat apparaat opnieuw in Flows die nachtkoeling schakelen.",
                "no": "Nattkjøling er flyttet til Nibe-varmeenheten din. Velg den enheten på nytt i Flows som styrer nattkjøling.",
                "da": "Natkøling er flyttet til din Nibe-varmeenhed. Vælg den enhed igen i Flows, der styrer natkøling."
            }
        }
    ]
};
export const ANNOUNCEMENT_SETTING = 'releaseAnnouncementsHandled';

type Device = {driverId: string; role: string};
type Services = {
    settings: {get(key: string): unknown; set(key: string, value: string[]): void};
    notifications: {createNotification(options: {excerpt: string}): Promise<void>};
};

export async function deliverAnnouncement(
    services: Services, announcement: Announcement | null, devices: Device[], language: string
): Promise<void> {
    if (!announcement) return;
    const stored = services.settings.get(ANNOUNCEMENT_SETTING);
    const handled = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
    if (handled.includes(announcement.id)) return;
    const excerpts = announcement.snippets.filter(snippet => devices.some(device =>
        (!snippet.driverIds || snippet.driverIds.includes(device.driverId))
        && (!snippet.roles || snippet.roles.includes(device.role as Role))
    )).map(snippet => snippet.text[language] || snippet.text.en);
    if (excerpts.length) {
        // Record only after delivery succeeds, so a failure can retry on the next app start.
        await services.notifications.createNotification({excerpt: excerpts.join('\n\n')});
    }
    // No paired/relevant devices: consume silently, including fresh installs. Pairing later
    // should not turn old release news into a delayed notification.
    services.settings.set(ANNOUNCEMENT_SETTING, [...handled, announcement.id]);
}

export function announcementDevices(devices: Record<string, any>, appId: string): Device[] {
    const owner = `homey:app:${appId}`;
    // driverId is the full `homey:app:<app>:<driver>` on current Homey. Never touch driverUri:
    // homey-api keeps it only as a getter that returns undefined and logs a deprecation warning
    // per call — one per device on the whole Homey, which buried every startup log.
    return Object.values(devices).flatMap(device => {
        const fullId = String(device.driverId ?? '');
        const driverId = fullId.startsWith(`${owner}:`) ? fullId.slice(owner.length + 1) : null;
        return driverId ? [{driverId, role: device.data?.role ?? 'main'}] : [];
    });
}

async function pairedDevices(homey: Homey.App['homey']): Promise<Record<string, any>> {
    const {HomeyAPI} = require('homey-api');
    const api = await HomeyAPI.createAppAPI({homey});
    return api.devices.getDevices({$cache: false, $timeout: 10000});
}

export async function announceRelease(
    homey: Homey.App['homey'], announcement: Announcement | null = CURRENT_ANNOUNCEMENT,
    inventory = pairedDevices
): Promise<void> {
    if (!announcement) return;
    // App onInit precedes driver/device creation. Read Homey's persisted inventory instead
    // of the SDK's still-empty in-process driver list. No pump connection is required.
    const devices = announcementDevices(await inventory(homey), homey.manifest.id);
    await deliverAnnouncement(homey, announcement, devices, homey.i18n.getLanguage());
}
