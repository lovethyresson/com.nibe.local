**Multiple climate systems: research and proposed major release**

Research date: 2026-09-27. Proposal only; no runtime changes or version bump.
Repository inspected at `3e9fe34`. Existing beta work and subsequent changes are outside
this proposal. Upstream references below are live branches, inspected on the research date.

**Recommendation.** Build shared circuit controls for F and S, and a separate, optional
distribution stage for the electricity already allocated to Heating. Do not ship an
automatic valve-percentage split. Offer an explicitly configured split as the simple
baseline; qualify a temperature-assisted estimate through a bounded pilot before making
it a product feature. No new meter should be required for the basic feature.

**What the hardware tells us.** A climate system is a water circuit, potentially serving
many rooms. EP14 is a compressor/refrigerant module, not synonymous with circuit 1.
EP21 identifies the additional climate system. Both circuits can draw heat together;
the secondary circuit mixes hot supply water with its own cooler return. NIBE describes
this arrangement and independent curve/offset regulation in its
[F1145/F1155 system documentation](https://installer.nibe.eu/webdav/files/GB/Technical/Docking%20Diagrams/Ground%20Source/F1145%20F1155.html).

Representative exports inspected: F730, F1155/F1255, F1345, S1155/S1255 and S735.
The search found no EP21/circuit-2 heat-energy counter or circuit flow meter in these
exports. This is not proof that no future model/accessory can provide one. BF1/EP14
flow is source-side flow and must not be relabelled as secondary-circuit flow.

Useful canonical F-series circuit-2 definitions are:

| Purpose | Register(s) |
|---|---|
| Supply / return / room temperature | 40007 / 40129 / 40032 |
| Calculated supply target | 43008 |
| Mixing-valve state / circulation pump state | 43095 / 44746 |
| Curve / offset | 47006 / 47010 |
| Accessory configured / room regulation enabled | 47302 / 47393 |
| Room target / influence | 47397 / 47401 |

These appear across the inspected F exports. Definition existence does not establish
readability on the tester's gateway. Accessory activation is configuration, not a
daily on/off control; read it for discovery. Keep service settings out of ordinary controls.
[F730 definitions](https://github.com/yozik04/nibe/blob/master/nibe/data/f730.json),
[F1155/F1255 definitions](https://github.com/yozik04/nibe/blob/master/nibe/data/f1155_f1255.json),
[F1345 definitions](https://github.com/yozik04/nibe/blob/master/nibe/data/f1345.json).

S-series needs its own profile mappings. Library addresses and native FC03/FC04 wire
addresses use different conventions; never copy numbers between them without the
existing transport conversion and model validation. Do not infer all circuits by
subtracting one from the previous address.

**What Home Assistant does.** Its local NIBE integration creates climate entities using
shared F/S circuit groups. The groups inspected cover systems 1–4; that is not a claim
that NIBE hardware supports only four. Each has a room sensor, room target, room-sensor
enable flag and shunt state. F accessory entities are disabled by default and availability
checks the accessory flag. Without enabled room regulation, the entity reports Auto
with no temperature target. Activity combines whole-pump priority with shunt state.
The climate entities share the heat-pump device association.
[Climate implementation](https://github.com/home-assistant/core/blob/dev/homeassistant/components/nibe_heatpump/climate.py),
[shared groups](https://github.com/yozik04/nibe/blob/master/nibe/coil_groups.py).

Its sensor platform exposes register values, including energy where provided. I found
no per-climate-system energy allocation in the inspected NIBE integration. This gives
us a useful controls pattern, not an existing energy-split algorithm to adopt.
[Sensor implementation](https://github.com/home-assistant/core/blob/dev/homeassistant/components/nibe_heatpump/sensor.py).

Community experience supports treating custom energy splits as assumptions: the author
of Home Performance discusses declared-power/runtime estimates and manually divided
power for multiple zones; users discuss radiator-capacity-weighted templates. Those are
proposals for approximations, not validation of NIBE hydraulic attribution.
[Author discussion](https://community.home-assistant.io/t/custom-integration-home-performance-analyze-your-homes-thermal-performance-and-insulation-quality/964027),
[project](https://github.com/Hugofromfrance/home_performance).

**A significant valve-state caveat.** NIBE's S-series Modbus document describes ECS shunt
states as inactive, off, opening and closing. It also lists a separate 0–10 V shunt signal;
that is not itself measured flow. HA treats numeric 30 as a closed state for its activity
heuristic. We must verify family/firmware semantics rather than use that heuristic as a
zero-heat gate. A closing valve can still pass substantial hot water. The F export labels
43095 as a state but does not explain its enum. Integrating opening/closing time would
require reliable movement timing, full travel and endpoint information; slow/cached
gateway polling would miss pulses. Even exact position would still need valve and
pressure/flow characteristics.
[NIBE M12676EN, ECS table](https://professional.nibe.eu/document/Technical%20information%20(TIF)/M12676EN.pdf),
[HA state constants](https://github.com/home-assistant/core/blob/dev/homeassistant/components/nibe_heatpump/const.py),
[ESBE valve sizing](https://esbe.eu/storage/A4CE8FFC8B3908CCB49AF02D023174EC9DD97639BCEDB60ED9ADB95CFB1EC011/00e23edfe5574f5fafac1f8c9c52506e/pdf/media/63fc08ee7d1e49cfa33492f6940198d9/VRG130_en_F_LR.pdf).

**What temperatures can establish.** For water, circuit heat transfer is approximately
`Q[kW] = 0.0697 × flow[L/min] × (supply°C − return°C)`.
Temperature difference and flow are both required. Pump RPM alone is not a flow meter.
Existing manifold flow indicators or commissioning records can sometimes provide a
nominal flow without buying equipment, but variable pumping and room valves invalidate
a constant-flow assumption. Source heat production, circuit water heat transfer and
heat released into a room also differ during storage/transients.
[Caleffi circuit measurement](https://www.caleffi.com/en-us/blog/3-site-measurements-circuit-performance),
[heat metering principles](https://www.caleffi.com/sites/default/files/media/external-file/Idronics_24_NA_Fundamentals%20of%20heat%20metering%20in%20hydronic%20systems.pdf).

The following mixing calculation is our engineering derivation under steady, well-mixed,
negligible-loss conditions, not a NIBE register feature:

`hot fraction within circuit 2 = (S2 − R2) / (H − R2)`

Here H is the hot inlet to the mixer, S2 the mixed outlet and R2 the local return.
For H=45°C, S2=35°C, R2=30°C, one third of the circulating secondary water comes
from the hot supply. That does NOT mean circuit 2 receives one third of total heat.
Its circulation volume and circuit 1's heat transfer are still unknown. Reject invalid
temperature ordering or poorly separated temperatures; do not clip bad readings into
apparently confident shares.

There is a narrow temperature-only possibility: in a simple two-branch parallel system,
if BOTH independent branch returns and the combined return are measured, return mixing
can reveal the primary flow ratio. With returns R1/R2 and combined return R,
`primary-flow fraction 2 = (R1 − R) / (R1 − R2)` and
`heat fraction 2 = primary-flow fraction 2 × (H − R2) / (H − R)`.
This requires verified plumbing, sensor placement and steady conditions, with sufficiently
different returns. Buffers, bypasses, transport delay and additional circuits break this
simple model. The pump's BT3 is normally the source return, not an independently measured
radiator return. The tester's necessary R1 measurement has not been established. Therefore
this is a conditional research route, not a default based on the currently known sensors.

**Estimation options and decision.**

| Method | Inputs | Proposed use |
|---|---|---|
| Direct circuit heat | Circuit meter, or flow plus correctly placed temperatures | Best optional evidence; not required for basic support |
| Nominal-flow model | Credible flow per branch, true branch temperatures, verified circulation | Pilot candidate; flag changing-flow conditions |
| Known secondary heat plus whole-system heat | Secondary flow/temperatures and validated, time-aligned total heat | Conditional residual estimate for circuit 1; no arbitrary clamping of contradictions |
| Return-mixing balance | Verified independent returns and common return, simple plumbing | Conditional experiment only |
| Emitter-output model | Circuit temperatures, room temperature, radiator capacities / floor design | Research candidate; installation-specific calibration needed |
| User-configured share | Explicit percentages; floor area or design loads as a starting suggestion | Honest basic split; label as configured, not detected |
| Valve state, runtime or temperature difference alone | Sparse signals | Insufficient for an automatic quantitative split |

An emitter model could weight radiator output by its rated capacity and water-to-room
temperature correction; underfloor heating needs floor construction/covering information
and storage effects. Do not apply one coefficient to radiators and floors, infer flow
from room-temperature error, or assume two equally sized floors use equal energy.
[Purmo technical catalogue](https://www.purmo.com/docs/Purmo-technical-catalogue-full-panel-radiators-10_2021_EN.pdf),
[Uponor design principles](https://www.uponor.com/getmedia/c5ab8a1f-9f02-43a4-8bcb-3b6a186dafeb/underfloor-heating-install-guidepdf?sitename=UK).

Fitting two freely variable circuit loads against one total is underdetermined. Even with
a thermal total, highly correlated circuit operation may prevent useful calibration.
Known independent operation, commissioning data or independent validation is needed.
Without a trusted thermal total, never convert electrical watts into supposed heat using
an assumed COP just to make the estimator work.

**Product proposal.** Keep Heating as the total-heating overview, with separate optional
circuit devices such as Upstairs and Underfloor heating. Each circuit offers the mapped
curve/offset controls, available temperatures, and a thermostat only when its own room
regulation is enabled. The tester's display-only indoor sensor remains a reading.
Global heating permission must not become a circuit-specific off switch. Native NIBE
control remains responsible for circulation and supply regulation.

Energy distribution is opt-in. Each circuit can show an estimated electricity share,
its method (configured / temperature-assisted / metered input), and data availability.
Prefer daily and cycle totals; publish live estimated watts only for a method with
adequate temporal evidence. An unsupported interval goes to Heating—Unassigned, not
silently to Upstairs or Main. Users may explicitly choose their configured split as the
fallback. Do not present invented accuracy percentages or circuit COP computed by
splitting both sides of the same ratio; that would merely reproduce aggregate COP.

Homey Energy must count either the aggregate or the children plus residual, never both.
The aggregate remains an overview. Exclusion/migration needs a real Homey prototype:
there is a user-facing Energy exclusion setting, but do not assume a supported app API
or mark Heating as a whole-home cumulative meter to hide double counting.
[Homey Energy SDK](https://apps.developer.homey.app/the-basics/devices/energy),
[exclusion behaviour](https://support.homey.app/hc/en-us/articles/19391114762268-Exclude-devices-from-Homey-Energy).

**Shared architecture.** Preserve the existing pump-to-function calculation as stage 1.
Stage 2 distributes ONLY its Heating output to circuits. No second integration of pump
watts. Per interval, `Heating = sum(circuit shares) + unassigned` for electricity; track
thermal evidence separately. Electrical shares based on heat delivered are an accounting
convention, not measured branch electricity or the marginal cost of each temperature level.
External circuit-pump electricity is not magically included in the pump's native power.

The code currently identifies devices by pump/role, returns one device for a role, and
broadcasts the full energy delta to all matching-role subscribers. A second ordinary
Heating subscriber would duplicate consumption. Required changes:

1. Stable circuit identity (pump + role + circuit number) and one shared circuit descriptor
   for readings, targets, curve, room-regulation flag and state semantics. Family-specific
   mappings only; optional circuits 1–8 where actually documented/supported.
2. One circuit distributor owning persistence, interval IDs, weights and residuals.
   Multiple devices consume its results rather than independently calculate energy.
3. Apply S-series hourly reconciliation centrally and distribute the correction using the
   historical weights for that hour, not current valve state. Source outages and rollovers
   retain the existing missing-data rules.
4. Keep Homey indoor-sensor feed ownership per supported pump/circuit, only where a real
   circuit-specific writable input exists. Existing host-wide ownership and fixed BT50
   assumptions cannot simply be copied. No fabricated input for EP21.
5. Preserve existing device IDs, Flows and total history. New circuit meters start at an
   explicit activation time; no retrospective guessed split. Device deletion/re-pairing,
   rename, disabled circuits and missing child devices must not lose or duplicate energy.

Relevant existing files: `lib/profile.ts`, `lib/driver.ts`, `lib/roles.ts`,
`lib/connection.ts`, `lib/device.ts`, `docs/energy-attribution.md`.

**Implementation sequence and gates.**

1. Complete a small capability matrix across representative F/S models. Confirm the tester's
   accessory type, buffer/bypass arrangement, independent radiator-return sensing, and any
   existing nominal-flow information. His second circuit and display-only sensor are already
   known; do not ask him to establish them again.
2. Capture a targeted set over 48–72 hours of normal operation: both circuits' relevant
   supply/return/target readings, pump/shunt state, mode, source power and available production.
   Configuration is read at setup or slowly. Use coherent temperature groups, record receipt
   time and cache limitations, and keep bounded rotating storage. Agree any LOG.SET priorities
   rather than blindly replacing his existing list. Do not run repeated full sweeps or force
   hydraulic changes. Gate: enough valid simultaneous data to distinguish candidate methods.
3. Replay the data offline against configured shares, eligible nominal-flow/balance methods,
   and at most one emitter model. Perturb plausible flow/calibration/sensor error. Compare
   holdout periods, restart/gap behaviour and naturally different load conditions. A sum that
   matches the parent is a conservation test, not evidence the split is correct. Gate: an
   independent reference or justified physical calibration and a split stable enough for the
   intended daily comparison. If competing plausible assumptions reverse the result, fail it.
4. Implement shared circuit controls and identity in an isolated major-release branch, with
   F two-circuit and S two-circuit fixtures. Keep current single-circuit behaviour unchanged.
5. Implement configured distribution first and the qualified estimator behind an explicit
   experimental option. Prototype Homey Energy ownership/migration before exposing child
   meters. Gate: zero double counting, no lost intervals, no cross-circuit writes.
6. Pilot on at least one F and one S installation; include a variable-flow or buffered system
   to exercise rejection/fallback. Only advertise automatic estimates for validated layouts.
   Do not let a failed estimate block useful multi-circuit controls.

Acceptance cases include simultaneous heating, one confirmed inactive circuit, hot-water
priority, defrost, storage circulation while the compressor is idle, stale values, nearly
equal returns, invalid temperature order, changed nominal flow, source resets, reconnection,
out-of-order replies, hourly reconciliation, adding/removing circuits and changing methods.

**Decision boundary.** Proceed with the controls architecture. Proceed with an explicit
configured energy split if that has product value. Invest in a small estimator feasibility
pilot, not a promised automatic split. If native signals and reasonable commissioning inputs
cannot constrain the result, stop the automatic estimator and retain configured attribution.
No need to kill the controls feature, require a new meter, or publish false precision.

**Separate finding to triage outside this proposal.** The upstream library explicitly
corrects F-series 43108 from a percentage to a fan-mode enum, where 0 means Normal.
This provides a plausible explanation for the tester's 0% report and corrects the earlier
assumption that it necessarily meant unavailable speed. Verify against his firmware before
changing the display; this would be read-only mode telemetry, not a fan-speed setting.
[Upstream correction](https://github.com/yozik04/nibe/blob/master/nibe/data/extensions.json).
