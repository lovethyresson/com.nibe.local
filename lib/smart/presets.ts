/** Profile: a preset or Custom → the limits the planner works inside. Pure.
 *  Design: docs/smart-heating-plan.md §7.4. The preset values are starting points to tune in
 *  M2 shadow, where all presets are planned every slot. */

export type PresetId = 'comfortable' | 'save_some' | 'save_most';
export const DEFAULT_PRESET: PresetId = 'save_some';

/** What Custom shows: the same five numbers every preset sets. Shares are 0..1. */
export interface ProfileSettings {
    /** K below comfort the house may go. 0..5. */
    coldest: number;
    /** K above comfort pre-heating may go. 0..3. */
    warmest: number;
    price: number;
    weather: number;
    stored: number;
}

export const PRESETS: Record<PresetId, ProfileSettings> = {
    comfortable: {coldest: 0.5, warmest: 0.5, price: 0.3, weather: 0.6, stored: 0.3},
    save_some: {coldest: 1.5, warmest: 1.0, price: 0.6, weather: 0.8, stored: 0.6},
    save_most: {coldest: 4.0, warmest: 2.0, price: 1.0, weather: 1.0, stored: 1.0},
};

export const RANGES = {coldest: [0, 5], warmest: [0, 3]} as const;
export const MAX_COAST_H = 8;
export const MAX_BIAS_K = 20;

export interface Limits {
    /** Band around comfort, K: [comfort − lower, comfort + upper]. */
    lower: number;
    upper: number;
    /** A price shift needs p_high / p_low > 1 + margin; Infinity = no price shifting. */
    margin: number;
    /** How far forecast sun and cold fronts are trusted in feed-forward; 0 = measured indoor only. */
    forecastTrust: number;
    /** Longest coast, h. */
    maxCoastH: number;
    /** Pre-heat lead as a share of the model's τ. */
    preheatLeadTau: number;
    /** Largest outdoor bias, K either way. */
    maxBias: number;
    /** What a degree-hour below comfort is worth, as a multiple of the heat that would cure it:
     *  1 trades comfort for money at cost, above 1 pays extra to stay at comfort. */
    comfortWeight: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function limitsFor(s: ProfileSettings): Limits {
    const price = clamp(s.price, 0, 1);
    const weather = clamp(s.weather, 0, 1);
    const stored = clamp(s.stored, 0, 1);
    return {
        lower: clamp(s.coldest, ...RANGES.coldest),
        upper: clamp(s.warmest, ...RANGES.warmest),
        // 30 % → 0.60, 100 % → 0.10, linear between and beyond; 0 % turns shifting off.
        margin: price === 0 ? Infinity : Math.max(0.1, 0.6 - (price - 0.3) * (0.5 / 0.7)),
        // 50 % → ×0.5, 100 % → ×0.9.
        forecastTrust: weather === 0 ? 0 : 0.1 + 0.8 * weather,
        maxCoastH: MAX_COAST_H * stored,
        preheatLeadTau: stored,
        maxBias: MAX_BIAS_K * stored,
        // 100 % price → 1 (comfort at cost), 30 % → 1.7, 0 % → 2.
        comfortWeight: 2 - price,
    };
}

/** Which preset these settings are, so Custom moved back to a preset's values shows that preset. */
export function presetOf(s: ProfileSettings): PresetId | 'custom' {
    const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    for (const [id, p] of Object.entries(PRESETS) as [PresetId, ProfileSettings][])
        if (same(p.coldest, s.coldest) && same(p.warmest, s.warmest) && same(p.price, s.price)
            && same(p.weather, s.weather) && same(p.stored, s.stored)) return id;
    return 'custom';
}
