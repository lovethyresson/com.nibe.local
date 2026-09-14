# F-series energy: Home Assistant research

Research date: 2026-09-12. Scope: electricity consumption and per-function allocation without
requiring an external meter. This records implementation evidence and owner reports separately.
No F-series hardware measurements were made for this research.

## Findings that affect our implementation

One shared allocator is still the right architecture. However, the evidence does not establish
a universal, complete F-series electricity source. Inverter models have a useful compressor
power signal; some models have native consumed-energy counters. Neither establishes whole-pump
accuracy on every F-series installation. Detection must establish available energy inputs as
well as available device functions.

### F730 native consumption counters are used by real owners

In January 2024, an F730 owner described using NibePi/MQTT to expose consumed energy for heating,
hot water and ventilation in Home Assistant. Their fix added energy metadata so HA could use
the sensors. This is evidence of practical availability, not an accuracy test.
[Owner report, post 17](https://community.home-assistant.io/t/support-heat-pumps-in-energy-dashboard/650033/17).

NibePi's F730 definitions corroborate the names and decoding: 41846 ventilation, 41848 hot water,
41850 heating, all unsigned 32-bit values divided by 10, in kWh. The receive path divides values
by the register factor and publishes them to MQTT. These are pump-provided values, not a
NibePi allocation algorithm. The field named `raw_data` in this receive path is already scaled;
do not treat another integration's “raw” field as raw Modbus words.
[Definitions](https://github.com/anerdins/nibepi/blob/1aa36b02986d88778d765be738c68fb2bcabdbea/models/F730.json),
[receive implementation](https://github.com/anerdins/nibepi/blob/1aa36b02986d88778d765be738c68fb2bcabdbea/index.js#L1095).

The December 2022 HA discussion contains both an F730 owner's discovery of consumption values
and a community administrator's report that members found substantial disagreement with
dedicated meters. No paired measurements or quantified test protocol are supplied. Treat that
as a reason to investigate, not proof that every F730 counter is inaccurate. The same discussion's
blanket claim that F-series cannot report consumption is contradicted by its own later reports.
[Posts 747–749](https://community.home-assistant.io/t/nibe-uplink-api-component-non-s-series/18173?page=37).

### F750 provides different counters

A November 2022 issue includes actual F750 readings for 43144 and 43305, labelled compressor
time factor and compressor time factor hot water, with kWh units and approximately 4954.7 and
769.3 kWh. The issue is about HA statistics metadata, not energy accuracy. It confirms readings
exist but does not demonstrate inclusion of immersion, fans or controls, or synchronized updates.
Do not implement total-minus-hot-water as heating until scope and timing are established.
[Owner's issue](https://github.com/elupus/hass_nibe/issues/154).

### Home Assistant does not supply the missing allocation algorithm

The core NIBE sensor implementation maps W/kW to power measurements and Wh/kWh/MWh to
`TOTAL_INCREASING` energy sensors. Its sensor value is the decoded coil value. This provides
statistics compatibility; it does not distinguish thermal production from electrical input or
calculate a whole-pump electricity total.
[Sensor implementation, dev branch inspected on research date](https://github.com/home-assistant/core/blob/dev/homeassistant/components/nibe_heatpump/sensor.py).

The coordinator accepts coil-update callbacks, polls on a 60-second interval and skips polling
coils already supplied through its update seed. This is useful transport reuse, not an assurance
that power and operating priority represent the same measurement instant.
[Coordinator](https://github.com/home-assistant/core/blob/dev/homeassistant/components/nibe_heatpump/coordinator.py).

### Community estimates fill the missing loads with model-specific assumptions

An F1255-6 R PC owner published an HA template in July 2024 combining compressor power,
internal electric addition and allowances driven by supply/brine pump speeds. They compared
against their household meter and reported approximate agreement for hot water; winter heating
validation was still pending. Their formula includes custom offsets and a compressor multiplier.
It is evidence that users build estimates, not a reusable calibration for F730 or all F-series.
The ×10 compressor factor conflicts with our exported definition. Subsequent research found
[NibePi PR 35](https://github.com/anerdins/nibepi/pull/35): an F730 owner reports a NIBE support
reply specifying raw ×10 W. This strengthens the scaling concern; retain both raw readings
and do not assume either the template or the exported factor is universally correct.
[Owner's implementation, July 17 post](https://gathering.tweakers.net/forum/list_messages/2106834/3).

Another HA discussion proposes rated compressor watts multiplied by runtime, or a power template
integrated over time. The NIBE model is unspecified and no validation is provided. This is an
explicit estimation technique, not evidence for an automatic fixed-speed F-series power source.
[Runtime discussion](https://community.home-assistant.io/t/converting-time-to-kwh/527965).

### Similar hardware does not imply the same transport

ESPHome-Nibe is a UDP gateway: it acknowledges pump telegrams, forwards them and accepts requests
for additional parameters. Its documentation describes up to 20 configured registers per
telegram and says payload parsing happens externally. This differs from the user's modified
nibegw-esp Modbus TCP server. HA success with a LilyGo board validates the hardware approach,
not TCP address offsets, caching or freshness for the user's firmware.
[ESPHome-Nibe implementation documentation](https://github.com/elupus/esphome-nibe).

HA documents both gateway emulation and physical MODBUS40 connections; it labels the latter
RCU connection support untested. Consequently HA's compatibility list is not hardware verification
of our MODBUS40 + TCP bridge path.
[HA connection documentation](https://www.home-assistant.io/integrations/nibe_heatpump/).

## Consequences for Nibe Live

The checked register definitions support this candidate for inverter models:

`estimated covered power W = compressor W (43141 OR 43375) + internal addition W (43084 × 10 raw)`

43141 describes inverter-to-compressor power; 43375 is its mean calculated every 10 seconds.
They are alternative readings, not additive sources. Neither description promises fans,
circulation pumps, control electronics or inverter losses. Use the existing shared integrator
and priority mapping (43086) for the covered consumption, with a clear estimate scope. A 10-second
mean can also cross a priority transition: it is not automatically the best live attribution source.
[NIBE register documentation](https://headless.nibe.eu/download/18.9a97aba184a9b5f272c80/1669796538703/F1355.pdf).

Do not invent a generic standby offset or infer watts from pump-speed percentages. A pump can
run auxiliaries concurrently with another function. Priority-based assignment is an accounting
policy, not a physical measurement of every component. The F730 ventilation counter may help
characterize this, but its exact scope remains open. Multi-compressor coverage also needs evidence.

F730 counters should initially be comparison channels. Their native function labels mean a delayed
heating increment would still belong to heating if later enabled; it must not be reassigned to
whatever priority happens to be active on receipt. Conversely, differentiation cannot recover
reliable instantaneous watts from a delayed counter. Never add counter deltas on top of an
integrated estimate of the same consumption.

This follows our [S-series evidence](energy-attribution.md#how-accurate-the-attribution-actually-is):
the apparent +37% discrepancy was invalid because of counter timing/quantization. The
[S735 verification](../tasks/s735-energylog-verification.md) demonstrates late lifetime-counter
increments after a completed hot-water cycle. These lessons justify aligned whole-cycle comparisons,
not automatically discarding all native counters or preferring them over live power.

The generic driver can share all allocation machinery while selecting supported sources from
capabilities. The seven exports checked so far do not supply a documented compressor-watts
source for every fixed-speed model. There is currently insufficient evidence to promise full
automatic energy allocation across all F-series models without additional assumptions.

## What the F730 owner needs to help validate

The existing 60-second capture, capped at three reads per register, establishes transport and
decoding. It is insufficient to characterize counter cadence and energy allocation. Add an opt-in,
bounded recording over several hours (ideally a day) of the small energy-related register set:

- 43141 and 43375 compressor power, 43084 immersion power, 43086 priority.
- 41846/41848/41850 native function counters.
- Compressor running/frequency and defrost state, with timestamps, read failures and actual
  sample intervals. Confirm the relevant register identities against the F730 export.

The recording must span idle, heating, hot water, transitions and naturally occurring immersion
operation. Retain repeated unchanged values at a modest cadence to distinguish a stable signal
from missing observations; keep raw words and decoded units. Put rapidly changing energy inputs
in the gateway's configured periodic register list where supported, within its capacity.

Compare integrated input and native deltas over completed cycles plus counter-settling time.
Check whether each counter advances during the expected function, whether immersion affects it,
and whether ventilation advances independently. Receiving TCP data does not establish pump-side
freshness; gateway firmware behavior must be inspected or separately observed.

The owner can do this without buying a meter. It establishes availability, consistency and timing.
It cannot independently establish absolute electrical accuracy or prove all auxiliary loads are
included. No reviewed source removes that limitation. Keep energy support explicitly experimental
until these questions are resolved; a register-reading driver alone does not fulfill the app's
per-function energy promise.
