/** Homey Energy prices → 15-minute UTC slots. Pure: the collector does the fetching.
 *  Design: docs/autopilot-plan.md §5.2. */

export const SLOT_MS = 15 * 60 * 1000;
export const slotOf = (ms: number) => Math.floor(ms / SLOT_MS);

export interface PriceSlot {
    slot: number;
    spot: number;
    /** All-in price from the owner's Homey Energy formula, or spot when costsApplied is false. */
    price: number;
}
export interface DayPrices {
    slots: PriceSlot[];
    costsApplied: boolean;
}

/** The owner's cost formula, e.g. `{{([[price]]+0.041+0.36+0.208)*1.25}}`, as a function of spot.
 *  A hand-written parser over numbers, + − * /, parentheses and unary minus. Never `eval`: the
 *  string comes from another app's settings. Returns undefined for anything else. */
export function parseCostFormula(expression: unknown): ((spot: number) => number) | undefined {
    if (typeof expression !== 'string') return undefined;
    const source = expression.trim().replace(/^\{\{/, '').replace(/\}\}$/, '');
    const tokens = source.match(/\[\[price\]\]|\d+(?:\.\d+)?|[-+*/()]|\S/g) ?? [];
    let at = 0;
    type Node = (x: number) => number;
    const peek = () => tokens[at];
    const fail = (): never => { throw new Error('formula'); };
    const primary = (): Node => {
        const token = tokens[at++];
        if (token === undefined) return fail();
        if (token === '[[price]]') return (x) => x;
        if (/^\d/.test(token)) { const n = Number(token); return () => n; }
        if (token === '-') { const inner = primary(); return (x) => -inner(x); }
        if (token === '+') return primary();
        if (token === '(') {
            const inner = sum();
            if (tokens[at++] !== ')') fail();
            return inner;
        }
        return fail();
    };
    const product = (): Node => {
        let left = primary();
        while (peek() === '*' || peek() === '/') {
            const op = tokens[at++], l = left, r = primary();
            left = op === '*' ? (x) => l(x) * r(x) : (x) => l(x) / r(x);
        }
        return left;
    };
    const sum = (): Node => {
        let left = product();
        while (peek() === '+' || peek() === '-') {
            const op = tokens[at++], l = left, r = product();
            left = op === '+' ? (x) => l(x) + r(x) : (x) => l(x) - r(x);
        }
        return left;
    };
    try {
        const fn = sum();
        if (at !== tokens.length) return undefined;
        return Number.isFinite(fn(1)) ? fn : undefined;
    } catch {
        return undefined;
    }
}

/** One `fetchDynamicElectricityPrices` response → 15-minute slots. A 60-minute zone is expanded
 *  ×4. Slots are keyed by UTC, so DST days (92 or 100 slots) need no special case. The formula is
 *  trusted only when it reproduces Homey's own `highestPriceWithUserCosts`. */
export function normalisePrices(response: any, costExpression: unknown): DayPrices {
    const intervals: any[] = Array.isArray(response?.pricesPerInterval) ? response.pricesPerInterval : [];
    const raw: {start: number; end: number; spot: number}[] = [];
    for (const interval of intervals) {
        const start = Date.parse(interval?.periodStart), end = Date.parse(interval?.periodEnd);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start
            || typeof interval.value !== 'number' || !Number.isFinite(interval.value)) continue;
        raw.push({start, end, spot: interval.value});
    }
    const formula = parseCostFormula(costExpression);
    let costsApplied = false;
    if (formula && raw.length && typeof response?.highestPriceWithUserCosts === 'number') {
        const highest = formula(Math.max(...raw.map((r) => r.spot)));
        costsApplied = Math.abs(highest - response.highestPriceWithUserCosts) < 0.001;
    }
    const slots = new Map<number, PriceSlot>();
    for (const {start, end, spot} of raw) {
        const price = costsApplied ? formula!(spot) : spot;
        for (let slot = slotOf(start); slot < slotOf(end); slot++) slots.set(slot, {slot, spot, price});
    }
    return {slots: [...slots.values()].sort((a, b) => a.slot - b.slot), costsApplied};
}

/** The owner's local calendar date ('YYYY-MM-DD') at `ms`, plus `days`. */
export function localDate(ms: number, timeZone: string, days = 0): string {
    const parts = new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'})
        .format(new Date(ms));
    if (!days) return parts;
    const [y, m, d] = parts.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Local minutes since midnight at `ms`. */
export function localMinutes(ms: number, timeZone: string): number {
    const [h, m] = new Intl.DateTimeFormat('en-GB', {timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'})
        .format(new Date(ms)).split(':').map(Number);
    return h * 60 + m;
}

/** Delay to the next price fetch: every 15 min from 12:45 to 16:00 local while tomorrow is
 *  missing (that is when day-ahead prices appear), otherwise hourly. */
export function nextPriceFetchMs(now: number, timeZone: string, haveTomorrow: boolean): number {
    const minutes = localMinutes(now, timeZone);
    if (!haveTomorrow && minutes >= 12 * 60 + 45 && minutes < 16 * 60) return 15 * 60 * 1000;
    return 60 * 60 * 1000;
}
