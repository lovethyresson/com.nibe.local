# Indoor temperature sources — implementation plan

Historical design plan for 1.3.0. The implementation is merged and installed on the maintainer’s Homey. See docs/pairing.md and docs/FAQ.md for current behaviour; later UI decisions supersede review/save and timestamp proposals below. Wider hardware lifecycle acceptance and Store permission approval remain outstanding.

## Scope and product model

Extend the existing Heating device's indoor-temperature source choice in pairing and Repair.
Offer every supported, discovered pump source plus **Use Homey sensors**. That option accepts
one sensor or the equal-weight arithmetic average of multiple sensors. One sensor per floor
therefore gives each floor equal influence. No automatic selection of household sensors.

Keep the existing thermostat: desired temperature still writes zone 1 setpoint 2505. Sensor
selection concerns measured temperature only. For a Homey feed, display the confirmed BT50 reading;
show the selected sensors' computed value and the pump's zone average separately in diagnostics.
Do not display a sent value as confirmed before effective readback. If the zone later combines
BT50 with other sensors, make that distinction visible rather than labelling BT50 the zone average.

Keep **Set outdoor temperature (BT1)** as a separate Flow action. Defer Ngenic-style control,
weighted/floor-group averages, schedules, additional zone setpoints and the standalone BT50 Flow
card. Remove the draft BT50 card before release so it cannot compete with the automatic feed.

## 1. Resolve Homey access and release eligibility first

The app currently declares no permissions. Automatic cross-app discovery requires:

- Add `homey:manager:api` to `.homeycompose/app.json` and `homey-api` as a runtime dependency.
- Use `HomeyAPI.createAppAPI({homey})`, `devices.getDevices()` and capability subscriptions.
- Read device metadata, Homey zone paths, availability, numeric temperature capabilities and update
  metadata; subscribe only to selected sources. Do not change third-party devices.
- No credentials for individual sensor vendors and no per-app permissions are required through
  this central device API. A cloud-backed sensor still depends on its own app/cloud connection.

**Release dependency:** Athom's published policy reserves this broad permission primarily for
Tools apps and explicitly gives branded thermostat/device integrations as examples that should
not use it. Its use here needs Athom confirmation before treating Store publication as viable.
Do not contact Athom without Love's authorization. Build a local proof of concept if requested,
without presenting it as Store approval. New permissions also prevent automatic app updates;
explain the user-initiated permission/update step in release guidance.

This permission grants broader access than the feature uses; do not describe the platform grant
as read-only or suggest that the mock's source selection is an OS permission dialog. No documented
sensor-only manifest permission was found. `homey:app:<id>` permissions access cooperating apps'
custom APIs and cannot provide a universal sensor picker. If Athom declines, a Flow-fed input is
an explicit reduced-scope alternative, not equivalent automatic pairing.

## 2. Finish the hardware contract

Confirmed on this S1155: 5987 accepts signed tenths of a degree, input 26 follows; input 5986
reports activation, but holding reads and disable writes there fail. BT50 alarms after the feed
stops. BT1 5217 is writable, but physical-sensor fallback is not established. External inputs clear
after consumption; persistent holding readback is not a verification mechanism.

Before unattended operation, measure and record:

- BT50 refresh requirement and timeout, alarm recovery on resuming fresh readings, and behaviour
  when an app restart or hub outage stops the feed. Test with a person available to restore menus.
- Exact room/zone setup: enable BT50 in 7.5.9.2, select it for the intended zone and heating in
  1.3.3/1.3.4, and remove the previous controlling sensor when replacement is intended.
- Confirm zone setpoint 2505 still follows the pump's target control after this configuration.
- Whether source selection / external activation has any supported writable route on this firmware.
  Do not assume there is one, or promise automatic return to the wireless sensor.
- Confirm warm-start and clean deactivation procedures. Do not leave a test with an enabled,
  unfed BT50; complete manual handover or an explicitly agreed supervised feed.

## 3. Discovery and source model

Reuse the existing detection pipeline and shared connection. Discover supported pump source
candidates with correct labels (climate-system averages versus individual BT50), sample them,
show actual values, and retain the saved choice. Probe all supported candidates; do not imply
we can enumerate every named wireless room sensor from the current Modbus map. Expand supported
candidates when their mappings/meaning are verified; never fabricate zone names from register IDs.

Detect BT50 support separately from whether it currently has a value: a disabled or empty input
must not hide the new feature. Distinguish supported/enabled, supported/setup required, unsupported,
and connection failure/unknown. Read-only discovery must never activate a feed or write a test.

Homey discovery includes standard temperature capabilities and temperature sub-capabilities with
known Celsius semantics. Unknown custom capability types need an explicit adapter, not guessing
from a name or a number. Store device ID + capability ID, never the display name. Show full room
path, capability label, value, source app and freshness/availability. Exclude Nibe Live's own
outputs to prevent feedback loops. Suggest room sensors, but keep other eligible measurements
inspectable; show why stale/unavailable or non-room measurements are unsuitable. Never select all.

## 4. Pairing flow

Keep the existing visual language, but separate device/features selection from temperature setup.
Pairing: discover pump → select devices/features → indoor temperature source (Heating only) →
select Homey sensors if chosen → review/create → guided pump activation and verification.
Repair: existing features preselected → indoor temperature source with current selection → change
sensors if requested → review/save. Offer a direct temperature-setup entry when feasible so a user
fixing a sensor does not have to repeat unrelated detection or feature configuration.

The source step is a separate next view, not a nested wizard in the Heating feature card. Choosing
NIBE skips Homey-sensor selection and pump activation. Back preserves drafts; save/create are explicit
commit points. Keep existing controls, device identity and Insights intact during sensor changes.

The sensor picker starts with search and **Show all sensors**; no inventory or filter panel is
shown by default. Search reveals matching sensors, while Show all reveals the complete browser in
Homey's room order. Selected sensors remain visible independently of the search, with removable
chips and an average. Clearing search returns to the quiet initial state without clearing selection.

Use **Let your rooms guide the heating** for the source step. Describe **Use Homey temperature
sensors** as choosing one room or averaging several for a representative indoor temperature.
No savings claims, no automatic selection over the existing NIBE source. Preserve NIBE red,
centered headings, compact cards and disclosures. Put analytics consent at final pairing review.

1. **Source:** preserve detected NIBE options; append **Use Homey sensors** with explanatory text.
   Existing selections remain selected. Missing permission / unsupported pump gets a clear reason.
2. **Sensors:** a searchable multi-select browser designed for 30+ sensors. Search across name,
   full floor/room path, device type and source app, ignoring case/accents. Add room/floor and
   device-type filters. Group results by room in Homey’s saved hierarchy and sibling `sortIndex` order, with locale-aware
   name ordering for siblings without a custom position. Use that same order in room filters,
   search results and review; filtering must not reorder remaining rooms. Every row shows device name, type/app, temperature
   and reading age. Keep unavailable/non-room readings inspectable with reasons. Preserve selections
   across searches, filters and pages; show removable selected chips and a selected-only view.
   Review the full selection and resulting temperature before pump setup. One selection is a
   direct feed, two or more an equal average.
   Live preview: individual readings plus "Temperature to send: 22.0 °C · Average of 3 sensors".
   Show all required sensor coverage; do not invent a floor average if users select unequal counts.
3. **Pump setup:** explain broad Homey permission separately from the manual pump steps. Establish
   the feed's durable owner before asking the user to enable an external input. Prefer creating
   the Heating device in "Finish setup" state, then use the same Repair wizard to activate. Pairing
   cancellation before creation causes no writes; afterwards incomplete setup is visible/recoverable.
4. **Verify:** use a fresh computed temperature, verify effective input 26 and report activation
   separately from zone configuration. Let the user confirm the zone settings where unreadable.
   Do not mark control verified merely because the holding write was acknowledged.
5. **Complete:** show active sources and where to change them. Keep the target-temperature dial.

Once the user has enabled the pump input, closing a wizard must not silently terminate the only
feed. Persist that transition and provide explicit resume/deactivate instructions; it must not be
tied to the lifetime of a pairing session or browser view.

## 5. Repair and ongoing operation

Repair opens a concise summary: selected source(s), computed temperature, last successful delivery,
pump BT50 reading and any action needed. Actions: change sensors, retest setup, return to NIBE.
Preserve all other features, capabilities, device identity, Flows and target temperature.

Changing Homey sensors keeps the previous valid feed until the new selection is validated and
saved atomically. Cancelling keeps the previous configuration. Returning to NIBE guides the user
through selecting the original sensor and disabling external BT50; stop the feed after confirmed
handover, not when they first click the button. Do not claim automatic rollback on this pump.

One persisted feed owner per pump/BT50 input, independent of pairing sessions. Use the shared wire
queue, bounded retries, effective-readback verification, restart recovery, and no competing writers.
A candidate 30-second refresh cadence must be validated; send regularly even if temperature is
unchanged. Sensor observation time, successful subscription contact and value-change time are
separate: fetching a cached number must never refresh its provenance. Some integrations only
report changes, so design freshness policy against actual reporting behaviour rather than equating
an old `lastUpdated` with a dead device.

For v1, require all selected sensors to meet the configured freshness policy; do not silently
change a three-floor average to two floors. On loss, show the failed source and notify once.
Do not replay stale measurements indefinitely or substitute a setpoint. Pump fallback/timeout is
a release acceptance condition: if no safe automatic return exists, explicitly document manual
recovery and observed pump alarm/control behaviour. Test hub failure, not only clean app shutdown.

## 6. Implementation and verification order

1. Access-policy decision and small local sensor discovery proof; hardware lifecycle verification.
2. Pure source/configuration types, aggregation and freshness policy, persisted feed state machine.
3. Homey API adapter + shared-connection feeder, with simulated Modbus transport tests.
4. Shared pairing/Repair source component, guided activation and manual handover; six languages.
5. End-to-end install and supervised live validation, then release documentation and permission review.

Tests cover discovery of disabled-but-supported BT50, stale/unknown readings, Celsius conversion,
multiple temperature capabilities, device rename/removal, three-sensor averaging, invalid values,
role and pump ownership, session cancellation, staged configuration, API loss, socket reconnect,
app restart, simultaneous Flow attempts, alarm/recovery and manual return to the original source.
Run typecheck, relevant unit/integration tests and Homey publish validation. Test live cards and
pairing/Repair on Vitahuset only after the planned recovery procedure is ready. Install with plain
`homey app install`; do not use `--skip-build`.

## Sources

- [Homey permissions and Store policy](https://apps.developer.homey.app/the-basics/app/permissions)
- [HomeyAPI.createAppAPI](https://athombv.github.io/node-homey-api/HomeyAPI.html#createAppAPI)
- [Device capability subscriptions](https://athombv.github.io/node-homey-api/HomeyAPIV3.ManagerDevices.Device.html#makeCapabilityInstance)
- [Hardware test record](external-sensors.md)


## Shared two-stage setup, including hot water

Refactor navigation around two stages: (1) choose devices/features, (2) configure each selected
function. Heating and hot water use the same navigation shell, draft handling, Back behaviour
and explicit final commit. Sensor search, review and pump verification are substeps of Heating
setup, not additional feature-selection screens.

Move the existing hot-water tank configuration out of the pairing device card and Repair feature
list into **Hot water setup**, shown after device/features selection. Reuse `assets/pair/tank.js`
and its existing validated tank choices, custom tank capacity, inlet-temperature configuration
and no-estimate option. Keep current saved values on Repair. This refactor changes navigation,
not the hot-water calculation or calibration semantics.

For pairing with both functions selected, queue Heating setup then Hot water setup, then final
review/create, with durable activation state for any Heating feed already started. Selecting
only Hot water skips Heating entirely. Per-device Repair configures only that function. Back
retains all draft selections; cancelling before commit leaves stored hot-water settings unchanged.
Removing an estimate remains explicit and explains its capability/history effect.

Use **Setup your heat pump** and **Verify settings** for the Heating actions. Verification must
have Back returning to pump setup, preserving the draft and any already active feed. Back is
navigation, not deactivation. Explain that verification starts regular temperature updates;
never stop a feed merely because a user navigates back. Minimize the gap between manual pump
activation and starting verification; incomplete setup must remain recoverable through Repair.

Test both functions together, each alone, Back through all steps, cancellation, Repair with
existing custom tank settings, and saving only after every required configuration is valid.


### Top-level setup navigation

After device/features selection, show **Device Setup** with clearly named **Heating Setup** and
**Hot Water Setup** entries for the selected functions. Show Ready / Needs setup status and allow
revisiting each section before final review. Keep the active section name visible throughout its
substeps. Per-device Repair exposes that device's relevant setup section only. Back from a section
returns to Device Setup; Back within a section returns to its previous step and retains drafts.
The shared overview replaces the implicit sequence between unrelated Heating and Hot Water pages.
