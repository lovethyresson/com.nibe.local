// Maintainer tool (not shipped — see .homeyignore). Reads the whole Smart Price Adaption
// register family, and with --watch prints only what changes. That watch mode is the point:
// 844, 846, 1915 and 1918 carry value codes Nibe does not publish (their CSV rows are
// min=max=def=0), so the only way to decode them is to change SPA on the pump's own panel
// and see which register moves and to what.
//
//   node dev/probe-spa.mjs                          one pass, print everything
//   node dev/probe-spa.mjs --watch                  re-read every 10s, changes only
//   node dev/probe-spa.mjs 10.136.1.93 --watch --interval 5
//
// --scan reads a RAW address range and prints everything that answers, with each plausible
// decode side by side. Unlike dev/probe-sweep.mjs it does not consult the CSV, which is the
// whole point: a register the CSV does not list is invisible to a CSV-driven sweep, and
// "documented but absent, real value living elsewhere" is a case this pump has form for.
//
//   node dev/probe-spa.mjs --scan --from 1900 --to 1940            input registers
//   node dev/probe-spa.mjs --scan --holding --from 890 --to 910    holding instead
//
// The pump accepts a single Modbus client, so the running Homey app loses its connection
// while this runs. It reconnects by itself afterwards.

import net from 'net';
import {createRequire} from 'module';

const require = createRequire(import.meta.url);
const {ModbusTCPClient} = require('jsmodbus');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const num = (n, d) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? Number(argv[i + 1]) : d;
};

const host = argv.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? '10.136.1.93';
const watch = has('watch');
const intervalMs = num('interval', 10) * 1000;
const scan = has('scan');
const scanFrom = num('from', 1900);
const scanTo = num('to', 1940);
const scanKind = has('holding') ? 'holding' : 'input';

// size/div lifted from the S1155/S1255 and S735 CSVs. `range` quotes what the CSV documents;
// a trailing "?" marks a register whose codes are undocumented — those are what --watch is for.
const REGISTERS = [
    {kind: 'holding', addr:  843, size: 'u8',  div:  1, name: 'SPA master activated',    range: '0-1'},
    {kind: 'holding', addr:  844, size: 'u8',  div:  1, name: 'SPA heating activated',   range: '0-3 ?'},
    {kind: 'holding', addr:  845, size: 's8',  div:  1, name: 'SPA heating influence',   range: '1-10'},
    {kind: 'holding', addr:  846, size: 'u8',  div:  1, name: 'SPA hotwater activated',  range: '0-4 ?'},
    // 847 is in NO model CSV and not in yozik04/nibe either, and the gap sits exactly where
    // pool's enable belongs (844/845 heating, 846 hot water, 848 pool, 849/850 cooling), so it
    // looked like another 2505 — untitled as `id:12801` and answering fine. It is not: a raw
    // --scan of holding 840..855 answered at 842-846 and 848-854 and skipped 847. Nor is that
    // the test pump lacking POOL 40, since it lacks cooling too and 849 still answers. Kept in
    // the list so a pump with different firmware is checked rather than assumed.
    {kind: 'holding', addr:  847, size: 'u8',  div:  1, name: '847 (absent - see note)',  range: 'no pool enable'},
    {kind: 'holding', addr:  848, size: 's8',  div:  1, name: 'SPA pool influence',      range: '0-10'},
    {kind: 'holding', addr:  849, size: 'u8',  div:  1, name: 'SPA cooling activated',   range: '0-1'},
    {kind: 'holding', addr:  850, size: 's8',  div:  1, name: 'SPA cooling influence',   range: '0-10'},
    {kind: 'holding', addr:  851, size: 'u8',  div:  1, name: 'SPA area',                range: '0-255 ?'},
    {kind: 'holding', addr:  902, size: 's8',  div:  1, name: 'SPA hotwater influence',  range: '1-4'},
    {kind: 'input',   addr: 1914, size: 's8',  div: 10, name: 'Heating offset (SPA)',    range: '? div10'},
    {kind: 'input',   addr: 1915, size: 's8',  div:  1, name: 'Hotwater mode (SPA)',     range: '?'},
    {kind: 'input',   addr: 1916, size: 's8',  div:  1, name: 'Pool offset (SPA)',       range: '?'},
    {kind: 'input',   addr: 1917, size: 's8',  div:  1, name: 'Cooling offset (SPA)',    range: '?'},
    {kind: 'input',   addr: 1918, size: 'u8',  div:  1, name: 'Operating mode (SPA)',    range: '?'},
    // Undocumented — absent from every model CSV, found by --scan on a live S1155. 1919 looked
    // like the heating offset 1914 should have been: small, negative (-0.4), moving, and sitting
    // in the SPA block while 1914 itself does not answer on this firmware.
    //
    // It is NOT. Measured 2026-08-09: switching the SPA master (843) off dropped 1916, 1917 and
    // 1918 to zero in the same poll and 1919 did not move at all. Earlier in the same run it had
    // stepped -0.4 -> -0.3 in the exact poll degree minutes stepped 28 -> 27 — one raw step each,
    // opposite directions. So 1919 tracks the heating regulation, not the price. Kept here only
    // so the next person does not re-run this experiment.
    //
    // 1920 drifts slowly (40, later 39) — consistent with a brine dT set point, not a constant.
    {kind: 'input',   addr: 1919, size: 's8',  div: 10, name: '1919 (not SPA - see note)',range: 'ruled out'},
    {kind: 'input',   addr: 1920, size: 'u8',  div:  1, name: '1920 (brine dT set pt)',   range: '-'},
    // Context — an offset only means something against what the pump is actually doing.
    {kind: 'input',   addr:    1, size: 's16', div: 10, name: '  outdoor temperature'},
    {kind: 'input',   addr:   11, size: 's16', div: 10, name: '  degree minutes'},
    {kind: 'input',   addr: 1017, size: 's16', div: 10, name: '  calculated supply'}
];

// Nibe hands 8-bit values back in a 16-bit word. Signed ones are normally sign-extended to
// 16 bits, but not always, so an s8 gets both rules. A u8 gets neither — 851 legitimately
// reaches 255, and "correcting" that to -1 would be the bug.
function decode(raw, {size, div}) {
    if (raw === undefined)
        return undefined;
    if (raw === 0x8000)
        return undefined;                                       // Nibe's not-available sentinel
    let value = raw;
    if (size !== 'u8' && value >= 32768)
        value -= 65536;
    if (size === 's8' && value >= 128 && value <= 255)
        value -= 256;
    return value / div;
}

async function readOne(client, register) {
    try {
        const response = register.kind === 'input'
            ? await client.readInputRegisters(register.addr, 1)
            : await client.readHoldingRegisters(register.addr, 1);
        return response.response.body.values[0];
    } catch {
        return undefined;                                       // absent on this model
    }
}

async function readAll(client) {
    const values = new Map();
    for (const register of REGISTERS)
        values.set(register.addr, await readOne(client, register));
    return values;
}

function label(register) {
    const kind = register.kind === 'input' ? 'I' : 'H';
    return `${kind} ${String(register.addr).padEnd(5)}${register.name.padEnd(26)}`;
}

function show(register, raw) {
    const decoded = decode(raw, register);
    const rawText = raw === undefined ? 'absent' : String(raw);
    const decodedText = decoded === undefined ? '--' : String(decoded);
    return `${label(register)} raw=${rawText.padEnd(7)} value=${decodedText.padEnd(8)} ${register.range ?? ''}`;
}

const socket = new net.Socket();
const client = new ModbusTCPClient(socket, 1);

// Every decode a single word could plausibly be, printed side by side, because the whole
// reason for scanning is that we do NOT know the register's declared type. An offset in
// tenths of a degree and one in whole degrees differ by 10x and both look reasonable in
// isolation — seeing them together next to a known quantity is what settles it.
async function scanRange() {
    console.log(`Scanning ${scanKind} registers ${scanFrom}..${scanTo} on ${host}\n`);
    console.log('addr   raw      s16      s16/10   s8       s8/10');
    console.log('-----  -------  -------  -------  -------  -------');
    let answered = 0;
    for (let addr = scanFrom; addr <= scanTo; addr++) {
        const raw = await readOne(client, {kind: scanKind, addr});
        if (raw === undefined)
            continue;                                           // exception: not on this pump
        answered++;
        const s16 = raw >= 32768 ? raw - 65536 : raw;
        let s8 = s16;
        if (s8 >= 128 && s8 <= 255)
            s8 -= 256;
        const sentinel = raw === 0x8000 ? '  <not available>' : '';
        const cell = (v) => String(v).padStart(7);
        console.log(`${String(addr).padEnd(5)}  ${cell(raw)}  ${cell(s16)}  ${cell(s16 / 10)}  ${cell(s8)}  ${cell(s8 / 10)}${sentinel}`);
    }
    console.log(`\n${answered} of ${scanTo - scanFrom + 1} addresses answered.`);
}

socket.on('connect', async () => {
    if (scan) {
        await scanRange();
        socket.end();
        return;
    }

    let previous = await readAll(client);
    for (const register of REGISTERS)
        console.log(show(register, previous.get(register.addr)));

    if (!watch) {
        socket.end();
        return;
    }

    console.log(`\nWatching every ${intervalMs / 1000}s. Change SPA on the pump (menu 7.1.10, and`);
    console.log('the per-function settings) — whatever moves names itself. Ctrl-C to stop.\n');

    setInterval(async () => {
        const now = await readAll(client);
        const stamp = new Date().toLocaleTimeString();
        for (const register of REGISTERS) {
            const before = previous.get(register.addr);
            const after = now.get(register.addr);
            if (before === after)
                continue;
            console.log(`${stamp}  ${label(register)} ${decode(before, register)} -> ${decode(after, register)}   (raw ${before} -> ${after})`);
        }
        previous = now;
    }, intervalMs);
});

socket.on('error', (error) => {
    console.error(`socket: ${error.message}`);
    process.exit(1);
});

socket.connect({host, port: 502});
