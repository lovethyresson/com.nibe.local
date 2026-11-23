import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {join} from 'node:path';

// Autopilot's mark (a gradient ring turning around a sparkle) means "Autopilot runs this": on the
// Nibe Live tiles it runs, beside Autopilot in setup, and as the status tile's icon. Not on every
// Autopilot widget's heading, where it says nothing new (owner, 2026-11-23). A widget page cannot
// load another's files, so a widget that shows it carries its own copy: the copies must match.
const ROOT = join(__dirname, '..');
const between = (s: string, from: string, to: string) => {
    const a = s.indexOf(from), b = s.indexOf(to, a);
    return a < 0 || b < 0 ? undefined : s.slice(a, b);
};
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const WIDGETS = ['overview'];

test('the mark is the same wherever it shows, and only where it says Autopilot runs something', () => {
    const snippets = WIDGETS.map((w) => between(readFileSync(join(ROOT, 'widgets', w, 'public', 'index.html'), 'utf8'),
        '<!-- autopilot-mark:start', '<!-- autopilot-mark:end')!);
    for (const [k, s] of snippets.entries()) assert.ok(s, `${WIDGETS[k]}: no mark`);
    const css = squash(between(snippets[0], '<style>', '</style>')!.replace('<style>', ''));
    const fn = squash(between(snippets[0], 'var AP_MARK_N', '</script>')!);
    for (const s of snippets) assert.equal(s, snippets[0]);
    const pairCss = squash(between(readFileSync(join(ROOT, 'assets/pair/pair.css'), 'utf8'), '/* autopilot-mark:start', '/* autopilot-mark:end')!);
    assert.ok(pairCss.endsWith(css), 'pair.css has the same style');
    const setup = squash(between(readFileSync(join(ROOT, 'assets/pair/setup.js'), 'utf8'), '// autopilot-mark:start', '// autopilot-mark:end')!);
    assert.ok(setup.includes(fn), 'setup.js has the same function');
    for (const w of readdirSync(join(ROOT, 'widgets'))) {
        const page = join(ROOT, 'widgets', w, 'public', 'index.html');
        if (existsSync(page) && readFileSync(page, 'utf8').includes('apMark(')) assert.ok(WIDGETS.includes(w), `${w} shows the mark: say why, then add it`);
    }
});
