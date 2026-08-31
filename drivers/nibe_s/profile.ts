import {registers} from './registers';
import {sReason} from './reason';
import {makeProfile} from '../../lib/profile';
import {capabilities, capabilitiesOptions} from './driver.compose.json';
import {actions, conditions, triggers} from './driver.flow.compose.json';

// The Nibe S-series model profile: the S register table plus everything model-specific the
// shared engine (lib/*) needs. Reproduces exactly the constants that used to live inline in
// the S driver's roles.ts / connection.ts / detection.ts, so S behaviour is unchanged.
export const sProfile = makeProfile({
    registers,

    role: {
        priorityRegisterName: "measure_enum_NIBE.i1028_priority",
        priorityRawOff: 10,
        // 2305 first, on measurement. It is the energy log's own power reading, it exists as an
        // input register on ALL six model maps, and integrating it reproduces the pump's hourly
        // books; 2166 is the instantaneous whole-unit draw and exists on only three models.
        //
        // Measured against the pump's own per-function figures, S1155 and S735:
        //
        //   hot water  2166  -3.3% -2.9% -3.0% -8.5% -5.0%   2305  0.0% +0.8% +0.1% -0.1% +3.1%
        //   heating    2166  -0.8% -4.2% -3.0%               2305  +1.6% -2.6% -3.0%
        //
        // 2166 runs consistently ~3% low on hot water on both models, and misses standby draw
        // entirely on exhaust-air units (S735 idle: 2166 10 W, 2305 50 W — it does not see the
        // continuously-running fan). halderex then measured Modbus 2293 against myUplink 25138
        // on the same pump in the same hour: 0.930 vs 0.93, exact. So the energy log IS what
        // myUplink publishes, which makes those percentages the error a user actually sees when
        // they compare us against the app they already trust.
        //
        // Used for the live `measure_power` too, not just the meter, so Homey's Energy tab
        // cannot show a live figure that fails to integrate to its own total. 2305 lags a ramp
        // more than 2166 does, which for a heat pump costs nothing worth having.
        //
        // 2166 stays as the fallback for a pump where 2305 is dead, and stays visible in its own
        // right as "Total power" — it is a real reading, just not the one to bill against.
        powerSources: [
            ["measure_watt_NIBE.i2305_energylog_power"],
            ["measure_watt_NIBE.i2166_energy_usage"]
        ],
        // The tile reads 2166 where it exists: it is the unfiltered instantaneous draw, and the
        // lag that costs 2305 nothing over an hour makes it show roughly half the real power
        // through a compressor start. Models without 2166 fall through to 2305 and simply get
        // the same figure the meter integrates, which is what they had before.
        displayPowerSources: [
            ["measure_watt_NIBE.i2166_energy_usage"],
            ["measure_watt_NIBE.i2305_energylog_power"]
        ],
        // Reading order per device. Temperatures first, most relevant first, then the settings
        // that act on them, then the slower/rarer stuff. See ModelProfile.displayOrder.
        displayOrder: {
            heating: [
                // what the room is doing, and what it is being asked to do
                "measure_temperature",
                "target_temperature",
                "measure_temperature.i1_outside",
                "measure_temperature.i37_outside_avg",
                // the water that heats it
                "measure_temperature.i1017_calculated_supply",
                "measure_temperature.i5_heating_supply",
                "measure_temperature.i7_heating_return",
                "measure_temperature.i12_heating_supply",
                "measure_water.i40_flow_sensor",
                "measure_percentage_NIBE.i1102_heating_pump",
                // the curve that decides the supply temperature
                "curve_mode_NIBE.h26_heat_curve",
                "curve_displacement_NIBE.h30_heat_curve_displacement",
                "target_temperature.h34_min_supply",
                "target_temperature.h38_max_supply",
                // when it is allowed to run at all
                "target_temperature.h184_auto_stop_heating",
                "target_temperature.h185_auto_stop_addition",
                "measure_minute_NIBE.h93_periodtime_heating",
                // degree minutes: the deficit and its thresholds
                "measure_degree_minutes_NIBE.h11_degree_minutes",
                "measure_degree_minutes_NIBE.h97_dm_start_compressor",
                "measure_degree_minutes_NIBE.h679_dm_diff_start_addition",
                // room-sensor regulation and price control, rarely touched
                "boolean_NIBE.h202_use_room_sensor",
                "boolean_NIBE.h844_spa_heating_activated",
                "spa_heating_influence_NIBE.h845_spa_heating_influence"
            ],
            hotwater: [
                "measure_temperature.i9_hot_water",
                "measure_temperature.i8_warmwater_top",
                // the mode in force, and the boost
                "hotwater_demand_NIBE.h56_hotwater_demand_mode",
                "boolean_NIBE.h697_more_hotwater",
                "hotwater_increase_NIBE.h697_onetimeincrease_hotwater",
                // the setpoints, paired start/stop per mode
                "target_temperature.h60_hotwater_start_small",
                "target_temperature.h64_hotwater_stop_small",
                "target_temperature.h59_hotwater_start",
                "target_temperature.h63_hotwater_stop",
                "target_temperature.h58_hotwater_start_large",
                "target_temperature.h62_hotwater_stop_large",
                // the periodic anti-legionella charge
                "boolean_NIBE.h65_periodic_hotwater",
                "hotwater_periodic_interval_NIBE.h66_periodic_hw_interval",
                "target_temperature.h61_hotwater_stop_periodic",
                "hotwater_periodtime_NIBE.h92_periodtime_hotwater",
                // runtimes, then the circulation accessory most pumps do not have
                "measure_hour_NIBE.i1091_compressor_usage_hotwater",
                "measure_hour_NIBE.i1069_additive_usage_hotwater",
                "status_NIBE.i1063_hw_circulation",
                "measure_temperature.i87_outgoing_hotwater",
                "measure_temperature.i174_hw_comfort_return",
                "measure_temperature.i175_hw_comfort_heater",
                "boolean_NIBE.h846_spa_hotwater_activated",
                "spa_hotwater_influence_NIBE.h902_spa_hotwater_influence"
            ],
            pool: [
                "measure_temperature.i27_pool",
                "target_temperature.h687_pool_start",
                "target_temperature.h689_pool_stop",
                "measure_minute_NIBE.h94_periodtime_pool",
                "status_NIBE.i1828_pool_circulation",
                "spa_influence_NIBE.h848_spa_pool_influence"
            ],
            cooling: [
                "target_temperature.h183_auto_start_cooling",
                "measure_degree_minutes_NIBE.h20_cooling_dm",
                "boolean_NIBE.h227_nightchill",
                "boolean_NIBE.h849_spa_cooling_activated",
                "spa_influence_NIBE.h850_spa_cooling_influence",
                "measure_hour_NIBE.i279_compressor_usage_cooling"
            ]
        },
        totalProductionRegister: "meter_kwh_NIBE.i3821_total_production",
        totalConsumptionRegister: "meter_kwh_NIBE.i3823_total_consumption",
        producedRegisterForRole: {
            heating: "meter_kwh_NIBE.i1577_heating_produced",
            hotwater: "meter_kwh_NIBE.i1575_hotwater_produced",
            pool: "meter_kwh_NIBE.i1581_pool_produced",
            cooling: "meter_kwh_NIBE.i1579_cooling_produced"
        },
        priorityToRole: {10: "main", 20: "hotwater", 30: "heating", 40: "pool", 60: "cooling"},
        // Each function device's tile on/off IS that function's enable register — so turning a
        // device off disables that function on the pump. Main's on/off is the bare `onoff`,
        // pinned ON (the pump is always operating).
        primaryOnoff: {
            main: "onoff",
            heating: "onoff.h181_enable_heating",
            hotwater: "onoff.h195_enable_hotwater",
            pool: "onoff.h691_pool_active",
            cooling: "onoff.h182_enable_cooling"
        },
        // Clear the "More hot water" one-time boost (697) once the pump has delivered it and
        // returns from hot water (priority 20) to idle (10), so the toggle doesn't linger on.
        resetOnPriorityChange: [
            {from: 20, to: 10, register: "boolean_NIBE.h697_more_hotwater"}
        ],
        // 195's own info string says it: "Off disables all hot water, including the More hot
        // water boost." Disabling hot water mid-boost via the Homey toggle otherwise leaves the
        // boost running — the reset rule above never fires, because the pump never makes the
        // "hot water -> idle" transition on its own once Homey has already cut it off.
        clearOnDisable: [
            {register: "onoff.h195_enable_hotwater", clears: ["boolean_NIBE.h697_more_hotwater"]}
        ]
    },

    // S-series speaks native Modbus TCP on port 502, unit id 1, with 1-based register ids
    // (no address offset).
    transport: {port: 502, unitId: 1},

    // Model/firmware input registers (menu labels), read once per connect.
    pumpInfo: {typeAddress: 1497, firmwareAddress: 1496},

    // Which functions the pump counts toward its own energy log and totals — Nibe's
    // `eMbHolding_eU8EnergyLogSettingsInc*`. Holding registers, read-only here; the CSVs give
    // them no title (3095 appears only as `id:12391`), so they are unfindable without Nibe's
    // symbol list.
    //
    // Only the two that any S-model actually exposes are listed: cooling on S320/S325 and
    // S2125, pool 1 on S320/S325 and S1156/S1256. IncHW (3092) and IncPool2 (3094) exist in
    // Nibe's master list but on none of the six S-series register maps, so listing them would
    // only ever produce "unavailable". Everything else reports nothing at all, which is
    // correct — those models give no way to know what their totals include.
    energyLogSettings: [
        {label: "cooling", address: 3095},
        {label: "pool 1", address: 3093}
    ],

    // Watched and logged each time they step at :00. Ordered used-then-produced so a logged
    // hour reads as a COP left to right.
    energyLog: [
        {name: "meter_kwh_NIBE.i2291_log_used_heating",      label: "heating used",       role: "heating",  flow: "used"},
        {name: "meter_kwh_NIBE.i2299_log_add_heating",       label: "add.heat heating",   role: "heating",  flow: "used"},
        {name: "meter_kwh_NIBE.i2283_log_produced_heating",  label: "heating produced",   role: "heating",  flow: "produced"},
        {name: "meter_kwh_NIBE.i2293_log_used_hotwater",     label: "hot water used",     role: "hotwater", flow: "used"},
        {name: "meter_kwh_NIBE.i2301_log_add_hotwater",      label: "add.heat hot water", role: "hotwater", flow: "used"},
        {name: "meter_kwh_NIBE.i2285_log_produced_hotwater", label: "hot water produced", role: "hotwater", flow: "produced"},
        {name: "meter_kwh_NIBE.i2297_log_used_cooling",      label: "cooling used",       role: "cooling",  flow: "used"},
        {name: "meter_kwh_NIBE.i2289_log_produced_cooling",  label: "cooling produced",   role: "cooling",  flow: "produced"},
        {name: "meter_kwh_NIBE.i2295_log_used_pool",         label: "pool used",          role: "pool",     flow: "used"},
        {name: "meter_kwh_NIBE.i2303_log_add_pool",          label: "add.heat pool",      role: "pool",     flow: "used"},
        {name: "meter_kwh_NIBE.i2287_log_produced_pool",     label: "pool produced",      role: "pool",     flow: "produced"}
    ],

    // Register 1975 "Alarm number" carries a bare code. S-series numbering — NOT the same as
    // the F-series scheme (see lib/alarms.ts); 438 means different things on the two.
    alarm: {registerName: "alarm_text_NIBE", series: "s"},

    // The hot water tank, for the litres-available estimate (see lib/hotwater.ts).
    //
    // TWO layers, not three. Nibe's register maps list a third tank sensor, BT5 "hot water
    // start", at address 2014 for this family — but a live S1155-16 (type 55, compressor 16,
    // firmware 1036) returns no answer for it, so S describes the two sensors that do exist.
    // The same pump, settled and idle, read BT7 56.0 against BT6 38.0: eighteen degrees apart,
    // with the lower sensor below the 40 °C mix point entirely. That spread is why the split
    // between them is measured from charge cycles rather than assumed.
    //
    // The catalogue only makes the measurement converge sooner — every entry is optional and
    // "auto" is the default. Litres are NIBE's own published figures from the VPB/VPBS brochure
    // (639368-5 / 639721 CIL EN 1902-2); no entry may be added without an official source, since
    // a wrong figure here silently biases every estimate that trusts it.
    hotwaterTank: {
        topRegister: "measure_temperature.i8_warmwater_top",
        lowerRegister: "measure_temperature.i9_hot_water",
        // WATER volume, never NIBE's published "equivalent amount of hot water at 40 °C" — that
        // figure is not a property of the tank (NIBE prints 376 L and 455 L for the same VPB S300
        // in two of its own documents) and feeding one in here would double-count the conversion.
        //
        // ONE ENTRY PER TANK FAMILY, not per lining. VPB 200 comes as 172 L copper, 176 L
        // stainless and 178 L enamel; picking the wrong one costs 1.7 %. The sensor split, which
        // is not measured on most installations, swings the same answer by ~57 %. Three near
        // identical rows asked the owner to know something that does not matter, so the families
        // are collapsed to their midpoint. VPB and VPB S share volumes exactly, so they share a row.
        //
        // AHPS / AHP / AHPH are deliberately absent: they store no potable water at all (hot water
        // is made through a 17 L instantaneous coil), so a litre figure would be meaningless.
        tanks: [
            {id: "integrated", litres: 178,
             name: {en: "Built-in tank (S1255, S1256, S735)",
                    sv: "Inbyggd beredare (S1255, S1256, S735)"}},
            {id: "vpb200", litres: 175, name: {en: "NIBE VPB 200 / VPB S200", sv: "NIBE VPB 200 / VPB S200"}},
            {id: "vpb300", litres: 276, name: {en: "NIBE VPB 300 / VPB S300", sv: "NIBE VPB 300 / VPB S300"}},
            // Kept apart from VPB 300: the solar coil displaces water, so its heated volume is
            // lower than the nominal figure and it is the one row whose published 40 °C figure
            // does not fit the formula every plain VPB row obeys.
            {id: "vpbs300", litres: 277, name: {en: "NIBE VPBS 300 (solar)", sv: "NIBE VPBS 300 (sol)"}},
            {id: "vpb500", litres: 486, name: {en: "NIBE VPB 500", sv: "NIBE VPB 500"}},
            {id: "vpb750", litres: 747, name: {en: "NIBE VPB 750", sv: "NIBE VPB 750"}},
            {id: "vpb1000", litres: 992, name: {en: "NIBE VPB 1000", sv: "NIBE VPB 1000"}},
            // Jacket tanks: only the potable volume, never the surrounding buffer.
            {id: "vpa200", litres: 204, name: {en: "NIBE VPA 200/70", sv: "NIBE VPA 200/70"}},
            {id: "vpa300", litres: 300, name: {en: "NIBE VPA 300 / VPAS 300", sv: "NIBE VPA 300 / VPAS 300"}},
            {id: "vpa450", litres: 450, name: {en: "NIBE VPA 450/300", sv: "NIBE VPA 450/300"}}
        ]
    },

    // How a change of operating priority is explained — see reason.ts, which holds the S
    // control semantics (degree minutes, hot-water start/stop bands, outdoor cut-offs).
    reason: sReason,

    // The pool device is a thermostat too: it measures a temperature and controls it. It cannot
    // own the bare `measure_temperature` / `target_temperature` ids, because a register's name is
    // its capability id and heating's room temperature and setpoint already hold them — so the
    // values are mirrored instead. See `mirrors` on ModelProfile.
    //
    // Pool has TWO setpoints where a thermostat dial has one: the pump heats until 689 (stop) and
    // restarts at 687 (start). `stop` is the honest reading of "the temperature you want the pool
    // at", and `start` stays visible as its own capability. The validator is what stops the dial
    // — now a single gesture — inverting the band.
    mirrors: [
        // Solar's live generation, published under the bare `measure_power` id. Homey Energy
        // reads production from that id alone — `meterPowerExportedCapability` redirects the
        // cumulative meter to meter_power.solar, but measure_power has no such key, so the
        // register's own sub-capability id is invisible to the Energy tab.
        //
        // Plumbing, not a second reading: measure_power.i2176_solar_current already shows these
        // watts in the device view under its own title, so `uiComponent: null` keeps the mirror
        // out of it and `insights: false` keeps it from opening a second Insights log with the
        // same name and the same values — which, per the display-name snapshot, could never be
        // renamed or merged afterwards. measure_power defaults to insights: true, so this has to
        // be explicit.
        {
            role: "solar",
            capability: "measure_power",
            options: {
                decimals: 0, uiComponent: null, insights: false,
                title: {en: "Solar power generated", sv: "Genererad soleffekt",
                        de: "Erzeugte Solarleistung", nl: "Opgewekt zonnevermogen",
                        no: "Generert soleffekt", da: "Genereret soleffekt"}
            },
            register: "measure_power.i2176_solar_current"
        },
        {
            role: "pool",
            capability: "measure_temperature",
            register: "measure_temperature.i27_pool",
            options: {
                title: {en: "Pool temperature", sv: "Pooltemperatur", de: "Pooltemperatur",
                        nl: "Zwembadtemperatuur", no: "Bassengtemperatur", da: "Pooltemperatur"}
            }
        },
        {
            role: "pool",
            capability: "target_temperature",
            register: "target_temperature.h689_pool_stop",
            writable: true,
            // Range kept identical to the source register (10..35), NOT Nibe's documented
            // 5.5..80.0 for holding 689. Widening it here would let the dial set a value the
            // generic "set numeric value" flow card then refuses — the two must agree. Whether
            // the register's own band should be widened toward Nibe's is a separate question.
            options: {
                decimals: 1, min: 10, max: 35, step: 0.5, insights: true,
                title: {en: "Pool target temperature", sv: "Börvärde pooltemperatur",
                        de: "Pool-Solltemperatur", nl: "Streefwaarde zwembadtemperatuur",
                        no: "Settpunkt bassengtemperatur", da: "Settpunkt pooltemperatur"}
            },
            validate: (value, read) => {
                const start = read("target_temperature.h687_pool_start");
                if (typeof start === "number" && value <= start)
                    return {
                        en: `Pool heating stops at this temperature and restarts at ${start} °C, `
                            + `so it has to stay above ${start} °C. Lower the pool start `
                            + `temperature first.`,
                        sv: `Poolvärmen stoppar vid den här temperaturen och startar om vid `
                            + `${start} °C, så den måste ligga över ${start} °C. Sänk `
                            + `poolens starttemperatur först.`
                    };
                return undefined;
            }
        }
    ],

    // Room temperature and the indoor setpoint moved from sub-capabilities to the bare
    // `measure_temperature` / `target_temperature` so Homey's Climate feature and the thermostat
    // tile can see them. Both resolutions are stored per register NAME, so without this an
    // upgraded device loses them: on an S735 that is the alternate address 26 (room temperature
    // would go back to the sentinel at the primary), and on an S1155 it is the user's choice
    // among 116/111/26.
    renamedRegisters: {
        "measure_temperature.i26_inside": "measure_temperature",
        "target_temperature.h2505_zone1_setpoint": "target_temperature",
        // 0.9.14: the SPA heating influence changed capability type (read-only count → picker),
        // which changes the capability id. Worth carrying because a stored `selection` is keyed
        // by register name, so without this the register loses its resolved address and any
        // per-capability override, not just its label.
        "measure_count_NIBE.h845_spa_heating_influence": "spa_heating_influence_NIBE.h845_spa_heating_influence",
        // Off the bare `measure_power`, which collided with the derived live-draw capability of
        // the same name (see the register's comment). Carried rather than hard-cut because a
        // stored selection is keyed by register name: a solar owner who unticked or re-sourced
        // this would otherwise silently lose that, and the collision means the old key could
        // have been written by either side.
        "measure_power": "measure_power.i2176_solar_current"
    },

    detection: {
        // Verify a Modbus responder is a pump by reading input register 1 (outdoor temp).
        discoveryProbe: {address: 1, scale: 10, min: -60, max: 60},
        // Fallbacks for groups where nothing moved during the sampling window.
        plausible: {
            // Apply to every pump, so they default to recommended.
            heating: () => true,
            diagnostics: () => true,
            statistics: () => true,
            alarm: () => true,
            // The energy meters increment continuously; default recommended if they happen
            // not to move during the window.
            energy: () => true,
            hotwater: ({value}) =>
                (value("measure_temperature.i8_warmwater_top") ?? 0) > 20
                || (value("measure_temperature.i9_hot_water") ?? 0) > 20,
            pool: ({value, inRange}) =>
                value("onoff.h691_pool_active") === 1
                || inRange("measure_temperature.i27_pool", 5, 45),
            // Only recommend cooling when the pump is actually prioritising cooling (60);
            // the enable register reads on essentially every S pump regardless of hardware.
            cooling: ({value}) => value("measure_enum_NIBE.i1028_priority") === 60,
            ventilation: ({inRange}) =>
                inRange("measure_temperature.i19_return_air", 5, 40)
                || inRange("measure_temperature.i20_supply_air", -25, 40),
            groundsource: ({inRange}) =>
                inRange("measure_temperature.i10_source_in", -15, 25)
                || inRange("measure_temperature.i11_source_out", -15, 25),
            electrical: ({value}) =>
                ["measure_current.i50_sensor_v2", "measure_current.i48_sensor_v2", "measure_current.i46_sensor_v2"]
                    .some((name) => (value(name) ?? 0) > 0),
            solar: ({value}) =>
                (value("measure_power.i2176_solar_current") ?? 0) > 0
                || (value("meter_power.solar") ?? 0) > 0
        }
    },

    compose: {capabilities, capabilitiesOptions, actions, conditions, triggers}
});
