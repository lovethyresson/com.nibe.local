// Maintainer tool (not shipped — see .homeyignore). Cross-checks registers.ts against the
// yozik04 per-model CSVs: (1) flags cross-model semantic collisions that would make the
// single superset table unsafe, (2) lists registers available in the CSVs but not yet
// mapped. See dev/README.md. Run `npm run build` first.
import {readFileSync, readdirSync} from 'fs';
import {fileURLToPath} from 'url';
import {dirname, join} from 'path';
import {createRequire} from 'module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const showAll = process.argv.includes('--all');

let registers;
try {
    ({registers} = require(join(root, '.homeybuild/drivers/nibe_s/registers.js')));
} catch {
    console.error('Could not load the compiled register table — run `npm run build` first.');
    process.exit(1);
}

const csvDir = join(here, 'csv');
let files;
try {
    files = readdirSync(csvDir).filter((f) => f.endsWith('.csv'));
} catch {
    console.error(`No dev/csv/ directory. Put the yozik04 model CSVs there — see dev/README.md.`);
    process.exit(1);
}
if (!files.length) {
    console.error(`No CSVs in ${csvDir}/ — see dev/README.md.`);
    process.exit(1);
}

// address -> model -> {in, hold} title
const map = {};
const models = [];
for (const f of files) {
    const model = f.replace(/\.csv$/, '');
    models.push(model);
    for (const line of readFileSync(join(csvDir, f), 'utf8').split('\n').slice(1)) {
        const c = line.split('\t');
        if (c.length < 3 || !c[2]) continue;
        const [title, type, addr] = c;
        (map[addr] ??= {})[model] ??= {};
        if (type === 'MODBUS_INPUT_REGISTER') map[addr][model].in = title.trim();
        if (type === 'MODBUS_HOLDING_REGISTER') map[addr][model].hold = title.trim();
    }
}
models.sort();
const named = (t) => t && !/^id:\d+$/.test(t);

// 1) Semantic-collision check.
console.log(`\n=== Cross-model semantic collisions (${models.length} models) ===`);
let collisions = 0;
for (const r of registers) {
    const kind = r.direction === 0 ? 'in' : 'hold';
    const per = map[String(r.address)];
    if (!per) continue;
    const titles = new Set();
    for (const m of models) if (named(per[m]?.[kind])) titles.add(per[m][kind]);
    if (titles.size > 1) {
        collisions++;
        console.log(`  COLLISION ${r.address} (${kind}) "${r.name}": ${[...titles].join('  |  ')}`);
    }
}
console.log(collisions
    ? `  ${collisions} address(es) with differing titles across models — review each: wording/`
      + `accessory-label differences (e.g. BT20 position, "(EME 20)") are cosmetic and fine; a\n`
      + `  genuinely different *meaning* at the same address would be a real problem (none as of 2026-07-21).`
    : '  none — superset is safe');

// 2) Unmapped registers (present in a CSV, absent from registers.ts).
const appIn = new Set(registers.filter((r) => r.direction === 0).map((r) => String(r.address)));
const appHold = new Set(registers.filter((r) => r.direction !== 0).map((r) => String(r.address)));
const rows = [];
for (const addr of Object.keys(map)) {
    for (const kind of ['in', 'hold']) {
        if ((kind === 'in' ? appIn : appHold).has(addr)) continue;
        let title;
        let count = 0;
        for (const m of models) {
            const t = map[addr][m]?.[kind];
            if (!t) continue;
            count++;
            if (!title && named(t)) title = t;
        }
        if (count && title) rows.push({addr: Number(addr), kind, title, count});
    }
}
rows.sort((a, b) => b.count - a.count || a.addr - b.addr);
const shown = showAll ? rows : rows.filter((r) => r.count >= Math.ceil(models.length / 2));
console.log(`\n=== Registers in the CSVs but not mapped in registers.ts `
    + `(${showAll ? 'all named' : `in ≥${Math.ceil(models.length / 2)} models; --all for full list`}) ===`);
for (const r of shown)
    console.log(`  ${String(r.addr).padEnd(6)} ${r.kind.padEnd(4)} ${r.title}  [${r.count}/${models.length}]`);
console.log(`  ${shown.length} shown / ${rows.length} total unmapped.`);
