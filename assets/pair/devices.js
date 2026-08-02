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

function renderGroup(deviceIndex, group, deviceChecked) {
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
                details.appendChild(renderGroup(index, g, candidate.detected));
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
    createSelected(chosen, 0, function () {
        Homey.hideLoadingOverlay();
        Homey.done();
    });
};

Homey.emit('get_pairing_devices', {}, function (err, result) {
    if (err) {
        Homey.alert((err && err.message) || String(err), 'error');
        return;
    }
    candidates = result || [];
    render();
});
