import {registers} from './registers';
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
        // S exposes a single whole-unit instantaneous power register (watts).
        powerSources: ["measure_watt_NIBE.i2166_energy_usage"],
        totalProductionRegister: "meter_kwh_NIBE.i3821_total_production",
        totalConsumptionRegister: "meter_kwh_NIBE.i3823_total_consumption",
        producedRegisterForRole: {
            heating: "meter_kwh_NIBE.i1577_heating_produced",
            hotwater: "meter_kwh_NIBE.i1575_hotwater_produced",
            pool: "meter_kwh_NIBE.i1581_pool_produced",
            cooling: "meter_kwh_NIBE.i1579_cooling_produced"
        },
        priorityToRole: {10: "main", 20: "hotwater", 30: "heating", 40: "pool", 60: "cooling"}
    },

    // S-series speaks native Modbus TCP on port 502, unit id 1, with 1-based register ids
    // (no address offset).
    transport: {port: 502, unitId: 1},

    // Model/firmware input registers (menu labels), read once per connect.
    pumpInfo: {typeAddress: 1497, firmwareAddress: 1496},

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
