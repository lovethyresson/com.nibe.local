# Autopilot: implementation plan

Named **Autopilot** on 2026-11-05, the same word in all six languages and in code (`lib/autopilot/`).
It was "smart heating" before; the branch `smart-heating/m1-data` and the history file collected
before the rename keep the old name.

Status (2026-11-22): **M0 done, go on BT1 (2026-10-30, §3.2).** M1 data and model, M2 shadow, the
live feed, the orchestrator, savings, Away, the COP model and the DP optimiser (shadow only) are
built on the dev branch, not released. Autopilot heating has run live on the maintainer's S1155
since 2026-11-14 (§11). Autopilot hot water is built ([autopilot-hot-water.md](autopilot-hot-water.md)).
Pool and cooling have Smart mode only; their Autopilot is phase 2 (§10.0, "Solar, as built").
Several sections below are the October design; where the build replaced them, a line says so and
points to what replaced it. Planned 2026-10-15. Companion to
[autopilot-research.md](autopilot-research.md), which covers the why, the evidence and
the scored ideas. This document covers the how; it was first written against 1.4.6.

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
5. **SPA and Autopilot are exclusive per pump** (confirmed 2026-11-08), chosen in Pair and
   Repair. Whichever is on owns its capabilities and Flow cards; the other's are removed (§10).
   Choosing Autopilot switches SPA off for every function, including those with no Autopilot
   controller on.
6. **One Autopilot controller per function, one orchestrator per pump** (maintainer, 2026-11-08,
   §2.1). The owner switches on Autopilot Heating, Autopilot Hot Water and later Pool and Cooling
   one by one. The orchestrator plans what they share and breaks their ties; it is not a switch.

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
  - **Autopilot requires the pump's room-sensor control to be off** (§4.3). The app keeps
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

**Autopilot** is a set of price-control controllers, one per pump function (§2.1). This
section and §4–§11 describe **Autopilot Heating**, owned by the **Heating** device; Autopilot
Hot Water is in [autopilot-hot-water.md](autopilot-hot-water.md). Autopilot Heating does three
things:

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
  pure `lib/autopilot/*.ts` modules with injected clocks, tested like `capabilitySyncPlan` and
  `lib/indoor-sensors.ts`.
- **Six languages for every string.** That includes warnings and notifications, which the BT50
  feed currently hard-codes in English (`lib/device.ts:156,997,1002`). Fix those in passing.
- **Lean.** The app already uses **63 MB [live]**, against community-reported kill thresholds of
  roughly 80–150 MB. So: no ML libraries, typed arrays for history, one controller per pump.

**Out of scope for v1:**
- multiple climate systems ([multiple-climate-systems-plan.md](multiple-climate-systems-plan.md));
- cooling and pool (they have Smart mode, SPA or Off, with Autopilot shown as "Soon"; their
  Autopilot is phase 2, §10.0);
- power-tariff peak shaving;
- F-series. The profile seam allows it later, but F-series BT1 emulation is untested.

---

## 2. Milestones

| M | Name | Pump writes | Ships to |
|---|---|---|---|
| **M0** | BT1 verification on hardware (`dev/probe-bt1.mjs`) | probes only | nothing (docs) |
| **M1** | Mode choice SPA ⇄ Autopilot, data foundation, "House insights" | **none** | test → live |
| **M2** | Shadow controller | **none** (logs what it would feed) | test |
| **M3** | Autopilot Heating v1: efficiency loop + price shifting through BT1, away mode, transparency (§19); the orchestrator's first real tie-break (§2.1) | 5217, 843 | test → live |
| **MW** | Widgets: a design of their own across the app, Autopilot's among them (§19.5) | none | test → live |
| **M4** | Autopilot Hot Water (replaces SPA hot water for that function) + solar surplus + add-heat guard (§12, §19.3); brings the orchestrator in its single-controller form (§2.1) | 697, 62 | test → live |
| **M5** | Predictive optimiser (DP, COP model, air-source, PV): the joint orchestrator (§2.1) | same levers | test → live |

**Where each stands (2026-11-22, dev branch, nothing released):**
- **M0** done (§3).
- **M1** built: prices, weather, outdoor, history, model, Insights backfill. Collecting on the
  maintainer's Homey since 2026-10-30. The pump-wide `priceControl` mode was replaced by Smart
  mode per function (§10.0).
- **M2** shadow built and logging on the maintainer's Homey since 2026-11-01. The 3-house exit is
  not met: only the S1155 has run it.
- **M3** live feed, Verify, status, Flow cards, Away, savings, transparency and Getting started
  (§7.7) built; live on the S1155 since 2026-11-14. Not released.
- **MW** ten widgets built (§19.5).
- **M4** Autopilot hot water and the shared solar surplus built (§10.0, hot water doc).
- **M5** COP model and DP optimiser built, the DP in shadow only (§13). Ship gate not started.

**On the order of M3 and M4.** The maintainer asked on 2026-11-08 for Autopilot Hot Water to be
built now, ahead of heating ([autopilot-hot-water.md](autopilot-hot-water.md)), so M4 may ship
first. SPA and Autopilot stay exclusive per pump (§0.5), so until Autopilot Heating ships, an
owner who chooses Autopilot for hot water gives up SPA heating. Repair says so in one line.

### 2.1 Controllers and the orchestrator (maintainer, 2026-11-08)

**Why.** One compressor serves every function, and the pump runs one at a time (priority, 1028).
A hot water charge is a stretch in which heating delivers nothing, and pool waits for both. So
every Autopilot controller competes for the same compressor hours and the same solar surplus,
and those need one owner per pump, whether one controller is on or four.

**The pieces.**

| Piece | Where | Owner sees | Writes |
|---|---|---|---|
| **Autopilot Heating** | Heating device | its mode choice, profile, status (§10) | 5217 |
| **Autopilot Hot Water** | Hot water device | its on/off, next charge and why ([autopilot-hot-water.md](autopilot-hot-water.md) §4.5) | 697, 62 |
| Autopilot Pool, Cooling | their devices | later; out of scope for v1 (§1) | – |
| **Orchestrator** | pure functions in `lib/autopilot/orchestrator.ts`, called by a per-host registry beside `autopilotOwners` (§7.6, `PumpRound` in the same file), not by `PumpConnection` | one status line on Main: what runs next and why ("Hot water 13:15, then heating eases off 17–20") | **none** |
| **Shared inputs** | home and pump level, below | Main shows the day type picker (working, day off) and a separate Away switch (`boolean_NIBE.away`), with an optional end time from the Flow card (hot water doc §4.1, §19.2) | none |

- **The orchestrator never writes to the pump.** It only changes what each controller plans
  against; the controllers act through their own levers, the write lane, persist-before-write
  and restart reconciliation. A bug in it can make a plan worse, never a write wrong.
- **It is not a switch.** It runs whenever at least one controller is on.
- **Main is required once any Autopilot is on**, since it holds the household state and the
  status line. Pairing and Repair add it if it is missing.

**The contract: per-slot adjustments, not blocks.** The two planners decide differently:
heating plans a bias per slot and the compressor runs under the curve whatever we grant (§7.3);
hot water plans the next charge and its target from a tank state, so moving one charge moves all
the later ones (hot water doc §4.2). Neither can quote "the cost of moving a block". What both
already take is a **price per slot**. So the orchestrator hands each controller:

1. **Delivery-free slots** (heating, from M3): slots in which a granted charge holds the compressor,
   so the heating model plans them as zero delivery instead of being surprised by them.
2. **Reserved slots** (hot water; empty in v1): slots it must not start a charge in. Nothing
   fills them while hot water plans first; they exist for pool, cooling and M5.
3. **Price adders** (M5): a per-slot shadow price on compressor time, iterated until the plans
   agree. A reserved slot is an infinite adder, so all three share one interface.

**One round per slot, in a fixed order.** On every slot boundary, and when prices, the forecast
or household state change:

1. **Hot water plans first** against the prices. Its charges are short, discrete and pinned by
   the learned peaks, while heating is continuous and its thermal mass absorbs a 1–3 h gap; the
   reverse order would plan heating blind to the charges that interrupt it. (Not because hot
   water saves more: 50–70 kr a month there, hot water doc §3, against 1–7 % of a much larger
   heating bill in the preset bench, `tasks/todo.md`.) Each planned charge occupies the slots
   from its start to its predicted end, taken from the charge model at its target temperature
   (up to about 3 h here), not a fixed 2 h.
2. **Heating plans second**, with those slots as delivery-free: it pre-heats before a charge
   or after it, never counting on heat during it.
3. **Each controller acts** on its own next slot. Heating's 30-second feed (§7.6) keeps running
   between rounds on the last plan.

**Events that skip the round:**
- **Hot water rescue** (below the owner's minimum litres, tank top under 45 °C) charges at once,
  whatever heating planned.
  The next round replans heating around it.
- **Live solar surplus** (hot water doc §4.4) may start a charge between rounds. If that lands
  in a planned heating pre-heat, the charge wins and the next round moves the pre-heat.

**Tie-breaks**, when the order above is not enough: pump safety (each controller's own guards)
before hard floors (hot water reserve, the indoor minimum), before comfort, before cost. In v1
this only decides rescue against a pre-heat, and rescue wins.

**As built (2026-11-15).** The first real round, in `lib/autopilot/orchestrator.ts`:
- **The registry.** `PumpRound.for(host)` holds each controller's latest plan. Hot water publishes
  the charges of the plan it makes every slot (`HotwaterHooks.planned`, the same plan that starts
  charges; the morning plan only words the morning message); heating publishes its biases from each replan (`FeedHooks.changed`).
  Each publishes `undefined` when it stops. Every answer runs under a guard: if one throws, it
  answers "no reservations" and Main reads "Hot water and heating plan apart for now" until it
  works again.
- **The order.** Heating's planner runs at slot + 20 s and hot water's at + 30 s (§7.6), so
  heating would plan first. When hot water's published charges change the slots heating loses,
  the round calls heating's `replanSoon()`, so heating plans second within the slot. Heating's
  plan never triggers hot water: hot water replans at its next slot anyway, which keeps the loop
  one-way.
- **Delivery-free slots** (`deliveryFree`): every slot a planned charge touches, from its start
  to the end of its predicted run. They reach heating as `ForecastSlot.busy` (planner.ts: no heat
  that slot, caught up afterwards).
- **Pre-heat as a price adder** (`preheatSlots`, `preheatAdders`). A pre-heat
  slot is one where heating's planned bias is above 0. Hot water sees each one with the horizon's
  price spread (highest minus lowest price, at least 0.01) added to every kWh charged there
  (`PlanSlot.adder`). So no slot inside a pre-heat is ever cheaper than one outside it, and price
  alone never puts a charge there; the reserve or a draw that cannot wait still can, because the
  planner's shortfall (50 per kWh) dwarfs it. That is "hard floors before cost" in one number. A
  reservation would have turned "must" into a shortfall. The adder moves the plan only: the costs
  a plan reports stay at real prices.
- **Hot water's own charge slots are never pre-heat to it.** Heating keeps a bias through the
  slots it planned around a charge; counting those against the charge would push it out of the
  room heating made for it, and the two plans would chase each other.
- **The safety net always wins.** A rescue charge starts in slot 0 whatever the slot costs and
  even in a reserved slot (`hotwater-planner.ts`).
- **Simulated counts like Live.** A test run's plan is in the round like a live one's, so a
  simulated controller shows what live would do; Main's line is marked "Simulation" only when
  every controller in the round is a test run. *For the maintainer:* this keeps today's
  behaviour (heating already planned around hot water's morning plan in either mode), but a live
  heating beside a simulated hot water plans around charges the pump will not make.
- **Main's status line** ("Autopilot now", the same capability as on Heating and Hot water, shown
  on Main with the day type): the next two events in time order, a charge running now first:
  "Hot water 13:15, then heating eases off 17–20". Stretches on the hour read as hours, others as
  times ("16:45–20:00"); "tomorrow" in front of anything not today. It refreshes whenever a
  controller publishes and each hour.

**Shared inputs (maintainer, 2026-11-08).** Anything more than one function is likely to use
is collected once and shared, never fetched or learned per controller. Each input lives at the
widest level it is true for:

| Level | Inputs | Lives in |
|---|---|---|
| **Home** (one per Homey, every pump) | prices and the owner's cost formula; weather forecast with irradiance; location; the real outdoor temperature (owner's sensor, else forecast); grid import and export, so solar surplus, live and forecast; the Homey's solar generators; **day type** and "away until" | one app-level service, `lib/autopilot/inputs.ts`, started by the app, read by every controller on every pump |
| **Pump** (one per host) | the 15-min history (heating *and* tank fields, one file); compressor state and priority (1028); the wired-BT1 lag model; the charge and COP model as functions of supply or tank temperature; the plan round and its grants | the per-host registry beside `autopilotOwners` |
| **Controller** | its own model (house, tank draws), planner, lever, guards and settings | its device |

- **As built, the home level is the Gateway, not `inputs.ts`** ([external-io.md](external-io.md)):
  `lib/gateway-prices.ts` (one price book for the collector, hot water and the savings devices),
  `lib/gateway-weather.ts` (one forecast an hour, the irradiance history once a day, location and
  season), `lib/gateway-price-history.ts` (a year's monthly price spread, §11) and
  `lib/autopilot/solar-surplus.ts` (one surplus fit and budget per home). The pump history is
  still owned by the Heating device's `AutopilotCollector` (`lib/autopilot/collector.ts`); hot
  water keeps its own tank history.
- **Day type is per home, not per pump.** Two pumps in one house share one day type. Every Main
  shows the same picker, and the Flow card sets the home value.
- **Surplus is one budget.** When several functions could take it, the orchestrator grants it
  (hot water first in v1: the tank stores it for hours). Two controllers never both count on the
  same exported kW.
- **New inputs follow the same rule:** occupancy, a power-tariff cap, grid CO₂ (§19.6) would each
  be home-level, added once.

**What each controller keeps.** Its model, learner, planner, lever, guards and settings. The
orchestrator holds no model of a house or a tank: it sees planned charge slots and pre-heat
slots, and returns delivery-free and reserved slots.

**What ships when.**
- **M4 (hot water first):** household state on Main, the status line, the rescue guard, and
  the reserved-slots input on the hot water planner, always empty for now. Nothing to arbitrate
  yet.
- **M3:** the round order above, delivery-free slots in the heating model, rescue against
  pre-heat. Built ahead of M3 on 2026-11-15, with heating's pre-heat reaching hot water as a
  price adder (see "As built").
- **M5:** price adders and the joint plan.

**Failure and neutral.**
- If the orchestrator throws, each controller plans with no reservations for that round, and the
  Main status says so.
- If a controller fails, it goes neutral on its own (§1), the others replan without it, and the
  owner gets one timeline notification per incident.
- **Neutral for hot water is not "off".** On a pump set up like the maintainer's (start 5 °C,
  charges only on request), off means no hot water. So hot water neutral is a **rescue guard
  outside the planner**: the owner's "always keep at least" litres (default 40 L, hot water doc
  §4), requesting a charge below it unless the tank top is still at 45 °C or more, kept running
  whenever the connection is up, even with the planner or orchestrator down. An owner who sets
  it to 0 relies on the pump's own start temperature, so on a pump like the maintainer's the
  app restores the start temperature snapshot while Autopilot is neutral. If the
  litres estimate itself is unavailable, the app restores the owner's start temperature snapshot
  (60/59/58, taken at activation) and says so.

**SPA and the controllers.** SPA and Autopilot are exclusive per pump (§0.5): the mode is
pump-wide, and which controllers run is a per-function choice inside Autopilot.
- **Switching the first controller on** switches SPA off (843 = 0, snapshot first, §4.3).
  Switching the last one off leaves the pump in Autopilot with nothing on until the owner picks
  SPA or None in Repair, which restores the snapshot.
- **So the orchestrator sees every price-driven action on the pump.** No SPA schedule runs beside
  it.
- **A function with no Autopilot controller on has no price control.** Setup and Repair say so
  in one line per function.
- The snapshot drops 902, which does not answer on the S1155 (`registers.ts` at 902).
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

**If 0.1 shows the value is held forever:** Autopilot does not ship as designed. Go back to
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

**BT1 is safe and strong enough. Autopilot is built on it, and M1 starts.** Measured on the
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
- **SPA off.** It moves supply on its own and is exclusive with Autopilot (§10).
- **Not "Immersion heater only"** (237 = 2). Auto and Manual both run; Auto is recommended (§10.4).

**What one pump cannot tell us.** The gain is curve-dependent (curve 5 here) and the house is a
fast radiator house. Both are learned per pump in M1/M2, and M2 shadow needs a slab house and an
air-source pump before M3 ships (§7.5).

### 3.3 The gain far from the real temperature (done 2026-11-02/03)

§3.1 measured the gain at ±5 K. The planner may bias ±12 K (Save some) and ±20 K (Save the most),
and both the curve's shape and the supply limits (34 min, 38 max) can bend the gain out there. A
coast that moves half the heat the planner expects is a coast that saves half as much.

**Design (`dev/probe-bt1.mjs --ladder`):** settle as §3.1, then walk the fed value out in rungs
of 5 K, 75 min each, and recover for 150 min. A rung is 1.5τ, short of steady state, so the gain
is read against the curve's filtered view of the offset (τ 49 min known from §3.1): change in
supply over change in what the curve saw, rung by rung. Dry-run against the fake pump: 0.55 on
every rung for a fake gain of 0.55.
- **Pre-heat side (colder fake):** `--ladder -5,-10,-15,-20`. Risk: degree minutes and the
  immersion heater. Aborts if 1029 turns on or DM falls below `--min-dm` (−600).
- **Coast side (warmer fake):** `--ladder 5,10,15,20`. Risk: supply reaching min supply (34) and
  the compressor stopping; that is a result (where the lever ends), not a failure.
- Each side ~8 h: settle ≥ 30 min (up to 2 h), 4 × 75 min, recovery 150 min. Two days.
- Aborts as §3.1 (held setting changed, indoor more than 1 K from its start), plus the two above.

**Pass:** every rung within 20 % of 0.50. Otherwise `MAX_BIAS_K` (§7.4) is cut to the last rung
that passes, on that side.

**Before the run:** the §3.1 checklist (SPA off, room-sensor control off ≥ 60 min, nothing
planned at the pump, at home), operating mode as it is normally run (Manual here: the auto-stop
thresholds don't act, so the probe doesn't refuse on them), and a mild day for the pre-heat side.

```
node dev/probe-bt1.mjs --ladder -5,-10,-15,-20 --lat <lat> --lon <lon>
node dev/probe-bt1.mjs --ladder 5,10,15,20 --lat <lat> --lon <lon>
```

**Result, pre-heat side (2026-11-02, S1155, 07:57–18:20, outdoor 7–9 °C, SPA and room-sensor
control off, hot-water Flow paused):** 583 writes, 0 failures (one Modbus drop at 09:24 aborted
the first attempt; the probe now reconnects).

| Rung | Curve saw | Supply | Gain |
|---|---|---|---|
| −5 K | −3.8 K | +1.6 K | 0.42 |
| −10 K | −8.5 K | +3.8 K | 0.46 |
| −15 K | −13.5 K | +6.0 K | 0.44 |
| −20 K | −18.5 K | +8.1 K | 0.43 |

One gain through the origin: **0.44**, flat to −20 K. Every rung is within 20 % of 0.50, so the
pre-heat side keeps its full −20 K. The gain is linear but ~12 % below §3.1's 0.50: use the
measured value, not 0.50. Indoor stayed 21.5–21.9 °C, DM bottomed at −102, the immersion heater
never ran. After the last rung the fake was released and calc supply fell back from 36.5 to 29.3.

**Result, coast side (2026-11-03, S1155, 06:42–11:43, real outdoor 2 → 5 °C, SPA and room-sensor
control off overnight, hot-water Flow paused):** run in four pieces. A Claude restart killed it in
the +10 rung and a 5-min network loss (this Mac, `EHOSTUNREACH`) in the +15 rung, about 3 min of
which the pump spent back on its wired sensor. The probe gained `--resume` (picks up a dead run
from its log, while the pump still holds the fed value), `--no-abort` (limits log WARN and a
person decides) and unbounded reconnects under `--no-abort`. Baseline: calc 30.9 at real 2.1.

| Rung | Curve saw | Supply | Gain |
|---|---|---|---|
| +5 K | +3.8 K | −1.7 K | 0.45 |
| +10 K | +8.6 K | −4.2 K | 0.52 |
| +15 K | +13.0 K | −6.8 K | 0.59 (network gap) |
| +20 K | +18.4 K | −10.9 K | 0.77 |

One gain through the origin: **0.54** (562 points), but **not linear**: the gain rises as the fake
warms, where the curve flattens towards its foot. +5…+15 pass (within 20 % of 0.50); +20 does not,
so per the pass rule the coast side's `MAX_BIAS_K` is cut to **15 K**. Better than a cut: make
the planner's gain a function of the fed temperature (the curve's slope there) rather than one
number; the two sides together show 0.44 below the real temperature and 0.45 → 0.77 above it.
Calc supply reached 20 °C with no floor at 34, so min supply did not bind on this curve. Indoor
(116) 20.4 → 19.8 °C, DM −72…+100, the immersion heater never ran, no WARN.

---

## 4. Lever: BT1 feed

### 4.1 What is fed

`bt1Fed = clamp(teReal − bias)`, refreshed every **30 s**.

- `bias > 0` → the pump sees a colder day → more heat (**pre-heat**).
- `bias < 0` → the pump sees a warmer day → less heat (**coast**).

Rules:

- **The bias is in kelvin of outdoor temperature.** Its limit comes from the Profile (§7.4), up
  to 20 K pre-heat and 15 K coast (`MAX_COAST_BIAS_K`, cut by the §3.3 ladder).
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

Decided 2026-11-02 (maintainer): **a Homey outdoor sensor is optional and comes first; the
forecast is the fallback, not a fault.** M0.3 found no physical-BT1 register, and most owners have
no outdoor sensor, so requiring one would shut most of them out. In order:

1. **A Homey outdoor sensor** the owner picks in Setup.
   - Reuse the BT50 picker (`sensorInventory`), with the range widened to −50..50 °C.
   - A reading counts while present, changed within 2 h, and in range (`outdoor.ts usableSensor`).
   - Until Setup has the picker, the app setting `autopilotOutdoorSensor` (a `SensorRef`) is set by
     hand; Setup will write the same setting.
2. **The wired BT1 (input 1)**, only while nothing feeds it.
3. **Open-Meteo, bias-corrected.** The app learns `real − forecast` per hour of day from 1 or 2,
   as an exponential moving average, and applies it while feeding without a sensor.

Rules for the source:

- **Without a sensor, feed only when the bias is non-zero.** A neutral slot leaves BT1 to the
  wired sensor, so the correction keeps learning from the real value. If the forecast alone has
  carried more than 6 h in a row, go neutral for an hour to relearn.
- **History (M1, built).** Each slot records outdoor from the same order (`recordedOutdoor`). It
  flags input 1 more than 3 K from the sensor or forecast as a fed BT1 (a probe, a Flow card,
  another app), so a test feed never teaches the model a fake outdoor temperature. Measured
  2026-11-02: the ladder fed 3.6 °C, the Hue sensor read 7.2, the forecast 7.3.
- **Display.** While feeding, Heating's outdoor capability (`measure_temperature.i1_outside`) shows
  the **real** value, not register 1, and the BT1 average shows a rolling mean of the real values
  computed by the app.
- A new capability `measure_temperature.autopilot_fed` shows what the pump is being told (§10.1).
- Every consumer that reads input 1 must be audited for this:
  - `reason.ts` explanations (e.g. auto-stop);
  - detection (`lib/detection.ts`);
  - the Flow "outdoor temperature" triggers;
  - the pump-relocation check (`choosePumpCandidate` uses register 1 to verify a responder).

### 4.3 Activation and handover (the BT50 pattern)

**Activate** (Repair, Autopilot section). The owner sees three manual steps:

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

**Setup check (to build with this step).** Room-sensor control *is* readable on zone firmware:
holding 2978 (`id:12671`, u8 0..3, one per climate system through 2985), proven 2026-11-05 by
switching it at the display (202 never moved). So Pair, Repair and startup can check the heating
system directly, read-only: 2978 (+ climate system − 1) = 0, SPA 843 = 0, 5986 = 0. Treat any
non-zero 2978 as on until 2 and 3 are understood. 7.5.9 and 7.5.9.2 have no register; Verify's
feed-and-read-back stays their check.

Then **"Verify"** runs (handler `activate_autopilot`, 45 s client timeout):

1. If M0.0 found an activation flag, read it.
2. Snapshot SPA (843/844/845/846/902/848/849/850) into `autopilot.spaSnapshot`, then persist.
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
  - The gain is curve-dependent; it is learned per pump, not hard-coded. **Done (`lib/autopilot/curve.ts`,
    2026-11-03):** the history keeps input 1 as the pump saw it (`bt1`, fed or not) and the four
    settings that shape the curve (26, 30, 34, 38). Every slot is a point (BT1 through the 49 min
    filter, 1017); a piecewise-linear curve on 2 K knots, smoothed and made non-increasing, is
    fitted hourly from the points since the settings last changed (≥ 48 points over ≥ 3 K). The
    planner moves heat by `heatPerSupplyK × (S(curve) − S(te))` instead of `lever × (te − curve)`,
    so the gain is the curve's slope where the feed lands; until a curve exists it keeps the old
    lever at 0.5. Only slots with room-sensor control off (202, recorded as `roomctl`) are points:
    while it is on, 1017 also carries the room loop's correction, and on the S1155 that
    correction integrates. On 2026-11-03, after the coast ladder, 1017 climbed 34 → 49 °C over
    5 h at a steady BT1 ≈ 7 °C while indoor rose 19.7 → 22.0 toward its 22.5 setpoint, then held
    ~48 °C with indoor above it. A first version fitted `factor × (setpoint − indoor)` beside the
    curve; that term cannot describe an integrator and would have read a curve ~15 K too high.
    With room control always on, no curve is learned and the planner keeps 0.5, which smart
    heating requiring room control off (§4.3) makes the rare case.
  - **Bench (October prices, 20 days, Manual mode, true curve vs a planner assuming 0.5):** the
    learned curve takes the planner's own 1 h indoor prediction error to zero (fixed 0.5: up to
    0.014 K on the S1155's curve, 0.066 K on a flat 0.3 curve, 0.062 K on a steep 0.8 one), but
    savings and lowest indoor move by at most ±0.3 pp / 0.1 K: the hourly replan against measured
    indoor absorbs most of a wrong gain. Its value is a plan that says what will happen, which the
    guards and the owner-facing forecast rely on, and pumps far from 0.5.
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

While Autopilot is active, `NibePumpDevice.writeRegister` (`lib/device.ts:289`) rejects writes
to 5217 and to the SPA registers, with a translated message ("Autopilot controls this; switch
to SPA or None in Repair"). This is the same mechanism as the lock on 5987 during the BT50 feed
(`:291`).

The existing `external_temperature.h5217_bt1.set` Flow card is unavailable in Autopilot mode anyway,
because its capability is removed (§10.1).

---

## 5. Data foundation (M1)

### 5.1 Module layout

```
lib/autopilot/
  mode.ts        PriceControl 'spa'|'autopilot'|'none': capability filter, pump-wide sync   (pure)
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

**As built (2026-11-22).** `mode.ts` became `smart-mode.ts` (a mode per function, §10.0) and
`controller.ts` became `live.ts` (`HeatingFeed`, with `StopReason` in place of the §7.1 state
machine); the per-device glue is in `lib/device.ts`. Added since: `curve.ts` (learned heating
curve, §4.5), `setpoint.ts` and `trim.ts` (the trim, §7.3), `heat-check.ts`, `curve-advice.ts`,
`settling.ts` (Getting started, §7.7), `heating-status.ts` (status and reason), `heating-flows.ts`,
`away.ts`, `day-type.ts`, `orchestrator.ts` (§2.1), `solar-surplus.ts`, `cop.ts`, `optimiser.ts`
(§13), `savings.ts`, `season.ts`, `shift-cost.ts` (§11), `comfort-days.ts` (time in range per day),
`cost-check.ts` (Plan vs actual), and the widget data modules (§19.5). The hot water modules are in
[autopilot-hot-water.md](autopilot-hot-water.md).

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

**Fetch schedule** (as built, one price book per home in `lib/gateway-prices.ts`: today and
tomorrow for an hour, tomorrow every 15 min while empty, a past day for good):
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
- `global_tilted_irradiance` at `tilt=90`, `azimuth=0` (S), plus `direct_normal_irradiance` and
  `diffuse_radiation`, from which `solar.ts` works out the **east and west walls** (sun position
  per slot, isotropic sky, ground albedo 0.2). One request instead of three: over 14 days at the
  maintainer's location the computed walls matched Open-Meteo's own tilted irradiance within
  1–2 W/m² RMSE on all three (2026-11-01). History fields `gtiE`/`gtiW` were appended; files from
  before load with them missing, which the model reads as no sun on those walls.
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

**As built:** one fetch per home, `lib/gateway-weather.ts`: the forecast at most once an hour and
the irradiance history once a day, shared by the collector and the solar surplus.

### 5.4 History (15-minute aggregates)

**Hook:** Heating's `onPollComplete(readNames)` + `connection.lastRawFor()`, as the
room-thermostat sync does (`lib/device.ts:1379`). Bucket on UTC: `slot = floor(t / 900 000)`.

**Polling:** while the mode is `autopilot`, Heating's `wantedRegisters()` adds what the aggregator
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
| `heat` | fraction of polls with priority = heating (1028 = 30), for the COP (§13) | 0..1 |
| `emeter`, `pmeter` | 3823 used and 3821 produced, cumulative kWh, for the COP (§13) | last |
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
  - Kept in `/userdata/autopilot-<random>.bin`, which is publicly served, hence the unguessable name
    held in the device store.
  - Written via temp file + rename. Flushed hourly and in `onUninit`.
  - A version byte at the start; an unknown version means discard and relearn.
  - Only the small `autopilotModel` state (~2 KB) goes in the store, written once a day.
- **Insights backfill** (`heating-insights.ts`, built 2026-11-15, not yet run on a Homey): once
  per Heating device, the history before its first polled slot is filled from the app's own
  Insights, so an owner who had the app before turning Autopilot on gets a model on day one.
  - **What is read.** Every `autopilotHistory.numeric` capability (indoor, input 1, supply,
    return, 1017, brine, Hz, degree minutes, 2166, the 1577 and 3823 counters, curve, offset,
    min/max supply, setpoint, room-sensor control), plus the owner's outdoor sensor when one is
    picked. The Heating device first; a sibling device of the same pump only for a capability
    named after its register (`meter_kwh_NIBE.i1577_…`), since a plain `measure_temperature` on
    Hot water is the tank. Priority and the immersion heater are enum and status capabilities
    without a numeric log, so `dhw` and `aux` stay missing (the gate treats missing as no hot
    water; 1577 counts heating only, so the heat itself is right).
  - **Resolutions.** `last24Hours` (5-minute buckets) and `last14Days` (hourly), finest first per
    slot. `last7Days` is hourly too and adds nothing. Coarser ones are not read: a 6-hour mean
    says nothing about how fast the house moves, and two weeks of slots the filter can't correct
    on would only widen its parameter uncertainty while it predicts through them.
  - **Resampling.** A bucket mean stands for its middle. A slot mean is the 5-minute buckets inside
    it (measured), else the line between the two hourly middles around the slot's middle, never
    across a missing hour. A counter is read the same way at the slot's end; a setting is held
    from the bucket in force, never interpolated.
  - **Flags.** Every slot gets `FLAG.backfill` and `coverage` NaN. A slot with any mean or counter
    from buckets longer than a slot also gets `FLAG.hourly`: the EKF weighs its indoor reading
    with 4× the measurement variance (`INTERPOLATED_VARIANCE`, so an hour's four slots carry what
    the one mean does), and the 6 h accuracy and sun scores skip any window holding one.
  - **Outdoor.** The collector's own order: the owner's sensor with the same `tesrc` code the
    collector records for it, else input 1 as wired, else the corrected forecast. Input 1 is taken
    as unfed: these slots predate the collector, so the app never fed BT1 in them. A sensor's
    backfilled run joins its polled run with no source change (`currentSourceStart`); a wired run
    followed by a sensor is seen as the change it is.
  - **Weather.** Open-Meteo's `past_days` (same URL, ≤ 31 days) fills sun on each wall, wind,
    humidity and cloud, so backfilled days don't read as overcast. Prices are not backfilled.
  - **Never overwrites.** Only slots before the first stored one (or the open slot), and only as
    far back as the ring holds behind the newest slot. The window is read again at insert time,
    since polling goes on while Insights is read. Saved, then refitted at once.
  - **Once, off init.** Starts 3 min after the collector, needs the device's Homey id
    (`ownDeviceId`), retries every 10 min up to 6 times while it has none or nothing answered,
    and then waits for the next start. Device store `autopilotBackfill` = `{at, slots}` once it
    ran. A history already reaching back past the 14 hourly days (the maintainer's, from
    2026-10-30) gets nothing and is unchanged.
  - **Readiness.** Backfilled days count toward the 5 valid days like polled ones when they have
    48 usable slots. Accuracy is scored on polled slots only (8 windows need ~13 h), and stability
    needs three daily fits, so a backfilled owner is ready after three days at the earliest.
  - **Rate limit.** One request every 2 s, and a "Too many requests" refusal retried once after
    20 s; a missing log is skipped. The plan once measured a refusal after 2 rapid calls
    **[live]**; hot water's reader then ran 12 at 1.5 s apart. About 36 requests, so ~1.5 min.
  - Measured on a simulated radiator house (`test/autopilot-heating-insights.test.ts`): 13 days
    hourly plus a day at 5 minutes fitted heat loss 0.180 kW/K against a true 0.18, 6 h error
    0.03 K over the 18 windows the measured day allows.

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

1. **1R1C ARX by RLS** (λ = 0.998/slot): `ti[k+1] = a·ti + b·te + c·qheat + d·Σgti + e`.
   Reported beside stage 2, never shown. The history holds slot means, so the inputs are
   averaged over the two slots; that took the heat-loss bias on a simulated house from +6–10 %
   to 0. Its τ stays biased low by sensor noise (−50 % at 0.03 K).
   - **It no longer seeds stage 2 (2026-11-01).** Over a 3-day warm-up its heat loss ranged from
     0.06× to 26× the truth on a slab house, and a seed that far off left the mass unidentified
     for weeks (τ 695 h for 127 h). Stage 2 now starts from the warm-up's **energy balance**,
     heat over indoor-above-outdoor degree-hours: it ignores sun and gains, so it reads 8–25 %
     low, but it stayed within that on every simulated house and seed.
2. **2R2C augmented EKF.**
   - States `[ti, tm]`; log-parameters `[1/(CiRie), 1/(CiRim), 1/(CmRim), 1/Ci, AwS, f, Φint/Ci,
     AwE, AwW]`.
   - **Sun per wall (2026-11-01).** One window area each for the east, south and west walls, so
     a house with its glass to the west learns that its sun arrives in the afternoon, and one
     with little glass learns little sun at all; the planner then eases off at the right hours
     (§7.3). The walls' irradiance is correlated, so they separate only on days the sun shows at
     different hours; until then each stays near the prior (3 m²-equivalent). The areas are
     learned absolute, not per Ci like the rates: per Ci, an unobserved wall drifted to 9 kW of
     "sun" as the fit raised Ci sixfold on the maintainer's first day. On a simulated
     west-facing house the west area came out within 35 % and more than twice either other wall.
   - Exact zero-order-hold discretisation via the 2×2 matrix exponential.
   - **Priors from the owner's two Setup answers** (§6.6), not a fixed radiator prior. The EKF
     then learns the house; the answers only set where it starts and how far it may wander.
   - The BT1 → supply lag (τ ≈ 49 min, §4.5) and the emitter lag are a **known actuator stage in
     front of the house model**, not states the EKF has to find. Lumping them into the house is
     how a radiator house gets credited with storage it doesn't have.
   - **Measured on simulated houses (2026-10-31, `test/autopilot-model.test.ts`).** Over 21 days
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

**BT1 makes excitation cheap.** While learning in Autopilot mode, the controller may already feed
small, slow steps: ±3 K bias, at most twice a day, during cheap hours, inside the *Comfortable*
band.

- This breaks the collinearity between heat input and losses within days instead of weeks.
- It is covered by choosing Autopilot in Setup: the owner opted into control, and the steps are
  inside the tightest band.
- Before control is activated (pending state), learning is passive.

### 6.4 Quality

- "Model ready" = 6 h RMSE < 0.35 K over 7 days, at least 5 valid days, and τ stable within 15 %
  over 3 days.
- Before that, Autopilot heating shifts nothing for price: the status is Learning and names the
  first test still open (days, accuracy, stability). Once met, `readyAt` is kept with the model, so
  a later day that misses a test doesn't stop live heating. (Built 2026-11-15.) Since 2026-11-22
  price shifting waits longer still, until Getting started reaches Saving (§7.7).
- **The trim holds the setpoint while it learns (2026-11-19, live.ts `learn`).** Room-sensor
  control is off from the day Autopilot is chosen, and until then it had held the house on a curve
  the owner never had to set. Without the trim, that curve held the house alone for the 3–8 days
  of learning. Now the trim runs from the first slot with 12 h of indoor readings and a setpoint,
  at the default time constant (72 h) until the model's is known; the pump's guards hold as with a
  plan. `dev/simulate-trim-dayone.ts`, 200 houses with curves up to ±4 K off in level as well as
  slope: worst day of days 1–5 at the 90th percentile 1.0 K against 3.1 K on the bare curve (cold
  spell), 1.4 against 3.3 (±7 K swings); better on 163–180 houses, worse on at most 5, by at most
  0.12 K rms. Heavy houses (τ > 150 h) overshoot a little more at the default speed (90th
  percentile 0.7–0.9 K against 0.5).

### 6.5 House insights (settings labels, written only when the rounded value changes)

Not built as settings labels: the Autopilot widget replaced them (§10.0). `insights.ts` computes
the numbers, and the collector writes them as one line in the app log.

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
Evidence in [autopilot-research.md](autopilot-research.md#outcome-drivers-and-what-others-expose-2026-10-30).

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

Replaced as built: the Smart mode (off, spa, test, autopilot) plus Verify is the state, and
`live.ts` `stopReason` (`no_model`, `immersion_only`, `cooling`, `spa_on`, `room_control`,
`no_outdoor`, `mode_off`, `feed_failed`) is why the feed waits or stops. There is no `pending`
state and no owner pause (§10.0). The design below is kept for its reasoning.

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
  sends one notification: "Autopilot learned your house and now uses prices".
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
| SPA switched on elsewhere (display, myUplink, Greenely) | 843 | pause `spa_on`, warning "SPA was turned on at the pump; choose SPA or Autopilot in Repair". Never switch it off again |
| Add heat running during pre-heat | 1029 | bias → min(bias, 0) at once |
| DM approaching add-heat start during pre-heat | 11 vs DM start − 0.5 × 679 | cap the bias |
| Feed verification fails ×3 | input 1 ≠ fed | pause `lever_error` |
| 5217 or 843 answers with an exception after a firmware update | read exception | pause `firmware_changed` |

### 7.3 Planner v1 (M3, pure)

Runs every 15 min and on new prices or weather. Horizon: 24–36 h of slots.

1. **Trim** (always on): a PI loop on `ti − comfort`, gain-scheduled by model τ.
   - Feed-forward from predicted solar gain (×0.7) and the outdoor forecast over τ/4.
   - This is the Ngenic-class efficiency loop. It needs no prices.
   - **Built as feed-forward first (2026-11-07, `lib/autopilot/trim.ts`, shadow only).** The
     room-off run (2026-11-04…07, room-sensor control off as Autopilot requires) showed the curve
     alone does not hold comfort: indoor drifted ~1.5 K with the weather at every offset. So
     "doing nothing holds comfort", the planner's first assumption, was dropped:
     - The pump delivers `heatPerSupplyK × (supply − indoor)`, supply from the learned curve
       (`pumpHeat`). On that run it predicts indoor as well as the heat meter does: 6 h 0.33 K,
       24 h 0.49 K RMS against 0.30 / 0.48 K (`dev/check-supply-model.mjs`).
     - The **comfort bias** inverts it: the supply that holds the setpoint at the outdoor
       temperature, and what the curve must see for it. The planner's "doing nothing" is holding
       comfort; presets plan a shift on top, and the profile's limits apply to the shift.
     - Both the supply model and the meter run ~0.4 K cold over 24 h on that run (the house model,
       not the pump), so a correction on measured indoor is still needed: the integral, in M3,
       where there is a loop to close.
   - **Planning around the thermostat (built 2026-11-14, 09f1322 then revised the same night;
     `lib/autopilot/setpoint.ts`, `live.ts`).** Shift-only live planned around the house's own
     24 h mean and never read the thermostat, so with room-sensor control off nothing steered the
     house to the setpoint, and Away's lower setpoint did nothing.
     - **The planner aims at the thermostat.** `planLive` gets the setpoint as its comfort
       reference: the band is setpoint ± the comfort range, heat below the setpoint is owed, and
       the expected indoor path (the widget's Expected) heads for the setpoint, timed by price. A
       house 1 K below a 22.5 setpoint is pre-heated and reaches it within the 24 h plan; one
       above eases off; one at it only shifts around peaks (probe, 2026-11-14). Without a
       thermostat the reference stays the 24 h mean.
     - **A learned trim makes "no shift" hold the setpoint.** The shift-only model assumes feeding
       the real outdoor temperature holds the reference; a real house holds whatever the curve
       gives (the model's steady level was ~1 K off on the S1155, `tasks/todo.md` 2026-11-11). The
       trim is that difference, fed *under* the planner's shift (`comfortBias` to `fedValue`),
       ±10 K, its learned part stored in `autopilotTrim`, 0 while neutral.
     - **The trim is PI, paced by the house (2026-11-19).** The integral-only trim (0.02 K per
       K·h, learning within 1 K) left the S1155 at 21.9–22.2 °C against 22.5 for days: about
       0.2 K a day, and on a heavy house its lag carried it past the target. Now, on setpoint −
       24 h mean: `TRIM_KP` 2 K per K at once; the rest learned at `TRIM_SPEED` 4 ÷ the model's
       envelope time constant, paused while the error is already shrinking (6 h back); an error
       beyond 2 K counts as 2 K (it held still there until the same day, which left houses whose curve
       was set over 2 K off uncorrected for good: 59 of 200 in `dev/simulate-trim-dayone.ts`); held
       still for 24 h after the setpoint changes (Away starting or ending, the
       thermostat), while the 24 h mean still holds the old target's hours. Chosen on 200 simulated houses
       (`dev/simulate-trim.ts`: light to slab, curves 40 % too flat to 20 % too steep, the time
       constant off by up to 40 %, cold spells, ±7 K swings, sensor noise): better than the old
       trim on 185–200, worse on none; the gain starts to misbehave at 5. With the planner on top
       (`dev/simulate-trim-planner.ts`) see the numbers there.
     - **Heating curve advice (2026-11-19, `curve-advice.ts`).** The trim's learned part is how
       far the owner's heating curve is from holding the setpoint. Once the model has been ready a
       week and the learned part has stayed within 0.4 K for 3 days, it is read as a curve offset
       (register 30, menu 1.1.1 "set value for heating (curve offset)" with room-sensor control off,
       −10 – 10): learned K × the curve's gain where the house has been ÷ supply K per step (the
       curve fit's `offsetGain`, else NIBE's "+2 steps = +5 °C", 2.5, which errs towards fewer steps;
       the S1155 measured 1.53), at most ±3 steps; Autopilot changes it at most once in 30 days. An
       owner's own offset change does not start that wait (2026-11-21): advice reads the new curve
       after a week on it (the trim's integral settles at the house's pace), then the 3 steady days.
       Since 2026-11-22 the advice (`curveVerdict`) is acted on, written or asked, only once Getting
       started's settling is done, in its step 3 (§7.7); a verdict that the offset is already right
       ends that step. Heating setup asks once:
       **Adjust it for me** (default: Autopilot writes the offset once and says so in the Timeline,
       with Undo in Heating setup) or **I'll do it myself** (the Timeline, and the device warning
       when the Advanced setting "Show advice as a device warning" is on; problems always win the
       warning slot). A learned part that moves with the outdoor temperature (≥ 0.15 K per K over
       ≥ 5 K of daily means) is a slope that is off: advice only, raise or lower the curve (1.30.1)
       one step, since a curve number changes the heat differently in every kind of weather. Any
       offset change, by Autopilot, Undo or the owner on the pump, moves the trim's learned part
       by the heat the curve now gives itself (`trimShiftFor`), so the two never correct the same
       error twice; the last offset seen is stored, so a change while Homey was off counts too.
       Why: the curve is what holds the house whenever Autopilot can't (Homey down, the app
       restarting), and room-sensor control, which used to cover a curve that was never set, is
       off. NIBE's own tip matches the split: constantly too warm or cold is the offset (1.1.1),
       changing with the weather is the slope (1.30.1); menus checked in the S1155, SMO S40, VVM
       S320, S735 and S1255 installer manuals.
     - **The daily heat check (2026-11-19, `heat-check.ts`).** Indoor alone cannot tell more heat
       loss with more free gains from less of both; the S1155 fit settled ~10 % low, so plans
       expected less heat than the meter delivered (Plan vs actual 13–16 % low). The model's two
       equations added give a daily balance (heat in + gains + sun − H × degree-hours = heat
       stored in air and mass); over the last 3 complete days, when the model's heat is more than
       5 % off the meter's, the plan uses the heat loss the meter supports. Recomputed at every
       fit; drift and readiness still judge the filter's own heat loss.
     - **First version (09f1322), replaced:** a proportional trim on top of a planner that still
       aimed at the 24 h mean. It steered, but the planner's band and Expected curve ignored the
       setpoint, so the owner saw the house expected to stay where it was while it was being
       warmed (maintainer, 2026-11-14).
     - **Away is just another setpoint**, with the widest range. With an end time it is a setpoint
       *path*: the Away temperature, then the home's from the slot that ends at the return (§19.2).
   - **The wired BT1 trails the real outdoor temperature** (S1155: the sensor through a ~5.5 h
     lag, +2.3 K). Shadow's doing nothing feeds that; the fed flag compares input 1 with it.
2. **Price shift** (dynamic contract and model ready):
   - Coast in expensive blocks; pre-heat beforehand only when the model says the band can hold.
   - **With radiators** (short τ), coasting dominates: a few hours of −bias through a peak, with a
     small, late pre-heat.
   - Every candidate is **simulated through the model and clamped to the band**.
   - A shift happens only when `p_high / p_low > 1 + margin`.

**Built offline (2026-10-31, `lib/autopilot/planner.ts`, `dev/evaluate-presets.mjs`).**
- **Objective: cost at no-worse comfort.** Electricity bought, plus every degree-hour colder than
  doing nothing (H·Δt each) and any stored heat short at the end, bought back at the horizon's
  mean price. Warmth above doing nothing earns nothing and offsets nothing, so a pre-heat is
  worth only what it carries into a coast. "Doing nothing" starts from the steady state at
  comfort, not from now. The forms rejected on the way, each by a closed-loop bench:
  - *Keep the mean indoor ≥ doing nothing from now:* each replan's bar rose with the last
    pre-heat; the house ratcheted +0.2 K and cost 2–5 % **more**.
  - *Equal mean as a constraint:* over a finite horizon it weights early heat over late, so it
    forbade the evening coast (2.7 % where a hand-made coast found 8.7 %).
  - *Surplus credited, or offsetting deficits (equal average comfort):* heat at any
    cheaper-than-mean hour looked like a saving, and the planner held 24.5 °C all morning to pay
    for a cool evening.
- **Warm start.** Each replan starts from the previous plan, shifted. Starting from zero let the
  ramp drag every coast back to −6 K each hour, which cut the closed-loop result by two thirds.
- The house and curve are linear in the bias while the pump is between off and flat out, so one
  impulse response scores every move; a greedy search moves 1 K at a time and the result is
  re-simulated in full. About 5–30 ms a plan.
- **The lever, measured on the S1155 (2026-10-31, 18 clean heating hours):** heat follows the
  calculated supply above indoor at ~0.26 kW/K, and 1 K of fed outdoor moves supply 0.5 K, so
  **1 K of bias moves ~0.13 kW**, about 0.45 of the house's apparent heat loss (0.29 kW/K). A
  curve tuned to the house would give 1.0. `estimateLever` computes it from history; the planner
  takes it as `PumpCurve.lever`.
- **Result, 20 real SE3 days (2026-10-03…30, all-in `(spot + 0.609) × 1.25`), closed loop,
  hourly replanning, lever 0.45·H, Manual, comfort 22.5 °C:**

  | House | Comfortable | Save some | Save the most | best day |
  |---|---|---|---|---|
  | radiator (H 180 W/K, C 9.5 kWh/K) | 0.9 % | 2.3 % | 5.2 % | 13 % |
  | slab (H 120 W/K, C 15 kWh/K) | 0.7 % | 1.9 % | 5.4 % | 15 % |
  | radiator, bias up to ±40 K | 1.1 % | 2.9 % | 6.2 % | 15 % |

  Gross savings run 5–25 %; the rest is time spent cooler than doing nothing, which this
  yardstick charges for. Doubling the spot spread roughly doubles the result.
- **Model error barely matters to the plan.** Planned with a model learned passively, with
  "Don't know", or from the wrong answers, and applied to the true house, Save some and Save the
  most landed within 0.2 points of the perfect-model result on both houses (e.g. radiator
  4.9 % perfect, 5.0 % wrong answers). The owner's answers buy readable insights, not savings.
- **Open for M2:** the lever per pump and per curve setting (learn it live, `estimateLever`);
  whether ±40 K is safe (gain measured at ±5 K only, §7.4); Comfortable earns little (< 1 %)
  and may not be worth a setting of its own.

**Weather feed-forward (2026-11-01).** The Ngenic value: indoor stays level because heat is cut
*before* forecast sun lands and raised before a cold front, not after the sensor sees it.
- **Comfort is the setpoint**, not a simulation of doing nothing (`comfortReference`). The old
  reference counted the sun's overshoot as comfort, so easing off ahead of sun looked like making
  the house colder and never happened. Now warmth above the setpoint is worth nothing and costs
  the heat that made it; degree-hours below it are owed as before.
- **`comfortWeight` = 2 − price share**: what a degree-hour below comfort is worth as a multiple
  of the heat that cures it. Save the most (1.0) trades comfort at cost; Comfortable (1.7) pays
  extra to stay level, which is what makes a pre-heat ahead of a cold front worth buying.
- **No early exit on a thin spread.** Each move must still beat half the margin on the heat it
  moves, which a thin-spread arbitrage can't, but easing off ahead of sun saves outright and
  passes. The coast cap counts only slots below comfort: easing off while sun holds the house
  above it draws on no stored heat.
- **Forecast sun is discounted by the profile's forecast trust** (×0.58 Comfortable, ×0.74 Save
  some, ×0.9 Save the most), so a forecast that oversells sun leaves the house short by less.
- **Bench, real October weather (2026-10-03…30) at the maintainer's location, planned on
  Open-Meteo's day-ahead forecast, the house run on what happened**, lever 0.45·H, Manual,
  comfort 22.5 °C. *Fair* is the price-shift yardstick (against doing nothing, sun overshoot
  counted as comfort); *at comfort* counts warmth above the setpoint as worth nothing; RMS is
  the indoor distance from the setpoint:

  | House | Profile | fair | at comfort | RMS off setpoint (doing nothing) |
  |---|---|---|---|---|
  | radiator | Comfortable | 1.2 % | 10.8 % | 0.39 K (0.54) |
  | | Save some | 2.3 % | 15.3 % | 0.41 K (0.54) |
  | | Save the most | 7.5 % | 22.5 % | 0.69 K (0.54) |
  | slab | Comfortable | 0.3 % | 11.1 % | 0.55 K (0.62) |
  | | Save some | 2.9 % | 17.1 % | 0.54 K (0.62) |
  | | Save the most | 7.3 % | 23.2 % | 0.58 K (0.62) |
  | west-facing | Comfortable | 1.3 % | 9.9 % | 0.31 K (0.43) |
  | | Save some | 2.6 % | 13.5 % | 0.34 K (0.43) |
  | | Save the most | 7.9 % | 20.2 % | 0.65 K (0.43) |

  Planning on the day-ahead forecast instead of the weather that came cost under 0.3 points
  anywhere. Comfortable and Save some are **steadier** than doing nothing (−25 % RMS); Save the
  most is less steady, because it spends comfort for money by design.
- **The "at comfort" column is an upper bound, not a claim.** The simulated houses overheat on a
  clear October day with nothing to stop them (the bench's doing nothing is the curve alone), and
  the planner's own model of doing nothing is the same curve. A real pump with room-sensor control
  trims part of that overshoot itself: on the maintainer's S1155 on 2026-10-31 (sun up to 190 W/m²
  south) indoor stayed 22.3–22.6 °C while calculated supply fell 43 → 31 °C on its own. Smart
  heating needs room-sensor control *off* (§3.2), so against the owner's setup today the trim
  replaces the room loop rather than adding to it, and its worth is what M2 shadow measures.

The output per slot is `{bias, mode, reason}`. The reason is structured, e.g.
`{kind: 'coast', until: '19:00', priceRatio: 2.3}`, and rendered in six languages.

### 7.4 Profile (pure `presets.ts`)

**As built (live, 2026-11-12):** the owner picks a Comfort range, an indoor tolerance: Comfortable
±0.5 °C (the default), Save some ±3 °C, Save the most ±6 °C, with shifts up to 10 / 15 / 20 K
(`live.ts` `PROFILE_LIMITS`). Custom is eight fields in Heating setup's Comfort range step
(`CUSTOM_SETTINGS`: coldest, warmest, price ratio, coast hours, pre-heat and coast shift, comfort
weight, pre-heat lead), not the five sliders below. `presets.ts` and the table below drive the
shadow log (§7.5).

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
| **Use of stored heat** | 0–100 % | max coast length (0–8 h) and pre-heat lead (0–1 τ of the model); max bias scales with it, up to 20 K pre-heat and 15 K coast (§3.3) | no coasting or pre-heat beyond trim |

Not exposed, deliberately: price-spread floor, ramp speed and solar discount curve. They are
tuning constants that only make sense to us (PumpSteer and Nibe both learned this the hard way).
Coasting is capped at 8 h. The benefit of a single coast saturates around 6 h (12 h and 24 h price
cycles); the extra 2 h is for the deep band of *Save the most*.

**Presets.** Working labels; final copy in six languages comes with the strings. The values are
**starting points to tune in M2 shadow**.

| Preset | Coldest / warmest | Price | Weather | Stored heat | ≈ max bias (pre-heat / coast) | Who it is for |
|---|---|---|---|---|---|---|
| **Comfortable** | −0.5 / +0.5 K | 30 % | 60 % | 30 % (≤ 2 h coast) | 6 / 4.5 K | "I don't want to notice it" |
| **Save some money** (default) | −1.5 / +1.0 K | 60 % | 80 % | 60 % (≤ 5 h coast) | 12 / 9 K | most owners |
| **Save the most** | −4.0 / +2.0 K (a 6 K swing) | 100 % | 100 % | 100 % (≤ 8 h coast) | 20 / 15 K | "I don't mind it getting cooler" |
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
- **The coast goes as deep as the owner's curve needs (live, 2026-11-14).** The profile's coast
  limit (live.ts `PROFILE_LIMITS`: 10 / 15 / 20 K) is a floor, not a ceiling: `liveLimits`
  deepens it to where the learned curve's supply falls to the indoor temperature, which is where
  the pump delivers nothing, and only as far as the curve has been learned. On the S1155 (curve 5,
  offset +6) that is a fed 29 °C, the value at which an 80 °C feed stopped the compressor on
  2026-11-13, so from 2 °C outside a 27 K coast. No owner has to change their curve. The plan models
  the shift along the learned curve (`livePump`, `shiftOnly`), not the lever's straight line, which
  underestimates a deep coast where the curve steepens (0.4 K per K at 0 °C, 0.8–1 K per K at
  16–28 °C). The indoor tolerance still bounds every plan. Replay of 7–13 Nov (actual weather and
  prices, the planner's own cost): Comfortable within 1 %, Save some 3–31 % cheaper than before,
  Save the most 8–47 %, part of it a cooler house inside that profile's range.
- **Hot water has the compressor first (live, 2026-11-14).** Heating's plan reads the slots the hot
  water plan charges in (`withHotwater`, `ForecastSlot.busy`): the house gets no heat from the pump
  then, and the heat it missed is paid back right after, as the pump's degree minutes do
  (planner.ts `simulate`). Without the payback the model took a charge's missed heat as lost and
  pre-heated for it. With it, the replayed week's plans stay within a few percent of the plans
  without charges, and the modelled dip during a charge (0.2–0.5 K) matches the measured 0.2–0.3 K.
- Picking Custom starts the sliders at the preset that was selected; moving any slider shows
  Custom. Moving them back to a preset's values shows that preset again.
- **Expectations, said once in the FAQ, not in the UI:** most of a "saving" in any product is a
  lower average indoor temperature (≈ 5 % per °C). Price shifting proper is worth **a few
  percent**: ~1 % at Comfortable, 2–3 % at Save some money, 5–8 % at Save the most on October SE3
  prices (§7.3), more on volatile days and roughly double in a winter with twice the spread.
  Beyond that, the claim is **steadier indoor**, not money: easing off ahead of forecast sun is
  heat the house would have wasted, but how much depends on how far sun overheats it today, which
  the pump's own room correction already trims; M2 shadow measures it per house before any figure
  is quoted. Savings are reported at equal average indoor temperature (§11) so the two are never
  mixed. Copy this into `docs/FAQ.md` with the M3 release, not before: the feature isn't shipped.

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

**Built (2026-11-01, `lib/autopilot/shadow.ts`, wired in `collector.ts`).** Every closed slot plans
the next one for all three presets, off the poll's call stack, from: the hourly fit (parameters,
lever, and the mass at the last slot the filter corrected), the slot's indoor reading, the real
outdoor temperature (input 1: nothing is fed), the setpoint (2505), operating mode (237) and the
Auto thresholds (183/184/185) from the latest poll, and the forecast: Open-Meteo corrected per
local hour by what the wired sensor taught (`outdoor.ts`), with prices where known, else the last
one known. Each preset carries its own would-be bias, curve and plan between slots, so its log
reads as the feed sequence it would really have sent.
- **Log:** `autopilot-….shadow.jsonl` beside the history, one line per slot: indoor, outdoor,
  setpoint, mode, and per preset the bias, fed value, actuator clamps, planner reason, planned
  indoor 1 h and 6 h ahead and planned saving; plus where *doing nothing* was expected to be 1 h
  and 6 h ahead. Since nothing is fed, the house really is doing nothing, so that pair against
  what followed is the model's **live** error, forecast error included. Trimmed to 28 days. The
  carried state is in `autopilot-….shadow.json`. One summary line in the app log per hour.
- **Review:** `node dev/review-shadow.mjs <url of the .shadow.jsonl>`.
- **Not yet behind a setting:** it runs on the maintainer's dev build. Before any test-channel
  build it goes behind the hidden setting above.
- First live slot (2026-11-01 08:45): 2.3 s for all three presets on the Homey Pro.

### 7.6 Timers and lifecycle

- One `AutopilotController` per pump host, with Heating as owner, via a static
  `autopilotOwners: Map<host, device>` mirroring `indoorOwners`. *As built:* the feed is a
  `HeatingFeed` (`live.ts`) on the Heating device, and the per-host registry is `PumpRound`
  (`orchestrator.ts`, §2.1); `autopilotOwners` was not built.
- A 30 s feed loop (self-rescheduling `setTimeout` with a mutex, as `scheduleIndoor` does) and a
  15-min planner loop aligned to slot + 20 s. Prices and weather run on separate jittered timers.

| Event | Behaviour |
|---|---|
| `onInit` | Load the state, claim ownership. A second Heating on the same host → warning, no control. Re-check the SPA snapshot vs 843 (§8). Resume `learning`/`active`/`paused` by feeding neutral first, then the plan. |
| `onUninit` (app stop, update) | Flush history. **Feed neutral once** (best effort, 5 s). Persist the state as-is so it resumes. |
| `onDeleted` | Feed neutral. If the mode was autopilot, the owner must still turn off 7.5.9.2: send a timeline notification saying so. Restore SPA from the snapshot. Delete the history file. Release ownership. |
| Pump relocated / address edit | Ownership follows (`reconnectTo`, `lib/device.ts:1363`). Unlike the BT50 address-edit refusal, allow it: the feed resumes on the new connection. |
| Homey reboot, power loss, uninstall | Nothing runs. Safety then rests on M0.1: the pump must return to the wired sensor after the feed stops. This is the reason 0.1 is ship/no-ship. The FAQ explains uninstall: "Switch to SPA or None in Repair first". |

### 7.7 Getting started (built 2026-11-22, `lib/autopilot/settling.ts`)

Autopilot heating's first weeks, shown to the owner in four steps. Room-sensor control is off from
the start, so the owner's curve alone holds the house, often some way off the thermostat; the trim
closes that at the house's own pace (115 h on the S1155). Without a picture of it, a house 1 °C off
for a week reads as Autopilot getting it wrong.

1. **Learning:** the house model meets its readiness test (§6.4). The trim already holds the level.
2. **Settling:** each morning the day before is scored, its indoor mean against the thermostat.
   Two days in a row within 0.2 K (`SETTLED_K`, `SETTLED_DAYS`) settle it. A day with under 75 %
   of its readings, or whose setpoint moved (Away, the thermostat), is skipped; a new thermostat
   starts it over. After `MAX_DAYS` (21) it stops: a curve that far off is step 3's to fix.
3. **Calibrating:** the curve advice (§7.3) now acts, writing the offset or asking the owner.
   It ends when the curve already fits, after `CHECK_DAYS` (3) in a row holding the thermostat
   after an offset change, `ASK_WAIT_DAYS` (7) after the owner was asked, or after
   `CALIBRATE_MAX_DAYS` (14).
4. **Saving:** price shifting starts.

- **No price shifts before Saving.** The feed holds the level only (`FeedHooks.holdShift` in
  `live.ts`: the plan runs with no shift allowed and its reason is `getting_started`, "Getting
  started. No price shifts yet"), so reaching the thermostat and the curve check are never mixed up
  with a shift.
- **Savings count from Saving.** The state keeps `liveAt`, when the feed first shifted; heating's
  savings, baseline and first-live day are read from there (§11).
- **Morning messages.** One timeline line a day while settling. After each hourly fit
  (`device.ts` `afterFit`), settling and the curve advice run together, and "your house holds"
  plus a curve change in the same hour go out as one line.
- **Shown** in the Getting started widget (`widgets/getting_started`: a four-step stepper with each
  step's detail, and its paused, offline and restart states) and in Heating setup, which, when
  Autopilot is first chosen, draws what to expect as indoor temperature over time across the four
  steps (`setup.js` `expectChart`).

---

## 8. Restart reconciliation

*As built:* no SPA snapshot check at start. The feed re-checks the pump every slot (`stopReason`:
SPA, room control, operating mode), a feed input 1 does not follow ends in `feed_failed`, and SPA
turned on elsewhere flips the function to SPA (§10.0).

The store holds:

```
autopilot = {state, profile, custom?, houseAnswers, outdoorSource, spaSnapshot, pausedReason?, since}
```

On `onInit`:

| Situation | Action |
|---|---|
| Mode `autopilot`, 843 reads 0 | Resume by feeding neutral, then the plan |
| Mode `autopilot`, 843 reads 1 | Someone enabled SPA while we were down → pause `spa_on` |
| Mode `autopilot`, input 1 does not follow the neutral feed | `lever_error`: 7.5.9.2 may have been switched off at the display. Warning to re-verify in Repair |
| Mode `pending` | Warning only |

---

## 9. Model lifecycle

| Situation | Detection | Response |
|---|---|---|
| The house changed | Drift (§6.2) | Notify "Autopilot is re-learning your house". Back to `learning` limits |
| Pump replaced or re-paired | `heatpump_type` (1497) or the firmware label changes | Reset COP η and BT1 gain; keep the house parameters |
| Indoor source changed | `indoorSensors` state change | Keep the parameters, widen the covariance |
| Outdoor source changed | `outdoorSource` change | Reset the forecast-bias learning |
| Owner wants a fresh start | Repair → "Re-learn my house" | Clear the model and history |
| Start of the heating season | Too few heating slots | Stay in `learning`; insights say "Waiting for heating season" |
| Summer | Real outdoor above 184 | `idle`, neutral feed. Insights keep their dated last value |

---

## 10. Mode choice: SPA ⇄ Autopilot ⇄ None

### 10.0 Owner UI (maintainer, 2026-11-11): supersedes the pump-wide radio below

**SPA or Autopilot, per function, as one dropdown each.** SPA is three pump switches (843 master,
844 heating, 846 hot water), and Autopilot hot water already checks only its own function. So the
choice follows the pump: one pump-wide setting per function, mirrored on every device.

| Setting | Values |
|---|---|
| Heating price control | Off · Nibe Smart price adaption · Autopilot (test run) · Autopilot |
| Hot water price control | Off · Nibe Smart price adaption · Autopilot (test run) · Autopilot |

- One value per function, so it is always one or the other. Autopilot writes that function's SPA
  switch off at Verify (snapshot first); SPA writes it back on and stops Autopilot there. A test
  run never writes.
- **The pump stays the truth.** SPA switched on elsewhere (tile, display, myUplink) makes
  Autopilot step aside for that function: the setting flips to SPA and the timeline says so once.
  No silent skips (hot water's lever skips silently today; change it with this).
- The SPA on/off tiles go; the SPA influence pickers stay while the function is on SPA.
- One line under the group: "Choose one per function. Nibe's Smart price adaption runs on the
  pump with its own prices; Autopilot runs in Homey and learns your house, sensors and weather."
  Why both would fight over one compressor goes in the FAQ.
- No migration: `autopilotHotwater` was never released, so `priceHotwater` simply replaced it.

**Settings layout.** Homey shows one driver's settings on every device, so fewer, grouped,
pump-wide settings, each with a one-line hint: *Price control* (the two dropdowns) · *Autopilot
heating* (profile, comfort, away temperature) · *Autopilot hot water* (keep at least … L, solar
surplus) · *House insights* (labels) · the existing groups · *Advanced* (poll interval and debug
logging only). One-off things (sensor pickers, pump checklist, Verify, Return to NIBE) live in
Setup; settings hold the everyday knobs.

**Setup** (Heating Setup hub, a new Autopilot step after the temperature source):
1. Heating price control (the same value as the setting). With SPA heating on: "Autopilot turns
   off Smart price adaption for heating when you verify".
2. Checklist, one line each: indoor source (blocking); **outdoor sensor picker** (reuses the
   sensor picker with live reading and age; "Use the weather forecast" needs a location; the
   picker is not built, the maintainer's sensor was set through the API); prices (dynamic, or
   "Fixed price: saves energy, no price shifting"); on the pump, for On only: 7.5.9 writes,
   7.5.9.2 external BT1, room-sensor control off (2978, checked), SPA off (843).
3. Comfort temperature (default: last 7 days' indoor mean, to 0.5) and profile.
4. Verify (On only): feed the real outdoor once, input 1 follows within 3 s; error beside the button.
5. Turn off / Return to NIBE: stop, feed the real outdoor once, remind to turn off 7.5.9.2.

**What the owner sees.** Status on Heating (`autopilot_status_NIBE` as built: Learning · Holding ·
Pre-heating · Easing off · Paused · Off) with a one-line reason ("Easing off until 19:00: prices
peak 17–19"). While the model learns, Autopilot is **shift-only** (`lib/autopilot/live.ts`): it
keeps the owner's curve and only moves heat in time (since 2026-11-14 on top of the setpoint trim,
§7.3, which holds the thermostat), and the status says "Shifting heat only
while learning". *Replaced:* while learning the trim holds the level and nothing is shifted; since
2026-11-22 no price shift happens until Getting started reaches Saving (§7.7). Insights for the
fed outdoor and the bias. Timeline only on a mode change. A savings label after 14 active days (§11). The 24 h plan as a widget (§19.5).

**What the owner can tweak.** Profile (presets, Custom sliders of §7.4), comfort temperature,
away temperature (settings, tile picker and Flows); pause for 1–48 h and resume (Flows); away via
Main's day type, shared with hot water; the outdoor sensor and Verify in Setup. Flow cards as in
§10.3.

**As built (dev build, 2026-11-12, revised the same evening).** Settings are only for what is set
once. The rest is Repair and capabilities:
- **Smart mode** (off · spa · test · autopilot) is chosen per function in that function's Repair, and
  since 2026-11-14 also in pairing (ffd1421: Verify over a short pairing connection,
  `lib/pairing-pump.ts`; Heating setup asks Smart mode first, Hot water setup after the tank; the
  UI lists Autopilot once with Live or Simulated inside it). It is
  stored on its device (store `smartMode`, `lib/autopilot/smart-mode.ts`); Main's day type follows
  hot water's. Off and SPA show as the pump has them. SPA switches are written from
  `smartModeWrites`; SPA turned on elsewhere while Autopilot runs flips the function to `spa` with
  one timeline line, seen even with the tile hidden (`spaSeen` in `setValue`). Autopilot heating
  only through Verify (`activateAutopilotHeating`, store `autopilotHeatingVerified`, cleared when
  leaving for Off or SPA).
- **A device carries only its mode's controls**: the function's SPA tiles (844/845, 846/902) go
  while Autopilot runs it (`hiddenBySmartMode`; still polled); Heating gains status, reason,
  Comfort range (`autopilot_range_NIBE`), Away temperature (`target_temperature.autopilot_away`),
  outdoor shift (`autopilot_shift_NIBE`) and fed outdoor while Autopilot runs it. Away itself
  moved to Main on 2026-11-15 (`boolean_NIBE.away`, 0a1d577).
- **Comfort is the thermostat.** Away keeps the thermostat's value, sets it to the Away
  temperature, and restores it when Away turns off; while Away the widest range applies.
  Away is the home's one Away, shared with hot water (hot water doc §4.1): since 2026-11-15 a
  switch of its own on Main beside the day type (working or day off), set by the switch or the
  *Turn Away on until …* card (`set_away_until`), and every Autopilot heating device follows. A
  nightly working/free card does not end it (`day-type.ts`).
- **No pause; Comfort range Off instead** (maintainer, 2026-11-12): Off keeps feeding the real
  outdoor temperature with no shift (the pump stays on the sensor Autopilot uses, never back on its
  own BT1, which reads ~2 °C higher here) and plans nothing; the pump's guards still apply. Smart
  mode Off is what hands BT1 back. Leaving Autopilot while Away first puts the thermostat back;
  the home stays away for hot water.
- **The outdoor shift capability is what BT1 is fed minus the real outdoor temperature**: below 0
  the pump sees it colder and heats more (the planner's bias with the sign flipped).
- **The Autopilot dashboard widget** (`widgets/autopilot`, `lib/autopilot/widget.ts`) replaces the
  House insights labels: status and reason, then indoor temperature (left axis; measured, then the
  plan's expectation, thermostat dotted) against the BT1 offset (right axis) from 12 h back to
  12 h ahead. Hot water shows the next 24 h: price (left axis) against the expected solar
  surplus (right axis, kW), with each planned charge split into its solar and grid parts. The repair choices are named "Autopilot"
  (runs in Nibe Live) and "Smart price adaption" (NIBE's own, runs in the pump).
Profiles map to shift limits in `PROFILE_LIMITS` (`live.ts`). Built since: Custom (§7.4),
pre-heating before Away ends (§19.2), savings (§11), Getting started (§7.7).
- **The pump's operating state names Autopilot (2026-11-22, `reason.ts`).** When Autopilot
  switched More hot water on, the operating state's reason says Autopilot started heating hot
  water, with Autopilot's own reason, instead of a reason read from the pump.

**Experimental.** Autopilot carries an "Experimental" badge wherever an owner chooses or sees it: the Smart mode
choice, the comparison grid and a widget pill.

**Solar, as built (2026-11-12).** The sun reaches Autopilot two ways from one forecast, kept apart:
- **Solar gain** (heat through windows) enters the house model as a heat input. Live plans count
  forecast sun only once it has earned it (`sunReady`, `lib/autopilot/house.ts`). The test is:
  - On at least 5 days (`SUN_DAYS`), the sun term predicted sunny 6 h windows (south > 150 W/m²,
    at least 3 per day) better than leaving it out (`sunScore`, `model.ts`).
  - Its size has moved under 30 % across the last three daily fits. That is looser than τ's 15 %:
    the sun swung 0.1–1.1 kW in November.
  - Until both hold, trust is 0, exactly as before. After that it is 0.58 / 0.74 / 0.9 by Comfort
    range (`SUN_TRUST`).
  - The status names the sun ("sun expected 11:00–15:00") when it is easing off with no price peak
    to name, and only when the plan counts the sun.
- **Solar surplus** (PV export) is one service per home (`lib/autopilot/solar-surplus.ts`), shared by
  hot water and heating. It holds one fit, one live reading, and one budget granted in the order hot
  water → pool → heating → cooling.
  - Hot water reserves the slots its solar charges run in.
  - Heating prices the rest as an effective price (`surplusPrices`, `live.ts`): the share of a 2 K
    pre-heat's extra draw the surplus covers costs what an export earns.
  - Heating does not reserve yet; it is the last user until cooling exists.
  - Weather is one fetch per home since then (`lib/gateway-weather.ts`): the forecast with GTI
    per wall once an hour and the GHI history once a day, shared by the collector and the surplus.
  - Not built yet: heating reserving its own surplus (needed once cooling uses the budget), the
    heating widget drawing the surplus, and reading the sun gate on the S1155 over sunny days.
- Heating's feed idles while the pump cools (priority 1028 = 60, `stopReason` `cooling`).
- **Pool and cooling** get Smart mode (SPA or Off; `SmartFunction` includes them,
  `AUTOPILOT_FUNCTIONS` does not). Cooling switches 849. The pool has no switch of its own: its
  influence 848 = 0 is off, and the owner's value is kept to restore. Autopilot is listed but
  disabled, marked "Soon", and the comparison grid's "What it covers" says "Pool and cooling soon"
  (`covers_auto_soon`).
- **Phase 2, not built: Pool and Cooling Autopilot** (design in the solar plan and `tasks/todo.md`;
  after a tester is lined up).
  - Pool: heat-up and loss rates learned from pool temperature (27) and priority 1028 = 40, plus a
    sun coefficient on GHI for an outdoor pool. The planner holds the owner's band with cheap slots
    and granted surplus, reusing hot water's planner. Lever: the 687/689 start/stop band, at most 4
    writes a day, restored on Off. Guards: 691 off, read-back mismatch.
  - Cooling: the house model with cooling as negative heat, the gated sun term its main driver.
    Pre-cools in cheap and surplus hours within a cooling range. Lever by probe on a tester's
    pump, cooling offset 975 or room setpoint 988, never BT1 (shared with heating, and it moves
    the auto-mode average 37). Guards: 182 off, the season switch (186, 165).

**Phasing.** First test-channel release: Setup steps 1–5 with the outdoor picker, status and reason, profile
and comfort, Insights; learning phase = hold the level (pause/resume was dropped for Comfort range
Off, above). Later: full comfort control once
the steady level is confirmed (todo.md, 2026-11-11), away, savings, the remaining Flow cards,
widgets.

### 10.1 The selection field and its capabilities

*Replaced, not built:* Smart mode per function (store `smartMode`, `smart-mode.ts`) and
`hiddenBySmartMode` in `roles.ts` (§10.0) took the place of `selection.priceControl` and
`mode.ts`. The capabilities built are `autopilot_status_NIBE`, `autopilot_reason_NIBE`,
`autopilot_range_NIBE`, `autopilot_shift_NIBE`, `measure_temperature.autopilot_fed`,
`measure_temperature.autopilot_outdoor`, `target_temperature.autopilot_away`, and on Main
`day_type_NIBE` and `boolean_NIBE.away`. Kept below for its reasoning.

A new selection field and its per-function companion (§2.1):
`selection.priceControl: 'spa' | 'autopilot' | 'none'`, **pump-wide** (§0.5). Inside
Autopilot, which controllers run is per function: `selection.autopilot: {heating?, hotwater?}`,
each a boolean, set on that function's device (§2.1). Both sit next to `groups`/`overrides` and
are resolved in `lib/autopilot/mode.ts`. Not built yet, so the shape costs no migration.

- **Missing value means `spa`.** That is the upgrade path: existing devices keep exactly what they
  have today, in line with the "missing selection = everything" rule.

The pure `capabilitySyncPlan` (`lib/roles.ts:334`) gets one more filter:

| Mode | Removed from every device of the pump | Added (Heating unless noted) |
|---|---|---|
| `spa` | the Autopilot capabilities below | – (today's SPA set: 843 on Main; 844/845 Heating; 846/902 Hot water; 848 Pool; 849/850 Cooling) |
| `autopilot` | **all SPA registers** above, and `external_temperature.h5217_bt1` | `autopilot_mode_NIBE`, `autopilot_profile_NIBE`, `measure_temperature.autopilot_fed`, `measure_temperature_offset_NIBE.autopilot_bias`, `measure_money_NIBE.autopilot_savings` |
| `none` | both sets | – |

- **SPA registers are still polled in `autopilot` mode.** They go in Heating's `wantedRegisters()`
  without capabilities, so the `spa_on` guard can see 843.
- **Flow cards follow the capabilities automatically.** Every SPA card is `$filter`ed on its
  capability, and the Autopilot cards are filtered on `autopilot_mode_NIBE`. So "whatever is on has
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
| `autopilot_mode_NIBE` | enum, read-only | `pending · learning · normal · preheat · coast · idle · paused` |
| `autopilot_profile_NIBE` | enum, **setable** (picker) | the three presets plus Custom (Custom is shown, not settable from the tile). Tile and Flow use the same capability as the setting (§10.2) |
| `measure_temperature_offset_NIBE` | number, K | bias |
| `measure_money_NIBE` | number, units overridden at runtime from `getCurrency()` | savings this month |

`measure_temperature.autopilot_fed` uses the official type, so it lands in Insights correctly.

Other rules:
- No on/off capability: the mode choice is the on/off.
  - Pausing is a Flow action, and a pause shows in `autopilot_mode_NIBE`.
  - This also avoids a second `onoff` on Heating (memory: multiple-onoff tile).
- New names go in the collision test (`test/unit.test.ts:287`) and the "every extra has options"
  test (`:474`). Push options with `ensureCapabilityOptions`.
- **Insights titles are snapshotted forever**, so get them right first time.
- The `autopilot_profile_NIBE` picker `values` must equal its value list exactly (the existing picker
  test, `test/unit.test.ts:1290`).

### 10.2 Settings (Heating; group "Autopilot", shown only meaningfully in Autopilot mode)

*Replaced:* settings hold only what is set once; comfort range, Custom and the house questions
live in Heating setup and on capabilities (§10.0, §7.4). There are no House insights or savings
labels: widgets show them (§19.5).

| Setting | Type | Default |
|---|---|---|
| Comfort temperature | number 15–25 | mean indoor over the last 7 days, rounded to 0.5 |
| Profile | dropdown: 3 presets + Custom | Save some money. **Mirrors the `autopilot_profile_NIBE` capability**: a change in either updates the other |
| Coldest allowed, Warmest allowed, Price influence, Weather influence, Use of stored heat | numbers (§7.4) | the selected preset's values; editable only with Profile = Custom |
| Heating system, Built or last insulated | dropdowns (§6.6) | the Setup answers; changing one re-seeds the prior, it does not reset learning |
| House insights | labels (§6.5) | – |
| Savings since start | label | – |

- Each label and hint is one short line (memory: UI text is not an essay). The reasoning goes in
  the FAQ.
- In `spa`/`none` mode the hint reads "Choose Autopilot in Repair to use these".

### 10.3 Flow cards (custom, filtered `capabilities=autopilot_mode_NIBE`, six languages)

Add each card to the generic allowlist in `test/unit.test.ts:219`.

| Card | Kind | Args / tokens |
|---|---|---|
| Set profile | action | **built** `autopilot_heating_set_profile` (the comfort range) |
| Set comfort temperature | action | not built: comfort is the thermostat (§10.0) |
| Pause Autopilot for … | action | dropped: Comfort range Off instead (§10.0) |
| Resume Autopilot | action | dropped, as above |
| Autopilot mode changed | trigger | **built** `autopilot_heating_status_changed` |
| Autopilot paused | trigger | dropped |
| Autopilot is pre-heating / coasting / paused | condition | **built** `autopilot_heating_status_is` |
| Profile is … | condition | not built |
| Set away until … / Back home | action | **built 2026-11-15** as `set_away_until` on Main, "Turn Away on until …" (date, time); Back home is `back_home` (§19.2) |
| Away mode is on | condition | not built as its own card |
| Expensive period starts in … | trigger | **built 2026-11-15** `autopilot_heating_expensive_soon`: 5–720 min ahead; tokens `start`, `end` (§19.1) |
| Cheap period starts in … | trigger | **built** `autopilot_heating_cheap_soon`, as above |
| Pre-heating / easing off started | trigger | **built** `autopilot_heating_preheating_started`, `autopilot_heating_easing_off_started`: token `reason` |

Also widen `LocalizedText` from `{en, sv}` to six languages (`lib/profile.ts:100`), so that
`reason.ts` and the controller's reasons reach every owner in their language.

### 10.4 Pairing (`assets/pair/setup.js` hub)

*Replaced:* pairing asks Smart mode per function, in Heating setup and Hot water setup, with
Verify over a short pairing connection (§10.0). There is no pump-wide radio and no `pending`
state. The prerequisite checks below became Heating setup's checklist.

A new hub section, **"Price control"**. It is shown once per pump, on the Heating candidate, or on
Main if Heating is not being created; in that case `autopilot` is unavailable. It is a radio group:

1. **Nibe Smart Price Adaption.** The default if the pump has SPA enabled (843 read during
   detection).
2. **Autopilot (Nibe Live).** One line: "Learns your house and steers heating with prices and
   weather".
3. **None.**

Choosing **Autopilot** shows the prerequisites from a `get_autopilot_prerequisites` handler:

| Check | Pass | Fail |
|---|---|---|
| Indoor temperature source | Homey sensors are chosen in the Heating temperature section, or a NIBE room sensor is readable | Blocking: "Needs an indoor temperature", with a link into the Heating temperature section |
| Room-sensor control | Shown as the step "Room-sensor control is turned off in Repair" | Not blocking at pairing. Repair Verify enforces it (§4.3). The BT50 feed and Autopilot are exclusive pump-side, because both use the indoor loop |
| Real outdoor source | A Homey outdoor sensor picked here (reuses the picker), or none: the corrected forecast stands in (§4.2) | Optional |
| Homey Energy prices | `dynamic` → "Uses your Homey Energy prices (SE3, 15 min)" | Not blocking: "Saves energy; add dynamic prices in Homey Energy to also use cheap hours" |
| Location | Checked when Setup opens. With one: "Weather for your Homey's location". Without: a place search (Open-Meteo geocoding; only the typed name leaves the Homey, the result is kept to 2 decimals) saved as the app setting `autopilotLocation`; `searchPlaces()` and the fallback are built (2026-11-02) | Blocking only without an outdoor sensor, since the forecast is then the outdoor fallback. Otherwise "No location: no weather or sun" |
| Model | Not applicable at pairing | – |
| House questions (§6.6) | "How is the house heated?" and "When was it built (or last insulated)?", each with "Don't know" | Not blocking |
| Operating mode (237) | Auto: "Recommended" | Not blocking. Manual: "Works. Auto is recommended: the pump then stops heating in summer and keeps the immersion heater off in mild weather by itself". Immersion heater only: blocking |

The result goes into `selection.priceControl` on every created device. Heating's store also gets
`autopilot = {state: 'pending', profile, houseAnswers, outdoorSource}`. **No pump writes.** At
`onInit`, the pending warning points to Repair (the BT50 pattern).

`test/setup-ui.test.ts` cases:
- the section appears exactly once;
- blocking prerequisites disable "Save";
- a fixed price shows the soft message;
- pair mode emits no activate.

### 10.5 Repair

*Replaced:* each function's Repair has its own Smart mode section (Off, Smart price adaption,
Autopilot with Live or Simulated); pool and cooling list Autopilot as "Soon" (§10.0). The
transitions below still describe what each switch writes.

The Repair views stay per device, but the Price control section is the same on every device of
the pump: the mode is pump-wide.

**On Main, Hot water and the other devices:** the radio group plus a one-line status. A switch
*to* Autopilot from a non-Heating device sends the owner on: "Finish in Heating → Repair". The
activation needs the Heating context.

**On Heating, in Autopilot mode:**
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
| spa → autopilot | at Verify: snapshot SPA, 843 = 0, start the feed | swap on all pump devices *after* Verify succeeds | If Verify fails, stay `spa` |
| spa → none | 843 = 0 (snapshot first) | remove SPA caps | Restorable by spa |
| autopilot → spa | handover; restore 843 and the snapshot | swap | The model is kept in the store (dormant), so returning to Autopilot skips most learning |
| autopilot → none | handover; SPA stays off | remove Autopilot caps | – |
| none → spa | write 843 = 1, or the snapshot if one exists | add SPA caps | – |
| none → autopilot | as spa → autopilot without the snapshot | swap after Verify | – |

Errors appear beside the button (`p.setup-error`). The device-side methods are
`setPriceControl(mode)`, `activateAutopilot()` and `handoverAutopilot()`. They throw localised errors and
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
  temperature, so a colder house is not reported as Autopilot savings. Report shifted cost and extra kWh
  separately: a Danish field test cut cost 12 % while electricity use rose 9.5 %.
- On a fixed contract, savings = energy saved × the fixed price.
- **Note for SPA owners switching over:** the counterfactual is "Nibe without SPA", not
  "Nibe with SPA". The FAQ says so plainly.
- **SPA is the baseline that matters** (seen 2026-11-01: SPA cut supply from 36 to 26 °C over the
  evening price peak). Where the history holds weeks of the owner's own SPA running, report
  against those too, or say plainly that the figure is against the pump without SPA.
- **Widget:** this month's saving with its band, and comfort held, once the 14-day rule passes.
  A candidate for the widgets milestone (§19.5), not part of M3.
- **Built first instead (2026-11-15): the measured view, `lib/autopilot/savings.ts`, as two widgets:**
  Heating savings (`widgets/savings`, the id kept from when one widget did both) and Hot water
  savings (`widgets/savings_hotwater`, its own page since 2026-11-16, designed apart from Heating's).
  The maintainer's test of "does it work" is kWh leaving the expensive hours, so the first widget
  needs no model. Per complete day it keeps the function's kWh in the cheapest, middle and most
  expensive third of that day's hours, and its cost. Sources: Insights' hourly `meter_power.total`
  (14 days back, then a 400-day ledger in the device store) and the day's prices from Homey Energy.
  - **Fixed baseline.** A rolling "days without Autopilot" comparison fades out as the window fills
    with Autopilot days, so the comparison is frozen instead: `autopilotFirstLive` is stored the
    first time the Smart mode switches to Live, and the up to 28 days before it become the baseline
    (`autopilotSavingsBaseline`), never recomputed. A device that ran Autopilot before this was
    recorded dates it from the hours before its first mode mark (heating: the pump showed the fed
    BT1; on the S1155 that dated 2026-11-14 21:00 for a 23:14 start). With fewer than 3 days before
    it, the day's average stands in.
  - **Heating counts from Saving (2026-11-22).** Before Getting started reaches Saving (§7.7) the
    feed only holds the thermostat and moves nothing to cheaper hours, so those hours are part of
    the starting point, never a saving. The first-live day, the baseline and the counted days are
    read from Getting started's `liveAt` (`savingsLive` in `savings.ts`).
  - **Kronor saved.** The baseline is kept as the price paid against the day's average (its ratio).
    A whole Autopilot day after the first-live day saves its kWh at that ratio of its own average,
    minus what they cost. That holds the old usage pattern at today's prices, so a price change
    between the periods does not read as a saving. Days add up into the last 7 days, this month and
    this year. Hot water, since 2026-11-21: the old way's kWh are the day's litres at the
    baseline's kWh per litre (`Baseline.kwhPerLitre`), not Autopilot's own kWh. Applied to
    Autopilot's own kWh, the ratio hid a hotter tank or the immersion heater, which cost more per
    litre while buying in cheap hours.
  - **The year (2026-11-21).** Both widgets lead with this calendar year's estimate: saved so far
    plus the rest of the year at the pace so far (`yearOutlook`), drawn as one bar, solid then
    hatched. Heating's rest is weighted by the heating degree-days per month where the heat pump is
    (`season.ts`: the last three full years of daily mean temperature at the Homey's location, from
    Open-Meteo's archive, below the pump's own stop-heating temperature, register 184, else 17 °C),
    so a winter pace is not projected over the summer, in any climate. Without that history heating
    shows the month, never a guessed season. Hot water's days weigh the same. Both are also weighted
    by each month's price spread in the owner's zone over the last year (`seasonWeight`), so a winter
    of big price swings is not projected at an autumn's pace. Since 2026-11-22 that comes from
    Energy-Charts (`lib/gateway-price-history.ts`): one request a month for the zone set in Homey
    Energy, twelve numbers kept; Homey Energy's past prices answered NotFound or timed out for many
    dates. A week's kronor were too few to say anything on their own. The Overview adds both estimates up.
  - **Views** (the maintainer's picks from ten mocks): heating shows before and with as two 100 %
    bars of the three thirds with kWh a day; hot water shows what a shower cost before and with
    (litres from the tank model). Hot water's share of heat in the cheapest hours was dropped on
    2026-11-21: heating the tank hotter, or with the immersion heater, in cheap hours raises it while
    costing more. Heating keeps its share: the house sets the heat, so where it is bought is the
    lever. The Overview's ring shows heating's share only, for the same reason.
  - It shows when the energy was used. Total kWh and comfort are what the modelled figure above adds.
  - **A modelled old way, logged only (2026-11-22, `shift-cost.ts`).** Each heating day is
    simulated twice with the house model, as fed and with Autopilot's average feed held steady; the
    difference counts a pre-heat's extra use and follows the season. It is recorded and logged
    beside the baseline's saving; the widget still shows the baseline's.
  - **Plan vs actual** (`cost-check.ts`, `widgets/cost_check`): what the morning plan expected
    each function's electricity to cost over the rest of the day, against what it cost.

---

## 12. Hot-water timing and add-heat (M4)

Hot-water timing replaces SPA hot water in Autopilot mode. First, extend M0 (0.8–0.10) to establish
how to defer and advance hot water safely on the S1155.

**Exploration with measured numbers, approach and hardware tests:
[autopilot-hot-water.md](autopilot-hot-water.md)** (2026-11-08). On the S1155, 41 % of hot water
electricity lands at 16–20. A day-ahead tank planner is worth about 50–70 kr a month there, and
phase A (offline) can run alongside M2.

- **Superseded by [autopilot-hot-water.md](autopilot-hot-water.md) §4** (2026-11-08): the
  first sketch here (one 697 boost a day, deferral by lowering start setpoints 58/59/60) is
  replaced by the day-ahead tank planner, which writes only 697 (2 = one-time increase) and the
  Large stop 62, and never the start setpoints. The rule against charging into a heating
  pre-heat is gone: heating now plans around the charges (§2.1). **Never touch 195** (allow hot water) still holds.
- **Legionella:** never change 65/66/92. Give advice only: "Your weekly boost runs at 03:00; this
  week's cheapest slot is Sunday 02:15". *Replaced:* while hot water Autopilot runs live it takes
  over the pump's own charging and periodic boost (`hotwater-takeover.ts`, restored when it stops)
  and runs the legionella charge itself in the cheapest two hours before it is due
  (`legionella.ts`; hot water doc §4.3).
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
  - **Built 2026-11-15 (`lib/autopilot/cop.ts`), offline.** `COP = η · (tsup + 5 + 273) / (tsup −
    tsource + 10)`: the Carnot COP with 5 K of approach at the condenser and the evaporator, which
    keeps η near constant across lifts. The source is the brine in (10) when the history reads it,
    else the real outdoor temperature. The defrost penalty is not built; until it is, defrost lands
    in η.
  - **Learned from the counters.** Windows of heating-only slots (≥ 95 % of polls on priority
    heating, the immersion heater off, not partial), each running between two steps of 3823
    (it steps 0.3–2.5 kWh), cut at ~6 h and kept with ≥ 2 kWh used. η = Σ produced / Σ(Carnot ×
    used), produced from 3821 (or 1577 where 3821 is missing; over heating-only slots they count
    the same). The history gained `heat` and `pmeter` for it; slots from before them count by
    `dhw` < 0.05 with the compressor running. Refitted hourly with the house model; the 28-day
    history is its forgetting.
  - **Trusted** like the house model's readiness (§6.4): ≥ 12 windows on ≥ 3 days, their η within
    15 % (energy-weighted RMS), and the last three days' own η within 15 % of each other.
    Ground source also needs a brine reading to plan with (the last day's heating mean, held over
    the horizon). Until trusted the planner prices heat at the constant COP 3, unchanged.
  - **In the planner (`planner.ts`).** Each slot's heat is priced at the COP of the supply its
    curve view gives (the learned curve, §4.5): a pre-heat buys its heat at a warmer supply. A
    slot's electricity is convex in its heat, so the greedy search prices each move by the exact
    change at the heat the plan has reached, supply moving with heat along `heatPerSupplyK`; with
    flat weather a fixed rate per slot would be the same everywhere and the penalty would cancel.
    Owed heat is bought back at the heat-weighted marginal rate, not the average COP: at the
    average, every coast looked like a saving at a flat price.
  - **Effect on simulated houses** (`test/autopilot-cop.test.ts`, η 0.5, brine 0 °C, the S1155's
    curve, Save some, 6 h at 1.45× the rest): the pre-heat fell from 51 to 22 K·slots on the
    radiator house and from 74 to 26 on the slab, and the coast with it. At 4× both still shift.
    Where a constant COP coasted deep (Save the most), the COP spreads the shift into a smaller
    coast and some pre-heat, which convexity favours. ~2× the planner's time (100 ms for 96 slots
    on a Mac).
  - **Unverified on hardware:** η and its spread on a real pump (the S1155's 3823 steps are
    uneven enough that the 15 % spread gate may need widening), and whether 3821 counts only the
    compressor.
- **PV:** moved to M4 (§19.3). The optimiser keeps the same rule: a slot with forecast surplus is
  priced at the export value.
- **Fallback:** if the solve throws or takes longer than 5 s, use the M3 plan.
- **Built 2026-11-15 (`lib/autopilot/optimiser.ts`), shadow only.**
  - State: `ti` 40 points over the band ±0.5 K, `tm` 40 points over doing nothing's mass ±(band
    + 1 K), and what the curve sees beyond the real outdoor temperature, `d` (12 points), stepped
    by the curve's own filter, `d' = (1 − α)(d + Δte) + α·bias`, which is the planner's `simulate`
    exactly. Feeds are 7 levels from the deepest coast to the largest pre-heat (0 among them).
  - **One decision an hour**, each simulated slot by slot. At one decision a slot (§13's first
    sketch) a slot's feed moves indoor ~0.02 K, an order of magnitude under the grid's spacing,
    and the interpolation's error chose the plan: on a real day its plan cost more than the greedy
    planner's on the DP's own objective. Hourly, it beats the planner on every plan it makes.
  - Cost per slot: price × electricity at the learned COP once trusted (above); the planner's
    owed heat per degree-hour below the setpoint, so both chase the same objective; 20 × mean
    price per K² outside the band (w_low, w_high); 0.002 × mean price per K the feed differs from
    what the curve sees (w_ramp). Terminal: stored heat short of comfort, bought back like owed heat.
  - **The actuator's ramp** (2 K a slot) is not in the state: the values assume a level is reached
    at once. The forward pass knows the bias in force and ramps each candidate from it, so the
    plan is one the actuator can send. That recovered a quarter of what ignoring the ramp cost
    (below); the rest needs the bias in force as a fourth dimension, not built.
  - About 100 ms for 96 slots on a Mac (24 decisions × 19,200 states × 7 feeds, inner loop
    inlined); one decision per `setImmediate`. The plan is re-simulated through the planner's
    exact model and scored with its `fairCost`; a plan that doesn't beat doing nothing there is
    doing nothing.
  - **Shadow log:** each slot, beside the shadow's default preset (Save some), from that preset's
    own state and warm start: `dp: {preset, bias, shift, ahead, cost, planner, baseline, ms,
    fallback?}`, where `cost` and `planner` are the predicted horizon costs at equal comfort.
    The hourly log line adds the DP's bias and both costs. Nothing is fed from it.
- **Measured offline (2026-11-15, `dev/evaluate-cop.mjs`).** 45 real SE3 days (2026-10-01…11-14,
  public spot prices, which match Homey's to 0.1 %, all-in `(spot + 0.609) × 1.25`), Open-Meteo's
  weather for central Stockholm, and the same days on a −5 °C day shape. The live build
  (shift-only, live profiles, the S1155's learned curve), closed loop, hourly replanning, on a
  simulated pump whose COP is η 0.5 × Carnot from 1 °C brine at the supply it really runs. Saving
  at equal comfort against doing nothing on that pump, totalled over all days:

  | | old view (pump at COP 3) | planner, COP 3 | planner, learned COP | DP |
  |---|---|---|---|---|
  | real weather, mean of 3 houses × 3 profiles | 4.38 % | 2.44 % | 2.51 % | 2.53 % |
  | −5 °C day shape | 4.45 % | 2.66 % | 2.79 % | 1.96 % |
  | air source (η 0.4), real weather | 4.38 % | 2.02 % | 1.78 % | – |

  - **A pump whose COP falls with supply takes ~40 % off every saving measured so far.** The
    yardstick of §7.3 priced the pump at a constant COP, so pre-heating looked free. That is the
    big finding, and it holds for every house and profile.
  - **Pricing heat at the learned COP wins back almost nothing**: +0.07 and +0.13 points on the
    means, up to +0.65 on Save more in a radiator or west-facing house, but −0.1 to −0.5 on the
    slab, and −0.24 on air source (−1.9 on the slab at Save more). It is the right price; the
    greedy search gains little from it. An η 20 % off changes no plan at all (only the COP's
    shape steers a plan, not its level).
  - **The DP** beats the planner at Comfort in every house and weather (+0.5 to +1.6 points), and
    on the slab at every profile in real weather. It loses at Save some and Save more elsewhere
    (−0.9 to −1.3 points in real weather, −1.0 to −1.9 in the cold, slab included). The loss is
    the ramp, which bites hardest where the profiles allow the widest swings: with the actuator's
    ramp lifted for every arm (`--no-ramp`, radiator, Save some, 10 days) it led the planner by
    0.05 points, 0.25 at comfort. Not yet worth feeding.
  - **Side finding, not from this work:** planned on a house 30 % off (heat loss ×1.3, mass ×0.7),
    the slab *loses* 6–8 % at Comfort and Save some in the live build, with either COP. October's
    "model error barely matters" (§7.3) was measured on the presets and full model, and does not
    carry over to shift-only live on a slab. Worth its own look before live ships to slab houses.
  - The ship gate below is unchanged.
- **Ship gate:** beats M3's counterfactual on at least 3 test houses over 4 weeks.
  - Radiator houses gain least here, so the slab tester is essential.

---

## 14. Analytics (read `docs/analytics-taxonomy.md` first; port any change to com.homevolt.local)

All events are edge-triggered, with enums and buckets only.

*Replaced as built* (source of truth: [analytics.md](analytics.md) "Autopilot"): `Changed Smart
Mode`, `Changed Autopilot Setting`, `Changed Autopilot State`, `Blocked Autopilot`, `Scored
Autopilot Day`, `Started Hot Water Charge` and `Changed Day Type` (`lib/autopilot/analytics.ts`
holds the bounded values). The table below is the October proposal.

| Event | Properties | When |
|---|---|---|
| `Changed Price Control` | `from`, `to`: `spa\|autopilot\|none`, `via: pair\|repair` | mode change |
| `Activated Autopilot` | `outdoor_source: nibe\|homey`, `price_mode: dynamic\|fixed\|none`, `weather: on\|off` | Verify succeeded |
| `Paused Autopilot` | `reason` (enum §7.1) | into paused |
| `Learned House Model` | `days_bucket`, `rmse_bucket`, `system: fast\|slow` | learning → active |
| `Changed Autopilot Profile` | `profile` (preset or `custom`) | edge. Name to be checked against `docs/analytics-taxonomy.md` before it ships |

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
- **outdoor:** source priority (sensor, unfed BT1, forecast); forecast-bias learning; a fed BT1 recognised in history; the 6 h relearn pause.
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
  you switch to Autopilot";
- FAQ entries:
  - choosing SPA vs Autopilot;
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
- [x] **M1** mode choice: built as Smart mode per function (`smart-mode.ts`), in pairing and Repair (§10.0), not as `mode.ts` and a pump-wide "Price control" section
- [x] **M1** `prices.ts`, `weather.ts`, `outdoor.ts`, `history.ts` + `/userdata` persistence + Insights backfill
      (collecting on the maintainer's Homey since 2026-10-30; prices and weather through the
      Gateway since; backfill built and tested offline 2026-11-15, `heating-insights.ts`, not yet
      run on a Homey with a fresh history)
- [x] **M1** `model.ts` + `insights.ts`, fitted hourly on the maintainer's Homey; the labels became
      the Autopilot widget (§6.5); nothing released to test
- [x] **M2** `presets.ts`, `planner.ts` v1, `actuator.ts` and the shadow (`shadow.ts`), running on the
      maintainer's Homey since 2026-11-01; the controller became `live.ts` (§5.1); twin integration
      test not built
- [x] **M2** §3.3 gain ladder to ±20 K on the S1155 (pre-heat 2026-11-02: 0.44 flat, −20 K stands;
      coast 2026-11-03: 0.45/0.52/0.59/0.77, +20 K fails; coast limit cut to 15 K, the learned curve (§4.5) gives the gain per fed temperature)
- [ ] **M2** two weeks of shadow on ≥ 3 houses (radiator, slab, air-source)
- [ ] **M3** Verify/handover, live feed, capabilities, Flow cards, write lock on 5217, savings, analytics,
      Away, Getting started (§7.7): built, live on the S1155 since 2026-11-14. §8's restart table
      is covered by the feed's own checks each slot (`stopReason`, SPA seen in `setValue`); the
      6-language `LocalizedText` is not done
- [ ] **M3** release (test → live)
- [x] **MW** widgets (§19.5)
- [x] **M4** shared solar surplus, heating's surplus price and sun gate, Smart mode for pool and
      cooling (§10.0, 2026-11-12); still open: heating reserving surplus, the sun gate read on hardware
- [ ] Phase 2: Pool and Cooling Autopilot (§10.0), not started
- [ ] **M4** hot-water probes and timing; DM-aware add-heat planning. Hot water's add-heat guard built
  2026-11-15 (learned compressor ceiling, target under it, [autopilot-hot-water.md](autopilot-hot-water.md) §4.8);
  the DM rule of §12 is heating's and still open
- [ ] **M5** COP, DP optimiser, air-source, PV; ship gate vs M3
      (COP model learned and pricing the planner's heat once trusted, offline 2026-11-15; air-source
      learns against outdoor, no defrost penalty yet; DP optimiser built and logging beside Save some
      in shadow 2026-11-15, never fed; offline bench `dev/evaluate-cop.mjs`: the learned COP gains
      ~0.1 point, the DP wins at Comfort and loses at the wider profiles until the ramp is in its
      state; ship gate not started)

## 19. Roadmap decisions (maintainer, 2026-11-02)

What makes Autopilot stand out against Nibe SPA, Tibber and Ngenic, decided after the M2
shadow results. **Out of scope:** running the whole house's energy (heat pump, EV, battery and
solar under one fuse limit). That is an app of its own, not part of this one.

### 19.1 Transparency (M3)

The competitors are black boxes. Owners switch off what they don't understand.

- **Every decision has a plain reason**, in the owner's language. For example: "Cooling 0.3 °C
  until 19:00: prices peak 17–19 and the house holds heat about 4 h". It is shown as the Heating
  status, and in the timeline only on a change of mode, never per slot.
- **Planned heating and savings** are shown as widgets, which have a milestone of their own
  (§19.5). M3 keeps the data they will draw: the current plan (`planShift` already returns indoor
  per slot) and the savings ledger (§11).
- **Flow cards that expose the plan** (§10.3): an expensive or cheap period starting in N
  minutes, and pre-heating or coasting started. Owners can then move the dishwasher, sauna or EV
  around the heat pump without us modelling those devices.
  - **Built 2026-11-15** (`lib/autopilot/heating-flows.ts`, wired in `device.ts`
    `checkPricePeriods` and `showHeatingStatus`). Heating device only, while Autopilot heating
    plans (live or Simulation).
  - **The periods are the status's.** Expensive is `pricePeak` over the plan's forecast from now,
    exactly what the Heating status calls "prices peak"; cheap is its mirror (`priceTrough`, within
    10 % of the spread from the bottom). One of each per horizon, so a card and the status never
    disagree.
  - **Once per period, per Flow.** The device checks after each 30 s feed cycle and fires the card with the
    window since the last check; a Flow fires when `start − minutes` falls in it (`periodDue`). A
    period stays the same one while it overlaps or touches the one seen before (edges move a slot
    as prices arrive; a one-slot spike that moves a slot only touches its old self), and every
    Flow's moment counts from the start it had when first seen, so a later edge never fires it
    twice. A period that appears inside a Flow's lead (tomorrow's prices) fires it late, once. The
    first check after a restart, or after the plan stopped (Autopilot off, paused), only learns
    what is there. The lead starts at 5 minutes: at 0 the period has begun.
  - **One expensive and one cheap period per horizon,** the most extreme runs, as the status names
    them. Once tomorrow's prices land and tomorrow's peak is higher, tonight's peak no longer fires.
    Open for the maintainer: a daily peak would serve the dishwasher use better, but the status
    would then have to name it too, or the two disagree.
  - **Pre-heating / easing off started** fire on entering that status from any other, next to the
    existing "Autopilot heating changed"; the existing status condition covers "is pre-heating".

### 19.2 Away mode (M3)

Our own, rather than the pump's holiday setting, so the planner knows when the owner returns.

- **Set:** the Away switch on the Main device (`boolean_NIBE.away`; until 2026-11-15 the day type
  "away", [autopilot-hot-water.md](autopilot-hot-water.md) §4.1), shared with hot water; the Flow
  card takes an optional end time. **Back home** ends it early.
- **While away**, comfort drops to the away temperature (a setting, default 17 °C), and the
  planner coasts through expensive hours within it.
- **Return:** the model's hours-per-degree says when to start warming, so the house is at
  comfort at the end time, on cheap hours where it can.
- **Built 2026-11-15** (`lib/autopilot/away.ts`, `live.ts` `planComfort`, `planner.ts`
  `SetpointPath`):
  - **Set:** the Flow card "Turn Away on until …" (`set_away_until`, date, time, read in Homey's
    time zone). The end time is its own app setting (`autopilotAwayUntil`), beside the day type,
    which Away leaves as it was. The driver checks each minute and ends Away at that time, as the
    `back_home` card does; turning Away off clears it. A time already past is refused with an
    error.
  - **The plan's setpoint steps** from the Away temperature to the stored home one at the first
    slot that ends at the return (`setpointPath`). The band's ceiling before the step is the
    setpoint still to come, or the pre-heat would sit outside it.
  - **Arriving is a promise, not a trade.** Away plans with Save more (weight 1.0), and at that
    weight, or even at 10× on degree-hours, the planner arrived 0.4 K short: an hour a little cold
    costs few degree-hours, and early heat leaks away. So at the return each kelvin short costs
    the house's whole heat capacity times `FIRM_WEIGHT` (10), and heat owed from then on 10× too.
    Among the ways to arrive, the cheapest still wins.
  - **The horizon is too short for a slab.** At Save more's 20 K and lever 0.5·H, warming 17 →
    21 °C at 2 °C outdoor is estimated (margin included) at ~32 h for the radiator sim house
    (C 9.5 kWh/K) and ~87 h for the slab (C 15 kWh/K), longer than the 24–36 h plan. `warmUpSlots` simulates the warm-up flat out (ramped as the
    feed ramps, +15 %) from the house's state; once the return is that close, the step is placed
    at the horizon's last slot until the real one comes into view.
  - **The warm-up latches** for that return (`warmingFor`, kept in the device store across a
    restart). Without it the lead shrank as the house warmed, the step left the horizon, Save more
    coasted, and the house arrived short.
  - **Ending by itself is retried.** If a device fails to follow (the thermostat write, pump
    offline), the driver tries again each minute until it does: the end time and day type are
    already gone by then, and nothing else would put the thermostat back.
  - **Status:** while it pre-heats for the return the reason says so ("Until 16:00, before you're
    back at 18:00", with the weekday when the return is not today) instead of naming a price peak.
  - **Tested closed loop** on the radiator and slab sim houses (`test/autopilot-away-flows.test.ts`):
    with four days' notice both are within 0.2 K of the setpoint at the return, neither more than
    1 K over, no warm-up long before the lead.
  - **Unverified on hardware.** The model's "no shift" holds whatever setpoint the plan aims at;
    on the pump it holds the level the trim learned at home, which Away does not unlearn (it is
    beyond the trim's 2 K hold, so the trim stays where it was). So the real house likely warms faster than planned, and the
    estimate is conservative. Hot water before the return is not part of this (M4).
- **Hot water** (M4): no boosts while away, and refilled before return.

### 19.3 Solar surplus (M4)

*Built 2026-11-12* as one service per home (`lib/autopilot/solar-surplus.ts`) with a budget granted
hot water → pool → heating → cooling; see §10.0 "Solar, as built". The research note below stands.

Sweden pays roughly spot for exported power but charges spot plus grid fee, tax and VAT for
imported power. Every surplus kWh used at home is therefore worth about 1 kr more than one sold.

- **Live:** Homey Energy's live report gives grid export. Sustained export above the
  compressor's draw for 10 min is priced at the export value in the planner, which then
  pre-heats within the comfort ceiling. Sunny winter days count too.
- **Hot water first:** a 200–300 L store that is needed all year is the best sink. "More hot
  water" (697) is used when the tank has room, under §12's rules.
- **Planned:** the forecast's sun (already in the history) gives the expected surplus a day
  ahead, so the planner can leave room for it instead of buying heat that morning.
- **Research first:** read how Home Assistant users run Nibe pumps on surplus before building.

### 19.4 Autopilot hot water (M4, §12)

Beyond the timing in §12: learn the household's draw pattern from the estimated litres, and have
hot water ready before the usual peaks (for example morning showers), heated in cheap or surplus
hours. No boosts while away.

### 19.5 Widgets (milestone MW, maintainer 2026-11-02)

Widgets get a broader look across the whole app, not one per feature, so they are a milestone of
their own rather than part of M3.

**Built (dev branch):** Autopilot (`widgets/autopilot`, §10.0), Heating savings and Hot water
savings (§11), Day plan (below), Getting started (§7.7), Plan vs actual (`widgets/cost_check`),
Energy today (`widgets/energy`), Heat pump overview (`widgets/overview`), and hot water's two,
Hot water and Hot water use (hot water doc). Autopilot's candidates as first planned:

- **Planned heating:** the next 24 h, with planned indoor against comfort, the pre-heat and coast
  blocks, and the price beneath; redrawn when the plan changes.
- **Savings:** this month's saving with its band, and comfort held (§11).
- **Day plan** (maintainer, 2026-11-15; `widgets/day_plan`, `lib/autopilot/day-plan.ts`): the
  plan round (§2.1) drawn for one pump, picked by its Main device. Today 00:00 to 24:00, like the
  other cards, so they line up. Headline: Main's status line. Three lanes on one time axis: the
  price, hot water's charges (solar part amber, grid part blue) and heating's shift as one bar an
  hour, up when it heats more (red) and down when it eases off (teal). Heat-up reads up here,
  the other way round from the Autopilot card's BT1 offset, because this card is about what the
  house gets. A function without Autopilot has no lane; with hot water off, heating's forecast
  fills the price. No indoor line, to stay readable at phone width. It reuses the two Autopilot
  cards' data, so the three always agree.

### 19.6 For later consideration

- **Room sensors and radiator valves** (Tado and others): use the coldest room that matters as
  the comfort limit, and valve openings to see where the heat goes. Value depends a lot on the
  implementation, so it gets a design of its own before any build.
- **Health checks from the model:** drift in heat loss, COP or brine temperature as early
  maintenance advice. Maybe later.
- **Known heat gains** (sauna, oven, dryer power), **window contacts** (pause learning while
  open), and grid CO₂ intensity: candidates, not planned.

## 18. Open questions

1. Is a slab/underfloor tester available in the test channel? M5 cannot be judged on radiators
   alone.
2. Should the default for an existing SPA-enabled pump stay `spa` after upgrade (proposed), or
   should the app prompt once via the timeline to try Autopilot?
