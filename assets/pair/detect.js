/* Shared by pair/detect.html and repair/detect.html.
 * Runs feature detection via the driver and moves on to the features view. */
/* global Homey */

Homey.setTitle(Homey.__('pair.detect.title'));

var statusEl = document.getElementById('status');
var barEl = document.getElementById('bar');
var errorEl = document.getElementById('error');
var retryEl = document.getElementById('retry');

Homey.on('detection_progress', function (progress) {
    var percent = Math.round((progress.pass / progress.passes) * 100);
    barEl.style.width = percent + '%';
    statusEl.textContent = Homey.__('pair.detect.status') + ' (' + progress.pass + '/' + progress.passes + ')';
});

function startDetection() {
    errorEl.style.display = 'none';
    retryEl.style.display = 'none';
    barEl.style.width = '3%';
    statusEl.textContent = Homey.__('pair.detect.status');
    Homey.emit('start_detection', {}, function (err) {
        if (err) {
            var message = (err && err.message) || (typeof err === 'string' ? err : '');
            statusEl.textContent = '';
            errorEl.textContent = Homey.__('pair.detect.failed') + (message ? ' (' + message + ')' : '');
            errorEl.style.display = 'block';
            retryEl.style.display = 'inline-block';
        } else {
            barEl.style.width = '100%';
            Homey.showView('features');
        }
    });
}

retryEl.onclick = function (e) {
    e.preventDefault();
    startDetection();
};

document.getElementById('skip').onclick = function (e) {
    e.preventDefault();
    Homey.showView('features');
};

startDetection();
