import {Dir} from '../../lib/registers';
import type {LocalizedText, ReasonConfig, ReasonContext, ReasonState} from '../../lib/profile';

// Why the pump just changed what it is producing.
//
// Nibe publishes no "reason" register — the control logic is internal — but the decision is
// driven by a handful of readable comparisons, and those are what a person actually wants:
//
//   * Heating runs off **degree minutes** (register 11): the pump integrates the gap between
//     the calculated supply temperature and the actual one. DM falls while the house is under-
//     heated; when it reaches the start threshold (97, typically -60) the compressor starts,
//     and heating ends when DM climbs back to 0. A further difference below that (679) brings
//     in the electric addition.
//   * Hot water starts when the charge sensor BT6 (9) drops to the start temperature for the
//     active demand mode (56 → 60/59/58) and stops at that mode's stop temperature (64/63/62).
//   * Pool works the same way against its own start/stop pair (687/689).
//   * Cooling starts once DM rises above the cooling threshold (20) with a warm enough outdoor
//     temperature (183).
//   * Heating is blocked outright above the outdoor cut-off (184) regardless of DM.
//
// So each rule below picks the comparison that actually fired and states it with the two or
// three numbers that justify it. Everything is optional-safe: any input can be missing (the
// register isn't on this model, the accessory isn't fitted), and a rule that can't back up its
// claim falls through to a weaker one rather than printing a blank.

const HW_LIMITS: Record<number, {start: string; stop: string; mode: LocalizedText}> = {
    0: {start: 'hwStartSmall',  stop: 'hwStopSmall',  mode: {en: 'Small',  sv: 'Litet'}},
    1: {start: 'hwStartMedium', stop: 'hwStopMedium', mode: {en: 'Medium', sv: 'Medel'}},
    2: {start: 'hwStartLarge',  stop: 'hwStopLarge',  mode: {en: 'Large',  sv: 'Stort'}},
    // "Smart control" learns the household's pattern; it charges to the medium band.
    4: {start: 'hwStartMedium', stop: 'hwStopMedium', mode: {en: 'Smart control', sv: 'Smart styrning'}}
};

// What started the hot water charge that is running, recorded when the pump enters hot water and
// read back when it leaves. It has to be remembered rather than re-read at the end: the profile's
// reset rule clears "More hot water" (697) the moment the pump goes hot water -> idle, and writes
// jump the wire queue ahead of the reads this file makes, so by the time a finished charge is
// explained the boost that caused it is usually already gone.
//
// It decides which stop point the charge was aiming at, which is the whole point — and only one
// of the three aims at the demand mode the user has selected:
//
//   * a "More hot water" boost raises the pump to luxury for its duration, so it charges to
//     **Large's** stop point (62) whatever mode is selected;
//   * the periodic anti-legionella charge has its own setpoint (61);
//   * only a charge the pump started on its own demand aims at the selected mode's pair.
//
// Quoting the selected mode for all three is what this fixes: a boost in Medium overshot it and
// looked like a mystery to explain away, and one that stopped short of Large but above Medium was
// announced as "charged".
type HwTrigger = 'boost' | 'periodic' | 'demand';
const HW_TRIGGER = 'hwTrigger';

// The stop point a charge aims at, for the two triggers that ignore the selected demand mode.
function hwTargetFor(trigger: 'boost' | 'periodic', v: ReasonContext['v']): number | undefined {
    return trigger === 'boost' ? v(HW_LIMITS[2]!.stop) : v('hwStopPeriodic');
}

// ...and how to name it, once it has a number to carry.
function hwTargetPhrase(trigger: 'boost' | 'periodic', target: number): LocalizedText {
    return trigger === 'boost'
        ? {en: `the ${e(target)} °C ${HW_LIMITS[2]!.mode.en} stop point that "More hot water" charges to`,
           sv: `stopptemperaturen ${s(target)} °C för behovsläget ${HW_LIMITS[2]!.mode.sv.toLowerCase()}, `
              + `som "Mer varmvatten" laddar till`}
        : {en: `the ${e(target)} °C stop point for the periodic hot water charge`,
           sv: `stopptemperaturen ${s(target)} °C för den periodiska varmvattenladdningen`};
}

// The two as a subject, for a model that doesn't publish the setpoint they aim at.
const HW_TRIGGER_FINISHED: Record<'boost' | 'periodic', LocalizedText> = {
    boost:    {en: 'The "More hot water" boost', sv: 'Höjningen "Mer varmvatten"'},
    periodic: {en: 'The periodic hot water charge', sv: 'Den periodiska varmvattenladdningen'}
};

// Reading the trigger also consumes it: the charge it describes has ended, and a trigger left
// behind would go on to explain the next one.
function takeHwTrigger(state: ReasonState): HwTrigger | undefined {
    const trigger = state[HW_TRIGGER];
    delete state[HW_TRIGGER];
    return typeof trigger === 'string' ? trigger as HwTrigger : undefined;
}

// One decimal, decimal comma in Swedish; degree minutes are whole numbers.
const e = (n: number) => n.toFixed(1);
const s = (n: number) => n.toFixed(1).replace('.', ',');
const dm = (n: number) => String(Math.round(n));

export const sReason: ReasonConfig = {
    inputs: {
        // Heating: degree minutes and the thresholds they are compared against.
        // s32 — must match the register table's declaration, or the same register decodes
        // differently depending on whether it arrives via the poll loop or this path.
        dm:              {address:   11, direction: Dir.Out, scale: 10, size: 32},
        dmStart:         {address:   97, direction: Dir.Out},
        dmAddDiff:       {address:  679, direction: Dir.Out},
        calcSupply:      {address: 1017, direction: Dir.In,  scale: 10},
        supply:          {address:    5, direction: Dir.In,  scale: 10},
        addSteps:        {address: 1029, direction: Dir.In},
        stopHeatingOut:  {address:  184, direction: Dir.Out, scale: 10},
        // 184's own info string calls it out: the outdoor cut-off is an *auto-mode* rule
        // (0 = Auto, 1 = Manual, 2 = Add. heat only — see registers.ts). Needed so the
        // "heating stays off" qualifier below doesn't cite a rule that isn't in effect.
        operatingMode:   {address:  237, direction: Dir.Out},
        // Hot water: the charge sensor, the demand mode, and that mode's start/stop pair.
        hwCharge:        {address:    9, direction: Dir.In,  scale: 10},
        hwTop:           {address:    8, direction: Dir.In,  scale: 10},
        hwMode:          {address:   56, direction: Dir.Out},
        hwStartSmall:    {address:   60, direction: Dir.Out, scale: 10},
        hwStopSmall:     {address:   64, direction: Dir.Out, scale: 10},
        hwStartMedium:   {address:   59, direction: Dir.Out, scale: 10},
        hwStopMedium:    {address:   63, direction: Dir.Out, scale: 10},
        hwStartLarge:    {address:   58, direction: Dir.Out, scale: 10},
        hwStopLarge:     {address:   62, direction: Dir.Out, scale: 10},
        // The periodic anti-legionella charge's own stop point, which is none of the three above
        // (a boost aims at Large). Absent on S330/S332, so every use of it tolerates undefined.
        hwStopPeriodic:  {address:   61, direction: Dir.Out, scale: 10},
        moreHotwater:    {address:  697, direction: Dir.Out},
        periodicHw:      {address:   65, direction: Dir.Out},
        // Cooling and pool.
        dmCooling:       {address:   20, direction: Dir.Out, scale: 10},
        startCoolingOut: {address:  183, direction: Dir.Out, scale: 10},
        poolTemp:        {address:   27, direction: Dir.In,  scale: 10},
        poolStart:       {address:  687, direction: Dir.Out, scale: 10},
        poolStop:        {address:  689, direction: Dir.Out, scale: 10},
        // Context that can override any of the above.
        outdoor:         {address:    1, direction: Dir.In,  scale: 10},
        sgReady:         {address: 1911, direction: Dir.In}
    },

    explain({role, previousRole, v, state}: ReasonContext): LocalizedText | undefined {
        const limits = HW_LIMITS[v('hwMode') ?? 1] ?? HW_LIMITS[1]!;
        const hwStart = v(limits.start);
        const hwStop = v(limits.stop);
        // BT6 (charge) is what the start/stop temperatures actually gate on; BT7 (top) is the
        // fallback for tanks that don't report it.
        const hw = v('hwCharge') ?? v('hwTop');

        const main = explainRole(role, previousRole, hwStart, hwStop, hw, limits.mode, v, state);
        if (!main)
            return undefined;
        const extra = qualifier(role, previousRole, v);
        return extra
            ? {en: `${main.en} ${extra.en}`, sv: `${main.sv} ${extra.sv}`}
            : main;
    }
};

function explainRole(role: string, previousRole: string | undefined,
                     hwStart: number | undefined, hwStop: number | undefined,
                     hw: number | undefined, mode: LocalizedText,
                     v: ReasonContext['v'], state: ReasonState): LocalizedText | undefined {
    const degreeMinutes = v('dm');
    const dmStart = v('dmStart');
    // Any move away from hot water ends that charge, so its trigger is consumed here whether or
    // not the branch that follows has a use for it — leaving it behind would let a boost explain
    // the next charge, which is the same class of bug this tracking exists to fix.
    const hwTrigger = previousRole === 'hotwater' && role !== 'hotwater'
        ? takeHwTrigger(state)
        : undefined;

    if (role === 'hotwater') {
        // Whatever fired this charge decides which stop point it is aiming at, and only this end
        // of the transition can see it — hence the record rather than a re-read at the far end.
        const boost = v('moreHotwater') ?? 0;
        if (boost > 0) {
            state[HW_TRIGGER] = 'boost';
            const target = hwTargetFor('boost', v);
            return target !== undefined
                ? {en: `"More hot water" was switched on, so the pump is charging the tank to `
                      + `${HW_LIMITS[2]!.mode.en}'s ${e(target)} °C stop point.`,
                   sv: `"Mer varmvatten" har slagits på, så pumpen laddar tanken till ${s(target)} °C, `
                      + `stopptemperaturen för behovsläget ${HW_LIMITS[2]!.mode.sv.toLowerCase()}.`}
                : {en: '"More hot water" was switched on, so the pump is charging the tank now.',
                   sv: '"Mer varmvatten" har slagits på, så pumpen laddar tanken nu.'};
        }
        if (hw !== undefined && hwStart !== undefined && hw <= hwStart + 0.5) {
            state[HW_TRIGGER] = 'demand';
            return {
                en: `Hot water ran down to ${e(hw)} °C, reaching the ${e(hwStart)} °C start point for ${mode.en} demand.`,
                sv: `Varmvattnet sjönk till ${s(hw)} °C och nådde starttemperaturen ${s(hwStart)} °C för behovsläge ${mode.sv.toLowerCase()}.`
            };
        }
        // Above the start point but charging anyway — that is what a scheduled top-up looks
        // like, so only say so when periodic hot water is actually enabled.
        if (hw !== undefined && hwStart !== undefined && (v('periodicHw') ?? 0) > 0) {
            state[HW_TRIGGER] = 'periodic';
            const periodicTarget = hwTargetFor('periodic', v);
            return periodicTarget !== undefined
                ? {en: `Scheduled periodic hot water charge to ${e(periodicTarget)} °C — the tank is at ${e(hw)} °C, `
                      + `above its ${e(hwStart)} °C start point.`,
                   sv: `Schemalagd periodisk varmvattenladdning till ${s(periodicTarget)} °C — tanken håller ${s(hw)} °C, `
                      + `över starttemperaturen ${s(hwStart)} °C.`}
                : {en: `Scheduled periodic hot water charge — the tank is at ${e(hw)} °C, above its ${e(hwStart)} °C start point.`,
                   sv: `Schemalagd periodisk varmvattenladdning — tanken håller ${s(hw)} °C, över starttemperaturen ${s(hwStart)} °C.`};
        }
        // Nothing here identifies what fired it, and a guess would be worse than the fallback the
        // end-of-charge rule already has. Clear rather than leave the previous charge's answer.
        delete state[HW_TRIGGER];
        return hw !== undefined
            ? {en: `Hot water demand — the tank is at ${e(hw)} °C.`,
               sv: `Varmvattenbehov — tanken håller ${s(hw)} °C.`}
            : {en: 'Hot water demand.', sv: 'Varmvattenbehov.'};
    }

    if (role === 'heating') {
        if (degreeMinutes === undefined || dmStart === undefined)
            return {en: 'Heat demand in the house.', sv: 'Värmebehov i huset.'};
        const supply = v('supply');
        const calcSupply = v('calcSupply');
        const gap = supply !== undefined && calcSupply !== undefined
            ? {en: ` The supply line is ${e(supply)} °C against a calculated ${e(calcSupply)} °C.`,
               sv: ` Framledningen är ${s(supply)} °C mot beräknade ${s(calcSupply)} °C.`}
            : {en: '', sv: ''};
        // Coming off another function the compressor is already turning, so degree minutes
        // needn't be past the start threshold — heating simply became the top priority again.
        if (degreeMinutes > dmStart && previousRole && previousRole !== 'main')
            return {
                en: `${finished(previousRole).en}, so the pump went back to heating — degree minutes `
                    + `are at ${dm(degreeMinutes)}, still short of the ${dm(dmStart)} start threshold.${gap.en}`,
                sv: `${finished(previousRole).sv}, så pumpen gick tillbaka till värme — gradminuterna `
                    + `ligger på ${dm(degreeMinutes)}, ännu inte vid startgränsen ${dm(dmStart)}.${gap.sv}`
            };
        if (degreeMinutes > dmStart)
            return {
                en: `Heat demand — degree minutes are at ${dm(degreeMinutes)}, with the compressor `
                    + `start threshold at ${dm(dmStart)}.${gap.en}`,
                sv: `Värmebehov — gradminuterna ligger på ${dm(degreeMinutes)}, med kompressorns `
                    + `startgräns vid ${dm(dmStart)}.${gap.sv}`
            };
        return {
            en: `The house fell behind on heat: degree minutes are down to ${dm(degreeMinutes)}, at or `
                + `past the ${dm(dmStart)} threshold that starts the compressor.${gap.en}`,
            sv: `Huset kom efter på värme: gradminuterna är nere på ${dm(degreeMinutes)}, vid eller `
                + `förbi gränsen ${dm(dmStart)} som startar kompressorn.${gap.sv}`
        };
    }

    if (role === 'cooling') {
        const outdoor = v('outdoor');
        const dmCooling = v('dmCooling');
        if (degreeMinutes === undefined || dmCooling === undefined)
            return {en: 'Cooling demand in the house.', sv: 'Kylbehov i huset.'};
        return {
            en: `The house is running warm: degree minutes rose to ${dm(degreeMinutes)}, past the `
                + `${dm(dmCooling)} cooling threshold${outdoor !== undefined ? `, with ${e(outdoor)} °C outdoors` : ''}.`,
            sv: `Huset blir för varmt: gradminuterna steg till ${dm(degreeMinutes)}, förbi kylgränsen `
                + `${dm(dmCooling)}${outdoor !== undefined ? `, med ${s(outdoor)} °C ute` : ''}.`
        };
    }

    if (role === 'pool') {
        const pool = v('poolTemp');
        const poolStart = v('poolStart');
        if (pool === undefined || poolStart === undefined)
            return {en: 'The pool needs heating.', sv: 'Poolen behöver värme.'};
        return {
            en: `The pool cooled to ${e(pool)} °C, reaching its ${e(poolStart)} °C start point.`,
            sv: `Poolen svalnade till ${s(pool)} °C och nådde starttemperaturen ${s(poolStart)} °C.`
        };
    }

    // role === 'main' — the pump went idle. Say what it just finished, since "nothing to do"
    // on its own explains nothing.
    if (previousRole === 'hotwater') {
        if (hw === undefined)
            return {en: 'Hot water charging finished.', sv: 'Varmvattenladdningen är klar.'};
        // A boost was aiming at Large and the periodic charge at 61, neither of which is the
        // selected demand mode's stop point — so that is what each gets measured against.
        if (hwTrigger === 'boost' || hwTrigger === 'periodic')
            return endOfCharge(hw, hwTargetFor(hwTrigger, v), hwTrigger);
        if (hwStop === undefined)
            return {en: 'Hot water charging finished.', sv: 'Varmvattenladdningen är klar.'};
        // From here the charge was either the pump's own (trigger 'demand') or one nobody watched
        // start — the app was restarted mid-charge, or the run began before it connected. Both
        // get the demand mode's pair, and both keep the inference below.
        //
        // A charge that ended *above* the demand mode's stop point was not stopped by it — a
        // boost was running. It is still worth inferring even with the trigger tracked, because a
        // boost switched on *during* a demand-driven charge extends a run that was recorded as
        // 'demand'. What DID stop it is not something we can name: measured on an S1155 with the
        // immersion heater off, two boosts ended at 54.6 and 55.0 °C while register 61 read 62.0
        // and Large read 58.0. Two runs ending at *different* temperatures point to a compressor
        // ceiling rather than a setpoint — a setpoint gives the same number every time. So state
        // what happened and stop there, rather than naming a limit that may not have been the
        // operative one.
        if (hw > hwStop + 0.5)
            return {en: `The tank is charged: hot water reached ${e(hw)} °C — past ${mode.en}'s `
                      + `${e(hwStop)} °C stop point, because a boost was running.`,
                    sv: `Tanken är laddad: varmvattnet nådde ${s(hw)} °C — förbi ${mode.sv.toLowerCase()}s `
                      + `stopptemperatur ${s(hwStop)} °C, eftersom en höjning pågick.`};
        // Only call it charged if it actually got there. A charge ends short for several reasons
        // the app cannot distinguish — the user cancelling it, a schedule (menu 6) cutting in, the
        // compressor giving up — so this states what happened and stops. Measured on an S1155: a
        // boost ran 12 minutes and ended at 41.9 °C against a 68 °C setpoint, and this line called
        // that "charged". Naming a cause here would be guessing; saying it ended short is not.
        if (hw < hwStop - 1)
            return {en: `Hot water charging ended at ${e(hw)} °C, short of its ${e(hwStop)} °C stop point.`,
                    sv: `Varmvattenladdningen avslutades vid ${s(hw)} °C, före stopptemperaturen `
                      + `${s(hwStop)} °C.`};
        return {en: `The tank is charged: hot water reached ${e(hw)} °C, its ${e(hwStop)} °C stop point.`,
                sv: `Tanken är laddad: varmvattnet nådde ${s(hw)} °C, stopptemperaturen ${s(hwStop)} °C.`};
    }

    if (previousRole === 'heating')
        return degreeMinutes !== undefined
            ? {en: `The house has caught up on heat — degree minutes are back to ${dm(degreeMinutes)}`
                  + `${dmStart !== undefined ? ` (the compressor restarts at ${dm(dmStart)})` : ''}.`,
               sv: `Huset har kommit ikapp på värme — gradminuterna är tillbaka på ${dm(degreeMinutes)}`
                  + `${dmStart !== undefined ? ` (kompressorn startar om vid ${dm(dmStart)})` : ''}.`}
            : {en: 'The heat demand has been met.', sv: 'Värmebehovet är tillgodosett.'};

    if (previousRole === 'pool') {
        const pool = v('poolTemp');
        const poolStop = v('poolStop');
        return pool !== undefined && poolStop !== undefined
            ? {en: `The pool reached ${e(pool)} °C, its ${e(poolStop)} °C stop point.`,
               sv: `Poolen nådde ${s(pool)} °C, stopptemperaturen ${s(poolStop)} °C.`}
            : {en: 'Pool heating finished.', sv: 'Pooluppvärmningen är klar.'};
    }

    if (previousRole === 'cooling')
        return {en: 'The cooling demand has been met.', sv: 'Kylbehovet är tillgodosett.'};

    // Idle from idle, or from something unmapped.
    if (degreeMinutes !== undefined && dmStart !== undefined)
        return {
            en: `Nothing to produce — degree minutes are at ${dm(degreeMinutes)} and the compressor `
                + `does not start until ${dm(dmStart)}.`,
            sv: `Inget att producera — gradminuterna ligger på ${dm(degreeMinutes)} och kompressorn `
                + `startar inte förrän vid ${dm(dmStart)}.`
        };
    return {en: 'The pump has no demand to meet.', sv: 'Pumpen har inget behov att möta.'};
}

// How a charge that ignored the selected demand mode ended, measured against the setpoint it was
// actually aiming at. Same 1 °C tolerance the demand-mode rule uses, and the same restraint about
// causes: a charge stops short for reasons the app cannot tell apart (the compressor's ceiling
// with the immersion heater blocked, a schedule cutting in, the user cancelling), so this says how
// far it got and stops there. When the setpoint doesn't read there is no number to quote — and
// falling back to the mode's stop point is exactly the mistake this rule exists to avoid.
function endOfCharge(hw: number, target: number | undefined,
                     trigger: 'boost' | 'periodic'): LocalizedText {
    if (target === undefined) {
        const what = HW_TRIGGER_FINISHED[trigger];
        return {en: `${what.en} finished with the tank at ${e(hw)} °C.`,
                sv: `${what.sv} avslutades med tanken på ${s(hw)} °C.`};
    }
    const label = hwTargetPhrase(trigger, target);
    if (hw < target - 1)
        return {en: `Hot water charging ended at ${e(hw)} °C, short of ${label.en}.`,
                sv: `Varmvattenladdningen avslutades vid ${s(hw)} °C, före ${label.sv}.`};
    return {en: `The tank is charged: hot water reached ${e(hw)} °C, ${label.en}.`,
            sv: `Tanken är laddad: varmvattnet nådde ${s(hw)} °C, ${label.sv}.`};
}

// What the pump just stopped doing, as a clause. Used when heating resumes on the back of
// another function rather than on its own demand.
function finished(role: string): LocalizedText {
    if (role === 'hotwater')
        return {en: 'Hot water was finished', sv: 'Varmvattnet blev klart'};
    if (role === 'pool')
        return {en: 'The pool was up to temperature', sv: 'Poolen kom upp i temperatur'};
    if (role === 'cooling')
        return {en: 'Cooling was finished', sv: 'Kylan blev klar'};
    return {en: 'The previous demand was met', sv: 'Det föregående behovet blev tillgodosett'};
}

// A second sentence, only when something is actively overriding the normal logic: the outdoor
// heating cut-off, the electric addition, or an SG Ready price signal. Nothing otherwise —
// silence is better than filler.
function qualifier(role: string, previousRole: string | undefined,
                   v: ReasonContext['v']): LocalizedText | undefined {
    const outdoor = v('outdoor');
    const stopHeatingOut = v('stopHeatingOut');
    const operatingMode = v('operatingMode');
    // Only worth saying when the reader would otherwise expect heating to take over — going
    // idle from heating, or idling on. After hot water or pool it's a non sequitur.
    //
    // operatingMode === 0 (Auto) is required, not just "not known to be off" — 184 only governs
    // Auto (see its own info string in registers.ts), so in Manual or Add-heat-only this clause
    // would name a rule that isn't in effect. If the mode register doesn't answer, say nothing
    // rather than assume Auto — same as the existing outdoor/stopHeatingOut undefined-safety.
    if (role === 'main' && (previousRole === undefined || previousRole === 'heating' || previousRole === 'main')
        && outdoor !== undefined && stopHeatingOut !== undefined && outdoor >= stopHeatingOut
        && operatingMode === 0)
        return {
            en: `Heating stays off anyway while it is ${e(outdoor)} °C outside (the limit is ${e(stopHeatingOut)} °C).`,
            sv: `Värmen är ändå avstängd så länge det är ${s(outdoor)} °C ute (gränsen är ${s(stopHeatingOut)} °C).`
        };

    if (role === 'heating') {
        const steps = v('addSteps') ?? 0;
        const dmValue = v('dm');
        const dmStart = v('dmStart');
        const addDiff = v('dmAddDiff');
        if (steps > 0)
            return dmStart !== undefined && addDiff !== undefined
                ? {en: `The compressor alone was not keeping up, so the electric addition has joined in `
                      + `at ${steps} step${steps === 1 ? '' : 's'} (it cuts in at ${dm(dmStart - addDiff)}).`,
                   sv: `Kompressorn ensam räckte inte till, så eltillsatsen har gått in med ${steps} steg `
                      + `(den kopplar in vid ${dm(dmStart - addDiff)}).`}
                : {en: `The electric addition is running at ${steps} step${steps === 1 ? '' : 's'}.`,
                   sv: `Eltillsatsen går med ${steps} steg.`};
        if (dmValue !== undefined && dmStart !== undefined && addDiff !== undefined
            && dmValue <= dmStart - addDiff)
            return {
                en: `Degree minutes are past ${dm(dmStart - addDiff)}, so the electric addition may cut in.`,
                sv: `Gradminuterna är förbi ${dm(dmStart - addDiff)}, så eltillsatsen kan koppla in.`
            };
    }

    const sgReady = v('sgReady');
    if (sgReady === 20)
        return {
            en: 'SG Ready is signalling a high electricity price, which holds the pump back.',
            sv: 'SG Ready signalerar högt elpris, vilket håller tillbaka pumpen.'
        };
    if (sgReady === 40)
        return {
            en: 'SG Ready is signalling free electricity, so the pump is running harder than usual.',
            sv: 'SG Ready signalerar gratis el, så pumpen går hårdare än vanligt.'
        };
    return undefined;
}
