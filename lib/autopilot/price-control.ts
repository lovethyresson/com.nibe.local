/** Price control: one choice per function, so Nibe's Smart price adaption (SPA) and Autopilot
 *  never both steer the same compressor. Design: docs/autopilot-plan.md §10.0 (B0). */

export type PriceFunction = 'heating' | 'hotwater';
export type PriceControl = 'off' | 'spa' | 'test' | 'autopilot';
export const PRICE_SETTING: Record<PriceFunction, string> = {heating: 'priceHeating', hotwater: 'priceHotwater'};

export function priceControl(value: unknown): PriceControl {
    return value === 'spa' || value === 'test' || value === 'autopilot' ? value : 'off';
}

/** The SPA switches a profile names: the master (843) and each function's own (844, 846). */
export interface SpaSwitches {
    master: string;
    heating: string;
    hotwater: string;
}

/** The SPA switch writes a choice needs, as capability name → on/off. SPA turns the master and
 *  that function's switch on; anything else turns that function's switch off and leaves the
 *  master alone (the other function may still use it). */
export function priceControlWrites(fn: PriceFunction, value: PriceControl, spa: SpaSwitches): [string, boolean][] {
    return value === 'spa' ? [[spa.master, true], [spa[fn], true]] : [[spa[fn], false]];
}

/** Whether SPA for this function is on: the master and the function's switch both on. */
export function spaOn(master: boolean | undefined, fn: boolean | undefined): boolean {
    return master === true && fn === true;
}
