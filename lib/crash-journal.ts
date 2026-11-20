/** A small journal of what stopped the app, kept in /userdata so it survives the restart: Homey
 *  doesn't give an app its own log, and on 2026-11-20 the app restarted an hour after each start
 *  with no message. Holds the last 20 entries: each start, each uncaught error (written
 *  synchronously, before the process goes) and each rejected promise nobody handled. Read through
 *  the app's debug endpoint (api.ts `crashes`). */
import fs from 'fs';

const FILE = '/userdata/crash-journal.json';
export const KEEP = 20;

export interface JournalEntry {at: string; kind: 'start' | 'uncaught' | 'rejection'; message?: string; stack?: string; uptimeS?: number}

export function readJournal(file = FILE): JournalEntry[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/** Synchronous on purpose: an uncaught error ends the process right after this returns. */
export function record(entry: Omit<JournalEntry, 'at'>, file = FILE, now = new Date()) {
    try {
        const entries = [...readJournal(file), {at: now.toISOString(), ...entry}].slice(-KEEP);
        fs.writeFileSync(file, JSON.stringify(entries));
    } catch {
        // Nothing to do: the journal must never be what crashes the app.
    }
}

export function errorEntry(kind: 'uncaught' | 'rejection', error: any): Omit<JournalEntry, 'at'> {
    return {kind, message: String(error?.message ?? error).slice(0, 500),
        stack: typeof error?.stack === 'string' ? error.stack.slice(0, 2000) : undefined, uptimeS: Math.round(process.uptime())};
}
