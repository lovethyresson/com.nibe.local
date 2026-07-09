/* Shared by pair/features.html and repair/features.html.
 * Renders the feature-group checklist (with per-capability overrides) and
 * sends the final selection to the driver. In pair mode the driver answers
 * with a device template to create; in repair mode it applies the selection
 * to the existing device. */
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

function registerChecked(group, register, checked) {
    var overrides = context.selection && context.selection.overrides;
    if (overrides && typeof overrides[register.name] === 'boolean')
        return overrides[register.name];
    return checked;
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
            regLabel.appendChild(document.createTextNode(' ' + register.title));
            details.appendChild(regLabel);
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
    Homey.showLoadingOverlay();
    Homey.emit('selection_done', selection, function (err, result) {
        Homey.hideLoadingOverlay();
        if (err) {
            Homey.alert(err.message || String(err), 'error');
        } else if (context.mode === 'repair') {
            Homey.done();
        } else {
            Homey.createDevice(result)
                .then(function () {
                    Homey.done();
                })
                .catch(function (error) {
                    Homey.alert(error.message || String(error), 'error');
                });
        }
    });
};

Homey.emit('get_context', {}, function (err, ctx) {
    if (err) {
        Homey.alert(err.message || String(err), 'error');
        return;
    }
    context = ctx;
    Homey.emit('get_detection', {}, function (err2, det) {
        detection = det || null;
        render();
    });
});
