# F-series energy: Home Assistant research

Research dates: 2026-09-12, updated 2026-09-20. Scope: electricity consumption and per-function allocation without
requiring an external meter. This records implementation evidence and owner reports separately.
No F-series hardware measurements were made for this research.

## September 23: production depends on metering hardware and variant

Production is not universally absent from F-series. NIBE's F1255 PC product page describes
EMK 300 measuring delivered heat separately for heating/hot water, with/without addition:
https://www.nibe.eu/nl-be/producten/warmtepompen/water-water-warmtepompen/f1255-pc
The manufacturer EMK manual describes a water-flow meter using existing temperature sensors:
https://professional.nibe.eu/document/Asennusohjeet/831222-3.pdf
This is thermal metering, distinct from the external electricity meters excluded from our
normal-support assumptions. Neither kind of accessory should be presumed installed.

There is evidence for F730 production hardware too, but variant matters:

- NIBE's German F730 brochure explicitly lists an integrated heat meter (printed page 13):
  https://www.baulinks.de/bkd_file/nibe/NIBE_F730_S735_Abluft-WP_A4_24S_230714.pdf
- NIBE Swedish installer manual 331666-4, printed page 58, labels the BF1 connection
  **Only in F730 E**. This was verified visually in the diagram; text extraction omits it.
  https://www.rskdatabasen.se/infodocs/MONT/MONT_30_6251305.pdf
  This historical diagram establishes variant differences, not a universal rule for all later
  F730 hardware or countries. Do not infer the tester's exact variant from his country alone.
- A third-party-hosted copy of NIBE release notes records BF1 configuration regression in
  9089R9, corrected in 9089R10 (2021-03-08), and UK built-in flow-meter support in 9089R15
  (2022-10-31). Useful supporting evidence of firmware/variant differences, not a diagnosis
  of this installation; the copy was not retrieved from a NIBE host:
  https://es.scribd.com/document/622017635/F730-v9089R15-CHANGELOG

The September 22 tester diagnostic (c687bc94-2f98-4db8-b759-39e8994f8a3e) contains BF1
40072 = 0x8000 (unavailable), observed at 15:21:14 UTC. EP14 heating production 44300 stayed
26660.4 kWh at 20:27:11 and 20:46:10 UTC; hot-water production stayed 352.5 kWh. No hot-water
cycle occurred. Native counter labelled heating consumption 41850 rose 56771.4 -> 56773.0 kWh
between 20:26:51 and 20:45:50 UTC. These observations do not validate relabelling consumption
as production, and a nonzero static counter does not establish a usable production source.
The retained stdout contains only 100 entries and no detailed two-hour capture/sweep lines.

Conclusion: heat production exists for suitably equipped F-series, including some F730
variants, but is unverified and plausibly unavailable on this tester's installation. Ask for
one observation of the pump's own Service info heat-meter page during heating: is BF1 present
and reporting flow, and do delivered heating kWh advance? Also record exact model variant and
firmware. If the pump itself has no working heat-meter data, stop register hunting and leave
production/COP unavailable. If its display advances while Modbus counters do not, investigate
mapping/firmware/gateway exposure. No external meter purchase or invented flow/COP estimate is
part of the proposed support. Consumption allocation remains independently useful.

## September 20 decision: continue a bounded inverter-model beta

The compressor scaling uncertainty is now resolved strongly enough to correct register metadata.
Both **43141 and 43375 require raw ×10 to obtain watts**. The tester's reported 57 therefore
represents 570 W, assuming it is the unchanged raw value currently displayed by the app.
This is a source-unit correction, not a change to the shared allocation business logic or
a gateway-specific mapping.

Evidence chain:

- [F730 owner test and correction of both registers](https://github.com/anerdins/nibepi/pull/35#issuecomment-1804048498).
  The PR quotes NIBE Support confirming 0.01 kW increments; a later reply says the correction
  applies to inverter units. This is a published account of support correspondence, not an
  independently retrieved NIBE specification. The NibePi PR itself remains unmerged.
- [Independent confirmation by elupus](https://github.com/anerdins/nibepi/pull/35#issuecomment-1874696305)
  links the correction already in the Python nibe library.
- [Python library correction](https://github.com/yozik04/nibe/blob/3eb7b88cb7e61553bbf3d53831a17faba7cb4b61/nibe/data/extensions.json#L162)
  covers F730, F750, F1155/F1255 and F1355.
- The [current generated F730 definitions](https://github.com/yozik04/nibe/blob/master/nibe/data/f730.json)
  actually contain factor 100 and unit kW for both registers. The library loads this model data;
  this is not merely an unused proposed override. Home Assistant's
  [integration manifest](https://github.com/home-assistant/core/blob/dev/homeassistant/components/nibe_heatpump/manifest.json)
  depends on this library. Raw 57 / 100 kW = 570 W.

Earlier research found the PR but did not follow its comments through to the corrected library
data. Retaining factor 1 was too conservative once that implementation evidence was available.

The useful promise is **estimated compressor-plus-immersion energy allocated to heating and
hot water**. The compressor signal describes inverter output to the motor; it does not establish
whole-unit mains consumption, inverter losses, fan, circulation-pump or standby consumption.
Do not compensate with invented percentages. Main can remain near zero while unmeasured
auxiliary consumption exists. Other inverter models have supporting definitions, but only the
F730 has this tester's hardware evidence; fixed-speed models remain a separate unsupported
energy-source question.

Production is still unresolved on this installation. The library labels 41848/41850 as consumed
energy and 44298/44300 as heat-meter production (compressor plus addition, EP14). There is no
evidence here for exchanging these labels based on lifetime ratios. The app's selected
42437/42439 have returned zero; readable nonzero alternatives do not yet establish current
production. Compare increments over the same complete cycle, including settling time, before
using alternatives for COP. Excluding electrical auxiliaries also limits the scope of any COP.

The prepared 1.3.5 now corrects both compressor units in register metadata and adds the
bounded capture described below. Next validation should use this build; retain the shared allocator; verify idle → hot water → idle and a heating
cycle when available, with timestamped raw power, immersion, priority and allocated energy.
Check that power updates, energy follows the active function and reconnects do not create
spikes or stale allocation. Record production/native counter deltas alongside this capture.
Naturally occurring immersion operation needs its own confirmation when available; do not
require the tester to force it. External meters are not a prerequisite for these checks, but
without one they do not establish absolute electrical accuracy.

Go if fresh power and priority reliably support the promised allocation. Keep COP unavailable
until its production source is verified. Stop energy support for configurations where no
trustworthy power source can be established; do not widen the claim to every F-series model.

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
reply specifying raw ×10 W. The September 20 follow-up above confirms this correction in the
Python library for both compressor registers; the template's other allowances remain unverified.
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
