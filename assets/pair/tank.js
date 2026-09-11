/* The hot water tank picker, shared by the repair features view and the pairing device picker.
 *
 * The tank size is REQUIRED for the estimate and cannot be derived: working it out from delivered
 * energy was tested against a real pump and measured 436 L for a 176 L tank, because hot water
 * used during a charge only makes the charge longer and that heat is indistinguishable from tank
 * volume. So the first option declines the feature rather than guessing, which is also what keeps
 * this screen unable to fail.
 *
 * Returns the inner block only; the caller supplies the surrounding card, because the two views
 * nest it differently (repair gives it a card of its own, pairing puts it inside the device's).
 */

/* eslint-disable no-unused-vars */

function tankBlock(config, current, idPrefix) {
    var chosen = (current && current.tankId) || 'none';

    var wrap = document.createElement('div');
    wrap.className = 'tank-block';

    var head = document.createElement('div');
    head.className = 'tank-head';
    head.textContent = Homey.__('pair.tank.title');
    wrap.appendChild(head);

    var select = document.createElement('select');
    select.className = 'tank-select';
    select.id = idPrefix + '-tank';

    /* First and default: no tank, no estimate. The app cannot work the volume out for itself —
       that was tried and measured 436 L for a 176 L tank — so declining is a real answer rather
       than a fallback, and it keeps this screen unable to fail. */
    var none = document.createElement('option');
    none.value = 'none';
    none.textContent = Homey.__('pair.tank.auto');
    select.appendChild(none);

    config.tanks.forEach(function (tank) {
        var option = document.createElement('option');
        option.value = tank.id;
        option.textContent = tank.name + ' \u00b7 ' + tank.litres + ' l';
        select.appendChild(option);
    });

    var other = document.createElement('option');
    other.value = 'custom';
    other.textContent = Homey.__('pair.tank.custom');
    select.appendChild(other);

    select.value = chosen;
    wrap.appendChild(select);

    /* Only shown for "Other". A labelled row rather than a bare box: a placeholder disappears the
       moment you type, leaving a naked number with no unit. Pre-filled from a stored figure so
       reopening Repair does not silently blank a number already entered. */
    var customRow = document.createElement('div');
    customRow.className = 'tank-row';

    var customLabel = document.createElement('span');
    customLabel.className = 'tank-row-label';
    customLabel.textContent = Homey.__('pair.tank.litres');
    customRow.appendChild(customLabel);

    var customField = document.createElement('span');
    customField.className = 'tank-row-field';
    var custom = document.createElement('input');
    custom.type = 'number';
    custom.className = 'tank-field tank-litres';
    custom.id = idPrefix + '-litres';
    custom.min = config.minLitres;
    custom.max = config.maxLitres;
    if (chosen === 'custom' && current && current.litres)
        custom.value = current.litres;
    customField.appendChild(custom);
    var customUnit = document.createElement('span');
    customUnit.className = 'tank-unit';
    customUnit.textContent = 'l';
    customField.appendChild(customUnit);
    customRow.appendChild(customField);
    wrap.appendChild(customRow);

    /* Description under the control, matching how an expanded feature group reads: label, then a
       quiet line explaining it. It used to sit above in body-sized text, which made this block
       twice the weight of everything around it. */
    var hint = document.createElement('p');
    hint.className = 'register-desc';
    hint.textContent = Homey.__('pair.tank.hint');
    wrap.appendChild(hint);

    var sync = function () {
        custom.required = select.value === 'custom';
        custom.disabled = select.value !== 'custom';
        customRow.style.display = select.value === 'custom' ? 'flex' : 'none';
    };
    select.onchange = sync;
    sync();
    return wrap;
}

/* Read the block back. Always returns something valid — the driver re-validates against its own
   catalogue anyway, since a pairing view is untrusted input. */
function tankValue(idPrefix) {
    var select = document.getElementById(idPrefix + '-tank');
    if (!select)
        return null;
    var litres = Number(document.getElementById(idPrefix + '-litres').value);
    /* No inletC: the cold-water inlet is observed from the tank's own lower sensor rather than
       asked for. The driver leaves any previously stored override alone. */
    return {
        tankId: select.value,
        litres: select.value === 'custom' && litres ? litres : null
    };
}
