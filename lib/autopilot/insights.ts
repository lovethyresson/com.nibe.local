/** Model → the numbers the owner will see as "House insights" (§6.5). Pure, and numbers only:
 *  the six-language labels are built from these when the insights reach the UI. */
import {curveLine} from './curve';
import {copLine} from './cop';
import {HouseParams, envelopeTau, stepHouse} from './model';
import {HouseFit, Readiness} from './house';

export interface HouseInsights {
    /** W per °C. */
    heatLoss: number;
    /** °C lost in 6 h at 0 °C outside once heating that held 21 °C stops; internal gains stay. */
    coolingIn6h: number;
    /** Hours to drop 1 °C under the same conditions; what sizes coasting (§6.6). */
    hoursPerDegree: number;
    /** kWh per °C, air and mass together. */
    stored: number;
    /** kW through each wall's windows at 500 W/m² on it, a sunny winter hour facing the sun. */
    sunAt500: {east: number; south: number; west: number};
    /** The wall with more than half the glass, when one has. */
    sunMostly?: 'east' | 'south' | 'west';
    /** Slow = behaves like a heavy floor: most heat goes into the mass first. */
    speed: 'fast' | 'slow';
    tau: number;
    /** 6 h prediction error, K. */
    accuracy: number;
    validDays: number;
}

/** §6.5: implausible values show "Still learning" instead of a number. */
export const PLAUSIBLE = {heatLoss: [30, 1000], tau: [5, 400]} as const;
const SLOW_F = 0.6;

/** Indoor every slot after heating stops, starting from the steady state that held `from`:
 *  heat P = H·(from − outdoor) − gains, and the mass sits f·P·Rim above the air. */
export function coolDown(p: HouseParams, hours: number, from = 21, outdoor = 0): number[] {
    const P = Math.max(0, p.heatLoss * (from - outdoor) - p.gains);
    let [ti, tm] = [from, from + p.f * P * p.rim];
    const out = [ti];
    for (let k = 0; k < hours * 4; k++) {
        [ti, tm] = stepHouse(p, ti, tm, {te: outdoor, q: 0, sun: 0});
        out.push(ti);
    }
    return out;
}

const MOSTLY = 0.5;

function mostly(walls: {east: number; south: number; west: number}): HouseInsights['sunMostly'] {
    const total = walls.east + walls.south + walls.west;
    const [wall, area] = (Object.entries(walls) as [keyof typeof walls, number][]).sort((a, b) => b[1] - a[1])[0];
    return total > 0 && area / total > MOSTLY ? wall : undefined;
}

/** Undefined while the model has no plausible reading: the label says "Still learning". */
export function houseInsights(fit: HouseFit): HouseInsights | undefined {
    const p = fit.params;
    if (!p) return undefined;
    const heatLoss = p.heatLoss * 1000;
    const tau = envelopeTau(p);
    if (heatLoss < PLAUSIBLE.heatLoss[0] || heatLoss > PLAUSIBLE.heatLoss[1]
        || tau < PLAUSIBLE.tau[0] || tau > PLAUSIBLE.tau[1]) return undefined;
    const curve = coolDown(p, 24);
    const firstDegree = curve.findIndex((t) => t <= curve[0] - 1);
    return {
        heatLoss,
        coolingIn6h: curve[0] - curve[24],
        hoursPerDegree: firstDegree < 0 ? 24 : firstDegree / 4,
        stored: p.ci + p.cm,
        sunAt500: {east: p.sunE * 500, south: p.sun * 500, west: p.sunW * 500},
        sunMostly: mostly({east: p.sunE, south: p.sun, west: p.sunW}),
        speed: p.f > SLOW_F ? 'slow' : 'fast',
        tau,
        accuracy: fit.rmse,
        validDays: fit.validDays,
    };
}

/** One line for the app log; the owner-facing labels come later. */
export function insightsLine(fit: HouseFit, insights: HouseInsights | undefined, ready: Readiness): string {
    const head = `Autopilot model: ${fit.usable}/${fit.slots} usable slots, ${fit.validDays} valid days, `
        + `6 h error ${Number.isFinite(fit.rmse) ? fit.rmse.toFixed(2) : '-'} K, `
        + (ready.ready ? 'ready' : `learning (${ready.missing.join(', ')})`)
        + (fit.lever !== undefined ? `, lever ${Math.round(fit.lever * 1000)} W/K` : '')
        + `, ${curveLine(fit.curve)}, ${copLine(fit.cop)}`;
    if (!insights) return `${head}; still learning`;
    return `${head}; heat loss ${Math.round(insights.heatLoss)} W/°C, τ ${Math.round(insights.tau)} h, `
        + `stored ${insights.stored.toFixed(1)} kWh/°C, −${insights.coolingIn6h.toFixed(1)} °C in 6 h at 0 °C off, `
        + `sun E/S/W ${[insights.sunAt500.east, insights.sunAt500.south, insights.sunAt500.west].map((v) => v.toFixed(1)).join('/')} kW`
        + `${insights.sunMostly ? ` (mostly ${insights.sunMostly})` : ''}, ${insights.speed}`;
}
