/* Shared by pair/detect.html and repair/detect.html.
 * Runs feature detection via the driver and moves on: to the device picker when
 * pairing, or to the per-device feature list when repairing.
 *
 * Same mechanism as the discovery screen: the driver emits progress events and we
 * set the bar width from them; completion comes from the start_detection response. */
/* global Homey */

Homey.setTitle(Homey.__('pair.detect.title'));

var statusEl = document.getElementById('status');
// Unique id per view: ip_address.html's discovery bar is "discovery-bar" and both
// detect views use "detect-bar". Homey loads a session's pair views into one shared
// DOM, so a generic id="bar" here would resolve to the discovery view's (hidden) bar
// instead of this one — the progress text updated but the fill never moved.
var barEl = document.getElementById('detect-bar');
var errorEl = document.getElementById('error');
var retryEl = document.getElementById('retry');

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

// Detection runs longer than Homey's ~30s RPC timeout, so start_detection only kicks
// it off — the outcome arrives as a detection_done / detection_failed event. Waiting on
// the emit callback instead reported a spurious timeout while the probe was still running.
function startDetection() {
    errorEl.style.display = 'none';
    retryEl.style.display = 'none';
    barEl.style.width = '3%';
    statusEl.textContent = Homey.__('pair.detect.status');
    Homey.emit('start_detection', {}, function (err) {
        if (err)
            showError((err && err.message) || String(err));
    });
}

Homey.on('detection_done', function () {
    barEl.style.width = '100%';
    Homey.showView(nextView);
});

Homey.on('detection_failed', function (data) {
    showError(data && data.message);
});

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
