/* Optional pairing step (S-series): save the heat pump's own settings to a USB stick (menu 8.3
   Manage settings, S1155 and S1256PC installer manuals), so the owner can go back to them later
   with or without this app. Nothing is read or written here: it is the pump's backup, not ours. */

Homey.setTitle(Homey.__('pair.title'));

function next(e) {
    e.preventDefault();
    Homey.showView('ip_address');
}
document.getElementById('continue').onclick = next;
document.getElementById('skip').onclick = next;
