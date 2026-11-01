/** A simulated 2R2C house heated by a weather-compensated pump, for the model tests. It steps in
 *  1-minute Euler substeps, not the model's exact discretisation, and records slot means the way
 *  the history aggregator does, so a fit is not the model recognising itself. */
import type {HouseParams, ModelSlot} from '../lib/smart/model';
import {WALLS, sunPosition, wallIrradiance} from '../lib/smart/solar';

/** Slot of 2026-10-01 00:00 UTC: the sim's sun is an October sun at the maintainer's latitude. */
export const SIM_START_SLOT = Date.UTC(2026, 9, 1) / 900_000;

/** Clear or overcast sky → irradiance on the three walls, W/m², at the middle of slot `slot`. */
export function simSun(slot: number, clear: number): {sun: number; sunE: number; sunW: number} {
    const pos = sunPosition((slot + 0.5) * 900_000, 59.37, 17.92);
    const up = Math.max(0, Math.sin(pos.altitude));
    const dni = clear * 750 * up ** 0.3 * (up > 0 ? 1 : 0);
    const dhi = up > 0 ? 30 + 90 * up * (1.5 - clear) : 0;
    const ghi = dni * up + dhi;
    const wall = (facing: number) => wallIrradiance(dni, dhi, ghi, pos, facing);
    return {sun: wall(WALLS.south), sunE: wall(WALLS.east), sunW: wall(WALLS.west)};
}

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
    let clearToday = 1;
    const perSlot = 15;
    const total = o.days * 96;
    const hotWaterEvery = o.hotWaterPerDay ? Math.round(96 / o.hotWaterPerDay) : 0;
    for (let k = 0; k < total; k++) {
        const hourOfDay = (k / 4) % 24;
        const slot = SIM_START_SLOT + k;
        drift += r.gauss() * 0.15;
        drift *= 0.995;
        const te = 2 + drift + 4 * Math.sin(2 * Math.PI * (hourOfDay - 9) / 24);
        // Clear or overcast for a whole day, so the walls' hours of sun can be told apart.
        if (k % 96 === 0) clearToday = r.next() < 0.5 ? 1 : 0.3;
        const walls = simSun(slot, clearToday);
        const solar = house.sun * walls.sun + house.sunE * walls.sunE + house.sunW * walls.sunW;
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
                ti += dt * (house.heatLoss * (te - ti) + P + solar + house.gains) / house.ci;
            } else {
                const dti = (house.heatLoss * (te - ti) + (tm - ti) / house.rim + (1 - house.f) * P
                    + solar + house.gains) / house.ci;
                const dtm = ((ti - tm) / house.rim + house.f * P) / house.cm;
                ti += dt * dti;
                tm += dt * dtm;
            }
            tiSum += ti;
        }
        slots.push({
            slot,
            ti: tiSum / perSlot + r.gauss() * noise,
            inputs: {te, q: P * 0.25, ...walls},
            usable: !hotWater,
        });
    }
    return slots;
}

export const RADIATOR_HOUSE: HouseParams = {heatLoss: 0.18, ci: 1.5, cm: 8, rim: 1 / 1.5, f: 0.25,
    sun: 0.004, sunE: 0.002, sunW: 0.002, gains: 0.3};
export const SLAB_HOUSE: HouseParams = {heatLoss: 0.12, ci: 1.2, cm: 14, rim: 2 / 1.2, f: 0.85,
    sun: 0.003, sunE: 0.001, sunW: 0.001, gains: 0.25};
/** The radiator house with its glass on the west side: same envelope, afternoon sun. */
export const WEST_HOUSE: HouseParams = {...RADIATOR_HOUSE, sun: 0.0005, sunE: 0.0005, sunW: 0.008};
