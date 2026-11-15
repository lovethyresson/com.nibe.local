/** Flow triggers from Autopilot heating's plan: an expensive or cheap period starting in N minutes,
 *  and pre-heating or easing off starting. Pure, so when each fires is a test.
 *  Design: docs/autopilot-plan.md §19.1, §10.3.
 *
 *  The periods are the ones the Heating status names (`pricePeak` in heating-status.ts), read from
 *  the same plan and forecast, so a card and the status never disagree about when prices peak. */
import {SLOT_MS} from './prices';
import {HeatingStatus, pricePeak, priceTrough} from './heating-status';

export type PeriodKind = 'expensive' | 'cheap';

export interface PricePeriod {
    kind: PeriodKind;
    /** Start and end, ms. */
    start: number;
    end: number;
}

/** The expensive and cheap period from now to the end of the plan's forecast. `slot` is the slot
 *  the forecast starts at; prices before `now`'s slot are left out, as the status leaves them. */
export function pricePeriods(prices: number[], slot: number, now: number): PricePeriod[] {
    const at = Math.max(0, Math.min(prices.length, Math.floor(now / SLOT_MS) - slot));
    const ahead = prices.slice(at);
    const out: PricePeriod[] = [];
    const add = (kind: PeriodKind, run?: {from: number; to: number}) => {
        if (run) out.push({kind, start: (slot + at + run.from) * SLOT_MS, end: (slot + at + run.to) * SLOT_MS});
    };
    add('expensive', pricePeak(ahead));
    add('cheap', priceTrough(ahead));
    return out;
}

/** One trigger call: the period, and the window of time this check covers. A Flow whose lead puts
 *  its moment (start − minutes) inside the window fires (`periodDue`). */
export interface PeriodTrigger extends PricePeriod {
    /** The previous check, or undefined for a period that appeared since it (new prices): a Flow
     *  whose moment already passed then fires late, once, rather than never. */
    from?: number;
    now: number;
    /** The start the period had when first seen, which every Flow's moment counts from: an edge
     *  that moves later after a Flow fired must not fire it again. */
    anchor: number;
}

/** Whether a Flow set to `minutes` ahead fires on this trigger: its moment fell in the window, and
 *  the period has not started yet. */
export function periodDue(trigger: PeriodTrigger, minutes: number): boolean {
    if (!Number.isFinite(minutes) || minutes < 0 || trigger.now >= trigger.start) return false;
    const moment = trigger.anchor - minutes * 60_000;
    return moment <= trigger.now && (trigger.from === undefined || moment > trigger.from);
}

/** Keeps which periods each check has seen, so each period fires each Flow once. A period counts
 *  as the same one while it overlaps or touches one seen before: the peak's edges move a slot as
 *  the horizon rolls or prices arrive, and a one-slot spike that moves a slot no longer overlaps
 *  its old self. That must not fire it again. */
export class PeriodWatch {
    private last?: number;
    private seen: (PricePeriod & {anchor: number})[] = [];

    /** The trigger calls for this check. The first check after a start only learns what is there:
     *  a restart must not fire a period again. */
    check(periods: PricePeriod[], now: number): PeriodTrigger[] {
        this.seen = this.seen.filter((p) => p.end > now);
        const out: PeriodTrigger[] = [];
        for (const p of periods) {
            if (p.start <= now) continue;
            const known = this.seen.find((s) => s.kind === p.kind && s.start <= p.end && p.start <= s.end);
            if (known) {
                known.start = p.start;
                known.end = p.end;
            } else {
                this.seen.push({...p, anchor: p.start});
            }
            if (this.last === undefined) continue;
            out.push({...p, from: known ? this.last : undefined, now, anchor: known?.anchor ?? p.start});
        }
        this.last = now;
        return out;
    }

    /** The plan stopped (Autopilot off, paused): the next check only learns again, so Flows whose
     *  moment fell in the gap don't all fire at once on resuming. */
    pause() {
        this.last = undefined;
    }
}

/** The trigger a status change starts, if any: entering pre-heating or easing off from anything
 *  else. Leaving and re-entering fires again; staying does not. */
export function startedTrigger(before: HeatingStatus | undefined, status: HeatingStatus): 'preheating' | 'easing_off' | undefined {
    if (before === undefined || before === status) return undefined;
    return status === 'preheating' || status === 'easing_off' ? status : undefined;
}
