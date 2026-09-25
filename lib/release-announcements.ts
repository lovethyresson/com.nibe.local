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
    "id": "1.3.3-setup-tips",
    "snippets": [
        {
            "driverIds": [
                "nibe_s"
            ],
            "roles": [
                "hotwater"
            ],
            "text": {
                "en": "Hot water available is here. Run Repair on your Hot Water device to set it up.",
                "sv": "Tillgängligt varmvatten är här. Kör Reparera på din varmvattenenhet för att komma igång.",
                "de": "Verfügbares Warmwasser ist da. Starte Reparieren auf deinem Warmwassergerät, um es einzurichten.",
                "nl": "Beschikbaar warm water is er. Kies Herstellen op je warmwaterapparaat om het in te stellen.",
                "no": "Tilgjengelig varmtvann er her. Kjør Reparer på varmtvannsenheten for å sette det opp.",
                "da": "Tilgængeligt varmt vand er her. Kør Reparer på din varmtvandsenhed for at sætte det op."
            }
        },
        {
            "driverIds": [
                "nibe_s"
            ],
            "roles": [
                "heating"
            ],
            "text": {
                "en": "You can now use your Homey temperature sensors for heating. Run Repair on your Heating device to set it up.",
                "sv": "Nu kan du använda dina temperaturgivare i Homey för att styra värmen. Kör Reparera på din värmeenhet för att komma igång.",
                "de": "Du kannst jetzt deine Homey-Temperatursensoren zum Heizen nutzen. Starte Reparieren auf deinem Heizungsgerät, um es einzurichten.",
                "nl": "Je kunt nu je Homey-temperatuursensoren gebruiken voor verwarming. Kies Herstellen op je verwarmingsapparaat om het in te stellen.",
                "no": "Nå kan du bruke temperatursensorene dine i Homey til å styre varmen. Kjør Reparer på varmeenheten for å sette det opp.",
                "da": "Nu kan du bruge dine Homey-temperatursensorer til at styre varmen. Kør Reparer på din varmeenhed for at sætte det op."
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
