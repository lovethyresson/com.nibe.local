/* First pairing step: ask for a pump software update before anything is read. Older firmware
   lacks registers the app relies on, and one S1255 booked ~7x too much delivered energy until it
   was updated (docs/FAQ.md). Detection on old firmware would also bake that absence into the
   device's selection, so this comes before discovery, not after.

   The S-series steps are Nibe's documented ones (S1155 installer manual: product overview
   "Update" when online, or a USB stick and menu 8.1). F-series menus differ per model, so that
   driver gets a pointer to the manual instead of steps that would be wrong for some pumps. */

Homey.setTitle(Homey.__('pair.title'));

Homey.emit('get_context', {}, function (err, ctx) {
    var fSeries = !err && ctx && ctx.driverId === 'nibe_f';
    document.getElementById('options-s').hidden = fSeries;
    document.getElementById('options-f').hidden = !fSeries;
});

document.getElementById('continue').onclick = function (e) {
    e.preventDefault();
    Homey.showView('ip_address');
};
