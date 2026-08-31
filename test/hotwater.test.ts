import {test} from 'node:test';
import assert from 'node:assert';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {
    DEFAULT_INLET_C, MAX_TANK_LITRES, MIN_TANK_LITRES, MIX_C,
    cleanTankChoice, dayNumber, learnedInletC, usableLitres
} from '../lib/hotwater';
import {sProfile} from '../drivers/nibe_s/profile';
import {
    HOTWATER_VOLUME_CAPABILITY, allRoles, extraCapabilities, extraCapabilityOptions,
    possibleExtraCapabilities
} from '../lib/roles';

const near = (actual: number, expected: number, tolerance: number, what: string) =>
    assert.ok(Math.abs(actual - expected) <= tolerance,
        `${what}: expected ${expected} ± ${tolerance}, got ${actual}`);

// ---------------------------------------------------------------------------------------
// V40, against NIBE's own published figures
// ---------------------------------------------------------------------------------------

// NIBE's VPB/VPBS brochure prints an "equivalent amount of hot water (40 °C)" for each tank, and
// for the small cylinders those numbers pin BOTH this formula and the 10 °C inlet NIBE assumes:
// 230/172 is exactly (50−10)/(40−10). A uniform tank has both sensors at the same temperature.
test('V40 matches NIBE\'s published figures for small cylinders', () => {
    const published: [number, number][] = [
        [172, 230],  // VPB 200 copper
        [176, 235],  // VPB 200 stainless
        [178, 238],  // VPB 200 enamel
        [272, 362],  // VPB 300 copper
        [282, 376],  // VPB 300 stainless
    ];
    for (const [litres, expected] of published)
        near(usableLitres(litres, 50, 50, 10)!, expected, 1.5, `${litres} L tank at 50 °C`);
});

// NIBE publishes 376 L and 455 L as the V40 of the SAME VPB S300 in two of its own documents — the
// second measured at double the draw rate with the coil recharging throughout. Large cylinders go
// the other way: VPB 500 is 486 L → 590 L, a ratio of 1.21 rather than 1.33, because a fast draw
// destroys the stratification this model assumes is preserved. So the figure is a bound, not a
// promise, and the gap widens with tank size. Asserted so nobody "fixes" the formula to chase a
// published number it was never computing.
test('the model is an upper bound, and knowingly diverges on large tanks', () => {
    assert.ok(usableLitres(486, 50, 50, 10)! > 590, 'stored heat exceeds the tested figure');
    near(usableLitres(486, 50, 50, 10)! / 590, 1.10, 0.02, 'VPB 500 over-estimate');
    near(usableLitres(172, 50, 50, 10)! / 230, 1.00, 0.01, 'VPB 200 agrees');
});

test('V40 exceeds the tank volume when the tank is hot — it must not be capped', () => {
    assert.ok(usableLitres(175, 55, 55, 10)! > 175);
});

test('an inlet at or above the mix point is refused rather than dividing by zero', () => {
    assert.equal(usableLitres(175, 55, 55, 40), null);
    assert.equal(usableLitres(175, 55, 55, 45), null);
    assert.equal(usableLitres(0, 55, 55, 10), null, 'no tank, no answer');
});

// ---------------------------------------------------------------------------------------
// The thermocline — why this model replaced a two-layer one
// ---------------------------------------------------------------------------------------

// Readings from a real shower on an S1155-16 (2026-08-31 19:35 → 19:41, ~50 L drawn). The lumped
// model moved 1.0 L across this because the lower sensor was already below the mix point and
// contributed nothing, so it was out by a factor of ~48. Interpolating the front makes the draw
// visible while it happens.
test('a draw in progress is visible, because both sensors count', () => {
    const V = 175, inlet = 16.6;
    const start = usableLitres(V, 43.5, 26.5, inlet)!;
    const end = usableLitres(V, 43.1, 25.2, inlet)!;
    assert.ok(start - end > 5,
        `a shower should move the estimate several litres, moved ${(start - end).toFixed(1)}`);
    // The lower sensor alone must move it, which is precisely what the lumped model could not do.
    assert.ok(usableLitres(V, 43.5, 26.5, inlet)! > usableLitres(V, 43.5, 22.0, inlet)!,
        'a colder tank bottom must mean less hot water, even with the top unchanged');
});

// The lumped model held a fixed share of the tank at the top sensor's temperature, so that share
// vanished in ONE STEP as the sensor crossed 40 °C — 61.5 L to zero, which drew on the owner's
// Insights chart as a vertical drop and read as the app breaking.
test('the estimate decays to zero smoothly as the tank passes the mix point', () => {
    const V = 175, inlet = 16.6, bottom = 20.2;
    const path = [41.0, 40.6, 40.3, 40.1, 40.0].map((t) => usableLitres(V, t, bottom, inlet)!);
    for (let i = 1; i < path.length; i++)
        assert.ok(path[i] <= path[i - 1], 'must fall monotonically toward the mix point');
    assert.ok(path[path.length - 2] < 2,
        `just above 40 °C only a sliver should remain, got ${path[path.length - 2].toFixed(1)}`);
    assert.equal(usableLitres(V, 40.0, bottom, inlet), 0);
    // Reaching zero is correct: below 40 °C there is no 40 °C shower left in the tank.
    assert.equal(usableLitres(V, 39.7, bottom, inlet), 0);
});

test('a fully hot tank uses its mean temperature, not just the top', () => {
    // Both sensors above the mix point: the whole tank counts.
    const even = usableLitres(175, 55, 55, 10)!;
    const skewed = usableLitres(175, 58, 52, 10)!;
    near(skewed, even, 0.01, 'the mean of 58 and 52 is 55');
});

test('the model is parameter-free — no split to guess', () => {
    // The lumped model needed an upper-share constant, and moving it 0.25 → 0.45 swung the answer
    // by ~57 %. Nothing here can be tuned: same inputs, same answer, always.
    const a = usableLitres(175, 44.2, 27.0, 15.4)!;
    const b = usableLitres(175, 44.2, 27.0, 15.4)!;
    assert.equal(a, b);
    assert.ok(a > 0 && a < 175);
});

// ---------------------------------------------------------------------------------------
// The tank the user picks
// ---------------------------------------------------------------------------------------

const CATALOGUE = sProfile.hotwaterTank!.tanks;

test('every catalogue tank is well formed, unique, and a plausible water volume', () => {
    const tank = sProfile.hotwaterTank!;
    assert.ok(sProfile.registerByName[tank.topRegister], 'top sensor must be a real register');
    assert.ok(sProfile.registerByName[tank.lowerRegister], 'lower sensor must be a real register');
    const ids = new Set<string>();
    for (const entry of tank.tanks) {
        assert.ok(!ids.has(entry.id), `duplicate tank id ${entry.id}`);
        ids.add(entry.id);
        assert.ok(entry.litres >= MIN_TANK_LITRES && entry.litres <= MAX_TANK_LITRES,
            `${entry.id}: ${entry.litres} L is outside the accepted range`);
        assert.ok(entry.name.en && entry.name.sv, `${entry.id} needs both languages`);
    }
    assert.ok(!ids.has('none') && !ids.has('custom'), 'reserved ids must not be catalogue entries');
});

// The catalogue holds WATER volume. NIBE's published "equivalent amount of hot water at 40 °C" is
// roughly a third larger, so a V40 figure pasted in by mistake would inflate every estimate.
test('no catalogue entry is secretly a V40 figure', () => {
    for (const entry of CATALOGUE)
        assert.ok(usableLitres(entry.litres, 50, 50, 10)! > entry.litres,
            `${entry.id}: stored volume should be smaller than its own 40 °C equivalent`);
    const vpb200 = CATALOGUE.find((t) => t.id === 'vpb200')!;
    assert.equal(vpb200.litres, 175, 'the VPB 200 family midpoint, not its V40 figure');
});

// One row per family, not per lining: picking the wrong lining costs ~2 %, and asking owners to
// know it was asking them for something that does not matter.
test('every tank family is one entry, not one per lining', () => {
    const names = CATALOGUE.map((t) => t.name.en);
    for (const gone of ['copper', 'stainless', 'enamel'])
        assert.ok(!names.some((n) => n.toLowerCase().includes(gone)),
            `the catalogue should not ask which lining a tank has (${gone})`);
    assert.ok(CATALOGUE.length <= 12, 'the list must stay short enough to scan');
    // And the aggregation is only safe because lining barely moves the answer.
    const spread = usableLitres(178, 44.2, 27.0, 15.4)! - usableLitres(172, 44.2, 27.0, 15.4)!;
    assert.ok(spread / usableLitres(175, 44.2, 27.0, 15.4)! < 0.05,
        'lining choice must stay a rounding error');
});

test('a picked catalogue tank comes back with the litres the catalogue says', () => {
    const choice = cleanTankChoice({tankId: 'vpb200', inletC: 8}, CATALOGUE)!;
    assert.deepEqual(choice, {tankId: 'vpb200', litres: 175, inletC: 8});
    // The view cannot smuggle in its own litre figure for a known tank.
    assert.equal(cleanTankChoice({tankId: 'vpb200', litres: 9999}, CATALOGUE)!.litres, 175);
});

test('declining is the default, and an unknown id declines rather than being trusted', () => {
    assert.deepEqual(cleanTankChoice({tankId: 'none'}, CATALOGUE), {tankId: 'none', litres: null});
    // The pairing view is untrusted input, and there is no safe unattended answer: the app cannot
    // work the volume out for itself, so an id it does not recognise means no estimate.
    assert.deepEqual(cleanTankChoice({tankId: 'vpb_from_mars', litres: 400}, CATALOGUE),
        {tankId: 'none', litres: null});
});

test('a custom volume is accepted only inside the range the model can use', () => {
    assert.equal(cleanTankChoice({tankId: 'custom', litres: 300}, CATALOGUE)!.litres, 300);
    for (const litres of [0, 10, 5000, -300, NaN, 'lots'])
        assert.equal(cleanTankChoice({tankId: 'custom', litres}, CATALOGUE)!.tankId, 'none',
            `${litres} L should not be accepted as a tank size`);
});

// THE REGRESSION TEST. cleanSelection() is a whitelist and applySelection() overwrites the whole
// stored selection with its output, so anything it forgets to copy is destroyed. A user who picked
// their tank at pairing and later opened Repair to tick one box about cooling would have lost it.
test('a tank picked at pairing survives a Repair that never mentions it', () => {
    const atPairing = cleanTankChoice({tankId: 'vpb300', inletC: 12}, CATALOGUE)!;
    assert.deepEqual(cleanTankChoice(atPairing, CATALOGUE), atPairing);
    assert.equal(atPairing.litres, 276);
});

test('a device that never picked a tank stays undefined rather than gaining one', () => {
    assert.equal(cleanTankChoice(undefined, CATALOGUE), undefined);
    assert.equal(cleanTankChoice(null, CATALOGUE), undefined);
});

// The inlet is no longer asked for, so an absent value must stay ABSENT rather than being
// defaulted: the device treats a stored inletC as an explicit override, and defaulting one here
// would permanently suppress the learned figure.
test('no inlet is stored unless one was genuinely given', () => {
    for (const inletC of [40, 55, -5, NaN, undefined, 'cold'])
        assert.equal('inletC' in cleanTankChoice({tankId: 'none', inletC}, CATALOGUE)!, false,
            `inlet ${inletC} should be dropped, not defaulted`);
    assert.equal(cleanTankChoice({tankId: 'none', inletC: 0}, CATALOGUE)!.inletC, 0);
    assert.equal(cleanTankChoice({tankId: 'none', inletC: 15}, CATALOGUE)!.inletC, 15);
});

// ---------------------------------------------------------------------------------------
// Learning the cold-water inlet
// ---------------------------------------------------------------------------------------

test('the inlet is the low-water mark of the lower sensor across the window', () => {
    const day = 1000;
    assert.equal(learnedInletC(
        [{day: day - 2, minC: 14.2}, {day: day - 1, minC: 11.5}, {day, minC: 13.0}], day), 11.5);
});

test('days outside the window stop counting, so a warmer supply can push it back up', () => {
    const day = 1000;
    assert.equal(learnedInletC(
        [{day: day - 60, minC: 4.0}, {day: day - 2, minC: 15.0}, {day: day - 1, minC: 16.0}], day),
        15.0, 'the 60-day-old winter low must have aged out');
});

// Counter-intuitive and worth pinning down, because the first version assumed the opposite. V40
// scales as (T − inlet)/(40 − inlet), so raising the inlet shrinks the denominator faster than the
// numerator and the estimate goes UP. The observed minimum is at or above the true inlet, so the
// bias is optimistic — which is why the upper clamp is load-bearing, not a sanity check.
test('over-estimating the inlet inflates the answer, so the clamp matters', () => {
    assert.ok(usableLitres(175, 56, 38, 12)! > usableLitres(175, 56, 38, 8)!);
    assert.equal(learnedInletC([{day: 1, minC: 22}], 1), null,
        'a tank that is never drawn down is not reporting the mains');
    assert.equal(learnedInletC([{day: 1, minC: 19}], 1), 19, 'a plausible mains figure is kept');
    assert.equal(learnedInletC([{day: 1, minC: -3}], 1), null);
    assert.equal(learnedInletC([], 1), null, 'no data means no answer, not a guess');
});

test('a day boundary is a whole number of days apart', () => {
    const noon = new Date(2026, 5, 15, 12, 0, 0).getTime();
    assert.equal(dayNumber(noon + 86_400_000) - dayNumber(noon), 1);
    assert.equal(dayNumber(noon + 3_600_000), dayNumber(noon), 'an hour later is the same day');
});

test('the default inlet is NIBE\'s own 10 °C', () => {
    assert.equal(DEFAULT_INLET_C, 10);
    assert.equal(usableLitres(175, 50, 50), usableLitres(175, 50, 50, 10));
    assert.equal(MIX_C, 40);
});

// ---------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------

const PICKED = {tankId: 'vpb200', litres: 175};

// A device that predates the feature must NOT sprout a blank capability on an app update, and one
// whose owner declined must not either.
test('the capability requires a chosen tank', () => {
    for (const selection of [null, {groups: {}, overrides: {}},
                             {groups: {}, overrides: {}, hotwater: {tankId: 'none', litres: null}}])
        assert.equal(
            extraCapabilities(sProfile, 'hotwater', selection).includes(HOTWATER_VOLUME_CAPABILITY),
            false, 'no tank chosen means no volume, and without a volume there is no estimate');
    assert.ok(extraCapabilities(sProfile, 'hotwater',
        {groups: {}, overrides: {}, hotwater: PICKED}).includes(HOTWATER_VOLUME_CAPABILITY));
});

// The superset must keep it regardless, or a capability added later by syncCapabilities() would
// have no per-instance options and getCapabilityOptions() would throw "Invalid Capability".
test('the superset still lists it, so its options are always prepared', () => {
    assert.ok(possibleExtraCapabilities(sProfile, 'hotwater').includes(HOTWATER_VOLUME_CAPABILITY));
    assert.ok(extraCapabilityOptions('hotwater', HOTWATER_VOLUME_CAPABILITY)?.title);
});

test('the litres estimate lands on the hot water device and nowhere else', () => {
    for (const role of allRoles) {
        assert.equal(
            extraCapabilities(sProfile, role, {groups: {}, overrides: {}, hotwater: PICKED})
                .includes(HOTWATER_VOLUME_CAPABILITY), role === 'hotwater');
        assert.equal(possibleExtraCapabilities(sProfile, role).includes(HOTWATER_VOLUME_CAPABILITY),
            role === 'hotwater');
    }
});

test('the litres estimate follows the hot water group, not the energy group', () => {
    const off = (groups: any) =>
        extraCapabilities(sProfile, 'hotwater', {groups, overrides: {}, hotwater: PICKED})
            .includes(HOTWATER_VOLUME_CAPABILITY);
    // Its two sensors are hotwater registers, so switching hot water off must take it with them...
    assert.equal(off({hotwater: false}), false);
    // ...while switching the energy group off must not.
    assert.equal(off({hotwater: true, energy: false}), true);
    assert.equal(
        extraCapabilities(sProfile, 'hotwater',
            {groups: {hotwater: true}, overrides: {[HOTWATER_VOLUME_CAPABILITY]: false},
             hotwater: PICKED}).includes(HOTWATER_VOLUME_CAPABILITY), false);
});

test('a model that describes no tank gets no litres estimate at all', () => {
    const tankless = {...sProfile, hotwaterTank: undefined};
    assert.equal(extraCapabilities(tankless as any, 'hotwater',
        {groups: {}, overrides: {}, hotwater: PICKED}).includes(HOTWATER_VOLUME_CAPABILITY), false);
    assert.equal(
        possibleExtraCapabilities(tankless as any, 'hotwater').includes(HOTWATER_VOLUME_CAPABILITY),
        false);
});

// CLAUDE.md records that the app ships six languages, that both locale layers are at full parity,
// and that there is no automated check — so a key missing from de.json silently shows English.
test('every locale file carries exactly the same keys', () => {
    const dir = join(__dirname, '..', '.homeycompose', 'locales');
    const flatten = (value: any, prefix = ''): string[] =>
        typeof value === 'object' && value !== null && !Array.isArray(value)
            ? Object.entries(value).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k))
            : [prefix];
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
    assert.deepEqual(files.sort(), ['da.json', 'de.json', 'en.json', 'nl.json', 'no.json', 'sv.json'],
        'the app advertises six languages; all six must have a locale file');
    const reference = new Set(flatten(JSON.parse(readFileSync(join(dir, 'en.json'), 'utf8'))));
    for (const file of files) {
        const keys = new Set(flatten(JSON.parse(readFileSync(join(dir, file), 'utf8'))));
        assert.deepEqual([...reference].filter((k) => !keys.has(k)), [],
            `${file} is missing keys that en.json has`);
        assert.deepEqual([...keys].filter((k) => !reference.has(k)), [],
            `${file} has keys en.json does not`);
    }
});
