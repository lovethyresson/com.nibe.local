/** Intl formatters, made once per locale and options and kept.
 *
 *  Each `new Intl.DateTimeFormat`/`NumberFormat` (and each `toLocale…String` with options, which
 *  makes one inside) holds ICU memory outside the JavaScript heap. The heap stays small, so the
 *  garbage collector rarely runs and that memory piles up: 20 000 fresh date formatters took a
 *  process from 53 to 650 MB while its heap stayed at 10 MB (2026-11-21). On the Homey Pro (2026)
 *  the savings and overview widgets, which turn every hour of every day into a local date, pushed
 *  the app past its memory limit within minutes, and Homey stopped it. A kept formatter costs
 *  nothing more per call. The keys are a handful (the home's zone, the owner's language), so the
 *  cache stays small; it is still bounded. */

const MAX_KEPT = 200;
const dates = new Map<string, Intl.DateTimeFormat>();
const numbers = new Map<string, Intl.NumberFormat>();

function kept<F>(map: Map<string, F>, key: string, make: () => F): F {
    let f = map.get(key);
    if (!f) {
        if (map.size >= MAX_KEPT) map.clear();
        f = make();
        map.set(key, f);
    }
    return f;
}

export function dateFormat(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
    return kept(dates, JSON.stringify([locale ?? '', options]), () => new Intl.DateTimeFormat(locale, options));
}

export function numberFormat(locale: string | undefined, options: Intl.NumberFormatOptions): Intl.NumberFormat {
    return kept(numbers, JSON.stringify([locale ?? '', options]), () => new Intl.NumberFormat(locale, options));
}

/** As `Date.prototype.toLocaleDateString(locale, options)`: year, month and day when the options
 *  name no date part. */
export function localeDate(ms: number, locale: string | undefined, options: Intl.DateTimeFormatOptions): string {
    const named = ['weekday', 'era', 'year', 'month', 'day', 'dateStyle'].some((k) => k in options);
    return dateFormat(locale, named ? options : {...options, year: 'numeric', month: 'numeric', day: 'numeric'}).format(new Date(ms));
}

/** As `Date.prototype.toLocaleTimeString(locale, options)`: hour, minute and second when the
 *  options name no time part. */
export function localeTime(ms: number, locale: string | undefined, options: Intl.DateTimeFormatOptions): string {
    const named = ['dayPeriod', 'hour', 'minute', 'second', 'fractionalSecondDigits', 'timeStyle'].some((k) => k in options);
    return dateFormat(locale, named ? options : {...options, hour: 'numeric', minute: 'numeric', second: 'numeric'}).format(new Date(ms));
}
