import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {join} from 'node:path';

// Autopilot's mark (the turning gradient ring) is copied into every widget page, since a widget
// page cannot load another's files: the copies must stay one mark.
const ROOT = join(__dirname, '..');
const between = (s: string, from: string, to: string) => {
    const a = s.indexOf(from), b = s.indexOf(to, a);
    return a < 0 || b < 0 ? undefined : s.slice(a, b);
};
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const WIDGETS = ['overview', 'autopilot', 'day_plan', 'savings', 'savings_hotwater', 'getting_started', 'cost_check', 'hotwater_tank', 'hotwater_use'];

test('every Autopilot widget carries the same mark, and setup the same function and style', () => {
    const snippets = WIDGETS.map((w) => {
        const file = join(ROOT, 'widgets', w, 'public', 'index.html');
        assert.ok(existsSync(file), w);
        const s = between(readFileSync(file, 'utf8'), '<!-- autopilot-mark:start', '<!-- autopilot-mark:end');
        assert.ok(s, `${w}: no mark`);
        return s!;
    });
    for (const [k, s] of snippets.entries()) assert.equal(s, snippets[0], `${WIDGETS[k]} differs from ${WIDGETS[0]}`);
    const css = squash(between(snippets[0], '<style>', '</style>')!.replace('<style>', ''));
    const fn = squash(between(snippets[0], 'var AP_MARK_N', '</script>')!);
    const pairCss = squash(between(readFileSync(join(ROOT, 'assets/pair/pair.css'), 'utf8'), '/* autopilot-mark:start', '/* autopilot-mark:end')!);
    assert.ok(pairCss.endsWith(css), 'pair.css has the same style');
    const setup = squash(between(readFileSync(join(ROOT, 'assets/pair/setup.js'), 'utf8'), '// autopilot-mark:start', '// autopilot-mark:end')!);
    assert.ok(setup.includes(fn), 'setup.js has the same function');
    // A widget with Autopilot in it and no mark is one the list above has missed.
    for (const w of readdirSync(join(ROOT, 'widgets'))) {
        const page = join(ROOT, 'widgets', w, 'public', 'index.html');
        if (existsSync(page) && readFileSync(page, 'utf8').includes('apMark(')) assert.ok(WIDGETS.includes(w), `${w} uses the mark: add it to the list`);
    }
});
