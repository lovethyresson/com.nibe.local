import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Announcement, CURRENT_ANNOUNCEMENT, ANNOUNCEMENT_SETTING, announcementDevices, announceRelease, deliverAnnouncement} from '../lib/release-announcements';

const announcement: Announcement = {id: 'feature-release', snippets: [
    {driverIds: ['nibe_s'], roles: ['hotwater'], text: {en: 'Hot water setup', sv: 'Varmvatten'}},
    {driverIds: ['nibe_s'], roles: ['heating'], text: {en: 'Heating setup', sv: 'Värme'}}
]};
const devices = [{driverId: 'nibe_s', role: 'hotwater'}, {driverId: 'nibe_s', role: 'heating'}];
function harness() {
    const values = new Map<string, unknown>();
    const messages: string[] = [];
    return {values, messages, settings: {
        get: (key: string) => values.get(key),
        set: (key: string, value: string[]) => { values.set(key, value); }
    }, notifications: {createNotification: async ({excerpt}: {excerpt: string}) => { messages.push(excerpt); }}};
}

test('combines relevant snippets once, localizes, and does not repeat after restart', async () => {
    const h = harness();
    await deliverAnnouncement(h, announcement, [...devices, ...devices], 'sv');
    await deliverAnnouncement(h, announcement, devices, 'sv');
    assert.deepEqual(h.messages, ['Varmvatten\n\nVärme']);
});

test('filters driver and role together and falls back to English', async () => {
    const h = harness();
    await deliverAnnouncement(h, announcement, [devices[0], {driverId: 'nibe_f', role: 'heating'}], 'de');
    assert.deepEqual(h.messages, ['Hot water setup']);
});

test('fresh install and irrelevant devices consume news without later replay', async () => {
    for (const paired of [[], [{driverId: 'nibe_f', role: 'hotwater'}]]) {
        const h = harness();
        await deliverAnnouncement(h, announcement, paired, 'en');
        await deliverAnnouncement(h, announcement, devices, 'en');
        assert.deepEqual(h.messages, []);
        assert.deepEqual(h.values.get(ANNOUNCEMENT_SETTING), ['feature-release']);
    }
});

test('failed delivery remains eligible for next startup', async () => {
    const h = harness();
    const failing = {...h, notifications: {createNotification: async () => { throw new Error('offline'); }}};
    await assert.rejects(deliverAnnouncement(failing, announcement, devices, 'en'), /offline/);
    assert.equal(h.values.has(ANNOUNCEMENT_SETTING), false);
    await deliverAnnouncement(h, announcement, devices, 'en');
    assert.equal(h.messages.length, 1);
});

test('only current news is sent; retained IDs prevent replay after downgrade', async () => {
    const h = harness();
    await deliverAnnouncement(h, announcement, devices, 'en');
    const latest = {...announcement, id: 'latest'};
    await deliverAnnouncement(h, latest, devices, 'en');
    await deliverAnnouncement(h, announcement, devices, 'en');
    assert.equal(h.messages.length, 2);
});

test('disabled announcements leave state untouched', async () => {
    const h = harness();
    await deliverAnnouncement(h, null, devices, 'en');
    assert.equal(h.values.size, 0);
    assert.equal(h.messages.length, 0);
});


test('startup uses persisted inventory even before SDK drivers exist', async () => {
    const h = harness();
    const homey = {...h, manifest: {id: 'com.nibe.local'}, i18n: {getLanguage: () => 'en'}};
    await announceRelease(homey as unknown as Parameters<typeof announceRelease>[0], announcement,
        async () => ({one: {driverId: 'homey:app:com.nibe.local:nibe_s', data: {role: 'hotwater'}}}));
    assert.deepEqual(h.messages, ['Hot water setup']);
});

test('inventory recognizes both Homey device ID formats and excludes other apps', () => {
    assert.deepEqual(announcementDevices({
        one: {driverId: 'homey:app:com.nibe.local:nibe_s', data: {role: 'hotwater'}},
        two: {driverUri: 'homey:app:com.nibe.local', driverId: 'nibe_s', data: {role: 'heating'}},
        other: {driverId: 'homey:app:another.app:nibe_s', data: {role: 'hotwater'}}
    }, 'com.nibe.local'), devices);
});

test('failed inventory does not silently consume an announcement', async () => {
    const h = harness();
    await assert.rejects(announceRelease(h as unknown as Parameters<typeof announceRelease>[0], announcement,
        async () => { throw new Error('inventory unavailable'); }), /inventory unavailable/);
    assert.equal(h.values.size, 0);
});

test('disabled startup never touches Homey services', async () => {
    await announceRelease({} as Parameters<typeof announceRelease>[0], null);
});


test('1.3.3 announcement is S-series only and translated in all supported languages', () => {
    assert.equal(CURRENT_ANNOUNCEMENT?.id, '1.3.3-setup-tips');
    assert.equal(CURRENT_ANNOUNCEMENT?.snippets.length, 2);
    for (const snippet of CURRENT_ANNOUNCEMENT!.snippets) {
        assert.deepEqual(snippet.driverIds, ['nibe_s']);
        for (const language of ['en', 'sv', 'de', 'nl', 'no', 'da']) {
            assert.ok(snippet.text[language]?.trim());
        }
    }
});
