// One-off research scan for multi-zone pumps (test builds). NIBE documents a setpoint per zone
// (holding 2505.. step 2) but no per-zone temperature, so the only way to find one is to read the
// input space on a pump whose zones read different temperatures and match what myUplink shows.
// Logs only: nothing here writes, sets a capability or feeds attribution.

export type BlockReader = (address: number, count: number) => Promise<number[] | undefined>;

export type ScanResult = {
    hits: {address: number; value: number}[];
    reads: number;
    answered: number;
    aborted?: string;
};

// A temperature in tenths of a degree, 5.0..40.0 °C. Wide enough for a cold basement and a
// warm upstairs, narrow enough to keep counters and flags out. 0x8000 is NIBE's sentinel.
export function isRoomTemperatureWord(word: number): boolean {
    if (word === 0x8000)
        return false;
    const signed = word >= 0x8000 ? word - 0x10000 : word;
    return signed >= 50 && signed <= 400;
}

// Blocks of 50, then 10, then single addresses wherever a block is refused: a NIBE pump rejects a
// whole block if any address in it is undefined, and most of the space is. A request slower than
// `slowMs` twice in a row aborts, so a pump that times out instead of refusing can't wedge the
// wire for hours. `deadline` bounds the whole run.
export async function scanInputSpace(read: BlockReader, from: number, to: number,
    options: {slowMs?: number; deadline?: number; now?: () => number} = {}): Promise<ScanResult> {
    const now = options.now ?? Date.now;
    const slowMs = options.slowMs ?? 3000;
    const result: ScanResult = {hits: [], reads: 0, answered: 0};
    let slow = 0;
    const attempt = async (address: number, count: number): Promise<number[] | undefined | null> => {
        if (options.deadline !== undefined && now() > options.deadline) {
            result.aborted = 'time limit';
            return null;
        }
        const started = now();
        const words = await read(address, count);
        result.reads++;
        slow = now() - started > slowMs ? slow + 1 : 0;
        if (slow >= 2) {
            result.aborted = 'pump answering too slowly';
            return null;
        }
        return words;
    };
    const record = (address: number, words: number[]) => {
        result.answered += words.length;
        words.forEach((word, i) => {
            if (isRoomTemperatureWord(word))
                result.hits.push({address: address + i, value: (word >= 0x8000 ? word - 0x10000 : word) / 10});
        });
    };
    const span = async (address: number, count: number, sizes: number[]): Promise<boolean> => {
        const words = await attempt(address, count);
        if (words === null) return false;
        if (words) { record(address, words); return true; }
        const [next, ...rest] = sizes;
        if (next === undefined) return true;
        for (let a = address; a < address + count; a += next)
            if (!await span(a, Math.min(next, address + count - a), rest)) return false;
        return true;
    };
    for (let a = from; a <= to; a += 50)
        if (!await span(a, Math.min(50, to - a + 1), [10, 1])) break;
    return result;
}

// Hits as compact log lines, so a few hundred of them stay readable in a diagnostics report.
export function formatHits(hits: ScanResult['hits'], perLine = 20): string[] {
    const lines: string[] = [];
    for (let i = 0; i < hits.length; i += perLine)
        lines.push(hits.slice(i, i + perLine).map((h) => `${h.address}=${h.value}`).join(' '));
    return lines;
}
