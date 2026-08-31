// Estimated litres of hot water.
//
// The pump reports tank TEMPERATURES, never a volume. NIBE added a hot-water volume figure to the
// myUplink tile in S-series firmware 4.4.7, but only for integrated-tank models and only in the
// cloud — that changelog names every new Modbus register it shipped and names none for this, and no
// S or F register map in the open-source datasets carries one. So the number is computed here or
// not at all.
//
// WHAT IT MEANS. V40: the litres of 40 °C water the heat now in the tank can still deliver, the
// same quantity NIBE prints on its own tank datasheets as "equivalent amount of hot water". It is a
// legal term (EU Ecodesign / EN 16147) and it is what an owner actually wants — 175 L at 55 °C is a
// lot more showering than 175 L. It therefore legitimately EXCEEDS the tank volume, and is not
// capped at it.
//
// WHERE THE VOLUME COMES FROM. The user, via the tank picker. The app cannot work it out: deriving
// it from the pump's delivered-energy counter was built, then tested against a real S1155-16 with a
// confirmed 176 L VPB 200, and measured 436 L. A charge ends only when the bottom sensor reaches
// its stop temperature, so hot water drawn during the charge just makes the charge run longer and
// that surplus heat is indistinguishable from tank volume. Across four charges the delivered energy
// ran 2.00x (+/-0.16) what the tank could hold. See docs/hot-water-estimate.md.

// The mix temperature V40 is defined against. Not configurable: it is what the standard says.
export const MIX_C = 40;

// Cold-water inlet. NIBE's own datasheets assume 10 °C — their VPB 200 (172 L) is published as
// 230 L of 40 °C water, and 230/172 is exactly (50−10)/(40−10). Used only until the tank's own
// lower sensor has been watched long enough to observe the real one (see learnedInletC).
export const DEFAULT_INLET_C = 10;

export const MIN_TANK_LITRES = 50;
export const MAX_TANK_LITRES = 1000;

// Litres of 40 °C water available, from the tank's size and its two temperature sensors.
//
// THE THERMOCLINE IS INTERPOLATED BETWEEN THE SENSORS rather than each sensor being lumped into a
// fixed share of the tank. That distinction is the whole model, and it was arrived at by watching
// the lumped version fail on live hardware in two ways:
//
//   - It could not see a draw. Hot water leaves from the TOP and cold enters the BOTTOM, so the
//     lower sensor collapses while the upper one stays hot until the front reaches it. With the
//     lower sensor already below the mix point and contributing nothing, a real shower moved the
//     estimate 1.0 L while roughly 50 L left the tank — out by a factor of 48.
//   - It was DISCONTINUOUS at the mix point. Holding a fixed share of the tank at the upper
//     sensor's temperature means that share vanishes in one step as that sensor crosses 40 °C:
//     61.5 L at BT7 40.1, zero at BT7 40.0. On the owner's Insights chart that drew as a vertical
//     drop to zero, which reads as the app breaking.
//
// Interpolating fixes both, and needs no parameter: as the upper sensor approaches 40 °C the
// fraction of the tank above 40 shrinks toward nothing, so the figure decays to zero smoothly, and
// it responds to BOTH sensors continuously so a draw is visible while it happens. It also drops the
// guessed upper-share constant the lumped model needed, which was the single largest source of
// error in the whole estimate (moving it 0.25 -> 0.45 swung the answer ~57 %).
//
// Reaching zero is correct, not a failure: once the hottest water in the tank is below 40 °C there
// is genuinely no 40 °C shower left in it. What was wrong before was arriving there in one jump.
export function usableLitres(
    litres: number, topC: number, lowerC: number, inletC = DEFAULT_INLET_C
): number | null {
    const span = MIX_C - inletC;
    // An inlet at or above the mix point makes the ratio meaningless (and divides by zero).
    if (!(span > 0) || !(litres > 0)
        || !Number.isFinite(topC) || !Number.isFinite(lowerC))
        return null;
    const hot = Math.max(topC, lowerC);
    const cold = Math.min(topC, lowerC);
    if (hot <= MIX_C)
        return 0;
    // Above the mix point everywhere: the whole tank counts, at its mean temperature. Otherwise the
    // front lies between the sensors, and a linear profile puts it here — which is the honest use
    // of two data points, and far closer to a real moving thermocline than two isothermal lumps.
    const wholeTankIsHot = cold >= MIX_C;
    const above = wholeTankIsHot ? 1 : (hot - MIX_C) / (hot - cold);
    const mean = wholeTankIsHot ? (hot + cold) / 2 : (hot + MIX_C) / 2;
    return litres * above * (mean - inletC) / span;
}

// --- The tank the user picked -----------------------------------------------------------

export interface TankChoice {
    tankId: string;
    litres: number | null;
    // Only ever present as a carried-over override from a device configured before the inlet was
    // observed rather than asked for. ABSENT IS THE NORMAL CASE and must stay absent: writing a
    // default here would look exactly like an explicit answer and permanently suppress the
    // learned value.
    inletC?: number;
}

// What the user picked, validated. Pure and here rather than in the driver so it can be tested
// without a Homey runtime — the same reason capabilitySyncPlan() was split out of
// syncCapabilities().
export function cleanTankChoice(
    raw: any, tanks: {id: string; litres: number}[]
): TankChoice | undefined {
    if (!raw)
        return undefined;
    const inletRaw = Number(raw.inletC);
    // Below freezing is not a mains inlet, and at or above the mix point the estimate would divide
    // by zero. Anything else is dropped rather than defaulted — see the field comment.
    const override = Number.isFinite(inletRaw) && inletRaw >= 0 && inletRaw < MIX_C
        ? {inletC: inletRaw} : {};
    const tankId = String(raw.tankId ?? 'none');
    const known = tanks.find((tank) => tank.id === tankId);
    if (known)
        return {tankId: known.id, litres: known.litres, ...override};
    if (tankId === 'custom') {
        const litres = Number(raw.litres);
        if (Number.isFinite(litres) && litres >= MIN_TANK_LITRES && litres <= MAX_TANK_LITRES)
            return {tankId: 'custom', litres, ...override};
    }
    // "none" is a real answer, not a fallback: the app cannot derive the volume, so declining
    // simply means no estimate. An id the view offers that we do not recognise lands here too.
    return {tankId: 'none', litres: null, ...override};
}

// --- Learning the cold-water inlet ------------------------------------------------------
//
// The other half of the conversion, and asking for it was worse than useless: almost nobody knows
// their mains temperature, and a wrong answer skews every figure. It can be observed instead.
//
// The lower tank sensor sits above the cold feed, so after a deep draw it settles close to what is
// coming in. Its LOW-WATER MARK over a long window is therefore an estimate of the inlet — and a
// one-sided one: the sensor is above the very bottom and is only reached by a draw big enough to
// empty the tank, so the observed minimum is at or ABOVE the true inlet.
//
// THAT BIAS IS OPTIMISTIC, NOT CONSERVATIVE, which is the opposite of what it looks like. V40
// scales as (T − inlet)/(40 − inlet), and raising the inlet shrinks the denominator faster than the
// numerator — so an over-estimated inlet makes V40 read HIGH.
//
// The upper clamp is therefore doing real work rather than being a sanity check. Mains water is not
// 22 °C in a Swedish house; a minimum that high means the tank was never drawn far enough to see
// the inlet at all. Above the clamp we decline and fall back to NIBE's own 10 °C.
//
// Daily minima rather than a running minimum of everything: a single anomalous reading would
// otherwise pin the estimate for a month, and taking the minimum across days lets a genuinely
// warmer summer supply push the estimate back up as old days age out.
export const COLD_WINDOW_DAYS = 30;
export const MIN_INLET_C = 2;
export const MAX_INLET_C = 20;

export interface ColdSample {
    day: number;
    minC: number;
}

export function learnedInletC(samples: ColdSample[], today: number): number | null {
    const fresh = samples.filter((s) => today - s.day < COLD_WINDOW_DAYS);
    if (!fresh.length)
        return null;
    const low = Math.min(...fresh.map((s) => s.minC));
    if (!Number.isFinite(low) || low < MIN_INLET_C || low > MAX_INLET_C)
        return null;
    return Math.round(low * 10) / 10;
}

// Days since the epoch, in local time — the boundary only has to be consistent, not meaningful.
export function dayNumber(at: number): number {
    const d = new Date(at);
    return Math.floor((at - d.getTimezoneOffset() * 60_000) / 86_400_000);
}
