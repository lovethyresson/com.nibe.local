import {Dir} from '../../lib/registers';
import {makeProfile} from '../../lib/profile';
import {registers} from './registers';
import {capabilities, capabilitiesOptions} from './driver.compose.json';
import {actions, conditions, triggers} from './driver.flow.compose.json';

export const fProfile = makeProfile({
    registers, flowPrefix: 'f_', estimatedEnergy: true, pollDeadlineMs: 120_000,
    singleWordWriteFunction: 16,
    writeReadbackIntervalMs: 2100,
    polling: {backgroundIntervalMs: 60_000,
        frequent: registers.filter((r) => [40004, 40008, 40012, 40013, 40014, 40025, 45001]
            .includes(r.address)).map((r) => r.name)},
    diagnosticTrace: registers.filter((r) => [43086, 43141, 43375, 43084, 43136, 43435,
        41846, 41848, 41850, 42437, 42439, 40033, 47394, 47398].includes(r.address)).map((r) => r.name),
    writeRequirements: {
        'boolean_NIBE.h47370_allow_addition': {register: 'operating_mode_NIBE.h47137_mode', values: [1],
            message: {en: 'Immersion permission applies only in Manual mode. Change operating mode explicitly first.',
                sv: 'Tillsats kan ändras endast i manuellt läge. Ändra driftläge först.'}},
        'boolean_NIBE.h47371_allow_heating': {register: 'operating_mode_NIBE.h47137_mode', values: [1, 2],
            message: {en: 'Heating permission applies only in Manual or addition-only mode. Adjust the curve in Auto mode.',
                sv: 'Värme kan ändras endast i manuellt eller tillsatsläge. Justera kurvan i autoläge.'}}
    },
    roomThermostat: {sensor: 'measure_temperature', enabled: 'boolean_NIBE.h47394_room_control',
        target: 'target_temperature.h47398_room_setpoint'},
    mirrors: [{role: 'heating', capability: 'target_temperature',
        register: 'target_temperature.h47398_room_setpoint', writable: true,
        options: {title: {en: 'Room target', sv: 'Önskad rumstemperatur'}, min: 5, max: 30, step: 0.1}}],
    addressModes: {
        modbus40: {label: 'MODBUS 40 + TCP', addressBase: 0},
        nibegw: {label: 'nibegw-esp', addressBase: 40000}
    },
    // Full NIBE ids on MODBUS 40. nibegw-esp is a per-connection offset, never
    // a different pump table. All mapped ids are holding registers in both modes.
    transport: {port: 502, unitId: 1},
    role: {
        priorityRegisterName: 'measure_enum_NIBE.h43086_priority', priorityRawOff: 10,
        priorityToRole: {10: 'main', 20: 'hotwater', 30: 'heating', 40: 'pool', 41: 'pool', 50: 'main', 60: 'cooling'},
        // Experimental covered consumption, not whole-pump metering. See docs/f-series.md.
        // Prefer the mean; instantaneous power remains available for comparison.
        powerSources: [
            ['power_sample.h43375_compressor_mean', 'measure_watt_NIBE.h43084_additive_effect'],
            ['measure_watt_NIBE.h43141_compressor_motor', 'measure_watt_NIBE.h43084_additive_effect']
        ],
        producedRegisterForRole: {
            heating: 'meter_kwh_NIBE.h42439_heating_produced',
            hotwater: 'meter_kwh_NIBE.h42437_hotwater_produced',
            pool: 'meter_kwh_NIBE.h42443_pool_produced',
            cooling: 'meter_kwh_NIBE.h42441_cooling_produced'
        }
    },
    alarm: {registerName: 'alarm_text_NIBE', series: 'f'},
    detection: {
        // Two passes permit a cache miss to warm up without five full slow scans.
        passes: 2,
        requestIntervalMs: 2100,
        discoveryProbe: {address: 40004, direction: Dir.Out, scale: 10, min: -60, max: 60},
        plausible: {
            heating: ({inRange}) => inRange('measure_temperature.h40008_heating_supply', 5, 90),
            hotwater: ({inRange}) => inRange('measure_temperature.h40013_warmwater_top', 10, 90),
            pool: ({inRange}) => inRange('measure_temperature.h40042_pool', 5, 45),
            cooling: ({value}) => value('status_NIBE.h43024_cooling') === 1
                || value('measure_enum_NIBE.h43086_priority') === 60,
            ventilation: ({inRange}) => inRange('measure_temperature.h40025_return_air', 5, 40),
            groundsource: ({inRange}) => inRange('measure_temperature.h40015_source_in', -15, 25),
            solar: ({value}) => (value('measure_power.h42035_solar_current') ?? 0) > 0
                || (value('meter_power.solar') ?? 0) > 0,
            alarm: () => true, diagnostics: () => true, statistics: () => true,
            electrical: ({value}) => (value('measure_current.h40083_sensor_v2') ?? 0) > 0
        }
    },
    compose: {
        capabilities, capabilitiesOptions,
        actions: actions.map((a: any) => ({...a, id: a.id.slice(2)})),
        conditions: conditions.map((a) => ({...a, id: a.id.slice(2)})),
        triggers: triggers.map((a) => ({...a, id: a.id.slice(2)}))
    }
});
