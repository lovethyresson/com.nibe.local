# F-series support (experimental)

One `nibe_f` driver uses the same connection, detection, device, Flow and pairing/repair
implementation as `nibe_s`. There is no pump-model picker. Its curated superset contains 61
registers, checked for consistent names, units, widths, signedness and factors wherever they
occur in these seven model exports:

- F1145/F1245
- F1155/F1255
- F1345
- F1355
- F370/F470
- F730
- F750

These are documentation-based mappings, not a claim of hardware validation. None has been
verified on a live F-series pump yet. Shared capability detection samples the superset and
recommends functions from movement or plausible readings; unsupported capabilities are omitted.
Export inclusion alone does not establish that an accessory is fitted or supported by the
owner's firmware. Newer firmware may expose additional registers not yet mapped here.

## Sources and reproducible audit

The register reference is the collection of ModbusManager exports in
[yozik04/nibe](https://github.com/yozik04/nibe/tree/master/nibe/data), downloaded 2026-09-12.
For example, `f730.csv` identifies ModbusManager 1.0.9, product F730, database 8310,
export date 20200624. The upstream CSVs remain in ignored `dev/csv/`; no upstream library
code or entire export is bundled. The register table records selected protocol facts and
uses this app's capability descriptions.

Download the seven `f*.csv` files named above to `dev/csv/`, then run:

```sh
node --import tsx dev/audit-f-registers.mjs
```

The audit fails on missing definitions, conflicting source names/units/formats, or mismatched
widths, signedness and factors. It does not prove the behavior of undocumented addresses on
models that omit them. Keep ambiguous registers out of the shared table until an actual
compatibility rule can be established.

Gateway behavior is checked separately against:

- [NIBE MODBUS 40 FAQ](https://installer.nibe.eu/download/18.47aa975e18a8b43315f342a/1696946128721/FAQ%20Modbus%2040.pdf)
- [NIBE MODBUS 40 installer manual](https://professional.nibe.eu/document/Installat%C3%B6rshandbok/031725-10.pdf)
- [nptr/nibegw-esp](https://github.com/nptr/nibegw-esp), especially `main/sys_modbus.cpp`

## Connections

Select the gateway, its IP, TCP port and Modbus unit ID during pairing. The same settings
are available afterwards and are shared across the pump's function devices.

| Gateway selection | Homey request for outdoor temperature |
| --- | --- |
| MODBUS 40 + TCP | Holding register / FC3, wire address **40004** |
| nibegw-esp | Holding register / FC3, wire address **4** |

MODBUS 40 needs a Modbus RTU-to-TCP bridge; Homey does not directly connect to RS485 or
raw serial-over-TCP. The bridge must preserve the full NIBE register address. The compact
address alias available in some MODBUS 40 versions is not this driver's selected convention.

The register table always retains canonical NIBE ids. Only the connection applies the
configured offset. Upstream nibegw-esp subtracts 40000 for the holding-register range used
by all currently mapped registers. Other firmware variants need their wire behavior verified;
there is no generic promise that every product called “Nibe gateway” speaks Modbus TCP.

32-bit reads use two words, low word first. Verify the pump/gateway word-swap configuration
against known counters. It is never changed automatically. The F poll watchdog permits up to
120 seconds as a recovery ceiling, not a target polling interval. Detection uses two sequential
passes (S retains five), allowing an initially empty gateway cache a second chance. It can
still take several minutes: requests are spaced at least 2.1 seconds apart even when cached
TCP replies are immediate, with progress after each parameter. An exception 04 is retryable, not proof of an unsupported register.

### LOG.SET and slow reads

The owner's follow-up supersedes the initial claim that only LOG.SET registers are readable.
NIBE's manual, English pages 13–15, specifies up to 20 broadcast parameters, updated twice
per second, and individual on-demand parameters taking 2.1 seconds. Its protocol table permits
two words for a single 32-bit parameter. The app does not batch unrelated parameters.
Upstream nibegw-esp differs at the TCP boundary: it may answer from cache immediately and
request a refresh in the background. The owner's modified firmware must be checked for this
behavior; response duration does not prove freshness.

The shared engine has an opt-in F polling policy. Priority, both compressor-power candidates,
immersion power, selected production counters and room-control inputs remain in each frequent
poll, along with key temperatures and the alarm. Allocation/COP and device updates are published
before one background parameter is requested. Remaining selected settings, statistics and
internal diagnostics rotate by oldest attempt, with at least 60 seconds between attempts of
the same parameter. A full rotation can take several minutes. Writes retain priority over queued
reads. Background results never reuse old readings as new energy or thermostat inputs.
This policy does not discover or modify LOG.SET: frequent inputs left out of that file can still
slow the frequent poll or carry cached values. Configure them in ModbusManager before assessing
energy allocation across operating-state transitions.

Suggested F730 LOG.SET baseline (16 logical parameters, including two 32-bit counters):

| Purpose | Canonical NIBE registers |
| --- | --- |
| Priority and electrical allocation | 43086, 43375, 43141, 43084 |
| Delivered energy for COP | 42437, 42439 |
| Room reading and regulation | 40033, 47394, 47398 |
| Outdoor, supply, return, hot-water top/middle, exhaust air | 40004, 40008, 40012, 40013, 40014, 40025 |
| Alarm | 45001 |

Choose only parameters available in the owner's ModbusManager export; retain its capacity
check when generating the file. Pool/cooling installations can add 42443/42441 where supported.
Unavailable inputs stay unavailable; do not substitute made-up readings. The baseline is shared
F-series register data, not a mapping specific to this volunteer's gateway.

## Available functions and current limits

Heating, hot water, pool, cooling and solar use the same function-device structure as S-series.
Ventilation is grouped with Heating; compressor diagnostics, electrical readings, runtime
statistics and F-series alarms belong on Main. Missing accessories that return a steady zero
are not enough to recommend Pool, Cooling or Solar. Solar may be detected at night from a
positive lifetime generation counter; a new, inactive system may need manual selection.

The test driver exposes a reviewed set of controls: heating curve/offset, room regulation,
room target/influence, hot-water comfort, temporary boost, periodic hot-water increase,
normal exhaust-fan speed, operating mode, heating permission and immersion permission.
Settings must be read successfully to be recommended. BT50 itself remains read-only.

Single-word F writes use FC16 (Write Multiple Registers with one word), compatible with
MODBUS 40; S retains its existing FC6 path. The shared write lane validates values and verifies
readback, allowing 2.1 seconds between F-series verification retries for cache refresh. The
gateway must actually permit writes. Heating permission is accepted only in
Manual/addition-only mode; immersion permission only in Manual. The app never switches mode
implicitly. Enabling room regulation requires a usable indoor reading; setting the room target
also requires regulation to be enabled. A successful ACK without matching readback is an error.

The first build enables experimental compressor-plus-immersion allocation and rolling
per-function COP through the shared engine. It prefers 43375 + 43084, falling back to
43141 + 43084; both components must answer. Counters 42437 (hot water) and 42439 (heating)
include compressor and addition production. 42443 covers pool compressor production;
42441 covers cooling on models that expose it (not in the F730 export). All are u32,
0.1 kWh steps. The F370/F470 export has none of these production counters.

COP is delivered-energy growth divided by allocated electrical energy over the shared
observed window, with the existing missing-data/restart safeguards. No Main total COP is
invented. The result is experimental: auxiliary electrical loads are excluded and production
is total-system scope, which may not match a single compressor on a multi-pump installation.

A newly found [NibePi F730 correction](https://github.com/anerdins/nibepi/pull/35) reports that
43141 needs raw ×10 W, contradicting the export's factor 1. This build retains the export
scaling pending hardware comparison; it is not a validated electricity meter. The mean
register's real scaling must also be checked, not assumed correct because it is preferred.

The F730 export also lists consumed-energy counters: ventilation 41846, hot water 41848,
and heating 41850 (all u32, factor 10). The other six exports do not list them. These are
included as internal diagnostic registers, not yet used for energy allocation or displayed
as verified energy meters. Confirm availability, scope, update cadence and reset behavior
before connecting them to shared per-function accounting.

F-series Flow cards use an `f_` namespace because Homey's Flow IDs are app-global. Their
listeners remain in the shared driver/device classes; S-series IDs are unchanged.

## Remote validation and debug logging

1. Pair with the F-series driver and correct gateway setting. If the gateway was previously
   paired as S-series at the same address, remove that incorrect device before pairing F.
2. Enable **Debug logging** on Main. F-series dumps use the last observed readings, with no
   additional full scan. The dump includes decoded/raw values, actual wire address, function
   code, word count, hexadecimal words, receipt time, request/queue duration and read errors.
   An immediate post-connect dump can be empty; ongoing snapshots supply later observations.
3. For 60 seconds after enabling debug, existing reads are also captured up to three times per
   register, with a global limit of 200 samples. This adds no independent polling loop or
   extra refresh requests. Slow gateways or unselected readings may yield fewer than three.
4. Collect a Homey diagnostic report promptly. Compare a few timestamped readings with the
   pump screen, then repeat during heating, hot-water production and idle operation.

Homey already supplies the app version. The logs do not claim that receipt time is measurement
time: nibegw-esp returns cached values and requests refreshes in the background. A successful
read cannot establish freshness. Correlate changes with the pump screen and gateway logs.
`LOG.SET` selects frequently broadcast values; it does not define the app's supported table.

An F730/nibegw test verifies that combination. MODBUS 40 hardware and the other F models still
need independent validation, even when simulated transport tests pass.

## Energy source decision: apply the S-series lessons

See [Home Assistant community and implementation research](f-series-energy-research.md) for
owner evidence, source limitations, and the longer recording needed to validate allocation.

External meters are not assumed for normal support. The intended inverter-F allocation path
is the existing shared power integrator plus operating priority 43086. Compare instantaneous
compressor electrical power 43141 with the 10-second mean 43375, and add internal immersion
power 43084 (raw × 10 W). 43375 is included in diagnostics for this comparison. Neither is
selected as a verified whole-pump input: auxiliary consumption and multi-compressor scope
remain unresolved. Fixed-speed models have no documented compressor-watts source in the
seven exports checked; this remains a coverage gap, not a reason to invent watts from runtime.

The source hierarchy must not automatically prefer counters just because they are labelled
consumption. [S-series attribution lessons](energy-attribution.md#how-accurate-the-attribution-actually-is)
record a false +37% error from a delayed, quantised lifetime counter and the removal of the
correction based on it. [The S735 verification](../tasks/s735-energylog-verification.md#the-caveat-38213823-lag-the-per-function-log-️)
shows completed-cycle energy appearing after the pump returned to idle. A counter delta must
not be charged to the operating state at receipt, and asynchronous counters must not be
subtracted to manufacture an idle remainder.

The F730 native counters remain diagnostic cross-checks pending characterization of their
scope, cadence and resets. They are not the default live allocation source. Validation needs
whole cycles and time for delayed counters to settle, including idle and auxiliary-only periods.
The S-series's apparently valid but unused power register 2727 is another relevant warning:
[responding is not enough](../tasks/lessons.md). A nonzero, changing compressor reading still
does not prove that it includes all electrical loads.


## Room sensor and thermostat research

F730 is supplied with BT50, but it can operate without installing it. A connected sensor can
show indoor temperature without controlling heating; room influence must be enabled in menu
1.9.4. See the [NIBE installer manual](https://assetstore.nibe.se/hcms/v2.3/entity/document/884709/storage/ODg0NzA5LzAvbWFzdGVy).
HA likewise omits the temperature target in automatic/curve mode and exposes it in room-control
mode; [implementation](https://github.com/home-assistant/core/blob/dev/homeassistant/components/nibe_heatpump/climate.py).
An [HA owner/maintainer exchange](https://community.home-assistant.io/t/how-to-connect-to-nibe-heat-pump-without-the-cloud/381099?page=9)
confirms that receiving BT50 alone does not establish room control.

The driver reads BT50 40033, room regulation 47394, target 47398, influence 47402 and curve
offset 47011. Without a usable sensor and enabled room regulation, Heating is class `heater`
and has no room-target dial. When both are present, it becomes `thermostat` with the root
current/target pair. This is re-evaluated on completed polls, including changes made at the
pump. Missing inputs remove the dial; write-time checks protect against stale UI state.
A connected BT50 can still be displayed while regulation is off. The S-series Homey-to-BT50
feed is not offered: F would require a gateway that emulates an RMU room unit.

Debug logging adds a compact snapshot of energy and room-control inputs once a minute for
up to two hours after enabling it. Values are `address=raw/decoded`; missing reads are explicit. Background values are labelled
last-observed with the latest attempt time, which may itself describe a failed refresh.
The normal 60-second transport capture remains. Send the Homey diagnostic report promptly
after a test because its log buffer is finite; toggle debug off/on to start another window.
These are receipt-time observations, not guaranteed pump measurement timestamps.

## First build and simulator

Build locally with `homey app build`, then `homey app validate --level publish`.
This prepares `.homeybuild`; it does not publish or install the app.

Run the synthetic pump from the repository:

```sh
node dev/f-series-simulator.mjs --host 0.0.0.0 --port 1502 --mode modbus40
```

Pair the F-series driver using this computer's LAN IP, port 1502, unit 1 and MODBUS 40 + TCP.
For the alternate scheme use `--mode nibegw` and choose nibegw-esp in pairing. No physical
MODBUS 40 is needed for the simulator. Keep the computer awake while testing.

The simulator spends 120 seconds each in heating, hot water, immersion-only heating and idle.
It generates cumulative production and consumption (0.1 kWh steps), synthetic COP 3 for
compressor heating, 2.5 for hot water and 1 for immersion. The rolling heating COP combines
compressor and immersion periods. Run long enough to exceed the shared COP minimum of
0.1 kWh allocated electricity. Small differences around transitions and quantized counter
steps are expected. `--phase-seconds 600` gives longer steady runs.

To exercise slow on-demand reads while keeping the baseline fast:

```sh
node dev/f-series-simulator.mjs --host 0.0.0.0 --port 1502 --read-delay-ms 2100 --log-set 43086,43375,43141,43084,42437,42439,40033,47394,47398,40004,40008,40012,40013,40014,40025,45001
```

The delayed mode models waiting for replies, not nibegw's asynchronous cache-refresh semantics.
Unrelated block reads are rejected; a single 32-bit parameter still accepts two words.

Restart with `--no-room`, `--no-power` or `--no-production` to test absent inputs and repeat
Repair. Unimplemented registers return Modbus exception 2, input reads and FC6 writes are rejected; the reviewed control addresses accept bounded FC16 writes,
and 32-bit counters use NIBE low-word-first ordering. By default the server binds only to
localhost; the explicit LAN command above allows Homey to reach it. This is a development
fixture, not an emulation of pump control, actual sensor accuracy, gateway caching, defrost
or counter delay. It must never be used as hardware validation evidence.

## Owner handover

See [the first hardware test checklist](f-series-user-test.md).
