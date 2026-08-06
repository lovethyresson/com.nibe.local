import {Dir, Register} from '../../lib/registers';

// Enum maps + the S-series register table. The register types and pure helpers live in
// lib/registers.ts; the derived catalog (registerByName, pickerPrimary) is built by
// makeProfile() in profile.ts.

export const returnairMap = Object({
    0: "Normal",
    1: "Speed 1",
    2: "Speed 2",
    3: "Speed 3",
    4: "Speed 4"
});

export const priorityMap = Object({
    10: "Off",
    20: "Hot water",
    30: "Heating",
    40: "Pool",
    60: "Cooling"
});

// 3 is deliberately absent: Nibe's Modbus manual lists it as "not in use" for
// register 56, so the pump has no mode 3 to select.
export const hotwaterMap = Object({
    0: "Small",
    1: "Medium",
    2: "Large",
    4: "Smart control"
});

// Menu 2.1 "More hot water" (register 697). Nibe's Modbus manual (M12676EN) omits 697
// entirely, and the S1155 manual describes menu 2.1 as a fixed list ("Setting range: 3, 6
// and 12 hours, as well as the modes 'Off' and 'One-time increase'"), which made this look
// like an enum. It isn't — the register is far less constrained than the menu.
//
// Measured against the live S1155 on 2026-07-17: 697 is a plain count of *hours*. Writing
// N sets holding 225 ("More hot water, number of minutes") to N*60 and input 1078
// ("More hot water status") to 1. That holds for every N in 1..127 — including 24 and 48,
// which this pump's menu cannot even select, and odd values like 1, 4, 5, 47 and 100. The
// register is not validated against the menu list. 0 is Off. It is s8 on the wire, so 128+
// wraps negative and the pump reads it back as 0.
//
// Consequences for the labels below:
//   - 2 is a *2-hour* boost. It was previously labelled "1h", which was simply wrong.
//   - No raw value means "One-time increase"; the whole 1..127 space is hour counts,
//     leaving no room for a sentinel, so that mode is unreachable through this register.
// The map is therefore a curated picker of useful durations, not the register's domain.
// Any 1..127 is legal if more are ever wanted.
export const onetimeincreaseMap = Object({
    0: "Off",
    2: "2 hours",
    3: "3 hours",
    6: "6 hours",
    12: "12 hours",
    24: "24 hours",
    48: "48 hours"
});

export const booleanMap = Object({
    0: "Off",
    1: "On"
});

export const modeMap = Object({
    0: "Auto",
    1: "Manual",
    2: "Immersion heater only"
});

export const registers: Register[] = [
    // Rad 1 Temp
    // Outdoor temperature lives with heating rather than on Main. It is only ever interesting
    // against something heating owns — the heat curve it drives, and the outdoor average the
    // summer cut-off (184) compares against — and splitting the threshold from the temperature
    // it is judged by across two devices is what made that setting unreadable.
    {address:    1, name: "measure_temperature.i1_outside",         direction: Dir.In,  group: "heating",     scale:  10, // Aktuell utetemperatur (BT1)
     info: {en: "Current outdoor temperature (sensor BT1)", sv: "Aktuell utetemperatur (givare BT1)"}},
    // Indoor temperature has three candidate addresses that are NOT the same quantity, which is
    // why this uses `sources` (user picks) rather than `altAddresses` (detection picks silently):
    //   116 — "Room average temp. clim. system 1", the value that regulates. All six model CSVs
    //         agree this is climate system 1. Nibe's CSV titles it "(BT50)", which is legacy
    //         wording and wrong on zone firmware: the maintainer's S1155 has NO wired room
    //         sensor at all (26/25/24 all answer with a Modbus exception, and "Use room sensor
    //         CS1" reads 0), yet 116 reports a real, independently moving value — it is coming
    //         from the wireless room unit assigned to the zone. So don't say BT50 to the user.
    //   111 — "Room average temp. clim. system 6". This was the primary until 0.9.13, on the
    //         mistaken reading that the CSVs put BT50 there. On the maintainer's S1155 it returns
    //         the not-available sentinel, so the capability resolved to nothing at all.
    //    26 — "Roomsensor 1-1", one individual sensor rather than a system average. Listed on
    //         every model except the S735, where it is undocumented and yet the only one that
    //         answers (halderex, on both Modbus and MyUplink).
    // In a multi-zone house more than one of these is alive and they genuinely differ, so the
    // pump cannot decide — see docs/pairing.md. The band is 5..40 rather than something wider so
    // that a disconnected sensor reading a flat 0 is rejected instead of accepted as 0 °C.
    // The name is the BARE `measure_temperature`, not a `.iNN_` sub-capability, and that is
    // load-bearing rather than a style slip. Homey's Climate feature and its thermostat tile both
    // key on the root capability id: a device exposing only dotted temperatures is skipped by
    // Climate entirely, and the tile needs a matching root `measure_temperature` +
    // `target_temperature` pair — promote only one and it degrades into separate sensor rows
    // (halderex, measured on a Homey Pro; PR #5). Same reasoning as `measure_power` and
    // `alarm_generic`: an official root id is what makes Homey's own features see the device.
    //
    // The rename costs this capability's Insights history, which cannot be migrated — a log is
    // bound to the capability id that created it. `renamedRegisters` in profile.ts carries the
    // stored *selection* across, which is the part that would otherwise break a pump outright.
    {address:  116, name: "measure_temperature",                    direction: Dir.In,  group: "heating",     scale:  10, // Rumstemperatur (BT50) klimatsystem 1
     altPlausible: {min: 5, max: 40},
     sources: [
         {address: 116, label: {en: "Climate system 1 average — wired or wireless room sensors", sv: "Medelvärde klimatsystem 1 — trådade eller trådlösa rumsgivare"}},
         {address: 111, label: {en: "Climate system 6 average", sv: "Medelvärde klimatsystem 6"}},
         {address:  26, label: {en: "Room sensor 1-1 — one wired sensor only", sv: "Rumsgivare 1-1 — endast en trådad givare"}}
     ],
     info: {en: "Indoor temperature used to regulate climate system 1", sv: "Inomhustemperatur som reglerar klimatsystem 1"}},
    // Rad 2 Framledning
    {address: 1017, name: "measure_temperature.i1017_calculated_supply", direction: Dir.In, group: "heating", scale:  10, // Beräknad framledning klimatsystem 1
     info: {en: "Supply temperature the pump is aiming for (climate system 1)", sv: "Framledningstemperatur pumpen siktar på (klimatsystem 1)"}},
    {address:    5, name: "measure_temperature.i5_heating_supply",  direction: Dir.In,  group: "heating",     scale:  10, // Framledning (BT2) klimatsystem 1
     info: {en: "Actual heating supply line temperature (BT2)", sv: "Verklig framledningstemperatur (BT2)"}},
    // Rad 3
    {address:   11, name: "measure_degree_minutes_NIBE.h11_degree_minutes",   direction: Dir.Out, group: "heating", scale: 10, size: 32, noAction: true, // Gradminuter (s32)
     info: {en: "Accumulated heating deficit that decides when the compressor starts", sv: "Ackumulerat värmeunderskott som avgör när kompressorn startar"}},
    {address:    7, name: "measure_temperature.i7_heating_return",  direction: Dir.In,  group: "heating",     scale:  10, // Returledning (BT3)
     info: {en: "Heating return line temperature (BT3)", sv: "Returledningstemperatur (BT3)"}},
    // Rad 4
    // Relocated to 1636 on the S330/S332, which do not list 1102 at all (the S2125 and
    // S320/S325 list both). A percentage, so the band is the full 0..100 — 0 is a pump that
    // is simply not running, which is real data rather than a dead read.
    {address: 1102, name: "measure_percentage_NIBE.i1102_heating_pump",       direction: Dir.In, group: "heating",     scale: 1, // Värmebärarpumphastighet (GP1)
     altAddresses: [1636], altPlausible: {min: 0, max: 100},
     info: {en: "Heating medium pump speed (GP1)", sv: "Värmebärarpumpens hastighet (GP1)"}},
    {address: 1104, name: "measure_percentage_NIBE.i1104_source_pump",        direction: Dir.In, group: "groundsource", scale: 1, // Köldbärarpumphastighet (GP2)
     info: {en: "Brine pump speed (GP2)", sv: "Köldbärarpumpens hastighet (GP2)"}},
    // Rad 5
    {address:   10, name: "measure_temperature.i10_source_in",      direction: Dir.In,  group: "groundsource", scale: 10, // Köldbärare in (BT10)
     info: {en: "Brine temperature entering the pump (BT10)", sv: "Köldbärartemperatur in till pumpen (BT10)"}},
    {address:   11, name: "measure_temperature.i11_source_out",     direction: Dir.In,  group: "groundsource", scale: 10, // Köldbärare ut (BT11)
     info: {en: "Brine temperature leaving the pump (BT11)", sv: "Köldbärartemperatur ut från pumpen (BT11)"}},
    // Rad 6
    {address: 1028, name: "measure_enum_NIBE.i1028_priority",                 direction: Dir.In,  group: "core",       enum: priorityMap, // Prio
     info: {en: "What the pump is producing right now (heating, hot water, pool…)", sv: "Vad pumpen producerar just nu (värme, varmvatten, pool…)"}},
    // Same register 1028 as the enum above, kept as a raw number so it can be logged in
    // Insights (the enum is a string capability Homey can't chart). Hidden from the tile, and
    // `secondary` keeps it out of the pairing/repair lists too: it is one register with two
    // representations, and offering the user a separate "Priority (value)" row to tick is noise
    // about an implementation detail.
    {address: 1028, name: "measure_priority_NIBE.i1028_priority_value",       direction: Dir.In,  group: "core",       noAction: true, secondary: true, // Prio (raw)
     info: {en: "Raw operating-priority code (10 off, 20 hot water, 30 heating, 40 pool, 60 cooling), logged over time", sv: "Rå driftprioritetskod (10 av, 20 varmvatten, 30 värme, 40 pool, 60 kyla), loggas över tid"}},
    {address:   40, name: "measure_water.i40_flow_sensor",          direction: Dir.In,  group: "heating",     scale:  10, // Flödesgivare (BF1)
     info: {en: "Heating medium flow (sensor BF1)", sv: "Värmebärarflöde (givare BF1)"}},
    // Rad 7
    {address: 1048, name: "measure_watt_NIBE.i1048_compressor_add_power",     direction: Dir.In,  group: "energy", role: "main", scale: 1, // Kompressor tillförd effekt
     info: {en: "Electrical power drawn by the compressor", sv: "Eleffekt som kompressorn drar"}},
    {address: 2166, name: "measure_watt_NIBE.i2166_energy_usage",             direction: Dir.In,  group: "energy", role: "main", scale: 1, size: 32, // Momentan använd effekt (u32)
     info: {en: "Total electrical power used by the pump right now", sv: "Total eleffekt pumpen använder just nu"}},
    // Fallback power source for the energy allocator on models with no 2166 — it does not
    // exist on S320/S325, S330/S332 or S2125, and without a power reading the allocator is
    // skipped entirely, leaving every per-function meter and COP permanently empty.
    //
    // `internal`: the allocator already republishes its power source as `measure_power`, so
    // this must not become a third visible copy of the same number on models that have both.
    // Verified against a live S1155 (2026-07-28) alongside 2166 over a hot-water cycle: it is
    // an *averaged* reading, so it lags on the compressor ramp (920 W vs 1621 W) and overruns
    // on the way down — but the integral is what the allocator uses, and over the run that came
    // to 0.1293 kWh against 2166's 0.1311 kWh (1.4%). The CSV's "kWh" unit is wrong: this is
    // kW/100, hence scale 0.1, exactly like 1027 below.
    //
    // Register 2727 "Current power" was the other candidate and is NOT usable: it answered
    // every read but sat at a flat zero through a 3.3 kW compressor run, tracking the EME 20
    // accessory registers (2176/2178) rather than the pump.
    {address: 2305, name: "measure_watt_NIBE.i2305_energylog_power",          direction: Dir.In,  group: "energy", role: "main", scale: 0.1, size: 32, internal: true, // Energilogg momentan förbrukning
     info: {en: "Total electrical power used by the pump right now (energy log, averaged)", sv: "Total eleffekt pumpen använder just nu (energilogg, medelvärde)"}},
    // Rad 8
    {address: 1047, name: "measure_temperature.i1047_inverter",     direction: Dir.In,  group: "diagnostics", scale:  10, // Invertertemperatur
     info: {en: "Temperature of the compressor inverter", sv: "Temperatur på kompressorns inverter"}},
    {address: 1046, name: "measure_frequency.i1046_compressor",     direction: Dir.In,  group: "diagnostics", scale:  10, // Kompressorfrekvens, aktuell
     info: {en: "Current compressor speed", sv: "Aktuell kompressorfrekvens"}},
    // Rad 9
    {address:    8, name: "measure_temperature.i8_warmwater_top",   direction: Dir.In,  group: "hotwater",    scale:  10, // Varmvatten topp (BT7)
     info: {en: "Hot water temperature at the top of the tank (BT7)", sv: "Varmvattentemperatur i toppen av tanken (BT7)"}},
    {address:    9, name: "measure_temperature.i9_hot_water",       direction: Dir.In,  group: "hotwater",    scale:  10, // Varmvatten laddning (BT6)
     info: {en: "Hot water charging temperature (BT6)", sv: "Varmvatten laddtemperatur (BT6)"}},
    // Rad 10 Frånluft
    {address:   19, name: "measure_temperature.i19_return_air",     direction: Dir.In,  group: "ventilation", scale:  10, // Frånluft (AZ10-BT20)
     info: {en: "Extract air temperature from the house (BT20)", sv: "Frånluftstemperatur från huset (BT20)"}},
    {address:   20, name: "measure_temperature.i20_supply_air",     direction: Dir.In,  group: "ventilation", scale:  10, // Avluft (AZ10-BT21)
     info: {en: "Exhaust air temperature after heat recovery (BT21)", sv: "Avluftstemperatur efter värmeåtervinning (BT21)"}},
    // Rad 11 Frånluft status
    // scale 100 is a unit conversion, not the register's factor (which is 1): the register
    // holds a 0..100 percentage, and Homey's official `fan_speed` expects a 0..1 fraction,
    // so dividing by 100 maps percent -> fraction. Don't "correct" this to 1 against the
    // open-source datasets — they'd read the raw percent and mis-scale the capability 100x.
    {address:  109, name: "fan_speed.h109_returnair_normal",                  direction: Dir.Out, group: "ventilation", scale: 100, min: 0, max: 1, // Frånluft fläkthastighet normal
     info: {en: "Normal speed of the exhaust air fan", sv: "Frånluftsfläktens normalhastighet"}},
    {address: 1037, name: "measure_enum_NIBE.i1037_return_fan_step",          direction: Dir.In,  group: "ventilation", enum: returnairMap, // Fläktläge 1 0-Normal Övrigt 1-4
     info: {en: "Currently active fan mode", sv: "Aktivt fläktläge"}},
    // Rad 12 Eltillsats
    // Nibe's title is "Operating mode internal add. heat" — a mode, not a step count. It was
    // mapped as "active steps", which was an invented meaning: the Swedish comment on this very
    // line already said driftläge. Exposed as a flag because that is the question a user has
    // ("is the immersion heater running?") and the mode's non-zero values are undocumented.
    {address: 1029, name: "boolean_NIBE.i1029_additive_heat_active",          direction: Dir.In,  group: "core",       bool: true, // Driftläge intern tillsats
     info: {en: "Whether the internal electric additional heat is running", sv: "Om den interna eltillsatsen är igång"}},
    // Incoming main fuse rating (A). Read-only info on the main device (replaces the old
    // static setting so it only appears there).
    {address:  103, name: "fuse_NIBE.h103_fuse",                              direction: Dir.Out, group: "core",       scale: 1, noAction: true, // Säkring inkommande (A)
     info: {en: "Incoming main fuse rating", sv: "Inkommande huvudsäkring"}},
    // 16-bit raw with scale 100 means the register carries hundredths of a kW (a multi-kW
    // value in watts wouldn't fit 16 bits), so scale 0.1 converts that to plain watts to
    // match the other measure_watt_NIBE power registers. Retyped off meter_power so it no
    // longer counts as a lifetime energy meter — it's an instantaneous power reading, and
    // keeping any meter_power.* on the main device would pollute Homey's Energy tab.
    // scale 0.1 is a unit conversion, not the register's factor (which is 100 across every
    // S-model): the raw value is in units of 0.01 kW, and this capability reports watts, so
    // raw / 0.1 == raw * 10 == watts. Don't "correct" this to 100 against the open-source
    // datasets — that would report kW into a watt capability (1000x low).
    {address: 1027, name: "measure_watt_NIBE.i1027_additive_effect",          direction: Dir.In,  group: "energy", role: "main", scale: 0.1, // Effekt intern tillsats
     info: {en: "Power from the internal electric additive heater", sv: "Effekt från intern eltillsats"}},
    // Rad 13 Eltillsats statistik
    {address: 1025, name: "measure_hour_NIBE.i1025_additive_usage_total",     direction: Dir.In,  group: "statistics", scale:  10, size: 32, // Total drifttid tillsats (s32)
     info: {en: "Total runtime of the additive heater", sv: "Total drifttid för tillsatsen"}},
    {address: 1069, name: "measure_hour_NIBE.i1069_additive_usage_hotwater",  direction: Dir.In,  group: "hotwater",   scale:  10, size: 32, // Total varmvatten drifttid tillsats (s32, tiondels timmar)
     info: {en: "Additive heater runtime spent on hot water", sv: "Tillsatsens drifttid för varmvatten"}},
    // Rad 14 Kompressor utomhus temp avg
    {address: 1083, name: "measure_count_NIBE.i1083_compressor_starts",       direction: Dir.In,  group: "statistics", scale: 1, size: 32, // Kompressorstarter (s32)
     info: {en: "Number of compressor starts", sv: "Antal kompressorstarter"}},
    // In "heating" rather than "statistics": this is the value register 184 is compared against,
    // so it belongs beside the setting it decides, not in a statistics list on another device.
    {address:   37, name: "measure_temperature.i37_outside_avg",    direction: Dir.In,  group: "heating",     scale:  10, // BT1 - Average outside temperature -Medeltemperatur (BT1)
     info: {en: "Average outdoor temperature — what the heating cut-off is judged against", sv: "Medelutetemperatur — det som värmestoppet jämförs mot"}},
    // Rad 15 Kompressor statistik
    {address: 1087, name: "measure_hour_NIBE.i1087_compressor_usage_total",   direction: Dir.In,  group: "statistics", scale: 1, size: 32, // Total drifttid kompressor (s32)
     info: {en: "Total compressor runtime", sv: "Total drifttid för kompressorn"}},
    // Lifetime cumulative energy counters (u32, tenths of a kWh). Deliberately a custom
    // meter_kwh_NIBE type, not Homey's meter_power: the function devices already report
    // consumption to the Energy tab via meter_power.total, so a second meter_power here
    // would double-count. These feed the derived total COP (production / consumption) on
    // the main device — see TOTAL_COP_CAPABILITY in roles.ts.
    {address: 3821, name: "meter_kwh_NIBE.i3821_total_production",            direction: Dir.In,  group: "energy", role: "main", scale: 10, size: 32, relative: true, // Tot. production
     info: {en: "Heat energy the pump has delivered since this device was added", sv: "Levererad värmeenergi sedan enheten lades till"}},
    {address: 3823, name: "meter_kwh_NIBE.i3823_total_consumption",           direction: Dir.In,  group: "energy", role: "main", scale: 10, size: 32, relative: true, // Tot. consumption
     info: {en: "Electricity the pump has consumed since this device was added", sv: "Elförbrukning sedan enheten lades till"}},
    // Per-function delivered energy (u32, tenths of kWh), shown since pairing like the
    // totals above. incl-additive for heating/hot water (fair for COP, which is charged the
    // additive heater's electricity too); pool/cooling only exist compressor-only. Each
    // lands on its function device via its group and, with that device's used energy from
    // the allocator, drives the device's rolling COP (see producedRegisterForRole).
    {address: 1577, name: "meter_kwh_NIBE.i1577_heating_produced",           direction: Dir.In,  group: "energy", role: "heating",  scale: 10, size: 32, relative: true, // Heating, incl. int. add.
     info: {en: "Heat energy delivered to heating (incl. electric additive)", sv: "Levererad värmeenergi till värme (inkl. eltillsats)"}},
    {address: 1575, name: "meter_kwh_NIBE.i1575_hotwater_produced",          direction: Dir.In,  group: "energy", role: "hotwater", scale: 10, size: 32, relative: true, // Hot water, incl. int. add.
     info: {en: "Heat energy delivered to hot water (incl. electric additive)", sv: "Levererad värmeenergi till varmvatten (inkl. eltillsats)"}},
    {address: 1581, name: "meter_kwh_NIBE.i1581_pool_produced",              direction: Dir.In,  group: "energy", role: "pool",     scale: 10, size: 32, relative: true, // Pool, compressor only
     info: {en: "Heat energy delivered to the pool", sv: "Levererad värmeenergi till poolen"}},
    {address: 1579, name: "meter_kwh_NIBE.i1579_cooling_produced",           direction: Dir.In,  group: "energy", role: "cooling",  scale: 10, size: 32, relative: true, // Cooling, compressor only
     info: {en: "Cooling energy delivered", sv: "Levererad kylenergi"}},

    // ---- The pump's own energy accounting (Nibe "Energy log") -------------------------------
    // All `internal`: polled and logged, never capabilities. These exist so the app can stop
    // *estimating* per-function energy and start reading what the pump itself booked — the
    // allocator was measured attributing 1.37 kWh to hot water on a day the pump's own counter
    // moved 1.00 kWh for the entire unit.
    //
    // CRITICAL: these report the PREVIOUS COMPLETED HOUR. They are static within the hour and
    // step at :00, so count the value when it steps and never difference it within the hour.
    //
    // The evidence, and its limits. On a live S1155: 2293 sat at 0.00 right through a hot-water
    // cycle, jumped to 1.99 at 08:00, held 1.99 for 59 minutes, then stepped to 0.13 at 09:00 —
    // sampled every 30 s. A later 3.5 h run polling every 5 s saw steps only at 10:00:13,
    // 11:00:11 and 12:00:09. Since the step logging is change-driven rather than scheduled, a
    // mid-hour update would have been logged with a mid-hour timestamp; none was.
    //
    // But that is one pump, one model, one cycle, and only four of these registers have ever
    // been *seen* to step (2283/2285/2291/2293). The additional-heat pair read a flat zero
    // throughout, and cooling/pool never answered at all, so their cadence is unobserved. The
    // change-driven logging keeps testing this claim for free: anything stepping at a timestamp
    // that is not :00 will say so.
    //
    // Separately established, and firmer: there is no current-HOUR variant. Every title
    // containing "hour" across all six model maps says "past hour", and Nibe's published symbol
    // list has no input registers in this range at all.
    //
    // Nibe's published register list has no input registers in this range at all (it predates
    // the block, as it predates 3821/3823), so the CSV titles and live observation are all the
    // documentation there is. div=100 -> scale 100.
    {address: 2283, name: "meter_kwh_NIBE.i2283_log_produced_heating",       direction: Dir.In,  group: "energy", role: "main", scale: 100, size: 32, internal: true, // Energy log - produced heating, past hour
     info: {en: "Heat delivered to heating in the last completed hour", sv: "Levererad värme till värme senaste hela timmen"}},
    {address: 2285, name: "meter_kwh_NIBE.i2285_log_produced_hotwater",      direction: Dir.In,  group: "energy", role: "main", scale: 100, size: 32, internal: true,
     info: {en: "Heat delivered to hot water in the last completed hour", sv: "Levererad värme till varmvatten senaste hela timmen"}},
    {address: 2287, name: "meter_kwh_NIBE.i2287_log_produced_pool",          direction: Dir.In,  group: "energy", role: "main", scale: 100, size: 32, internal: true,
     info: {en: "Heat delivered to the pool in the last completed hour", sv: "Levererad värme till poolen senaste hela timmen"}},
    {address: 2289, name: "meter_kwh_NIBE.i2289_log_produced_cooling",       direction: Dir.In,  group: "energy", role: "main", scale: 100, size: 32, internal: true,
     info: {en: "Cooling delivered in the last completed hour", sv: "Levererad kyla senaste hela timmen"}},
    {address: 2291, name: "meter_kwh_NIBE.i2291_log_used_heating",           direction: Dir.In,  group: "energy", role: "main", scale: 100, size: 32, internal: true,
     info: {en: "Electricity used for heating in the last completed hour", sv: "El använd till värme senaste hela timmen"}},
    {address: 2293, name: "meter_kwh_NIBE.i2293_log_used_hotwater",          direction: Dir.In,  group: "energy", role: "main", scale: 100, size: 32, internal: true,
     info: {en: "Electricity used for hot water in the last completed hour", sv: "El använd till varmvatten senaste hela timmen"}},
    {address: 2295, name: "meter_kwh_NIBE.i2295_log_used_pool",              direction: Dir.In,  group: "energy", role: "main", scale: 100, size: 32, internal: true,
     info: {en: "Electricity used for the pool in the last completed hour", sv: "El använd till poolen senaste hela timmen"}},
    {address: 2297, name: "meter_kwh_NIBE.i2297_log_used_cooling",           direction: Dir.In,  group: "energy", role: "main", scale: 100, size: 32, internal: true,
     info: {en: "Electricity used for cooling in the last completed hour", sv: "El använd till kyla senaste hela timmen"}},
    {address: 2299, name: "meter_kwh_NIBE.i2299_log_add_heating",            direction: Dir.In,  group: "energy", role: "main", scale: 100, size: 32, internal: true,
     info: {en: "Immersion heater energy used for heating in the last completed hour", sv: "Elpatronens energi till värme senaste hela timmen"}},
    {address: 2301, name: "meter_kwh_NIBE.i2301_log_add_hotwater",           direction: Dir.In,  group: "energy", role: "main", scale: 100, size: 32, internal: true,
     info: {en: "Immersion heater energy used for hot water in the last completed hour", sv: "Elpatronens energi till varmvatten senaste hela timmen"}},
    {address: 2303, name: "meter_kwh_NIBE.i2303_log_add_pool",               direction: Dir.In,  group: "energy", role: "main", scale: 100, size: 32, internal: true,
     info: {en: "Immersion heater energy used for the pool in the last completed hour", sv: "Elpatronens energi till poolen senaste hela timmen"}},

    // Compressor-only delivered energy, alongside the "including additional heat" counters
    // above. Mapped to test whether 3821 tracks compressor-only output: the per-function
    // counters overshoot it by +0.99% (S320) and +0.54% (S1155, which has neither cooling nor
    // pool), so cooling exclusion is not the explanation. Subtracting these from 1575/1577
    // also gives the additional-heat share per function.
    {address: 1583, name: "meter_kwh_NIBE.i1583_hotwater_produced_compressor", direction: Dir.In, group: "energy", role: "main", scale: 10, size: 32, internal: true,
     info: {en: "Heat delivered to hot water by the compressor alone", sv: "Levererad värme till varmvatten enbart från kompressorn"}},
    {address: 1585, name: "meter_kwh_NIBE.i1585_heating_produced_compressor",  direction: Dir.In, group: "energy", role: "main", scale: 10, size: 32, internal: true,
     info: {en: "Heat delivered to heating by the compressor alone", sv: "Levererad värme till värme enbart från kompressorn"}},
    {address: 1091, name: "measure_hour_NIBE.i1091_compressor_usage_hotwater",direction: Dir.In,  group: "hotwater",   scale: 1, size: 32, // Total drifttid kompressor varmvatten (s32)
     info: {en: "Compressor runtime spent on hot water", sv: "Kompressorns drifttid för varmvatten"}},
    // Rad 16 Värmekurvor
    {address:   26, name: "measure_count_NIBE.h26_heat_curve",                direction: Dir.Out, group: "heating",    scale: 1, min: 0, max: 15, // Värmekurva klimatsystem 1
     info: {en: "Heat curve slope for climate system 1", sv: "Värmekurvans lutning för klimatsystem 1"}},
    {address:   30, name: "measure_count_NIBE.h30_heat_curve_displacement",   direction: Dir.Out, group: "heating",    scale: 1, min: -10, max: 10, // Värmeförskjutning klimatsystem 1 RW
     info: {en: "Offset of the heat curve for climate system 1", sv: "Förskjutning av värmekurvan för klimatsystem 1"}},
    // Rad 16b Rumstemperatur (zoner)
    //
    // The indoor setpoint. This is the register the myUplink app writes when you set an indoor
    // temperature — verified on a live S1155 (fw 1036) by setting 35 °C then 28 °C in the iOS app
    // and sweeping all 2065 registers: 2505 was the only one of them to follow, both times.
    // Writing it drives real demand rather than just storing a number — after the change degree
    // minutes went -14.6 -> -339.1 and the compressor started.
    //
    // NOT registers 206/205/204/203 ("Room sensor set point value climate system N") or 55
    // ("External adjustment with room sensor"), which look like the obvious candidates and are
    // legacy on zone firmware: they sit at their factory default with "Use room sensor" off, and
    // holding 2503 "External setting for adjustment migrated" reads 1. Exposing them would give
    // the user a temperature control that silently does nothing.
    //
    // Nibe's CSVs title this family only `id:12801`..`id:12840` — holding 2505..2583, step 2,
    // s32 — which is why searching the register maps for "zone" finds nothing but the
    // `Zone N affected by ECS1` flags at 2119..2158. Those flags are how a zone is detected:
    // an unconfigured zone reads 0 here rather than its documented default of 20.
    //
    // The CSV documents min 50 / max 300 (5.0..30.0 °C) and is WRONG — the live register held
    // 350. Clamping to 30 would reject a setting the pump itself accepts, so the band is 5..35.
    //
    // WRITABLE — but only in one very specific shape, and getting that wrong looks exactly like a
    // read-only register. The pump ACKs every plausible write and silently discards all but a
    // two-word FC16 request assembled HIGH word first, the opposite of the order it reads in. See
    // writeRegisterValue() in lib/connection.ts for the measured matrix. Confirmed on two models:
    // halderex's S735 (PR #5) and the maintainer's S1155.
    //
    // This register was briefly shipped read-only on the strength of a test that tried FC6 and
    // FC16 low-word-first and concluded the pump refused writes. Three of the four shapes ACK, so
    // a partial matrix is indistinguishable from an unwritable register. If it ever looks inert
    // again, check the word order before concluding anything.
    //
    // Not register 206: that one accepts writes and the controller ignores them — a controlled
    // A/B/A experiment swung it 10 °C either side of the room temperature and moved neither the
    // calculated supply nor the degree-minute rate (dev/experiment-room-control.mjs).
    {address: 2505, name: "target_temperature",                                direction: Dir.Out, group: "heating",    scale: 10, size: 32, min: 5, max: 35,
     plausible: {min: 5, max: 35}, // Rumstemperatur börvärde zon 1
     info: {en: "The indoor temperature the pump aims for (menu 1.1, zone 1)", sv: "Inomhustemperaturen pumpen siktar på (meny 1.1, zon 1)"}},
    // Zones 2-40 exist at 2507..2583 (step 2, same shape) but are deliberately NOT mapped. A
    // setpoint on its own is not zone support: without per-zone temperatures and names it is a
    // row of anonymous sliders, and on a single-zone pump they all answer anyway (reading a flat
    // 0 rather than their documented default). Add them together with the rest of the zone model
    // or not at all.
    //
    // Smart Price Adaption. Worth having as a setting in its own right, and it is also the prime
    // suspect for why writes to the zone setpoint (2505) are accepted and then discarded: SPA
    // recomputes the indoor setpoint from the electricity price, so an external write is
    // overwritten by the pump's own controller within a poll — the same way register 11's degree
    // minutes are. `1918` is what SPA is doing right now, so the influence is visible rather than
    // mysterious.
    {address:  843, name: "boolean_NIBE.h843_spa_activated",                   direction: Dir.Out, group: "heating",    bool: true, // Aktiverad (Smart prisanpassning)
     info: {en: "Smart Price Adaption — shift consumption towards cheaper hours", sv: "Smart prisanpassning — flytta förbrukningen mot billigare timmar"}},
    {address:  845, name: "measure_count_NIBE.h845_spa_heating_influence",     direction: Dir.Out, group: "heating",    scale: 1, min: 1, max: 10, // Prisanpassning värme grad av påverkan
     info: {en: "How strongly the electricity price is allowed to move the indoor temperature (1-10)", sv: "Hur mycket elpriset får påverka inomhustemperaturen (1-10)"}},
    {address: 1918, name: "measure_count_NIBE.i1918_spa_status",              direction: Dir.In,  group: "heating",    scale: 1, noAction: true, // Driftläge (Smart prisanpassning)
     info: {en: "What Smart Price Adaption is doing right now", sv: "Vad smart prisanpassning gör just nu"}},
    // Why the setpoint above may appear to do nothing. On zone firmware this reads 0 and room
    // control runs through the zones; on older firmware it is what enables room-sensor
    // regulation at all. Read-only either way — writing it is the legacy path.
    {address:  202, name: "boolean_NIBE.h202_use_room_sensor",                direction: Dir.Out, group: "heating",    bool: true, noAction: true, // Använd rumsgivare klimatsystem 1
     info: {en: "Whether room sensor regulation is switched on for climate system 1", sv: "Om rumsgivarreglering är påslagen för klimatsystem 1"}},
    // Rad 17 Varmvatten
    {address:   56, name: "measure_enum_NIBE.h56_hotwater_demand_mode",       direction: Dir.Out, group: "hotwater",   enum: hotwaterMap, // Varmvatten behovsläge RW
     info: {en: "Hot water demand mode (small/medium/large/smart)", sv: "Varmvattnets behovsläge (litet/medel/stort/smart)"}},
    // "More hot water" quick action: on = raw 2, off = raw 0. Raw 2 is *2 hours*, not the
    // 1 hour this was labelled as before it was measured (see onetimeincreaseMap). Write
    // onValue: 1 instead if a 1-hour boost is what's actually wanted.
    // A sub-id `onoff.*` (a row toggle), not the bare `onoff` — the bare id is now the
    // device's derived Active state (the tile on/off follows operating priority for every
    // role device); the duration picker below is the secondary control for the same register.
    // The pump's "blocked" flags — polled, and now known NOT to answer the question they were
    // added for. Tested 2026-08-06 with a schedule actively blocking hot water and additional
    // heat: tank at 44.5 °C against a 52 °C start point, hot water permitted, pump idle at 10 W,
    // and all four of these read 0.
    //
    // So a schedule block (menu 6) really is invisible over Modbus — that is measured now, not
    // assumed, and this comment exists so nobody adds these again hoping otherwise. They stay
    // because they may still report something on an installation with a real external blocking
    // signal wired in, which this pump does not have.
    {address: 1058, name: "__blocked_external",                                      direction: Dir.In,  group: "core",      scale: 1, internal: true, // Extern blockering
     info: {en: "External blocking flag, function unconfirmed", sv: "Extern blockeringsflagga, funktion obekräftad"}},
    {address: 1059, name: "__blocked_1059",                                          direction: Dir.In,  group: "core",      scale: 1, internal: true, // Blockerad
     info: {en: "One of the pump's blocked flags, which function it covers is unconfirmed", sv: "En av värmepumpens blockeringsflaggor, vilken funktion den gäller är obekräftat"}},
    {address: 1131, name: "__blocked_1131",                                          direction: Dir.In,  group: "core",      scale: 1, internal: true, // Blockerad
     info: {en: "One of the pump's blocked flags, which function it covers is unconfirmed", sv: "En av värmepumpens blockeringsflaggor, vilken funktion den gäller är obekräftat"}},
    {address: 1132, name: "__blocked_1132",                                          direction: Dir.In,  group: "core",      scale: 1, internal: true, // Blockerad
     info: {en: "One of the pump's blocked flags, which function it covers is unconfirmed", sv: "En av värmepumpens blockeringsflaggor, vilken funktion den gäller är obekräftat"}},
    // Smart Price Adaptation and SG Ready, the two things that can make the pump ignore a hot
    // water start temperature it would otherwise act on. Added after a tank sat at 32 °C against
    // a 52 °C start point with the pump idle and nothing in the app able to say why: none of
    // these were read, so the app could show every setting as correct and still not explain the
    // behaviour.
    //
    // Value meanings beyond "0 = off" are not documented in the register map, so they are
    // exposed as plain numbers rather than invented enums.
    {address:  846, name: "measure_count_NIBE.h846_spa_hotwater",                    direction: Dir.Out, group: "hotwater",  scale: 1, min: 0, max: 4, // (SPA) varmvatten aktiverad
     info: {en: "Smart Price Adaptation for hot water. When on, the pump may let the tank cool well past its start temperature and charge later, when electricity is cheaper.", sv: "Smart prisanpassning för varmvatten. När den är på kan värmepumpen låta tanken svalna långt förbi starttemperaturen och ladda senare, när elen är billigare."}},
    {address:  902, name: "measure_count_NIBE.h902_spa_hotwater_influence",           direction: Dir.Out, group: "hotwater",  scale: 1, min: 1, max: 4, // (SPA) varmvatten påverkansgrad
     info: {en: "How strongly Smart Price Adaptation is allowed to shift hot water charging", sv: "Hur mycket smart prisanpassning får förskjuta varmvattenladdningen"}},
    {address: 1915, name: "measure_count_NIBE.i1915_spa_hotwater_mode",               direction: Dir.In,  group: "hotwater",  scale: 1, noAction: true, // Varmvattenkomfortläge (SPA)
     info: {en: "The hot water mode Smart Price Adaptation is currently imposing", sv: "Varmvattenläget som smart prisanpassning för tillfället tvingar fram"}},
    {address:  762, name: "boolean_NIBE.h762_hotwater_sg_ready",                      direction: Dir.Out, group: "hotwater",  bool: true, // Varmvatten (SG Ready)
     info: {en: "Whether SG Ready signals are allowed to affect hot water charging", sv: "Om SG Ready-signaler får påverka varmvattenladdningen"}},
    // The two registers 697 drives, polled but never shown: they are how we find out what the
    // pump writes when a one-time increase is started from its OWN menu 2.1.
    //
    // 697 is a plain hour count (1..127, 0 = off) — see the note on onetimeincreaseMap above —
    // which leaves no value meaning "one-time increase", the separate mode NIBE's menu offers
    // alongside the 3/6/12-hour durations. So every boost this app has ever triggered has been a
    // *timed* one, and the mode that is supposed to bring in the immersion heater may simply not
    // be reachable over Modbus. Watching 225 and 1078 while the pump starts one itself is what
    // settles that: if 697 lands on a value outside 1..127, the sentinel exists after all.
    {address:  225, name: "__more_hotwater_minutes",                                 direction: Dir.Out, group: "hotwater",  scale: 1, internal: true, // Mer varmvatten (antal minuter)
     info: {en: "Minutes of boost remaining, written by the pump when More hot water starts", sv: "Återstående minuter av höjningen, skrivs av värmepumpen när Mer varmvatten startar"}},
    {address: 1078, name: "__more_hotwater_status",                                  direction: Dir.In,  group: "hotwater",  scale: 1, internal: true, // Mer varmvatten status
     info: {en: "Whether a hot water boost is currently running, as the pump sees it", sv: "Om en varmvattenhöjning pågår, sett från värmepumpen"}},
    {address:  697, name: "boolean_NIBE.h697_more_hotwater",                         direction: Dir.Out, group: "hotwater",   bool: true, onValue: 2, offValue: 0, // Mer varmvatten engångshöjning
     info: {en: "More hot water: a one-time 2-hour boost", sv: "Mer varmvatten: en engångshöjning på 2 timmar"}},
    // Rad 18 Periodisk varmvatten höjning
    {address:   65, name: "measure_enum_NIBE.h65_periodic_hotwater",          direction: Dir.Out, group: "hotwater",   enum: booleanMap, // Periodisk varmvatten
     info: {en: "Periodic hot water boost on/off (status)", sv: "Periodisk varmvattenhöjning av/på (status)"}},
    {address:   66, name: "measure_day_NIBE.h66_periodic_hotwater_interval",  direction: Dir.Out, group: "hotwater",   scale: 1, min: 1, max: 90, // Periodiskt varmvatten intervall i dagar
     info: {en: "Days between periodic hot water boosts", sv: "Dagar mellan periodiska varmvattenhöjningar"}},
    // Rad 19 Periodtid varmvatten
    {address:   92, name: "measure_minute_NIBE.h92_periodtime_hotwater",      direction: Dir.Out, group: "hotwater",   scale: 1, min: 0, max: 180, // Periodtid varmvatten minuter
     info: {en: "Duration of the periodic hot water boost", sv: "Längd på den periodiska varmvattenhöjningen"}},
    // Rad 20 Strömförbrukning
    {address:   50, name: "measure_current.i50_sensor_v2",                    direction: Dir.In,  group: "electrical", scale: 10, size: 32, // Strömavkänare BE1 -L1 (u32)
     info: {en: "Current on phase L1 (sensor BE1)", sv: "Ström på fas L1 (givare BE1)"}},
    {address:   48, name: "measure_current.i48_sensor_v2",                    direction: Dir.In,  group: "electrical", scale: 10, size: 32, // Strömavkänare BE2 -L2 (u32)
     info: {en: "Current on phase L2 (sensor BE2)", sv: "Ström på fas L2 (givare BE2)"}},
    {address:   46, name: "measure_current.i46_sensor_v2",                    direction: Dir.In,  group: "electrical", scale: 10, size: 32, // Strömavkänare BE3 -L3 (u32)
     info: {en: "Current on phase L3 (sensor BE3)", sv: "Ström på fas L3 (givare BE3)"}},
    // Rad 21 Driftläge / pool
    {address:  237, name: "operating_mode_NIBE.h237_operating_mode",            direction: Dir.Out, group: "core",       enum: modeMap, picker: true, pickerValues: [0, 1, 2], // Driftläge
     info: {en: "Operating mode: auto, manual or additional heat only", sv: "Driftläge: auto, manuellt eller endast tillsats"}},
    {address:   27, name: "measure_temperature.i27_pool",           direction: Dir.In,  group: "pool",        scale:  10, // Pooltemperatur
     info: {en: "Pool water temperature", sv: "Poolens vattentemperatur"}},
    // Rad 22
    {address:   12, name: "measure_temperature.i12_heating_supply", direction: Dir.In,  group: "heating",     scale:  10, // Framledning BT12 värme och varmvatten
     info: {en: "Supply temperature after the condenser (BT12)", sv: "Framledning efter kondensorn (BT12)"}},
    {address:   13, name: "measure_temperature.i13_discharge",      direction: Dir.In,  group: "diagnostics", scale:  10, // Hetgas BT14
     info: {en: "Compressor discharge gas temperature (BT14)", sv: "Hetgastemperatur (BT14)"}},
    // Rad 23
    {address:   14, name: "measure_temperature.i14_liquid_line",    direction: Dir.In,  group: "diagnostics", scale:  10, // Vätskeledning BT15
     info: {en: "Refrigerant liquid line temperature (BT15)", sv: "Köldmediets vätskeledningstemperatur (BT15)"}},
    {address:   16, name: "measure_temperature.i16_suction_gas",    direction: Dir.In,  group: "diagnostics", scale:  10, // Suggas BT17
     info: {en: "Refrigerant suction gas temperature (BT17)", sv: "Köldmediets suggastemperatur (BT17)"}},
    // Writable on paper, but no source documents what its values mean, so it stays a
    // read-only insight rather than a control we can't label honestly.
    // Register 19 "Holiday function status" is deliberately not mapped. Nibe documents no value
    // mapping for it on any of the six models (s8, min=0 max=0 — their notation for "undocumented
    // range"), and nothing in the Home Assistant community documents one either. The only
    // observation we have is -1 on a live S1155 with holiday mode off, which is not enough to say
    // what any other value means. Shown as a raw count it was a number nobody could interpret.
    // Map it if and when someone reads it with holiday mode actually on.
    // Rad 24
    // Ej på värdedelen av appen

    // Poolvärme inställningar temp
    {address:  687, name: "target_temperature.h687_pool_start",               direction: Dir.Out, group: "pool",       scale: 10, min: 10, max: 35,
     info: {en: "Pool temperature where heating starts", sv: "Pooltemperatur där uppvärmning startar"}},
    {address:  689, name: "target_temperature.h689_pool_stop",                direction: Dir.Out, group: "pool",       scale: 10, min: 10, max: 35,
     info: {en: "Pool temperature where heating stops", sv: "Pooltemperatur där uppvärmning stoppar"}},

    // On / Off delar på kortet
    // On / Off Nattsvalka
    // Relocated to 2955 on the S2125 and S330/S332 (the S320/S325 list both). A 0/1 flag, so
    // the band admits exactly those two values; writes follow the resolved address too.
    {address:  227, name: "boolean_NIBE.h227_nightchill",                            direction: Dir.Out, group: "cooling",     bool: true, // Nattsvalka 1
     altAddresses: [2955], altPlausible: {min: 0, max: 1},
     info: {en: "Night cooling using the exhaust air fan", sv: "Nattsvalka med hjälp av frånluftsfläkten"}},
    // On / Off Periodiskt varmvatten
    {address:   65, name: "boolean_NIBE.h65_periodic_hotwater",                      direction: Dir.Out, group: "hotwater",   bool: true, // Periodisk varmvatten
     info: {en: "Enable the periodic hot water boost", sv: "Aktivera periodisk varmvattenhöjning"}},

    {address: 1828, name: "boolean_NIBE.i1828_pool_circulation",                     direction: Dir.In,  group: "pool",       bool: true, // Pool 1 pump status
     info: {en: "Whether the pool pump is circulating", sv: "Om poolpumpen cirkulerar"}},
    {address:  691, name: "onoff.h691_pool_active",                           direction: Dir.Out, group: "pool",       bool: true,
     info: {en: "Enable pool heating", sv: "Aktivera poolvärme"}},

    // Inställning värmekurva
    {address:   26, name: "curve_mode_NIBE.h26_heat_curve",                   direction: Dir.Out, group: "heating",    picker: true, pickerValues: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], // Värmekurva klimatsystem 1
     info: {en: "Selector for the heat curve slope (0–10)", sv: "Väljare för värmekurvans lutning (0–10)"}},
    {address:   30, name: "curve_displacement_NIBE.h30_heat_curve_displacement", direction: Dir.Out, group: "heating", picker: true, pickerValues: [-10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], // Värmeförskjutning klimatsystem 1 RW
     info: {en: "Selector for the heat curve offset (−10…+10)", sv: "Väljare för kurvförskjutning (−10…+10)"}},
    // Inställning varmvatten
    {address:   56, name: "hotwater_demand_NIBE.h56_hotwater_demand_mode",    direction: Dir.Out, group: "hotwater",   picker: true, pickerValues: [0, 1, 2, 4], // Varmvatten behovsläge RW 0 = small, 1 = medium, 2 = large, 3 = not in use, 4 = Smart control
     info: {en: "Selector for the hot water demand mode", sv: "Väljare för varmvattnets behovsläge"}},
    {address:  697, name: "hotwater_increase_NIBE.h697_onetimeincrease_hotwater", direction: Dir.Out, group: "hotwater", picker: true, pickerValues: [0, 2, 3, 6, 12, 24, 48], // Mer varmvatten engångshöjning 0 = Från, 2 = Engångshöjning, 3 = 3 timmar, 6 = 6 timmar, 12 = 12 timmar, 24 = timmar, 48 = 48 Timmar
     info: {en: "Selector for a one-time hot water boost", sv: "Väljare för engångshöjning av varmvatten"}},
        // Inställning Periodiskt varmvatten
    {address:   66, name: "hotwater_periodic_interval_NIBE.h66_periodic_hw_interval", direction: Dir.Out, group: "hotwater", picker: true, pickerValues: [7, 14, 21, 28], // Periodiskt varmvatten intervall i dagar
     info: {en: "Selector for days between periodic hot water boosts", sv: "Väljare för dagar mellan periodiska varmvattenhöjningar"}},
    {address:   92, name: "hotwater_periodtime_NIBE.h92_periodtime_hotwater", direction: Dir.Out, group: "hotwater",   picker: true, pickerValues: [30, 45, 60, 120], // Periodiskt varmvatten längd i minuter
     info: {en: "Selector for the periodic hot water boost duration", sv: "Väljare för den periodiska varmvattenhöjningens längd"}},

    // Setpoints and degree-minute tuning. Ranges are the maintainer's pump (an S1155) —
    // the hot water start/stop limits in particular differ on other S models (S320/S330/
    // S2125 allow up to 70 °C), and the pool/ventilation ranges below come from the manual
    // rather than hardware, since those accessories aren't docked here to check against.
    {address:   34, name: "target_temperature.h34_min_supply",                direction: Dir.Out, group: "heating",    scale: 10, min: 5, max: 80, // Min framledning klimatsystem 1
     info: {en: "Lowest supply temperature the pump may produce (climate system 1)", sv: "Lägsta framledningstemperatur pumpen får producera (klimatsystem 1)"}},
    {address:   38, name: "target_temperature.h38_max_supply",                direction: Dir.Out, group: "heating",    scale: 10, min: 5, max: 80, // Max framledning klimatsystem 1
     info: {en: "Highest supply temperature the pump may produce (climate system 1)", sv: "Högsta framledningstemperatur pumpen får producera (klimatsystem 1)"}},
    {address:  184, name: "target_temperature.h184_auto_stop_heating",        direction: Dir.Out, group: "heating",    scale: 10, min: -20, max: 40, // Auto: stopptemp värme
     info: {en: "Outdoor temperature where automatic mode stops heating", sv: "Utetemperatur där autoläget stoppar värmen"}},
    {address:  185, name: "target_temperature.h185_auto_stop_addition",       direction: Dir.Out, group: "heating",    scale: 10, min: -25, max: 40, // Auto: stopptemp tillsats
     info: {en: "Outdoor temperature where automatic mode stops the additive heater", sv: "Utetemperatur där autoläget stoppar tillsatsen"}},
    {address:   93, name: "measure_minute_NIBE.h93_periodtime_heating",       direction: Dir.Out, group: "heating",    scale: 1, min: 0, max: 180, // Periodtid värme
     info: {en: "How long the pump makes heating before switching demand", sv: "Hur länge pumpen gör värme innan den byter behov"}},
    {address:   97, name: "measure_degree_minutes_NIBE.h97_dm_start_compressor", direction: Dir.Out, group: "heating", scale: 1, min: -1000, max: -30, // Startgradminuter kompressor
     info: {en: "Degree minutes at which the compressor starts heating", sv: "Gradminuter då kompressorn startar värmen"}},
    // A difference from h97, not an absolute degree-minute value — hence the positive range.
    {address:  679, name: "measure_degree_minutes_NIBE.h679_dm_diff_start_addition", direction: Dir.Out, group: "heating", scale: 1, min: 100, max: 2000, // Gradminuter differens start tillsats
     info: {en: "How many degree minutes below the compressor start the additive heater joins in", sv: "Hur många gradminuter under kompressorstarten som tillsatsen går in"}},
    {address:   18, name: "measure_degree_minutes_NIBE.h18_limit_dm",         direction: Dir.Out, group: "heating",    scale: 10, min: -3000, max: 3000, // Gradminuter, begränsat värde
     info: {en: "Degree minutes limited to the range the pump regulates within", sv: "Gradminuter begränsade till intervallet pumpen reglerar inom"}},
    {address:   20, name: "measure_degree_minutes_NIBE.h20_cooling_dm",       direction: Dir.Out, group: "cooling",    scale: 10, min: -3000, max: 3000, // Gradminuter kyla
     info: {en: "Accumulated cooling surplus that decides when cooling starts", sv: "Ackumulerat kylöverskott som avgör när kylan startar"}},
    // Hot water start/stop come as three pairs, one per demand mode (register 56):
    // Small = low (60/64), Medium = normal (59/63), Large = high (58/62). The active mode
    // picks which pair the pump uses. All three are exposed so any mode is editable, and
    // ordered Small → Medium → Large so they read in that order in the UI.
    {address:   60, name: "target_temperature.h60_hotwater_start_small",      direction: Dir.Out, group: "hotwater",   scale: 10, min: 5, max: 55, // Start HW low (Small)
     info: {en: "Charging start temperature for the Small demand mode", sv: "Starttemperatur för behovsläget Litet"}},
    {address:   64, name: "target_temperature.h64_hotwater_stop_small",       direction: Dir.Out, group: "hotwater",   scale: 10, min: 5, max: 60, // Stop HW low (Small)
     info: {en: "Charging stop temperature for the Small demand mode", sv: "Stopptemperatur för behovsläget Litet"}},
    {address:   59, name: "target_temperature.h59_hotwater_start",            direction: Dir.Out, group: "hotwater",   scale: 10, min: 5, max: 60, // VV starttemperatur (Medium/normal)
     info: {en: "Charging start temperature for the Medium demand mode", sv: "Starttemperatur för behovsläget Medel"}},
    {address:   63, name: "target_temperature.h63_hotwater_stop",             direction: Dir.Out, group: "hotwater",   scale: 10, min: 5, max: 65, // VV stopptemperatur (Medium/normal)
     info: {en: "Charging stop temperature for the Medium demand mode", sv: "Stopptemperatur för behovsläget Medel"}},
    {address:   58, name: "target_temperature.h58_hotwater_start_large",      direction: Dir.Out, group: "hotwater",   scale: 10, min: 5, max: 70, // Start HW high (Large)
     info: {en: "Charging start temperature for the Large demand mode", sv: "Starttemperatur för behovsläget Stort"}},
    {address:   62, name: "target_temperature.h62_hotwater_stop_large",       direction: Dir.Out, group: "hotwater",   scale: 10, min: 5, max: 70, // Stop HW high (Large)
     info: {en: "Charging stop temperature for the Large demand mode", sv: "Stopptemperatur för behovsläget Stort"}},
    // Kept last, after all three demand modes. The flow-card autocompletes and the pairing lists
    // are ordered by this table, so a boost sitting between "start (Large)" and "stop (Large)"
    // broke the start/stop pairing the reader is following down the list.
    //
    // Nibe's setpoint for the *periodic* anti-legionella charge, and named only for that. It is
    // not what a manual "More hot water" boost aims at: this register read 60.0 while a boost
    // stopped at 58.1 °C.
    //
    // What a boost DOES target is most likely the Large (luxury) stop point — NIBE's manuals
    // describe menu 2.1 as temporarily raising the pump to luxury hot water, and say luxury uses
    // the immersion heater alongside the compressor. Our measurements cannot confirm it, because
    // additional heat for hot water is blocked on the test pump, so every boost ends at the
    // compressor's ceiling rather than at a setpoint: 53.4, 54.6, 55.0, then 58.1 with Large at
    // 58.0 and 58.6 with Large at 66.0. The second of those looks like a refutation and is not —
    // the ceiling binds first, so the test is simply silent.
    //
    // To settle it, set Large BELOW the ceiling (say 54) and run a boost: stopping there proves
    // the target, and unlike every attempt so far the compressor can definitely reach it.
    //
    // Its floor is 55 °C, and the top of its 55..70 range needs the immersion heater — which is
    // exactly what the periodic charge is for.
    {address:   61, name: "target_temperature.h61_hotwater_stop_periodic",    direction: Dir.Out, group: "hotwater",   scale: 10, min: 55, max: 70, // Stopptemp. VV periodisk höjning
     info: {en: "Stop temperature for the periodic anti-legionella hot water charge. Reaching it usually needs the immersion heater — a compressor alone tops out in the high 50s, and lower still when the ground loop is cold.",
            sv: "Stopptemperatur för den periodiska legionellakörningen. För att nå den behövs oftast elpatronen — en kompressor ensam når knappt 60 °C, och lägre än så när köldbärarkretsen är kall."}},
    {address:   94, name: "measure_minute_NIBE.h94_periodtime_pool",          direction: Dir.Out, group: "pool",       scale: 1, min: 0, max: 180, // Periodtid pool
     info: {en: "How long the pump heats the pool before switching demand", sv: "Hur länge pumpen värmer poolen innan den byter behov"}},

    // Alarm handling. h22 is a command: write 1 to acknowledge, it reads back 0.
    {address:   22, name: "button.h22_reset_alarm",                           direction: Dir.Out, group: "alarm",      bool: true, writeOnly: true, noAction: true, // Återställ larm
     info: {en: "Acknowledge and reset an active alarm on the pump", sv: "Kvittera och återställ ett aktivt larm på pumpen"}},
    // Registers 196/197 ("on an alarm, lower the room / hot water temperature") are deliberately
    // not mapped. They are install-time pump configuration that fires only during a fault, so
    // they earn a permanent row in every user's pairing list for something nobody automates.
    // Set them on the pump if you want them.

    // The immersion/electric additive heater is a shared resource — it serves heating and
    // hot water (and electric pool assist), so its on/off lives on "main" alongside the
    // additive step (i1029) and power (i1027) readouts, not on the heating device. The
    // per-function permits below (h181 heating, h182 cooling) stay with their function.
    // On Main, with the immersion heater's own readouts, because its true scope is unverified.
    // Nibe titles it "Permit additional heat, HEATING", but Nibe titles have been wrong before
    // (116 is labelled BT50 and is not), and the pump's schedule modes carry a *global* "Block
    // additional heat" alongside "Block compressor" and "Hot water" — so the setting that really
    // governs the immersion is not per-function at all.
    //
    // What is known: 180 read 1 throughout a year in which a schedule had additional heat
    // blocked, so 180 is NOT what the schedule writes; they are separate mechanisms. Whether 180
    // also gates hot water could not be tested, since the immersion is never called for heating
    // in summer. Main claims less than Heating does.
    {address:  180, name: "boolean_NIBE.h180_enable_addition",                       direction: Dir.Out, group: "core",       bool: true, // Tillåt tillsats
     info: {en: "Nibe's permit for additional heat, which they label as heating-only. Note the pump's own schedule modes carry a separate, global \"block additional heat\" that this cannot see or override.", sv: "Nibes tillstånd för tillsatsvärme, som de märker som endast värme. Observera att värmepumpens schemalägen har en egen, global \"blockera tillsatsvärme\" som den här inte ser eller kan åsidosätta."}},
    {address:  181, name: "onoff.h181_enable_heating",                        direction: Dir.Out, group: "heating",    bool: true, // Tillåt värme
     info: {en: "Allow heating operation", sv: "Tillåt värmedrift"}},
    {address:  182, name: "onoff.h182_enable_cooling",                        direction: Dir.Out, group: "cooling",    bool: true, // Tillåt kyla
     info: {en: "Allow cooling operation", sv: "Tillåt kyldrift"}},
    // Master hot-water permit (Nibe's own on/off for hot water). OFF disables ALL hot
    // water: the pump then blocks the demand-mode (56) and "More hot water" (697) registers
    // entirely (Modbus "Illegal Function" on read and write), so the boost can't be used
    // either. For "auto off, manual boost only" keep this ON and set the active mode's start
    // temperature very low instead.
    {address:  195, name: "onoff.h195_enable_hotwater",                       direction: Dir.Out, group: "hotwater",   bool: true, // Tillåt varmvatten
     info: {en: "Allow hot water. Off disables all hot water, including the More hot water boost", sv: "Tillåt varmvatten. Av stänger av allt varmvatten, även engångshöjningen"}},

    // ---- Offer-all expansion (specs verified against yozik04 s1155_s1255.csv) ----
    // Alarm code (0 = no alarm), a read-only insight beside the reset/alarm-action controls.
    // The pump's alarm *number*. Deliberately mapped to the string `alarm_text_NIBE` rather
    // than a numeric capability: the device turns the code into text via lib/alarms.ts (and
    // also drives the derived `alarm_generic` flag), and a numeric capability would make Homey
    // auto-generate "Alarm code becomes greater/less than" flow triggers, which are meaningless
    // for an unordered fault code. `noAction` because it is read-only.
    {address: 1975, name: "alarm_text_NIBE",                                  direction: Dir.In,  group: "alarm",       noAction: true, // Alarm number
     info: {en: "Active alarm code (0 = no alarm)", sv: "Aktiv larmkod (0 = inget larm)"}},
    // Compressor running status (read-only on/off).
    {address: 1100, name: "boolean_NIBE.i1100_compressor_status",                    direction: Dir.In,  group: "diagnostics", bool: true, // Compressor status
     info: {en: "Whether the compressor is running", sv: "Om kompressorn är igång"}},
    // External pulse energy meter BE6 — only present if such a meter is wired to the pump.
    // Relocated to 396 on the S320/S325. A meter that has counted nothing yet genuinely reads
    // 0, so the band includes it — unlike the room sensor, 0 here is data, not a dead read.
    {address:  398, name: "meter_kwh_NIBE.i398_pulse_energy",                 direction: Dir.In,  group: "electrical",  scale: 100, size: 32, // Pulse energy meter (BE6)
     altAddresses: [396], altPlausible: {min: 0, max: 1_000_000},
     info: {en: "Energy counted by an external pulse meter (BE6)", sv: "Energi räknad av extern pulsmätare (BE6)"}},
    // Photovoltaic / self-consumption accessory (EME 20), on its own `solarpanel`-class
    // device. Mapped to Homey's official energy capabilities so it reports generation to the
    // Energy tab: measure_power = current generation (W), meter_power.solar = cumulative
    // generation (declared as exported via setEnergy). Both read 0 without the accessory.
    {address: 2176, name: "measure_power",                                    direction: Dir.In,  group: "solar",       scale: 1, size: 32, // Current power (EME 20)
     info: {en: "Solar power generated right now (EME 20)", sv: "Soleffekt som genereras just nu (EME 20)"}},
    {address: 2180, name: "meter_power.solar",                                direction: Dir.In,  group: "solar",       scale: 10, size: 32, relative: true, // Total energy (EME 20)
     info: {en: "Solar energy generated since this device was added (EME 20)", sv: "Genererad solenergi sedan enheten lades till (EME 20)"}},
    // Hot water circulation accessory (BT70/BT82/BT83 + GP11). Absent → reads except/0.
    {address:   87, name: "measure_temperature.i87_outgoing_hotwater",  direction: Dir.In, group: "hotwater", scale: 10, // Outgoing hot water (BT70)
     info: {en: "Outgoing hot water temperature (BT70)", sv: "Utgående varmvattentemperatur (BT70)"}},
    {address:  174, name: "measure_temperature.i174_hw_comfort_return", direction: Dir.In, group: "hotwater", scale: 10, // Hot water comfort return (BT82)
     info: {en: "Hot water circulation return temperature (BT82)", sv: "Returtemperatur varmvattencirkulation (BT82)"}},
    {address:  175, name: "measure_temperature.i175_hw_comfort_heater", direction: Dir.In, group: "hotwater", scale: 10, // Hot water comfort heater (BT83)
     info: {en: "Hot water comfort heater temperature (BT83)", sv: "Temperatur varmvattenkomfortvärmare (BT83)"}},
    {address: 1063, name: "boolean_NIBE.i1063_hw_circulation",                       direction: Dir.In,  group: "hotwater",    bool: true, // Hot water circulation (GP11)
     info: {en: "Whether the hot water circulation pump is running", sv: "Om varmvattencirkulationspumpen är igång"}},
    // Auto-mode cooling start temperature (sibling of h184/h185); holding register 183.
    {address:  183, name: "target_temperature.h183_auto_start_cooling",       direction: Dir.Out, group: "cooling",     scale: 10, min: -20, max: 40, // Auto mode, start temp cooling
     info: {en: "Outdoor temperature where automatic mode starts cooling", sv: "Utetemperatur där autoläget startar kylan"}}
];

