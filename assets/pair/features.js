/* Used by repair/features.html only — pairing picks features per device in the
 * device picker (devices.js) instead.
 * Renders the feature-group checklist (with per-capability overrides) and applies
 * the final selection to the device being repaired. */
/* global Homey */

Homey.setTitle(Homey.__('pair.features.title'));

var context = null;
var detection = null;

function groupChecked(group) {
    // Repair: start from the current selection. Pair with detection: start
    // from the recommendation. Otherwise (detection skipped): everything on.
    if (context.selection && context.selection.groups)
        return context.selection.groups[group.id] !== false;
    if (detection && detection.recommendations && detection.recommendations[group.id])
        return detection.recommendations[group.id].recommended;
    return true;
}

function unsupported(register) {
    return !!(detection && detection.unsupported
        && detection.unsupported.indexOf(register.name) !== -1);
}

function registerChecked(group, register, checked) {
    var overrides = context.selection && context.selection.overrides;
    // An explicit stored override is a deliberate choice the user made last time, so it wins
    // outright. cleanSelection() only records an override when it *differs* from its group,
    // so its presence really does mean "the user decided this one", not "this was the default".
    if (overrides && typeof overrides[register.name] === 'boolean')
        return overrides[register.name];
    // Otherwise a fresh detection pass may veto: a register the pump did not answer for
    // cannot ever hold a value, so don't pre-tick it just because its group is on. Repair
    // starts from the stored selection, so without this a capability added before detection
    // knew better would stay ticked and be re-applied every time.
    if (checked && unsupported(register))
        return false;
    return checked;
}

// The candidates detection found alive for a register, or null when it declares none.
function sourcesFor(register) {
    var choices = detection && detection.choices;
    var sources = choices && choices[register.name];
    return (sources && sources.length) ? sources : null;
}

// Which candidate starts selected: the address this device already reads, if it is still one of
// the offered candidates, otherwise the first live one. A stored address that is no longer
// offered means the pump changed under the device, and falling back beats preselecting nothing.
function selectedSource(register, sources) {
    var addresses = context.selection && context.selection.addresses;
    var stored = addresses && addresses[register.name];
    for (var i = 0; i < sources.length; i++)
        if (sources[i].address === stored)
            return stored;
    return sources[0].address;
}

// What sensor this capability is actually reading. With one live candidate that is a statement
// ("Using: climate system 1 average — 23.5"); with several it becomes a radio group, because
// they are different quantities and only the user knows which one they mean. Either way the
// sensor is named — "Indoor temperature" alone tells you nothing about where it comes from,
// which is what made pairing confusing.
function renderSources(register, parent) {
    var sources = sourcesFor(register);
    if (!sources)
        return;
    var chosen = selectedSource(register, sources);

    var box = document.createElement('div');
    box.className = 'register-sources';

    if (sources.length === 1) {
        var only = document.createElement('div');
        only.className = 'register-desc';
        only.textContent = Homey.__('pair.sources.using') + ' ' + sources[0].label
            + (sources[0].value === undefined || sources[0].value === null
                ? '' : ' — ' + sources[0].value);
        box.appendChild(only);
        parent.appendChild(box);
        return;
    }

    var prompt = document.createElement('div');
    prompt.className = 'register-desc';
    prompt.textContent = Homey.__('pair.sources.prompt');
    box.appendChild(prompt);

    sources.forEach(function (source) {
        var option = document.createElement('label');
        option.className = 'source-option';
        var radio = document.createElement('input');
        radio.type = 'radio';
        // One radio group per register, keyed by name so several can coexist on the page.
        radio.name = 'source:' + register.name;
        radio.value = String(source.address);
        radio.checked = source.address === chosen;
        radio.dataset.source = register.name;
        option.appendChild(radio);

        var text = ' ' + source.label;
        if (source.value !== undefined && source.value !== null)
            text += ' — ' + source.value;
        option.appendChild(document.createTextNode(text));
        box.appendChild(option);
    });
    parent.appendChild(box);
}

function evidenceText(group) {
    if (!detection || !detection.recommendations || !detection.recommendations[group.id])
        return '';
    return Homey.__('pair.evidence.' + detection.recommendations[group.id].evidence);
}

function render() {
    var list = document.getElementById('groups');
    list.innerHTML = '';
    context.groups.forEach(function (group) {
        var checked = groupChecked(group);

        var item = document.createElement('div');
        item.className = 'feature-group';

        var row = document.createElement('div');
        row.className = 'feature-row';

        var label = document.createElement('label');
        label.className = 'feature-label';
        var toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.checked = checked;
        toggle.dataset.group = group.id;
        label.appendChild(toggle);
        label.appendChild(document.createTextNode(' ' + group.name));
        row.appendChild(label);

        var evidence = evidenceText(group);
        if (evidence) {
            var hint = document.createElement('span');
            hint.className = 'evidence';
            hint.textContent = evidence;
            row.appendChild(hint);
        }

        var expand = document.createElement('a');
        expand.href = '#';
        expand.className = 'expand';
        expand.textContent = '▸';
        row.appendChild(expand);

        item.appendChild(row);

        var details = document.createElement('div');
        details.className = 'registers';
        details.style.display = 'none';
        group.registers.forEach(function (register) {
            var regLabel = document.createElement('label');
            regLabel.className = 'register-label';
            var regBox = document.createElement('input');
            regBox.type = 'checkbox';
            regBox.checked = registerChecked(group, register, checked);
            regBox.dataset.register = register.name;
            regLabel.appendChild(regBox);
            regLabel.appendChild(document.createTextNode(' ' + register.title + ' '));

            var badge = document.createElement('span');
            badge.className = 'badge ' + (register.adjustable ? 'badge-adjustable' : 'badge-insight');
            badge.textContent = Homey.__(register.adjustable ? 'pair.badge.adjustable' : 'pair.badge.insight');
            regLabel.appendChild(badge);

            // Say why a box arrived unticked, rather than letting it look like a glitch.
            if (unsupported(register)) {
                var noData = document.createElement('span');
                noData.className = 'badge badge-nodata';
                noData.textContent = Homey.__('pair.devices.notdetected');
                regLabel.appendChild(noData);
            }

            if (register.description) {
                var desc = document.createElement('div');
                desc.className = 'register-desc';
                desc.textContent = register.description;
                regLabel.appendChild(desc);
            }
            details.appendChild(regLabel);
            // Outside the <label>: a click anywhere in a label toggles its checkbox, so nesting
            // the radios there would untick the capability every time you pick a source.
            renderSources(register, details);
        });
        item.appendChild(details);

        expand.onclick = function (e) {
            e.preventDefault();
            var open = details.style.display !== 'none';
            details.style.display = open ? 'none' : 'block';
            expand.textContent = open ? '▸' : '▾';
        };

        // Toggling a group resets its per-capability overrides
        toggle.onchange = function () {
            details.querySelectorAll('input').forEach(function (box) {
                box.checked = toggle.checked;
            });
        };

        list.appendChild(item);
    });
    document.getElementById('save').style.display = 'block';
}

document.getElementById('save').onclick = function (e) {
    e.preventDefault();
    var selection = {groups: {}, overrides: {}};
    document.querySelectorAll('input[data-group]').forEach(function (toggle) {
        selection.groups[toggle.dataset.group] = toggle.checked;
    });
    document.querySelectorAll('input[data-register]').forEach(function (box) {
        selection.overrides[box.dataset.register] = box.checked;
    });
    selection.sources = {};
    document.querySelectorAll('input[data-source]:checked').forEach(function (radio) {
        selection.sources[radio.dataset.source] = Number(radio.value);
    });
    Homey.showLoadingOverlay();
    // This view is used by the repair flow only (pairing uses the device picker);
    // applying the selection to the device is all that's left.
    Homey.emit('selection_done', selection, function (err) {
        Homey.hideLoadingOverlay();
        if (err)
            Homey.alert(err.message || String(err), 'error');
        else
            Homey.done();
    });
};

// render() only runs after get_context and get_detection have both answered, so
// cover the two round-trips rather than showing an empty page under the title.
Homey.showLoadingOverlay();
Homey.emit('get_context', {}, function (err, ctx) {
    if (err) {
        Homey.hideLoadingOverlay();
        Homey.alert(err.message || String(err), 'error');
        return;
    }
    context = ctx;
    Homey.emit('get_detection', {}, function (err2, det) {
        detection = det || null;
        render();
        Homey.hideLoadingOverlay();
    });
});
