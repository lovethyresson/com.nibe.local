import {Dir, Register} from '../../lib/registers';

// Canonical NIBE ids; transport differences are profile data. See docs/f-series.md.
export const registers: Register[] = [
    {
        "address": 43086,
        "name": "measure_enum_NIBE.h43086_priority",
        "direction": Dir.Out,
        "group": "core",
        "noAction": true,
        "size": 16,
        "signed": false,
        "info": {
            "en": "Priority",
            "sv": "Driftprioritering"
        },
        "enum": {
            "10": "Off",
            "20": "Hot water",
            "30": "Heating",
            "40": "Pool",
            "41": "Pool",
            "50": "Transfer",
            "60": "Cooling"
        }
    },
    {
        "address": 40004,
        "name": "measure_temperature.h40004_outside",
        "direction": Dir.Out,
        "group": "heating",
        "noAction": true,
        "scale": 10,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Outside temperature (BT1)",
            "sv": "Utetemperatur (BT1)"
        }
    },
    {
        "address": 40033,
        "name": "measure_temperature",
        "direction": Dir.Out,
        "group": "heating",
        "noAction": true,
        "scale": 10,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Indoor temperature",
            "sv": "Inomhustemperatur"
        },
        "plausible": {
            "min": 5,
            "max": 40
        }
    },
    {
        "address": 40067,
        "name": "measure_temperature.h40067_outside_avg",
        "direction": Dir.Out,
        "group": "heating",
        "noAction": true,
        "scale": 10,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Average outdoor temperature",
            "sv": "Medelutetemperatur"
        }
    },
    {
        "address": 43009,
        "name": "measure_temperature.h43009_calculated_supply",
        "direction": Dir.Out,
        "group": "heating",
        "noAction": true,
        "scale": 10,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Calculated supply",
            "sv": "Beräknad framledning"
        }
    },
    {
        "address": 40008,
        "name": "measure_temperature.h40008_heating_supply",
        "direction": Dir.Out,
        "group": "heating",
        "noAction": true,
        "scale": 10,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Heating supply (BT2)",
            "sv": "Framledningstemp. (BT2)"
        }
    },
    {
        "address": 40012,
        "name": "measure_temperature.h40012_heating_return",
        "direction": Dir.Out,
        "group": "heating",
        "noAction": true,
        "scale": 10,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Heating return (BT3)",
            "sv": "Returledningstemp. (BT3)"
        }
    },
    {
        "address": 40071,
        "name": "measure_temperature.h40071_heating_supply",
        "direction": Dir.Out,
        "group": "heating",
        "noAction": true,
        "scale": 10,
        "size": 16,
        "signed": true,
        "info": {
            "en": "External supply (BT25)",
            "sv": "Extern framledning (BT25)"
        }
    },
    {
        "address": 40072,
        "name": "measure_water.h40072_flow_sensor",
        "direction": Dir.Out,
        "group": "heating",
        "noAction": true,
        "scale": 10,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Flow sensor (BF1)",
            "sv": "Flödesgivare (BF1)"
        }
    },
    {
        "address": 43005,
        "name": "measure_degree_minutes_NIBE.h43005_degree_minutes",
        "direction": Dir.Out,
        "group": "heating",
        "noAction": true,
        "scale": 10,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Degree minutes",
            "sv": "Gradminuter"
        }
    },
    {
        "address": 43437,
        "name": "measure_percentage_NIBE.h43437_heating_pump",
        "direction": Dir.Out,
        "group": "heating",
        "noAction": true,
        "scale": 1,
        "size": 16,
        "signed": false,
        "info": {
            "en": "Heating pump (GP1)",
            "sv": "Värme-pumphastighet (GP1)"
        }
    },
    {
        "address": 40013,
        "name": "measure_temperature.h40013_warmwater_top",
        "direction": Dir.Out,
        "group": "hotwater",
        "noAction": true,
        "scale": 10,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Hot water top (BT7)",
            "sv": "Varmvatten topp (BT7)"
        }
    },
    {
        "address": 40014,
        "name": "measure_temperature.h40014_hot_water",
        "direction": Dir.Out,
        "group": "hotwater",
        "noAction": true,
        "scale": 10,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Hot water charging (BT6)",
            "sv": "Varmvatten laddning (BT6)"
        }
    },
    {
        "address": 43239,
        "name": "measure_hour_NIBE.h43239_additive_usage_hotwater",
        "direction": Dir.Out,
        "group": "hotwater",
        "noAction": true,
        "scale": 10,
        "size": 32,
        "signed": true,
        "info": {
            "en": "Immersion heater runtime",
            "sv": "Elpatronens drifttid"
        }
    },
    {
        "address": 43424,
        "name": "measure_hour_NIBE.h43424_compressor_usage_hotwater",
        "direction": Dir.Out,
        "group": "hotwater",
        "noAction": true,
        "scale": 1,
        "size": 32,
        "signed": true,
        "info": {
            "en": "Compressor runtime",
            "sv": "Drifttid kompressor"
        }
    },
    {
        "address": 40025,
        "name": "measure_temperature.h40025_return_air",
        "direction": Dir.Out,
        "group": "ventilation",
        "noAction": true,
        "scale": 10,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Extract air (BT20)",
            "sv": "Frånluft (BT20)"
        }
    },
    {
        "address": 40026,
        "name": "measure_temperature.h40026_supply_air",
        "direction": Dir.Out,
        "group": "ventilation",
        "noAction": true,
        "scale": 10,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Exhaust air (BT21)",
            "sv": "Avluft (BT21)"
        }
    },
    {
        "address": 43108,
        "name": "measure_percentage_NIBE.h43108_fan",
        "direction": Dir.Out,
        "group": "ventilation",
        "noAction": true,
        "scale": 1,
        "size": 16,
        "signed": false,
        "info": {
            "en": "Fan speed",
            "sv": "Fläkthastighet"
        }
    },
    {
        "address": 40015,
        "name": "measure_temperature.h40015_source_in",
        "direction": Dir.Out,
        "group": "groundsource",
        "noAction": true,
        "scale": 10,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Brine in (BT10)",
            "sv": "Köldbärare in (BT10)"
        }
    },
    {
        "address": 40016,
        "name": "measure_temperature.h40016_source_out",
        "direction": Dir.Out,
        "group": "groundsource",
        "noAction": true,
        "scale": 10,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Brine out (BT11)",
            "sv": "Köldbärare ut (BT11)"
        }
    },
    {
        "address": 43439,
        "name": "measure_percentage_NIBE.h43439_source_pump",
        "direction": Dir.Out,
        "group": "groundsource",
        "noAction": true,
        "scale": 1,
        "size": 16,
        "signed": false,
        "info": {
            "en": "Source pump (GP2)",
            "sv": "Köld-pumphastighet (GP2)"
        }
    },
    {
        "address": 43140,
        "name": "measure_temperature.h43140_inverter",
        "direction": Dir.Out,
        "group": "diagnostics",
        "noAction": true,
        "scale": 10,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Inverter temperature",
            "sv": "Invertertemperatur"
        }
    },
    {
        "address": 43136,
        "name": "measure_frequency.h43136_compressor",
        "direction": Dir.Out,
        "group": "diagnostics",
        "noAction": true,
        "scale": 10,
        "size": 16,
        "signed": false,
        "info": {
            "en": "Compressor frequency",
            "sv": "Kompressorfrekvens"
        }
    },
    {
        "address": 40018,
        "name": "measure_temperature.h40018_discharge",
        "direction": Dir.Out,
        "group": "diagnostics",
        "noAction": true,
        "scale": 10,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Discharge (BT14)",
            "sv": "Hetgas (BT14)"
        }
    },
    {
        "address": 40019,
        "name": "measure_temperature.h40019_liquid_line",
        "direction": Dir.Out,
        "group": "diagnostics",
        "noAction": true,
        "scale": 10,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Liquid line (BT15)",
            "sv": "Vätskeledning (BT15)"
        }
    },
    {
        "address": 40022,
        "name": "measure_temperature.h40022_suction_gas",
        "direction": Dir.Out,
        "group": "diagnostics",
        "noAction": true,
        "scale": 10,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Suction gas (BT17)",
            "sv": "Suggas (BT17)"
        }
    },
    {
        "address": 43435,
        "name": "status_NIBE.h43435_compressor_status",
        "direction": Dir.Out,
        "group": "diagnostics",
        "noAction": true,
        "size": 16,
        "signed": false,
        "info": {
            "en": "Compressor running",
            "sv": "Kompressor igång"
        },
        "bool": true
    },
    {
        "address": 43081,
        "name": "measure_hour_NIBE.h43081_additive_usage_total",
        "direction": Dir.Out,
        "group": "statistics",
        "noAction": true,
        "scale": 10,
        "size": 32,
        "signed": true,
        "info": {
            "en": "Total immersion heater runtime",
            "sv": "Total drifttid elpatron"
        }
    },
    {
        "address": 43416,
        "name": "measure_count_NIBE.h43416_compressor_starts",
        "direction": Dir.Out,
        "group": "statistics",
        "noAction": true,
        "scale": 1,
        "size": 32,
        "signed": true,
        "info": {
            "en": "Compressor starts",
            "sv": "Kompressorstarter"
        }
    },
    {
        "address": 43420,
        "name": "measure_hour_NIBE.h43420_compressor_usage_total",
        "direction": Dir.Out,
        "group": "statistics",
        "noAction": true,
        "scale": 1,
        "size": 32,
        "signed": true,
        "info": {
            "en": "Total compressor runtime",
            "sv": "Total drifttid kompressor"
        }
    },
    {
        "address": 40079,
        "name": "measure_current.h40079_sensor_v2",
        "direction": Dir.Out,
        "group": "electrical",
        "noAction": true,
        "scale": 10,
        "size": 32,
        "signed": false,
        "info": {
            "en": "Current sensor L1 (BE1)",
            "sv": "Strömsensor L1 (BE1)"
        }
    },
    {
        "address": 40081,
        "name": "measure_current.h40081_sensor_v2",
        "direction": Dir.Out,
        "group": "electrical",
        "noAction": true,
        "scale": 10,
        "size": 32,
        "signed": false,
        "info": {
            "en": "Current sensor L2 (BE2)",
            "sv": "Strömsensor L2 (BE2)"
        }
    },
    {
        "address": 40083,
        "name": "measure_current.h40083_sensor_v2",
        "direction": Dir.Out,
        "group": "electrical",
        "noAction": true,
        "scale": 10,
        "size": 32,
        "signed": false,
        "info": {
            "en": "Current sensor L3 (BE3)",
            "sv": "Strömsensor L3 (BE3)"
        }
    },
    {
        "address": 43141,
        "name": "measure_watt_NIBE.h43141_compressor_motor",
        "direction": Dir.Out,
        "group": "electrical",
        "noAction": true,
        "scale": 1,
        "size": 16,
        "signed": false,
        "info": {
            "en": "Power delivered by the inverter to the compressor motor; excludes other pump consumption.",
            "sv": "Effekt från växelriktaren till kompressormotorn; omfattar inte övrig förbrukning."
        }
    },
    {
        "address": 43084,
        "name": "measure_watt_NIBE.h43084_additive_effect",
        "direction": Dir.Out,
        "group": "electrical",
        "noAction": true,
        "scale": 0.1,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Immersion heater power",
            "sv": "Elpatronens effekt"
        }
    },
    {
        "address": 45001,
        "name": "alarm_text_NIBE",
        "direction": Dir.Out,
        "group": "alarm",
        "noAction": true,
        "scale": 1,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Alarm",
            "sv": "Larm"
        }
    },
    {
        "address": 40042,
        "name": "measure_temperature.h40042_pool",
        "direction": Dir.Out,
        "group": "pool",
        "noAction": true,
        "scale": 10,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Pool temperature (BT51)",
            "sv": "Pooltemperatur (BT51)"
        }
    },
    {
        "address": 43024,
        "name": "status_NIBE.h43024_cooling",
        "direction": Dir.Out,
        "group": "cooling",
        "noAction": true,
        "size": 16,
        "signed": false,
        "info": {
            "en": "Cooling active",
            "sv": "Kyla aktiv"
        },
        "bool": true
    },
    {
        "address": 40045,
        "name": "measure_temperature.h40045_cooling_supply",
        "direction": Dir.Out,
        "group": "cooling",
        "noAction": true,
        "scale": 10,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Cooling supply temperature",
            "sv": "Framledningstemperatur kyla"
        }
    },
    {
        "address": 42035,
        "name": "measure_power.h42035_solar_current",
        "direction": Dir.Out,
        "group": "solar",
        "noAction": true,
        "scale": 1,
        "size": 32,
        "signed": false,
        "info": {
            "en": "Solar power generated",
            "sv": "Genererad soleffekt"
        }
    },
    {
        "address": 42075,
        "name": "meter_power.solar",
        "direction": Dir.Out,
        "group": "solar",
        "noAction": true,
        "scale": 10,
        "size": 32,
        "signed": false,
        "info": {
            "en": "Solar energy generated",
            "sv": "Genererad solenergi"
        },
        "relative": true
    },
    {
        "address": 42437,
        "name": "meter_kwh_NIBE.h42437_hotwater_produced",
        "direction": Dir.Out,
        "group": "hotwater",
        "noAction": true,
        "scale": 10,
        "size": 32,
        "signed": false,
        "info": {
            "en": "Energy delivered",
            "sv": "Levererad energi"
        },
        "relative": true
    },
    {
        "address": 42439,
        "name": "meter_kwh_NIBE.h42439_heating_produced",
        "direction": Dir.Out,
        "group": "heating",
        "noAction": true,
        "scale": 10,
        "size": 32,
        "signed": false,
        "info": {
            "en": "Energy delivered",
            "sv": "Levererad energi"
        },
        "relative": true
    },
    {
        "address": 42441,
        "name": "meter_kwh_NIBE.h42441_cooling_produced",
        "direction": Dir.Out,
        "group": "cooling",
        "noAction": true,
        "scale": 10,
        "size": 32,
        "signed": false,
        "info": {
            "en": "Energy delivered",
            "sv": "Levererad energi"
        },
        "relative": true
    },
    {
        "address": 42443,
        "name": "meter_kwh_NIBE.h42443_pool_produced",
        "direction": Dir.Out,
        "group": "pool",
        "noAction": true,
        "scale": 10,
        "size": 32,
        "signed": false,
        "info": {
            "en": "Energy delivered",
            "sv": "Levererad energi"
        },
        "relative": true
    },
    {
        "address": 41846,
        "name": "energy_counter.h41846_ventilation_consumed",
        "direction": Dir.Out,
        "group": "electrical",
        "noAction": true,
        "internal": true,
        "size": 32,
        "signed": false,
        "scale": 10,
        "info": {
            "en": "F730 consumed energy: ventilation. Diagnostic only until hardware validation.",
            "sv": "Förbrukad energi F730: ventilation. Endast diagnostik tills verifierat på hårdvara."
        }
    },
    {
        "address": 41848,
        "name": "energy_counter.h41848_hotwater_consumed",
        "direction": Dir.Out,
        "group": "electrical",
        "noAction": true,
        "internal": true,
        "size": 32,
        "signed": false,
        "scale": 10,
        "info": {
            "en": "F730 consumed energy: hotwater. Diagnostic only until hardware validation.",
            "sv": "Förbrukad energi F730: varmvatten. Endast diagnostik tills verifierat på hårdvara."
        }
    },
    {
        "address": 41850,
        "name": "energy_counter.h41850_heating_consumed",
        "direction": Dir.Out,
        "group": "electrical",
        "noAction": true,
        "internal": true,
        "size": 32,
        "signed": false,
        "scale": 10,
        "info": {
            "en": "F730 consumed energy: heating. Diagnostic only until hardware validation.",
            "sv": "Förbrukad energi F730: värme. Endast diagnostik tills verifierat på hårdvara."
        }
    },
    {
        "address": 43375,
        "name": "power_sample.h43375_compressor_mean",
        "direction": Dir.Out,
        "group": "electrical",
        "noAction": true,
        "internal": true,
        "size": 16,
        "signed": true,
        "scale": 1,
        "info": {
            "en": "Compressor electrical power averaged over 10 seconds; compare with 43141 before choosing the integration source.",
            "sv": "Kompressorns eleffekt som medelvärde över 10 sekunder; jämför med 43141 innan integrationskälla väljs."
        }
    },
    {
        "address": 47007,
        "name": "curve_mode_NIBE.h47007_heat_curve",
        "direction": Dir.Out,
        "group": "heating",
        "scale": 1,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Heating curve",
            "sv": "Värmekurva"
        },
        "picker": true,
        "pickerValues": [
            0,
            1,
            2,
            3,
            4,
            5,
            6,
            7,
            8,
            9,
            10,
            11,
            12,
            13,
            14,
            15
        ],
        "enum": {
            "0": "0",
            "1": "1",
            "2": "2",
            "3": "3",
            "4": "4",
            "5": "5",
            "6": "6",
            "7": "7",
            "8": "8",
            "9": "9",
            "10": "10",
            "11": "11",
            "12": "12",
            "13": "13",
            "14": "14",
            "15": "15"
        }
    },
    {
        "address": 47011,
        "name": "curve_displacement_NIBE.h47011_curve_offset",
        "direction": Dir.Out,
        "group": "heating",
        "scale": 1,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Heating curve offset",
            "sv": "Värmekurvans förskjutning"
        },
        "picker": true,
        "pickerValues": [
            -10,
            -9,
            -8,
            -7,
            -6,
            -5,
            -4,
            -3,
            -2,
            -1,
            0,
            1,
            2,
            3,
            4,
            5,
            6,
            7,
            8,
            9,
            10
        ],
        "enum": {
            "-10": "-10",
            "-9": "-9",
            "-8": "-8",
            "-7": "-7",
            "-6": "-6",
            "-5": "-5",
            "-4": "-4",
            "-3": "-3",
            "-2": "-2",
            "-1": "-1",
            "0": "0",
            "1": "1",
            "2": "2",
            "3": "3",
            "4": "4",
            "5": "5",
            "6": "6",
            "7": "7",
            "8": "8",
            "9": "9",
            "10": "10"
        }
    },
    {
        "address": 47394,
        "name": "boolean_NIBE.h47394_room_control",
        "direction": Dir.Out,
        "group": "heating",
        "scale": 1,
        "size": 16,
        "signed": false,
        "info": {
            "en": "Use room sensor",
            "sv": "Använd rumsgivare"
        },
        "bool": true
    },
    {
        "address": 47398,
        "name": "target_temperature.h47398_room_setpoint",
        "direction": Dir.Out,
        "group": "heating",
        "scale": 10,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Room target",
            "sv": "Önskad rumstemperatur"
        },
        "min": 5.0,
        "max": 30.0,
        "plausible": {
            "min": 5,
            "max": 30
        }
    },
    {
        "address": 47402,
        "name": "measure_number_NIBE.h47402_room_factor",
        "direction": Dir.Out,
        "group": "heating",
        "scale": 10,
        "size": 16,
        "signed": false,
        "info": {
            "en": "Room sensor influence",
            "sv": "Rumsgivarpåverkan"
        },
        "min": 0.0,
        "max": 6.0
    },
    {
        "address": 47041,
        "name": "hotwater_demand_NIBE.h47041_comfort",
        "direction": Dir.Out,
        "group": "hotwater",
        "scale": 1,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Hot water comfort",
            "sv": "Varmvattenkomfort"
        },
        "picker": true,
        "pickerValues": [
            0,
            1,
            2,
            4
        ],
        "enum": {
            "0": "0 = Small",
            "1": "1 = Medium",
            "2": "2 = Large",
            "4": "4 = Smart control"
        }
    },
    {
        "address": 48132,
        "name": "f_hotwater_boost.h48132_boost",
        "direction": Dir.Out,
        "group": "hotwater",
        "scale": 1,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Temporary hot water boost",
            "sv": "Tillfällig varmvattenhöjning"
        },
        "picker": true,
        "pickerValues": [
            0,
            1,
            2,
            3,
            4
        ],
        "enum": {
            "0": "Off",
            "1": "3 hours",
            "2": "6 hours",
            "3": "12 hours",
            "4": "One-time increase"
        }
    },
    {
        "address": 47050,
        "name": "boolean_NIBE.h47050_periodic_hw",
        "direction": Dir.Out,
        "group": "hotwater",
        "scale": 1,
        "size": 16,
        "signed": true,
        "info": {
            "en": "Periodic hot water increase",
            "sv": "Periodisk varmvattenhöjning"
        },
        "bool": true
    },
    {
        "address": 47265,
        "name": "fan_speed.h47265_normal",
        "direction": Dir.Out,
        "group": "ventilation",
        "scale": 1,
        "size": 16,
        "signed": false,
        "info": {
            "en": "Normal fan speed",
            "sv": "Normal fläkthastighet"
        },
        "min": 0.0,
        "max": 100.0
    },
    {
        "address": 47137,
        "name": "operating_mode_NIBE.h47137_mode",
        "direction": Dir.Out,
        "group": "core",
        "scale": 1,
        "size": 16,
        "signed": false,
        "info": {
            "en": "Operating mode",
            "sv": "Driftläge"
        },
        "picker": true,
        "pickerValues": [
            0,
            1,
            2
        ],
        "enum": {
            "0": "Auto",
            "1": "Manual",
            "2": "Immersion heater only"
        }
    },
    {
        "address": 47370,
        "name": "boolean_NIBE.h47370_allow_addition",
        "direction": Dir.Out,
        "group": "electrical",
        "scale": 1,
        "size": 16,
        "signed": false,
        "info": {
            "en": "Allow immersion (Manual mode)",
            "sv": "Tillåt tillsats (manuellt läge)"
        },
        "bool": true
    },
    {
        "address": 47371,
        "name": "boolean_NIBE.h47371_allow_heating",
        "direction": Dir.Out,
        "group": "heating",
        "scale": 1,
        "size": 16,
        "signed": false,
        "info": {
            "en": "Allow heating (Manual/addition mode)",
            "sv": "Tillåt värme (manuellt/tillsatsläge)"
        },
        "bool": true
    }
];
