// Prints the Getting started widget's payload (NibePumpDevice.settleWidget) for six cases, in
// one language, through a stub device: for rendering the real widget page in a browser.
// npx tsx dev/gs-widget-states.ts [lang] > states.json
import {readFileSync} from 'node:fs';
import Module from 'node:module';

// The app's device without the Homey runtime: 'homey' loads as an empty base class.
const loader = Module as any;
const originalLoad = loader._load;
class HomeyBase {}
loader._load = function (id: string, ...args: any[]) {
    return id === 'homey' ? {Device: HomeyBase, Driver: HomeyBase} : originalLoad.call(this, id, ...args);
};
const {NibePumpDevice} = require('../lib/device');
loader._load = originalLoad;

const lang = process.argv[2] ?? 'en';
const locale = JSON.parse(readFileSync(`.homeycompose/locales/${lang}.json`, 'utf8'));
const NOW = Date.parse('2026-11-27T10:00:00Z');
Date.now = () => NOW;
const day = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
const at = (date: string) => Date.parse(`${date}T08:00:00Z`);

function payload(c: {store: Record<string, unknown>; summary?: unknown}) {
    const device = Object.create(NibePumpDevice.prototype);
    Object.assign(device, {
        heatingMode: 'live',
        autopilot: {houseSummary: () => c.summary ?? {days: 15, needed: 7, ready: true, missing: []}},
        getStoreValue: (key: string) => c.store[key],
        getAvailable: () => true,
        hasCapability: () => false,
        autopilotAway: () => false,
        getCapabilityValue: () => 22.5,
        homey: {
            __: (key: string, tokens: Record<string, unknown> = {}) => {
                const text = key.split('.').reduce((o: any, k) => o?.[k], locale);
                return typeof text === 'string' ? text.replace(/__(\w+)__/g, (_, t) => String(tokens[t])) : key;
            },
            clock: {getTimezone: () => 'Europe/Stockholm'},
            i18n: {getLanguage: () => lang},
        },
    });
    return device.settleWidget();
}

const d = (date: string, mean: number) => ({date, mean, setpoint: 22.5});
const settled = [d('2026-11-21', 21.7), d('2026-11-22', 21.8), d('2026-11-23', 21.6), d('2026-11-24', 21.7), d('2026-11-25', 22.4), d('2026-11-26', 22.2)];
const out = {
    '1-learning': payload({store: {}, summary: {days: 4, needed: 7, ready: false, missing: ['days']}}),
    '2-settling-holding': payload({store: {autopilotSettling: {start: '2026-11-24', days: [d('2026-11-25', 21.4), d('2026-11-26', 21.6)]}}}),
    '3-settling-offset': payload({store: {autopilotSettling: {start: '2026-11-20', days: settled, liveAt: at('2026-11-26')},
        autopilotHeatCurve: {choice: 'auto', adjusted: {from: 6, to: 7, day: day('2026-11-27')}, changed: day('2026-11-27'), moved: {from: 6, to: 7}, offset: 7}}}),
    '4-curve-check': payload({store: {autopilotSettling: {start: '2026-11-20', days: settled, settled: '2026-11-26',
        liveAt: at('2026-11-26'), calibrating: {start: '2026-11-26', days: [{...d('2026-11-27', 22.4), ok: true}]}},
    autopilotHeatCurve: {choice: 'auto', adjusted: {from: 6, to: 7, day: day('2026-11-26')}, changed: day('2026-11-26'), moved: {from: 6, to: 7}, offset: 7}}}),
    '5-curve-ask': payload({store: {autopilotSettling: {start: '2026-11-20', days: settled, settled: '2026-11-26', liveAt: at('2026-11-26'), calibrating: {start: '2026-11-26', days: []}},
        autopilotHeatCurve: {choice: 'self', offset: 6, told: {day: day('2026-11-27'), to: 7}}}}),
    '6-done': payload({store: {autopilotSettling: {start: '2026-11-20', days: settled, settled: '2026-11-26', live: '2026-11-26', liveAt: at('2026-11-26')}}}),
};
console.log(JSON.stringify(out, null, 1));
