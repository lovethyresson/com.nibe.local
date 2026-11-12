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
        var next = button(useHomey ? t('choose_sensors') : flowing() ? t('next') : t('save_section'), function () {
            if (useHomey) picker(); else afterIndoor();
        }, true);
        shell.appendChild(next); back(heating.zones ? zones : hub);
    }
    // Which zone the thermostat sets: its own step, before the temperature source, and only on a
    // pump with two or more zones. Continue stays disabled until a zone is picked.
    function zones() {
        clear(t('heating'), t('thermostat_zone_intro'));
        view.querySelector('.pair-hero-title').textContent = t('thermostat_zone_title');
        view.querySelector('.pair-hero-title').hidden = false;
        view.querySelector('.pair-hero').classList.add('setup-source-hero');
        shell.appendChild(heating.zones);
        var next = button(t('next'), temperature, true);
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
    // ---- Heating Setup as one flow (Repair on Heating, where Smart mode is available): zone →
    // indoor temperature → who steers (Smart mode) → one pump checklist for that combination →
    // Verify. Later visits open on a summary with a Change link per step.
    function flowing() { return options.mode === 'repair' && !!options.smart; }
    function afterIndoor() {
        if (!flowing()) { ready[heating.id] = true; hub(); return; }
        steer();
    }
    /** The indoor feed still has to be started: Homey sensors chosen and reviewed now. */
    function indoorPending() { return useHomey && validated; }
    async function steer() {
        clear(t('heating'), a('steer_intro'));
        view.querySelector('.pair-hero-title').textContent = a('steer_title');
        var loading = el('p', t('checking')); shell.appendChild(loading);
        back(useHomey ? picker : temperature);
        try { ap.status = await emit('smart_status'); } catch (err) { loading.remove(); fail(err); return; }
        loading.remove();
        var st = ap.status;
        if (!ap.picked) ap.choice = st.mode;
        var choices = [
            {id: 'autopilot', title: a('choose_on'), description: a('choose_on_desc_heating')},
            {id: 'test', title: a('choose_test'), description: a('choose_test_desc')},
        ];
        if (st.spa) choices.push({id: 'spa', title: a('choose_spa'), description: a('choose_spa_desc')});
        choices.push({id: 'off', title: a('choose_off'), description: a('choose_off_desc_heating')});
        shell.appendChild(radios('smart-choice', choices, ap.choice, function (v) { ap.choice = v; ap.picked = true; }));
        var how = button(a('compare_link'), compare); how.classList.add('setup-small-action'); shell.appendChild(how);
        if (st.spaOn) shell.appendChild(el('p', a('spa_note'), 'register-desc'));
        shell.appendChild(button(t('next'), function () {
            // Coming to Autopilot from a mode where it did not run: say what to expect, once.
            var starting = (ap.choice === 'autopilot' || ap.choice === 'test') && st.mode !== 'autopilot' && st.mode !== 'test';
            if (starting) expect(); else pumpStep();
        }, true));
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
        cols.forEach(function (c) { grid.appendChild(el('strong', a(c[1]), 'setup-compare-head')); });
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
        shell.appendChild(button(t('next'), pumpStep, true));
        back(steer);
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
            onPump.appendChild(checkRow(live ? true : null, a('modbus'), a('modbus_detail')));
        }
        var group = el('section', undefined, 'setup-task-group');
        group.append(el('h3', t('on_pump')), onPump); shell.appendChild(group);
        if (runs) {
            var uses = el('ul', undefined, 'setup-checklist');
            var outdoorText = st.outdoorSensor ? (st.outdoorName || a('sensor')) + (st.outdoor !== null ? ' · ' + st.outdoor + ' °C' : ' · ' + a('no_reading'))
                : a('outdoor_forecast');
            uses.appendChild(checkRow(st.outdoorSensor && st.outdoor !== null ? true : null, a('outdoor'), outdoorText,
                button(a('choose_outdoor'), function () { outdoorPicker(pumpStep); })));
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
            if (indoorPending()) {
                var indoor = await emit('activate_indoor', draft());
                active = true; config.state = 'active'; validated = false;
                results.push([indoor.measured + ' °C', t('success_received')]);
            }
            if (verifyBt1) {
                var fed = await emit('activate_autopilot');
                results.push([fed.fed + ' °C', a('success_received')]);
            } else if (ap.choice !== st.mode) {
                await emit('smart_choose', {value: ap.choice});
            }
            ap.status = await emit('smart_status').catch(function () { return ap.status; });
            ap.picked = false;
            finished(results, live && ap.choice !== 'autopilot');
        }); }, true);
        if (confirm) { go.disabled = true; confirm.onchange = function () { go.disabled = !confirm.checked; }; }
        if (runs && roomOk === false) go.disabled = true;
        shell.appendChild(go); back(steer);
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
            list.appendChild(checkRow(true, title, value, button(a('change'), go)));
        }
        if (heating.zones) row(a('row_zone'), zoneLabel() || '—', zones);
        row(a('row_indoor'), useHomey ? a('indoor_homey', {n: selected.length}) : a('indoor_pump'), temperature);
        row(a('row_smart'), a({autopilot: 'choose_on', test: 'choose_test', spa: 'choose_spa'}[st.mode] || 'choose_off'), steer);
        if (st.mode === 'autopilot' || st.mode === 'test')
            row(a('row_outdoor'), st.outdoorSensor ? (st.outdoorName || a('sensor')) : a('outdoor_forecast'),
                function () { outdoorPicker(summary); });
        shell.appendChild(list);
        shell.appendChild(button(t('next'), function () { ready[heating.id] = true; hub(); }, true));
        back(hub);
    }
    // ---- Smart mode (Repair only, Heating and Hot water): choose, then for Autopilot heating the
    // checklist and Verify. Comfort range and Away are capabilities on the device, not steps here.
    var ap = {status: null, choice: 'off'};
    function a(key, tokens) {
        var text = Homey.__('pair.setup.smart.' + key);
        Object.keys(tokens || {}).forEach(function (k) { text = text.split('__' + k + '__').join(tokens[k]); });
        return text;
    }
    function apBadge(status) {
        return a(status.mode === 'autopilot' ? 'badge_on'
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
    async function smart() {
        clear(a('title'), a('intro'));
        var loading = el('p', t('checking')); shell.appendChild(loading); back(hub);
        try { ap.status = await emit('smart_status'); } catch (err) { loading.remove(); fail(err); return; }
        loading.remove();
        var st = ap.status;
        var heating = st.role === 'heating';
        var live = heating && st.mode === 'autopilot' && st.verified;
        ap.choice = st.mode;
        if (live) {
            var box = el('section', undefined, 'setup-temperature-summary');
            box.append(el('h3', a('is_on')), el('p', st.status || ''));
            shell.appendChild(box);
            shell.appendChild(button(a('change_outdoor'), function () { outdoorPicker(smart); }));
        }
        var choices = [
            {id: 'autopilot', title: a('choose_on'), description: a('choose_on_desc_' + st.role)},
            {id: 'test', title: a('choose_test'), description: a('choose_test_desc')},
        ];
        if (st.spa) choices.push({id: 'spa', title: a('choose_spa'), description: a('choose_spa_desc')});
        choices.push({id: 'off', title: a('choose_off'), description: a('choose_off_desc_' + st.role)});
        shell.appendChild(radios('smart-choice', choices, ap.choice, function (v) { ap.choice = v; }));
        if (heating && st.spaOn) shell.appendChild(el('p', a('spa_note'), 'register-desc'));
        var next = button(t('next'), function () {
            if (ap.choice === st.mode && (ap.choice !== 'autopilot' || !heating || live)) { hub(); return; }
            if (heating && (ap.choice === 'autopilot' || ap.choice === 'test')) { checklist(); return; }
            busy(next, async function () {
                await emit('smart_choose', {value: ap.choice});
                done(ap.choice === 'test' ? a('saved_test') : a('saved'), live ? a('return_reminder') : '');
            });
        }, true);
        shell.appendChild(next);
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
        var next = button(ap.choice === 'autopilot' ? t('next') : a('start_test'), function () {
            if (ap.choice === 'autopilot') { verifyStep(); return; }
            busy(next, async function () { await emit('smart_choose', {value: 'test'}); done(a('saved_test')); });
        }, true);
        next.disabled = !indoorOk || roomOk === false;
        shell.appendChild(next); back(smart);
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
        if (ap.status.spaOn) shell.appendChild(el('p', a('spa_note'), 'register-desc'));
        var confirm = document.createElement('input'); confirm.type = 'checkbox';
        var label = el('label', undefined, 'setup-option'); label.append(confirm, el('span', a('verify_confirm')));
        shell.appendChild(label);
        var verify = button(t('verify'), function () { busy(verify, async function () {
            var result = await emit('activate_autopilot');
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
        shell.appendChild(verify); back(checklist);
    }
    function done(message, detail) {
        clear(a('title'), '');
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
            ap.status = await emit('smart_status').catch(function () { return ap.status; }); hub();
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
            ap.status = await emit('smart_status'); then();
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
        if (section.role === 'smart') { smart(); return; }
        if (section.role === 'heating') {
            heating = section;
            if (flowing() && (active || (ap.status && ap.status.mode !== 'off'))) { summary(); return; }
            if (heating.zones) zones(); else temperature(); return;
        }
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
            var badge = section.role === 'smart' || (section.role === 'heating' && flowing()) ? (ap.status ? apBadge(ap.status) : '')
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
        if (zoneLabel()) shell.appendChild(el('p', t('thermostat_zone_review').replace('__zone__', zoneLabel())));
        if (useHomey) shell.appendChild(el('p', options.mode === 'pair' ? t('pending_hint') : t('active_note')));
        if (options.consent) { options.consent.hidden = false; options.consent.style.display = 'block'; shell.appendChild(options.consent); }
        var save = button(Homey.__(options.mode === 'pair' ? 'pair.devices.add' : 'pair.ok'), function () {
            busy(save, async function () { await options.commit(); });
        }, true);
        shell.appendChild(save); back(hub);
    }
    api.start = function (entries) {
        sections = entries;
        // Smart mode acts on its own (each choice saves); it never holds up Save changes.
        sections.forEach(function (s) { if (s.role === 'smart') ready[s.id] = true; });
        if (options.smart) sections.forEach(function (s) { if (s.role === 'heating') ready[s.id] = true; });
        if (options.smart || sections.some(function (s) { return s.role === 'smart'; }))
            emit('smart_status').then(function (st) { ap.status = st; if (shell.querySelector('.setup-menu')) hub(); }).catch(function () {});
        sections.forEach(function (s) { if (s.sources) parking.appendChild(s.sources); if (s.zones) parking.appendChild(s.zones); if (s.content) parking.appendChild(s.content); });
        hub();
    };
    api.indoorConfig = function () { return useHomey && validated ? draft() : null; };
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
