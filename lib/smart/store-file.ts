/** History persistence in /userdata. Design: docs/smart-heating-plan.md §5.4. */
import {promises as fs} from 'fs';
import {randomBytes} from 'crypto';
import {History, applyJournal} from './history';

const DIR = '/userdata';

/** /userdata is served publicly by the Homey web server, so the name is unguessable and is kept
 *  in the device store, never derived from the device. */
export function newHistoryFileName(): string {
    return `smart-${randomBytes(12).toString('hex')}.bin`;
}

const journalName = (name: string) => `${name}.journal`;

const readOrUndefined = (path: string) => fs.readFile(path).catch((error: any) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
});

/** The last full save plus the slots journalled since. */
export async function loadHistory(name: string): Promise<History | undefined> {
    const file = await readOrUndefined(`${DIR}/${name}`);
    const journal = await readOrUndefined(`${DIR}/${journalName(name)}`);
    let history = file ? History.deserialize(file) : undefined;
    if (!journal?.length) return history;
    history ??= new History();
    applyJournal(history, journal);
    return history;
}

/** Temp file + rename, so a crash mid-write leaves the previous file intact; then the journal,
 *  now inside the file, is emptied. A crash between the two replays slots already saved, which
 *  writes the same values again. */
export async function saveHistory(name: string, history: History): Promise<void> {
    const path = `${DIR}/${name}`;
    await fs.writeFile(`${path}.tmp`, history.serialize());
    await fs.rename(`${path}.tmp`, path);
    await fs.writeFile(`${DIR}/${journalName(name)}`, Buffer.alloc(0));
}

export async function appendJournal(name: string, record: Buffer): Promise<void> {
    await fs.appendFile(`${DIR}/${journalName(name)}`, record);
}

export async function deleteHistory(name: string): Promise<void> {
    for (const file of [name, journalName(name), modelFileName(name)]) {
        await fs.unlink(`${DIR}/${file}`).catch((error: any) => {
            if (error?.code !== 'ENOENT') throw error;
        });
    }
}

/** The model's state sits beside the history under the same unguessable name. */
export function modelFileName(historyName: string): string {
    return historyName.replace(/\.bin$/, '.model.json');
}

export async function loadJson<T>(name: string): Promise<T | undefined> {
    try {
        return JSON.parse(await fs.readFile(`${DIR}/${name}`, 'utf8'));
    } catch (error: any) {
        if (error?.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
        throw error;
    }
}

export async function saveJson(name: string, value: unknown): Promise<void> {
    const path = `${DIR}/${name}`;
    await fs.writeFile(`${path}.tmp`, JSON.stringify(value));
    await fs.rename(`${path}.tmp`, path);
}
