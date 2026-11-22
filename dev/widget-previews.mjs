#!/usr/bin/env node
// Renders each dashboard widget's preview-light.png and preview-dark.png (1024 × 1024) from the
// widget's own page, fed with saved data, in headless Chrome. So a preview is the card as it is,
// not a drawing of it.
//
//   node dev/widget-previews.mjs <data dir>
//
// <data dir> holds one JSON per widget, named after it (autopilot.json, savings.json, …): what
// the widget's API returns, e.g. from the app's debug route
//   homey api raw -X GET --path "/api/app/com.nibe.local/widget/<id>?device=<data id>"
// A JSON's "title" is replaced by the preview's (an owner's device name has no place in the store).
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = new URL('..', import.meta.url).pathname;
const SIZE = 1024;
/** The card's width as a phone shows it, CSS px; the preview scales it to fill the square. */
const CARD = 400;
const MARGIN = 72;
const THEMES = {
    light: {bg: '#ffffff', fg: '#111111'},
    dark: {bg: '#1c1c1e', fg: '#ffffff'},
};
const WIDGETS = {
    autopilot: 'Heating',
    savings: 'Heating',
    savings_hotwater: 'Hot water',
    hotwater_use: 'Hot water',
    hotwater_tank: 'Hot water',
    energy: 'Heat pump',
    cost_check: 'Plan vs actual',
    getting_started: 'Heating · Getting started',
};

const dataDir = process.argv[2];
if (!dataDir) { console.error('usage: node dev/widget-previews.mjs <data dir>'); process.exit(1); }
const work = mkdtempSync(join(tmpdir(), 'widget-previews-'));

for (const [id, title] of Object.entries(WIDGETS)) {
    const file = join(dataDir, `${id}.json`);
    if (!existsSync(file)) { console.warn(`${id}: no ${file}, skipped`); continue; }
    let data = JSON.parse(readFileSync(file, 'utf8'));
    data = data.result ?? data;
    data.title = title;
    const page = readFileSync(join(ROOT, 'widgets', id, 'public', 'index.html'), 'utf8');
    for (const [theme, {bg, fg}] of Object.entries(THEMES)) {
        // A stand-in for the Homey widget API: the saved data, no settings, and a height setter
        // that only marks the card as drawn. Then the card is scaled to fill the square.
        const harness = `
<style>
  html, body { margin: 0; width: ${SIZE}px; height: ${SIZE}px; overflow: hidden; background: ${bg}; color: ${fg};
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif; font-size: 16px; }
  body > div:first-of-type { width: ${CARD}px; position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  /* Homey's own text class, which the dashboard defines. */
  .homey-text-small { font-size: 14px; line-height: 1.35; }
</style>
<script>
  var DATA = ${JSON.stringify(data)};
  var Homey = {
    getSettings: function () { return {}; },
    api: function () { return Promise.resolve(DATA); },
    ready: function () {},
    setHeight: function () {},
  };
  window.addEventListener('load', function () {
    onHomeyReady(Homey);
    setTimeout(function () {
      var card = document.body.querySelector('body > div');
      var w = card.offsetWidth, h = card.scrollHeight, room = ${SIZE - 2 * MARGIN};
      var k = Math.min(room / w, room / h);
      card.style.transform = 'translate(' + ((${SIZE} - w * k) / 2) + 'px,' + ((${SIZE} - h * k) / 2) + 'px) scale(' + k + ')';
    }, 300);
  });
</script>`;
        const html = page.replace('</head>', `${harness}</head>`);
        const htmlFile = join(work, `${id}-${theme}.html`);
        writeFileSync(htmlFile, html);
        const out = join(ROOT, 'widgets', id, `preview-${theme}.png`);
        execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${SIZE},${SIZE}`,
            '--force-device-scale-factor=1', '--virtual-time-budget=4000', `--screenshot=${out}`, `file://${htmlFile}`],
            {stdio: 'ignore'});
        console.log(`${id}: ${theme} → ${out}`);
    }
}
