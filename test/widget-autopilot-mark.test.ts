import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {join} from 'node:path';

// Autopilot's mark (a gradient ring turning around a sparkle) is introduced where Autopilot is a
// choice, setup's Smart mode and comparison, and is the Autopilot status tile's icon. Not in the
// widgets: there it felt forced (owner, 2026-11-23).
const ROOT = join(__dirname, '..');
const between = (s: string, from: string, to: string) => {
    const a = s.indexOf(from), b = s.indexOf(to, a);
    return a < 0 || b < 0 ? undefined : s.slice(a, b);
};

test('the mark lives in setup only: its style in pair.css and its function in setup.js', () => {
    assert.ok(between(readFileSync(join(ROOT, 'assets/pair/pair.css'), 'utf8'), '/* autopilot-mark:start', '/* autopilot-mark:end'));
    const setup = readFileSync(join(ROOT, 'assets/pair/setup.js'), 'utf8');
    assert.ok(between(setup, '// autopilot-mark:start', '// autopilot-mark:end')?.includes('function apMark('));
    for (const w of readdirSync(join(ROOT, 'widgets'))) {
        const page = join(ROOT, 'widgets', w, 'public', 'index.html');
        if (existsSync(page)) assert.ok(!readFileSync(page, 'utf8').includes('apMark('), `${w}: no mark in widgets`);
    }
});
