// Audit the curated F table against locally downloaded exports. No upstream data is
// bundled. Run: node --import tsx dev/audit-f-registers.mjs
import fs from 'node:fs';
import {registers} from '../drivers/nibe_f/registers.ts';

const models = ['f1145_f1245', 'f1155_f1255', 'f1345', 'f1355', 'f370_f470', 'f730', 'f750'];
// Quoted semicolon CSV, including doubled quotes in fields.
function row(line) {
    const fields = []; let field = ''; let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            if (quoted && line[i + 1] === '"') { field += '"'; i++; }
            else quoted = !quoted;
        } else if (c === ';' && !quoted) { fields.push(field); field = ''; }
        else field += c;
    }
    fields.push(field); return fields;
}
const tables = models.map((model) => {
    const text = fs.readFileSync(new URL(`./csv/${model}.csv`, import.meta.url), 'latin1');
    return {model, rows: new Map(text.split(/\r?\n/).slice(5).map(row)
        .filter((r) => /^\d+$/.test(r[2])).map((r) => [Number(r[2]), r]))};
});
let errors = 0;
for (const register of registers) {
    const found = tables.flatMap(({model, rows}) => rows.has(register.address)
        ? [{model, row: rows.get(register.address)}] : []);
    const signatures = new Set(found.map(({row: r}) => JSON.stringify([r[0], r[3], r[4], r[5]])));
    if (!found.length || signatures.size !== 1) {
        console.error(`Conflicting or missing definition: ${register.address}`, found); errors++; continue;
    }
    const r = found[0].row;
    if (!register.noAction && found.some(({row}) => row[9] !== 'R/W')) {
        console.error(`Control is not writable in every matching export: ${register.address}`); errors++;
    }
    const factor = register.address === 43084 ? Number(r[5]) / 1000 : Number(r[5]);
    if ((register.scale ?? 1) !== factor || register.size !== (r[4].endsWith('32') ? 32 : 16)
        || register.signed !== r[4].startsWith('s')) {
        console.error(`Format mismatch: ${register.address}`, r); errors++;
    }
}
console.log(`${registers.length} mapped registers checked against ${models.length} exports; ${errors} conflicts/errors.`);
process.exitCode = errors ? 1 : 0;
