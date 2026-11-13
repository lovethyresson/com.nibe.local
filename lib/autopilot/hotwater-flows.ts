/** Flows that switch More hot water on by themselves, which fight Autopilot hot water's plan: each
 *  starts a charge the plan did not want, and the plan then has to work around it. Setup lists
 *  them and asks the owner to turn them off (docs/autopilot-hot-water.md §4.5). Pure: the caller
 *  reads the Flows through `homey-api`.
 *
 *  A Flow the owner starts by hand (an advanced Flow with only a Start card, a simple Flow with
 *  the manual trigger) is a button, not a schedule, and is left out: pressing it is the owner
 *  asking for hot water now. */

/** One conflicting Flow, for the setup list. */
export interface FlowConflict {
    id: string;
    name: string;
    advanced: boolean;
}

/** What identifies a card that turns More hot water on. */
export interface MoreHotwaterCards {
    /** Homey ids of the pump's devices: an app card's id is `homey:device:<deviceId>:<cardId>`. */
    deviceIds: string[];
    /** Capability names that write More hot water (a register can appear twice, as an on/off
     *  and as a picker). */
    capabilities: string[];
    /** The model's Flow card id prefix (`f_` on the F-series). */
    prefix?: string;
}

const MANUAL_TRIGGER = /programmatic_trigger$/;
const off = (v: unknown) => v === 'off' || v === false || v === 0 || v === '0';

/** Whether a card turns More hot water on. A value that is a token (not known until it runs)
 *  counts: it can. */
export function startsMoreHotwater(card: {id?: string; args?: any} | undefined, on: MoreHotwaterCards): boolean {
    const match = /^homey:device:([^:]+):(.+)$/.exec(String(card?.id ?? ''));
    if (!match || !on.deviceIds.includes(match[1])) return false;
    const id = on.prefix && match[2].startsWith(on.prefix) ? match[2].slice(on.prefix.length) : match[2];
    const args = card?.args ?? {};
    for (const cap of on.capabilities) {
        if (id === `${cap}.onoff`) return !off(args.state);
        if (id === `${cap}.enum`) return !off(args.mode?.id ?? args.mode);
    }
    // The deprecated generic cards, still run for existing Flows.
    if (args.register?.id && on.capabilities.includes(args.register.id))
        return id === 'enable_feature' || (id === 'set_numeric_value' && !off(args.value));
    return false;
}

/** Enabled Flows that switch More hot water on by themselves. `flows` and `advanced` are the
 *  Homey API's `getFlows()` and `getAdvancedFlows()`. */
export function moreHotwaterFlows(flows: Record<string, any> | undefined, advanced: Record<string, any> | undefined,
                                  on: MoreHotwaterCards): FlowConflict[] {
    const out: FlowConflict[] = [];
    for (const [id, f] of Object.entries(flows ?? {})) {
        if (!f || f.enabled === false || MANUAL_TRIGGER.test(String(f.trigger?.id ?? ''))) continue;
        if ((f.actions ?? []).some((card: any) => startsMoreHotwater(card, on)))
            out.push({id, name: String(f.name ?? id), advanced: false});
    }
    for (const [id, f] of Object.entries(advanced ?? {})) {
        if (!f || f.enabled === false) continue;
        const cards = Object.values(f.cards ?? {}) as any[];
        if (!cards.some((card) => card?.type === 'trigger')) continue;
        if (cards.some((card) => card?.type === 'action' && startsMoreHotwater(card, on)))
            out.push({id, name: String(f.name ?? id), advanced: true});
    }
    return out.sort((x, y) => x.name.localeCompare(y.name));
}
