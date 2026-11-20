/** History persistence in /userdata. Design: docs/autopilot-plan.md §5.4. */
import {promises as fs} from 'fs';
import {randomBytes} from 'crypto';
import {History, applyJournal} from './history';

const DIR = '/userdata';

/** /userdata is served publicly by the Homey web server, so the name is unguessable and is kept
 *  in the device store, never derived from the device. */
export function newHistoryFileName(): string {
    return `autopilot-${randomBytes(12).toString('hex')}.bin`;
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
    const fields = history && file ? History.fieldCount(file) : undefined;
    history ??= new History();
    applyJournal(history, journal, fields);
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
    for (const file of [name, journalName(name), modelFileName(name), shadowLogName(name), shadowStateName(name)]) {
        await fs.unlink(`${DIR}/${file}`).catch((error: any) => {
            if (error?.code !== 'ENOENT') throw error;
        });
    }
}

/** The model's state sits beside the history under the same unguessable name. */
export function modelFileName(historyName: string): string {
    return historyName.replace(/\.bin$/, '.model.json');
}

/** Shadow mode's per-slot log (JSON lines) and its carried state, beside the history. */
export function shadowLogName(historyName: string): string {
    return historyName.replace(/\.bin$/, '.shadow.jsonl');
}

export function shadowStateName(historyName: string): string {
    return historyName.replace(/\.bin$/, '.shadow.json');
}

export async function appendLine(name: string, value: unknown): Promise<void> {
    await fs.appendFile(`${DIR}/${name}`, `${JSON.stringify(value)}\n`);
}

/** Keep the last `keep` lines; returns how many are left. */
export async function trimLines(name: string, keep: number): Promise<number> {
    const text = await fs.readFile(`${DIR}/${name}`, 'utf8').catch((error: any) => {
        if (error?.code === 'ENOENT') return '';
        throw error;
    });
    const lines = text.split('\n').filter((l) => l.length);
    if (lines.length <= keep) return lines.length;
    const path = `${DIR}/${name}`;
    await fs.writeFile(`${path}.tmp`, `${lines.slice(-keep).join('\n')}\n`);
    await fs.rename(`${path}.tmp`, path);
    return keep;
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

/** Remove one file from /userdata; a file already gone is fine. */
export async function deleteFile(name: string): Promise<void> {
    await fs.unlink(`${DIR}/${name}`).catch((error: any) => {
        if (error?.code !== 'ENOENT') throw error;
    });
}
