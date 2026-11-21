/** Kept Intl formatters (lib/intl.ts): the same text as the built-ins, one formatter per key. */
import {test} from 'node:test';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {collator, dateFormat, localeDate, localeTime, numberFormat} from '../lib/intl';

const at = [Date.UTC(2026, 10, 21, 22, 30), Date.UTC(2026, 2, 29, 1, 15), Date.UTC(2026, 9, 25, 0, 45)];

test('the helpers write what toLocaleDateString and toLocaleTimeString write', () => {
    for (const ms of at) for (const timeZone of ['Europe/Stockholm', 'Europe/Amsterdam', 'UTC']) {
        const d = new Date(ms);
        assert.equal(localeDate(ms, 'en-CA', {timeZone}), d.toLocaleDateString('en-CA', {timeZone}));
        assert.equal(localeDate(ms, 'sv', {timeZone, weekday: 'short'}), d.toLocaleDateString('sv', {timeZone, weekday: 'short'}));
        assert.equal(localeDate(ms, 'nl', {timeZone, day: 'numeric', month: 'short'}), d.toLocaleDateString('nl', {timeZone, day: 'numeric', month: 'short'}));
        assert.equal(localeTime(ms, 'sv-SE', {timeZone, hour: '2-digit', minute: '2-digit'}), d.toLocaleTimeString('sv-SE', {timeZone, hour: '2-digit', minute: '2-digit'}));
        assert.equal(localeTime(ms, 'en-GB', {timeZone}), d.toLocaleTimeString('en-GB', {timeZone}));
    }
});

test('one formatter per locale and options, made once', () => {
    const a = dateFormat('en-CA', {timeZone: 'Europe/Stockholm', year: 'numeric'});
    assert.equal(dateFormat('en-CA', {timeZone: 'Europe/Stockholm', year: 'numeric'}), a);
    assert.notEqual(dateFormat('en-CA', {timeZone: 'UTC', year: 'numeric'}), a);
    assert.equal(numberFormat('sv', {maximumFractionDigits: 1}), numberFormat('sv', {maximumFractionDigits: 1}));
    assert.equal(numberFormat('sv', {maximumFractionDigits: 1}).format(2.25), (2.25).toLocaleString('sv', {maximumFractionDigits: 1}));
});

test('a kept collator sorts as localeCompare does', () => {
    const names = ['Övre', 'arbetsrum', 'Ångbastu', 'Zon', 'äng'];
    assert.deepEqual([...names].sort(collator('sv').compare), [...names].sort((a, b) => a.localeCompare(b, 'sv')));
});

test('the app makes no Intl object outside lib/intl.ts: each holds native memory the small heap rarely frees', () => {
    const files: string[] = [];
    const walk = (dir: string) => readdirSync(dir).forEach((f) => {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p);
    });
    walk(join(__dirname, '..', 'lib'));
    files.push(join(__dirname, '..', 'app.ts'));
    const offenders = files.filter((f) => !f.endsWith('intl.ts')).flatMap((f) => {
        const src = readFileSync(f, 'utf8');
        return /new Intl\.|\.toLocale(Date|Time)?String\(|\.localeCompare\([^)]*,/.test(src) ? [f] : [];
    });
    assert.deepEqual(offenders, [], 'use lib/intl.ts');
});
