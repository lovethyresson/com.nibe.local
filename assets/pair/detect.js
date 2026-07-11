/* Shared by pair/detect.html and repair/detect.html.
 * Runs feature detection via the driver and moves on: to the device picker when
 * pairing, or to the per-device feature list when repairing.
 *
 * The bar is animated on a timer over the expected sampling window rather than
 * driven by realtime progress events (which don't reliably reach the pair view);
 * completion comes from the start_detection response, which always fires. */
/* global Homey */

Homey.setTitle(Homey.__('pair.detect.title'));

var statusEl = document.getElementById('status');
var barEl = document.getElementById('bar');
var errorEl = document.getElementById('error');
var retryEl = document.getElementById('retry');

// Roughly how long sampling takes (5 passes ~6s apart); the bar creeps to 95% over
// this window and snaps to 100% when detection actually finishes.
var ESTIMATE_SECONDS = 32;

// Default to the pairing device picker; get_context tells us if we're repairing.
var nextView = 'devices';

function showError(message) {
    barEl.style.transition = 'none';
    barEl.style.width = '0%';
    statusEl.textContent = '';
    errorEl.textContent = Homey.__('pair.detect.failed') + (message ? ' (' + message + ')' : '');
    errorEl.style.display = 'block';
    retryEl.style.display = 'inline-block';
}

// Progress events are unreliable in the pair view, but if they do arrive, use them
// for the "(pass/passes)" status text.
Homey.on('detection_progress', function (progress) {
    if (progress && progress.passes)
        statusEl.textContent = Homey.__('pair.detect.status')
            + ' (' + progress.pass + '/' + progress.passes + ')';
});

function startDetection() {
    errorEl.style.display = 'none';
    retryEl.style.display = 'none';
    statusEl.textContent = Homey.__('pair.detect.status');

    // Restart the creep animation from 0.
    barEl.style.transition = 'none';
    barEl.style.width = '0%';
    // Force reflow so the next transition takes effect.
    void barEl.offsetWidth;
    barEl.style.transition = 'width ' + ESTIMATE_SECONDS + 's linear';
    barEl.style.width = '95%';

    Homey.emit('start_detection', {}, function (err) {
        if (err) {
            showError((err && err.message) || String(err));
            return;
        }
        barEl.style.transition = 'width 0.3s ease';
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
