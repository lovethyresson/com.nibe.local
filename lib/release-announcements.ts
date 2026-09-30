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
    "id": "1.4-feature-update",
    "snippets": [
        {
            "driverIds": [
                "nibe_s"
            ],
            "text": {
                "en": "More control in Flows: dedicated setting cards and SG Ready controls where supported and configured. Explore the new Nibe Flow cards; existing Flows keep working.",
                "sv": "Mer styrning i Flöden: egna inställningskort och SG Ready-styrning där det stöds och är konfigurerat. Utforska de nya Nibe-korten; befintliga Flöden fortsätter fungera.",
                "de": "Mehr Kontrolle in Flows: eigene Einstellungskarten und SG-Ready-Steuerung, sofern unterstützt und eingerichtet. Entdecke die neuen Nibe-Flow-Karten; bestehende Flows funktionieren weiter.",
                "nl": "Meer controle in Flows: aparte instellingskaarten en SG Ready-besturing waar ondersteund en ingesteld. Bekijk de nieuwe Nibe-Flow-kaarten; bestaande Flows blijven werken.",
                "no": "Mer kontroll i Flows: egne innstillingskort og SG Ready-styring der det støttes og er satt opp. Utforsk de nye Nibe-kortene; eksisterende Flows virker fortsatt.",
                "da": "Mere kontrol i Flows: egne indstillingskort og SG Ready-styring, hvor det understøttes og er sat op. Udforsk de nye Nibe-kort; eksisterende Flows virker fortsat."
            }
        },
        {
            "driverIds": [
                "nibe_f"
            ],
            "text": {
                "en": "Experimental F-series support has improved readings and energy recommendations. Run Repair on your Nibe devices to review the available features.",
                "sv": "Det experimentella F-seriestödet har förbättrade mätvärden och energirekommendationer. Kör Reparera på dina Nibe-enheter för att granska tillgängliga funktioner.",
                "de": "Die experimentelle F-Serie bietet verbesserte Messwerte und Energieempfehlungen. Starte Reparieren auf deinen Nibe-Geräten, um die verfügbaren Funktionen zu prüfen.",
                "nl": "Experimentele F-serie-ondersteuning biedt verbeterde meetwaarden en energieaanbevelingen. Kies Herstellen op je Nibe-apparaten om de beschikbare functies te bekijken.",
                "no": "Eksperimentell F-seriestøtte har forbedrede måleverdier og energianbefalinger. Kjør Reparer på Nibe-enhetene dine for å se tilgjengelige funksjoner.",
                "da": "Eksperimentel F-serieunderstøttelse har forbedrede måleværdier og energianbefalinger. Kør Reparer på dine Nibe-enheder for at gennemgå de tilgængelige funktioner."
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
