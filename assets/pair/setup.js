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
    var useHomey = !!config && config.state !== 'read';
    // Homey sensors only read, for Autopilot (indoor state `read`): never sent to the pump.
    var readHomey = !!config && config.state === 'read';
    var selected = (config && config.sensors || []).slice();
    var inventory = [];
    var validated = false;
    var heating;
    var active = config && config.state === 'active';
    if (readHomey) validated = true;
    var error;
    function el(tag, text, cls) {
        var node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (cls) node.className = cls;
        return node;
    }
    /** A text action ("Change", "How do they differ?"): not one of Homey's full-size buttons. */
    function smallAction(text, fn) {
        var b = el('button', text, 'setup-small-action hy-nostyle'); b.type = 'button'; b.onclick = fn; return b;
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
        sections.forEach(function (s) { if (s.sources) parking.appendChild(s.sources); if (s.zones) parking.appendChild(s.zones); if (s.content) parking.appendChild(s.content); });
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
    var LOCAL = {smart_choose: true, hotwater_household: true, hotwater_reserve: true, heating_range: true};
    function emit(event, data) {
        if (options.mode === 'pair' && LOCAL[event]) {
            var saved = ap.saved = ap.saved || {};
            if (event === 'smart_choose') saved.mode = data.value;
            else if (event === 'hotwater_household') saved.household = data;
            else if (event === 'heating_range') saved.range = data.value;
            else saved.reserve = data.litres;
            return Promise.resolve(true);
        }
        return new Promise(function (resolve, reject) {
            var slow = event === 'activate_indoor' || event === 'activate_autopilot' || event === 'solar_scan';
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
        if (active) { handover(temperature); return; }
        useHomey = false; validated = false; temperature();
    }
    function sourcePrompt(text) {
        var prompt = heating.sources.querySelector('.register-sources > .register-desc');
        if (prompt && heating.sources.querySelector('input[data-source]')) prompt.textContent = text;
    }
    function temperature() {
        clear(t('heating'), t('source_intro'));
        if (heating.sources) sourcePrompt(Homey.__('pair.sources.prompt'));
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
        var next = button(useHomey ? t('choose_sensors') : flowing() ? t('next') : t('save_section'), function () {
            if (useHomey) picker(); else afterIndoor();
        }, true);
        shell.appendChild(next); back(flowing() ? steer : heating.zones ? zones : hub);
    }
    // Which zone the thermostat sets: its own step, before the temperature source, and only on a
    // pump with two or more zones. Continue stays disabled until a zone is picked.
    function zones() {
        clear(t('heating'), t('thermostat_zone_intro'));
        view.querySelector('.pair-hero-title').textContent = t('thermostat_zone_title');
        view.querySelector('.pair-hero-title').hidden = false;
        view.querySelector('.pair-hero').classList.add('setup-source-hero');
        shell.appendChild(heating.zones);
        var next = button(t('next'), function () { if (flowing()) steer(); else temperature(); }, true);
        var update = function () { next.disabled = !heating.zones.querySelector('input:checked'); };
        heating.zones.onchange = update; update();
        shell.appendChild(next); back(hub);
    }
    function zoneLabel() {
        var picked = heating && heating.zones && heating.zones.querySelector('input:checked');
        return picked ? picked.dataset.label : null;
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
        back(apMode() && flowing() ? apIndoor : temperature);
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
                var showSelected = smallAction(onlySelected ? t('all_matches') : t('selected_only'), function () {
                    onlySelected = !onlySelected; page = 0; draw();
                });
                picked.appendChild(showSelected);
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
        var refresh = smallAction(t('refresh'), function () { busy(refresh, load); });
        shell.appendChild(refresh);
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
        if (apMode() && flowing()) {
            shell.appendChild(el('p', a('indoor_read_hint')));
            shell.appendChild(button(t('next'), afterApIndoor, true));
        } else if (options.mode === 'pair') {
            shell.appendChild(el('p', t('pending_hint')));
            shell.appendChild(button(t('save_section'), function () { ready[heating.id] = true; hub(); }, true));
        } else if (flowing()) shell.appendChild(button(t('next'), afterIndoor, true));
        else shell.appendChild(button(t('setup_pump'), prepare, true));
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
    function handover(then) {
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
            (typeof then === 'function' ? then : temperature)();
        }); }, true);
        stop.disabled = true; confirmed.onchange = function () { stop.disabled = !confirmed.checked; };
        shell.appendChild(stop); back(typeof then === 'function' ? then : temperature);
    }
    // ---- Heating Setup as one flow (Repair on Heating, where Smart mode is available): zone →
    // indoor temperature → who steers (Smart mode) → one pump checklist for that combination →
    // Verify. Later visits open on a summary with a Change link per step.
    function flowing() { return !!options.smart; }
    function afterIndoor() {
        if (!flowing()) { ready[heating.id] = true; hub(); return; }
        pumpStep();
    }
    /** The indoor feed still has to be started: Homey sensors chosen and reviewed now. */
    function indoorPending() { return useHomey && validated && !(flowing() && apMode()); }
    async function steer() {
        useAp('heating');
        clear(t('heating'), a('steer_intro'));
        view.querySelector('.pair-hero-title').textContent = a('steer_title');
        var loading = el('p', t('checking')); shell.appendChild(loading);
        back(heating.zones ? zones : hub);
        try { ap.status = await smartStatus(); } catch (err) { loading.remove(); fail(err); return; }
        loading.remove();
        var st = ap.status;
        if (!ap.picked) { ap.choice = st.mode; ap.sim = undefined; }
        shell.appendChild(smartPicker(st));
        var how = smallAction(a('compare_link'), compare); shell.appendChild(how);
        if (st.spaOn) shell.appendChild(el('p', a('spa_note'), 'register-desc'));
        // Autopilot steers through BT1 with room-sensor control off, so its path never asks for
        // the pump's own room control (the temperature source below sets that up for SPA and Off).
        shell.appendChild(button(t('next'), function () { if (apMode()) apIndoor(); else temperature(); }, true));
    }
    /** Autopilot: which indoor temperature it holds at the thermostat. Read only either way. */
    function apIndoor() {
        // Homey sensors sent as BT50 today: Autopilot keeps the same sensors, only read.
        if (active && !apIndoor.seen) { readHomey = true; validated = true; selected = (config && config.sensors || []).slice(); }
        apIndoor.seen = true;
        clear(t('heating'), a('indoor_intro'));
        view.querySelector('.pair-hero-title').textContent = a('indoor_title');
        view.querySelector('.pair-hero-title').hidden = false;
        view.querySelector('.pair-hero').classList.add('setup-source-hero');
        var choose = function (homey) { readHomey = homey; apIndoor(); };
        var nativeCard = el('div', undefined, 'setup-source-card' + (!readHomey ? ' is-selected' : ''));
        var native = el('label', undefined, 'setup-source-label');
        var n = document.createElement('input'); n.type = 'radio'; n.name = 'ap-indoor'; n.checked = !readHomey;
        n.onchange = function () { choose(false); };
        native.append(n, el('span', t('nibe'), 'setup-source-title'));
        nativeCard.appendChild(native);
        heating.sources.hidden = readHomey;
        heating.sources.classList.add('setup-native-detail');
        sourcePrompt(a('indoor_source_prompt'));
        nativeCard.appendChild(heating.sources);
        shell.appendChild(nativeCard);
        var homeyCard = el('div', undefined, 'setup-source-card' + (readHomey ? ' is-selected' : ''));
        var label = el('label', undefined, 'setup-source-label');
        var h = document.createElement('input'); h.type = 'radio'; h.name = 'ap-indoor'; h.checked = readHomey;
        h.onchange = function () { choose(true); };
        var text = el('span', undefined, 'setup-source-copy');
        var picked = readHomey && validated && selected.length;
        text.append(el('span', t('homey'), 'setup-source-title'),
            el('span', picked ? a('indoor_homey', {n: selected.length}) + ' · ' + a('indoor_homey_read') : a('indoor_homey_desc'), 'setup-source-description'));
        label.append(h, text); homeyCard.appendChild(label);
        if (readHomey) homeyCard.appendChild(smallAction(picked ? a('change_sensors') : t('choose_sensors'), picker));
        shell.appendChild(homeyCard);
        // Sent as BT50 today: with Autopilot the same sensors are only read, nothing to do on the pump.
        shell.appendChild(el('p', active ? a('indoor_bt50_note') : a('indoor_note'), 'register-desc'));
        shell.appendChild(button(t('next'), function () {
            if (readHomey && !picked) picker(); else afterApIndoor();
        }, true));
        back(steer);
    }
    function afterApIndoor() {
        var st = ap.status || {};
        // Coming to Autopilot from a mode where it did not run: say what to expect, once.
        var starting = st.mode !== 'autopilot' && st.mode !== 'test';
        if (starting) expect(); else pumpStep();
    }
    // Small stroke icons for the explainers, drawn in currentColor.
    var ICONS = {
        thermostat: '<circle cx="12" cy="12" r="8"/><path d="M12 12l3-3"/><path d="M12 4v2M20 12h-2M12 20v-2M4 12h2"/>',
        range: '<path d="M12 4v16"/><path d="M8 7l4-3 4 3M8 17l4 3 4-3"/>',
        away: '<path d="M4 11l8-6 8 6v8H4z"/><path d="M14 19v-5h-4v5"/><path d="M17 4l3 3"/>',
        off: '<path d="M12 4v8"/><path d="M7 7a7 7 0 1 0 10 0"/>',
        yes: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
        no: '<path d="M7 12h10"/>',
    };
    function icon(name, cls) {
        var span = el('span', undefined, 'setup-icon' + (cls ? ' ' + cls : ''));
        span.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + '</svg>';
        return span;
    }
    /** The modes side by side, as a grid of what each one does. */
    function compare() {
        clear(a('cmp_title'), '');
        view.querySelector('.pair-hero-title').hidden = false;
        var cols = [['auto', 'col_auto']];
        if (ap.status && ap.status.spa) cols.push(['spa', 'col_spa']);
        cols.push(['off', 'col_off']);
        // Each row: what is true for Autopilot, SPA and Off; a string is a yes with a qualifier.
        // Balanced against NIBE's own SPA info sheet (2025): SPA uses next-day prices, heats extra
        // when cheap and less when dear, for heating, hot water, pool and cooling, at three levels.
        var rows = [
            ['row_cheaper', {auto: true, spa: true, off: false}],
            ['row_covers', {auto: 'covers_auto', spa: 'covers_spa', off: false}],
            ['row_levels', {auto: 'levels_auto', spa: 'levels_spa', off: false}],
            ['row_starts', {auto: false, spa: true, off: true}],
            ['row_learns', {auto: true, spa: false, off: false}],
            ['row_forecast', {auto: true, spa: false, off: false}],
            ['row_price', {auto: true, spa: '!price_spot', off: false}],
            ['row_solar', {auto: 'solar_hotwater', spa: false, off: false}],
            ['row_homey_off', {auto: false, spa: true, off: true}],
        ];
        var grid = el('div', undefined, 'setup-compare-grid');
        grid.style.gridTemplateColumns = 'minmax(0, 1fr) repeat(' + cols.length + ', 4.6em)';
        grid.appendChild(el('span'));
        cols.forEach(function (c) {
            var head = el('strong', a(c[1]), 'setup-compare-head');
            if (c[0] === 'auto') head.appendChild(el('span', a('experimental'), 'setup-soon setup-compare-badge'));
            grid.appendChild(head);
        });
        rows.forEach(function (r) {
            grid.appendChild(el('span', a(r[0]), 'setup-compare-label'));
            cols.forEach(function (c) {
                var v = r[1][c[0]];
                var cell = el('span', undefined, 'setup-compare-cell');
                // 'key' is a yes with a qualifier, '!key' a no with one.
                if (typeof v === 'string') {
                    var no = v.charAt(0) === '!';
                    cell.appendChild(icon(no ? 'no' : 'yes', no ? 'is-no' : 'is-yes'));
                    cell.appendChild(el('small', a(no ? v.slice(1) : v)));
                    if (r[0] === 'row_covers' && c[0] === 'auto') cell.appendChild(el('small', a('covers_auto_soon'), 'setup-compare-soon'));
                }
                else cell.appendChild(icon(v ? 'yes' : 'no', v ? 'is-yes' : 'is-no'));
                grid.appendChild(cell);
            });
        });
        shell.appendChild(grid);
        shell.appendChild(el('p', a('cmp_note'), 'register-desc'));
        shell.appendChild(button(t('back'), steer, true));
        back(steer);
    }
    /** Before Autopilot's pump checklist: it learns first, then acts; and what stays the owner's. */
    function expect() {
        clear(a('exp_title'), '');
        view.querySelector('.pair-hero-title').hidden = false;
        var line = el('div', undefined, 'setup-timeline');
        [['is-learning', 'exp_learning', 'exp_learning_sub'], ['is-acting', 'exp_acting', 'exp_acting_sub']].forEach(function (p) {
            var phase = el('div', undefined, 'setup-phase ' + p[0]);
            phase.append(el('span', undefined, 'setup-phase-bar'), el('strong', a(p[1])), el('small', a(p[2])));
            line.appendChild(phase);
        });
        shell.appendChild(line);
        shell.appendChild(el('h3', a('exp_control'), 'setup-tiles-title'));
        var tiles = el('div', undefined, 'setup-tiles');
        [['thermostat', 'ctl_thermostat'], ['range', 'ctl_range'], ['away', 'ctl_away'], ['off', 'ctl_off']].forEach(function (c) {
            var tile = el('div', undefined, 'setup-tile');
            tile.append(icon(c[0]), el('strong', a(c[1])), el('small', a(c[1] + '_sub')));
            tiles.appendChild(tile);
        });
        shell.appendChild(tiles);
        shell.appendChild(button(t('next'), function () { rangeStep(pumpStep, expect); }, true));
        back(apIndoor);
    }
    // ---- Comfort range: one explained choice per range, with an example day. The numbers come
    // from the live planner's limits (smart_status `ranges`), so the text says what it will do.
    var RANGE_IDS = ['comfortable', 'save_some', 'save_most'];
    /** An example day for a range: price (a cheap night, an expensive evening) and indoor moving
     *  within the range, as a share of it: Comfort a shallow pre-heat that barely cools, Balanced
     *  a moderate swing, Savings most of its range. Illustrative, and labelled so. */
    var EXAMPLE_PRICE = [1.0, 0.95, 0.92, 0.9, 0.92, 1.0, 1.3, 1.7, 1.8, 1.5, 1.4, 1.35, 1.4, 1.6, 1.9, 2.2, 2.5, 2.7, 2.6, 2.3, 2.0, 1.8, 1.6, 1.3];
    var EXAMPLE_MOVE = {
        comfortable: [0, 0.06, 0.13, 0.22, 0.31, 0.39, 0.44, 0.42, 0.36, 0.33, 0.31, 0.3, 0.33, 0.36, 0.35, 0.24, 0.11, 0, -0.09, -0.13, -0.11, -0.06, 0, 0],
        save_some: [0, 0.13, 0.3, 0.47, 0.6, 0.7, 0.73, 0.63, 0.5, 0.4, 0.37, 0.4, 0.47, 0.53, 0.43, 0.2, -0.1, -0.37, -0.53, -0.6, -0.53, -0.37, -0.17, -0.03],
        save_most: [0, 0.17, 0.38, 0.6, 0.77, 0.9, 0.96, 0.86, 0.68, 0.55, 0.51, 0.55, 0.64, 0.68, 0.51, 0.17, -0.26, -0.6, -0.81, -0.9, -0.81, -0.6, -0.29, -0.09],
    };
    var SVG = 'http://www.w3.org/2000/svg';
    function svgEl(tag, attrs, text) {
        var n = document.createElementNS(SVG, tag);
        Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
        if (text !== undefined) n.textContent = text;
        return n;
    }
    /** A smooth path through points: monotone cubic, so it never overshoots a value it passes. */
    function smooth(pts) {
        var n = pts.length, d = 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
        if (n < 2) return d;
        var dx = [], m = [], t = [], i;
        for (i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = (pts[i + 1][1] - pts[i][1]) / dx[i]; }
        t[0] = m[0]; t[n - 1] = m[n - 2];
        for (i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
        for (i = 0; i < n - 1; i++) {
            if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
            var p = t[i] / m[i], q = t[i + 1] / m[i], h = p * p + q * q;
            if (h > 9) { var k = 3 / Math.sqrt(h); t[i] = k * p * m[i]; t[i + 1] = k * q * m[i]; }
        }
        for (i = 0; i < n - 1; i++)
            d += 'C' + (pts[i][0] + dx[i] / 3).toFixed(1) + ' ' + (pts[i][1] + t[i] * dx[i] / 3).toFixed(1) + ' '
                + (pts[i + 1][0] - dx[i] / 3).toFixed(1) + ' ' + (pts[i + 1][1] - t[i + 1] * dx[i] / 3).toFixed(1) + ' '
                + pts[i + 1][0].toFixed(1) + ' ' + pts[i + 1][1].toFixed(1);
        return d;
    }
    function rangeChart(id, band) {
        // Indoor on top, the price in its own low lane under it, so the two lines never cross.
        var W = 340, L = 6, R = W - 36, T = 8, B = 96, mid = (T + B) / 2, PT = B + 14, PB = PT + 24, H = PB + 18;
        var svg = svgEl('svg', {viewBox: '0 0 ' + W + ' ' + H, 'class': 'setup-range-chart', role: 'img', 'aria-label': a('range_example')});
        var x = function (h) { return L + (R - L) * h / 23; };
        // Indoor on the range's own scale, so each tab fills the chart; the ± label gives its size.
        var yt = function (dt) { return mid - dt * (B - T) / 2 / (band * 1.25); };
        var yp = function (p) { return PB - (PB - PT) * (p - 0.8) / 2; };
        svg.appendChild(svgEl('rect', {x: L, y: yt(band), width: R - L, height: yt(-band) - yt(band), rx: 4, 'class': 'setup-range-band'}));
        svg.appendChild(svgEl('line', {x1: L, x2: R, y1: mid, y2: mid, 'class': 'setup-range-target'}));
        // The band's edges, labelled at the right.
        var num = String(band).replace('.', a('decimal'));
        svg.appendChild(svgEl('text', {x: R + 6, y: yt(band) + 4}, '+' + num));
        svg.appendChild(svgEl('text', {x: R + 6, y: yt(-band) + 4}, '−' + num));
        var price = smooth(EXAMPLE_PRICE.map(function (p, h) { return [x(h), yp(p)]; }));
        svg.appendChild(svgEl('path', {d: price + 'L' + x(23).toFixed(1) + ' ' + PB + 'L' + x(0).toFixed(1) + ' ' + PB + 'Z', 'class': 'setup-range-price-area'}));
        svg.appendChild(svgEl('path', {d: price, 'class': 'setup-range-price'}));
        svg.appendChild(svgEl('text', {x: R + 6, y: PT + 12}, a('range_key_price')));
        svg.appendChild(svgEl('path', {d: smooth(EXAMPLE_MOVE[id].map(function (v, h) { return [x(h), yt(v * band)]; })), 'class': 'setup-range-indoor'}));
        [0, 6, 12, 18].forEach(function (h) { svg.appendChild(svgEl('text', {x: x(h), y: H - 4, 'text-anchor': 'middle'}, (h < 10 ? '0' : '') + h + ':00')); });
        return svg;
    }
    function rangeName(id) { return a('range_' + id); }
    /** Choose the comfort range: explained, then saved (Repair) or kept for the new device (pairing). */
    function rangeStep(next, from) {
        var st = ap.status || {};
        var facts = st.ranges || {};
        var current = ap.range || (RANGE_IDS.indexOf(st.range) >= 0 ? st.range : 'comfortable');
        clear(setupTitle(), a('range_intro'));
        view.querySelector('.pair-hero-title').textContent = a('range_title');
        var pills = el('div', undefined, 'setup-segment setup-range-tabs');
        var panel = el('div', undefined, 'setup-range');
        var use = button('', function () {}, true);
        function show(id) {
            current = id;
            pills.querySelectorAll('button').forEach(function (b) { b.classList.toggle('is-on', b.dataset.range === id); });
            var f = facts[id] || {};
            panel.replaceChildren();
            panel.appendChild(el('p', a('range_example'), 'setup-range-caption'));
            panel.appendChild(rangeChart(id, f.band || 0.5));
            var legend = el('div', undefined, 'setup-range-legend');
            [['setup-range-key-indoor', 'range_key_indoor'], ['setup-range-key-band', 'range_key_band']].forEach(function (k) {
                var item = el('span'); item.append(el('span', undefined, 'setup-range-key ' + k[0]), document.createTextNode(a(k[1]))); legend.appendChild(item);
            });
            panel.appendChild(legend);
            var list = el('ul', undefined, 'setup-range-facts');
            var num = function (v) { return String(v).replace('.', a('decimal')); };
            [[a('range_fact_band'), '±' + num(f.band) + ' °C'],
             [a('range_fact_cools'), f.weight > 1 ? a('range_fact_cools_value', {x: num(f.weight)}) : a('range_fact_cools_any')],
             [a('range_fact_coast'), a('range_fact_coast_value', {h: f.coast})]].forEach(function (r) {
                var li = el('li'); li.append(el('span', r[0]), el('b', r[1])); list.appendChild(li);
            });
            panel.appendChild(list);
            var feel = el('div', undefined, 'setup-range-feel');
            feel.append(el('strong', a('range_feel_title')), el('p', a('range_feel_' + id)));
            panel.appendChild(feel);
            use.textContent = a('range_use', {name: rangeName(id)});
        }
        RANGE_IDS.forEach(function (id) {
            var pill = el('button', rangeName(id), 'setup-segment-option hy-nostyle');
            pill.type = 'button'; pill.dataset.range = id;
            pill.onclick = function (e) { e.preventDefault(); show(id); };
            pills.appendChild(pill);
        });
        use.onclick = function (e) {
            e.preventDefault();
            emit('heating_range', {value: current}).then(function () { ap.range = current; next(); }).catch(fail);
        };
        shell.append(pills, panel);
        // Notes go above the button: the button is pinned to the bottom of the sheet.
        if (st.range === 'custom') shell.appendChild(el('p', a('range_custom_now'), 'register-desc'));
        shell.appendChild(el('p', a('range_custom'), 'register-desc'));
        shell.appendChild(use);
        show(current);
        back(from);
    }
    /** What the pump needs for this combination of indoor source and Smart mode, in one list. */
    function pumpStep() {
        var st = ap.status;
        var runs = ap.choice === 'autopilot' || ap.choice === 'test';
        var live = st.mode === 'autopilot' && st.verified;
        var verifyBt1 = ap.choice === 'autopilot' && !live;
        clear(t('heating'), a('pump_intro'));
        view.querySelector('.pair-hero-title').textContent = t('setup_pump');
        var onPump = el('ul', undefined, 'setup-checklist');
        if (indoorPending()) {
            onPump.appendChild(checkRow(null, t('enable_title'), t('enable_detail')));
            onPump.appendChild(checkRow(null, t('zone_title'), t('zone_detail')));
            onPump.appendChild(checkRow(null, t('control_title'), t('control_detail')));
        }
        var roomOk = st.roomControl === null ? null : st.roomControl === 0;
        if (runs) onPump.appendChild(checkRow(roomOk, a('room_control'),
            a(roomOk === false ? 'room_control_on' : roomOk ? 'room_control_off' : 'room_control_unknown')));
        else onPump.appendChild(checkRow(null, a('room_control'), a('room_control_optional')));
        if (ap.choice === 'autopilot') {
            onPump.appendChild(checkRow(live ? true : null, a('bt1'), a('bt1_detail')));
        }
        var group = el('section', undefined, 'setup-task-group');
        group.append(el('h3', t('on_pump')), onPump); shell.appendChild(group);
        if (runs) {
            var uses = el('ul', undefined, 'setup-checklist');
            var outdoorText = st.outdoorSensor ? (st.outdoorName || a('sensor')) + (st.outdoor !== null ? ' · ' + st.outdoor + ' °C' : ' · ' + a('no_reading'))
                : a('outdoor_forecast');
            uses.appendChild(checkRow(st.outdoorSensor && st.outdoor !== null ? true : null, a('outdoor'), outdoorText,
                smallAction(a('choose_outdoor'), function () { outdoorPicker(pumpStep); })));
            uses.appendChild(checkRow(st.prices ? true : null, a('prices'), a(st.prices ? 'prices_dynamic' : 'prices_fixed')));
            var usesGroup = el('section', undefined, 'setup-task-group');
            usesGroup.append(el('h3', a('autopilot_uses')), uses); shell.appendChild(usesGroup);
        }
        var needsPump = indoorPending() || verifyBt1;
        var confirm;
        if (needsPump) {
            confirm = document.createElement('input'); confirm.type = 'checkbox';
            var label = el('label', undefined, 'setup-option'); label.append(confirm, el('span', a('pump_confirm')));
            shell.appendChild(label);
            if (indoorPending()) shell.appendChild(el('p', t('feed_short'), 'setup-feed-summary'));
        }
        var go = button(needsPump ? t('verify') : t('save_section'), function () { busy(go, async function () {
            var results = [];
            // Autopilot's indoor temperature: Homey sensors read only, or the pump's own sensor.
            if (runs && options.mode === 'repair') {
                if (readHomey) { await emit('read_indoor', {sensors: selected.slice()}); active = false; config = {sensors: selected.slice(), state: 'read'}; }
                else if (config && (config.state === 'read' || config.state === 'active')) { await emit('stop_reading_indoor'); config = null; active = false; }
            }
            if (indoorPending()) {
                var indoor = await emit('activate_indoor', draft());
                active = true; config.state = 'active'; validated = false;
                results.push([indoor.measured + ' °C', t('success_received')]);
            }
            if (verifyBt1) {
                await emit('activate_autopilot');
                // Pairing: verified on the pump now, saved on the new Heating device when it is added.
                if (options.mode === 'pair') { ap.saved = ap.saved || {}; ap.saved.mode = 'autopilot'; ap.saved.verified = true; }
            } else if (ap.choice !== st.mode) {
                await emit('smart_choose', {value: ap.choice});
            }
            ap.status = await smartStatus().catch(function () { return ap.status; });
            // Autopilot on: what matters to the owner is the house, and where it is going.
            if (verifyBt1 && indoorReading(ap.status)) results.push(indoorReading(ap.status));
            ap.picked = false;
            finished(results, live && ap.choice !== 'autopilot');
        }); }, true);
        if (confirm) { go.disabled = true; confirm.onchange = function () { go.disabled = !confirm.checked; }; }
        if (runs && roomOk === false) go.disabled = true;
        shell.appendChild(go); back(runs ? apIndoor : temperature);
    }
    function finished(results, leftAutopilot) {
        clear(t('heating'), '');
        var success = el('section', undefined, 'setup-success'); success.setAttribute('role', 'status');
        var check = el('div', '✓', 'setup-success-check'); check.setAttribute('aria-hidden', 'true');
        success.append(check, el('h2', a('saved_setup')));
        results.forEach(function (r) {
            var reading = el('div', undefined, 'setup-success-reading');
            reading.append(el('strong', r[0]), el('span', r[1])); success.appendChild(reading);
        });
        if (ap.choice === 'autopilot' || ap.choice === 'test') success.appendChild(el('p', a('success_description')));
        if (leftAutopilot) success.appendChild(el('p', a('return_reminder')));
        shell.appendChild(success);
        shell.appendChild(button(t('next'), summary, true));
    }
    /** Later visits: every step with what it is set to and a way to change it. */
    function summary() {
        var st = ap.status || {};
        clear(t('heating'), a('summary_intro'));
        if (st.mode === 'autopilot' && st.status) {
            var box = el('section', undefined, 'setup-temperature-summary');
            box.append(el('h3', a('is_on')), el('p', st.status)); shell.appendChild(box);
        }
        var list = el('ul', undefined, 'setup-checklist');
        function row(title, value, go) {
            list.appendChild(checkRow(true, title, value, smallAction(a('change'), go)));
        }
        if (heating.zones) row(a('row_zone'), zoneLabel() || '—', zones);
        var runsNow = st.mode === 'autopilot' || st.mode === 'test';
        row(a('row_smart'), runsNow ? a('choose_on') + ' · ' + a(st.mode === 'test' ? 'mode_simulated' : 'mode_live')
            : a(st.mode === 'spa' ? 'choose_spa' : 'choose_off'), steer);
        if (runsNow) {
            var range = ap.range || st.range;
            row(a('row_range'), RANGE_IDS.indexOf(range) >= 0 ? rangeName(range) : range === 'custom' ? a('range_custom_name') : '—',
                function () { rangeStep(function () { st.range = ap.range; summary(); }, summary); });
        }
        if (runsNow) row(a('row_indoor'), readHomey || active ? a('indoor_homey', {n: selected.length}) : a('indoor_pump'), apIndoor);
        else row(a('row_indoor'), useHomey ? a('indoor_homey', {n: selected.length}) : a('indoor_pump'), temperature);
        if (st.mode === 'autopilot' || st.mode === 'test')
            row(a('row_outdoor'), st.outdoorSensor ? (st.outdoorName || a('sensor')) : a('outdoor_forecast'),
                function () { outdoorPicker(summary); });
        shell.appendChild(list);
        shell.appendChild(button(t('next'), function () { ready[heating.id] = true; hub(); }, true));
        back(hub);
    }
    // ---- Smart mode (pairing and Repair, a step of its function's setup): choose, then for
    // Autopilot heating the checklist and Verify. Comfort range and Away are capabilities on the device, not steps here.
    // One Smart mode state per function: pairing sets up heating and hot water in one session.
    var aps = {};
    var ap = {status: null, choice: 'off'};
    function useAp(role) {
        ap = aps[role] = aps[role] || {status: null, choice: 'off', role: role};
        return ap;
    }
    async function smartStatus() {
        var st = await emit('smart_status', {role: ap.role});
        if (options.mode === 'pair' && ap.saved) {
            st = Object.assign({}, st);
            if (ap.saved.mode) st.mode = ap.saved.mode;
            if (ap.saved.verified) st.verified = true;
            if (ap.saved.household) st.household = ap.saved.household;
            if (typeof ap.saved.reserve === 'number') st.reserve = ap.saved.reserve;
        }
        return st;
    }
    /** Autopilot as one choice, Live or Simulated inside it; then SPA and Off. */
    function smartPicker(st) {
        var soon = st.autopilot === false;
        if (ap.sim === undefined) ap.sim = ap.choice === 'test';
        var current = ap.choice === 'test' ? 'autopilot' : ap.choice;
        var choices = [{id: 'autopilot', title: a('choose_on'), description: a('choose_on_desc_' + st.role),
            badge: soon ? a('soon') : a('experimental'), disabled: soon}];
        if (st.spa) choices.push({id: 'spa', title: a('choose_spa'), description: a('choose_spa_desc')});
        choices.push({id: 'off', title: a('choose_off'), description: a('choose_off_desc_' + st.role)});
        var box = radios('smart-choice', choices, current, function (v) {
            ap.choice = v === 'autopilot' ? (ap.sim ? 'test' : 'autopilot') : v; ap.picked = true; seg.hidden = v !== 'autopilot';
            pills.querySelectorAll('button').forEach(function (b) { b.classList.toggle('is-on', b.dataset.mode === ap.choice); });
        });
        var seg = el('div', undefined, 'setup-segment-wrap'); seg.hidden = current !== 'autopilot' || soon;
        var pills = el('div', undefined, 'setup-segment');
        [['autopilot', 'mode_live'], ['test', 'mode_simulated']].forEach(function (m) {
            var pill = el('button', a(m[1]), 'setup-segment-option hy-nostyle' + (ap.choice === m[0] ? ' is-on' : ''));
            pill.type = 'button'; pill.dataset.mode = m[0];
            pill.onclick = function (e) {
                e.preventDefault(); ap.sim = m[0] === 'test'; ap.choice = m[0]; ap.picked = true;
                pills.querySelectorAll('button').forEach(function (b) { b.classList.toggle('is-on', b === pill); });
            };
            pills.appendChild(pill);
        });
        seg.append(pills, el('p', a('mode_note'), 'setup-segment-note'));
        var card = box.querySelector('input[value="autopilot"]').closest('.setup-choice');
        card.querySelector('.setup-source-copy').appendChild(seg);
        return box;
    }
    /** Smart mode is a step of its function's setup, so its pages carry that setup's name. */
    function setupTitle() {
        var fn = ap.role || options.role;
        return t({heating: 'heating', hotwater: 'hotwater', pool: 'pool', cooling: 'cooling'}[fn] || 'title');
    }
    /** The indoor temperature now and the thermostat Autopilot steers it to, for the success screen. */
    function indoorReading(st) {
        if (!st || typeof st.indoor !== 'number') return null;
        return [st.indoor + ' °C', typeof st.target === 'number' ? a('success_indoor', {target: st.target}) : a('success_indoor_now')];
    }
    function apMode() { return ap.choice === 'autopilot' || ap.choice === 'test'; }
    function a(key, tokens) {
        var text = Homey.__('pair.setup.smart.' + key);
        Object.keys(tokens || {}).forEach(function (k) { text = text.split('__' + k + '__').join(tokens[k]); });
        return text;
    }
    function apBadge(status) {
        if (status.mode === 'autopilot') return a('choose_on');
        if (status.mode === 'test') return a('choose_on') + ' · ' + a('mode_simulated');
        return a(status.mode === 'spa' ? 'badge_spa' : 'badge_off');
    }
    function radios(name, values, current, onchange) {
        var box = el('div', undefined, 'setup-choices');
        values.forEach(function (v) {
            var card = el('label', undefined, 'setup-source-card setup-choice' + (v.id === current ? ' is-selected' : ''));
            var input = document.createElement('input'); input.type = 'radio'; input.name = name; input.value = v.id;
            input.checked = v.id === current;
            if (v.disabled) { input.disabled = true; card.classList.add('is-disabled'); }
            input.onchange = function () {
                box.querySelectorAll('.setup-choice').forEach(function (c) { c.classList.remove('is-selected'); });
                card.classList.add('is-selected'); onchange(v.id);
            };
            var copy = el('span', undefined, 'setup-source-copy');
            var title = el('span', v.title, 'setup-source-title');
            if (v.badge) title.appendChild(el('span', v.badge, 'setup-soon'));
            copy.appendChild(title);
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
    async function smart() {
        clear(setupTitle(), a('intro'));
        var loading = el('p', t('checking')); shell.appendChild(loading); back(hub);
        try { ap.status = await smartStatus(); } catch (err) { loading.remove(); fail(err); return; }
        loading.remove();
        var st = ap.status;
        var heating = st.role === 'heating';
        var live = heating && st.mode === 'autopilot' && st.verified;
        if (!ap.picked) { ap.choice = st.mode; ap.sim = undefined; }
        if (live) {
            var box = el('section', undefined, 'setup-temperature-summary');
            box.append(el('h3', a('is_on')), el('p', st.status || ''));
            shell.appendChild(box);
            shell.appendChild(button(a('change_outdoor'), function () { outdoorPicker(smart); }));
        }
        // Pool and cooling: Autopilot is coming; shown, not selectable (smartPicker).
        shell.appendChild(smartPicker(st));
        if (heating && st.spaOn) shell.appendChild(el('p', a('spa_note'), 'register-desc'));
        var next = button(t('next'), function () {
            if (st.role === 'hotwater' && (ap.choice === 'autopilot' || ap.choice === 'test')) { hotwaterStep(); return; }
            if (ap.choice === st.mode && (ap.choice !== 'autopilot' || !heating || live)) { hub(); return; }
            if (heating && (ap.choice === 'autopilot' || ap.choice === 'test')) { checklist(); return; }
            busy(next, async function () {
                await emit('smart_choose', {value: ap.choice});
                ap.picked = false;
                done(ap.choice === 'test' ? a('saved_test') : a('saved'), live ? a('return_reminder') : '');
            });
        }, true);
        shell.appendChild(next);
    }
    /** Autopilot hot water: the Flows that would fight it, and for a home with a short history
     *  the household answers it starts from. */
    function hotwaterStep() {
        var st = ap.status;
        clear(setupTitle(), a('hw_intro'));
        // Autopilot plans in litres, so it needs the tank. The setup's own tank picker is moved in
        // here when none is chosen yet: in this setup if it has one, else on the device.
        var tank = sections.filter(function (s) { return s.role === 'hotwater' && s.content; })[0];
        var tankSelect = tank && tank.content.querySelector('select');
        var tankNeeded = tankSelect ? tankSelect.value === 'none' : !st.tank;
        if (tankNeeded) {
            var tankGroup = el('section', undefined, 'setup-task-group');
            tankGroup.append(el('h3', a('hw_tank')), el('p', a('hw_tank_intro'), 'register-desc'));
            if (tank) tankGroup.appendChild(tank.content);
            shell.appendChild(tankGroup);
        }
        var list = el('ul', undefined, 'setup-checklist');
        if (st.flows === null) list.appendChild(checkRow(null, a('hw_flows'), a('hw_flows_unknown')));
        else if (!st.flows.length) list.appendChild(checkRow(true, a('hw_flows'), a('hw_flows_none')));
        else {
            var names = el('ul', undefined, 'setup-flow-list');
            st.flows.forEach(function (f) { names.appendChild(el('li', f.name)); });
            list.appendChild(checkRow(null, a('hw_flows'), a('hw_flows_found'), names));
        }
        // The day type picks the day's profile: weekends are days off unless the owner or a Flow says otherwise.
        if (st.dayType) list.appendChild(checkRow(null, a('hw_daytype'),
            a(st.dayType.set ? 'hw_daytype_set' : 'hw_daytype_calendar', {type: st.dayType.name})));
        shell.appendChild(list);
        var saved = st.household;
        var ask = !!saved || st.historyDays === null || st.historyDays < st.starterDays;
        var answers = {people: saved ? saved.people : 2, morningHour: saved ? saved.morningHour : 7, freeDay: saved ? saved.freeDay : 'evening'};
        if (ask) {
            var group = el('section', undefined, 'setup-task-group');
            group.appendChild(el('h3', a('hw_household')));
            group.appendChild(el('p', st.historyDays === null ? a('hw_household_intro_unknown')
                : a('hw_household_intro', {days: st.historyDays}), 'register-desc'));
            var field = function (label, values, current, onchange) {
                var row = el('label', undefined, 'setup-field');
                var select = document.createElement('select'); select.setAttribute('aria-label', label);
                values.forEach(function (v) { select.add(new Option(v[1], String(v[0]))); });
                select.value = String(current);
                select.onchange = function () { onchange(Number(select.value)); };
                row.append(el('span', label), select); return row;
            };
            var people = [1, 2, 3, 4, 5, 6, 7, 8].map(function (n) { return [n, String(n)]; });
            var hours = [4, 5, 6, 7, 8, 9, 10].map(function (h) { return [h, (h < 10 ? '0' : '') + h + ':00']; });
            group.appendChild(field(a('hw_people'), people, answers.people, function (v) { answers.people = v; }));
            group.appendChild(field(a('hw_morning'), hours, answers.morningHour, function (v) { answers.morningHour = v; }));
            group.appendChild(el('p', a('hw_free'), 'setup-tiles-title'));
            group.appendChild(radios('hw-free', ['morning', 'daytime', 'evening'].map(function (id) {
                return {id: id, title: a('hw_free_' + id)};
            }), answers.freeDay, function (v) { answers.freeDay = v; }));
            shell.appendChild(group);
        }
        // The safety net: Autopilot never plans the tank below it. A value from the old setting
        // that is not one of the choices is kept as one.
        var reserve = typeof st.reserve === 'number' ? st.reserve : 40, keptReserve = reserve;
        var levels = [0, 20, 40, 60];
        if (levels.indexOf(reserve) < 0) levels.push(reserve);
        levels.sort(function (x, y) { return x - y; });
        var safety = el('section', undefined, 'setup-task-group');
        safety.appendChild(el('h3', a('hw_reserve')));
        var pick = document.createElement('select'); pick.setAttribute('aria-label', a('hw_reserve'));
        // The usual choices say what they cover, as the help page does; an old custom value is just litres.
        levels.forEach(function (l) {
            pick.add(new Option(!l ? a('hw_reserve_off') : l === 20 || l === 40 || l === 60 ? a('hw_reserve_' + l) : l + ' L', String(l)));
        });
        pick.value = String(reserve); pick.onchange = function () { reserve = Number(pick.value); };
        safety.append(pick, el('p', a('hw_reserve_hint'), 'register-desc'));
        shell.appendChild(safety);
        shell.appendChild(button(t('next'), function () {
            if (tankNeeded) {
                var invalid = tank && tank.content.querySelector('input:invalid');
                if (!tankSelect || tankSelect.value === 'none' || invalid) {
                    if (invalid) invalid.reportValidity(); else fail(new Error(a('hw_tank_missing')));
                    return;
                }
                ready[tank.id] = true;
            }
            solarStep(async function () {
                if (reserve !== keptReserve) await emit('hotwater_reserve', {litres: reserve});
                if (ask) await emit('hotwater_household', answers);
                if (ap.choice !== st.mode) await emit('smart_choose', {value: ap.choice});
                done(ap.choice === 'test' ? a('saved_test') : a('saved'));
            });
        }, true));
        back(smart);
    }
    /** Solar: what a scan of the home found, then two switches: charge on live export, and plan
     *  around the sun ahead. The answer is the home's, read by every function; hot water asks it
     *  because surplus pays most there. `finish` saves the rest. */
    function solarStep(finish) {
        clear(setupTitle(), a('solar_intro'));
        var loading = el('p', a('solar_scanning')); shell.appendChild(loading);
        back(hotwaterStep);
        emit('solar_scan').then(function (scan) { loading.remove(); drawSolar(scan, finish); })
            .catch(function (err) { loading.remove(); fail(err); });
    }
    function kw(w) { return w === null || w === undefined ? '' : ' · ' + Math.round(Math.abs(w) / 100) / 10 + ' kW'; }
    function drawSolar(scan, finish) {
        var list = el('ul', undefined, 'setup-checklist');
        var hasMeter = scan.meters.length > 0;
        var meter = scan.meter;
        if (scan.meters.length > 1) {
            var pick = document.createElement('select'); pick.setAttribute('aria-label', a('solar_meter'));
            scan.meters.forEach(function (m) { pick.add(new Option(m.name + kw(m.w), m.id)); });
            pick.value = meter; pick.onchange = function () { meter = pick.value; };
            list.appendChild(checkRow(true, a('solar_meter'), a('solar_meter_pick'), pick));
        } else if (hasMeter) list.appendChild(checkRow(true, a('solar_meter'), scan.meters[0].name + kw(scan.meters[0].w)));
        else list.appendChild(checkRow(null, a('solar_meter'), a('solar_meter_none')));
        list.appendChild(scan.solar.length
            ? checkRow(true, a('solar_panels'), scan.solar.map(function (d) { return d.name + kw(d.w); }).join(', '))
            : checkRow(null, a('solar_panels'), a('solar_panels_none')));
        shell.appendChild(list);
        if (scan.followsSun) shell.appendChild(el('p', scan.peakKw ? a('solar_evidence', {kw: scan.peakKw}) : a('solar_evidence_plain'), 'register-desc'));
        // Without a meter there is no export to read: say what is missing and save nothing.
        if (!hasMeter) {
            shell.appendChild(el('p', a(scan.solar.length ? 'solar_no_meter_found' : 'solar_need_meter'), 'register-desc'));
            var on = button(ap.choice === 'test' ? a('start_test') : t('save_section'), function () { busy(on, finish); }, true);
            shell.appendChild(on);
            return;
        }
        var live = scan.live !== null ? scan.live : true;
        var forecast = scan.forecast !== null ? scan.forecast : false;
        var box = el('div', undefined, 'setup-choices');
        box.append(toggle('solar-live', a('solar_live'), a('solar_live_hint'), live, function (v) { live = v; }),
            toggle('solar-forecast', a('solar_forecast'), a('solar_forecast_hint'), forecast, function (v) { forecast = v; }));
        shell.appendChild(box);
        var go = button(ap.choice === 'test' ? a('start_test') : t('save_section'), function () { busy(go, async function () {
            await emit('solar_save', meter ? {live: live, forecast: forecast, meter: meter} : {live: live, forecast: forecast});
            await finish();
        }); }, true);
        shell.appendChild(go);
    }
    /** A switch as a card, like `radios`' cards: title, one line under it. */
    function toggle(name, title, description, checked, onchange) {
        var card = el('label', undefined, 'setup-source-card setup-choice' + (checked ? ' is-selected' : ''));
        var input = document.createElement('input'); input.type = 'checkbox'; input.name = name; input.checked = checked;
        input.onchange = function () { card.classList.toggle('is-selected', input.checked); onchange(input.checked); };
        var copy = el('span', undefined, 'setup-source-copy');
        copy.append(el('span', title, 'setup-source-title'), el('span', description, 'setup-source-description'));
        card.append(input, copy);
        return card;
    }
    function checklist() {
        var st = ap.status;
        clear(setupTitle(), a('checklist_intro'));
        var list = el('ul', undefined, 'setup-checklist');
        var indoorOk = st.indoor !== null;
        list.appendChild(checkRow(indoorOk, a('indoor'), indoorOk ? st.indoor + ' °C' : a('indoor_missing')));
        var outdoorText = st.outdoorSensor ? (st.outdoorName || a('sensor')) + (st.outdoor !== null ? ' · ' + st.outdoor + ' °C' : ' · ' + a('no_reading'))
            : a('outdoor_forecast');
        list.appendChild(checkRow(st.outdoorSensor && st.outdoor !== null ? true : null, a('outdoor'), outdoorText,
            smallAction(a('choose_outdoor'), function () { outdoorPicker(checklist); })));
        list.appendChild(checkRow(st.prices ? true : null, a('prices'), a(st.prices ? 'prices_dynamic' : 'prices_fixed')));
        var roomOk = st.roomControl === null ? null : st.roomControl === 0;
        list.appendChild(checkRow(roomOk, a('room_control'), a(roomOk === false ? 'room_control_on' : roomOk ? 'room_control_off' : 'room_control_unknown')));
        if (ap.choice === 'autopilot') list.appendChild(checkRow(null, a('bt1'), a('bt1_detail')));
        shell.appendChild(list);
        var next = button(ap.choice === 'autopilot' ? t('next') : a('start_test'), function () {
            if (ap.choice === 'autopilot') { verifyStep(); return; }
            busy(next, async function () { await emit('smart_choose', {value: 'test'}); done(a('saved_test')); });
        }, true);
        next.disabled = !indoorOk || roomOk === false;
        shell.appendChild(next); back(smart);
    }
    function verifyStep() {
        clear(setupTitle(), a('verify_intro'));
        var group = el('section', undefined, 'setup-task-group');
        group.appendChild(el('h3', t('on_pump')));
        var steps = el('ol', undefined, 'setup-pump-steps');
        // Modbus is on already (the app is connected); whether it allows writes, Verify proves.
        [['bt1', 'bt1_detail']].forEach(function (k) {
            var step = el('li'); var copy = el('div'); copy.append(el('strong', a(k[0])), el('p', a(k[1])));
            step.appendChild(copy); steps.appendChild(step);
        });
        group.appendChild(steps); shell.appendChild(group);
        if (ap.status.spaOn) shell.appendChild(el('p', a('spa_note'), 'register-desc'));
        var confirm = document.createElement('input'); confirm.type = 'checkbox';
        var label = el('label', undefined, 'setup-option'); label.append(confirm, el('span', a('verify_confirm')));
        shell.appendChild(label);
        var verify = button(t('verify'), function () { busy(verify, async function () {
            await emit('activate_autopilot');
            ap.status = await smartStatus().catch(function () { return ap.status; });
            var now = indoorReading(ap.status);
            clear(setupTitle(), '');
            var success = el('section', undefined, 'setup-success'); success.setAttribute('role', 'status');
            var check = el('div', '✓', 'setup-success-check'); check.setAttribute('aria-hidden', 'true');
            success.append(check, el('h2', a('success_title')), el('p', a('success_description')));
            if (now) {
                var reading = el('div', undefined, 'setup-success-reading');
                reading.append(el('strong', now[0]), el('span', now[1])); success.appendChild(reading);
            }
            shell.appendChild(success);
            shell.appendChild(toHub());
        }); }, true);
        verify.disabled = true; confirm.onchange = function () { verify.disabled = !confirm.checked; };
        shell.appendChild(verify); back(checklist);
    }
    function done(message, detail) {
        clear(setupTitle(), '');
        var success = el('section', undefined, 'setup-success'); success.setAttribute('role', 'status');
        var check = el('div', '✓', 'setup-success-check'); check.setAttribute('aria-hidden', 'true');
        success.append(check, el('h2', message));
        if (detail) success.appendChild(el('p', detail));
        shell.appendChild(success);
        shell.appendChild(toHub());
    }
    /** Back to the hub with the Smart mode badge brought up to date. */
    function toHub() {
        var b = button(t('next'), function () { busy(b, async function () {
            ap.status = await smartStatus().catch(function () { return ap.status; }); hub();
        }); }, true);
        return b;
    }
    function outdoorPicker(then) {
        clear(setupTitle(), a('outdoor_intro'));
        var current = ap.status && ap.status.outdoorSensor;
        var choice = current ? current.deviceId + ':' + current.capabilityId : 'forecast';
        var search = document.createElement('input'); search.type = 'search'; search.placeholder = t('search');
        search.setAttribute('aria-label', t('search')); search.className = 'setup-search';
        var results = el('div'); results.setAttribute('aria-live', 'polite');
        var save = button(t('save_section'), function () { busy(save, async function () {
            var ref = choice === 'forecast' ? null : list.find(function (s) { return key(s) === choice; });
            await emit('set_outdoor_sensor', ref ? {deviceId: ref.deviceId, capabilityId: ref.capabilityId} : null);
            ap.status = await smartStatus(); then();
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
        if (section.role === 'smart') { useAp(section.fn || options.role); smart(); return; }
        if (section.role === 'heating') {
            heating = section;
            useAp('heating');
            // Later visits open on the summary: in Repair once something is set, in pairing once done.
            var set = options.mode === 'repair' ? active || readHomey || (ap.status && ap.status.mode !== 'off') : ready[section.id];
            if (flowing() && set) { summary(); return; }
            if (heating.zones) zones(); else if (flowing()) steer(); else temperature(); return;
        }
        clear(section.title, section.description);
        shell.appendChild(section.content);
        // Hot water: the tank, then its Smart mode, as Heating setup does.
        shell.appendChild(button(section.smart ? t('next') : t('save_section'), function () {
            var invalid = section.content.querySelector('input:invalid');
            if (invalid) { invalid.reportValidity(); return; }
            ready[section.id] = true;
            if (section.smart) { useAp(section.smart); smart(); } else hub();
        }, true)); back(hub);
    }
    /** The function whose Smart mode a section sets up, if any: heating's is part of Heating setup,
     *  hot water's follows its tank (`smart` on the section) or is a section of its own. */
    function fnOf(section) {
        if (section.role === 'smart') return section.fn || options.role;
        if (section.role === 'heating' && flowing()) return 'heating';
        return section.smart || null;
    }
    function hub() {
        clear(t('title'), t('intro'));
        sections.forEach(function (section) {
            var menu = button('', function () { open(section); }); menu.className = 'setup-menu hy-nostyle';
            var text = el('span'); text.append(el('strong', section.title), el('small', section.description));
            // Each function's own Smart mode: never whichever was opened last.
            var mine = aps[fnOf(section)];
            var badge = !ready[section.id] ? t('needs_setup') : mine && mine.status ? apBadge(mine.status) : t('ready');
            menu.append(text, el('span', badge + ' ›')); shell.appendChild(menu);
        });
        var next = button(t(options.mode === 'repair' ? 'save_changes' : 'review'), review, true);
        next.disabled = sections.some(function (s) { return !ready[s.id]; }); shell.appendChild(next);
        back(function () {
            shell.hidden = true; navigation.hidden = true;
            Array.from(form.children).forEach(function (n) { if (n !== shell && n !== parking) n.hidden = false; });
            if (options.consent) options.consent.hidden = true;
            view.querySelector('.pair-hero').classList.remove('setup-hero', 'setup-source-hero');
            heading(originalTitle, originalIntro);
        });
    }
    /** The last step: what saving does to the devices, grouped by why, from the same plan the
     *  devices follow (pairing: what gets added; Repair: what changes). */
    function review() {
        var pair = options.mode === 'pair';
        clear(t(pair ? 'gets_added' : 'what_changes'), t(pair ? 'gets_added_intro' : 'what_changes_intro'));
        var list = el('div', undefined, 'setup-changes'); shell.appendChild(list);
        var loading = el('p', t('checking')); list.appendChild(loading);
        if (zoneLabel()) shell.appendChild(el('p', t('thermostat_zone_review').replace('__zone__', zoneLabel()), 'register-desc'));
        if (useHomey) shell.appendChild(el('p', pair ? t('pending_hint') : t('active_note'), 'register-desc'));
        if (options.consent) { options.consent.hidden = false; options.consent.style.display = 'block'; shell.appendChild(options.consent); }
        var save = button(pair ? Homey.__('pair.devices.add') : t('save_changes'), function () {
            busy(save, async function () { await options.commit(); });
        }, true);
        shell.appendChild(save); back(hub);
        (options.preview ? options.preview() : Promise.resolve([])).then(function (devices) {
            loading.remove();
            var any = false;
            devices.forEach(function (d) {
                if (!d.groups.length) return;
                any = true;
                var card = el('section', undefined, 'setup-change-device');
                card.appendChild(el('h3', d.name));
                d.groups.forEach(function (g) {
                    var row = el('div', undefined, 'setup-change ' + (g.kind === 'add' ? 'is-add' : 'is-remove'));
                    row.appendChild(el('span', g.kind === 'add' ? '+' : '−', 'setup-change-mark'));
                    var copy = el('div');
                    copy.append(el('strong', g.reason === 'count' ? t('changes.count').replace('__n__', g.count) : g.names.join(', ')),
                        el('span', g.reason === 'count' ? t('changes.count_detail') : t('changes.' + g.reason)));
                    row.appendChild(copy); card.appendChild(row);
                });
                list.appendChild(card);
            });
            if (!any) list.appendChild(el('p', t('changes.none')));
        }).catch(function (err) { loading.remove(); fail(err); });
    }
    api.start = function (entries) {
        sections = entries;
        // Smart mode acts on its own (each choice saves); it never holds up Save changes.
        sections.forEach(function (s) { if (s.role === 'smart') ready[s.id] = true; });
        // Repair: Heating is already set up. Pairing: it is done when the owner has been through it.
        if (options.smart && options.mode === 'repair') sections.forEach(function (s) { if (s.role === 'heating') ready[s.id] = true; });
        if (options.smart || sections.some(function (s) { return s.role === 'smart'; }))
            sections.forEach(function (s) {
                var fn = fnOf(s);
                if (!fn) return;
                var mine = useAp(fn);
                smartStatus().then(function (st) { mine.status = st; mine.choice = st.mode; if (shell.querySelector('.setup-menu')) hub(); }).catch(function () {});
            });
        sections.forEach(function (s) { if (s.sources) parking.appendChild(s.sources); if (s.zones) parking.appendChild(s.zones); if (s.content) parking.appendChild(s.content); });
        hub();
    };
    api.indoorConfig = function () {
        if (aps.heating && (aps.heating.choice === 'autopilot' || aps.heating.choice === 'test') && flowing())
            return readHomey && validated ? {sensors: selected.slice(), state: 'read'} : null;
        return useHomey && validated ? draft() : null;
    };
    /** Pairing: each function's Smart mode and the answers that go with it, for the new devices. */
    api.choices = function () {
        var out = {};
        Object.keys(aps).forEach(function (fn) { if (aps[fn].saved) out[fn] = aps[fn].saved; });
        return out;
    };
}

// Zone cards for the thermostat target, or null when there is nothing to ask: one zone (or none)
// is not a choice. The radios carry data-source so the views' commit picks them up like any other
// source choice; `stored` preselects a zone the user already chose (Repair).
function nibeZoneCards(sources, options) {
    if (!sources || sources.length < 2) return null;
    var box = document.createElement('div');
    var known = sources.some(function (s) { return s.address === options.stored; });
    sources.forEach(function (source) {
        var card = document.createElement('div');
        card.className = 'setup-source-card';
        var label = document.createElement('label'); label.className = 'setup-source-label';
        var radio = document.createElement('input'); radio.type = 'radio';
        radio.name = options.name; radio.value = String(source.address);
        radio.dataset.source = 'target_temperature'; radio.dataset.label = source.label;
        if (options.device !== undefined) radio.dataset.device = options.device;
        radio.checked = known && source.address === options.stored;
        var copy = document.createElement('span'); copy.className = 'setup-source-copy';
        var title = document.createElement('span'); title.className = 'setup-source-title'; title.textContent = source.label;
        copy.appendChild(title);
        if (source.value !== undefined && source.value !== null) {
            var target = document.createElement('span'); target.className = 'setup-source-description';
            target.textContent = Homey.__('pair.setup.thermostat_zone_target').replace('__value__', source.value);
            copy.appendChild(target);
        }
        label.append(radio, copy); card.appendChild(label); box.appendChild(card);
    });
    var mark = function () {
        box.querySelectorAll('.setup-source-card').forEach(function (card) {
            card.classList.toggle('is-selected', !!card.querySelector('input:checked'));
        });
    };
    box.addEventListener('change', mark); mark();
    return box;
}

// A source's label in the user's language. The driver localises only en/sv, so the two families
// shown everywhere get keys of their own. A wireless slot is deliberately unnumbered: NIBE's slot
// order matches neither zones nor menu 5.4, so the reading beside it is what identifies it.
function nibeSourceLabel(source) {
    if (source.address === 116) return Homey.__('pair.setup.source_cs1');
    if (source.address >= 2800 && source.address <= 2878) return Homey.__('pair.setup.source_wireless');
    return source.label;
}
