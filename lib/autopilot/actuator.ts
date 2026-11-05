/** Bias → the value fed to BT1 (5217), with the profile's limit, the ramp limit and the pump's
 *  auto-stop clamps. Pure. Design: docs/autopilot-plan.md §4.1, §4.5.
 *
 *  `bias > 0` pre-heats (the pump sees a colder day), `bias < 0` coasts. Fed = real − bias. */

/** At most this much bias change per 15 min: radiators react within the hour, and a jump gives
 *  overshoot and compressor spikes. */
export const RAMP_K_PER_SLOT = 2;
/** The app's guardrail on what 5217 is ever given. */
export const FED_RANGE = [-50, 60] as const;
/** Distance kept from the auto-stop thresholds. */
export const THRESHOLD_MARGIN = 1;

export interface PumpThresholds {
    /** 184: auto-stop heating, °C. */
    stopHeating?: number;
    /** 183: start cooling, °C. */
    startCooling?: number;
    /** 185: auto-stop additional heat (immersion), °C. */
    stopAddHeat?: number;
}

export interface ActuatorInput {
    /** Real outdoor, from outdoor.ts. */
    real: number;
    /** What the planner wants. */
    bias: number;
    /** What was applied last slot; the ramp starts from here. */
    previousBias: number;
    /** Largest bias on each side, K: pre-heat (bias > 0) and coast (bias < 0). */
    maxBias: number;
    maxCoastBias: number;
    /** Operating mode Auto (237 = 0): only then do the thresholds act, so only then clamp. */
    auto: boolean;
    thresholds: PumpThresholds;
    /** Slots since the previous decision, for the ramp. */
    slots?: number;
}

export type ClampReason = 'max_bias' | 'ramp' | 'stop_heating' | 'add_heat' | 'pass_through' | 'range';

export interface ActuatorOutput {
    fed: number;
    /** The bias actually applied: what the next call's `previousBias` should be. */
    bias: number;
    clamped: ClampReason[];
}

const round1 = (v: number) => Math.round(v * 10) / 10;

export function fedValue(input: ActuatorInput): ActuatorOutput {
    const clamped: ClampReason[] = [];
    let bias = input.bias;
    if (bias > input.maxBias || bias < -input.maxCoastBias) {
        bias = Math.max(-input.maxCoastBias, Math.min(input.maxBias, bias));
        clamped.push('max_bias');
    }
    const step = RAMP_K_PER_SLOT * Math.max(1, input.slots ?? 1);
    if (Math.abs(bias - input.previousBias) > step) {
        bias = input.previousBias + Math.sign(bias - input.previousBias) * step;
        clamped.push('ramp');
    }
    let fed = input.real - bias;
    if (input.auto) {
        const t = input.thresholds;
        // Never make the pump think it is warm enough to stop heating or start cooling. The
        // thresholds are judged on the slow average (37), which is a weighted mean of what was
        // fed, so keeping every fed value under the limit keeps 37 and its prediction under it.
        const warmLimit = Math.min(t.stopHeating ?? Infinity, t.startCooling ?? Infinity) - THRESHOLD_MARGIN;
        if (input.real >= warmLimit) {
            // Already beyond it for real (a mild day): pass the real value through, no bias.
            if (bias !== 0) clamped.push('pass_through');
            bias = 0;
            fed = input.real;
        } else if (fed > warmLimit) {
            fed = warmLimit;
            clamped.push('stop_heating');
        }
        // Never make it think it is cold enough to unlock the immersion heater.
        if (t.stopAddHeat !== undefined && input.real > t.stopAddHeat && fed < t.stopAddHeat + THRESHOLD_MARGIN) {
            fed = Math.min(input.real, t.stopAddHeat + THRESHOLD_MARGIN);
            clamped.push('add_heat');
        }
    }
    if (fed < FED_RANGE[0] || fed > FED_RANGE[1]) {
        fed = Math.min(FED_RANGE[1], Math.max(FED_RANGE[0], fed));
        clamped.push('range');
    }
    fed = round1(fed);
    return {fed, bias: round1(input.real - fed), clamped};
}

/** The curve's view of BT1: a first-order filter of what was fed (τ ≈ 49 min, §4.5). */
export const CURVE_TAU_H = 49 / 60;

export function curveInput(previous: number, fed: number, dtH = 0.25, tauH = CURVE_TAU_H): number {
    return fed + (previous - fed) * Math.exp(-dtH / tauH);
}
