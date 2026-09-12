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
            var timeout = setTimeout(function () { reject(new Error(t('request_timeout'))); }, event === 'activate_indoor' ? 45000 : 20000);
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
    function open(section) {
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
            menu.append(text, el('span', (ready[section.id] ? t('ready') : t('needs_setup')) + ' ›')); shell.appendChild(menu);
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
        sections.forEach(function (s) { if (s.sources) parking.appendChild(s.sources); if (s.content) parking.appendChild(s.content); });
        hub();
    };
    api.indoorConfig = function () { return useHomey && validated ? draft() : null; };
}
