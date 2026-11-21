/** Kept Intl formatters (lib/intl.ts): the same text as the built-ins, one formatter per key. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dateFormat, localeDate, localeTime, numberFormat} from '../lib/intl';

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
