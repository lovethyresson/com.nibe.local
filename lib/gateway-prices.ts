/** The Gateway's price book (docs/external-io.md, step 2): Homey Energy's dynamic prices, fetched
 *  once and shared by everyone who asks: the heating collector, hot water Autopilot and the three
 *  savings devices each used to fetch the same days on their own schedule.
 *
 *  Age rules: the price type, cost formula and currency for an hour; a past day for good (it never
 *  changes); today for an hour; tomorrow for an hour once it has prices, 15 minutes while it is
 *  still empty. Two callers asking at once share one request. */

import {DayPrices, localDate, normalisePrices} from './autopilot/prices';
import {PRIORITY, gatewayFor} from './gateway';

export const INFO_MAX_AGE_MS = 60 * 60_000;
/** "No dynamic prices" is asked again sooner: an owner may just have set them up in Homey Energy. */
export const NOT_DYNAMIC_MAX_AGE_MS = 5 * 60_000;
export const DAY_MAX_AGE_MS = 60 * 60_000;
export const EMPTY_DAY_MAX_AGE_MS = 15 * 60_000;
/** Past days kept: savings looks 13 back, Plan vs actual a week. */
export const KEEP_DAYS = 16;

export interface PriceInfo {
    /** Homey Energy has dynamic prices. Without them there is nothing to shift. */
    dynamic: boolean;
    /** The owner's cost formula (Homey Energy → prices), applied to every day's spot price. */
    costExpression?: string;
    currency?: string;
}

export interface PriceBookDeps {
    /** Runs `use` with the Homey API, through the Gateway. */
    call<T>(use: (api: any) => Promise<T>): Promise<T>;
    now(): number;
    /** Today's date in the Homey's time zone, YYYY-MM-DD. */
    today(): string;
}

const EMPTY: DayPrices = {slots: [], costsApplied: false};

export class PriceBook {
    private infoAt = -Infinity;
    private infoValue?: PriceInfo;
    private infoAsk?: Promise<PriceInfo>;
    private days = new Map<string, {at: number; prices: DayPrices; expression?: string}>();
    private asks = new Map<string, Promise<DayPrices>>();

    constructor(private readonly deps: PriceBookDeps) {}

    /** Price type, cost formula and currency. Throws when Homey can't say the price type. */
    async info(): Promise<PriceInfo> {
        const maxAge = this.infoValue?.dynamic ? INFO_MAX_AGE_MS : NOT_DYNAMIC_MAX_AGE_MS;
        if (this.infoValue && this.deps.now() - this.infoAt < maxAge) return this.infoValue;
        this.infoAsk ??= this.deps.call(async (api) => {
            const dynamic = await api.energy.getElectricityPriceType() === 'dynamic';
            if (!dynamic) return {dynamic};
            const costs = await api.energy.getDynamicElectricityPriceUserCosts().catch(() => undefined);
            const currency = await api.energy.getCurrency().catch(() => undefined);
            return {dynamic, ...typeof costs?.mathExpression === 'string' ? {costExpression: costs.mathExpression} : {},
                ...typeof currency === 'string' && currency ? {currency} : {}};
        }).then((info) => {
            this.infoValue = info;
            this.infoAt = this.deps.now();
            return info;
        }).finally(() => { this.infoAsk = undefined; });
        return this.infoAsk;
    }

    /** One day's prices, with the owner's cost formula applied. Empty when Homey has none (yet), or
     *  has no dynamic prices; never throws. */
    async day(date: string): Promise<DayPrices> {
        const info = await this.info().catch(() => undefined);
        if (!info?.dynamic) return EMPTY;
        const kept = this.days.get(date);
        if (kept && kept.expression === info.costExpression && this.fresh(date, kept)) return kept.prices;
        let ask = this.asks.get(date);
        if (!ask) {
            ask = this.deps.call((api) => api.energy.fetchDynamicElectricityPrices({date}))
                .then((response: any) => {
                    const prices = normalisePrices(response, info.costExpression);
                    this.days.set(date, {at: this.deps.now(), prices, expression: info.costExpression});
                    this.prune();
                    return prices;
                })
                // A failed fetch keeps what was there, if it was priced with today's formula.
                .catch(() => (kept && kept.expression === info.costExpression ? kept.prices : EMPTY))
                .finally(() => this.asks.delete(date));
            this.asks.set(date, ask);
        }
        return ask;
    }

    private fresh(date: string, kept: {at: number; prices: DayPrices}): boolean {
        const today = this.deps.today();
        if (date < today && kept.prices.slots.length) return true;
        const age = this.deps.now() - kept.at;
        return age < (kept.prices.slots.length ? DAY_MAX_AGE_MS : EMPTY_DAY_MAX_AGE_MS);
    }

    private prune() {
        const dates = [...this.days.keys()].sort();
        for (const date of dates.slice(0, Math.max(0, dates.length - KEEP_DAYS))) this.days.delete(date);
    }
}

/** One price book per app process, through its Gateway. */
let shared: PriceBook | undefined;

export function pricesFor(homey: any): PriceBook {
    shared ??= new PriceBook({
        call: (use) => gatewayFor(homey).call(use, PRIORITY.control),
        now: () => Date.now(),
        today: () => localDate(Date.now(), homey.clock.getTimezone()),
    });
    return shared;
}
