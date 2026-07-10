export enum Dir {
    In,
    Out
}

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

export const hotwaterMap = Object({
    0: "Small",
    1: "Medium",
    2: "Large",
    4: "Smart control"
});

export const onetimeincreaseMap = Object({
    0: "Off",
    2: "One-time increase 1h",
    3: "One-time increase 3h",
    6: "One-time increase 6h",
    12: "One-time increase 12h",
    24: "One-time increase 24h",
    48: "One-time increase 48h"
});

export const booleanMap = Object({
    0: "Off",
    1: "On"
});

export const modeMap = Object({
    0: "Auto",
    1: "Manual",
    2: "Additional heat only"
});

// Feature groups a register can belong to. "core" is always enabled; the rest are
// toggled by the user during pairing/repair (see driver.ts) with recommendations
// from detection.ts.
export const groupIds = [
    "heating",
    "hotwater",
    "pool",
    "cooling",
    "ventilation",
    "groundsource",
    "electrical",
    "diagnostics",
    "statistics"
] as const;

export type GroupId = typeof groupIds[number] | "core";

export interface RegisterInfo {
    en: string;
    sv: string;
}

export interface Register  {
    address: number;
    name: string;
    direction: Dir;
    group: GroupId;
    info: RegisterInfo;
    scale?: number
    enum?: Record<number, string>
    bool?: boolean;
    picker?: boolean;
    noAction?: boolean;
    min?: number;
    max?: number;
}

export const registers: Register[] = [
    // Rad 1 Temp
    {address:    1, name: "measure_temperature.i1_outside",         direction: Dir.In,  group: "core",        scale:  10, // Aktuell utetemperatur (BT1)
     info: {en: "Current outdoor temperature (sensor BT1)", sv: "Aktuell utetemperatur (givare BT1)"}},
    {address:   26, name: "measure_temperature.i26_inside",         direction: Dir.In,  group: "heating",     scale:  10, // Rumsensor 1 inomhus
     info: {en: "Indoor temperature from room sensor 1 (BT50)", sv: "Inomhustemperatur från rumsgivare 1 (BT50)"}},
    // Rad 2 Framledning
    {address: 1017, name: "measure_temperature.i1017_calculated_supply", direction: Dir.In, group: "heating", scale:  10, // Beräknad framledning klimatsystem 1
     info: {en: "Supply temperature the pump is aiming for (climate system 1)", sv: "Framledningstemperatur pumpen siktar på (klimatsystem 1)"}},
    {address:    5, name: "measure_temperature.i5_heating_supply",  direction: Dir.In,  group: "heating",     scale:  10, // Framledning (BT2) klimatsystem 1
     info: {en: "Actual heating supply line temperature (BT2)", sv: "Verklig framledningstemperatur (BT2)"}},
    // Rad 3
    {address:   11, name: "measure_degree_minutes_NIBE.h11_degree_minutes",   direction: Dir.Out, group: "heating", scale: 10, noAction: true, // Gradminuter
     info: {en: "Accumulated heating deficit that decides when the compressor starts", sv: "Ackumulerat värmeunderskott som avgör när kompressorn startar"}},
    {address:    7, name: "measure_temperature.i7_heating_return",  direction: Dir.In,  group: "heating",     scale:  10, // Returledning (BT3)
     info: {en: "Heating return line temperature (BT3)", sv: "Returledningstemperatur (BT3)"}},
    // Rad 4
    {address: 1102, name: "measure_percentage_NIBE.i1102_heating_pump",       direction: Dir.In, group: "heating",     scale: 1, // Värmebärarpumphastighet (GP1)
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
    {address:   40, name: "measure_water.i40_flow_sensor",          direction: Dir.In,  group: "heating",     scale:  10, // Flödesgivare (BF1)
     info: {en: "Heating medium flow (sensor BF1)", sv: "Värmebärarflöde (givare BF1)"}},
    // Rad 7
    {address: 1048, name: "measure_watt_NIBE.i1048_compressor_add_power",     direction: Dir.In,  group: "core",       scale: 1, // Kompressor tillförd effekt
     info: {en: "Electrical power drawn by the compressor", sv: "Eleffekt som kompressorn drar"}},
    {address: 2166, name: "measure_watt_NIBE.i2166_energy_usage",             direction: Dir.In,  group: "core",       scale: 1, // Momentan använd effekt
     info: {en: "Total electrical power used by the pump right now", sv: "Total eleffekt pumpen använder just nu"}},
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
    {address:  109, name: "fan_speed.h109_returnair_normal",                  direction: Dir.Out, group: "ventilation", scale: 100, min: 0, max: 1, // Frånluft fläkthastighet normal
     info: {en: "Normal speed of the exhaust air fan", sv: "Frånluftsfläktens normalhastighet"}},
    {address: 1037, name: "measure_enum_NIBE.i1037_return_fan_step",          direction: Dir.In,  group: "ventilation", enum: returnairMap, // Fläktläge 1 0-Normal Övrigt 1-4
     info: {en: "Currently active fan mode", sv: "Aktivt fläktläge"}},
    // Rad 12 Eltillsats
    {address: 1029, name: "measure_count_NIBE.i1029_additive_heat_steps",     direction: Dir.In,  group: "core",       scale: 1, // Driftläge intern tillsats
     info: {en: "Active steps of the internal electric additive heater", sv: "Aktiva steg för intern eltillsats"}},
    // 16-bit raw with scale 100 means the register carries hundredths of a kW (a multi-kW
    // value in watts wouldn't fit 16 bits), so scale 0.1 converts that to plain watts to
    // match the other measure_watt_NIBE power registers. Retyped off meter_power so it no
    // longer counts as a lifetime energy meter — it's an instantaneous power reading, and
    // keeping any meter_power.* on the main device would pollute Homey's Energy tab.
    {address: 1027, name: "measure_watt_NIBE.i1027_additive_effect",          direction: Dir.In,  group: "core",       scale: 0.1, // Effekt intern tillsats
     info: {en: "Power from the internal electric additive heater", sv: "Effekt från intern eltillsats"}},
    // Rad 13 Eltillsats statistik
    {address: 1025, name: "measure_hour_NIBE.i1025_additive_usage_total",     direction: Dir.In,  group: "statistics", scale:  10, // Total drifttid tillsats
     info: {en: "Total runtime of the additive heater", sv: "Total drifttid för tillsatsen"}},
    {address: 1069, name: "measure_hour_NIBE.i1069_additive_usage_hotwater",  direction: Dir.In,  group: "hotwater",   scale:  10, // Total varmvatten drifttid tillsats
     info: {en: "Additive heater runtime spent on hot water", sv: "Tillsatsens drifttid för varmvatten"}},
    // Rad 14 Kompressor utomhus temp avg
    {address: 1083, name: "measure_count_NIBE.i1083_compressor_starts",       direction: Dir.In,  group: "statistics", scale: 1, // Kompressorstarter
     info: {en: "Number of compressor starts", sv: "Antal kompressorstarter"}},
    {address:   37, name: "measure_temperature.i37_outside_avg",    direction: Dir.In,  group: "statistics",  scale:  10, // BT1 - Average outside temperature -Medeltemperatur (BT1)
     info: {en: "Average outdoor temperature (BT1)", sv: "Medelutetemperatur (BT1)"}},
    // Rad 15 Kompressor statistik
    {address: 1087, name: "measure_hour_NIBE.i1087_compressor_usage_total",   direction: Dir.In,  group: "statistics", scale: 1, // Total drifttid kompressor
     info: {en: "Total compressor runtime", sv: "Total drifttid för kompressorn"}},
    {address: 1091, name: "measure_hour_NIBE.i1091_compressor_usage_hotwater",direction: Dir.In,  group: "hotwater",   scale: 1, // Total drifttid kompressor varmvatten
     info: {en: "Compressor runtime spent on hot water", sv: "Kompressorns drifttid för varmvatten"}},
    // Rad 16 Värmekurvor
    {address:   26, name: "measure_count_NIBE.h26_heat_curve",                direction: Dir.Out, group: "heating",    scale: 1, min: 0, max: 10, // Värmekurva klimatsystem 1
     info: {en: "Heat curve slope for climate system 1", sv: "Värmekurvans lutning för klimatsystem 1"}},
    {address:   30, name: "measure_count_NIBE.h30_heat_curve_displacement",   direction: Dir.Out, group: "heating",    scale: 1, min: -10, max: 10, // Värmeförskjutning klimatsystem 1 RW
     info: {en: "Offset of the heat curve for climate system 1", sv: "Förskjutning av värmekurvan för klimatsystem 1"}},
    // Rad 17 Varmvatten
    {address:   56, name: "measure_enum_NIBE.h56_hotwater_demand_mode",       direction: Dir.Out, group: "hotwater",   enum: hotwaterMap, // Varmvatten behovsläge RW
     info: {en: "Hot water demand mode (small/medium/large/smart)", sv: "Varmvattnets behovsläge (litet/medel/stort/smart)"}},
    {address:  697, name: "measure_enum_NIBE.h697_onetimeincrease_hotwater",  direction: Dir.Out, group: "hotwater",   enum: onetimeincreaseMap, // Mer varmvatten engångshöjning
     info: {en: "Temporary one-time hot water boost", sv: "Tillfällig engångshöjning av varmvatten"}},
    // Rad 18 Periodisk varmvatten höjning
    {address:   65, name: "measure_enum_NIBE.h65_periodic_hotwater",          direction: Dir.Out, group: "hotwater",   enum: booleanMap, // Periodisk varmvatten
     info: {en: "Periodic hot water boost on/off (status)", sv: "Periodisk varmvattenhöjning av/på (status)"}},
    {address:   66, name: "measure_day_NIBE.h66_periodic_hotwater_interval",  direction: Dir.Out, group: "hotwater",   scale: 1, min: 1, max: 90, // Periodiskt varmvatten intervall i dagar
     info: {en: "Days between periodic hot water boosts", sv: "Dagar mellan periodiska varmvattenhöjningar"}},
    // Rad 19 Periodtid varmvatten
    {address:   92, name: "measure_minute_NIBE.h92_periodtime_hotwater",      direction: Dir.Out, group: "hotwater",   scale: 1, min: 0, max: 180, // Periodtid varmvatten minuter
     info: {en: "Duration of the periodic hot water boost", sv: "Längd på den periodiska varmvattenhöjningen"}},
    // Rad 20 Strömförbrukning
    {address:   50, name: "measure_current.i50_sensor_v2",                    direction: Dir.In,  group: "electrical", scale: 10, // Strömavkänare BE1 -L1
     info: {en: "Current on phase L1 (sensor BE1)", sv: "Ström på fas L1 (givare BE1)"}},
    {address:   48, name: "measure_current.i48_sensor_v2",                    direction: Dir.In,  group: "electrical", scale: 10, // Strömavkänare BE2 -L2
     info: {en: "Current on phase L2 (sensor BE2)", sv: "Ström på fas L2 (givare BE2)"}},
    {address:   46, name: "measure_current.i46_sensor_v2",                    direction: Dir.In,  group: "electrical", scale: 10, // Strömavkänare BE3 -L3
     info: {en: "Current on phase L3 (sensor BE3)", sv: "Ström på fas L3 (givare BE3)"}},
    // Rad 21 Driftläge / pool
    {address:  237, name: "measure_enum_NIBE.h237_operating_mode",            direction: Dir.Out, group: "core",       enum: modeMap, // Driftläge
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
    // Rad 24
    {address: 5351, name: "pump_setpoint.h5351_compressor_min_speed",         direction: Dir.Out, group: "diagnostics", scale: 100, min: 0.02, max: 0.5, // Minsta tillåtna hastighet GP1
     info: {en: "Lowest allowed speed for the heating medium pump (GP1)", sv: "Minsta tillåtna hastighet för värmebärarpumpen (GP1)"}},

    // Ej på värdedelen av appen

    // Poolvärme inställningar temp
    {address:  687, name: "target_temperature.h687_pool_start",               direction: Dir.Out, group: "pool",       scale: 10, min: 10, max: 35,
     info: {en: "Pool temperature where heating starts", sv: "Pooltemperatur där uppvärmning startar"}},
    {address:  689, name: "target_temperature.h689_pool_stop",                direction: Dir.Out, group: "pool",       scale: 10, min: 10, max: 35,
     info: {en: "Pool temperature where heating stops", sv: "Pooltemperatur där uppvärmning stoppar"}},

    // On / Off delar på kortet
    // On / Off Nattsvalka
    {address:  227, name: "onoff.h227_nightchill",                            direction: Dir.Out, group: "ventilation", bool: true, // Nattsvalka 1
     info: {en: "Night cooling using the exhaust air fan", sv: "Nattsvalka med hjälp av frånluftsfläkten"}},
    // On / Off Periodiskt varmvatten
    {address:   65, name: "onoff.h65_periodic_hotwater",                      direction: Dir.Out, group: "hotwater",   bool: true, // Periodisk varmvatten
     info: {en: "Enable the periodic hot water boost", sv: "Aktivera periodisk varmvattenhöjning"}},

    {address: 1828, name: "onoff.i1828_pool_circulation",                     direction: Dir.In,  group: "pool",       bool: true, // Pool 1 pump status
     info: {en: "Whether the pool pump is circulating", sv: "Om poolpumpen cirkulerar"}},
    {address:  691, name: "onoff.h691_pool_active",                           direction: Dir.Out, group: "pool",       bool: true,
     info: {en: "Enable pool heating", sv: "Aktivera poolvärme"}},

    // Inställning värmekurva
    {address:   26, name: "curve_mode_NIBE.h26_heat_curve",                   direction: Dir.Out, group: "heating",    picker: true, // Värmekurva klimatsystem 1
     info: {en: "Selector for the heat curve slope (0–10)", sv: "Väljare för värmekurvans lutning (0–10)"}},
    {address:   30, name: "curve_displacement_NIBE.h30_heat_curve_displacement", direction: Dir.Out, group: "heating", picker: true, // Värmeförskjutning klimatsystem 1 RW
     info: {en: "Selector for the heat curve offset (−10…+10)", sv: "Väljare för kurvförskjutning (−10…+10)"}},
    // Inställning varmvatten
    {address:   56, name: "hotwater_demand_NIBE.h56_hotwater_demand_mode",    direction: Dir.Out, group: "hotwater",   picker: true, // Varmvatten behovsläge RW 0 = small, 1 = medium, 2 = large, 3 = not in use, 4 = Smart control
     info: {en: "Selector for the hot water demand mode", sv: "Väljare för varmvattnets behovsläge"}},
    {address:  697, name: "hotwater_increase_NIBE.h697_onetimeincrease_hotwater", direction: Dir.Out, group: "hotwater", picker: true, // Mer varmvatten engångshöjning 0 = Från, 2 = Engångshöjning, 3 = 3 timmar, 6 = 6 timmar, 12 = 12 timmar, 24 = timmar, 48 = 48 Timmar
     info: {en: "Selector for a one-time hot water boost", sv: "Väljare för engångshöjning av varmvatten"}},
        // Inställning Periodiskt varmvatten
    {address:   66, name: "hotwater_periodic_interval_NIBE.h66_periodic_hw_interval", direction: Dir.Out, group: "hotwater", picker: true, // Periodiskt varmvatten intervall i dagar
     info: {en: "Selector for days between periodic hot water boosts", sv: "Väljare för dagar mellan periodiska varmvattenhöjningar"}},
    {address:   92, name: "hotwater_periodtime_NIBE.h92_periodtime_hotwater", direction: Dir.Out, group: "hotwater",   picker: true, // Periodiskt varmvatten längd i minuter
     info: {en: "Selector for the periodic hot water boost duration", sv: "Väljare för den periodiska varmvattenhöjningens längd"}},

    {address:  180, name: "onoff.h180_enable_addition",                       direction: Dir.Out, group: "core",       bool: true, // Tillåt tillsats
     info: {en: "Allow the electric additive heater", sv: "Tillåt eltillsatsen"}},
    {address:  181, name: "onoff.h181_enable_heating",                        direction: Dir.Out, group: "heating",    bool: true, // Tillåt värme
     info: {en: "Allow heating operation", sv: "Tillåt värmedrift"}},
    {address:  182, name: "onoff.h182_enable_cooling",                        direction: Dir.Out, group: "cooling",    bool: true, // Tillåt kyla
     info: {en: "Allow cooling operation", sv: "Tillåt kyldrift"}}
];

export const registerByName =
    Object.fromEntries(registers.map((register: Register) => [register.name, register]));

// A register the user can change from Homey (writable holding register that
// isn't display-only) as opposed to a read-only sensor/insight value.
export function isAdjustable(register: Register): boolean {
    return register.direction === Dir.Out && !register.noAction;
}

// Registers whose values are static configuration rather than something worth
// monitoring. They are surfaced as read-only labels in the device's advanced
// settings instead of capabilities.
export interface StaticRegister {
    address: number;
    direction: Dir;
    settingId: string;
    format: (raw: number) => string;
}

export const staticRegisters: StaticRegister[] = [
    // Säkring inkommande (A)
    {address: 103, direction: Dir.Out, settingId: "fuse_size", format: (raw) => `${raw} A`},
    // Periodiskt varmvatten start, sekunder efter midnatt
    {address:  67, direction: Dir.Out, settingId: "periodic_hotwater_start", format: (raw) => {
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${pad(Math.floor(raw / 3600))}:${pad(Math.floor((raw % 3600) / 60))}`;
    }}
];

// Convert a raw 16-bit register value to a plain number (sign + scale only, no
// enum/bool mapping) — used by detection sampling where only numeric movement
// and plausibility matter.
export function toNumericValue(register: Register, raw: number): number {
    let value = raw;
    if (value >= 32768)
        value -= 65536;
    if (register.scale)
        return value / register.scale;
    return value;
}

// The user's feature selection, stored on the device (store key "selection").
// A missing selection means everything is enabled, which keeps devices paired
// before this feature (or paired with detection skipped) behaving as before.
export interface Selection {
    groups: Partial<Record<GroupId, boolean>>;
    overrides: Record<string, boolean>;
}

export function isRegisterEnabled(register: Register, selection: Selection | null | undefined): boolean {
    if (register.group === "core" || !selection)
        return true;
    return selection.overrides?.[register.name]
        ?? selection.groups?.[register.group]
        ?? true;
}
