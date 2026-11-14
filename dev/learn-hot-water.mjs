// Maintainer tool (not shipped — see .homeyignore). Runs the hot water learner on a real Hot water
// device's Insights, read through the homey CLI, and prints what it learned. Reads only.
//
//   node --import tsx dev/learn-hot-water.mjs <hot water device id> [--tz Europe/Stockholm] [--save dir]
//
// Needs `homey login` and a selected Homey. The Homey rate-limits Insights, so this paces itself.

import {execFileSync} from 'child_process';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';
import {chargeRate, learn, localClock, KWH_PER_LITRE} from '../lib/autopilot/hotwater-learner.ts';
import {pointsFromInsights, RESOLUTIONS} from '../lib/autopilot/hotwater-insights.ts';

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const device = argv.find((a) => !a.startsWith('--') && !argv[argv.indexOf(a) - 1]?.startsWith('--'));
if (!device) { console.error('usage: node --import tsx dev/learn-hot-water.mjs <device id>'); process.exit(1); }
const tz = flag('tz', 'Europe/Stockholm');
const save = flag('save');

const caps = {litres: 'measure_volume_NIBE.hotwater_estimate', produced: 'meter_kwh_NIBE.i1575_hotwater_produced',
    used: 'meter_power.total', top: 'measure_temperature.i8_warmwater_top'};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const logs = {};
for (const [field, cap] of Object.entries(caps)) {
    logs[field] = [];
    for (const resolution of RESOLUTIONS) {
        const path = `/api/manager/insights/log/homey:device:${device}/homey:device:${device}:${cap}/entry?resolution=${resolution}`;
        let log = {};
        for (let attempt = 0; attempt < 4; attempt++) {
            try { log = JSON.parse(execFileSync('homey', ['api', 'raw', '-X', 'GET', '--path', path], {encoding: 'utf8'})); break; }
            catch { sleep(5000); }
        }
        logs[field].push(log);
        if (save) { mkdirSync(save, {recursive: true}); writeFileSync(join(save, `${field}.${resolution}.json`), JSON.stringify(log)); }
        sleep(3000);
    }
}

const points = pointsFromInsights(logs);
const clock = localClock(tz);
const model = learn(points, clock, Date.now());
const r = (v, d = 1) => Number.isFinite(v) ? v.toFixed(d) : '–';
console.log(`${points.length} readings, ${model.days} full days, away: ${model.away.join(', ') || 'none'}`);
console.log(`standing loss: ${r(model.loss.base, 3)} + ${r(model.loss.perKwh, 4)}/kWh stored kWh/h (${model.loss.samples} quiet hours);`
    + ` full tank (${r(290 * KWH_PER_LITRE)} kWh): ${r(model.loss.base + model.loss.perKwh * 290 * KWH_PER_LITRE, 3)} kWh/h`);
if (model.charge) console.log(`charge: tank gains ${[1, 3, 5, 7, 9, 10].map((k) => `${r(chargeRate(model.charge, k), 1)}@${k}`).join(' ')}`
    + ` kWh/h (at kWh stored), ${r(model.charge.kw, 2)} kW, tank COP ${r(model.charge.cop, 2)};`
    + ` heat counter ${r(model.charge.producedPerHour, 2)} kWh/h (${model.charge.samples} hours)`);
for (const [type, p] of Object.entries(model.profiles)) {
    console.log(`${type}: ${r(p.days)} weighted days, ${r(p.daily)} kWh/day (p80 ${r(p.dailyP80)})`);
    console.log('  hour ' + p.hours.map((_, h) => String(h).padStart(4)).join(''));
    console.log('  mean ' + p.hours.map((v) => r(v).padStart(4)).join(''));
    console.log('  p80  ' + p.p80.map((v) => r(v).padStart(4)).join(''));
}
