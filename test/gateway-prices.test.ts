import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DAY_MAX_AGE_MS, EMPTY_DAY_MAX_AGE_MS, INFO_MAX_AGE_MS, PriceBook} from '../lib/gateway-prices';

/** One hour of Homey Energy's response for `date`, spot 1.0 (Homey's shape, 60-minute zone). */
function response(date: string, spot = 1) {
    const start = Date.parse(`${date}T00:00:00Z`);
    return {highestPriceWithUserCosts: spot * 2,
        pricesPerInterval: [{periodStart: new Date(start).toISOString(), periodEnd: new Date(start + 3_600_000).toISOString(), value: spot}]};
}

function harness(opts: {type?: string; empty?: Set<string>; fail?: Set<string>} = {}) {
    let now = Date.parse('2026-11-20T10:00:00Z');
    const calls: string[] = [];
    const api = {energy: {
        getElectricityPriceType: async () => { calls.push('type'); return opts.type ?? 'dynamic'; },
        getDynamicElectricityPriceUserCosts: async () => { calls.push('costs'); return {mathExpression: '{{[[price]]*2}}'}; },
        getCurrency: async () => { calls.push('currency'); return 'SEK'; },
        fetchDynamicElectricityPrices: async ({date}: any) => {
            calls.push(`day ${date}`);
            if (opts.fail?.has(date)) throw new Error('down');
            return opts.empty?.has(date) ? {pricesPerInterval: []} : response(date);
        },
    }};
    const book = new PriceBook({call: (use) => use(api), now: () => now, today: () => '2026-11-20'});
    return {book, calls, advance: (ms: number) => { now += ms; }};
}

test('five consumers asking for today and tomorrow cause one fetch of each', async () => {
    const h = harness();
    await Promise.all(Array.from({length: 5}, () => Promise.all([h.book.day('2026-11-20'), h.book.day('2026-11-21')])));
    assert.deepEqual(h.calls.filter((c) => c.startsWith('day')).sort(), ['day 2026-11-20', 'day 2026-11-21']);
    assert.equal(h.calls.filter((c) => c === 'type').length, 1);
});

test('the owner\'s cost formula is applied, and info carries the currency', async () => {
    const h = harness();
    const day = await h.book.day('2026-11-20');
    assert.equal(day.costsApplied, true);
    assert.equal(day.slots[0].spot, 1);
    assert.equal(day.slots[0].price, 2);
    assert.equal((await h.book.info()).currency, 'SEK');
});

test('a past day is kept for good; today is fetched again after an hour', async () => {
    const h = harness();
    await h.book.day('2026-11-19');
    await h.book.day('2026-11-20');
    h.advance(DAY_MAX_AGE_MS + 1);
    await h.book.day('2026-11-19');
    await h.book.day('2026-11-20');
    assert.equal(h.calls.filter((c) => c === 'day 2026-11-19').length, 1);
    assert.equal(h.calls.filter((c) => c === 'day 2026-11-20').length, 2);
    assert.ok(INFO_MAX_AGE_MS <= DAY_MAX_AGE_MS);
});

test('tomorrow without prices is asked again after 15 minutes, not every call', async () => {
    const h = harness({empty: new Set(['2026-11-21'])});
    assert.equal((await h.book.day('2026-11-21')).slots.length, 0);
    await h.book.day('2026-11-21');
    assert.equal(h.calls.filter((c) => c === 'day 2026-11-21').length, 1);
    h.advance(EMPTY_DAY_MAX_AGE_MS + 1);
    await h.book.day('2026-11-21');
    assert.equal(h.calls.filter((c) => c === 'day 2026-11-21').length, 2);
});

test('fixed prices: no day is fetched; a failed fetch is empty and not kept', async () => {
    const fixed = harness({type: 'fixed'});
    assert.deepEqual(await fixed.book.day('2026-11-20'), {slots: [], costsApplied: false});
    assert.equal(fixed.calls.some((c) => c.startsWith('day')), false);
    const down = harness({fail: new Set(['2026-11-20'])});
    assert.equal((await down.book.day('2026-11-20')).slots.length, 0);
    await down.book.day('2026-11-20');
    assert.equal(down.calls.filter((c) => c === 'day 2026-11-20').length, 2, 'a failure is tried again next time');
});

test('through the real Gateway and homey-api client: shared, paced, formula applied', async () => {
    const {Gateway, LANE_GAP_MS} = await import('../lib/gateway');
    const V3 = require('homey-api/lib/HomeyAPI/HomeyAPIV3Local');
    const api = new V3({properties: {id: 'x', localUrl: 'http://127.0.0.1:1', token: 't'}, strategy: [], baseUrl: 'http://127.0.0.1:1'});
    let now = Date.parse('2026-11-20T10:00:00Z');
    const starts: {path: string; at: number}[] = [];
    api.call = async ({path}: any) => {
        starts.push({path, at: now});
        if (path.endsWith('/price/electricity/type')) return 'dynamic';
        if (path.includes('user-costs') || path.includes('usercosts')) return {mathExpression: '{{[[price]]*2}}'};
        if (path.includes('currency')) return 'SEK';
        const date = /date=([0-9-]+)/.exec(decodeURIComponent(path))?.[1] ?? '2026-11-20';
        return response(date);
    };
    const gateway = new Gateway({createClient: async () => api, now: () => now, sleep: async (ms) => { now += ms; }, log: () => undefined});
    const book = new PriceBook({call: (use) => gateway.call(use), now: () => now, today: () => '2026-11-20'});
    const dates = Array.from({length: 13}, (_, k) => `2026-11-${String(7 + k).padStart(2, '0')}`);
    const days = await Promise.all(dates.map((d) => book.day(d)));
    assert.ok(days.every((d) => d.slots.length === 4 && d.slots.every((x) => x.price === 2)), 'every day priced with the owner formula');
    const fetches = starts.filter((s) => /date=/.test(decodeURIComponent(s.path)));
    assert.equal(fetches.length, 13);
    const gaps = fetches.slice(1).map((s, k) => s.at - fetches[k].at);
    assert.ok(gaps.every((g) => g >= LANE_GAP_MS.energy), 'a first-run catch-up of 13 days is paced, not a burst');
});

test('a new cost formula re-prices; a failure never returns days priced with the old one', async () => {
    let expression = '{{[[price]]*2}}';
    let down = false;
    let now = 0;
    const api = {energy: {
        getElectricityPriceType: async () => 'dynamic',
        getDynamicElectricityPriceUserCosts: async () => ({mathExpression: expression}),
        getCurrency: async () => 'SEK',
        fetchDynamicElectricityPrices: async ({date}: any) => {
            if (down) throw new Error('down');
            return {...response(date), highestPriceWithUserCosts: expression.includes('*3') ? 3 : 2};
        },
    }};
    const {INFO_MAX_AGE_MS} = await import('../lib/gateway-prices');
    const book = new PriceBook({call: (use) => use(api), now: () => now, today: () => '2026-11-20'});
    assert.equal((await book.day('2026-11-19')).slots[0].price, 2);
    expression = '{{[[price]]*3}}';
    now += INFO_MAX_AGE_MS + 1;
    down = true;
    assert.equal((await book.day('2026-11-19')).slots.length, 0, 'old-formula prices are not handed out');
    down = false;
    assert.equal((await book.day('2026-11-19')).slots[0].price, 3);
});

test('"no dynamic prices" is asked again after five minutes, not an hour', async () => {
    const {NOT_DYNAMIC_MAX_AGE_MS} = await import('../lib/gateway-prices');
    let type = 'fixed';
    let now = 0;
    const api = {energy: {getElectricityPriceType: async () => type, getDynamicElectricityPriceUserCosts: async () => ({}),
        getCurrency: async () => 'SEK', fetchDynamicElectricityPrices: async ({date}: any) => response(date)}};
    const book = new PriceBook({call: (use) => use(api), now: () => now, today: () => '2026-11-20'});
    assert.equal((await book.info()).dynamic, false);
    type = 'dynamic';
    now += NOT_DYNAMIC_MAX_AGE_MS + 1;
    assert.equal((await book.info()).dynamic, true);
});
