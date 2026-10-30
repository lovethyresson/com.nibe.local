# Smart heating: research and plan

Research note (2026-10-15). The implementation plan is in
[smart-heating-plan.md](smart-heating-plan.md). It answers one question: can this app beat Nibe's Smart Price
Adaption (SPA) by learning the house, using prices and weather, and steering the pump the way
Ngenic does? Nothing here is built yet. Figures marked *[est]* are engineering estimates, not
sourced findings.

## TL;DR

- **The money is in two places, not one.**
  - *Efficiency*: run the lowest supply temperature that keeps the house comfortable. That means
    stopping overheating, using free solar gain, and never letting the immersion heater cover a
    pre-heat.
  - *Time-shifting*: pre-heat when power is cheap.
- **For a ground-source pump like the maintainer's S1155, efficiency is worth as much as
  shifting, or more.** Pre-heating costs COP (about 2–2.5 %/K of supply temperature) and raises
  heat losses. Shifting pays only when the price spread beats roughly 10–15 % *[est]*.
- **Realistic total savings: 5–15 % of heating cost** on a quarter-hour spot contract in SE3/SE4.
  On a monthly-average contract, shifting earns nothing.
  - The best field MPC study (Thorsteinsson et al. 2023, 97 days, occupied house) measured 2–17 %.
  - A Norwegian nZEB study found price rules *raised* energy use by up to 25 % and saved nothing.
  - Ngenic's "20–30 %" and Nibe's "5–25 %" have no independent support.
- **We can do what Ngenic does without any hardware.** Holding 5217 (external BT1) is verified on
  the S1155 to replace the outdoor reading, and it is a RAM mailbox, not EEPROM. What happens when
  the feed is lost is still **unverified**, and that is the gate for everything below.
- **Our real edge over SPA and Ngenic** is honest, local, inspectable control:
  - a learned house model the owner can see;
  - DHW timing that SPA gets wrong;
  - an add-heat guard;
  - a measured savings counterfactual instead of a marketing number.

## What exists today

### Nibe SPA
- **What it does:** pulls Nord Pool prices through myUplink and shifts heating, hot water, pool
  and cooling.
- **How it is set:** an "influence" from 1–10 per function, registers 843–850 and 902, which this
  app already exposes.
- **What "influence" means:**
  - Nibe support says it describes how slow the emitter is (1 = radiators, 10 = slab), not a
    temperature.
  - Nibe's consumer page says more influence means more savings.
- **Documented failures:**
  - Reheats an already-hot tank above 60 °C in the cheapest hour.
  - At influence 10, overheats the next sunny day (overnight floor supply reached 26 °C).
  - At influence 1, the floor goes cold.
  - Has no PV awareness and no offline price cache.
- **On this app:** SPA overwrites the indoor setpoint (2505), so any optimiser we build must turn
  SPA off (843) while it runs.

### Ngenic Tune
- **How it acts:** an inline resistor emulator on the BT1 wire. The pump sees a fake outdoor
  temperature.
- **Inputs:** indoor sensors, outdoor temperature, solar, forecasts, "house dynamics".
- **What is not published:** the model, the offset range and the cloud-loss fallback.
- **Savings:** the vendor's one-house case study shows 8.3 % energy. The pump's own internal
  heater is still the backstop.
- **Exclusion:** Ngenic refuses installs where BT1 also feeds the defrost logic, i.e. some
  air-water outdoor units.

### DIY projects
PeaqHvac, PumpSteer, ClimateOptimizer, EMHASS and the openHAB spot-price optimiser all converged
on the same pattern:
- a closed loop on indoor temperature;
- forecast-aware pre-heat;
- a price-ranked curve offset or BT1 shift, with a deadband;
- an add-heat guard and a start-rate guard.

None of them publishes measured savings.

### This app
The control levers and sensors are already mapped (`drivers/nibe_s/registers.ts`):

| Need | Have |
|---|---|
| Outdoor override | 5217 BT1 mailbox (verified, RAM) |
| Indoor feed | 5987 BT50 mailbox (verified, already fed every 30 s from Homey sensors) |
| Curve | offset 30 (−10…+10, EEPROM), slope 26 |
| Hot water | 697 boost, 195 allow, start/stop setpoints 58–64, periodic 65/66/92 |
| Add heat | 180 permit, 679 DM difference |
| Price shifting already built into the pump | SPA 843–850/902 |
| Price signal for the pump | SG Ready 6008 (absent on the S1155) |
| Model inputs | BT1 (1), indoor (116/26), supply/return (5/7), brine (10/11), flow (40), compressor Hz (1046), power (2166/2305), produced/consumed (3821/3823), hourly energy log, priority (1028/3804) |
| Other Homey devices and prices | `homey:manager:api` (already used for the indoor sensors; also reaches Homey Energy prices) |

Nothing reads prices or weather yet.

## The control lever

> **Decided 2026-10-15: BT1 (5217).** The maintainer's experience is that ±3 curve-offset steps
> come nowhere near the needed authority, so the curve offset is not a fallback. Weather comes
> from Open-Meteo. The test house has radiators. See
> [smart-heating-plan.md §0](smart-heating-plan.md).

This decision gates everything. There are three candidates.

1. **BT1 mailbox (5217): the recommended lever if it passes hardware tests.**
   - For: it is Ngenic's lever without the hardware, with no EEPROM wear, and Nibe keeps its own
     degree-minute, start/stop and defrost logic.
   - Against: a fake outdoor temperature also moves
     - auto-stop heating (184);
     - add-heat start (185);
     - auto-start cooling (183);
     - the BT1 average (37).
   - So the engine must clamp the faked value away from those thresholds.
   - Loss-of-feed behaviour is unknown. If the pump holds the last value forever, a crashed app
     leaves the house on a fake temperature.
2. **Curve offset (30): the fallback.**
   - For: simple, and already used by HA users.
   - Against: integer steps of about 1–1.5 K supply each *[est]*, and EEPROM.
   - Nibe quotes 1 M writes per position, about 180 writes/day over 15 years. With a deadband and
     at most one change per 15 min, this sits well under ~24 writes/day.
3. **Biased BT50 (5987): worth one test, probably not shipped.**
   - For: the app already owns this feed, and Nibe's room control then closes the loop itself.
   - Against: it lies about the one number the owner looks at, it requires zone control through
     BT50, and its gain (the room factor) isn't exposed over Modbus.

**Avoid** degree-minute writes (11 is overwritten within a poll on the S1155) and direct compressor
blocking. The Thorsteinsson study found blocking unreliable, with about 1.5 h restart delays.

## The model

### 1. Learning the house (the user's point 1)

**Model:** a 2R2C grey box. The states are room air `Ti` and one thermal mass `Tm`, which is the
slab for underfloor heating or the fabric for radiators.

    Ci·dTi/dt = (Tm−Ti)/Rim + (Te−Ti)/Rie + Aw·I_south + Φint + (1−f)·Φh
    Cm·dTm/dt = (Ti−Tm)/Rim + f·Φh

**Fitting:**
- `Φh` is space heat. Take it from the produced-energy counters, and drop the hot-water intervals
  using priority 1028.
- Bootstrap with a 1R1C model fitted by recursive least squares (RLS), then run an augmented
  extended Kalman filter (EKF) over the states and log-parameters. Both cost microseconds in JS.

**The one real pitfall:**
- A weather-compensated pump in steady state makes heat input proportional to the loss, so `R`
  cannot be told apart from the heating gain.
- *Excitation* fixes this:
  - a "learning week" of ±2–3 curve steps for a few hours;
  - or the natural off-periods during hot-water runs.

**How much data:** about 1 week for a usable model, 2–4 weeks across varied weather for stable
solar and mass terms.

**What the owner sees** (useful before any control exists):
- heat-loss coefficient, e.g. "180 W/K";
- time constant, e.g. "the house loses 1 °C in 9 h at 0 °C outside";
- slab storage, e.g. "≈ 12 kWh per °C";
- model accuracy at 1 h and 6 h.

These numbers are also how we size pre-heat. A radiator house with τ≈30 h has almost nothing to
shift. A slab house with τ≈80 h can coast through a 4-hour price peak.

### 2. Weather (the user's point 3)

- **Source: Open-Meteo.** MET Nordic, 1 km, refreshed hourly.
  - Use `global_tilted_irradiance` with `tilt=90, azimuth=0`, so solar gain is
    one learned south aperture `Aw` in m².
  - Fitting raw global horizontal irradiance (GHI) gets the season wrong: low winter sun hits
    windows hard.
  - Also take temperature, wind and humidity.
  - Licence: free for non-commercial use. Check that it covers a free store app.
- **Discount solar in planning (×0.7 *[est]*).** Cloud forecast error is the main cause of
  sunny-day overheating, in SPA and in the field study.
- **Outdoor-temperature forecast:** gives feed-forward for cold fronts. It matters for slab houses
  because their lag is long.
- **Wind:** infiltration term `1/Rie = Ua0 + Ua1·v`. Fit `Ua1` only after weeks of data.
- **Humidity:** matters only for air-source defrost.

### 3. COP (what makes price-shifting honest)

Carnot-fraction form, with `η` learned online from measured Q/Pel (the field study had to refit
it mid-experiment):

    COP = η · T_cond / (T_cond − T_evap)

- **Sensitivity:** about −2.5 %/K of supply temperature at 35 °C supply and a 0 °C source.
- **Ground source:** brine temperature barely moves within a day, so pre-heating only ever costs
  COP.
- **Air source (S2125, F2040):** a +5 °C afternoon versus a −5 °C night is a 20–25 % Carnot
  difference *[derived]*. The weather forecast becomes a price signal of its own.
- **Air source, 0…+5 °C at high humidity:** a defrost penalty of 10–15 % *[est]*.

### 4. Prices (the user's point 2)

- **Use the marginal all-in price:** spot + energy tax + grid energy fee + margin, all with VAT.
  The fixed adders squeeze the *relative* spread, which is what shifting earns on.
- **Quarter-hour spot since 1 Oct 2025:**
  - Prices are published around 13:00 CET for the next day, so the known horizon is 11–35 h.
  - Days are 96 slots, and 92 or 100 on DST days.
  - Hourly-only logic has already broken HA blueprints.
- **Source: Homey Energy, through the `homey-api` client the app already holds.** The app already
  has `homey:manager:api`, and `ManagerEnergy` in `homey-api` 3.14 exposes everything needed under
  the read-only `homey.energy.readonly` scope:

  | Operation | Gives us |
  |---|---|
  | `fetchDynamicElectricityPrices({date})` | The day's spot prices for the owner's zone |
  | `getDynamicElectricityPriceUserCosts()` | The owner's own math expression for the all-in price (tax, grid fee, VAT, margin) |
  | `getElectricityPriceType()` | Dynamic or fixed contract, which is the contract detection in idea 13 |
  | `getOptionElectricityPriceDynamicPreferredInterval()` | 15 or 60 min |
  | `getOptionElectricityPriceFixed()`, `getCurrency()` | The flat-price case and its currency |

  - The owner configures this once in Homey's Energy settings, so there is no zone picker, token
    or tariff UI for us to build.
  - Still to confirm on a live Homey: the response shape, whether user costs are already applied,
    and when tomorrow's prices appear.
- **Detect the contract and say so.** If `getElectricityPriceType()` reports a fixed price, the
  engine should tell the owner that shifting earns nothing and run efficiency-only.

### 5. Other factors (the user's point 4)

**Hot water as storage**
- Shifting the *timing* of a normal reheat costs nothing in COP. Shifting the *temperature*
  (boost to 55 °C+) pays only when the price ratio is above about 1.3–1.5.
- Put the weekly legionella cycle in the cheapest slot of the week.
- Never start hot water right before a planned pre-heat: it blocks space heating.

**Add-heat guard**
- One hour of immersion heating at COP 1 wipes out a day of shifting.
- Don't push the curve hard when degree minutes approach the add-heat threshold (679).
- On ground source, consider lowering the add-heat cap during optimised periods. Don't do this on
  air-water pumps (freeze risk).

**Start/cycling penalty**
- The S-series modulates, but aggressive SPA still produces 60 Hz spikes.
- Plan with a minimum run/off time of 30–60 min, and leave start/stop decisions to Nibe's DM
  logic.

**PV surplus**
- Exported power is worth about spot alone; imported power carries tax and VAT.
- So surplus PV is cheap heat: treat the house as the first battery. Read PV from Homey devices.

**Power tariff (effektavgift)**
- The 2027 mandate was dropped on 13 March 2026, and some grids (e.g. Mälarenergi) have removed
  theirs.
- Make it configurable and off by default.
- When on, the main lever is not stacking hot water, immersion heating and space heating in one
  hour.

**Internal gains, occupancy and away**
- Learned as a constant, plus an optional daily profile.
- A setback earns almost nothing in a slab house and a few percent with radiators.
- Express it as a comfort-band schedule, not a setpoint schedule.

**Ventilation (S735 exhaust air)**
- On this model the exhaust air is the heat source, so fan speed changes both losses and COP.
- Niche; leave for later.

**Firmware and model drift**
- SPA registers have stopped answering after firmware updates.
- Re-probe the levers at startup and fail safe.

## Scored ideas

How to read the scores:
- **Value**: expected contribution to cost and comfort for a typical SE3/SE4 owner on a spot
  contract, from 1 to 5.
- **Confidence**: how well the evidence supports it.
- **Effort**: S, M or L for this codebase.

| # | Idea | Value | Confidence | Effort | Why |
|---|---|---|---|---|---|
| 1 | **Learned house model and insight view** (heat loss W/K, time constant, slab storage, accuracy) | 2 directly, **5 as an enabler** | High | M | Every other idea sizes itself from this. It is visible value with no control risk. |
| 2 | **Lever validation on hardware** (BT1 loss-of-feed, threshold side effects, offset→supply map, write budget) | gate | – | S | Unknown fallback behaviour is a safety issue, not a tuning issue. |
| 3 | **Efficiency loop**: indoor feedback that finds the lowest curve that holds comfort, and stops overheating | **4** | Med-high | M | The main source of Ngenic's ~8–10 % energy saving. 1 K less overheating ≈ 4–5 % heat. Matters for any contract. |
| 4 | **Solar forecast** pulls heating down before sunny days | 3 (spring/autumn), 1 (midwinter) | Med | S on top of 1 | Fixes the best-documented SPA complaint. Large-glazing houses gain most. |
| 5 | **Hot-water timing**: reheat in cheap slots, legionella in the cheapest weekly slot, no needless 60 °C reheats | **3** | High | S | No COP penalty, and hot water is 15–25 % of energy. Best value per line of code. |
| 6 | **Add-heat guard** | 3 (cost tail), 4 for peak tariffs | High | S | Prevents the failure that turns shifting into a loss. |
| 7 | **Price heuristic** (price percentile → bounded offset, clamped by model-predicted indoor temp) | 2–3 | Med | S | Ngenic-class. Baseline and fallback for 8. |
| 8 | **Predictive optimiser** (DP over Ti×Tm, 36 h, 15 min, COP-aware, start penalty, terminal value) | 3–4 (slab), 2 (radiators), 0 (flat contract) | Med | L | Literature 5–15 % in the field. About 1 M ops per solve, fine in JS. |
| 9 | **Measured savings**: counterfactual offset-0 simulation versus actual cost | 0 directly, **5 for trust** | High | M | The only thing no competitor offers. Needed to tune 3–8 honestly. |
| 10 | **Air-source COP and defrost** (shift to warm, dry hours) | 3 air-source, 0 ground | Med | M | A real effect, but only on S2125-type installs. |
| 11 | **PV surplus as cheap heat** | 2–3 with PV, 0 without | Med | S on top of 8 | Read PV through the Homey API. |
| 12 | **Outdoor-forecast feed-forward** | 2 | Med | S on top of 1 | Mostly a comfort win in slab houses. |
| 13 | **Contract detection and advice** | situational, up to 5 | High | S | For a monthly-average customer, the biggest saving is an honest "switch contract". |
| 14 | **Power-tariff peak shaving** | 1 today | Med | M | Mandate dropped. Configurable, off by default. |
| 15 | **Wind infiltration** | 1 | Low | S | Weakly identifiable. Add once residuals ask for it. |
| 16 | **Occupancy/away comfort band** | 1–2 | Med | S | Small, mainly for radiator houses. |
| 17 | **Ventilation (S735)** | 1 | Low | M | Niche. |

## Plan

Each phase ships on its own, and each is gated on evidence from the previous one. The maintainer's
pump is ground-source with SPA history, so we need at least one air-source tester and one radiator
house before phase 4.

**Phase 0: Prove the lever (S, hardware only, no release)**
1. On the S1155 with `dev/*.mjs` probes:
   - Write 5217, stop feeding, and record how long the pump holds the value and whether it falls
     back to the wired sensor.
   - Repeat across a pump reboot and a Modbus disconnect.
2. Check whether a faked BT1 moves the BT1 average (37), auto-stop heating (184) and add-heat
   start (185).
3. Map offset 30 to calculated supply (1017) at 2–3 outdoor temperatures.
4. Decide the lever and record it in `docs/external-sensors.md`.

**Phase 1: Observe and learn (M) → "House insights"** (ideas 1 and 13)
- A 15-minute aggregate logger: Ti, Te, supply/return, brine, Pel, Q, hot-water/defrost flags,
  plus Open-Meteo GTI, temperature and wind. About 4 weeks of history in the store.
- RLS 1R1C, then the 2R2C EKF, then Carnot η.
- Show heat loss, time constant, storage and accuracy in device settings or Insights.
- Read prices and contract type from Homey Energy (`ManagerEnergy`) and confirm the response shape on a live Homey.
- **Exit criterion:** 6-hour indoor prediction RMSE below 0.3 K on the maintainer's house.

**Phase 2: Efficiency and hot water (M)** (ideas 3, 4, 5, 6, 9)
- An opt-in "Smart heating" mode that turns SPA off while it runs.
- An indoor-feedback curve trim with a deadband and rate limit.
- Solar pull-down.
- Hot-water timing and the weekly legionella slot.
- The add-heat guard.
- A watchdog: on stale data, forecast or prices, return to neutral (real BT1, offset 0).
- The savings counterfactual, from day one.

**Phase 3: Price heuristic (S)** (idea 7)
- Price percentile → bounded shift, clamped by the model.
- Ship to the test channel and compare the measured counterfactual with phase 2 alone.

**Phase 4: Predictive optimiser (L)** (ideas 8, 10, 11, 12)
- DP over (Ti, Tm) for 36 h at 15-minute steps.
- The COP model, a start penalty, a terminal value on stored heat, and a solar discount.
- Defrost and air-source COP; PV surplus pricing.
- The phase-3 heuristic stays as the fallback.
- **Ship only if** the counterfactual beats phase 3 on test houses.

**Phase 5: Optional extras** (ideas 14–17)
- Peak tariff, wind, occupancy band, ventilation. Each only if real owners ask for it.

## Outcome drivers and what others expose (2026-10-30)

Asked for the Profile setting and the inertia question (plan §6.6, §7.4). Derived numbers are
marked *[derived]*; unconfirmed ones *[unverified]*.

### Learn inertia, or ask?

- **Heat loss is learnable; the mass and its slab/fabric split are hard.** Every reference
  identification used deliberate excitation (Bacher & Madsen drove heaters with a PRBS). A Kalman
  (stochastic) grey box depends far less on the training period than a deterministic fit (NTNU
  PhD). Passive data gives heat loss in about 1–3 cold weeks; the mass needs excitation and refits.
- **Closest analogue:** a 97-day Danish field MPC on a slab-floor air-water house, controlled by
  overriding outdoor temperature. They refitted the house once (after 2.5 months) and the COP model
  three times; the savings estimate had not settled after 10 days.
- **Failure modes:** unmeasured internal and solar gains bias heat loss (63 ± 5 W/K fitted against
  50 W/K designed in one Annex 71 house); PV as a sun proxy is seasonally biased; lumping emitter
  and controller lag into the house over-credits a radiator house with storage.
- **Envelope τ, Swedish villas:** 1950s brick ≈ 35 h, 1970s ≈ 34–52 h, 1980s ≈ 53 h, old timber
  ≈ 70 h, 1990s insulated timber ≈ 100 h *[derived from Hedbrant 2001 and Energimyndigheten
  cool-down tables]*. The *comfort* time constant, 23 → 20 °C at 0 °C outside, is only **6–10 h**.
- **The emitter is a weak prior on its own.** Insulation has the largest effect on flexibility,
  total inertia second. Floor heating instead of radiators adds up to +44 % flexibility in a poorly
  insulated house and +8 % in a well-insulated one; furniture raises τ up to 42 % in light houses
  (Johra, Heiselberg, Le Dréau, simulation).

### What others ask

| Product | Inertia | What the owner sets |
|---|---|---|
| Nibe SPA | preset | Newer S firmware: Off / Comfort / Save / Save PLUS per function; older: 1–10 "influence", which Nibe support and marketing describe differently |
| Ngenic Tune | learned | price adaptation on/off, spot-price factor 0–100 % (default 50) |
| Tibber | learned *[insulation input unverified]* | target, day/night saving up to ~3 °C, away; needs a Nibe room sensor and turns SPA off |
| tado Balance | – | comfort↔savings slider; hours per day it may act, 1–6 (default 2) |
| Qvantum SmartControl | – | Eco / Balanced (default) / Comfort |
| MELCloud Optimizer (Homey) | learned | temperature flexibility 1–2 °C, comfort hours, hot water, weather pre-heat |
| PumpSteer (HA, fakes outdoor) | asked | Saving Level 0–5 (drop 0.5–3 °C, pre-heat 0.3–1.5 °C), "Brake Ramp Time" 0.5–10 for inertia; both renamed from "aggressiveness" and "house inertia" |
| Kompromiss (HA MPC) | asked as R and C | raw MPC weights: the anti-pattern |

Commercial products learn the house and expose one comfort↔savings control with 3–4 presets. Only
hobby tools ask for inertia, as an abstract number, and rename it.

### What drives the outcome

| Source | Result |
|---|---|
| Danish field MPC (arXiv 2303.16289) | cost −2 to −33 % by comfort level, −12.4 % overall; electricity **+9.5 %**; blocking the evening peak alone captured 66 % of the saving |
| Võsa & Kurnitski, CLIMA 2025 (vendor-linked) | 12–20 % of the bill; but 23 → 21 °C alone saves 22 % |
| HeatShift-HP (simulation, 2025 prices) | pooled < 1 %, best 4 %; supply temperature dominates heat cost |
| LTH thesis 2026 (Swedish air-water, simulation) | ~6 % of household electricity cost ignoring comfort; ~820 SEK/yr keeping it |
| Johra et al. (simulation) | storing heat costs 3–6 % extra heat; benefit saturates at ~6 h of activation |

In order: the comfort band (and how much of a "saving" is just a colder house, ≈ 5 % per °C),
price spread, insulation then mass then emitter, the COP cost of pre-heating, add-heat avoidance
*[not isolated by any study]*, occupancy, and sun forecast error (overheating).

### Sources (this section)

- NTNU grey-box PhD: https://hdl.handle.net/11250/3028399
- Bacher & Madsen: https://02417.compute.dtu.dk/material/week13/article-grey-box-models.pdf
- Danish field MPC: https://arxiv.org/html/2303.16289v2
- Annex 71 RC fit: https://mdpi.com/1996-1073/13/21/5724
- Kull et al., time constants: https://research.aalto.fi/fi/publications/influence-of-time-constants-on-low-energy-buildings-heating-contr/
- Hedbrant 2001: https://www.avhandlingar.se/avhandling/936c01bc03/
- Energimyndigheten cool-down: https://www.storuman.se/contentassets/978dc7d8203e479687a8f2a0e128e6f0/hur_snabbt_blir_huset_kallt.pdf
- Nibe SPA 2025: https://nibe.eu/download/18.3bb4c23119588237ccea3f/1742824789335/Productinformatieblad%20-%20Smart%20Price%20Adaption%202025.pdf
- Ngenic (Homey app settings): https://github.com/enodis74/se.ngenic.tune
- Tibber: https://support.tibber.com/en/articles/5084963-sensibo
- tado Balance: https://help.tado.com/en/articles/8912069
- Qvantum: https://info.qvantum.com/knowledge-base/qvantum-kb/what-is-smartcontrol-how-does-it-work
- MELCloud Optimizer: https://homey.app/a/com.melcloud.optimize
- PumpSteer: https://johanalvedal.github.io/PumpSteer/Configuration
- Kompromiss: https://github.com/etnoy/kompromiss
- CLIMA 2025 summary: https://www.heatadapt.eu/articles/price-based-heat-pump-control-peer-reviewed-savings
- HeatShift-HP: https://escholarship.org/uc/item/803399rv
- LTH thesis: https://lup.lub.lu.se/student-papers/record/9224173
- Thermia (≈ 5 % per °C): https://www.thermia.se/media/70446/elforbrukning_styrning_och_elavtal_thermia_20230201.pdf

## Open questions

- BT1 mailbox loss-of-feed behaviour (phase 0).
- Whether the Open-Meteo licence covers a free Homey app, or whether to use MET Norway (cloud
  cover plus a clear-sky model).
- Whether to replace SPA or *tune* it: write influence 845/902 from our model, which is cheap but
  coarse. Worth one test in phase 2 as a baseline.

## Sources

- Thorsteinsson et al. 2023, field MPC in an occupied house, Applied Energy 347: https://ar5iv.labs.arxiv.org/html/2303.16289
- Bacher & Madsen 2011, grey-box building models: https://02417.compute.dtu.dk/material/week13/article-grey-box-models.pdf
- Clauss et al., Norwegian nZEB price control (no savings, up to +25 % energy): https://ntnuopen.ntnu.no/ntnu-xmlui/handle/11250/2609078
- Alimohammadisagvand 2018, Finnish GSHP rule-based demand response (~15 % cost, simulated): https://napier-repository.worktribe.com/output/2787353
- Lund thesis, air-water HP in southern Sweden (~6 % with comfort loss): https://lup.lub.lu.se/student-papers/record/9224173
- Ngenic Tune control and data: https://en.support.ngenic.se/article/81-how-does-ngenic-tune-control-my-heating-system , https://en.support.ngenic.se/article/82-what-data-does-ngenic-tune-use
- SPA user reports (S1155): https://www.energiesparhaus.at/forum-meine-erfahrung-mit-smart-price-adaption-der-nibe-1155-6-pc/75327
- Nibe EEPROM endurance (1 M writes): https://www.energiesparhaus.at/forum-nibe-wp-wie-oft-kann-man-parameter-veraendern-flash-lebensdauer/55835_1
- PeaqHvac: https://github.com/elden1337/hass-peaqhvac · PumpSteer: https://community.home-assistant.io/t/pumpsteer-integration/921641 · EMHASS thermal model: https://emhass.readthedocs.io/en/latest/thermal_model.html · heat-pump-pilot (EKF/RLS design reference): https://github.com/andox/heat-pump-pilot
- Open-Meteo (GTI, MET Nordic): https://open-meteo.com/en/docs
- Nord Pool 15-min MTU: https://www.nordpoolgroup.com/en/trading/transition-to-15-minute-market-time-unit-mtu/
- Effektavgift mandate dropped: https://www.tv4.se/artikel/tt-260313-elkostnader1-a11d2879/regeringen-stoppar-kritiserad-effektavgift-pa-el
