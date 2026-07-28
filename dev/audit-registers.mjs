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

// The profile is optional: it only feeds the engine-critical check below, and loading it pulls
// in the compose JSON, so a partial build shouldn't take the whole audit down.
let profile;
try {
    ({sProfile: profile} = require(join(root, '.homeybuild/drivers/nibe_s/profile.js')));
} catch {
    console.error('(profile not loadable — skipping the engine-critical register check)');
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

// The CSVs ship two different encodings of the "Size of variable" column. The older exports
// (s1155_s1255, s1156_s1256, s735) spell the type out — u8/s8/u16/s16/u32/s32. The newer ones
// (s320_s325, s330_s332, s2125) use a numeric code instead. The mapping below was derived by
// comparing registers that appear in both styles: 1028 Priority is u8 there / 4 here, register
// 1 (outdoor temp) is s16 / 2, and 1575 (hot water energy) is u32 / 6.
const SIZE_CODES = {1: 's8', 2: 's16', 3: 's32', 4: 'u8', 5: 'u16', 6: 'u32'};

// Register width in bits, or undefined when the column is blank/unrecognised.
function bitsOf(raw) {
    const cell = (raw ?? '').trim();
    if (!cell || cell === '-') return undefined;
    const type = SIZE_CODES[cell] ?? cell;
    const m = /^[us](8|16|32)$/.exec(type);
    return m ? Number(m[1]) : undefined;
}

// address -> model -> {in, hold} title, plus {inBits, holdBits}
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
        if (type === 'MODBUS_INPUT_REGISTER') {
            map[addr][model].in = title.trim();
            map[addr][model].inBits = bitsOf(c[5]);
        }
        if (type === 'MODBUS_HOLDING_REGISTER') {
            map[addr][model].hold = title.trim();
            map[addr][model].holdBits = bitsOf(c[5]);
        }
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

// 3) Per-model coverage (mapped in registers.ts, absent from a model's CSV).
//
// This is the check that was missing when the app shipped with register 2166 "Instantaneous
// used power" as its ONLY power source: 2166 does not exist on S320/S325, S330/S332 or S2125,
// so on those models the energy allocator had nothing to integrate and every per-function
// meter and COP stayed empty. The old audit only looked the other way (CSV -> app), so
// nothing flagged it. A register absent on some models is normal and expected for a superset
// table — what matters is knowing WHICH, especially for anything the engine depends on.
const kindOf = (r) => (r.direction === 0 ? 'in' : 'hold');
console.log(`\n=== Per-model coverage: app registers absent from each model ===`);
const absentByModel = {};
for (const m of models)
    absentByModel[m] = registers.filter((r) => !map[String(r.address)]?.[m]?.[kindOf(r)]);
for (const m of models)
    console.log(`  ${m.padEnd(16)} ${String(absentByModel[m].length).padStart(3)} / ${registers.length} absent`);
for (const m of models) {
    if (!absentByModel[m].length) continue;
    console.log(`\n  --- ${m} ---`);
    for (const r of absentByModel[m])
        console.log(`    ${String(r.address).padEnd(6)} ${kindOf(r).padEnd(4)} ${r.name}`);
}

// Registers the engine cannot work without get called out separately: losing one of these on
// a model is a silent feature outage, not a missing sensor.
const role = profile?.role ?? {};
const critical = [
    ...(role.powerSources ?? []).flat(),
    role.priorityRegisterName,
    role.totalProductionRegister,
    role.totalConsumptionRegister,
    ...Object.values(role.producedRegisterForRole ?? {}),
    ...Object.values(role.primaryOnoff ?? {})
].filter((name) => name && name !== 'onoff');
console.log(`\n=== Engine-critical registers missing per model ===`);
let criticalHits = 0;
for (const name of [...new Set(critical)]) {
    const reg = registers.find((r) => r.name === name);
    if (!reg) continue;
    const missing = models.filter((m) => !map[String(reg.address)]?.[m]?.[kindOf(reg)]);
    if (!missing.length) continue;
    criticalHits++;
    console.log(`  ${String(reg.address).padEnd(6)} ${name}\n      absent on: ${missing.join(', ')}`);
}
console.log(criticalHits
    ? `  ${criticalHits} engine-critical register(s) unavailable on some models — each needs a`
      + ` fallback, or the\n  feature it drives must be detected as unsupported (see extraCapabilities).`
    : '  none — every engine-critical register exists on all models');

// 4) Declared width cross-check. Modbus reads whole 16-bit words, so u8/s8/u16/s16 all sit in
// the app's default 16-bit register; only 32-bit values span two words and must carry
// `size: 32`. Getting this wrong silently truncates a counter to its low word.
console.log(`\n=== Declared size vs CSV width ===`);
let widthIssues = 0;
for (const r of registers) {
    const declared = r.size === 32 ? 32 : 16;
    for (const m of models) {
        const bits = map[String(r.address)]?.[m]?.[kindOf(r) === 'in' ? 'inBits' : 'holdBits'];
        if (bits === undefined) continue;
        const expected = bits === 32 ? 32 : 16;
        if (expected === declared) continue;
        widthIssues++;
        console.log(`  MISMATCH ${String(r.address).padEnd(6)} ${r.name}: `
            + `declared ${declared}-bit, ${m} says ${bits}-bit`);
    }
}
console.log(widthIssues ? `  ${widthIssues} mismatch(es) — a 32-bit value read as 16-bit truncates.`
    : '  none — every mapped register matches the CSV width on every model');
