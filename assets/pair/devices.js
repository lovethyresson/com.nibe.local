/* Pairing device picker. Lists the pump's main + function devices, badges the ones
 * detection found live data for (pre-checking them), and creates the checked ones
 * via Homey.createDevice(). The user can add any of them. */
/* global Homey */

Homey.setTitle(Homey.__('pair.devices.title'));

var candidates = [];

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
        label.appendChild(toggle);
        label.appendChild(document.createTextNode(' ' + candidate.name));
        row.appendChild(label);

        var badge = document.createElement('span');
        badge.className = 'badge ' + (candidate.detected ? 'badge-detected' : 'badge-nodata');
        badge.textContent = Homey.__(candidate.detected ? 'pair.devices.detected' : 'pair.devices.notdetected');
        row.appendChild(badge);

        item.appendChild(row);

        if (candidate.description) {
            var desc = document.createElement('div');
            desc.className = 'register-desc';
            desc.textContent = candidate.description;
            item.appendChild(desc);
        }

        list.appendChild(item);
    });
    document.getElementById('add').style.display = 'block';
}

// Homey.createDevice one at a time, then finish the pairing session.
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
            chosen.push(candidates[box.dataset.index].device);
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
