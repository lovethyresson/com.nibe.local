/* Shared pairing/Repair navigation. Sections stay mounted so Back preserves drafts. */
/* global Homey */
/* eslint-disable no-unused-vars */
function NibeSetup(options) {
    var api = this;
    var t = function (key) { return Homey.__('pair.setup.' + key); };
    var originalTitle = Homey.__(options.mode === 'pair' ? 'pair.devices.title' : 'pair.features.title');
    var originalIntro = Homey.__(options.mode === 'pair' ? 'pair.devices.intro' : 'pair.features.intro');
    var view = document.getElementById(options.mode === 'pair' ? 'nibe-pair-setup' : 'nibe-repair-setup');
    var form = view.querySelector('form');
    var navigation = el('nav', undefined, 'setup-navigation'); navigation.hidden = true;
    view.querySelector('.pair-hero').before(navigation);
    var shell = document.createElement('div');
    shell.className = 'setup-shell';
    shell.hidden = true;
    form.appendChild(shell);
    var parking = document.createElement('div'); parking.hidden = true; form.appendChild(parking);
    var sections = [];
    var ready = {};
    var config = options.indoorSensors || null;
    var useHomey = !!config;
    var selected = (config && config.sensors || []).slice();
    var inventory = [];
    var validated = false;
    var heating;
    var active = config && config.state === 'active';
    var error;
    function el(tag, text, cls) {
        var node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (cls) node.className = cls;
        return node;
    }
    function button(text, fn, primary) {
        var b = el('button', text, primary ? 'homey-button-primary-full' : 'homey-button-secondary');
        b.type = 'button'; b.onclick = fn; return b;
    }
    function heading(title, intro) {
        // Homey's translation pass can run again after navigation. These are now dynamic.
        view.querySelector('.pair-hero-title').removeAttribute('data-i18n');
        view.querySelector('.pair-hero-sub').removeAttribute('data-i18n');
        Homey.setTitle(title);
        view.querySelector('.pair-hero-title').textContent = title;
        view.querySelector('.pair-hero-sub').textContent = intro || '';
    }
    function clear(title, intro) {
        sections.forEach(function (s) { if (s.sources) parking.appendChild(s.sources); if (s.content) parking.appendChild(s.content); });
        if (options.consent) parking.appendChild(options.consent);
        navigation.replaceChildren(); navigation.hidden = false;
        shell.replaceChildren();
        shell.hidden = false;
        Array.from(form.children).forEach(function (n) { if (n !== shell) n.hidden = true; });
        view.querySelector('.pair-hero').classList.remove('setup-source-hero');
        view.querySelector('.pair-hero').classList.add('setup-hero');
        heading(title, intro);
        error = el('p', '', 'setup-error'); error.setAttribute('role', 'alert'); shell.appendChild(error);
    }
    function fail(err) { error.textContent = err && err.message || String(err); }
    function emit(event, data) {
        return new Promise(function (resolve, reject) {
            var slow = event === 'activate_indoor' || event === 'activate_autopilot';
            var timeout = setTimeout(function () { reject(new Error(t('request_timeout'))); }, slow ? 45000 : 20000);
            Homey.emit(event, data || {}, function (err, result) {
                clearTimeout(timeout); if (err) reject(err); else resolve(result);
            });
        });
    }
    function busy(b, job) {
        b.disabled = true;
        var caption = b.textContent; var message = error;
        b.textContent = t('checking'); message.textContent = '';
        return job().catch(function (err) {
            message.textContent = err && err.message || String(err);
            if (b.isConnected) { b.before(message); message.scrollIntoView?.({block: 'nearest'}); }
        }).finally(function () { b.disabled = false; b.textContent = caption; });
    }
    function back(fn) {
        var b = button(t('back'), fn); b.classList.add('setup-back'); navigation.appendChild(b);
    }
    function draft() { return {sensors: selected.slice(), state: 'pending'}; }
    function key(s) { return s.deviceId + ':' + s.capabilityId; }
    function nativeMode() {
        if (active) { handover(); return; }
        useHomey = false; validated = false; temperature();
    }
    function temperature() {
        clear(t('heating'), t('source_intro'));
        view.querySelector('.pair-hero-title').textContent = t('source_title');
        view.querySelector('.pair-hero-title').hidden = false;
        view.querySelector('.pair-hero').classList.add('setup-source-hero');
        var nativeCard = el('div', undefined, 'setup-source-card' + (!useHomey ? ' is-selected' : ''));
        var native = el('label', undefined, 'setup-source-label');
        var n = document.createElement('input'); n.type = 'radio'; n.name = 'temperature-mode'; n.checked = !useHomey;
        n.onchange = nativeMode;
        native.append(n, el('span', t('nibe'), 'setup-source-title'));
        nativeCard.appendChild(native);
        heating.sources.hidden = useHomey;
        heating.sources.classList.add('setup-native-detail');
        nativeCard.appendChild(heating.sources);
        shell.appendChild(nativeCard);

        var homeyCard = el('div', undefined, 'setup-source-card' + (useHomey ? ' is-selected' : ''));
        var label = el('label', undefined, 'setup-source-label');
        var h = document.createElement('input'); h.type = 'radio'; h.name = 'temperature-mode'; h.checked = useHomey;
        h.onchange = function () { useHomey = true; temperature(); };
        var text = el('span', undefined, 'setup-source-copy');
        text.append(el('span', t('homey'), 'setup-source-title'),
            el('span', t('source_homey_desc'), 'setup-source-description'));
        label.append(h, text); homeyCard.appendChild(label); shell.appendChild(homeyCard);
        if (active) shell.appendChild(el('p', t('active_note')));
        if (options.mode === 'repair' && config) {
            var statusBox = el('div', undefined, 'register-desc'); shell.appendChild(statusBox);
            emit('indoor_status').then(function (status) {
                statusBox.textContent = 'BT50: ' + (status.measured === null ? '—' : status.measured + ' °C')
                    + ' · ' + t('zone_temperature') + ': ' + (status.zone === null ? '—' : status.zone + ' °C');
                if (status.message) statusBox.appendChild(el('p', status.message));
            }).catch(function (err) { statusBox.textContent = err.message || String(err); });
        }
        var next = button(useHomey ? t('choose_sensors') : t('save_section'), function () {
            if (useHomey) picker(); else { ready[heating.id] = true; hub(); }
        }, true);
        shell.appendChild(next); back(hub);
    }
    function picker() {
        clear(t('heating'), t('picker_intro'));
        var search = document.createElement('input'); search.type = 'search'; search.placeholder = t('search');
        search.setAttribute('aria-label', t('search')); search.className = 'setup-search';
        var filters = el('div', undefined, 'setup-filters');
        var room = document.createElement('select'); room.setAttribute('aria-label', t('room'));
        var type = document.createElement('select'); type.setAttribute('aria-label', t('type'));
        filters.append(room, type); filters.hidden = true;
        var picked = el('div', undefined, 'setup-picked'); picked.setAttribute('aria-live', 'polite');
        var results = el('div'); results.setAttribute('aria-live', 'polite');
        var showAll = false; var page = 0; var onlySelected = false;
        var next = button(t('review_sensors'), function () { busy(next, async function () {
            var result = await emit('validate_indoor_sensors', draft());
            config = result.config; validated = true; reviewSensors(result.value);
        }); }, true);
        shell.append(search, filters, picked, next, results);
        back(temperature);
        function normalized(text) { return String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
        function fill(select, title, values) {
            select.replaceChildren(new Option(title, ''));
            values.forEach(function (v) { select.appendChild(new Option(v, v)); });
        }
        function draw() {
            var browsing = !!search.value.trim() || showAll || onlySelected;
            filters.hidden = !browsing;
            picked.replaceChildren(); results.replaceChildren(); next.disabled = selected.length === 0;
            selected.forEach(function (ref) {
                var s = inventory.find(function (r) { return key(r) === key(ref); });
                var roomName = s && s.room.split(' / ').slice(-1)[0];
                var chip = button((s ? s.name + ' · ' + roomName : t('missing')) + ' ×', function () {
                    selected = selected.filter(function (r) { return key(r) !== key(ref); }); validated = false; draw();
                });
                chip.classList.add('setup-chip'); picked.appendChild(chip);
            });
            if (selected.length) {
                var showSelected = button(onlySelected ? t('all_matches') : t('selected_only'), function () {
                    onlySelected = !onlySelected; page = 0; draw();
                });
                showSelected.classList.add('setup-small-action'); picked.appendChild(showSelected);
            }
            if (!browsing) { results.appendChild(button(t('show_all'), function () { showAll = true; draw(); })); return; }
            var query = normalized(search.value.trim());
            var matches = inventory.filter(function (s) {
                return (!query || normalized([s.name, s.room, s.type, s.app, s.capabilityId].join(' ')).includes(query))
                    && (!room.value || s.room === room.value || s.room.startsWith(room.value + ' / '))
                    && (!type.value || s.type === type.value)
                    && (!onlySelected || selected.some(function (r) { return key(r) === key(s); }));
            });
            if (page * 8 >= matches.length) page = 0;
            results.appendChild(el('p', matches.length + ' ' + t('matches')));
            var lastRoom;
            matches.slice(page * 8, page * 8 + 8).forEach(function (s) {
                if (lastRoom !== s.room) { results.appendChild(el('h3', s.room || t('no_room'))); lastRoom = s.room; }
                var row = el('label', undefined, 'setup-sensor');
                var input = document.createElement('input'); input.type = 'checkbox';
                input.checked = selected.some(function (r) { return key(r) === key(s); });
                var valid = s.available && s.value !== null && s.value >= 5 && s.value <= 40;
                input.disabled = !valid && !input.checked;
                input.onchange = function () {
                    selected = selected.filter(function (r) { return key(r) !== key(s); });
                    if (input.checked) selected.push({deviceId: s.deviceId, capabilityId: s.capabilityId});
                    validated = false; draw();
                };
                var info = el('span', s.name);
                info.appendChild(el('small', [s.type, s.app].join(' · ')));
                info.appendChild(el('small', s.updatedAt ? new Date(s.updatedAt).toLocaleString() : t('unknown_age')));
                var reading = valid ? s.value + ' °C' : t('unavailable');
                row.append(input, info, el('span', reading)); results.appendChild(row);
            });
            if (matches.length > 8) {
                var pager = el('div', undefined, 'setup-actions');
                var prev = button(t('previous_page'), function () { page--; draw(); }); prev.disabled = page === 0;
                var more = button(t('next'), function () { page++; draw(); }); more.disabled = (page + 1) * 8 >= matches.length;
                pager.append(prev, el('span', (page + 1) + ' / ' + Math.ceil(matches.length / 8)), more); results.appendChild(pager);
            }
        }
        search.oninput = function () { page = 0; draw(); }; room.onchange = type.onchange = function () { page = 0; draw(); };
        var refresh = button(t('refresh'), function () { busy(refresh, load); });
        refresh.classList.add('setup-small-action'); shell.appendChild(refresh);
        async function load() {
            inventory = await emit('get_indoor_sensors');
            fill(room, t('all_rooms'), Array.from(new Set(inventory.map(function (s) { return s.room; }))));
            fill(type, t('all_types'), Array.from(new Set(inventory.map(function (s) { return s.type; }))).sort());
            draw();
        }
        draw(); busy(refresh, load);
    }
    function reviewSensors(value) {
        clear(t('heating'), '');
        var group = el('section', undefined, 'setup-task-group setup-sensor-review');
        group.appendChild(el('h3', t('selected_sensors')));
        var list = el('ul', undefined, 'setup-review-list');
        inventory.filter(function (sensor) {
            return selected.some(function (ref) { return key(sensor) === key(ref); });
        }).forEach(function (sensor) {
            var row = el('li', undefined, 'setup-review-row');
            var copy = el('div', undefined, 'setup-review-copy');
            copy.append(el('strong', sensor.name), el('span', sensor.room));
            row.append(copy, el('span', sensor.value + ' °C', 'setup-review-value'));
            list.appendChild(row);
        });
        group.appendChild(list); shell.appendChild(group);
        var summary = el('section', undefined, 'setup-temperature-summary');
        summary.append(el('h3', selected.length > 1 ? t('average') : t('temperature')),
            el('strong', value + ' °C'));
        if (selected.length > 1) summary.appendChild(el('p', t('review_intro')));
        shell.appendChild(summary);
        if (options.mode === 'pair') {
            shell.appendChild(el('p', t('pending_hint')));
            shell.appendChild(button(t('save_section'), function () { ready[heating.id] = true; hub(); }, true));
        } else shell.appendChild(button(t('setup_pump'), prepare, true));
        back(picker);
    }
    function prepare() {
        clear(t('heating'), t('setup_pump'));
        view.querySelector('.pair-hero-title').textContent = t('setup_pump');
        view.querySelector('.pair-hero-sub').textContent = t('pump_intro');
        view.querySelector('.pair-hero').classList.add('setup-source-hero');
        var pumpGroup = el('section', undefined, 'setup-task-group');
        pumpGroup.appendChild(el('h3', t('on_pump')));
        var steps = el('ol', undefined, 'setup-pump-steps');
        [['enable_title', 'enable_detail'], ['zone_title', 'zone_detail'], ['control_title', 'control_detail']].forEach(function (keys) {
            var step = el('li');
            var copy = el('div'); copy.append(el('strong', t(keys[0])), el('p', t(keys[1])));
            step.appendChild(copy); steps.appendChild(step);
        });
        pumpGroup.appendChild(steps); shell.appendChild(pumpGroup);
        var homeyGroup = el('section', undefined, 'setup-task-group setup-confirm-group');
        homeyGroup.appendChild(el('h3', t('in_homey')));
        var confirm = document.createElement('input'); confirm.type = 'checkbox';
        var label = el('label', undefined, 'setup-option'); label.append(confirm, el('span', t('zone_confirm')));
        homeyGroup.appendChild(label);
        homeyGroup.appendChild(el('p', t('feed_short'), 'setup-feed-summary'));
        var recovery = el('details', undefined, 'setup-recovery');
        recovery.append(el('summary', t('if_readings_stop')), el('p', t('feed_recovery')));
        homeyGroup.appendChild(recovery); shell.appendChild(homeyGroup);
        var feedStatus = el('p', '', 'setup-feed-status'); feedStatus.setAttribute('aria-live', 'polite');
        shell.appendChild(feedStatus);
        var verify = button(t('verify'), function () { busy(verify, async function () {
            var result;
            try { result = await emit('activate_indoor', draft()); } catch (err) {
                var status = await emit('indoor_status').catch(function () { return null; });
                if (status && status.config && status.config.state === 'active') {
                    active = true; feedStatus.textContent = t('active_note');
                }
                throw err;
            }
            active = true; config.state = 'active';
            clear(t('heating'), '');
            var success = el('section', undefined, 'setup-success'); success.setAttribute('role', 'status');
            var check = el('div', '✓', 'setup-success-check'); check.setAttribute('aria-hidden', 'true');
            success.append(check, el('h2', t('success_title')), el('p', t('success_description')));
            var reading = el('div', undefined, 'setup-success-reading');
            reading.append(el('strong', result.measured + ' °C'), el('span', t('success_received')));
            success.appendChild(reading);
            success.appendChild(el('p', selected.length === 1 ? t('success_one') : selected.length + ' ' + t('success_many'), 'setup-success-sensors'));
            shell.appendChild(success);
            shell.appendChild(button(t('next'), function () { ready[heating.id] = true; hub(); }, true));
            back(prepare);
        }); }, true);
        verify.disabled = true; confirm.onchange = function () { verify.disabled = !confirm.checked; };
        shell.appendChild(verify); back(picker);
    }
    function handover() {
        clear(t('heating'), t('return_nibe'));
        shell.appendChild(el('p', t('handover_hint')));
        var confirmed = document.createElement('input'); confirmed.type = 'checkbox';
        var label = el('label', undefined, 'setup-option'); label.append(confirmed, document.createTextNode(' ' + t('handover_confirm')));
        shell.appendChild(label);
        var stop = button(t('verify'), function () { busy(stop, async function () {
            await emit('deactivate_indoor'); active = false; config = null; useHomey = false;
            var previous = heating.sources.querySelector('input[data-source][value="' + (options.indoorNativeAddress || 116) + '"]');
            if (!previous) {
                previous = document.createElement('input'); previous.type = 'radio'; previous.hidden = true;
                previous.name = 'source:measure_temperature'; previous.dataset.source = 'measure_temperature';
                previous.value = String(options.indoorNativeAddress || 116); heating.sources.appendChild(previous);
            }
            heating.sources.querySelectorAll('input[data-source]').forEach(function (r) { r.checked = r === previous; });
            temperature();
        }); }, true);
        stop.disabled = true; confirmed.onchange = function () { stop.disabled = !confirmed.checked; };
        shell.appendChild(stop); back(temperature);
    }
    // ---- Autopilot heating (Repair only): choose, checklist, profile, Verify, Return to NIBE ----
    var ap = {status: null, choice: 'autopilot', profile: 'comfortable', comfort: 21};
    function a(key, tokens) {
        var text = Homey.__('pair.setup.autopilot.' + key);
        Object.keys(tokens || {}).forEach(function (k) { text = text.split('__' + k + '__').join(tokens[k]); });
        return text;
    }
    function apBadge(status) {
        return a(status.mode === 'autopilot' ? (status.paused ? 'badge_paused' : 'badge_on')
            : status.mode === 'test' ? 'badge_test' : status.mode === 'spa' ? 'badge_spa' : 'badge_off');
    }
    function radios(name, values, current, onchange) {
        var box = el('div', undefined, 'setup-choices');
        values.forEach(function (v) {
            var card = el('label', undefined, 'setup-source-card setup-choice' + (v.id === current ? ' is-selected' : ''));
            var input = document.createElement('input'); input.type = 'radio'; input.name = name; input.value = v.id;
            input.checked = v.id === current;
            input.onchange = function () {
                box.querySelectorAll('.setup-choice').forEach(function (c) { c.classList.remove('is-selected'); });
                card.classList.add('is-selected'); onchange(v.id);
            };
            var copy = el('span', undefined, 'setup-source-copy');
            copy.appendChild(el('span', v.title, 'setup-source-title'));
            if (v.description) copy.appendChild(el('span', v.description, 'setup-source-description'));
            card.append(input, copy); box.appendChild(card);
        });
        return box;
    }
    function checkRow(ok, title, detail, action) {
        var row = el('li', undefined, 'setup-check ' + (ok === true ? 'is-ok' : ok === false ? 'is-blocking' : 'is-info'));
        row.appendChild(el('span', ok === true ? '✓' : ok === false ? '!' : '·', 'setup-check-mark'));
        var copy = el('div'); copy.appendChild(el('strong', title));
        if (detail) copy.appendChild(el('p', detail));
        if (action) copy.appendChild(action);
        row.appendChild(copy); return row;
    }
    async function autopilot() {
        clear(a('title'), a('intro'));
        var loading = el('p', t('checking')); shell.appendChild(loading); back(hub);
        try { ap.status = await emit('autopilot_status'); } catch (err) { loading.remove(); fail(err); return; }
        loading.remove();
        var st = ap.status;
        ap.profile = st.profile; ap.comfort = st.comfort;
        if (st.mode === 'autopilot' && st.verified) { autopilotOn(); return; }
        ap.choice = st.mode === 'test' ? 'test' : 'autopilot';
        shell.appendChild(radios('autopilot-choice', [
            {id: 'autopilot', title: a('choose_on'), description: a('choose_on_desc')},
            {id: 'test', title: a('choose_test'), description: a('choose_test_desc')},
            {id: 'off', title: a('choose_off'), description: a('choose_off_desc')},
        ], ap.choice, function (v) { ap.choice = v; }));
        if (st.spaHeating) shell.appendChild(el('p', a('spa_note'), 'register-desc'));
        shell.appendChild(button(t('next'), function () {
            if (ap.choice === 'off') busy(this, async function () {
                await emit('autopilot_choose', {value: 'off'}); done(a('saved_off'));
            }.bind(this)); else checklist();
        }, true));
    }
    function autopilotOn() {
        var st = ap.status;
        var box = el('section', undefined, 'setup-temperature-summary');
        box.append(el('h3', a(st.paused ? 'is_paused' : 'is_on')), el('p', st.status || ''));
        shell.appendChild(box);
        shell.appendChild(button(a('change_outdoor'), function () { outdoorPicker(autopilot); }));
        shell.appendChild(button(a('change_profile'), function () { ap.choice = 'autopilot'; profileStep(); }));
        shell.appendChild(button(a('return_nibe'), returnToNibe, true));
    }
    function checklist() {
        var st = ap.status;
        clear(a('title'), a('checklist_intro'));
        var list = el('ul', undefined, 'setup-checklist');
        var indoorOk = st.indoor !== null;
        list.appendChild(checkRow(indoorOk, a('indoor'), indoorOk ? st.indoor + ' °C' : a('indoor_missing')));
        var outdoorText = st.outdoorSensor ? (st.outdoorName || a('sensor')) + (st.outdoor !== null ? ' · ' + st.outdoor + ' °C' : ' · ' + a('no_reading'))
            : a('outdoor_forecast');
        list.appendChild(checkRow(st.outdoorSensor && st.outdoor !== null ? true : null, a('outdoor'), outdoorText,
            button(a('choose_outdoor'), function () { outdoorPicker(checklist); })));
        list.appendChild(checkRow(st.prices ? true : null, a('prices'), a(st.prices ? 'prices_dynamic' : 'prices_fixed')));
        var roomOk = st.roomControl === null ? null : st.roomControl === 0;
        list.appendChild(checkRow(roomOk, a('room_control'), a(roomOk === false ? 'room_control_on' : roomOk ? 'room_control_off' : 'room_control_unknown')));
        if (ap.choice === 'autopilot') list.appendChild(checkRow(null, a('bt1'), a('bt1_detail')));
        shell.appendChild(list);
        var next = button(t('next'), profileStep, true);
        next.disabled = !indoorOk || roomOk === false;
        shell.appendChild(next); back(autopilot);
    }
    function profileStep() {
        clear(a('title'), a('profile_intro'));
        shell.appendChild(radios('autopilot-profile', [
            {id: 'comfortable', title: a('profile_comfortable'), description: a('profile_comfortable_desc')},
            {id: 'save_some', title: a('profile_save_some'), description: a('profile_save_some_desc')},
            {id: 'save_most', title: a('profile_save_most'), description: a('profile_save_most_desc')},
        ], ap.profile, function (v) { ap.profile = v; }));
        var label = el('label', undefined, 'setup-field');
        label.appendChild(el('span', a('comfort')));
        var comfort = document.createElement('input'); comfort.type = 'number'; comfort.min = 15; comfort.max = 25; comfort.step = 0.5;
        comfort.value = ap.comfort; comfort.oninput = function () { ap.comfort = Number(comfort.value); };
        label.appendChild(comfort); shell.appendChild(label);
        shell.appendChild(el('p', a('comfort_hint'), 'register-desc'));
        var on = ap.status.mode === 'autopilot' && ap.status.verified;
        var next = button(on ? t('save_section') : ap.choice === 'autopilot' ? t('next') : a('start_test'), function () {
            if (!comfort.checkValidity()) { comfort.reportValidity(); return; }
            if (on) busy(next, async function () {
                await emit('autopilot_choose_profile', {profile: ap.profile, comfort: ap.comfort}); done(a('saved_profile'));
            }); else if (ap.choice === 'autopilot') verifyStep();
            else busy(next, async function () {
                await emit('autopilot_choose', {value: 'test', profile: ap.profile, comfort: ap.comfort}); done(a('saved_test'));
            });
        }, true);
        shell.appendChild(next); back(on ? autopilot : checklist);
    }
    function verifyStep() {
        clear(a('title'), a('verify_intro'));
        var group = el('section', undefined, 'setup-task-group');
        group.appendChild(el('h3', t('on_pump')));
        var steps = el('ol', undefined, 'setup-pump-steps');
        [['bt1', 'bt1_detail'], ['modbus', 'modbus_detail']].forEach(function (k) {
            var step = el('li'); var copy = el('div'); copy.append(el('strong', a(k[0])), el('p', a(k[1])));
            step.appendChild(copy); steps.appendChild(step);
        });
        group.appendChild(steps); shell.appendChild(group);
        if (ap.status.spaHeating) shell.appendChild(el('p', a('spa_note'), 'register-desc'));
        var confirm = document.createElement('input'); confirm.type = 'checkbox';
        var label = el('label', undefined, 'setup-option'); label.append(confirm, el('span', a('verify_confirm')));
        shell.appendChild(label);
        var verify = button(t('verify'), function () { busy(verify, async function () {
            var result = await emit('activate_autopilot', {profile: ap.profile, comfort: ap.comfort});
            clear(a('title'), '');
            var success = el('section', undefined, 'setup-success'); success.setAttribute('role', 'status');
            var check = el('div', '✓', 'setup-success-check'); check.setAttribute('aria-hidden', 'true');
            success.append(check, el('h2', a('success_title')), el('p', a('success_description')));
            var reading = el('div', undefined, 'setup-success-reading');
            reading.append(el('strong', result.fed + ' °C'), el('span', a('success_received')));
            success.appendChild(reading); shell.appendChild(success);
            shell.appendChild(toHub());
        }); }, true);
        verify.disabled = true; confirm.onchange = function () { verify.disabled = !confirm.checked; };
        shell.appendChild(verify); back(profileStep);
    }
    function returnToNibe() {
        clear(a('title'), a('return_intro'));
        var handover = ap.status.spaHeating ? 'spa' : 'off';
        shell.appendChild(radios('autopilot-handover', [
            {id: 'spa', title: a('handover_spa'), description: a('handover_spa_desc')},
            {id: 'off', title: a('handover_off'), description: a('handover_off_desc')},
        ], handover, function (v) { handover = v; }));
        shell.appendChild(el('p', a('return_reminder'), 'register-desc'));
        var stop = button(a('return_nibe'), function () { busy(stop, async function () {
            await emit('deactivate_autopilot', {handover: handover}); done(a('saved_returned'));
        }); }, true);
        shell.appendChild(stop); back(autopilot);
    }
    function done(message) {
        clear(a('title'), '');
        var success = el('section', undefined, 'setup-success'); success.setAttribute('role', 'status');
        var check = el('div', '✓', 'setup-success-check'); check.setAttribute('aria-hidden', 'true');
        success.append(check, el('h2', message)); shell.appendChild(success);
        shell.appendChild(toHub());
    }
    /** Back to the hub with the Autopilot badge brought up to date. */
    function toHub() {
        var b = button(t('next'), function () { busy(b, async function () {
            ap.status = await emit('autopilot_status').catch(function () { return ap.status; }); hub();
        }); }, true);
        return b;
    }
    function outdoorPicker(then) {
        clear(a('title'), a('outdoor_intro'));
        var current = ap.status && ap.status.outdoorSensor;
        var choice = current ? current.deviceId + ':' + current.capabilityId : 'forecast';
        var search = document.createElement('input'); search.type = 'search'; search.placeholder = t('search');
        search.setAttribute('aria-label', t('search')); search.className = 'setup-search';
        var results = el('div'); results.setAttribute('aria-live', 'polite');
        var save = button(t('save_section'), function () { busy(save, async function () {
            var ref = choice === 'forecast' ? null : list.find(function (s) { return key(s) === choice; });
            await emit('set_outdoor_sensor', ref ? {deviceId: ref.deviceId, capabilityId: ref.capabilityId} : null);
            ap.status = await emit('autopilot_status'); then();
        }); }, true);
        shell.append(search, results, save); back(then);
        var list = [];
        function row(id, title, detail, reading, enabled) {
            var r = el('label', undefined, 'setup-sensor');
            var input = document.createElement('input'); input.type = 'radio'; input.name = 'outdoor'; input.checked = choice === id;
            input.disabled = !enabled && choice !== id;
            input.onchange = function () { choice = id; };
            var info = el('span', title); if (detail) info.appendChild(el('small', detail));
            r.append(input, info, el('span', reading || '')); results.appendChild(r);
        }
        function draw() {
            results.replaceChildren();
            row('forecast', a('use_forecast'), a('use_forecast_desc'), '', true);
            var q = search.value.trim().toLowerCase();
            list.filter(function (s) { return !q || [s.name, s.room, s.app].join(' ').toLowerCase().includes(q); }).slice(0, 30)
                .forEach(function (s) {
                    var valid = s.available && s.value !== null && s.value >= -50 && s.value <= 50;
                    var age = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : t('unknown_age');
                    row(key(s), s.name, [s.room, age].filter(Boolean).join(' · '), valid ? s.value + ' °C' : t('unavailable'), valid);
                });
        }
        search.oninput = draw;
        emit('get_outdoor_sensors').then(function (all) { list = all; draw(); }).catch(fail);
        draw();
    }
    function open(section) {
        if (section.role === 'autopilot') { autopilot(); return; }
        if (section.role === 'heating') { heating = section; temperature(); return; }
        clear(section.title, section.description);
        shell.appendChild(section.content);
        shell.appendChild(button(t('save_section'), function () {
            if (!section.content.querySelector('input:invalid')) { ready[section.id] = true; hub(); }
            else section.content.querySelector('input:invalid').reportValidity();
        }, true)); back(hub);
    }
    function hub() {
        clear(t('title'), t('intro'));
        sections.forEach(function (section) {
            var menu = button('', function () { open(section); }); menu.className = 'setup-menu';
            var text = el('span'); text.append(el('strong', section.title), el('small', section.description));
            var badge = section.role === 'autopilot' ? (ap.status ? apBadge(ap.status) : '')
                : ready[section.id] ? t('ready') : t('needs_setup');
            menu.append(text, el('span', badge + ' ›')); shell.appendChild(menu);
        });
        var next = button(t(options.mode === 'repair' ? 'save_changes' : 'review'), function () {
            if (options.mode === 'repair') busy(next, async function () { await options.commit(); });
            else review();
        }, true);
        next.disabled = sections.some(function (s) { return !ready[s.id]; }); shell.appendChild(next);
        back(function () {
            shell.hidden = true; navigation.hidden = true;
            Array.from(form.children).forEach(function (n) { if (n !== shell && n !== parking) n.hidden = false; });
            if (options.consent) options.consent.hidden = true;
            view.querySelector('.pair-hero').classList.remove('setup-hero', 'setup-source-hero');
            heading(originalTitle, originalIntro);
        });
    }
    function review() {
        clear(t('review'), t('review_hint'));
        options.summary().forEach(function (s) { shell.appendChild(el('p', s)); });
        if (useHomey) shell.appendChild(el('p', options.mode === 'pair' ? t('pending_hint') : t('active_note')));
        if (options.consent) { options.consent.hidden = false; options.consent.style.display = 'block'; shell.appendChild(options.consent); }
        var save = button(Homey.__(options.mode === 'pair' ? 'pair.devices.add' : 'pair.ok'), function () {
            busy(save, async function () { await options.commit(); });
        }, true);
        shell.appendChild(save); back(hub);
    }
    api.start = function (entries) {
        sections = entries;
        // Autopilot acts on its own (Verify, Return to NIBE); it never holds up Save changes.
        sections.forEach(function (s) { if (s.role === 'autopilot') ready[s.id] = true; });
        if (sections.some(function (s) { return s.role === 'autopilot'; }))
            emit('autopilot_status').then(function (st) { ap.status = st; }).catch(function () {});
        sections.forEach(function (s) { if (s.sources) parking.appendChild(s.sources); if (s.content) parking.appendChild(s.content); });
        hub();
    };
    api.indoorConfig = function () { return useHomey && validated ? draft() : null; };
}
