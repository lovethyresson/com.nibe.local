/** What the Heating device shows while Autopilot heating is on: a status and a one-line reason
 *  in the owner's words. Pure, so every case is a test. Design: docs/autopilot-plan.md §10.0 (B2). */
import {FeedSnapshot} from './live';
import {SLOT_MS} from './prices';

export type HeatingStatus = 'learning' | 'holding' | 'preheating' | 'easing_off' | 'paused' | 'off';
export const HEATING_STATUSES: HeatingStatus[] = ['learning', 'holding', 'preheating', 'easing_off', 'paused', 'off'];

/** A bias smaller than this is holding: the ramp and rounding leave a few tenths behind. */
export const SHIFT_K = 0.25;

export interface Learning {
    days: number;
    needed: number;
    /** The model has met the readiness test, so a plan that cannot be made waits on the
     *  forecast, not on learning: after a restart, or while weather or prices are missing. */
    ready: boolean;
    /** What the readiness test still misses (house.ts `readiness`). */
    missing: ('accuracy' | 'days' | 'stability')[];
}

/** Learning in one line, naming the first test still open: days of data, then predictions
 *  close enough, then the same result three days running. */
export function learningText(learning: Learning, t: Translate, prefix = 'learning'): string {
    if (learning.missing.includes('days')) return t(`${prefix}_day`, {day: Math.min(learning.days, learning.needed), of: learning.needed});
    return t(learning.missing.includes('accuracy') ? `${prefix}_accuracy` : `${prefix}_steady`);
}

export type Translate = (key: string, tokens?: Record<string, string | number>) => string;

/** The run of the highest prices in the horizon: slots within 10 % of the spread from the top,
 *  around the most expensive one. Undefined when the prices are flat. */
export function pricePeak(prices: number[], within?: [number, number]): {from: number; to: number} | undefined {
    return priceRun(prices, 1, within);
}

/** The run of the lowest prices, the same way: slots within 10 % of the spread from the bottom,
 *  around the cheapest one. */
export function priceTrough(prices: number[]): {from: number; to: number} | undefined {
    return priceRun(prices, -1);
}

/** `within` [from, to) picks the top inside that window; the run and its 10 % still come from the
 *  whole horizon, so a window whose top is well below the horizon's is named no peak. */
function priceRun(raw: number[], sign: 1 | -1, within: [number, number] = [0, raw.length]):
    {from: number; to: number} | undefined {
    const prices = raw.map((p) => sign * p);
    const ok = prices.filter(Number.isFinite);
    if (ok.length === 0) return undefined;
    const max = Math.max(...ok);
    const min = Math.min(...ok);
    if (max - min < 1e-9) return undefined;
    const floor = max - 0.1 * (max - min);
    let top = -1;
    for (let k = Math.max(0, within[0]); k < Math.min(prices.length, within[1]); k++)
        if (Number.isFinite(prices[k]) && (top < 0 || prices[k] > prices[top])) top = k;
    if (top < 0 || prices[top] < floor) return undefined;
    let from = top;
    let to = top;
    while (from > 0 && prices[from - 1] >= floor) from--;
    while (to < prices.length - 1 && prices[to + 1] >= floor) to++;
    return {from, to: to + 1};
}

/** The sunny run in the forecast between `from` and `to`, slots from the plan's start. */
function sunRun(forecast: {sun: number}[], from: number, to: number): {from: number; to: number} | undefined {
    const k = forecast.findIndex((f, i) => i >= from && i < to && f.sun >= 150);
    if (k < 0) return undefined;
    let end = k;
    while (end < forecast.length && forecast[end].sun >= 150) end++;
    return {from: k, to: end};
}

/** Where the plan's current sign ends: slots from the plan's start. */
function runEnd(biases: number[], from: number, sign: number): number {
    let k = from;
    while (k < biases.length && Math.sign(Math.abs(biases[k]) < SHIFT_K ? 0 : biases[k]) === sign) k++;
    return k;
}

/** The easing-off run that follows a pre-heat ending at `end`: from its first eased slot to its
 *  last, or the rest of the plan when none follows. */
function afterRun(biases: number[], end: number): [number, number] {
    let from = end;
    while (from < biases.length && Math.abs(biases[from]) < SHIFT_K) from++;
    if (from >= biases.length || biases[from] > 0) return [end, biases.length || Infinity];
    return [from, runEnd(biases, from, -1)];
}

/** `on` formats a time that may be days away (Away's return), with its day when not today. */
export function heatingStatus(s: FeedSnapshot, now: number, t: Translate, time: (ms: number) => string,
    learning?: Learning, on: (ms: number) => string = time): {status: HeatingStatus; reason: string} {
    const test = s.mode === 'test';
    const say = (text: string) => (test ? t('test', {text}) : text);
    if (s.mode === 'off' && s.stopped !== 'feed_failed') return {status: 'off', reason: ''};
    // Learning: no plan, or the trim alone while the model learns (live.ts `learn`).
    if (s.stopped === 'no_model' || (s.learning && !s.stopped)) {
        // Not read yet (just after a restart): nothing is known about learning.
        if (!learning) return {status: 'holding', reason: say(t('starting'))};
        if (learning.ready) return {status: 'holding', reason: say(t('waiting'))};
        return {status: 'learning', reason: say(learningText(learning, t))};
    }
    // The minutes after a start, before the first outdoor reading: starting, not a pause.
    if (s.startingUp) return {status: 'holding', reason: say(t('starting'))};
    if (s.stopped) return {status: 'paused', reason: say(t(`paused.${s.stopped}`))};
    if (s.neutral) return {status: 'holding', reason: say(t('range_off'))};
    // Getting started (settling.ts): the level is held, nothing shifts for prices until the house
    // is within the comfort range.
    if (s.planReason === 'getting_started') return {status: 'holding', reason: say(t('getting_started'))};
    const biases = s.biases ?? [];
    const slot0 = s.slot ?? Math.floor(now / SLOT_MS);
    // Where in the plan "now" is: the plan was made at its slot's start.
    const at = Math.max(0, Math.min(biases.length, Math.floor(now / SLOT_MS) - slot0));
    const prices = (s.forecast ?? []).map((f) => f.price).slice(at);
    const clock = (k: number) => time((slot0 + k) * SLOT_MS);
    // The plan's own shift, never the setpoint trim inside the bias: a house held up to its
    // setpoint is not pre-heating for a price.
    const shift = at < biases.length ? biases[at] : s.bias - (s.trim ?? 0);
    const sign = Math.abs(shift) < SHIFT_K ? 0 : Math.sign(shift);
    if (sign !== 0) {
        const end = runEnd(biases, at, sign);
        // The peak this run is for: inside an easing-off run, or the easing-off run after a
        // pre-heat.
        const within: [number, number] = sign < 0 ? [at, end] : afterRun(biases, end);
        const peak = pricePeak(prices, [within[0] - at, within[1] - at]);
        const peakText = peak ? t('peak', {from: clock(at + peak.from), to: clock(at + peak.to)}) : '';
        const until = clock(end);
        const key = sign < 0 ? 'easing_off' : 'preheating';
        // Easing off with no price peak to name: the sun, when the plan counts it.
        const sunny = sign < 0 && !peakText && s.sunTrusted ? sunRun(s.forecast ?? [], at, end + 16) : undefined;
        // Pre-heating for the end of Away says so: the price peak is not why.
        const back = sign > 0 && s.back !== undefined ? t('back', {at: on(s.back)}) : '';
        const why = back || peakText || (sunny ? t('sun', {from: clock(sunny.from), to: clock(sunny.to)}) : '');
        // The status already says pre-heating or easing off, so the reason starts at "until".
        const tail = !why ? '' : sign > 0 ? `, ${t('before', {why})}` : `: ${why}`;
        return {status: sign < 0 ? 'easing_off' : 'preheating', reason: say(t(key, {until}) + tail)};
    }
    const next = biases.findIndex((b, k) => k > at && Math.abs(b) >= SHIFT_K);
    if (next < 0) return {status: 'holding', reason: say(t(s.planReason === 'spread_below_margin' ? 'holding_even' : 'holding'))};
    return {status: 'holding', reason: say(t(biases[next] < 0 ? 'next_easing_off' : 'next_preheating', {at: clock(next)}))};
}
