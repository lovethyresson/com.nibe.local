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
    "id": "1.5.0-update",
    "snippets": [
        {
            "driverIds": [
                "nibe_s"
            ],
            "roles": [
                "heating"
            ],
            "text": {
                "en": "Your Heating thermostat can now follow one NIBE wireless room sensor, and on pumps with several zones you choose which zone it sets. Run Repair on your Nibe Heating device to set it up.",
                "sv": "Termostaten på Värme kan nu följa en trådlös NIBE-rumsgivare, och på värmepumpar med flera zoner väljer du vilken zon den ställer in. Kör Reparera på din Nibe Värme-enhet för att ställa in det.",
                "de": "Der Thermostat von Heizung kann jetzt einem NIBE-Funk-Raumfühler folgen, und bei Wärmepumpen mit mehreren Zonen wählst du, welche Zone er einstellt. Führe Reparieren auf deinem Nibe-Heizungsgerät aus, um es einzurichten.",
                "nl": "De thermostaat van Verwarming kan nu één draadloze NIBE-ruimtesensor volgen, en op warmtepompen met meerdere zones kies je welke zone hij instelt. Voer Repareren uit op je Nibe Verwarming-apparaat om het in te stellen.",
                "no": "Termostaten på Varme kan nå følge én trådløs NIBE-romføler, og på varmepumper med flere soner velger du hvilken sone den stiller inn. Kjør Reparer på Nibe Varme-enheten din for å sette det opp.",
                "da": "Termostaten på Varme kan nu følge én trådløs NIBE-rumføler, og på varmepumper med flere zoner vælger du, hvilken zone den indstiller. Kør Reparer på din Nibe Varme-enhed for at sætte det op."
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
