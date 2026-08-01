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
        // Preferred first: 2166 is the instantaneous whole-unit draw, but it only exists on
        // S1155/S1255, S1156/S1256 and S735. S320/S325, S330/S332 and S2125 fall through to
        // the energy log's averaged reading — see the note on 2305 in registers.ts.
        powerSources: [
            ["measure_watt_NIBE.i2166_energy_usage"],
            ["measure_watt_NIBE.i2305_energylog_power"]
        ],
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

    // How a change of operating priority is explained — see reason.ts, which holds the S
    // control semantics (degree minutes, hot-water start/stop bands, outdoor cut-offs).
    reason: sReason,

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
                (value("measure_power") ?? 0) > 0
                || (value("meter_power.solar") ?? 0) > 0
        }
    },

    compose: {capabilities, capabilitiesOptions, actions, conditions, triggers}
});
