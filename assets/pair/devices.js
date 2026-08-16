/* Pairing device picker. Lists main + function devices; each expands to its feature
 * groups (with per-group toggles) and the capabilities in them, each flagged by
 * whether detection found data. Creates the checked devices, honouring the toggles. */
/* global Homey */

Homey.setTitle(Homey.__('pair.devices.title'));

var candidates = [];

function groupChecked(deviceIndex, groupId) {
    var box = document.querySelector('input[data-device="' + deviceIndex + '"][data-group="' + groupId + '"]');
    return box ? box.checked : true;
}

// Keep a device's feature-group checkboxes in step with its own checkbox: unchecked device →
// every group off and disabled; checked device → groups restored to their recommended state
// (core fixed-on). Feature groups are never checked while the device itself isn't.
function syncGroups(deviceIndex, deviceChecked) {
    document.querySelectorAll('input[data-device="' + deviceIndex + '"][data-group]').forEach(function (box) {
        var fixed = box.dataset.fixed === '1';
        if (deviceChecked) {
            box.checked = fixed || box.dataset.recommended === '1';
            box.disabled = fixed;
        } else {
            box.checked = false;
            box.disabled = true;
        }
    });
}

// A radio group for a capability whose value can come from several live registers that mean
// different things (indoor temperature is the case: climate-system average vs a single sensor).
// Detection only reports a register here when two or more candidates answered plausibly, so an
// entry always represents a real question. Each option shows what that address actually read —
// without the numbers there is no way to tell the candidates apart.
function renderSources(deviceIndex, candidate, capName, parent) {
    var choices = candidate.choices || {};
    var sources = choices[capName];
    if (!sources || !sources.length)
        return;
    // One live candidate is not a choice — but it is still worth naming, so "Indoor temperature"
    // doesn't leave you guessing which sensor the pump is regulating on.
    if (sources.length === 1) {
        var only = document.createElement('div');
        only.className = 'register-sources';
        var text = document.createElement('div');
        text.className = 'register-desc';
        text.textContent = Homey.__('pair.sources.using') + ' ' + sources[0].label
            + (sources[0].value === undefined || sources[0].value === null
                ? '' : ' — ' + sources[0].value);
        only.appendChild(text);
        parent.appendChild(only);
        return;
    }
    // The device template already carries detection's default (the first live candidate), so
    // preselect that rather than assuming index 0 twice over.
    var selection = candidate.device && candidate.device.store && candidate.device.store.selection;
    var stored = selection && selection.addresses && selection.addresses[capName];

    var box = document.createElement('div');
    box.className = 'register-sources';

    var prompt = document.createElement('div');
    prompt.className = 'register-desc';
    prompt.textContent = Homey.__('pair.sources.prompt');
    box.appendChild(prompt);

    var matched = sources.some(function (s) { return s.address === stored; });
    sources.forEach(function (source, i) {
        var option = document.createElement('label');
        option.className = 'source-option';
        var radio = document.createElement('input');
        radio.type = 'radio';
        // Scoped by device index as well as name: the same register can appear under more than
        // one candidate device on the page, and they must not share a radio group.
        radio.name = 'source:' + deviceIndex + ':' + capName;
        radio.value = String(source.address);
        radio.checked = matched ? source.address === stored : i === 0;
        radio.dataset.device = deviceIndex;
        radio.dataset.source = capName;
        option.appendChild(radio);
        var text = ' ' + source.label;
        if (source.value !== undefined && source.value !== null)
            text += ' — ' + source.value;
        option.appendChild(document.createTextNode(text));
        box.appendChild(option);
    });
    parent.appendChild(box);
}

function renderGroup(deviceIndex, candidate, group, deviceChecked) {
    var wrap = document.createElement('div');
    wrap.className = 'feature-subgroup';

    var head = document.createElement('label');
    head.className = 'subgroup-head';
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.device = deviceIndex;
    box.dataset.group = group.id;
    box.dataset.recommended = group.selected ? '1' : '';
    box.dataset.fixed = group.fixed ? '1' : '';
    // A feature group is only ever checked when its device is checked (core is then fixed-on).
    // Toggling the device box syncs these (see syncGroups).
    box.checked = deviceChecked && (group.selected || group.fixed);
    box.disabled = group.fixed || !deviceChecked;
    head.appendChild(box);
    head.appendChild(document.createTextNode(' ' + group.name));
    wrap.appendChild(head);

    group.caps.forEach(function (c) {
        var line = document.createElement('div');
        line.className = 'register-line';
        var dot = document.createElement('span');
        dot.className = 'reg-dot ' + (c.detected ? 'reg-dot-on' : 'reg-dot-off');
        line.appendChild(dot);
        line.appendChild(document.createTextNode(' ' + c.title));
        wrap.appendChild(line);
        renderSources(deviceIndex, candidate, c.name, wrap);
    });
    return wrap;
}

function render() {
    var list = document.getElementById('devices');
    list.innerHTML = '';
    candidates.forEach(function (candidate, index) {
        var item = document.createElement('div');
        item.className = 'feature-group';

        var row = document.createElement('div');
        row.className = 'feature-row';

        var label = document.createElement('label');
        label.className = 'feature-label';
        var toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.checked = candidate.detected; // pre-check the devices we saw data for
        toggle.dataset.index = index;
        // The device's groups follow its checkbox: never checked while the device isn't.
        toggle.onchange = function () { syncGroups(index, toggle.checked); };
        label.appendChild(toggle);
        label.appendChild(document.createTextNode(' ' + candidate.name));
        row.appendChild(label);

        var badge = document.createElement('span');
        badge.className = 'badge ' + (candidate.detected ? 'badge-detected' : 'badge-nodata');
        badge.textContent = Homey.__(candidate.detected ? 'pair.devices.detected' : 'pair.devices.notdetected');
        row.appendChild(badge);

        var groups = candidate.groups || [];
        var expand = null;
        if (groups.length) {
            expand = document.createElement('a');
            expand.href = '#';
            expand.className = 'expand';
            expand.textContent = '▸';
            row.appendChild(expand);
        }
        item.appendChild(row);

        if (candidate.description) {
            var desc = document.createElement('div');
            desc.className = 'register-desc';
            desc.textContent = candidate.description;
            item.appendChild(desc);
        }

        if (groups.length) {
            var details = document.createElement('div');
            details.className = 'registers';
            details.style.display = 'none';
            groups.forEach(function (g) {
                details.appendChild(renderGroup(index, candidate, g, candidate.detected));
            });
            item.appendChild(details);
            expand.onclick = function (e) {
                e.preventDefault();
                var open = details.style.display !== 'none';
                details.style.display = open ? 'none' : 'block';
                expand.textContent = open ? '▸' : '▾';
            };
        }

        list.appendChild(item);
    });
    document.getElementById('add').style.display = 'block';
    document.getElementById('consent-row').style.display = 'block';
}

// Rebuild the device to create from the group toggles: the core group is always
// included; each checked group contributes the capabilities that had data, while its
// no-data registers are recorded as overrides so they stay off.
function buildDevice(candidate, index) {
    var device = JSON.parse(JSON.stringify(candidate.device));
    var caps = [];
    var groups = {};
    var overrides = {};
    (candidate.groups || []).forEach(function (g) {
        if (g.id === 'core') {
            g.caps.forEach(function (c) { caps.push(c.name); });
            return;
        }
        var checked = groupChecked(index, g.id);
        groups[g.id] = checked;
        if (checked)
            g.caps.forEach(function (c) {
                if (c.detected)
                    caps.push(c.name);
                else
                    overrides[c.name] = false;
            });
    });
    device.capabilities = caps;
    device.store = device.store || {};
    // Carry the resolved register addresses through. Detection put them on the template and
    // they are not a user choice, so rebuilding the selection from the checkboxes must not
    // drop them — without this a relocated register would silently fall back to the address
    // its model doesn't implement.
    var resolved = device.store.selection && device.store.selection.addresses;
    device.store.selection = { groups: groups, overrides: overrides };
    if (resolved)
        device.store.selection.addresses = resolved;
    // Where the user was offered a choice of source, their pick overrides detection's default.
    // Layered on top of `resolved` rather than replacing it: the two write to the same map but
    // cover different registers, and dropping the detection-resolved ones would undo relocation.
    document.querySelectorAll('input[data-source]:checked').forEach(function (radio) {
        if (Number(radio.dataset.device) !== index)
            return;
        device.store.selection.addresses = device.store.selection.addresses || {};
        device.store.selection.addresses[radio.dataset.source] = Number(radio.value);
    });
    return device;
}

function createSelected(devices, i, done) {
    if (i >= devices.length) {
        done();
        return;
    }
    Homey.createDevice(devices[i]).then(function () {
        createSelected(devices, i + 1, done);
    }).catch(function (error) {
        Homey.hideLoadingOverlay();
        Homey.alert((error && error.message) || String(error), 'error');
    });
}

// Store the answer before creating anything. The choice is the user's regardless of whether
// device creation then succeeds, and storing it first is also what lets the driver start tracking
// in time to record this very pairing run.
function applyConsent(done) {
    var consent = document.getElementById('analytics-consent').checked;
    Homey.emit('set_analytics_consent', consent, function () {
        if (consent)
            Homey.emit('track_ui', {view: 'pair_devices', button: 'add'}, function () {});
        done();
    });
}

document.getElementById('add').onclick = function (e) {
    e.preventDefault();
    var chosen = [];
    document.querySelectorAll('input[data-index]').forEach(function (box) {
        if (box.checked)
            chosen.push(buildDevice(candidates[box.dataset.index], box.dataset.index));
    });
    if (!chosen.length) {
        Homey.alert(Homey.__('pair.devices.select_one'), 'error');
        return;
    }
    Homey.showLoadingOverlay();
    applyConsent(function () {
        createSelected(chosen, 0, function () {
            Homey.hideLoadingOverlay();
            Homey.done();
        });
    });
};

// Pre-tick only if consent was already given on an earlier pairing — a second pump should not
// re-ask a question already answered. Default is unticked: this is opt-in.
Homey.emit('get_context', {}, function (err, ctx) {
    if (!err && ctx && ctx.analyticsConsent)
        document.getElementById('analytics-consent').checked = true;
});

Homey.emit('get_pairing_devices', {}, function (err, result) {
    if (err) {
        Homey.alert((err && err.message) || String(err), 'error');
        return;
    }
    candidates = result || [];
    render();
});
