/** Smart mode: one choice per function, made in that function's Repair, so Nibe's Smart price
 *  adaption (SPA) and Autopilot never both steer the same compressor. Stored on the function's own
 *  device; SPA's on/off stays the pump's (Off and SPA differ only in what the pump says).
 *  Design: docs/autopilot-plan.md §10.0 (B0). */

export type SmartFunction = 'heating' | 'hotwater';
export type SmartMode = 'off' | 'spa' | 'test' | 'autopilot';
export const SMART_MODE_STORE = 'smartMode';

export function smartMode(value: unknown): SmartMode {
    return value === 'spa' || value === 'test' || value === 'autopilot' ? value : 'off';
}

/** Autopilot runs for the function: a test run or live. */
export function autopilotRuns(mode: SmartMode): boolean {
    return mode === 'test' || mode === 'autopilot';
}

/** What Repair shows: a stored Off or SPA follows the pump, which may have changed it since. */
export function shownSmartMode(stored: SmartMode, spaIsOn: boolean): SmartMode {
    return autopilotRuns(stored) ? stored : spaIsOn ? 'spa' : 'off';
}

/** The SPA switches a profile names: the master (843) and each function's own (844, 846), plus
 *  each function's SPA capabilities, which its device carries only while Autopilot does not run. */
export interface SpaSwitches {
    master: string;
    heating: string;
    hotwater: string;
    controls: Record<SmartFunction, string[]>;
}

/** The SPA switch writes a choice needs, as capability name → on/off. SPA turns the master and
 *  that function's switch on; anything else turns that function's switch off and leaves the
 *  master alone (the other function may still use it). */
export function smartModeWrites(fn: SmartFunction, value: SmartMode, spa: SpaSwitches): [string, boolean][] {
    return value === 'spa' ? [[spa.master, true], [spa[fn], true]] : [[spa[fn], false]];
}

/** Whether SPA for this function is on: the master and the function's switch both on. */
export function spaOn(master: boolean | undefined, fn: boolean | undefined): boolean {
    return master === true && fn === true;
}
