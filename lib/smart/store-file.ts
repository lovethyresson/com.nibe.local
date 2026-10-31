/** History persistence in /userdata. Design: docs/smart-heating-plan.md §5.4. */
import {promises as fs} from 'fs';
import {randomBytes} from 'crypto';
import {History} from './history';

const DIR = '/userdata';

/** /userdata is served publicly by the Homey web server, so the name is unguessable and is kept
 *  in the device store, never derived from the device. */
export function newHistoryFileName(): string {
    return `smart-${randomBytes(12).toString('hex')}.bin`;
}

export async function loadHistory(name: string): Promise<History | undefined> {
    try {
        return History.deserialize(await fs.readFile(`${DIR}/${name}`));
    } catch (error: any) {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
    }
}

/** Temp file + rename, so a crash mid-write leaves the previous file intact. */
export async function saveHistory(name: string, history: History): Promise<void> {
    const path = `${DIR}/${name}`;
    await fs.writeFile(`${path}.tmp`, history.serialize());
    await fs.rename(`${path}.tmp`, path);
}

export async function deleteHistory(name: string): Promise<void> {
    await fs.unlink(`${DIR}/${name}`).catch((error: any) => {
        if (error?.code !== 'ENOENT') throw error;
    });
}
