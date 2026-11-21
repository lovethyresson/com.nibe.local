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
    click('Continue'); menu('Heating setup');
    const source = win.document.querySelector('input[data-source][value="26"]'); source.checked = true;
    click('Save setup'); menu('Hot water setup');
    const tank = win.document.querySelector('#pair1-tank');
    assert.ok([...tank.options].some((o: any) => o.textContent.includes('VPB 200')));
    tank.value = 'custom'; tank.dispatchEvent(new win.Event('change'));
    win.document.querySelector('#pair1-litres').value = '275';
    click('Save setup'); click('Back');
    assert.equal(f.created.length, 0);
    click('Continue'); menu('Hot water setup');
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
    const f = fixture('repair'); f.click('Continue'); f.menu('Hot water setup');
    assert.equal(f.win.document.querySelector('#repair-tank').value, 'custom');
    assert.equal(f.win.document.querySelector('#repair-litres').value, '275');
    f.click('Back'); assert.equal(f.emitted.some(e => e.name === 'selection_done'), false);
    f.menu('Hot water setup'); f.click('Save setup'); f.click('Save changes');
    // Save changes opens What changes, which asks the driver for the preview; saving is the next click.
    assert.ok(f.emitted.some(e => e.name === 'preview_changes')); assert.equal(f.emitted.some(e => e.name === 'selection_done'), false);
    f.click('Save changes');
    const saved = f.emitted.find(e => e.name === 'selection_done');
    assert.ok(saved); assert.equal(saved.data.hotwater.litres, 275);
    f.dom.window.close();
});

test('Homey picker is search-first, preserves selections across searches, and pairs a pending feed without writes', async () => {
    const f = fixture(); const {win, click, menu} = f;
    click('Continue'); menu('Heating setup');
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
    click('Save setup'); menu('Hot water setup'); click('Save setup'); click('Review setup');
    click('Add selected devices'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.created[0].store.indoorSensors.state, 'pending');
    assert.deepEqual(Array.from(f.created[0].store.indoorSensors.sensors, (s: any) => s.deviceId), ['sensor0', 'sensor29']);
    assert.equal(f.emitted.some(e => e.name === 'activate_indoor'), false);
    f.dom.window.close();
});

test('temperature source choices explain which sensors supply the reading', () => {
    const f = fixture(); f.click('Continue'); f.menu('Heating setup');
    const doc = f.win.document.getElementById('nibe-pair-setup');
    const cards = doc.querySelectorAll('.setup-source-card');
    assert.equal(cards.length, 2);
    assert.match(cards[0].textContent, /your heat pump’s own temperature sensor/);
    assert.match(cards[1].textContent, /own Homey temperature sensors/);
    assert.ok(cards[1].contains(doc.querySelector('.setup-source-description')));
    assert.equal(doc.querySelector('.pair-hero-title').textContent, 'Choose your temperature source');
    f.dom.window.close();
});

test('review failures appear beside the action and leave a working retry button', async () => {
    const f = fixture(); f.click('Continue'); f.menu('Heating setup');
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
    const f = fixture('repair', 'heating'); f.click('Continue'); f.menu('Heating setup');
    f.win.document.querySelectorAll('input[name="temperature-mode"]')[1].click();
    f.click('Choose sensors'); await new Promise(resolve => setImmediate(resolve));
    f.click('Show all sensors'); f.win.document.querySelector('.setup-sensor input').click();
    f.click('Review sensors'); await new Promise(resolve => setImmediate(resolve));
    f.click('Set up your heat pump');
    const groups = f.win.document.querySelectorAll('.setup-task-group');
    assert.equal(groups.length, 2);
    assert.equal(groups[0].querySelectorAll('li strong').length, 3);
    assert.equal(groups[1].querySelector('details').open, false);
    groups[1].querySelector('input').click(); f.click('Verify settings');
    await new Promise(resolve => setImmediate(resolve));
    const success = f.win.document.querySelector('.setup-success');
    assert.ok(success); assert.match(success.textContent, /You’re all set/);
    assert.match(success.textContent, /21 °C/); assert.match(success.textContent, /1 sensor connected/);
    f.click('Continue'); assert.ok(f.win.document.querySelector('.setup-menu'));
    f.dom.window.close();
});

test('pairing asks for the thermostat zone as its own step, with nothing preselected', async () => {
    const f = fixture('pair', 'hotwater', 2); const {win, click, menu} = f;
    click('Continue'); menu('Heating setup');
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
    click('Continue'); click('Save setup'); menu('Hot water setup'); click('Save setup'); click('Review setup');
    assert.match(doc.querySelector('.setup-shell').textContent, /The Heating thermostat sets Zone 2/);
    click('Add selected devices'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.created[0].store.selection.addresses.target_temperature, 2507);
    f.dom.window.close();
});

test('Repair preselects the stored zone and saves a new pick; a single zone skips the step', () => {
    const f = fixture('repair', 'heating', 3);
    f.click('Continue'); f.menu('Heating setup');
    const doc = f.win.document.getElementById('nibe-repair-setup');
    assert.equal(doc.querySelector('.pair-hero-title').textContent, 'Which zone should the thermostat set?');
    doc.querySelector('input[data-source="target_temperature"][value="2509"]').click();
    f.click('Continue'); f.click('Save setup'); f.menu('Hot water setup'); f.click('Save setup'); f.click('Save changes'); f.click('Save changes');
    const saved = f.emitted.find(e => e.name === 'selection_done');
    assert.equal(saved.data.sources.target_temperature, 2509);
    f.dom.window.close();

    const again = fixture('repair', 'heating', 3, 2507);
    again.click('Continue'); again.menu('Heating setup');
    assert.equal(again.win.document.querySelector('input[data-source="target_temperature"]:checked').value, '2507');
    again.dom.window.close();

    const one = fixture('repair', 'heating', 1); one.click('Continue'); one.menu('Heating setup');
    assert.equal(one.win.document.getElementById('nibe-repair-setup').querySelector('.pair-hero-title').textContent, 'Choose your temperature source');
    assert.equal(one.win.document.querySelector('input[data-source="target_temperature"]'), null);
    one.dom.window.close();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const NO_SOLAR = {meters: [], meter: null, solar: [], followsSun: false, peakKw: null, live: null, forecast: null};
async function hotwaterSmart(status: any, scan: any = NO_SOLAR, legionella = false) {
    const f = fixture('repair', 'hotwater', 0, undefined, {context: {smart: true},
        results: {smart_status: {role: 'hotwater', mode: 'off', spa: true, spaOn: false, autopilot: true, tank: true,
            starterDays: 14, household: null, reserve: 40, legionella: null, legionellaPumpC: 60, legionellaDays: 14, ...status},
            hotwater_household: true, hotwater_reserve: true, hotwater_legionella: true, smart_choose: true,
            solar_scan: scan, solar_save: true}});
    // Hot water setup: the tank, then its Smart mode; Autopilot, Simulated.
    f.click('Continue'); f.menu('Hot water setup'); f.click('Continue'); await tick();
    const autopilot = f.win.document.querySelector('input[name="smart-choice"][value="autopilot"]');
    autopilot.checked = true; autopilot.dispatchEvent(new f.win.Event('change'));
    f.click(english.pair.setup.smart.mode_simulated);
    // The choice goes straight on to Legionella, then the hot water checklist; When to charge is
    // a link on the Autopilot choice.
    f.click('Continue'); await tick();
    if (!legionella) {
        assert.ok(f.win.document.body.textContent.includes(english.pair.setup.smart.hw_legionella_title));
        f.click('Continue'); await tick();
    }
    return f;
}

test('Legionella: a heat pump already at 65 °C gives one card, not two the same; every control opts out of Homey styling', async () => {
    const f = await hotwaterSmart({flows: [], historyDays: 60, legionellaPumpC: 65, legionellaDays: 14}, NO_SOLAR, true);
    const cards = [...f.win.document.querySelectorAll('.hwl-card')] as any[];
    assert.equal(cards.length, 2, 'Recommended and Your own');
    // Homey's stylesheet restyles every label, button and input without hy-nostyle (it did, on the phone).
    for (const node of f.win.document.querySelectorAll('.hwl-card, .hwl-card input') as any)
        assert.ok(node.classList.contains('hy-nostyle'), node.outerHTML.slice(0, 60));
    f.dom.window.close();
});

test('When to charge: the segment and the day chips opt out of Homey styling', async () => {
    const f = fixture('repair', 'hotwater', 0, undefined, {context: {smart: true},
        results: {smart_status: {role: 'hotwater', mode: 'off', spa: true, spaOn: false, autopilot: true, tank: true,
            starterDays: 14, household: null, reserve: 40, legionella: null, legionellaPumpC: 60, legionellaDays: 14, flows: [], historyDays: 60},
            hotwater_household: true, hotwater_reserve: true, hotwater_legionella: true, smart_choose: true, solar_scan: NO_SOLAR, solar_save: true}});
    f.click('Continue'); f.menu('Hot water setup'); f.click('Continue'); await tick();
    const autopilot = f.win.document.querySelector('input[name="smart-choice"][value="autopilot"]');
    autopilot.checked = true; autopilot.dispatchEvent(new f.win.Event('change'));
    f.click(english.pair.setup.smart.mode_simulated);
    // When to charge opens from the link on the Autopilot choice, and its button goes back to the choice.
    f.click(english.pair.setup.smart.hw_plan_open + ' ›');
    assert.ok(f.win.document.body.textContent.includes(english.pair.setup.smart.hw_plan_day_work));
    const controls = [...f.win.document.querySelectorAll('.hwp-seg button, .hwp-chips button')] as any[];
    assert.equal(controls.length, 6);
    assert.ok(controls.every((b) => b.classList.contains('hy-nostyle')));
    f.click(english.pair.setup.smart.hw_plan_back); await tick();
    assert.ok(f.win.document.querySelector('input[name="smart-choice"]'), 'back at the choice');
    f.dom.window.close();
});

test('the Legionella step comes after the choice: the pump\'s own, 65 °C recommended and preselected, or their own', async () => {
    const s = english.pair.setup.smart;
    const f = await hotwaterSmart({flows: [], historyDays: 60, legionellaPumpC: 60, legionellaDays: 21}, NO_SOLAR, true);
    const body = () => f.win.document.body.textContent;
    assert.ok(body().includes(s.hw_legionella_title));
    assert.ok(body().includes(s.hw_legionella_intro.replace('__days__', '21')), 'the heat pump\'s own interval');
    const cards = [...f.win.document.querySelectorAll('.hwl-card')] as any[];
    assert.equal(cards.length, 3);
    assert.ok(cards[0].textContent.includes('60 °C') && cards[0].textContent.includes(s.hw_legionella_pump), 'the heat pump\'s own setting');
    assert.ok(cards[1].textContent.includes('65 °C') && cards[1].textContent.includes(s.hw_legionella_recommended));
    assert.ok(cards[1].classList.contains('is-selected'), '65 °C is preselected');
    assert.ok(body().includes(s.hw_legionella_note));
    assert.ok(body().includes(s.hw_legionella_link), 'a link to the help page\'s Legionella section');
    // Back to the choice and forward again.
    f.click('Back'); await tick();
    assert.ok(f.win.document.querySelector('input[name="smart-choice"]'));
    f.click('Continue'); await tick();
    // A temperature of their own: out of range is refused, in range is saved.
    const own = f.win.document.querySelector('.hwl-custom input');
    own.value = '75'; own.dispatchEvent(new f.win.Event('input'));
    assert.ok(cards.length && f.win.document.querySelectorAll('.hwl-card')[2].classList.contains('is-selected'));
    f.click('Continue'); await tick();
    assert.ok(body().includes(s.hw_legionella_invalid));
    assert.equal(f.emitted.some((e) => e.name === 'hotwater_legionella'), false);
    own.value = '68'; own.dispatchEvent(new f.win.Event('input'));
    f.click('Continue'); await tick(); await tick();
    assert.equal(JSON.stringify(f.emitted.find((e) => e.name === 'hotwater_legionella')?.data), JSON.stringify({choice: 'custom', c: 68}));
    assert.ok(body().includes(s.hw_flows_none), 'on to the hot water checklist');
    // Back from the checklist returns here, with their own temperature kept.
    f.click('Back'); await tick();
    assert.ok(f.win.document.querySelectorAll('.hwl-card')[2].classList.contains('is-selected'));
    assert.equal(f.win.document.querySelector('.hwl-custom input').value, '68');
    f.dom.window.close();
});

test('the Legionella step leaves the recommended 65 °C unsaved, and hides the heat pump\'s card when it does not read', async () => {
    const f = await hotwaterSmart({flows: [], historyDays: 60, legionellaPumpC: null}, NO_SOLAR, true);
    assert.equal(f.win.document.querySelectorAll('.hwl-card').length, 2);
    f.click('Continue'); await tick();
    assert.equal(f.emitted.some((e) => e.name === 'hotwater_legionella'), false);
    f.dom.window.close();
});

test('hot water setup shows made-up days without and with Autopilot, each with its own plan', async () => {
    const f = fixture('repair', 'hotwater', 0, undefined, {context: {smart: true},
        results: {smart_status: {role: 'hotwater', mode: 'off', spa: true, spaOn: false, autopilot: true, tank: true,
            starterDays: 14, household: null, reserve: 40, historyDays: 30}}});
    f.click('Continue'); f.menu('Hot water setup'); f.click('Continue'); await tick();
    const autopilot = f.win.document.querySelector('input[name="smart-choice"][value="autopilot"]');
    autopilot.checked = true; autopilot.dispatchEvent(new f.win.Event('change'));
    f.click(english.pair.setup.smart.mode_simulated);
    f.click(english.pair.setup.smart.hw_plan_open + ' ›');
    const sm = english.pair.setup.smart;
    const body = () => f.win.document.body.textContent;
    assert.ok(body().includes(sm.hw_plan_w1), 'opens on Autopilot, a workday');
    f.click(sm.hw_plan_day_sun);
    assert.ok(body().includes(sm.hw_plan_u3), 'a sunny day charges on solar');
    f.click(sm.hw_plan_without);
    assert.ok(body().includes(sm.hw_plan_s2), 'without Autopilot it charges right away');
    assert.ok(f.win.document.querySelector('.hwp-chips').hidden, 'the example days belong to Autopilot');
    assert.equal(f.win.document.querySelectorAll('.hwp-chart').length, 1);
});
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
test('the hot water step says today\'s day type: the calendar\'s, or one set and held', async () => {
    const s = english.pair.setup.smart;
    let f = await hotwaterSmart({flows: [], historyDays: 60, dayType: {name: 'Day off', set: false}});
    assert.ok(f.win.document.body.textContent.includes(s.hw_daytype_calendar.replace('__type__', 'Day off')));
    f.dom.window.close();
    f = await hotwaterSmart({flows: [], historyDays: 60, dayType: {name: 'Working day', set: true}});
    assert.ok(f.win.document.body.textContent.includes(s.hw_daytype_set.replace('__type__', 'Working day')));
    f.dom.window.close();
});

test('the hot water step sets how much to always keep; an unchanged choice is not saved again', async () => {
    const s = english.pair.setup.smart;
    let f = await hotwaterSmart({flows: [], historyDays: 60, reserve: 35});
    const pick = f.win.document.querySelector('select[aria-label="' + s.hw_reserve + '"]');
    assert.deepEqual([...pick.options].map((o: any) => o.textContent), [s.hw_reserve_off, s.hw_reserve_20, '35 L', s.hw_reserve_40, s.hw_reserve_60],
        'an old value that is not a choice is kept as one');
    assert.equal(pick.value, '35');
    pick.value = '60'; pick.dispatchEvent(new f.win.Event('change'));
    f.click('Continue'); await tick(); await tick();
    f.click(s.start_test); await tick(); await tick();
    assert.equal(JSON.stringify(f.emitted.find((e) => e.name === 'hotwater_reserve')?.data), JSON.stringify({litres: 60}));
    f.dom.window.close();
    f = await hotwaterSmart({flows: [], historyDays: 60});
    f.click('Continue'); await tick(); await tick();
    f.click(s.start_test); await tick(); await tick();
    assert.equal(f.emitted.some((e) => e.name === 'hotwater_reserve'), false);
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

test('the Solar step shows what it found, live charging on and the forecast off by default', async () => {
    const f = await hotwaterSmart({flows: [], historyDays: 60}, {meters: [{id: 'p1', name: 'P1 Meter', w: -1200}], meter: 'p1',
        solar: [{id: 'se', name: 'SolarEdge', w: 3400}], followsSun: true, peakKw: 2.4, live: null, forecast: null});
    f.click('Continue'); await tick(); await tick();
    const text = f.win.document.body.textContent;
    const s = english.pair.setup.smart;
    assert.ok(text.includes('P1 Meter · 1.2 kW') && text.includes('SolarEdge · 3.4 kW'), text);
    assert.ok(text.includes(s.solar_evidence.replace('__kw__', '2.4')));
    assert.ok(text.includes(s.solar_live) && text.includes(s.solar_forecast_hint));
    const box = (name: string) => f.win.document.querySelector(`input[name="${name}"]`);
    assert.equal(box('solar-live').checked, true);
    assert.equal(box('solar-forecast').checked, false);
    box('solar-forecast').checked = true; box('solar-forecast').dispatchEvent(new f.win.Event('change'));
    f.click(s.start_test); await tick(); await tick();
    assert.equal(JSON.stringify(f.emitted.find((e) => e.name === 'solar_save')?.data),
        JSON.stringify({live: true, forecast: true, meter: 'p1'}));
    f.dom.window.close();
});

test('with no meter the Solar step says what to add, offers no switches and saves nothing', async () => {
    const f = await hotwaterSmart({flows: [], historyDays: 60});
    f.click('Continue'); await tick(); await tick();
    const s = english.pair.setup.smart;
    const text = f.win.document.body.textContent;
    assert.ok(text.includes(s.solar_meter_none) && text.includes(s.solar_need_meter));
    assert.equal(f.win.document.querySelector('input[name="solar-live"]'), null);
    f.click(s.start_test); await tick(); await tick();
    assert.equal(f.emitted.some((e) => e.name === 'solar_save'), false);
    assert.equal(f.emitted.find((e) => e.name === 'smart_choose')?.data?.value, 'test');
    f.dom.window.close();
});

test('several grid meters: the owner picks the one for the whole home', async () => {
    const f = await hotwaterSmart({flows: [], historyDays: 60}, {meters: [{id: 'a', name: 'Grid Sensor', w: 5869}, {id: 'b', name: 'Home', w: 5883}],
        meter: 'a', solar: [], followsSun: false, peakKw: null, live: false, forecast: false});
    f.click('Continue'); await tick(); await tick();
    const s = english.pair.setup.smart;
    const pick = f.win.document.querySelector('select[aria-label="' + s.solar_meter + '"]');
    assert.ok(pick && f.win.document.body.textContent.includes(s.solar_meter_pick));
    pick.value = 'b'; pick.dispatchEvent(new f.win.Event('change'));
    f.click(s.start_test); await tick(); await tick();
    assert.equal(JSON.stringify(f.emitted.find((e) => e.name === 'solar_save')?.data), JSON.stringify({live: false, forecast: false, meter: 'b'}), 'saved switches are kept');
    f.dom.window.close();
});

test('Autopilot with Homey sensors sent as BT50: the same sensors, only read, and no BT50 steps', async () => {
    const s = english.pair.setup;
    const f = fixture('repair', 'heating', 0, undefined, {
        context: {smart: true, indoorSensors: {sensors: [{deviceId: 'sensor1', capabilityId: 'measure_temperature'}], state: 'active'}},
        results: {smart_status: {role: 'heating', mode: 'test', spa: true, spaOn: false, autopilot: true, verified: false, roomControl: 0,
            indoor: 21.3, prices: true, status: null, outdoorSensor: null, outdoorName: null}, read_indoor: {value: 21}}});
    f.click('Continue'); f.menu('Heating setup'); await tick();
    const change = [...f.win.document.querySelectorAll('button')].filter((b: any) => b.textContent === s.smart.change);
    change[0].click(); await tick();
    f.click('Continue'); await tick();
    const text = f.win.document.body.textContent;
    assert.ok(text.includes(s.smart.indoor_bt50_note), 'says the sensors are only read from now on');
    assert.ok(!text.includes(s.return_nibe), 'no "Return to your NIBE sensor" page');
    f.click('Continue'); await tick();
    const pump = f.win.document.body.textContent;
    assert.ok(!pump.includes(s.enable_title) && !pump.includes(s.control_title), 'no BT50 steps on the Autopilot path');
    f.click(s.save_section); await tick(); await tick();
    assert.equal(f.emitted.find((e) => e.name === 'read_indoor')?.data?.sensors?.[0]?.deviceId, 'sensor1');
    assert.equal(f.emitted.some((e) => e.name === 'activate_indoor'), false);
    f.dom.window.close();
});
