import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {errorEntry, KEEP, readJournal, record} from '../lib/crash-journal';

test('the crash journal keeps the last entries, survives a broken file and never throws', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cj-')), 'j.json');
    assert.deepEqual(readJournal(file), []);
    fs.writeFileSync(file, '{not json');
    assert.deepEqual(readJournal(file), []);
    for (let i = 0; i < KEEP + 5; i++) record({kind: 'start'}, file, new Date(i * 1000));
    const entries = readJournal(file);
    assert.equal(entries.length, KEEP);
    assert.equal(entries[0].at, new Date(5000).toISOString());
    record(errorEntry('uncaught', new Error('boom')), file);
    const last = readJournal(file).at(-1)!;
    assert.equal(last.kind, 'uncaught');
    assert.equal(last.message, 'boom');
    assert.match(last.stack!, /boom/);
    assert.doesNotThrow(() => record({kind: 'start'}, '/nonexistent-dir/x.json'));
});
