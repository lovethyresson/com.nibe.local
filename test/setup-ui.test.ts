import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const {JSDOM} = require('jsdom');
const english = JSON.parse(readFileSync('locales/en.json', 'utf8'));
function fixture(mode = 'pair', role = 'hotwater', zoneCount = 0, storedZone?: number, extra: {context?: any; results?: any} = {}) {
    const dom = new JSDOM(readFileSync(mode === 'pair' ? 'drivers/nibe_s/pair/devices.html' : 'drivers/nibe_s/repair/features.html', 'utf8'), {runScripts: 'outside-only'});
    const win = dom.window;
    const created: any[] = []; const emitted: any[] = [];
    const sources = [{address: 116, label: 'Climate system 1', value: 22}, {address: 26, label: 'BT50', value: 21}];
    const tanks = {minLitres: 20, maxLitres: 1000, tanks: [{id: 'vpb', litres: 180, name: 'VPB 200'}]};
    const zones = Array.from({length: zoneCount}, (_, i) => ({address: 2505 + 2 * i, label: 'Zone ' + (i + 1), value: 20 + i}));
    const group = {id: 'heating', name: 'Heating', selected: true,
        caps: [{name: 'measure_temperature', title: 'Indoor temperature', detected: true},
            {name: 'target_temperature', title: 'Target temperature', detected: true}],
        registers: [{name: 'measure_temperature', title: 'Indoor temperature'}, {name: 'target_temperature', title: 'Target temperature'}]};
    const heatingChoices = zoneCount ? {measure_temperature: sources, target_temperature: zones} : {measure_temperature: sources};
    const candidates = ['heating', 'hotwater'].map((role, i) => ({role, name: role, description: role + ' description', detected: true,
        device: {name: role, data: {id: role}, store: {selection: {addresses: {measure_temperature: 116}}}},
        groups: [group], choices: i ? {} : heatingChoices, tanks: i ? tanks : null}));
    win.Homey = {__: (key: string) => key.split('.').reduce((o: any, k: string) => o?.[k], english) ?? key,
        setTitle() {}, showLoadingOverlay() {}, hideLoadingOverlay() {}, done() {}, alert(message: string) { throw new Error(message); },
        createDevice: async (d: any) => { created.push(d); },
        emit(name: string, data: any, callback: any) {
            emitted.push({name, data});
            const results: any = {...extra.results, get_context: {...extra.context, mode, role, groups: [group], tanks,
                selection: {groups: {heating: true}, hotwater: {tankId: 'custom', litres: 275, inletC: 9},
                    addresses: storedZone ? {target_temperature: storedZone} : {}}},
                get_indoor_sensors: Array.from({length: 30}, (_, i) => ({deviceId: 'sensor' + i, capabilityId: 'measure_temperature', name: 'Sensor ' + i, room: i < 15 ? 'Home / Ground floor' : 'Home / Upstairs', type: 'sensor', app: 'test', value: 20 + i / 10, available: true, updatedAt: Date.now()})),
                activate_indoor: {measured: 21},
                validate_indoor_sensors: {config: {...data, state: 'pending'}, value: 21},
                get_pairing_devices: candidates, get_detection: {choices: heatingChoices}};
            callback(null, results[name]);
        }};
    win.document.querySelectorAll('[data-i18n]').forEach((n: any) => { n.textContent = win.Homey.__(n.dataset.i18n); });
    const previousView = win.document.createElement('div'); previousView.hidden = true;
    previousView.innerHTML = '<div class="pair-hero"><div class="pair-hero-title">Previous view</div><p class="pair-hero-sub">Previous intro</p></div><form></form>';
    win.document.body.prepend(previousView);
    for (const file of ['setup', 'tank', mode === 'pair' ? 'devices' : 'features'])
        win.eval(readFileSync('assets/pair/' + file + '.js', 'utf8'));
    const click = (text: string) => {
        const b = [...win.document.querySelectorAll('button')].find((n: any) => n.textContent === text && !n.closest('[hidden]') && n.style.display !== 'none') as any;
        assert.ok(b, 'Visible button: ' + text); assert.equal(b.disabled, false, text + ' should be enabled'); b.click();
    };
    const menu = (text: string) => {
        const b = [...win.document.querySelectorAll('.setup-menu')].find((n: any) => n.textContent.includes(text)) as any;
        assert.ok(b); b.click();
    };
    return {win, dom, click, menu, created, emitted};
}
test('pairing preserves native source and custom tank through overview and Back, commits only at final review', async () => {
    const f = fixture(); const {win, click, menu} = f;
    click('Continue'); menu('Heating Setup');
    const source = win.document.querySelector('input[data-source][value="26"]'); source.checked = true;
    click('Save setup'); menu('Hot Water Setup');
    const tank = win.document.querySelector('#pair1-tank');
    assert.ok([...tank.options].some((o: any) => o.textContent.includes('VPB 200')));
    tank.value = 'custom'; tank.dispatchEvent(new win.Event('change'));
    win.document.querySelector('#pair1-litres').value = '275';
    click('Save setup'); click('Back');
    assert.equal(f.created.length, 0);
    click('Continue'); menu('Hot Water Setup');
    assert.equal(win.document.querySelector('#pair1-litres').value, '275');
    click('Save setup'); click('Review setup');
    assert.equal(win.document.querySelectorAll('#analytics-consent').length, 1);
    click('Add selected devices'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.created.length, 2);
    assert.equal(f.created[0].store.selection.addresses.measure_temperature, 26);
    assert.equal(f.created[1].store.selection.hotwater.litres, 275);
    assert.equal(f.emitted.some(e => e.name === 'activate_indoor'), false);
    f.dom.window.close();
});
test('hot water Repair retains catalogue and custom tank without saving when navigating', () => {
    const f = fixture('repair'); f.click('Continue'); f.menu('Hot Water Setup');
    assert.equal(f.win.document.querySelector('#repair-tank').value, 'custom');
    assert.equal(f.win.document.querySelector('#repair-litres').value, '275');
    f.click('Back'); assert.equal(f.emitted.some(e => e.name === 'selection_done'), false);
    f.menu('Hot Water Setup'); f.click('Save setup'); f.click('Save changes');
    const saved = f.emitted.find(e => e.name === 'selection_done');
    assert.ok(saved); assert.equal(saved.data.hotwater.litres, 275);
    f.dom.window.close();
});

test('Homey picker is search-first, preserves selections across searches, and pairs a pending feed without writes', async () => {
    const f = fixture(); const {win, click, menu} = f;
    click('Continue'); menu('Heating Setup');
    const homey = win.document.querySelectorAll('input[name="temperature-mode"]')[1]; homey.click();
    click('Choose sensors'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(win.document.querySelectorAll('.setup-sensor').length, 0);
    click('Show all sensors');
    assert.equal(win.document.querySelectorAll('.setup-sensor').length, 8);
    win.document.querySelector('.setup-sensor input').click();
    const search = win.document.querySelector('input[type=search]');
    search.value = 'Sensor 29'; search.dispatchEvent(new win.Event('input'));
    assert.equal(win.document.querySelectorAll('.setup-sensor').length, 1);
    win.document.querySelector('.setup-sensor input').click();
    click('Review sensors'); await new Promise(resolve => setImmediate(resolve));
    click('Save setup'); menu('Hot Water Setup'); click('Save setup'); click('Review setup');
    click('Add selected devices'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.created[0].store.indoorSensors.state, 'pending');
    assert.deepEqual(Array.from(f.created[0].store.indoorSensors.sensors, (s: any) => s.deviceId), ['sensor0', 'sensor29']);
    assert.equal(f.emitted.some(e => e.name === 'activate_indoor'), false);
    f.dom.window.close();
});

test('temperature source choices explain which sensors supply the reading', () => {
    const f = fixture(); f.click('Continue'); f.menu('Heating Setup');
    const doc = f.win.document.getElementById('nibe-pair-setup');
    const cards = doc.querySelectorAll('.setup-source-card');
    assert.equal(cards.length, 2);
    assert.match(cards[0].textContent, /your device’s own temperature sensor/);
    assert.match(cards[1].textContent, /own Homey temperature sensors/);
    assert.ok(cards[1].contains(doc.querySelector('.setup-source-description')));
    assert.equal(doc.querySelector('.pair-hero-title').textContent, 'Choose your temperature source');
    f.dom.window.close();
});

test('review failures appear beside the action and leave a working retry button', async () => {
    const f = fixture(); f.click('Continue'); f.menu('Heating Setup');
    f.win.document.querySelectorAll('input[name="temperature-mode"]')[1].click();
    f.click('Choose sensors'); await new Promise(resolve => setImmediate(resolve));
    f.click('Show all sensors'); f.win.document.querySelector('.setup-sensor input').click();
    assert.ok(f.win.document.querySelector('.setup-chip'));
    const originalEmit = f.win.Homey.emit;
    f.win.Homey.emit = (name: string, data: any, callback: any) => {
        if (name === 'validate_indoor_sensors') callback({message: 'A selected sensor is unavailable.'});
        else originalEmit(name, data, callback);
    };
    f.click('Review sensors'); await new Promise(resolve => setImmediate(resolve));
    const error = f.win.document.querySelector('.setup-error');
    assert.match(error.textContent, /unavailable/);
    assert.equal(error.nextElementSibling.textContent, 'Review sensors');
    assert.equal(error.nextElementSibling.disabled, false);
    f.win.Homey.emit = originalEmit;
    f.click('Review sensors'); await new Promise(resolve => setImmediate(resolve));
    assert.match(f.win.document.querySelector('.setup-shell').textContent, /Average|Temperature to send/);
    f.dom.window.close();
});

test('pump instructions are grouped and successful verification celebrates confirmed receipt', async () => {
    const f = fixture('repair', 'heating'); f.click('Continue'); f.menu('Heating Setup');
    f.win.document.querySelectorAll('input[name="temperature-mode"]')[1].click();
    f.click('Choose sensors'); await new Promise(resolve => setImmediate(resolve));
    f.click('Show all sensors'); f.win.document.querySelector('.setup-sensor input').click();
    f.click('Review sensors'); await new Promise(resolve => setImmediate(resolve));
    f.click('Set up your device');
    const groups = f.win.document.querySelectorAll('.setup-task-group');
    assert.equal(groups.length, 2);
    assert.equal(groups[0].querySelectorAll('li strong').length, 3);
    assert.equal(groups[1].querySelector('details').open, false);
    groups[1].querySelector('input').click(); f.click('Verify settings');
    await new Promise(resolve => setImmediate(resolve));
    const success = f.win.document.querySelector('.setup-success');
    assert.ok(success); assert.match(success.textContent, /You’re all set!/);
    assert.match(success.textContent, /21 °C/); assert.match(success.textContent, /1 sensor connected/);
    f.click('Continue'); assert.ok(f.win.document.querySelector('.setup-menu'));
    f.dom.window.close();
});

test('pairing asks for the thermostat zone as its own step, with nothing preselected', async () => {
    const f = fixture('pair', 'hotwater', 2); const {win, click, menu} = f;
    click('Continue'); menu('Heating Setup');
    const doc = win.document.getElementById('nibe-pair-setup');
    assert.equal(doc.querySelector('.pair-hero-title').textContent, 'Which zone should the thermostat set?');
    const cards = doc.querySelectorAll('.setup-shell .setup-source-card');
    assert.equal(cards.length, 2);
    assert.match(cards[1].textContent, /Zone 2.*Target 21 °C/);
    assert.equal(doc.querySelector('input[data-source="target_temperature"]:checked'), null, 'no silent zone 1 default');
    const next = [...doc.querySelectorAll('.setup-shell button')].find((b: any) => b.textContent === 'Continue') as any;
    assert.equal(next.disabled, true);
    const zone2 = doc.querySelector('input[data-source="target_temperature"][value="2507"]');
    zone2.click();
    assert.equal(next.disabled, false);
    assert.ok(cards[1].classList.contains('is-selected'));
    click('Continue');
    assert.equal(doc.querySelector('.pair-hero-title').textContent, 'Choose your temperature source');
    assert.equal(doc.querySelector('.setup-shell input[data-source="target_temperature"]'), null, 'zone not repeated');
    click('Back');
    assert.equal(doc.querySelector('input[data-source="target_temperature"]:checked').value, '2507', 'Back keeps the pick');
    click('Continue'); click('Save setup'); menu('Hot Water Setup'); click('Save setup'); click('Review setup');
    assert.match(doc.querySelector('.setup-shell').textContent, /the thermostat sets Zone 2/);
    click('Add selected devices'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.created[0].store.selection.addresses.target_temperature, 2507);
    f.dom.window.close();
});

test('Repair preselects the stored zone and saves a new pick; a single zone skips the step', () => {
    const f = fixture('repair', 'heating', 3);
    f.click('Continue'); f.menu('Heating Setup');
    const doc = f.win.document.getElementById('nibe-repair-setup');
    assert.equal(doc.querySelector('.pair-hero-title').textContent, 'Which zone should the thermostat set?');
    doc.querySelector('input[data-source="target_temperature"][value="2509"]').click();
    f.click('Continue'); f.click('Save setup'); f.menu('Hot Water Setup'); f.click('Save setup'); f.click('Save changes');
    const saved = f.emitted.find(e => e.name === 'selection_done');
    assert.equal(saved.data.sources.target_temperature, 2509);
    f.dom.window.close();

    const again = fixture('repair', 'heating', 3, 2507);
    again.click('Continue'); again.menu('Heating Setup');
    assert.equal(again.win.document.querySelector('input[data-source="target_temperature"]:checked').value, '2507');
    again.dom.window.close();

    const one = fixture('repair', 'heating', 1); one.click('Continue'); one.menu('Heating Setup');
    assert.equal(one.win.document.getElementById('nibe-repair-setup').querySelector('.pair-hero-title').textContent, 'Choose your temperature source');
    assert.equal(one.win.document.querySelector('input[data-source="target_temperature"]'), null);
    one.dom.window.close();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const NO_SOLAR = {meters: [], meter: null, solar: [], followsSun: false, peakKw: null, panels: null};
async function hotwaterSmart(status: any, scan: any = NO_SOLAR) {
    const f = fixture('repair', 'hotwater', 0, undefined, {context: {smart: true},
        results: {smart_status: {role: 'hotwater', mode: 'off', spa: true, spaOn: false, autopilot: true, tank: true,
            starterDays: 14, household: null, ...status}, hotwater_household: true, smart_choose: true,
            solar_scan: scan, solar_save: true}});
    f.click('Continue'); f.menu('Smart mode'); await tick();
    const test = f.win.document.querySelector('input[name="smart-choice"][value="test"]');
    test.checked = true; test.dispatchEvent(new f.win.Event('change'));
    f.click('Continue'); await tick();
    return f;
}
test('Autopilot hot water setup lists the Flows that switch More hot water, and asks a young home about its household', async () => {
    const f = await hotwaterSmart({flows: [{id: 'a', name: 'Cheap hot water', advanced: true}], historyDays: 3});
    const text = f.win.document.body.textContent;
    assert.ok(text.includes('Cheap hot water'));
    assert.ok(text.includes(english.pair.setup.smart.hw_flows_found));
    assert.ok(text.includes('3 days'));
    const people = f.win.document.querySelector('select[aria-label="' + english.pair.setup.smart.hw_people + '"]');
    people.value = '4'; people.dispatchEvent(new f.win.Event('change'));
    const daytime = f.win.document.querySelector('input[name="hw-free"][value="daytime"]');
    daytime.checked = true; daytime.dispatchEvent(new f.win.Event('change'));
    f.click('Continue'); await tick(); await tick();
    f.click(english.pair.setup.smart.start_test); await tick(); await tick();
    assert.equal(JSON.stringify(f.emitted.find((e) => e.name === 'hotwater_household')?.data), JSON.stringify({people: 4, morningHour: 7, freeDay: 'daytime'}));
    assert.equal(f.emitted.find((e) => e.name === 'smart_choose')?.data?.value, 'test');
    f.dom.window.close();
});
test('a home with enough history is not asked about its household, and no Flows is said plainly', async () => {
    const f = await hotwaterSmart({flows: [], historyDays: 60});
    const text = f.win.document.body.textContent;
    assert.ok(text.includes(english.pair.setup.smart.hw_flows_none));
    assert.ok(!text.includes(english.pair.setup.smart.hw_household));
    f.click('Continue'); await tick(); await tick();
    f.click(english.pair.setup.smart.start_test); await tick(); await tick();
    assert.equal(f.emitted.some((e) => e.name === 'hotwater_household'), false);
    assert.equal(f.emitted.find((e) => e.name === 'smart_choose')?.data?.value, 'test');
    f.dom.window.close();
});

test('the Solar step shows the meter and panels it found and asks to heat with them, on by default', async () => {
    const f = await hotwaterSmart({flows: [], historyDays: 60}, {meters: [{id: 'p1', name: 'P1 Meter', w: -1200}], meter: 'p1',
        solar: [{id: 'se', name: 'SolarEdge', w: 3400}], followsSun: true, peakKw: 2.4, panels: null});
    f.click('Continue'); await tick(); await tick();
    const text = f.win.document.body.textContent;
    const s = english.pair.setup.smart;
    assert.ok(text.includes('P1 Meter · 1.2 kW') && text.includes('SolarEdge · 3.4 kW'), text);
    assert.ok(text.includes(s.solar_evidence.replace('__kw__', '2.4')));
    assert.ok(text.includes(s.solar_use) && text.includes(s.solar_how));
    f.click(s.start_test); await tick(); await tick();
    assert.equal(JSON.stringify(f.emitted.find((e) => e.name === 'solar_save')?.data), JSON.stringify({panels: true, meter: 'p1'}));
    f.dom.window.close();
});

test('with nothing found the Solar step asks, and a yes without a meter says what to add', async () => {
    const f = await hotwaterSmart({flows: [], historyDays: 60});
    f.click('Continue'); await tick(); await tick();
    const s = english.pair.setup.smart;
    let text = f.win.document.body.textContent;
    assert.ok(text.includes(s.solar_have) && text.includes(s.solar_meter_none) && !text.includes(s.solar_need_meter));
    const yes = f.win.document.querySelector('input[name="solar-answer"][value="yes"]');
    yes.checked = true; yes.dispatchEvent(new f.win.Event('change'));
    text = f.win.document.body.textContent;
    assert.ok(text.includes(s.solar_need_meter));
    f.click(s.start_test); await tick(); await tick();
    assert.equal(JSON.stringify(f.emitted.find((e) => e.name === 'solar_save')?.data), JSON.stringify({panels: true}));
    f.dom.window.close();
});

test('several grid meters: the owner picks the one for the whole home', async () => {
    const f = await hotwaterSmart({flows: [], historyDays: 60}, {meters: [{id: 'a', name: 'Grid Sensor', w: 5869}, {id: 'b', name: 'Home', w: 5883}],
        meter: 'a', solar: [], followsSun: false, peakKw: null, panels: false});
    f.click('Continue'); await tick(); await tick();
    const s = english.pair.setup.smart;
    const pick = f.win.document.querySelector('select[aria-label="' + s.solar_meter + '"]');
    assert.ok(pick && f.win.document.body.textContent.includes(s.solar_meter_pick));
    pick.value = 'b'; pick.dispatchEvent(new f.win.Event('change'));
    f.click(s.start_test); await tick(); await tick();
    assert.equal(JSON.stringify(f.emitted.find((e) => e.name === 'solar_save')?.data), JSON.stringify({panels: false, meter: 'b'}), 'a saved no is kept');
    f.dom.window.close();
});
