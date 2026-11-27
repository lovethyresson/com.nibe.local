// Prints the Autopilot Setup widget's payload (NibePumpDevice.settleWidget) for each phase, in
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

function payload(c: {store: Record<string, unknown>; summary?: unknown; mode?: string; available?: boolean; since?: number; days?: {date: string; mean: number}[]}) {
    const device = Object.create(NibePumpDevice.prototype);
    Object.assign(device, {
        heatingMode: c.mode ?? 'live',
        autopilot: {houseSummary: () => c.summary ?? {days: 15, needed: 7, ready: true, missing: []},
            indoorDays: () => c.days ?? history},
        unavailableSince: c.since,
        getStoreValue: (key: string) => c.store[key],
        getAvailable: () => c.available ?? true,
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
// The graph's days: the house's daily indoor means over the last two weeks.
const history = [21.4, 21.6, 21.5, 21.7, 21.7, 21.8, 21.6, 21.7, 22.4, 22.2].map((mean, k) => ({date: `2026-11-${17 + k}`, mean}));
const settled = [d('2026-11-21', 21.7), d('2026-11-22', 21.8), d('2026-11-23', 21.6), d('2026-11-24', 21.7), d('2026-11-25', 22.4), d('2026-11-26', 22.2)];
const out = {
    '1-learning': payload({store: {}, summary: {days: 4, needed: 7, ready: false, missing: ['days']}}),
    '2-learning-checking': payload({store: {}, summary: {days: 9, needed: 7, ready: false, missing: ['accuracy']}}),
    '3-settling-first-day': payload({store: {autopilotSettling: {start: '2026-11-26', days: []}}}),
    '4-settling-on-track': payload({store: {autopilotSettling: {start: '2026-11-20', days: settled, liveAt: at('2026-11-26')}}}),
    '5-settling-one-in-band': payload({store: {autopilotSettling: {start: '2026-11-20', days: [...settled.slice(0, 5), d('2026-11-26', 22.4)]}}}),
    '6-settling-behind': payload({store: {autopilotSettling: {start: '2026-11-20', days: [...settled.slice(0, 5), d('2026-11-26', 21.4)]}}}),
    '7-settling-too-warm': payload({store: {autopilotSettling: {start: '2026-11-20', days: [...settled.slice(0, 5), d('2026-11-26', 23.3)]}}}),
    '7b-still-below-two-weeks': payload({store: {autopilotSettling: {start: '2026-11-10', days: [...settled.slice(0, 5), d('2026-11-26', 21.4)]}}}),
    '8-settling-restarted': payload({store: {autopilotSettling: {start: '2026-11-26', restarted: '2026-11-26', days: [{date: '2026-11-26', mean: 21.2, setpoint: 21.5}]}}}),
    '9-curve-check': payload({store: {autopilotSettling: {start: '2026-11-20', days: settled, settled: '2026-11-26',
        liveAt: at('2026-11-26'), calibrating: {start: '2026-11-26', days: [{...d('2026-11-27', 22.4), ok: true}]}},
    autopilotHeatCurve: {choice: 'auto', adjusted: {from: 6, to: 7, day: day('2026-11-26')}, changed: day('2026-11-26'), moved: {from: 6, to: 7}, offset: 7}}}),
    '10-curve-check-again': payload({store: {autopilotSettling: {start: '2026-11-20', days: settled, settled: '2026-11-25',
        liveAt: at('2026-11-26'), calibrating: {start: '2026-11-25', days: [{...d('2026-11-26', 22.4), ok: true}, {...d('2026-11-27', 21.9), ok: false}]}},
    autopilotHeatCurve: {choice: 'auto', offset: 7}}}),
    '11-curve-ask': payload({store: {autopilotSettling: {start: '2026-11-20', days: settled, settled: '2026-11-26', liveAt: at('2026-11-26'), calibrating: {start: '2026-11-26', days: []}},
        autopilotHeatCurve: {choice: 'self', offset: 6, told: {day: day('2026-11-27'), to: 7}}}}),
    '12-done': payload({store: {autopilotSettling: {start: '2026-11-20', days: settled, settled: '2026-11-26', live: '2026-11-26', liveAt: at('2026-11-26')}}}),
    '13-off': payload({store: {autopilotSettling: {start: '2026-11-20', days: settled}}, mode: 'off'}),
    '14-offline': payload({store: {autopilotSettling: {start: '2026-11-20', days: settled}}, available: false, since: NOW - 600_000}),
    '15-offline-hour': payload({store: {autopilotSettling: {start: '2026-11-20', days: settled}}, available: false, since: NOW - 7_200_000}),
};
console.log(JSON.stringify(out, null, 1));
