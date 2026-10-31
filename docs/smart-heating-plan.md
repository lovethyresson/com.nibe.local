# Smart heating: implementation plan

Status: **M0 done, go on BT1 (2026-10-30, §3.2); M1 not started.** Planned 2026-10-15. Companion to
[smart-heating-research.md](smart-heating-research.md), which covers the why, the evidence and
the scored ideas. This document covers the how, against the code as it stands at 1.4.6.

Platform facts marked **[live]** were checked on the maintainer's Homey Pro (Early 2023,
firmware 13.5.2-rc.5, SE3) with read-only `homey api` calls.

## 0. Decisions (maintainer, 2026-10-15)

1. **The test house has radiators.** That is a fast heating system with little stored heat.
   Price shifting there is mostly *coasting through* 1–3 h peaks, not pre-heating for half a day.
   An underfloor/slab house is needed from the test channel before the M5 optimiser can be judged.
2. **Weather: Open-Meteo is the primary source.** It is the only free source with irradiance. A
   free Homey app is non-commercial use. MET Norway is the fallback.
3. **The lever is the outdoor sensor (BT1, holding 5217), not the heating curve.**
   - In the maintainer's experience, ±3 curve-offset steps do not come close to the authority
     needed.
   - Curve-offset writes also wear the pump's EEPROM.
   - The curve offset is no longer a fallback. M0 must prove that BT1 is safe; if it is not, the
     feature waits rather than shipping a weaker lever.
4. **One "Profile" setting with presets and Custom** (revised 2026-10-30, §7.4). Presets for most
   owners; Custom exposes how much price, weather and stored heat may steer, plus the comfort band.
   It replaces the 2026-10-15 five-level "Aggressiveness", and with it the separate
   band, strength and margin settings (§7.4).
5. **SPA and Smart heating are exclusive per pump**, chosen in Pair and Repair. Whichever is on
   owns its capabilities and Flow cards; the other's are removed (§10).

### M0 findings so far (S1155, 2026-10-15; details in [external-sensors.md](external-sensors.md))

- **BT1 is fail-safe.** A single 5217 write expires after about 5 minutes, across disconnects
  too, and the pump returns to the wired sensor. A 30 s feed ran for 1 h with 0 failures.
- **BT1 moves the curve within an hour (2026-10-29, confirmed clean 2026-10-30).** With room
  control and SPA off, calculated supply follows a first-order filter of the fed BT1: **τ ≈ 49 min,
  gain ≈ 0.50 K supply per K** (0.47–0.55 across two days and both directions). **BT1 stays the
  only lever.**
  - The slow BT1 average (37, τ ≈ 18 h from a 3 h step on 2026-10-16) is *not* what the curve
    reads. The controller models both (§4.5).
- **Room-sensor control masks the lever.** The 2026-10-15/16 steps ran with the zone controlled by the app's
  BT50 feed (5986 = 1) and the house at or above setpoint: DM sat at +100, and calculated supply
  was held low regardless of BT1.
  - Ngenic has the same precondition: any indoor sensor on the pump must be removed or disabled.
  - **Smart heating requires the pump's room-sensor control to be off** (§4.3). The app keeps
    reading indoor temperature for its own model, but stops feeding it to the pump.
- **Fake indoor (BT50) was tested too, at the maintainer's request (2026-10-28).**
  - It is fast: the regulator's average (116) moves within about 5 min.
  - It is weak: about 0.4 K supply per K. Half of it is diluted by a second sensor in the 116
    average.
  - It fails safe: input 26 goes unavailable about 5 min after the feed stops, and the pump
    carries on.
  - Details are in external-sensors.md.
  - BT1 with room control off (above) is about as fast and has more authority.
- **No physical-BT1 copy found** (input 108 is still unexplained). The real outdoor temperature
  must come from a Homey sensor or the forecast (§4.2).

---

## 1. Scope and principles

**Smart heating** is a price-control mode for a pump, owned by its **Heating** device. It does
three things:

1. **Learns the house** from 15-minute aggregates of pump, indoor, price and weather data, and
   shows the owner what it learned.
2. **Feeds the pump a computed outdoor temperature** through BT1, keeping the house inside a
   comfort band at the lowest cost.
3. **Measures itself** against a simulated "Nibe on its own" counterfactual.

**Principles.** Each one is drawn from how this codebase already works.

- **Heating owns it.** Everything the indoor climate is judged by already sits on Heating
  (test-enforced, `test/unit.test.ts:1225`). The BT50 feed is the template:
  - single-writer ownership per pump (`indoorOwners`);
  - pairing saves a pending configuration;
  - Repair activates it after the owner has enabled the external sensor in the pump menu and the
    app has verified it took effect.
- **Pairing never writes to the pump.**
- **Persist before you write.** Store the SPA snapshot and the control state *before* the first
  write (as `activateIndoor` does, `lib/device.ts:106`).
- **Fail neutral, visibly.**
  - *Neutral* means feeding the **real** outdoor temperature, so the pump behaves exactly as if
    the app were not there. If even that cannot be done, stop feeding and let the pump take over.
  - On a problem: `setWarning()` with the reason, one timeline notification per incident, and the
    warning cleared on recovery.
  - `setUnavailable` stays reserved for losing the pump.
- **Pure core, thin glue.** The model, planner, actuator plan, price parsing and counterfactual are
  pure `lib/smart/*.ts` modules with injected clocks, tested like `capabilitySyncPlan` and
  `lib/indoor-sensors.ts`.
- **Six languages for every string.** That includes warnings and notifications, which the BT50
  feed currently hard-codes in English (`lib/device.ts:156,997,1002`). Fix those in passing.
- **Lean.** The app already uses **63 MB [live]**, against community-reported kill thresholds of
  roughly 80–150 MB. So: no ML libraries, typed arrays for history, one controller per pump.

**Out of scope for v1:**
- multiple climate systems ([multiple-climate-systems-plan.md](multiple-climate-systems-plan.md));
- cooling and pool;
- power-tariff peak shaving;
- F-series. The profile seam allows it later, but F-series BT1 emulation is untested.

---

## 2. Milestones

| M | Name | Pump writes | Ships to |
|---|---|---|---|
| **M0** | BT1 verification on hardware (`dev/probe-bt1.mjs`) | probes only | nothing (docs) |
| **M1** | Mode choice SPA ⇄ Smart, data foundation, "House insights" | **none** | test → live |
| **M2** | Shadow controller | **none** (logs what it would feed) | test |
| **M3** | Controller v1: efficiency loop + price shifting through BT1 | 5217, 843 | test → live |
| **M4** | Hot-water timing (replaces SPA hot water) + add-heat guard | DHW registers | test → live |
| **M5** | Predictive optimiser (DP, COP model, air-source, PV) | same lever | test → live |

**On the timing of M4.** Choosing Smart heating turns SPA off for the whole pump, which includes
SPA hot water. Until M4 ships, a Smart heating pump therefore has no price-aware hot water. The
Repair screen says so in one line. Hot-water timing is the cheapest idea to build, so M4 can be
pulled forward into M3 if shadow data allows.

---

## 3. M0: BT1 verification (hardware, run by the maintainer)

Script: **`dev/probe-bt1.mjs`**. The S1155 accepts two Modbus clients, so it runs alongside the
app, and Claude can run it with the maintainer's go-ahead. Record the results in
[external-sensors.md](external-sensors.md).

| # | Question | Mode | Blocks |
|---|---|---|---|
| 0.0 | Is there a readable "external BT1 enabled" flag, like 5986 is for BT50? **No (2026-10-30):** no register followed an on/off/on toggle. Repair verifies by feed-and-readback. | `--watch` while toggling menu 7.5.9.2 | Repair verification |
| 0.1 | Does one 5217 write expire, and does the pump return to the wired sensor? | `--hold -5 --minutes 120` | **ship / no-ship**: a value held forever turns a dead app into a stuck house |
| 0.2 | Does it survive a Modbus disconnect? | `--hold -5 --reconnect` | crash behaviour |
| 0.3 | **Can we still read the physical sensor while feeding?** | `--find-physical` | real-outdoor source (§4.2) |
| 0.4 | How fast, and how far, does a BT1 step move the calculated supply (1017) and the BT1 average (37)? Does the pump filter BT1? | `--step -5 --minutes 30` and `--step +5` | planner latency, gain |
| 0.5 | ~~Does a fake BT1 trip auto-stop heating 184 / add heat 185 / cooling 183?~~ **Not tested, known (2026-10-30):** they act only in Auto (237 = 0) and are judged on the pump's averaged outdoor temperature (37, the filter time set in the pump). The app reads 37 live and clamps on it (§4.1). | — | — |
| 0.6 | Does 843 = 0 fully stop SPA, and is the readback immediate? | existing `dev/probe-spa.mjs --watch` plus `probe-room --register 843 --write 0` | mode switch |
| 0.7 | Does a 30 s feed cadence hold for an hour without exceptions? | `--step 0 --minutes 60` | cadence |

**Exit:** a written decision on whether BT1 is safe, plus its clamps, gain, latency, the
activation flag and the real-outdoor source.

**If 0.1 shows the value is held forever:** Smart heating does not ship as designed. Go back to
the maintainer: options are a hardware relay/emulator (Ngenic-style) or SG Ready on models that
have it.

### 3.1 Repeat of 0.4 with every other input held (done 2026-10-30: τ 49 min, gain 0.50)

The 2026-10-29 step measured a curve gain of about 0.55 K per K and τ ≈ 50 min, but with SPA on
and room control switched off minutes before. The repeat confirms both numbers with nothing else
moving, in both directions, in one run.

**Inputs to calculated supply (1017), and how each is held:**

| Input | Held by | Checked by the probe |
|---|---|---|
| BT1 as the curve sees it | the fed value | yes: input 1 equals the fed value |
| SPA (843) | maintainer sets it off before the run | yes: refuses unless 843 = 0 |
| Room-sensor control (1.3.3/1.3.4) | maintainer sets it off ≥ 60 min before | indirectly: no register on zone firmware, so the settle check stands in |
| Curve 26, offset 30, min supply 34, max supply 38, operating mode 237 | left alone | yes: snapshot at start, re-read every 10 min, abort on change |
| Holiday/away, external adjustment | maintainer confirms none is active | no |
| Real outdoor temperature (sets the recovery end point) | can't be held | logged from Open-Meteo every 15 min (`--lat`/`--lon`) |

**Design:**
1. **Settle:** log every 30 s until 1017 has stayed within 0.2 K for 30 min. Refuse to step if
   that doesn't happen within 2 h.
2. **Step colder, not warmer:** feed real − 5 K for 3 h (more than 3τ). A colder fake asks for
   *more* heat, so the house warms slightly instead of cooling as it did on 2026-10-29. If real −
   5 K would cross auto-stop add heat (185, 5 °C), the probe refuses: use `--step -3`, or wait for a
   day with real ≥ 10.5 °C.
3. **Recovery:** stop feeding and log for 2.5 h (more than 3τ).
4. **Fit:** the probe fits `Δsupply = A·(1 − e^(−t/τ))` to each half separately and prints A, τ
   and the gain per K.

**Abort (probe restores the real value and exits):** a held setting changes, indoor (116) moves
more than 1 K from its start value, or the maintainer says stop. Nothing else stops the run early.

**Pass:** the step and recovery gains agree within 20 %, and the two τ within 30 %. The recovery
gain is corrected for the real outdoor drift logged from Open-Meteo.

**Maintainer checklist, before the run:**
- SPA off.
- Room-sensor control off (1.3.3/1.3.4), at least 60 min before.
- No hot-water boost, holiday or away mode planned for the window.
- About 6.5 h at home: settle (≥ 30 min), step 3 h, recovery 2.5 h.

```
node dev/probe-bt1.mjs --step -5 --minutes 180 --after 150 --lat <lat> --lon <lon>
```

Afterwards: SPA and room-sensor control back on.

### 3.2 M0 decision (2026-10-30): go on BT1

**BT1 is safe and strong enough. Smart heating is built on it, and M1 starts.** Measured on the
maintainer's S1155 (ground source, radiators); details in [external-sensors.md](external-sensors.md).

| # | Answer | What it fixes in the design |
|---|---|---|
| 0.0 | No readable "external BT1 enabled" flag | Repair verifies by feeding a value and seeing input 1 follow it (§4.3, §8) |
| 0.1 | One write expires after about 5 min; the pump returns to the wired sensor | Fail-safe: a dead app or Homey costs at most 5 min of a fake value |
| 0.2 | Expiry holds across a Modbus disconnect | No special crash handling |
| 0.3 | No physical-BT1 copy while feeding | Real outdoor comes from a Homey sensor or the forecast (§4.2) |
| 0.4 | Calculated supply follows the fed value: τ ≈ 49 min, gain ≈ 0.50 K per K (0.47–0.55, two days, both directions) | Actuator model (§4.5); bias ±20 K buys about ±10 K of supply |
| 0.5 | Not tested, known: auto-stop 184/185 act in Auto only, on the average 37 | Clamp on 37 in Auto; nothing to clamp in Manual (§4.1) |
| 0.6 | SPA switched off at the display reads 843 = 0 at once, and supply settles flat within 35 min | Mode switch reads 843 back. An app-side write of 843 is first exercised by Repair Verify in M3 |
| 0.7 | 30 s feed, 1 h and 3 h runs, 0 failures (351 writes in the longest) | 30 s cadence |

**Preconditions the product must enforce,** each learned the hard way in M0:
- **Room-sensor control off.** With it on, the pump's indoor loop overrides the fed BT1 (§4.3).
- **SPA off.** It moves supply on its own and is exclusive with Smart heating (§10).
- **Not "Immersion heater only"** (237 = 2). Auto and Manual both run; Auto is recommended (§10.4).

**What one pump cannot tell us.** The gain is curve-dependent (curve 5 here) and the house is a
fast radiator house. Both are learned per pump in M1/M2, and M2 shadow needs a slab house and an
air-source pump before M3 ships (§7.5).

---

## 4. Lever: BT1 feed

### 4.1 What is fed

`bt1Fed = clamp(teReal − bias)`, refreshed every **30 s**.

- `bias > 0` → the pump sees a colder day → more heat (**pre-heat**).
- `bias < 0` → the pump sees a warmer day → less heat (**coast**).

Rules:

- **The bias is in kelvin of outdoor temperature.** Its limit comes from the Profile (§7.4), up
  to about ±20 K.
  - Measured on the S1155 at curve 5: about 0.5 K supply per K, so ±20 K buys about ±10 K of
    supply (M0.4, §4.5).
    That is the authority a ±3 offset never had.
- **Ramp limit:** at most 2 K per 15 min. Radiators react within an hour, and a hard jump produces
  overshoot and compressor spikes.
- **Clamps**, in operating mode Auto only (237 = 0; in Manual the thresholds do nothing). Keep the
  pump's average (37), read live, and its prediction over the planning horizon:
  - below `min(184 auto-stop heating, 183 cooling start) − 1 K`, so the app never stops heating or
    starts cooling by accident;
  - above `185 auto-stop add heat + 1 K` when the real temperature is above it, so the app never
    unlocks add heat;
  - when the real temperature is already beyond a threshold, let it pass through unchanged
    (bias 0).
- **Neutral** is `bias = 0`, i.e. feeding the real outdoor temperature.
- **Cadence:** 5217 is a RAM mailbox, so there is no EEPROM wear. The 30 s cadence matches the
  BT50 feed and is verified by M0.7. Write the same value again even when nothing changed: the
  pump needs a fresh value.
- **Write path:** `connection.writeRegisterValue` on the write lane, exactly like `sendIndoor`.
  - The mailbox clears within about 1 s, so verify against **input 1**, not 5217: up to 4
    readbacks × 750 ms.
  - Three cycles in a row that fail verification → pause `lever_error`.

### 4.2 The real outdoor temperature (the hard part)

While we feed 5217, input 1 *and* the BT1 average 37 show **our** value. The app still needs the
real outdoor temperature to compute the fed value, for the model, and to show the owner. Sources,
in order of preference:

1. **A physical-BT1 register**, if M0.3 finds one.
2. **A Homey outdoor sensor** the owner picks in Setup.
   - Reuse the BT50 picker (`sensorInventory`), with the range widened to −50..60 °C.
   - Same rule as the indoor feed: no partial averaging.
3. **Open-Meteo current temperature**, bias-corrected. The app learns `wired − forecast` per hour
   of day while not feeding (the learning phase, and every pause), as an exponential moving
   average. That correction is applied while feeding.

Rules for the source:

- **Setup requires 1 or 2 to turn control on.** Option 3 is allowed only as a degraded fallback
  while the chosen source is down. After 6 h on option 3, go neutral: stop feeding so the wired
  sensor takes over.
- **Display.** While feeding, Heating's outdoor capability (`measure_temperature.i1_outside`) shows
  the **real** value, not register 1, and the BT1 average shows a rolling mean of the real values
  computed by the app.
- A new capability `measure_temperature.smart_fed` shows what the pump is being told (§10.1).
- Every consumer that reads input 1 must be audited for this:
  - `reason.ts` explanations (e.g. auto-stop);
  - detection (`lib/detection.ts`);
  - the Flow "outdoor temperature" triggers;
  - the pump-relocation check (`choosePumpCandidate` uses register 1 to verify a responder).

### 4.3 Activation and handover (the BT50 pattern)

**Activate** (Repair, Smart heating section). The owner sees three manual steps:

1. Menu **7.5.9 Modbus TCP: writes allowed**.
2. Menu **7.5.9.2 enable external BT1**.
3. **Room-sensor control off** for the climate system: the zone is not controlled by a room
   sensor. This is the same precondition as Ngenic. With room control on, the pump regulates on
   indoor error and overrides the fed outdoor temperature (M0.4).
   - If the app's own BT50 feed is active, it is handed back first, through the existing
     "Return to NIBE" path (`deactivateIndoor`).
   - Indoor temperature still comes from the same Homey sensors, now read by the controller only.
4. A confirm checkbox.

Verify then refuses while room control is still on: input 5986 (BT50 active) must read 0.

Then **"Verify"** runs (handler `activate_smart`, 45 s client timeout):

1. If M0.0 found an activation flag, read it.
2. Snapshot SPA (843/844/845/846/902/848/849/850) into `smartHeating.spaSnapshot`, then persist.
3. Write 843 = 0 and verify.
4. Feed the neutral value (the real temperature) and verify that input 1 follows within 3 s.
5. Persist `state: 'learning'` or `'active'`, depending on model readiness, then start the loop.
6. On any failure: restore 843 from the snapshot, show the error beside the button, and keep the
   previous mode.

**Handover back to Nibe** ("Return to NIBE"; also reached when switching to SPA or None):

1. Stop the loop.
2. Feed neutral one last time.
3. Ask the owner to turn off 7.5.9.2, with a confirm checkbox. If M0.0 found a flag, refuse until
   it reads 0, like `deactivateIndoor` and 5986.
4. Restore SPA from the snapshot when the target mode is SPA. Otherwise leave it off.
5. Restore the outdoor capabilities to registers 1 and 37.

### 4.5 The pump's outdoor filter (measured, M0.4 and 2026-10-29)

The curve does **not** read the slow BT1 average (input 37, τ ≈ 18 h). With room control off, fed
BT1 steps moved calculated supply as a clean first-order response with **τ ≈ 49 min** and a
gain of **about 0.5 K supply per K** of fed BT1 (2026-10-29/30), while 37 barely moved. Removing the fake reversed
it on the same time constant. So the curve reads a faster-filtered BT1; 37 is a separate, slow
average (it may still be what the auto-stop thresholds use).

- **Model the curve path as one state:** `f[k+1] = f[k] + (fed[k] − f[k]) · Δt/τc`, with
  `supply ≈ curve(f)`.
  - `τc` and the gain start from the measured values, then are learned online from 1017, which
    is a measured output every slot, so the estimate corrects itself.
  - The gain is curve-dependent; it is learned per pump, not hard-coded.
- **Invert it.** The planner decides the supply it wants; the actuator computes the fed value.
  - A 50 min lag is short against 1–3 h price peaks, so the fed value can move close to when the
    supply should move, with a lead of about one τc.
  - Supply authority is about 0.5 K per K of bias, so the bias range (§7.4, up to ±20 K) gives
    roughly ±10 K of supply. That is the authority knob.
- **Track 37 as well.** It is the slow average of whatever is fed, so a long coast or pre-heat
  drags it hours behind.
- **Clamp on 37.** The auto-stop thresholds (184/185) act in Auto only and are judged on the
  averaged temperature 37. The actuator keeps 37, and its prediction, away from them (§4.1).
- **Radiators.** House τ is short and the curve lag is under an hour, so the 2R2C model plus the
  curve-filter state makes 1–3 h peaks plannable. The early tests on the maintainer's house are
  where this gets proven.

### 4.4 Write locks

While Smart heating is active, `NibePumpDevice.writeRegister` (`lib/device.ts:289`) rejects writes
to 5217 and to the SPA registers, with a translated message ("Smart heating controls this; switch
to SPA or None in Repair"). This is the same mechanism as the lock on 5987 during the BT50 feed
(`:291`).

The existing `external_temperature.h5217_bt1.set` Flow card is unavailable in Smart mode anyway,
because its capability is removed (§10.1).

---

## 5. Data foundation (M1)

### 5.1 Module layout

```
lib/smart/
  mode.ts        PriceControl 'spa'|'smart'|'none': capability filter, pump-wide sync   (pure)
  prices.ts      Homey Energy fetch + user-cost evaluator + slot normalisation       (pure core)
  weather.ts     Open-Meteo (primary) / MET Norway (fallback)                        (pure core)
  outdoor.ts     real-outdoor source selection + forecast bias learning              (pure)
  history.ts     15-min bucket aggregator + ring buffer + (de)serialisation          (pure)
  store-file.ts  /userdata persistence (batching, atomic rename)                     (glue)
  model.ts       RLS 1R1C bootstrap, 2R2C EKF, quality metrics                       (pure)
  cop.ts         Carnot-fraction COP, online η                                       (pure)
  insights.ts    model → owner-facing numbers                                        (pure)
  presets.ts         profile (preset or Custom) → band, max bias, margin, coast cap   (pure)
  planner.ts     M3 trim + price shift; M5 DP                                        (pure)
  actuator.ts    bias → fed BT1 with clamps, ramp, verification plan                 (pure)
  savings.ts     counterfactual + ledger                                             (pure)
  controller.ts  state machine; timers; calls the above                              (glue, per pump)
```

### 5.2 Prices: Homey Energy via `homey-api` (`homey:manager:api`, Athom-approved)

**Calls [live]:**

| Call | Use |
|---|---|
| `energy.getElectricityPriceType()` | `"dynamic"` or `"fixed"` |
| `energy.getDynamicPricesElectricityZone()` | `userConfigured.zoneName`, `.priceInterval` ("15"/"60") |
| `energy.fetchDynamicElectricityPrices({date: 'YYYY-MM-DD'})` | `pricesPerInterval: [{periodStart, periodEnd, value}]`, UTC ISO, **raw spot** |
| `energy.getDynamicElectricityPriceUserCosts()` | `{mathExpression: "{{([[price]]+0.041+0.36+0.208)*1.25}}"}` |
| `energy.getCurrency()` | `"SEK"` |

`getOptionElectricityPriceDynamicPreferredInterval()` is refused on a local Homey **[live]**.

**User costs are not applied per interval [live].** Only the `…WithUserCosts` summaries include
them. So the app evaluates `mathExpression` itself:

- Strip `{{ }}`, substitute `[[price]]`, and evaluate with a **hand-written recursive-descent
  parser**: numbers, `+ − * /`, parentheses and unary minus only. **Never `eval`.**
- **Self-check:** the result for `max(value)` must equal `highestPriceWithUserCosts`. If it does
  not, or the formula does not parse, use spot and set `costsApplied: false`.
  - Ranking survives any increasing affine formula. The planner widens its spread margin when
    costs are unknown.

**Normalisation:**
- 15-minute UTC slots.
- 60-minute zones are expanded ×4.
- DST days have 92 or 100 slots **[live: 100 on 2025-10-26]**. Key slots by UTC, never by local
  index.

**Fetch schedule:**
- Today and tomorrow on init, then hourly.
- From 12:45 to 16:00 local time, every 15 min until tomorrow appears.
- The last two days are cached in the history file, so a restart has prices immediately.

**Edge cases:**
- **Tomorrow not published** shows up as `{"error":"Timeout after 10000ms"}` **[live]**.
  - Before 16:00 it means "not yet".
  - After 16:00 it means "Homey's fetch is stuck". From 18:00, show a soft hint, not a warning:
    "Tomorrow's prices are missing in Homey Energy".
- **Today missing** (also seen on spring DST day 2026-03-29): price-blind mode. The planner runs
  efficiency-only, and the reason says so.
- **Fixed contract or no zone:** efficiency-only. Setup says "Set up dynamic prices in Homey
  Energy to also use cheap hours".
- **Negative prices** are valid. The comfort band still holds.
- **Currency change:** the savings ledger notes it and restarts.
- **Zone change:** refetch.

### 5.3 Weather: Open-Meteo, MET Norway as fallback

**Location:** `api.geolocation.getOptionLocation()` **[live]**, with no new permission. Round to
2 decimals before sending it anywhere. No location means weather is disabled, which Setup says.

**Open-Meteo** (`models=metno_seamless`, hourly):
- Variables: `temperature_2m`, `wind_speed_10m`, `relative_humidity_2m`, `cloud_cover`,
  `shortwave_radiation`.
- `global_tilted_irradiance` at `tilt=90`, `azimuth=0` (S); a second façade (E/W) only if the fit
  asks for it.
- `past_days=1&forecast_days=3`.
- Attribution, "Weather data by Open-Meteo.com (CC BY 4.0)", goes in the README and the settings
  hint.

**MET Norway Locationforecast `complete`:** used only when Open-Meteo fails.
- Temperature, wind and humidity are direct. Solar is estimated from cloud cover with a clear-sky
  model.
- An identifying User-Agent is required.
- Coordinates at most 4 decimals.
- Honour the `Expires` header.

**Cadence:** hourly with ±5 min jitter. **Staleness:** cached for 24 h; after that, persistence
(no solar, outdoor equal to the current temperature).

### 5.4 History (15-minute aggregates)

**Hook:** Heating's `onPollComplete(readNames)` + `connection.lastRawFor()`, as the
room-thermostat sync does (`lib/device.ts:1379`). Bucket on UTC: `slot = floor(t / 900 000)`.

**Polling:** while the mode is `smart`, Heating's `wantedRegisters()` adds what the aggregator
needs, whatever the owner selected. This is the precedent at `lib/device.ts:1024`.

| Field | Source | Aggregate |
|---|---|---|
| `ti` | Heating indoor (116/26/BT50 feed) | mean |
| `te` | real outdoor (§4.2) | mean |
| `tfed` | fed BT1 (when feeding) | mean |
| `tsup`, `tret`, `tcalc` | 5, 7, 1017 | mean |
| `tbrine` | 10 (ground source) | mean |
| `hz` | 1046 | mean |
| `pel` | allocator deltas (`onEnergy` sum across roles) | kWh |
| `qheat` | Δ 1577, step-smoothed by Hz | kWh |
| `dhw`, `aux` | fraction of polls with priority = hot water, 1029 on | 0..1 |
| `dm` | 11 | mean |
| `price` | all-in slot price | value |
| `gti_s`, `gti_x`, `wind`, `rh`, `ghi` | weather, interpolated | value |
| `flags` | partial, reconnect, window-open, defrost, paused | bits |

**Rules:**
- A slot with less than 80 % poll coverage is `partial`. The first slot after a reconnect is
  always partial, because `invalidateWork()` clears `lastRaw`. `onConnectionDown` closes the open
  bucket as partial.
- **Storage:**
  - `Float32Array` ring, 28 days × 96 slots ≈ 230 KB.
  - Kept in `/userdata/smart-<random>.bin`, which is publicly served, hence the unguessable name
    held in the device store.
  - Written via temp file + rename. Flushed hourly and in `onUninit`.
  - A version byte at the start; an unknown version means discard and relearn.
  - Only the small `smartModel` state (~2 KB) goes in the store, written once a day.
- **Insights backfill:** on first enable, up to 14 days at 1 h resolution from the app's own logs,
  via `api.insights.getLogEntries({id:'homey:device:<id>:<cap>', resolution:'last14Days'})`
  **[live]**.
  - Throttled to 1 call per 20 s: "Too many requests" after 2 rapid calls **[live]**.
  - A missing log is skipped silently.

### 5.5 Delivered heat

- 1577 steps by 0.1 kWh on the S1155. Spread each step over the slots since the previous one,
  weighted by Hz outside hot water (a hot-water slot's Hz made no space heat).
- Electricity per slot is spread the same way from the consumption counter (3823), weighted by
  2166. 2166 alone read 5.8 % under 3823 over the first day (2026-10-31), the same shortfall that
  moved the energy meters off it in 0.9.13.
- Where flow (40) exists, cross-check against `ṁ·cp·(tsup − tret)`.

---

## 6. Model (M1)

### 6.1 Stages

1. **1R1C ARX by RLS** (λ = 0.998/slot): `ti[k+1] = a·ti + b·te + c·qheat + d·gti_s + e`.
   Usable after about 3 days, or day 1 with the backfill.
   - It seeds stage 2's **heat loss only**. The history holds slot means, so the inputs are
     averaged over the two slots; that took the heat-loss bias on a simulated house from +6–10 %
     to 0. Its τ stays biased low by sensor noise (−50 % at 0.03 K), so it is never shown.
2. **2R2C augmented EKF.**
   - States `[ti, tm]`; log-parameters `[1/(CiRie), 1/(CiRim), 1/(CmRim), 1/Ci, Aw/Ci, f, Φint/Ci]`.
   - Exact zero-order-hold discretisation via the 2×2 matrix exponential.
   - **Priors from the owner's two Setup answers** (§6.6), not a fixed radiator prior. The EKF
     then learns the house; the answers only set where it starts and how far it may wander.
   - The BT1 → supply lag (τ ≈ 49 min, §4.5) and the emitter lag are a **known actuator stage in
     front of the house model**, not states the EKF has to find. Lumping them into the house is
     how a radiator house gets credited with storage it doesn't have.
   - **Measured on simulated houses (2026-10-31, `test/smart-model.test.ts`).** Over 21 days
     with ±40 % excitation and the right answers, a radiator and a slab house came out within
     8 % on heat loss and 12 % on τ across six seeds (radiator within 3 %), with 6 h RMSE ≤ 0.05 K. Without excitation, τ
     came out ~20 % low (§6.3). With "Don't know" a slab's τ wandered ±30 %, and with the wrong
     answer (radiators, pre-1960) heat loss was off by up to 2×. It still predicted within 0.14 K
     in every case and learned `f` > 0.6. The answers buy parameters the owner can read, not
     prediction accuracy.

### 6.2 Gating

Skip a slot when any of these hold:
- it is partial;
- `dhw > 0.5` or defrost;
- indoor jumps by more than 1.5 K/h (window, fireplace, sun on the sensor);
- the indoor or outdoor source changed in the last 2 h;
- the 2 h after a bias ramp, until M2 shows the transients are modelled.

Two related rules:
- A window-open drop (≥ 1 K in 30 min while heating) also sends the controller neutral for 1 h.
- A parameter that moves more than 20 %/day for 3 days raises **drift** (§9).

### 6.3 Excitation

**BT1 makes excitation cheap.** While learning in Smart mode, the controller may already feed
small, slow steps: ±3 K bias, at most twice a day, during cheap hours, inside the *Comfortable*
band.

- This breaks the collinearity between heat input and losses within days instead of weeks.
- It is covered by choosing Smart heating in Setup: the owner opted into control, and the steps are
  inside the tightest band.
- Before control is activated (pending state), learning is passive.

### 6.4 Quality

- "Model ready" = 6 h RMSE < 0.35 K over 7 days, at least 5 valid days, and τ stable within 15 %
  over 3 days.
- Before that, only the trim (§7.3) runs, capped at the *Comfortable* limits.

### 6.5 House insights (settings labels, written only when the rounded value changes)

| Label | Example |
|---|---|
| Heat loss | "≈ 180 W per °C" |
| Cooling rate | "Loses ~1 °C in 6 h at 0 °C with heating off" |
| Stored heat | "≈ 4 kWh per °C" |
| Sun gain | "Sunny winter noon adds ≈ 1.2 kW" |
| Heating system | "Fast (radiators)" / "Slow (underfloor)" |
| Model accuracy | "± 0.2 °C over 6 h · learning day 9" |

Implausible values (heat loss outside 30–1,000 W/K, τ outside 5–400 h) show "Still learning".

### 6.6 Inertia: learned, started from two questions

**Decision: learn it; ask two plain questions for the starting point; never ask for a number.**
Evidence in [smart-heating-research.md](smart-heating-research.md#outcome-drivers-and-what-others-expose-2026-10-30).

- **Why not just ask "radiators or floor heating".** Insulation moves a house's flexibility more
  than the emitter does. In one Danish simulation, floor heating added up to +44 % flexibility in
  a poorly insulated house and only +8 % in a well-insulated one. The emitter alone is a weak prior.
- **Why not only learn.** Normal weather-compensated operation hides the mass (§6.3), so a cold
  start can take weeks, and the field references all used deliberate excitation and refits.
  A prior halves the bad weeks.
- **Why never a number.** The products that asked for one (PumpSteer's "house inertia", Nibe SPA's
  1–10 influence, Kompromiss's R and C) renamed it or confused owners with it.

**The questions (Setup, §10.4), each with "Don't know":**

| Question | Answers | Prior it sets |
|---|---|---|
| How is the house heated? | Radiators · Floor heating in concrete · Floor heating in a wooden floor · Both | `f` (share of heat into the mass), emitter lag: radiators f ≈ 0.4, ~10 min; concrete slab f ≈ 0.8, hours |
| When was it built (or last insulated)? | Before 1960 · 1960–1979 · 1980–1999 · 2000 or later | envelope τ and heat loss: ≈ 35 / 50 / 55–70 / 100 h *[from Swedish cool-down tables, research doc]* |

"Don't know" uses the wide default (radiators, τ 50 h, wide variance).

**What the owner sees.** The "Heating system" insight (§6.5) shows what was *learned*: "Fast
(behaves like radiators)" / "Slow (behaves like a heavy floor)". When it disagrees with the answer
for 7 days, Repair shows one line: "Your house behaves slower than radiators usually do". It is
information only; the model keeps what it learned.

**What sizes coasting is the comfort-band coast time, not the envelope τ.** A 1970s villa with an
envelope τ of 34 h still drifts from 23 to 20 °C in only 6–10 h. The planner works from the model's
predicted time to leave the band (§7.3), never from τ directly.

---

## 7. Controller (M2 shadow, M3 live)

### 7.1 State machine (pure transition function; state persisted in the store)

```
pending ──Repair verify──▶ learning ──model ready──▶ active
   ▲                          │  ▲                     │
   │                          ▼  │                     ▼
   │                        paused ◀──── any guard ────┘
   │                          │ guard ok → back to learning/active
   └──── mode → spa/none: handover (§4.3) ────────────────────
```

- **`pending`:** chosen at pairing, or in Repair before Verify. No writes. Warning: "Finish Smart
  heating setup in Heating → Repair".
- **`learning`:** feeding. Trim plus excitation steps, *Comfortable* limits.
- **`active`:** the full planner at the chosen profile. The `learning → active` transition
  sends one notification: "Smart heating learned your house and now uses prices".
- **Pause reasons** (an enum, used for i18n and analytics): `pump_offline`, `indoor_missing`,
  `outdoor_missing`, `spa_on`, `manual_mode`, `lever_error`, `model_drift`, `owner_pause`,
  `firmware_changed`.
- **Entering `paused`:**
  - Feed neutral if the real outdoor temperature is known.
  - Otherwise stop feeding, so the pump falls back to the wired sensor (relies on M0.1).

### 7.2 Guards (each poll and before each feed)

| Guard | Source | Action |
|---|---|---|
| Pump connection down | `onConnectionDown` | pause `pump_offline`. No writes are possible, and the pump holds or falls back per M0.1/0.2. On reconnect, feed the real temperature first |
| Indoor stale > 30 min / BT50 feed in error | Heating indoor age, `indoorStatus` | pause `indoor_missing` (neutral) |
| Real outdoor missing | §4.2 | degrade to the forecast for 6 h, then pause `outdoor_missing` (stop feeding) |
| Operating mode "Immersion heater only" | 237 = 2 | pause `manual_mode`: no compressor, nothing to steer. Auto (0) and Manual (1) both run; the 184/185 clamps apply in Auto only (§4.1) |
| Real outdoor above auto-stop heating | 184 vs real | `idle`: neutral feed, no warning (summer) |
| Cooling active | 1028 | `idle` |
| SPA switched on elsewhere (display, myUplink, Greenely) | 843 | pause `spa_on`, warning "SPA was turned on at the pump; choose SPA or Smart heating in Repair". Never switch it off again |
| Add heat running during pre-heat | 1029 | bias → min(bias, 0) at once |
| DM approaching add-heat start during pre-heat | 11 vs DM start − 0.5 × 679 | cap the bias |
| Feed verification fails ×3 | input 1 ≠ fed | pause `lever_error` |
| 5217 or 843 answers with an exception after a firmware update | read exception | pause `firmware_changed` |

### 7.3 Planner v1 (M3, pure)

Runs every 15 min and on new prices or weather. Horizon: 24–36 h of slots.

1. **Trim** (always on): a PI loop on `ti − comfort`, gain-scheduled by model τ.
   - Feed-forward from predicted solar gain (×0.7) and the outdoor forecast over τ/4.
   - This is the Ngenic-class efficiency loop. It needs no prices.
2. **Price shift** (dynamic contract and model ready):
   - Coast in expensive blocks; pre-heat beforehand only when the model says the band can hold.
   - **With radiators** (short τ), coasting dominates: a few hours of −bias through a peak, with a
     small, late pre-heat.
   - Every candidate is **simulated through the model and clamped to the band**.
   - A shift happens only when `p_high / p_low > 1 + margin`.

**Built offline (2026-10-31, `lib/smart/planner.ts`, `dev/evaluate-presets.mjs`).**
- The objective is **cost at equal comfort**: electricity bought, plus the warmth a plan leaves
  owing (degree-hours below a reference, and stored heat short at the end) bought back at the
  horizon's mean price. A cooler house saves nothing in it, so the planner can only win by
  shifting. Two earlier forms failed in the closed-loop bench and are rejected:
  - *Minimise cost, keep the mean indoor ≥ doing nothing from now.* Each replan's bar started from
    the current state, so a pre-heat raised the bar for every later replan; the house ratcheted
    +0.2 K warmer and cost 2–5 % **more** than doing nothing. The reference is therefore doing
    nothing from the steady state at comfort.
  - *Equal mean over the horizon as a constraint.* Over a finite horizon it weights early heat
    more than late, so it forbade coasting the evening peak: 2.7 % where a hand-made 3 h coast
    found 8.7 %.
- The house and curve are linear in the bias while the pump is between off and flat out, so one
  impulse response scores every move. A greedy search moves the bias 1 K at a time; the result is
  re-simulated in full. About 5 ms a plan.
- **Result, 20 real SE3 days (2026-10-03…30, all-in `(spot + 0.609) × 1.25`), closed loop,
  hourly replanning, at equal comfort:**

  | House | Comfortable | Save some | Save the most | best day |
  |---|---|---|---|---|
  | radiator (H 180 W/K, C 9.5 kWh/K) | 0.6 % | 1.5 % | 2.8 % | 6.2 % |
  | slab (H 120 W/K, C 15 kWh/K) | 0.6 % | 1.4 % | 3.1 % | 6.4 % |

  Gross savings ran 3–6 %; the difference is a cooler house, which §11 does not count.
- **Model error barely matters to the plan.** Planned with a model learned passively, with
  "Don't know", or from the wrong answers, and applied to the true house, every preset landed
  within 0.2 points of the perfect-model result, even with stored heat 46 % low.
- **Open for M2:** *Save the most* never went below 20.4 °C closed loop (its band allows 17); its
  extra comes from pre-heating, not deep coasts. And the pump model is an assumption: the curve
  is taken as tuned to the house (`H·(comfort − fed) − gains`); shadow must learn it from 1017.

The output per slot is `{bias, mode, reason}`. The reason is structured, e.g.
`{kind: 'coast', until: '19:00', priceRatio: 2.3}`, and rendered in six languages.

### 7.4 Profile (pure `presets.ts`)

One setting: a **preset**, or **Custom**. Presets cover most owners. Custom shows four sliders and
the band, the same numbers each preset sets, so an owner can start from a preset and nudge one
thing. The house's inertia is *learned* (§6.6); what the owner chooses is how much of it the app
may *use*.

**The Custom controls** (Advanced, visible only when Profile = Custom):

| Control | Range | What it does in the planner | 0 means |
|---|---|---|---|
| **Coldest allowed** | 0–5 K below comfort | lower band edge; undershoot is penalised hardest | never below comfort |
| **Warmest allowed** | 0–3 K above comfort | upper band edge, i.e. pre-heat headroom | no pre-heat |
| **Price influence** | 0–100 % | scales the price term and the margin a shift needs (100 % → 10 %, 30 % → 60 %) | efficiency only: trim, no price shifting |
| **Weather influence** | 0–100 % | scales forecast feed-forward: cold fronts, and how far forecast sun is trusted (×0.5 at 50 %, ×0.9 at 100 %) | react to measured indoor only |
| **Use of stored heat** | 0–100 % | max coast length (0–8 h) and pre-heat lead (0–1 τ of the model); max bias scales with it, up to ±20 K | no coasting or pre-heat beyond trim |

Not exposed, deliberately: price-spread floor, ramp speed and solar discount curve. They are
tuning constants that only make sense to us (PumpSteer and Nibe both learned this the hard way).
Coasting is capped at 8 h. The benefit of a single coast saturates around 6 h (12 h and 24 h price
cycles); the extra 2 h is for the deep band of *Save the most*.

**Presets.** Working labels; final copy in six languages comes with the strings. The values are
**starting points to tune in M2 shadow**.

| Preset | Coldest / warmest | Price | Weather | Stored heat | ≈ max bias | Who it is for |
|---|---|---|---|---|---|---|
| **Comfortable** | −0.5 / +0.5 K | 30 % | 60 % | 30 % (≤ 2 h coast) | ±6 K | "I don't want to notice it" |
| **Save some money** (default) | −1.5 / +1.0 K | 60 % | 80 % | 60 % (≤ 5 h coast) | ±12 K | most owners |
| **Save the most** | −4.0 / +2.0 K (a 6 K swing) | 100 % | 100 % | 100 % (≤ 8 h coast) | ±20 K | "I don't mind it getting cooler" |
| **Custom** | sliders above | | | | | owners who want to steer one thing |

Rules:
- The band is asymmetric: undershoot is penalised harder than overshoot at every setting.
- A change takes effect at the next planner run, ramped, never stepped.
- **A deep band needs a recovery the compressor can deliver.** Coming back from −4 K is a large
  heat demand, and a fast climb drives degree minutes toward the add-heat start. The planner
  schedules recovery early enough, in cheap slots, to stay above the add-heat threshold (§12); an
  immersion hour at COP 1 erases the coast it followed. Shadow (§7.5) checks this per house.
- **Bias beyond ±15 K** is new ground: M0 measured gain at ±5 K only. The actuator clamps to the
  fed-value limits (§4.1) regardless, and shadow confirms the gain holds that far before M3.
- Picking Custom starts the sliders at the preset that was selected; moving any slider shows
  Custom. Moving them back to a preset's values shows that preset again.
- **Expectations, said once in the FAQ, not in the UI:** most of a "saving" in any product is a
  lower average indoor temperature (≈ 5 % per °C). Price shifting proper is worth a few percent in
  a fast radiator house and more in a slab house with big spreads. Savings are reported at equal
  average indoor temperature (§11) so the two are never mixed.

**Why this shape.** Commercial products expose one comfort↔savings control with 3–4 named presets
(Nibe SPA's newer firmware: Off/Comfort/Save/Save PLUS; Qvantum: Eco/Balanced/Comfort; tado: a
slider). The products that exposed abstract numbers renamed them. Custom keeps the advanced owner
without making everyone read sliders.

### 7.5 Shadow mode (M2)

- The full controller runs, but the feed writes the **real** temperature (neutral) instead of the
  planned one.
- Each slot logs `wouldFeed` and the predicted `ti` to the history file.
- **All three presets are planned every slot, not only the chosen one.** Planning is cheap, and it
  turns two weeks of shadow into a side-by-side test: per house, what each preset would have fed,
  how far indoor would have moved and what it would have cost. That is the evidence for tuning the
  preset table (§7.4) before anything is live.
- Behind `debugLogging`, plus a hidden test-channel setting.
- **Exit:** two weeks on at least 3 houses (one radiator, one slab, one air-source), with no
  would-have plan leaving its band by more than 0.3 K under the realised weather.

### 7.6 Timers and lifecycle

- One `SmartController` per pump host, with Heating as owner, via a static
  `smartOwners: Map<host, device>` mirroring `indoorOwners`.
- A 30 s feed loop (self-rescheduling `setTimeout` with a mutex, as `scheduleIndoor` does) and a
  15-min planner loop aligned to slot + 20 s. Prices and weather run on separate jittered timers.

| Event | Behaviour |
|---|---|
| `onInit` | Load the state, claim ownership. A second Heating on the same host → warning, no control. Re-check the SPA snapshot vs 843 (§8). Resume `learning`/`active`/`paused` by feeding neutral first, then the plan. |
| `onUninit` (app stop, update) | Flush history. **Feed neutral once** (best effort, 5 s). Persist the state as-is so it resumes. |
| `onDeleted` | Feed neutral. If the mode was smart, the owner must still turn off 7.5.9.2: send a timeline notification saying so. Restore SPA from the snapshot. Delete the history file. Release ownership. |
| Pump relocated / address edit | Ownership follows (`reconnectTo`, `lib/device.ts:1363`). Unlike the BT50 address-edit refusal, allow it: the feed resumes on the new connection. |
| Homey reboot, power loss, uninstall | Nothing runs. Safety then rests on M0.1: the pump must return to the wired sensor after the feed stops. This is the reason 0.1 is ship/no-ship. The FAQ explains uninstall: "Switch to SPA or None in Repair first". |

---

## 8. Restart reconciliation

The store holds:

```
smartHeating = {state, profile, custom?, houseAnswers, outdoorSource, spaSnapshot, pausedReason?, since}
```

On `onInit`:

| Situation | Action |
|---|---|
| Mode `smart`, 843 reads 0 | Resume by feeding neutral, then the plan |
| Mode `smart`, 843 reads 1 | Someone enabled SPA while we were down → pause `spa_on` |
| Mode `smart`, input 1 does not follow the neutral feed | `lever_error`: 7.5.9.2 may have been switched off at the display. Warning to re-verify in Repair |
| Mode `pending` | Warning only |

---

## 9. Model lifecycle

| Situation | Detection | Response |
|---|---|---|
| The house changed | Drift (§6.2) | Notify "Smart heating is re-learning your house". Back to `learning` limits |
| Pump replaced or re-paired | `heatpump_type` (1497) or the firmware label changes | Reset COP η and BT1 gain; keep the house parameters |
| Indoor source changed | `indoorSensors` state change | Keep the parameters, widen the covariance |
| Outdoor source changed | `outdoorSource` change | Reset the forecast-bias learning |
| Owner wants a fresh start | Repair → "Re-learn my house" | Clear the model and history |
| Start of the heating season | Too few heating slots | Stay in `learning`; insights say "Waiting for heating season" |
| Summer | Real outdoor above 184 | `idle`, neutral feed. Insights keep their dated last value |

---

## 10. Mode choice: SPA ⇄ Smart heating ⇄ None

### 10.1 The selection field and its capabilities

A new **pump-wide** selection field, `selection.priceControl: 'spa' | 'smart' | 'none'`. It sits
next to `groups`/`overrides` and is resolved in `lib/smart/mode.ts`.

- **Missing value means `spa`.** That is the upgrade path: existing devices keep exactly what they
  have today, in line with the "missing selection = everything" rule.

The pure `capabilitySyncPlan` (`lib/roles.ts:334`) gets one more filter:

| Mode | Removed from every device of the pump | Added (Heating unless noted) |
|---|---|---|
| `spa` | the Smart capabilities below | – (today's SPA set: 843 on Main; 844/845 Heating; 846/902 Hot water; 848 Pool; 849/850 Cooling) |
| `smart` | **all SPA registers** above, and `external_temperature.h5217_bt1` | `smart_heating_mode_NIBE`, `smart_profile_NIBE`, `measure_temperature.smart_fed`, `measure_temperature_offset_NIBE.smart_bias`, `measure_money_NIBE.smart_savings` |
| `none` | both sets | – |

- **SPA registers are still polled in `smart` mode.** They go in Heating's `wantedRegisters()`
  without capabilities, so the `spa_on` guard can see 843.
- **Flow cards follow the capabilities automatically.** Every SPA card is `$filter`ed on its
  capability, and the Smart cards are filtered on `smart_heating_mode_NIBE`. So "whatever is on has
  Flow cards" falls out of the capability sync with no extra wiring.
- **Existing Flows break when a card's capability disappears.** Homey marks them broken. The Repair
  confirm step says so in one line, and the changelog says so for the release.
- **The mode is pump-wide.** Changing it on one device's Repair applies it to every device at that
  address:
  - `applySelection` on siblings, reusing the `syncToSiblings` pattern (`lib/device.ts:1667`);
  - failures listed per device, and the Repair throws (per memory: surface errors).
- Pairing writes the same `priceControl` into every created device's `selection`.

**New capability types** (`.homeycompose/capabilities/`). Each declares `units` in six languages
where numeric. A custom number without units fails install with "Invalid Capability" (memory).

| Type | Kind | Notes |
|---|---|---|
| `smart_heating_mode_NIBE` | enum, read-only | `pending · learning · normal · preheat · coast · idle · paused` |
| `smart_profile_NIBE` | enum, **setable** (picker) | the three presets plus Custom (Custom is shown, not settable from the tile). Tile and Flow use the same capability as the setting (§10.2) |
| `measure_temperature_offset_NIBE` | number, K | bias |
| `measure_money_NIBE` | number, units overridden at runtime from `getCurrency()` | savings this month |

`measure_temperature.smart_fed` uses the official type, so it lands in Insights correctly.

Other rules:
- No on/off capability: the mode choice is the on/off.
  - Pausing is a Flow action, and a pause shows in `smart_heating_mode_NIBE`.
  - This also avoids a second `onoff` on Heating (memory: multiple-onoff tile).
- New names go in the collision test (`test/unit.test.ts:287`) and the "every extra has options"
  test (`:474`). Push options with `ensureCapabilityOptions`.
- **Insights titles are snapshotted forever**, so get them right first time.
- The `smart_profile_NIBE` picker `values` must equal its value list exactly (the existing picker
  test, `test/unit.test.ts:1290`).

### 10.2 Settings (Heating; group "Smart heating", shown only meaningfully in smart mode)

| Setting | Type | Default |
|---|---|---|
| Comfort temperature | number 15–25 | mean indoor over the last 7 days, rounded to 0.5 |
| Profile | dropdown: 3 presets + Custom | Save some money. **Mirrors the `smart_profile_NIBE` capability**: a change in either updates the other |
| Coldest allowed, Warmest allowed, Price influence, Weather influence, Use of stored heat | numbers (§7.4) | the selected preset's values; editable only with Profile = Custom |
| Heating system, Built or last insulated | dropdowns (§6.6) | the Setup answers; changing one re-seeds the prior, it does not reset learning |
| House insights | labels (§6.5) | – |
| Savings since start | label | – |

- Each label and hint is one short line (memory: UI text is not an essay). The reasoning goes in
  the FAQ.
- In `spa`/`none` mode the hint reads "Choose Smart heating in Repair to use these".

### 10.3 Flow cards (custom, filtered `capabilities=smart_heating_mode_NIBE`, six languages)

Add each card to the generic allowlist in `test/unit.test.ts:219`.

| Card | Kind | Args / tokens |
|---|---|---|
| Set profile | action | dropdown, 3 presets (Custom is set in settings) |
| Set comfort temperature | action | number |
| Pause smart heating for … | action | 1–48 h (guests, fireplace evening). Feeds neutral |
| Resume smart heating | action | – |
| Smart heating mode changed | trigger | `mode`, `reason` |
| Smart heating paused | trigger | `reason` |
| Smart heating is pre-heating / coasting / paused | condition | – |
| Profile is … | condition | dropdown |

Also widen `LocalizedText` from `{en, sv}` to six languages (`lib/profile.ts:100`), so that
`reason.ts` and the controller's reasons reach every owner in their language.

### 10.4 Pairing (`assets/pair/setup.js` hub)

A new hub section, **"Price control"**. It is shown once per pump, on the Heating candidate, or on
Main if Heating is not being created; in that case `smart` is unavailable. It is a radio group:

1. **Nibe Smart Price Adaption.** The default if the pump has SPA enabled (843 read during
   detection).
2. **Smart heating (Nibe Live).** One line: "Learns your house and steers heating with prices and
   weather".
3. **None.**

Choosing **Smart heating** shows the prerequisites from a `get_smart_prerequisites` handler:

| Check | Pass | Fail |
|---|---|---|
| Indoor temperature source | Homey sensors are chosen in the Heating temperature section, or a NIBE room sensor is readable | Blocking: "Needs an indoor temperature", with a link into the Heating temperature section |
| Room-sensor control | Shown as the step "Room-sensor control is turned off in Repair" | Not blocking at pairing. Repair Verify enforces it (§4.3). The BT50 feed and Smart heating are exclusive pump-side, because both use the indoor loop |
| Real outdoor source | NIBE (if M0.3 found it) or a Homey outdoor sensor picked here (reuses the picker) | Blocking |
| Homey Energy prices | `dynamic` → "Uses your Homey Energy prices (SE3, 15 min)" | Not blocking: "Saves energy; add dynamic prices in Homey Energy to also use cheap hours" |
| Location | "Weather for your Homey's location" | Not blocking: "No location: no weather" |
| Model | Not applicable at pairing | – |
| House questions (§6.6) | "How is the house heated?" and "When was it built (or last insulated)?", each with "Don't know" | Not blocking |
| Operating mode (237) | Auto: "Recommended" | Not blocking. Manual: "Works. Auto is recommended: the pump then stops heating in summer and keeps the immersion heater off in mild weather by itself". Immersion heater only: blocking |

The result goes into `selection.priceControl` on every created device. Heating's store also gets
`smartHeating = {state: 'pending', profile, houseAnswers, outdoorSource}`. **No pump writes.** At
`onInit`, the pending warning points to Repair (the BT50 pattern).

`test/setup-ui.test.ts` cases:
- the section appears exactly once;
- blocking prerequisites disable "Save";
- a fixed price shows the soft message;
- pair mode emits no activate.

### 10.5 Repair

The Repair views stay per device, but the Price control section is the same on every device of
the pump: the mode is pump-wide.

**On Main, Hot water and the other devices:** the radio group plus a one-line status. A switch
*to* Smart from a non-Heating device sends the owner on: "Finish in Heating → Repair". The
activation needs the Heating context.

**On Heating, in Smart mode:**
- **Status:** the state and reason; model readiness ("day 9 · ± 0.2 °C"); the price, weather and
  outdoor-source lines; the hot-water note ("Hot water has no price control until a later update"
  until M4).
- **Setup:** the activation steps and Verify (§4.3); outdoor source change; comfort and
  profile. These also exist as settings and capabilities; this is the same value.
- **Actions:**
  - "Re-learn my house" (confirm checkbox).
  - **Switch mode**: SPA or None, through the handover (§4.3), with a confirm listing the Flow
    cards that will disappear.

**Transitions and what each must do:**

| From → To | Pump writes | Capabilities | Notes |
|---|---|---|---|
| spa → smart | at Verify: snapshot SPA, 843 = 0, start the feed | swap on all pump devices *after* Verify succeeds | If Verify fails, stay `spa` |
| spa → none | 843 = 0 (snapshot first) | remove SPA caps | Restorable by spa |
| smart → spa | handover; restore 843 and the snapshot | swap | The model is kept in the store (dormant), so returning to smart skips most learning |
| smart → none | handover; SPA stays off | remove smart caps | – |
| none → spa | write 843 = 1, or the snapshot if one exists | add SPA caps | – |
| none → smart | as spa → smart without the snapshot | swap after Verify | – |

Errors appear beside the button (`p.setup-error`). The device-side methods are
`setPriceControl(mode)`, `activateSmart()` and `handoverSmart()`. They throw localised errors and
never swallow them.

---

## 11. Savings (M3, pure `savings.ts`)

- **Counterfactual:** each slot, simulate the model from the same initial state with **bias 0**
  (Nibe alone, on the real outdoor temperature) under the realised weather. That gives heat, then
  electricity via COP, then cost via price.
- **Actual:** measured `pel` × price. **Ledger:** monthly totals in the store, written daily.
- **Honesty rules:**
  - Nothing is shown until 14 active days.
  - A ± band from the model RMSE.
  - Above 30 % → "check your settings", since the model is likelier wrong than the savings real.
  - The FAQ says it is an estimate.
- **At equal average indoor temperature.** The counterfactual runs at the *achieved* mean indoor
  temperature, so a colder house is not reported as smart savings. Report shifted cost and extra kWh
  separately: a Danish field test cut cost 12 % while electricity use rose 9.5 %.
- On a fixed contract, savings = energy saved × the fixed price.
- **Note for SPA owners switching over:** the counterfactual is "Nibe without SPA", not
  "Nibe with SPA". The FAQ says so plainly.

---

## 12. Hot-water timing and add-heat (M4)

Hot-water timing replaces SPA hot water in Smart mode. First, extend M0 (0.8–0.10) to establish
how to defer and advance hot water safely on the S1155.

- **Advance:** 697 "more hot water" (2 h) in a cheap slot.
  - Only when the tank top (BT7) is below stop − 3 K.
  - At most once a day.
  - Never within 2 h before a planned pre-heat, because hot water blocks space heating.
- **Defer:** temporarily lower the start setpoint for the owner's demand mode (58/59/60) by up to
  5 K, during expensive blocks of at most 3 h.
  - Snapshot and restore it, with persist-before-write and restart reconciliation.
  - It is an EEPROM setting, so at most 2 writes a day.
  - **Never touch 195** (allow hot water).
- **Legionella:** never change 65/66/92. Give advice only: "Your weekly boost runs at 03:00; this
  week's cheapest slot is Sunday 02:15".
- **Comfort guard:** the estimated litres (`lib/hotwater.ts`) never go below the owner's recent
  daily minimum during a defer.
- **Add heat:** plan the bias so the predicted DM never crosses `start − 0.7 × 679`.
  - On ground source, add heat may optionally be capped during optimised periods.
  - Never on air-water pumps.

---

## 13. Predictive optimiser (M5)

- **DP over discretised `(ti, tm)`:** about 30 × 40 states, 7 bias levels, 144 steps.
  - Bilinear interpolation, about 1 M transitions, under 1 s in V8.
  - Chunked with `setImmediate`; about 0.7 MB.
- **Cost per step:**
  `price × Pel(bias, te, COP)`
  `+ w_low·max(0, Tlow − ti)²`
  `+ w_high·max(0, ti − Thigh)²`
  `+ w_ramp·|Δbias|`
  `+ terminal value of stored heat`.
- **COP:** Carnot fraction with η learned online; brine or outdoor as the source; a defrost penalty
  binned by `(te, rh)` for air-source.
- **PV:** a Homey `solarpanel` device with a forecast surplus → that slot is priced at the export
  value.
- **Fallback:** if the solve throws or takes longer than 5 s, use the M3 plan.
- **Ship gate:** beats M3's counterfactual on at least 3 test houses over 4 weeks.
  - Radiator houses gain least here, so the slab tester is essential.

---

## 14. Analytics (read `docs/analytics-taxonomy.md` first; port any change to com.homevolt.local)

All events are edge-triggered, with enums and buckets only.

| Event | Properties | When |
|---|---|---|
| `Changed Price Control` | `from`, `to`: `spa\|smart\|none`, `via: pair\|repair` | mode change |
| `Activated Smart Heating` | `outdoor_source: nibe\|homey`, `price_mode: dynamic\|fixed\|none`, `weather: on\|off` | Verify succeeded |
| `Paused Smart Heating` | `reason` (enum §7.1) | into paused |
| `Learned House Model` | `days_bucket`, `rmse_bucket`, `system: fast\|slow` | learning → active |
| `Changed Smart Heating Profile` | `profile` (preset or `custom`) | edge. Name to be checked against `docs/analytics-taxonomy.md` before it ships |

Candidate user property: `price_control`. **Renaming a user property orphans it forever**, so
decide the name once. Add rows to `docs/analytics.md`.

---

## 15. Testing

**Pure unit tests:**
- **mode:** the capability filter per mode × role; a missing value → `spa`; the pump-wide sibling
  sync plan.
- **prices:** the expression parser, including hostile input (`process.exit()`, `**`, `1/0`) and
  whitespace; DST 92/100-slot days (fixtures captured live); 60 → 15 expansion; the timeout
  classification; the summary self-check.
- **outdoor:** source priority; forecast-bias learning; the 6 h degraded limit.
- **history:** coverage and partial flags; reconnect mid-slot; ring wrap; version mismatch.
- **model:** RLS recovers synthetic 1R1C within 5 %; the EKF recovers a simulated radiator *and* a
  slab house; gating drops spikes; drift.
- **presets/planner:** stays in band per preset and at Custom extremes (all 0 % = trim only; all 100 %); slider ↔ preset round-trip; no shift below the margin; radiator coasting
  shape; negative prices; efficiency-only without prices; solar pull-down.
- **actuator:** clamps against 184/185/183 including the pass-through case; the ramp limit;
  verification failure counting.
- **controller:** every transition and guard; reconciliation (§8).
- **savings:** zero bias gives zero savings.
- **i18n:** key parity across the six languages, already enforced (`test/hotwater.test.ts:281`).

**Integration (closed-loop twin):**
- The fake pump's input 1 follows 5217 writes (with an M0-measured expiry). Its 1017 follows the
  curve, and indoor/1577 come from a 2R2C house simulator.
- A simulated week runs in seconds through the pure layer with an injected clock.
- Real timers only for: the write lock, a connection lost mid-feed, restart reconciliation, and
  pump relocation during a feed.

**UI:** the setup-ui cases (§10.4); Repair mode switches, including the sibling-sync failure
listing.

**Hardware:**
- M0 on the S1155.
- M2 shadow on the S1155 (radiators), plus a slab and an air-source house from the test channel.

---

## 16. Documentation and release (per milestone)

Per CLAUDE.md "Releasing":
- `docs/releases.md` row;
- changelog in six languages, a few sentences, including the line "SPA Flow cards disappear when
  you switch to Smart heating";
- FAQ entries:
  - choosing SPA vs Smart;
  - why it is still learning;
  - how savings are counted;
  - what happens if Homey is offline;
  - uninstalling;
  - fixed contracts;
- `docs/external-sensors.md` (M0);
- `docs/analytics.md`;
- README weather attribution;
- ask about a timeline announcement for M1 and M3.

Also update CLAUDE.md's pairing section: it still describes three pair views, and there are now
four plus the Setup hub.

---

## 17. Checklist

- [x] **M0** `dev/probe-bt1.mjs` written; 0.0–0.7 answered; results in external-sensors.md; **go on BT1** (§3.2, 2026-10-30)
- [ ] Prerequisites: six-language `LocalizedText`; translate the BT50 feed warnings
- [ ] **M1** `mode.ts` + capability filter + pump-wide sync + pair/repair "Price control" section
- [ ] **M1** `prices.ts`, `weather.ts`, `outdoor.ts`, `history.ts` + `/userdata` persistence + Insights backfill
      (all but the backfill done; collecting on the maintainer's Homey since 2026-10-30)
- [ ] **M1** `model.ts` + `insights.ts` + labels; release to test (`model.ts` done offline, not yet
      run online)
- [ ] **M2** `presets.ts`, `planner.ts` v1, `actuator.ts`, `controller.ts` in shadow; twin integration test
      (presets, actuator and planner done offline 2026-10-31; controller and shadow not started)
- [ ] **M2** two weeks of shadow on ≥ 3 houses (radiator, slab, air-source)
- [ ] **M3** Verify/handover, live feed, capabilities, settings, Flow cards, write locks, reconciliation, savings, analytics
- [ ] **M3** release (test → live)
- [ ] **M4** hot-water probes and timing; DM-aware add-heat planning
- [ ] **M5** COP, DP optimiser, air-source, PV; ship gate vs M3

## 18. Open questions

1. Is a slab/underfloor tester available in the test channel? M5 cannot be judged on radiators
   alone.
2. Should the default for an existing SPA-enabled pump stay `spa` after upgrade (proposed), or
   should the app prompt once via the timeline to try Smart heating?
