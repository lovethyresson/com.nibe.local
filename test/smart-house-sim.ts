/** A simulated 2R2C house heated by a weather-compensated pump, for the model tests. It steps in
 *  1-minute Euler substeps, not the model's exact discretisation, and records slot means the way
 *  the history aggregator does, so a fit is not the model recognising itself. */
import type {HouseParams, ModelSlot} from '../lib/smart/model';

export function rng(seed: number) {
    let s = seed >>> 0;
    const next = () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const gauss = () => Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next());
    return {next, gauss};
}

export interface SimOptions {
    days: number;
    seed?: number;
    /** Indoor sensor noise per slot mean, K. */
    noise?: number;
    /** Multiply the pump's heat in random 2–6 h blocks (§6.3 excitation). 0 = none. */
    excitation?: number;
    /** Hot-water runs per day, each one slot with no space heat. */
    hotWaterPerDay?: number;
    /** Make the pump a 1R1C-shaped house: no mass node. */
    singleNode?: boolean;
}

export function simulateHouse(house: HouseParams, o: SimOptions): ModelSlot[] {
    const r = rng(o.seed ?? 1);
    const noise = o.noise ?? 0.03;
    const slots: ModelSlot[] = [];
    let ti = 21;
    let tm = 21;
    let block = 1;
    let blockLeft = 0;
    let drift = 0;
    const perSlot = 15;
    const total = o.days * 96;
    const hotWaterEvery = o.hotWaterPerDay ? Math.round(96 / o.hotWaterPerDay) : 0;
    for (let k = 0; k < total; k++) {
        const hourOfDay = (k / 4) % 24;
        drift += r.gauss() * 0.15;
        drift *= 0.995;
        const te = 2 + drift + 4 * Math.sin(2 * Math.PI * (hourOfDay - 9) / 24);
        const clear = r.next() < 0.5 ? 1 : 0.3;
        const sun = Math.max(0, 450 * Math.sin(Math.PI * (hourOfDay - 7) / 10)) * (hourOfDay > 7 && hourOfDay < 17 ? clear : 0);
        if (blockLeft-- <= 0) {
            blockLeft = 8 + Math.floor(r.next() * 16);
            block = o.excitation ? 1 + o.excitation * (r.next() * 2 - 1) : 1;
        }
        const hotWater = hotWaterEvery > 0 && k % hotWaterEvery === 0;
        // Weather compensation, a weak room correction, then the excitation multiplier.
        const want = house.heatLoss * (21 - te) + 0.3 * (21 - ti) - house.gains;
        const P = hotWater ? 0 : Math.min(8, Math.max(0, want * block));
        let tiSum = 0;
        for (let m = 0; m < perSlot; m++) {
            const dt = 1 / 60;
            if (o.singleNode) {
                ti += dt * (house.heatLoss * (te - ti) + P + house.sun * sun + house.gains) / house.ci;
            } else {
                const dti = (house.heatLoss * (te - ti) + (tm - ti) / house.rim + (1 - house.f) * P
                    + house.sun * sun + house.gains) / house.ci;
                const dtm = ((ti - tm) / house.rim + house.f * P) / house.cm;
                ti += dt * dti;
                tm += dt * dtm;
            }
            tiSum += ti;
        }
        slots.push({
            slot: 1_000_000 + k,
            ti: tiSum / perSlot + r.gauss() * noise,
            inputs: {te, q: P * 0.25, sun},
            usable: !hotWater,
        });
    }
    return slots;
}

export const RADIATOR_HOUSE: HouseParams = {heatLoss: 0.18, ci: 1.5, cm: 8, rim: 1 / 1.5, f: 0.25, sun: 0.004, gains: 0.3};
export const SLAB_HOUSE: HouseParams = {heatLoss: 0.12, ci: 1.2, cm: 14, rim: 2 / 1.2, f: 0.85, sun: 0.003, gains: 0.25};
