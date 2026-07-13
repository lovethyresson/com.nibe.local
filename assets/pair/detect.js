/* Shared by pair/detect.html and repair/detect.html.
 * Runs feature detection via the driver and moves on: to the device picker when
 * pairing, or to the per-device feature list when repairing.
 *
 * Same mechanism as the discovery screen: the driver emits progress events and we
 * set the bar width from them; completion comes from the start_detection response. */
/* global Homey */

Homey.setTitle(Homey.__('pair.detect.title'));

var statusEl = document.getElementById('status');
var barEl = document.getElementById('bar');
var errorEl = document.getElementById('error');
var retryEl = document.getElementById('retry');

// Ensure the fill is visible even if the stylesheet's CSS variable doesn't resolve
// in the pairing webview (the reason the bar looked empty despite updating).
barEl.style.background = '#dd1111';

// Default to the pairing device picker; get_context tells us if we're repairing.
var nextView = 'devices';

Homey.on('detection_progress', function (progress) {
    if (!progress || !progress.passes)
        return;
    barEl.style.width = Math.round((progress.pass / progress.passes) * 100) + '%';
    statusEl.textContent = Homey.__('pair.detect.status') + ' (' + progress.pass + '/' + progress.passes + ')';
});

function showError(message) {
    barEl.style.width = '0%';
    statusEl.textContent = '';
    errorEl.textContent = Homey.__('pair.detect.failed') + (message ? ' (' + message + ')' : '');
    errorEl.style.display = 'block';
    retryEl.style.display = 'inline-block';
}

function startDetection() {
    errorEl.style.display = 'none';
    retryEl.style.display = 'none';
    barEl.style.width = '3%';
    statusEl.textContent = Homey.__('pair.detect.status');
    Homey.emit('start_detection', {}, function (err) {
        if (err) {
            showError((err && err.message) || String(err));
            return;
        }
        barEl.style.width = '100%';
        Homey.showView(nextView);
    });
}

retryEl.onclick = function (e) {
    e.preventDefault();
    startDetection();
};

document.getElementById('skip').onclick = function (e) {
    e.preventDefault();
    Homey.showView(nextView);
};

Homey.emit('get_context', {}, function (err, ctx) {
    if (ctx && ctx.mode === 'repair')
        nextView = 'features';
    startDetection();
});
