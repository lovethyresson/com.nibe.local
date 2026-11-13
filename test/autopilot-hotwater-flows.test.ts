import {test} from 'node:test';
import assert from 'node:assert';
import {moreHotwaterFlows, startsMoreHotwater} from '../lib/autopilot/hotwater-flows';

const on = {deviceIds: ['hw'], capabilities: ['boolean_NIBE.h697_more_hotwater', 'hotwater_increase_NIBE.h697_onetimeincrease_hotwater']};
const card = (id: string, args: any = {}, type = 'action') => ({id: `homey:device:${id}`, args, type});

test('a card turns More hot water on: the on/off, the picker and the old generic cards', () => {
    assert.ok(startsMoreHotwater(card('hw:boolean_NIBE.h697_more_hotwater.onoff', {state: 'on'}), on));
    assert.ok(!startsMoreHotwater(card('hw:boolean_NIBE.h697_more_hotwater.onoff', {state: 'off'}), on));
    assert.ok(startsMoreHotwater(card('hw:boolean_NIBE.h697_more_hotwater.onoff', {state: '[[token]]'}), on), 'a token can turn it on');
    assert.ok(startsMoreHotwater(card('hw:hotwater_increase_NIBE.h697_onetimeincrease_hotwater.enum', {mode: {id: '3'}}), on));
    assert.ok(!startsMoreHotwater(card('hw:hotwater_increase_NIBE.h697_onetimeincrease_hotwater.enum', {mode: {id: '0'}}), on));
    assert.ok(startsMoreHotwater(card('hw:enable_feature', {register: {id: 'boolean_NIBE.h697_more_hotwater'}}), on));
    assert.ok(!startsMoreHotwater(card('hw:disable_feature', {register: {id: 'boolean_NIBE.h697_more_hotwater'}}), on));
    assert.ok(!startsMoreHotwater(card('hw:enable_feature', {register: {id: 'onoff.h195_enable_hotwater'}}), on));
    assert.ok(!startsMoreHotwater(card('other:boolean_NIBE.h697_more_hotwater.onoff', {state: 'on'}), on), 'another pump');
    assert.ok(startsMoreHotwater(card('hw:f_boolean_NIBE.h697_more_hotwater.onoff', {state: 'on'}), {...on, prefix: 'f_'}));
});

test('only enabled Flows that switch it on by themselves are listed; a manual one is a button', () => {
    const more = card('hw:boolean_NIBE.h697_more_hotwater.onoff', {state: 'on'});
    const advanced = {
        cheap: {name: 'Cheap hot water', enabled: true, cards: {a: {type: 'trigger', id: 'homey:manager:cron:time'}, b: more}},
        manual: {name: 'More hot water', enabled: true, cards: {a: {type: 'start'}, b: more}},
        off: {name: 'Old hot water', enabled: false, cards: {a: {type: 'trigger', id: 'x'}, b: more}},
        lights: {name: 'Lights', enabled: true, cards: {a: {type: 'trigger', id: 'x'}, b: card('lamp:on')}},
    };
    const simple = {
        timed: {name: 'At six', enabled: true, trigger: {id: 'homey:manager:cron:time_exactly'}, actions: [more]},
        button: {name: 'Button', enabled: true, trigger: {id: 'homey:manager:flow:programmatic_trigger'}, actions: [more]},
    };
    assert.deepStrictEqual(moreHotwaterFlows(simple, advanced, on).map((f) => f.name), ['At six', 'Cheap hot water']);
    assert.deepStrictEqual(moreHotwaterFlows(undefined, undefined, on), []);
});
