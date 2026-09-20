import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const {JSDOM} = require('jsdom');
const english = JSON.parse(readFileSync('locales/en.json', 'utf8'));
function fixture(mode = 'pair', role = 'hotwater') {
    const dom = new JSDOM(readFileSync(mode === 'pair' ? 'drivers/nibe_s/pair/devices.html' : 'drivers/nibe_s/repair/features.html', 'utf8'), {runScripts: 'outside-only'});
    const win = dom.window;
    const created: any[] = []; const emitted: any[] = [];
    const sources = [{address: 116, label: 'Climate system 1', value: 22}, {address: 26, label: 'BT50', value: 21}];
    const tanks = {minLitres: 20, maxLitres: 1000, tanks: [{id: 'vpb', litres: 180, name: 'VPB 200'}]};
    const group = {id: 'heating', name: 'Heating', selected: true,
        caps: [{name: 'measure_temperature', title: 'Indoor temperature', detected: true}],
        registers: [{name: 'measure_temperature', title: 'Indoor temperature'}]};
    const candidates = ['heating', 'hotwater'].map((role, i) => ({role, name: role, description: role + ' description', detected: true,
        device: {name: role, data: {id: role}, store: {selection: {addresses: {measure_temperature: 116}}}},
        groups: [group], choices: i ? {} : {measure_temperature: sources}, tanks: i ? tanks : null}));
    win.Homey = {__: (key: string) => key.split('.').reduce((o: any, k: string) => o?.[k], english) ?? key,
        setTitle() {}, showLoadingOverlay() {}, hideLoadingOverlay() {}, done() {}, alert(message: string) { throw new Error(message); },
        createDevice: async (d: any) => { created.push(d); },
        emit(name: string, data: any, callback: any) {
            emitted.push({name, data});
            const results: any = {get_context: {mode, role, groups: [group], tanks,
                selection: {groups: {heating: true}, hotwater: {tankId: 'custom', litres: 275, inletC: 9}}},
                get_indoor_sensors: Array.from({length: 30}, (_, i) => ({deviceId: 'sensor' + i, capabilityId: 'measure_temperature', name: 'Sensor ' + i, room: i < 15 ? 'Home / Ground floor' : 'Home / Upstairs', type: 'sensor', app: 'test', value: 20 + i / 10, available: true, updatedAt: Date.now()})),
                activate_indoor: {measured: 21},
                validate_indoor_sensors: {config: {...data, state: 'pending'}, value: 21},
                get_pairing_devices: candidates, get_detection: {choices: {measure_temperature: sources}}};
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
    assert.match(cards[0].textContent, /heat pump’s native temperature sensor/);
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
    f.click('Setup your heat pump');
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
