# Working plan

Open work first. What has shipped is in the commits and in the **Releases** table in
[`docs/releases.md`](../docs/releases.md), the durable rules are in
[`CLAUDE.md`](../CLAUDE.md), and the design write-ups are under [`docs/`](../docs).

## Comfort trial from Monday 2026-11-30: ready by Sunday evening

A week on each comfort range (Comfortable 30 Nov, Save some 7 Dec, Save most 14 Dec), scored by
`dev/comfort-trial.mjs` (smoke-tested on 20–26 Nov: runs, model found).

- [x] Restarts resume (bbacf7c, d1e2c5c): a deploy no longer changes what heating does.
- [x] No make-up after hot water: the plan covers a run itself (bbacf7c).
- [ ] Hold every input but the range (confounders first):
  - [ ] Curve check must not move the offset during the trial: Heating Setup → curve, "tell me".
  - [ ] No deploy of heating code from Monday until the trial ends; fixes land by Sunday evening.
  - [ ] Thermostat 22.5 °C, Away off, no SPA, room control off, all three weeks.
- [ ] Afternoon model miss (0.7 K warm given the heat delivered, 27 Nov 10–19 h): find the cause by
  Sunday; ship only with a back-test that beats today's model, else leave it and note it.
- [ ] Weekend checks: hourly line shows the plan's indoor and hot water hours; a hot water run gets
  a pre-heat; indoor stays within 22.0–23.0; Plan vs actual's first day at the plan's COP.
- [ ] Hot water "This week: +40 %" on Plan vs actual: look before Monday (doesn't touch heating).

## After the heating test ends (Thursday 2026-11-19), in this order

- [x] Homey system update, held since 2026-11-17 so the test sees no firmware change. Done
  2026-11-20: Homey 13.5.5 at 10.136.1.16.
- [x] **Athom account rate-limited (2026-11-20).** The cause was the Mac test logger
  (`local.nibe-logger`, two `homey api raw` calls every 2 min), now unloaded (plist and
  `~/nibe-logs/live.csv`, 1009 rows, kept). The limit lifted: installed 2026-11-20 12:36 (71f5f13).
  All later checks read the Homey locally with a Homey API key, never through the CLI.
- Main's 1.5.1 (01a2513) stays off this branch: Autopilot work is separate from it. When the
  branch is merged to main, the conflict is in driver.ts `pendingSelection`: pass `stored` to
  `cleanSelection`, as `selection_done` on main does; keep both sides' integration tests.
- [x] Review the heating test and the Mac logger's gaps (439027d). Both fixes built: a daily heat
  check fits the heat loss to the meter (2a87865), and the holding trim is PI (16e3127, 6ab59ce).
  **2026-11-24: the heat check's swap is dropped (logged only).** Back-tests showed it flipping between fits and
  not predicting metered heat better (tasks/drift-analysis-2026-11-24.md). Plan vs actual is watched again: the
  target stays a miss under 5 %, and every heat-loss rule tested ran 4–6 % low on 8–23 Nov.
  Whether they close the miss is the next section.
  Plan vs actual ran 13–16 % low on Mon and Tue (2026-11-16/17) while indoor sat below target:
  split each day's miss into kWh (house model, COP) and price, per function, and fix the one that
  is off. Also why holding sits at 22.1 °C and doesn't climb back to 22.5 °C.
  - **Reviewed 2026-11-19 (read-only):**
    - **Price is not it.** Plan and actual use the same price list (`normalisePrices` with the
      owner's formula).
    - **COP is a small part.** From 07:00 to midnight on Mon–Wed the pump made 61.3 / 59.2 /
      83.4 kWh of heat for 16.9 / 16.0 / 23.4 kWh of electricity. That is a COP of 3.63 / 3.71 /
      3.57, against the 3.74 rolling COP the plan divides by (`noteCostPlan`): 1–5 % of the miss.
    - **The rest is heat.** The house took about 10 % more heat than the model planned, and still
      sat below target.
    - **Holding at 22.1 °C is the same cause.** While holding, fed − real outdoor averaged −0.2 K
      every day: the comfort bias is almost zero, so the pump's own curve decides. Indoor while
      holding went 22.8 → 22.1 → 22.2 → 21.9 °C as outdoor fell from about 5 to 1 °C: the curve
      is too flat for the cold. The model's steady state says the curve holds 22.5 °C, so it adds
      no bias. A heat loss that is too low gives both the low plan and the missing bias.
    - **Fix:** both, see above.
  - **Logger gaps** (35 % of the time covered): the Homey cloud API's rate limit, not the Mac
    sleeping. The logger makes 60 calls an hour, so each hour stops at about :50, and longer stretches
    go when other calls share the quota. The local shadow log is the record. A future logger reads
    once every 5 minutes, or reads local files only.
- [x] Merge the held branches: insights-backfill → cop-optimiser → orchestrator; gifted-euler any time.
  Done 2026-11-19 (c1a92bf, 1f80ebd, dff95aa, e640bed); 684 tests and validate pass.
- [x] Install the app batch: savings fixes, badge removal, savings-card redesign, Plan vs actual,
  the early-draw log (a826834). Installed 2026-11-20 12:36 (71f5f13) and again 2026-11-21 (3c49d8f).
- [ ] Compare figures with where else they show (897a839, 6700246, ee7e952, 68ecd46), mid-evening
  and just after midnight: Energy today's kWh and kr against Homey Energy's Top consumers, Heating
  + Hot water + Main (to about 0.1 kWh and a few öre; Main's idle part reads about 5 min after a
  start); the savings cards' today against Energy today; tank litres in
  the three hot water widgets against the Tank volume tile; the tank widget's usual day against
  Hot water use's expected.
- [ ] The shadow log now carries `tm`, the model's mass temperature, next to `ti` (in this batch).
  After a few ease-offs, check that tm lags ti as expected (dips less, recovers later).

## Autopilot heating: evaluate the trim, then Balanced (2026-11-20)

- [ ] 4–5 days on Comfort with b870c03 + 5b81952: indoor 24 h mean within ±0.5 °C of 22.5 without
  oscillating, Plan vs actual's miss under 5 %, no "Pre-heating" for a trim-only shift. Held: SPA
  off, room control (2978) off, curve offset unchanged, same indoor sensor. Read locally only.
- [ ] Then Balanced: how much more it shifts and saves against Comfort, and what indoor does.
  Not before the trim is judged, or the two changes can't be told apart.
- Since 37e1431 the feed held the level without price shifts until Getting started's fourth step;
  since 2026-11-23 only until the first day within the comfort range (`liveAt`, `holdShift`). On a reinstall the trim is judged during Settling
  and Calibrating, and "no Pre-heating for a trim-only shift" and Balanced only after Saving.

## Autopilot heating: Getting started (built 2026-11-22, running on the test Homey via `homey app run`)

Four steps: Learning, Settling, Calibrating, Saving (`lib/autopilot/settling.ts`, widget
`widgets/getting_started`, Heating Setup shows the steps).

- [x] Settling: each morning yesterday's indoor mean against the thermostat, a timeline message,
  two days within 0.2 °C settle it, stops after 21 days (9174e2e).
- [x] Calibrating, then Saving; price shifts held until Saving (`holdShift`); widget stepper with
  paused, offline and restart states; six languages (37e1431). Hold logged on change, debug
  route (ab2dc59).
- [x] Curve advice acts once settling is done; the settled line and a curve change in the same
  hour go out as one timeline message (`afterFit`, `lib/device.ts`) (0624c39).
- [x] Heating savings count from Saving (`liveAt` in the settle store) (0624c39).
- [x] Operating state reason names Autopilot when it switched on More hot water
  (`takeAutopilotNote`, `drivers/nibe_s/reason.ts`) (0624c39).
- [x] Price history from Energy-Charts, one request a month, twelve monthly spreads kept
  (e32f4e3); the year's savings estimate weights months by it (a6c4cb6).
- [x] Running on the test Homey (0624c39, 2026-11-22): log shows "holding the level, no price
  shifts", the savings reset ran (TEMP(savings reset), flag 2), widget endpoint read and rendered
  (Settling, day 1).
- [ ] Watch the morning timeline messages through Settling, Calibrating and Saving.
- [ ] Savings: heating's model-based old way (`shift-cost.ts`) is logged beside the baseline's
  saving (a6c4cb6); compare the two over some days and decide which the widget shows.

## Autopilot heating: "feels like" indoor temperature (idea, 2026-11-18)

Felt temperature is about (air + radiant) / 2. The house model's mass `tm` stands in for the inner
surfaces; outer surfaces sit about U·(ti − te)/7.7 below air (windows dominate, share unknown).
During an ease-off the air dips more than what is felt, so judging comfort on felt temperature
allows somewhat longer or deeper ease-offs.

- [ ] UX: one option in the heating settings, "Use feels-like as indoor temperature" (or
  similar), off by default. When on, the comfort range is judged on the felt estimate instead of
  air; status and widgets say "feels like" where they show it, since thermostats and Insights
  show air.
- [ ] Before building it: fix the plan miss first. Then a DIY globe sensor (black ball with a
  temperature sensor, mid-room at 0.6 m) next to the indoor sensor for a week, logged by the Mac
  logger, to check whether a mix of ti and tm tracks it. Without that, a wrong tm directly allows
  colder air.

## Before the release: drop temporary test code

Run `grep -rn "TEMP(" lib drivers app.ts api.ts widgets assets` before packaging; each hit is
listed here. TEMP(mem), the memory probe, is gone (`lib/mem-probe.ts` deleted, 0624c39).

- [ ] **TEMP(warning clear)**, added 2026-11-20 (3f33d79, `lib/device.ts`, heating `onInit`):
  clears the Proxy error left as Heating's warning by the 12:36 build, once (store flag
  `proxyWarningCleared`). Remove once it has run on the test Homey.
- [ ] **TEMP(savings reset)**, added 2026-11-20 (6549daa, `lib/device.ts`, `onInit`): clears
  heating's savings start, baseline and days once (store flag `autopilotSavingsReset`, now 2), so
  the test Homey reads them again under 0624c39's rule (counted from Getting started's Saving).
  Remove once the 0624c39 build has run on the test Homey.

- [ ] **TEMP(tank trace)**, added 2026-11-26 (`lib/autopilot/tank-trace.ts`, `lib/device.ts`
  `startTankTrace`/`readWaterMeter`, `test/tank-trace.test.ts`): a line a minute of BT6, BT7, 1575,
  priority, compressor Hz, 62, 697, the litres estimate and the house water meter, to
  `/userdata/tank-trace-<pump>.jsonl`, a month kept. The ground truth for
  [hotwater-estimate-ground-truth.md](hotwater-estimate-ground-truth.md). Remove once step 3 of
  that plan is decided; the file goes with the app.

- [ ] **TEMP(early-draw log)**, added 2026-11-17 (a826834, `lib/autopilot/hotwater-shadow.ts`):
  the hot water log's `early` and `withEarly` fields and `withEarly()`, which plan a second time
  with early draws credited (`creditEarly`, `drawnEarly`). Logged only, never acted on. Kept
  until two weeks of Autopilot-run days are compared: how often the credit would have waited,
  what it saves, and how close each wait came to the reserve (the 2026-11-16 19:15 charge was an
  early shower counted twice; a 7-day replay found a busy Saturday read as early draws, tank held
  at 35–56 L, so a 50 L floor is the candidate). Then either the credit goes live with its floor,
  or this and `creditEarly`/`drawnEarly` are removed. The skip lines and the `produced` field may
  stay.
  - Days to read with care in that comparison: **2026-11-17**, one of the household home sick,
    a midday shower; not a normal working day.

## Autopilot hot water: built, live on the maintainer's Homey (2026-11-08 on, [docs/autopilot-hot-water.md](../docs/autopilot-hot-water.md))

The maintainer asked for it now (2026-11-08): a generic learner of the household's hot water use
(weekday/free day), price and solar surplus, knobs "when" (697 = 2) and "how hot" (end the boost with 697 = 0); no EEPROM writes; day type set by the owner via Flow or by hand. Measured: free
days use 1.7x a working day; worth 50-70 kr/month in winter and roughly 100-150 kr/month in summer
from surplus.

- [x] Levers decided (2026-11-08): no EEPROM writes; day type only from Flows or by hand
- [ ] Release scope beyond the maintainer's Homey
- [x] Slice 1: learner (pure) + Insights bootstrap + tank fields in the history, with tests (1fffdf0)
- [x] Slice 2: planner (pure) + `dev/evaluate-hot-water.mjs` back-test, draws not known ahead (44ed1cd)
- [x] Slice 3: shadow on the maintainer's Homey; next planned charge on the device (22c1301)
- [x] Slice 4: live levers behind the on/off, guards, rescue, reconciliation, surplus, Flow cards, settings, six languages (5c0fd35)
- [x] Takes over the pump's own charging and legionella boost while Live, restores them on leaving;
  Legionella setup screen (a5ed4c6)
- [ ] From a5ed4c6, not verified on hardware: 697 = 6 read-back, whether 60 is clamped, and a 6 h
  boost reaching 65 °C.
- [ ] Slice 5: docs and FAQ are written; README has no Autopilot mention and `docs/releases.md` no
  row yet (both at release).
- [ ] At release: the store tagline (`.homeycompose/app.json` `description`, six languages) to name
  Autopilot, e.g. "Your heat pump on Autopilot" (owner's idea, 2026-11-23; "home" overclaims: it runs
  the heat pump). Together with README and store screenshots showing the ring mark beside the word.
- [ ] H0 (no writes, in shadow): 1028 at 5-min for a week. No record here of it being read.
- [x] H1 skipped (maintainer, 2026-11-08; docs/autopilot-hot-water.md §5).
- [ ] H3: Autopilot live 7 days with the Flow off, real kr against the Flow's week.
- [ ] Exit: back-test >= 10 % better than the Flow over 14 days, no floor violations; litres at peaks within +-50 L on >= 80 % of days
  - 23 Nov, 8 days (8–20 Nov), `dev/evaluate-hot-water.mjs`: 14.15 kr/day against the Flow's 23.84 (41 %
    better); 6 replay slots under the minimum, each caught by a top-up, against 3 for hindsight (the
    hourly draws land in each hour's first slot, so hindsight dips too); litres at the peak hour
    within ±50 L on 5 of 6 scorable days (83 %). Needs 14 days (about 28 Nov) and a reading of
    "no floor violations" that allows what hindsight itself does.

## Autopilot slice 5: live BT1 test build (5a built 2026-11-07; 5b superseded)

5b as designed here was not built. The live feed came as the shift-only test (`live.ts`,
f57b79e) and the setpoint trim (`setpoint.ts`, 09f1322, PI since 16e3127); the sections below
track those.

**Order (maintainer, 2026-11-07): nothing that writes 5217 is built until M2 is complete.** M2
cannot complete without the comfort loop, because shadow's "doing nothing" assumes the curve holds
comfort, which the room-off run disproved. So: 5a puts the trim and the planner baseline into
**shadow** (no pump writes) and M2 runs on with it; 5b, the live loop, is built only once M2's
exit criteria hold.

**M2 exit criteria.** Daily τ moves < 5 % three days running; the model passes its own accuracy
gate; the history has a day below −5 °C and a clear sunny day; ≥ 5 days of trim-in-shadow whose
comfort bias matches what actually held comfort in the room-off run (offsets 2/3/5/6 give that
ground truth); shadow 1 h / 6 h errors stay where they are (0.18 / 0.67 K).

**Goal.** The next hardware run steers the house through BT1 (5217) alone, holding comfort on the
Homey's own indoor and outdoor sensors and saving where prices allow. The heat curve and its
offset stay fixed for the whole run; nothing about the owner's curve is being tuned.

**What the room-off run showed that this build must answer.** The planner assumes "doing nothing
holds comfort" (`planner.ts` header). It doesn't: with room control off the curve let indoor
drift ~1.5 K with the weather at every offset tried. Autopilot replaces the room loop, so comfort
is its base job and price shifting sits on top. The trim (§7.3 step 1) was designed for this and
never built.

**Design.**
- **Comfort bias = feed-forward + integral.** From the learned curve (`curve.ts`, supply vs BT1)
  and the house model (heat loss, gains, sun), compute the BT1 the curve needs to hold comfort at
  today's real outdoor; the difference from real outdoor is the feed-forward bias. An integral
  term on `ti − comfort` (slow, τ-scheduled, anti-windup inside the preset's bias limits) corrects
  what the model gets wrong. A small P term on the same error, no D. Pure, in `trim.ts`.
- **Price shift on top.** `planShift()` plans around the comfort bias instead of around zero, so
  "doing nothing" in its baseline becomes "hold comfort". Feed = real − (comfort bias + shift),
  through `fedValue()` (ramp, max bias, Auto-mode clamps).
- **Real outdoor** from `outdoor.ts`: the Homey sensor first, then the corrected forecast; never
  input 1, which shows our own feed. Indoor from the Heating device's chosen sensors (1.5.0).
- **Fed flag from our own state.** While the controller feeds, `FLAG.fedOutdoor` is set because
  we wrote 5217, not inferred from |BT1 − sensor| > 3 K. That retires the lag false positive.
- **Live loop** (`controller.ts` + device wiring): replan every 15 min, write 5217 every 30 s on
  the write lane, verify against input 1 (4 × 750 ms). Guards from §7.2 that matter on this pump:
  pump offline, indoor stale > 30 min, outdoor missing (forecast 6 h then stop), add heat running
  → bias ≤ 0, feed verify fails ×3 → stop, SPA turned on → stop. Hot water running → hold the
  bias (it does nothing during DHW), don't wind up the integral.
- **Fail safe already measured (M0):** a 5217 write expires in ~5 min and the pump returns to the
  wired BT1, so a crash, reboot or uninstall degrades to the plain curve.
- **Switch:** an app setting (`autopilotLive.<device id>`, preset id or off), set from the CLI. No
  Repair/Verify UI, no capabilities, no Flow cards, no changelog: this is a dev build on the
  maintainer's Homey only, not a test-channel release.
- **Log** every slot to the shadow log: comfort bias (FF and I parts), shift, fed value, clamps,
  guard state, so the run can be read back with `review-shadow.mjs`.

**5a (M2, shadow only):** `trim.ts`, the planner baseline around the comfort bias, the
closed-loop bench, the own-state fed flag, and the shadow log fields; installed so shadow plans
with them. **5b (M3, after the exit criteria):** controller, guards, 5217 writes, switch.
**First step of M3, before 5b:** split `AutopilotCollector` into `lib/autopilot/inputs.ts` (home:
prices, weather, surplus, day type) and the per-pump 15-min history (plan §2.1 shared inputs),
then move hot water's own price fetch and tank history (branch `autopilot/hot-water`) onto them.
Not before the room-off run ends: the collector is the test instrument, a reinstall interrupts it.

5a done 2026-11-07, installed 21:11 (commits 00cccb5, 6ec3658, and the review-shadow one):
- [x] Curve learner keeps points through offset changes (1.49 K per step on the S1155).
- [x] `pumpHeat` from supply; checked: 6 h 0.33 K / 24 h 0.49 K RMS, as good as the meter.
- [x] `trim.ts` comfort bias (feed-forward); planner plans the shift on top; actuator limits the shift.
- [x] Shadow: setpoint is comfort; doing nothing on the lagged wired BT1; entries log `comfortBias`.
- [x] Fed flag against the wired-BT1 model (no false positives since 4 Nov; was 66 a day).
- [x] Bench on the learned curve: trim only holds 22.56 °C, 0.09 K RMS (doing nothing at +6:
      23.08 °C, 0.68 K); presets on top 1.1 / 1.8 / 7.2 %.
- Not built, on purpose: the integral (needs a loop, M3). Own-state fed flag (nothing feeds yet).

**Review (2026-11-07, after install).**
- Fixed: the wired lag didn't decay across history gaps; a stale duplicate doc comment; the bench
  printed cost as "electricity".
- The bench's "trim only holds 0.09 K" runs the model against itself: it shows the inversion is
  consistent, not that it holds a real house. The real check is `dev/check-supply-model.mjs`, and
  24 h windows cannot test the static balance on a house with τ ≈ 130 h.
- First live shadow entry (21:15): indoor 21.1 °C, outdoor 2.8 °C, setpoint 22.5, comfort bias
  **−2.2 K** (coast). The comfort bias is steady state only: by the model, the curve at +6 holds
  22.5 °C at 2.8 °C in the long run, and recovery from 1.4 K below is left to the planner.
- **Testable prediction:** at +6 and ~3 °C the model's steady state is ~23.3 °C. If indoor
  settles near 21–21.5 instead over the next days, the static balance (heat loss vs emission) is
  off by ~2 K and the comfort bias is wrong in sign here; that would block 5b and point at the
  heat-loss/emission fit, not the planner. Hot water took up to a third of the day's compressor
  time on 7 Nov, which the steady-state balance does not count.
- 5b will need: an integral on `ti − comfort`; the wired-BT1 offset learned from unfed slots only
  (a fed stretch would dominate the median); the previous-plan warm start converted once after an
  upgrade (old shadow memory holds pre-trim biases, a few slots of transient).

**Before it touches the pump.**
- [x] `trim.ts` + unit tests (`test/autopilot-trim.test.ts`).
- [x] Planner baseline around the comfort bias + tests (5a, 00cccb5).
- Superseded: the closed-loop bench (`dev/simulate-trim*.ts` took its place for the setpoint
  trim), the controller and guards (`live.ts`, `test/autopilot-live.test.ts` with a fake pump for
  5217/input 1), and the install with the switch off (done for the shift-only test, 2026-11-12).

**The run.** After the room-off run ends (~9 Nov evening). Room control off, SPA off, Manual mode,
offset held where it is. Day 1 trim only (Comfortable limits, no price shifting) to prove the
comfort loop; then Save some. Daily check as now, plus: indoor vs comfort (mean, RMS, min),
bias range, saving against the doing-nothing baseline, add-heat starts, feed verify failures.

Maintainer's go: "Do it" (shadow), sun impact differing per window direction, ±20 K test "Ok",
FAQ claim "a few percent" "Ok".

- [x] `solar.ts`: sun position + wall irradiance; east/west walls from DNI/DHI in the same
      Open-Meteo request; matched Open-Meteo's own walls within 1–2 W/m² RMSE over 14 days.
      History fields `gtiE`/`gtiW` appended; older files and journals load (journal read with the
      saved file's field count; every start saves first).
- [x] Model: one window area per wall, absolute (per-Ci drifted to 9 kW on day 1). Stage 2 seeded
      from the energy balance (RLS ranged 0.06×–26× on a slab warm-up). West-facing sim house
      learns its west sun.
- [x] Planner: comfort = setpoint (`comfortReference`), `comfortWeight` = 2 − price, no early exit
      on a thin spread, coast cap counts slots below comfort only; forecast sun discounted by
      trust. Real-weather bench (`--weather`/`--forecast`): steadier at Comfortable/Save some.
- [x] Shadow (`shadow.ts`, collector): all three presets every slot, log + state files,
      `dev/review-shadow.mjs`. Live on the Homey since 2026-11-01 08:45 (2.3 s a slot).
- [x] `probe-bt1.mjs --ladder` for §3.3, dry-run on the fake pump (0.55 per rung).
- [x] §3.3 pre-heat ladder on the S1155, 2026-11-02: gain 0.42/0.46/0.44/0.43 at −5…−20 K (0.44
      overall), all within 20 % of 0.50, so −20 K stands; 583 writes, 0 failures, DM ≥ −102, no
      immersion. Hot-water Flow re-enabled after the run.
- [x] §3.3 coast ladder on the S1155, 2026-11-03: gain 0.45/0.52/0.59/0.77 at +5…+20 K (0.54
      overall, rising as the fake warms); +20 K fails the 20 % band. Run resumed twice (`--resume`),
      `--no-abort` added. Hot-water Flow re-enabled after the run.
- [x] Planner: the BT1 gain is the learned heat curve's slope where the feed lands (`lib/autopilot/curve.ts`,
      plan §4.5), not 0.50. History records `bt1` and 26/30/34/38; a settings change starts a new
      curve. Bench: plan error to zero, savings within ±0.3 pp.
- [x] The curve learns only from slots with room-sensor control off (`roomctl` = 202 recorded). The
      fitted `factor × (setpoint − indoor)` term was dropped: on the S1155 the room loop integrates
      (1017 34 → 49 °C at steady BT1 on 2026-11-03), which no proportional term describes.
- [x] Coast side capped at 15 K (`MAX_COAST_BIAS_K`, the ladder's pass rule); pre-heat keeps 20 K.
      Presets now 6/4.5, 12/9, 20/15 K.
- [x] With room-sensor control off, shadow comfort is indoor's mean over the last day of loop-off
      slots (`curveComfort`), not the setpoint: the setpoint only steers the room loop, and planning
      to it bought back a "deficit" the curve never meant to deliver. The log keeps `setpoint` too.
- [x] The 2026-11-03 10:09 outage was this Mac's route to the pump (`EHOSTUNREACH`), not the pump:
      the Homey's slots 10:00 and 10:15 have coverage 0.99/1.0 and no reconnect flag. No app change.
- [x] Room-sensor control off from 2026-11-04 ~20:30, curve offset +2: collect ~5 clean days, then
      the curve fit and preset evaluation (both in the daily log below). 2026-11-05 15:15: curve fitted, 71 slots over BT1
      5.3–8.3 °C, gain 0.46 per K (ladder: 0.44); indoor settled at ~21.3 °C since 08:00.
- [x] The real room-sensor flag on zone firmware is holding 2978 (`id:12671`, u8 0..3; 2978–2985
      look like one per climate system). Sweep 2026-11-05: switched on 15:02 → 2978 0→1 next
      pass; off 15:07 → back to 0. 202 never moved. Register 30 follows too, ~6 min late
      (refused 15:08–15:13), so `roomControlOff` reads the stored slots right; the 15:02–15:08
      on-spell counts as off there (about 2 slots).
- [ ] Record 2978 as `roomctl` instead of 202. History still maps `roomctl` to
      `boolean_NIBE.h202_use_room_sensor` (`drivers/nibe_s/profile.ts`); the live feed and pairing
      read 2978 directly (`readRoomControl`, `lib/pairing-pump.ts`).
- Superseded: shadow behind a hidden setting (Smart mode's Test run replaced it, 3063bc6).
- Superseded: modelling the room loop. Autopilot requires room-sensor control off and stops if
  it is on (`live.ts`, `room_control`).

## Autopilot slice 3: planner (offline)

- [x] `presets.ts`, `actuator.ts` (clamps on 184/183/185 in Auto, ramp, pass-through),
      `planner.ts` (cost at equal comfort, linear-response greedy). Tests in
      `test/autopilot-control.test.ts`.
- [x] `dev/evaluate-presets.mjs`: 20 SE3 days, measured lever → 0.9 / 2.3 / 5.2 % at no-worse
      comfort (plan §7.3 has the table and the three rejected objectives).
- [x] Why *Save the most* didn't use its depth: replans started from zero bias (fixed: warm
      start), and the lever is ~0.45·H, not H (measured; `PumpCurve.lever`).
- [x] Rerun on the maintainer's learned house once the model is ready (`--model`): daily from
      2026-11-04 (slice 2's model log).
- [x] Learn the lever live per pump (`estimateLever` over the history) and keep it in the model
      file (`lib/autopilot/house.ts`, `lever`).

## Autopilot slice 2: house model (branch `smart-heating/m1-data`)

Started offline; the model has run on the Homey since 2026-10-31 (8e13f97). Design:
`docs/autopilot-plan.md` §4.2, §6.

- [x] `lib/autopilot/outdoor.ts`: real outdoor source (wired while not feeding, Homey sensor, forecast
      + per-hour bias), 6 h degraded limit.
- [x] `lib/autopilot/model.ts`: stage 1 RLS (heat-loss seed), stage 2 2R2C EKF with priors from the two
      Setup answers, gating, 6 h prediction RMSE, `toModelSlots`.
- [x] `test/autopilot-house-sim.ts` + `test/autopilot-model.test.ts`: radiator and slab houses recovered
      within 10 % heat loss / 15 % τ; a wrong answer still predicts inside 0.35 K.
- [x] `dev/fit-house-model.mjs` runs on the real file (day 1: 77/92 usable, 6 h RMSE 0.21 K;
      too short to read the parameters).
- [x] Fit again after ≥ 5 valid days (2026-11-04 on, daily log below).
- [x] Run the model online: the collector refits over the whole history every hour
      (`lib/autopilot/house.ts`; heat for a slot lands slots later, so a refit beats stepping) and
      writes `autopilot-<id>.model.json` beside the history. Answers default to "Don't know".
- [x] `lib/autopilot/insights.ts`: heat loss, cool-down from the heated steady state, stored heat,
      sun, fast/slow; readiness (§6.4) and drift (§6.2) over one fit per day.
- [x] A reinstall at 20:23 on 2026-10-31 lost the slots since the 19:46 save, and a second one
      confirmed `homey app install` ends the process before `onUninit` saves. Each closed slot is
      now appended to `autopilot-<id>.bin.journal` (92 bytes, 100 since the wall fields) and replayed on load; the hourly save
      empties it.

**Daily model log** (`dev/fit-house-model.mjs … --system radiators`, history + journal):
- 2026-10-31 21:43 — 96 slots (30 Oct 20:45 → 21:15), 1 valid day, 78 usable; gap 19:45–20:15
  (lost to the reinstall before the journal), 21:00 partial (restart). Heat loss 310 W/K, τ 57 h,
  stored 17.6 kWh/K, lever 128 W/K, 6 h error 0.17 K. Learning (days, stability). No live
  `model.json` yet (first hourly fit ~22:03).
- 2026-11-01 21:45 — 192 slots, 158 usable, 2 valid days, no gaps today. Heat loss 296 W/K (live
  300), τ 72–75 h, sun E/S/W 0.5/1.1/0.6 kW at 500 W/m² (mostly south; E/W moved off the prior),
  lever 127 W/K (0.42·H), 6 h error 0.21 K. Learning (days, stability): too early for
  evaluate-presets. Shadow: 52 slots, 124 ms a slot; doing nothing predicted 1 h 0.18 K RMS (bias
  +0.14), 6 h 0.66 K RMS (bias **+0.62**, model too warm). Presets: Comfortable −6…0 K (coasting
  77 %), Save some −12…+2 (52 %), Save the most −20…0 (85 %); no clamps, ramps ≤ 2 K/slot, no
  pre-heat near add-heat (pre-heat max +2 K at 9 °C real). Planned saving 6.5/6.8/9.1 %.
  **The 6 h bias is the pump's own control, not the house model:** SPA is on (843 = 1) and cut
  calculated supply from 36 to 26 °C over the 17–20 price peak (3.4–3.5 kr), the compressor
  stopped 19–20 h with DM positive, and indoor fell 22.5 → 21.4 °C while outdoor rose. The
  doing-nothing baseline (curve alone) knows neither SPA nor the room loop, so live error is only
  a fair test of the feed-forward on slots with both off and nothing fed (the ladder's own slots
  are fed, so they aren't; the evening after it, with SPA and the room loop still off, would be). Settings
  read back unchanged (curve 5, 184 = 15, 185 = 5, 237 = Manual).
- 2026-11-02 21:20 — 285 slots (30 Oct 20:45 → 2 Nov 21:15), 229 usable, 3 valid days; gaps
  31 Oct 19:30–20:30 and 2 Nov 10:45–11:45 (installs). Heat loss 280 W/K (first-order 215), τ 91 h,
  stored 25.6 kWh/K, sun E/S/W 0.3/0.5/0.4 kW, lever 125 W/K (0.45·H), 6 h error 0.23 K. Learning
  (days, stability). Outdoor today: 35 slots from the Homey sensor, 1 forecast, 17 flagged fed (the
  ladder; earlier ladder slots predate the flag). Shadow 145 slots: doing nothing 1 h 0.18 K
  (bias +0.06), 6 h 0.63 K (bias **+0.30**, down from +0.62). SPA and the room loop off since
  ~07:00 for the ladder, so this evening is the first clean baseline, but the day's own slots were
  fed. Presets today pre-heat a lot (Comfortable 71 %, mean +3.3 K; Save the most up to +20 K)
  because indoor sat ~21.5 against the 22.5 setpoint with the room loop off: comfort-chasing, not
  price-shifting. Within what the ladder showed safe (−20 K: DM −102, no immersion), but the
  planner should not read a room-loop-off house as a comfort deficit. Planned saving 6.2/6.0/5.4 %.
  Indoor in history switches from 116 to 26 (the Heating device's own source) from 21:05 (fix
  e63bdbd; the tile had been frozen since 30 Oct).
- 2026-11-03 21:45 — 381 slots (30 Oct 19:45 → 3 Nov 21:15), 324 usable, 4 valid days; no new
  gaps (31 Oct 19:45–20:30 and 2 Nov 11:00–11:45 remain), 2 partial today (installs). Heat loss
  234 W/K (first-order 175), τ 111 h, stored 25.8 kWh/K, sun E/S/W 0.2/0.2/0.5 kW, lever 128 W/K,
  6 h error 0.28 K. Learning (days, stability): heat loss has slid 292 → 299 → 277 → 234 W/K and
  τ 64 → 111 h over the four daily fits, so not stable yet. Outdoor today: 85 of 86 slots from the
  Homey sensor, 0 forecast, 56 fed (the coast ladder). Heat curve learning: 0 points, since room
  control has been on since ~12:30 and `roomctl` (2b37d2c) records 1 from the 21:15 slot. Shadow
  240 slots: doing nothing 1 h 0.22 K (bias +0.03), 6 h 0.89 K (bias +0.23; 0.63 K yesterday),
  worse because today was fed all morning and then the room loop drove 1017 to ~49 °C, which the
  curve-only baseline does not know. SPA on (influence 10) and the room loop on since midday.
  Presets today pre-heat almost throughout (Comfortable 95 %, mean +5.5 K; Save some 76 %) because
  indoor bottomed at 19.7 °C after the coast: comfort recovery, the same room-loop-off artefact as
  yesterday. Save the most still spans −20…+20 K, and the ladder showed +20 K (coast) outside the
  20 % band, so the planner's coast range should stop at +15 K before any feed is live. Planned
  saving 6.6/6.9/5.4 %.
- 2026-11-04 21:45 — 477 slots (30 Oct 20:45 → 4 Nov 21:15), 409 usable, **5 valid days**; no
  new gaps, 0 partial today. Heat loss 244 W/K (first-order 165), τ 111 h, stored 27.2 kWh/K, sun
  E/S/W 0.2/0.1/0.1 kW, lever 128 W/K, 6 h error 0.35 K. Learning (stability only): daily heat
  loss 292 → 299 → 277 → 234 → 244 W/K, τ 64 → 72 → 95 → 110 → 111 h, so τ is settling. Outdoor
  today: 86/86 slots from the sensor, 0 forecast; 21 flagged fed, but nothing fed: overnight BT1
  ran 3–4.3 K warmer than the Homey sensor, past `FED_OUTDOOR_K` 3. Room-sensor control turned off
  ~20:30 with curve offset +2 (30 readable from that slot, 1017 37.2 → 31.7 °C), yet `roomctl`
  (202) still reads 1: 202 is legacy on zone firmware and has not changed since August, so the
  curve learner and `curveComfort` see the loop as on. SPA off since 2 Nov 05:57 (843 = 0).
  Shadow 336 slots: doing nothing 1 h 0.21 K (bias +0.02), 6 h 0.79 K (bias +0.08, down from
  +0.23). Today the room loop held indoor 22.1–22.9 against 22.5, so presets mostly coasted
  (Comfortable 67 %, Save some 70 %, Save the most 64 %, mean −6.6 K); Save the most still spans
  −20 K on the installed build (ab8835a caps it at 15 K, not installed). Manual mode, so no
  auto-stop risk from warm feeds. Planned saving 5.9/7.8/11.8 %.
  Preset evaluation (step 4, 5 valid days; not "ready"), 31 SE3 days 5 Oct → 4 Nov, this model,
  Manual, comfort 22.5, lever 0.525·H, Open-Meteo history, 15 K coast cap: fair saving
  Comfortable 1.1 %, Save some 1.8 %, Save the most 7.2 % (best days 8/17/17 %); indoor
  22.3–22.8 / 22.1–23.1 / 21.3–24.0 °C, off comfort 0.05/0.08/0.39 K RMS (doing nothing 0.04).
  Planning on the day-ahead forecast instead changes nothing (1.1/1.8/7.2 %).
- 2026-11-06 08:45 — 618 slots (30 Oct 20:45 → 6 Nov 08:30), 538 usable, 6 valid days; no new
  gaps (the 5 Nov check did not run). Heat loss 236 W/K (first-order 189), τ 125 h, stored
  29.5 kWh/K, sun E/S/W 0.1/0.1/0.1 kW, lever 119 W/K (0.50·H), 6 h error 0.31 K. The app's
  `model.json` (07:37) says **ready**; `fit-house-model.mjs` still says learning (stability). Daily
  heat loss 292 → 299 → 277 → 234 → 247 → 239 → 236 W/K, τ 64 → 72 → 95 → 110 → 111 → 122 → 125 h:
  heat loss has settled, τ is still creeping up. Heat curve 141 points, gain 0.47 per 4 K.
  Outdoor last 24 h: 96/97 slots from the sensor, 0 forecast; 60 flagged fed with nothing fed: this
  morning BT1 read +1.5 °C against the sensor's −3.9 °C, so the 3 K `FED_OUTDOOR_K` false positive
  now fires most of a cold night. Room control off since 4 Nov 20:30 (offset 30 = +2 readable;
  202 still 1, legacy). Indoor 20.6–21.1 °C at −4 °C this morning, so +2 no longer holds 22.5.
  Shadow 477 slots: doing nothing 1 h 0.19 K (bias +0.03), 6 h 0.70 K (bias +0.18). Bias range
  Comfortable −6…6 K (coasting 30 %), Save some −12…12 K (36 %), Save the most −20…20 K (56 %);
  ramp clamps ≤2 %; planned saving 6.2/7.1/8.1 %. Manual mode, so warm feeds cannot trip
  auto-stop; nothing unsafe. SPA off since 2 Nov.
  Preset evaluation (ready), 31 SE3 days 6 Oct → 5 Nov, this model, Manual, comfort 22.5, lever
  0.505·H, Open-Meteo history: fair saving Comfortable 0.9 %, Save some 1.5 %, Save the most 7.1 %
  (best days 6/13/16 %); gross 3.1/4.6/20.6 %; indoor 22.4–22.7 / 22.2–22.8 / 21.5–23.8 °C, off
  comfort 0.04/0.06/0.33 K RMS (doing nothing 0.03). On the day-ahead forecast: 0.9/1.4/7.1 %.
- 2026-11-06 15:09 — curve offset (30) raised +2 → +3 at the owner's request, read back 3. Indoor had
  slid 22.3 → 20.6 °C over the first 36 h of the room-off run as it turned colder (−4 °C). The run
  continues; `hoffset` is logged per slot, so the curve learner sees the step.
- 2026-11-06 21:45 — 669 slots (30 Oct 20:45 → 6 Nov 21:15), 585 usable, 7 valid days; no new
  gaps (31 Oct 19:30–20:30 and 2 Nov 10:45–11:45 remain), 0 partial or reconnect in 24 h. Heat
  loss 228 W/K (first-order 159), τ 130 h, stored 29.7 kWh/K, sun E/S/W 0.1/0.2/0.1 kW, lever
  127 W/K (0.56·H), 6 h error 0.31 K. The app's `model.json` (20:37) is back to **learning
  (stability)** after saying ready this morning: daily τ 64 → 72 → 95 → 110 → 111 → 122 → 130 h
  keeps creeping, heat loss 236 → 228 W/K. Heat curve learning, 254 W per K of supply.
  Outdoor last 24 h: 96/96 slots from the sensor, 0 forecast, 66 flagged fed with nothing fed
  (BT1 +1.4 °C against the sensor's −4.2 °C at 21:00: the lag false positive again). Since +3 at
  15:09 indoor held 20.8–20.9 °C while outdoor fell +4.4 → −4.2 °C; the pump still steers on a BT1
  ~5.5 K warmer, so the step has not shown fully yet. SPA off; room loop off.
  Shadow 528 slots: doing nothing 1 h 0.18 K (bias +0.03), 6 h 0.67 K (bias +0.17). Bias range
  Comfortable −6…6 K (coasting 36 %), Save some −12…12 K (42 %), Save the most −20…20 K (60 %);
  ramp clamps 0 %; planned saving 6.0/6.9/8.2 %. Today all three mostly coasted (71–72 %) because
  indoor sat well below 22.5 with nothing to recover cheaply. Manual mode; nothing unsafe.
  Preset evaluation, 30 SE3 days 7 Oct → 5 Nov, this model, Manual, comfort 22.5, lever 0.557·H,
  Open-Meteo history: fair saving Comfortable 0.9 %, Save some 1.2 %, Save the most 7.6 % (best
  days 3/7/17 %); gross 3.2/4.7/22.7 %; indoor 22.4–22.7 / 22.2–22.9 / 21.5–23.7 °C, off comfort
  0.04/0.06/0.33 K RMS (doing nothing 0.04). On the day-ahead forecast: 0.9/1.2/7.6 %.
- 2026-11-07 08:56 — curve offset (30) raised +3 → +5 at the owner's request, read back 5. On +3
  indoor slid 20.9 → 20.4 °C overnight (outdoor −5.2 → +0.9 °C) with supply tracking the curve
  (~35.5 °C, 21 Hz, DM ~−100, no immersion): the setting, not the pump, was short. Step back to +4
  if indoor heads past ~23 °C. The room-off run continues.
- 2026-11-07 20:36 — curve offset (30) raised +5 → +6 at the owner's request, read back 6. On +5
  indoor rose 20.4 → 21.1 °C by 13:30, then sat at ~21.0 °C as outdoor fell +3.7 → −0.7 °C (two
  hot water runs, 10–12 and 14–15:30, each stalled it). Every offset so far loses ground when it
  turns colder: curve 5 looks too flat for this house, which is what the run should show.
- 2026-11-07 22:15 — 765 slots (30 Oct 20:45 → 7 Nov 21:15), 659 usable, 8 valid days; no new
  gaps, 2 partial (installs). Heat loss 218 W/K, τ 134 h (daily 122 → 132 → 134: settling, +1.5 %),
  stored 29.3 kWh/K, sun E/S/W 0.1/0.9/0.1 kW (south jumped from 0.2), lever 119 W/K (0.55·H),
  6 h error 0.35 K. The app's `model.json` says **ready** (accuracy 0.346 just under 0.35);
  `fit-house-model.mjs` still says learning (stability). Curve learner on all three offsets: 285
  slots, 0…10 °C, gain 0.46–0.47 per K, 1.49 K per offset step, 256 W per K of supply.
  Supply model (`check-supply-model.mjs`, room-off run): 6 h 0.33 K / 24 h 0.49 K RMS, as good as
  the meter (0.30 / 0.48); both ~0.4 K cold at 24 h.
  Outdoor last 24 h: 93 sensor, 1 forecast, 20 fed — all under the old flag logic before 21:11
  (the lag false positive). **Bug of mine, fixed:** the rename (a2a08b5) moved `smartOutdoorSensor`
  to `autopilotOutdoorSensor` without carrying the value, so from the 21:11 install the 21:00 and
  21:15 slots took outdoor from BT1 (2.8 °C against a real ~−1 °C). Carried over at start in
  8f4acce, installed 21:44 (standing permission
  to install, over this check's no-install rule, because every slot until then was wrong data);
  22:00 slot back on the sensor (−1.5 °C, flag 16) and not flagged fed with BT1 4.1 K warmer.
  Shadow 624 slots: doing nothing 1 h 0.17 K (bias +0.03), 6 h 0.62 K (bias +0.14). First entries
  with the comfort bias (21:15 on): −2.2 K on the wrong 2.8 °C, **−1.7 K** on the real −1.5 °C,
  with indoor 21.3 against 22.5: the model's steady state still says +6 holds more than 22.5.
  Today's presets −4…6 / −9…12 / −15…20 K, planned saving 5.6/7.0/9.8 %, no clamps; Manual
  mode, nothing unsafe. Room loop off, SPA off. Offset +6 from 20:36.
  Preset evaluation, 31 SE3 days 8 Oct → 7 Nov, Manual, comfort 22.5, on the learned curve
  (trim as baseline): Comfortable 1.1 %, Save some 1.8 %, Save the most 7.2 % (day-ahead
  1.2/1.8/7.3; old lever 0.546·H 1.1/1.8/7.3). Doing nothing at +6 in October weather: 23.06 °C
  mean; trim only 22.56 °C at 28 % lower cost (model against itself, see the 5a review).
- 2026-11-08 21:40 — 861 slots (30 Oct 20:45 → 8 Nov 21:15), 739 usable, 9 valid days; no new
  gaps, 1 partial today. Heat loss 222 W/K (first-order 180; daily 218 → 215 → 222), τ 136 h
  (135.6 two days running: settled), stored 30.2 kWh/K, gains 0.59 kW, sun E/S/W 0.1/0.4/0.1 kW,
  lever 117 W/K (0.53·H), 6 h error 0.34 K. `model.json` ready; `fit-house-model.mjs` still
  learning (stability). Curve learner 377 slots, 1.52 K per offset step, 256 W per K of supply.
  Outdoor last 24 h: 95 sensor, 0 forecast, 0 fed. Room loop off (202 still reads 1, legacy),
  SPA off, offset +6 all day.
  **The room-off verdict:** a full day at +6 held indoor flat at 21.2–21.4 °C (te −1.5…+2.7 °C),
  dipping 0.3 K for each of two hot water runs (10–12, 16:30–18:30, the second after a bath). The
  heat meter's ~4.5–5 kW matches the emission model; the house model needs ~4.1 kW to hold 21.3,
  so its long-run balance is ~0.6 kW too warm (heat loss ~250 W/K, or gains/night gains lower).
  With τ settled, slow-mass charging no longer explains it. Shadow 719 slots: doing nothing 1 h
  0.17 K (bias +0.03), 6 h 0.59 K (bias +0.15, still warm). Comfort bias today −6.3…−0.7 K
  (mean −3.3) while indoor sits 1.2 K under 22.5: wrong sign, so **5b stays blocked** until the
  heat-loss/gains fit is fixed. Presets today −5…5 / −2…11 / −20…19 K; Save some pre-heated every
  slot (shift +11.5 against the coast bias), Save the most hit ramp 21 % and max-bias 2 %;
  Manual, nothing fed, nothing unsafe at the ladder's tested range. Planned saving 5.4/6.9/4.7 %.
  Preset evaluation (22:30 check), 29 SE3 days 9 Oct → 6 Nov, this model, Manual, comfort 22.5,
  lever 0.527·H, Open-Meteo history, planned on the day-ahead forecast: fair saving Comfortable
  1.0 %, Save some 1.3 %, Save the most 7.3 % (best days 3.2/6.4/16.9 %); gross 3.2/4.6/20.4 %;
  off comfort 0.04/0.06/0.30 K RMS. Perfect forecast 1.0/1.4/7.2 %: forecast error costs nothing
  measurable. Unchanged from 7 Nov, so the too-warm balance does not move the October verdict.
  Preset evaluation, 31 SE3 days 9 Oct → 8 Nov, Manual, comfort 22.5, lever 0.53: Comfortable
  1.0 %, Save some 1.4 %, Save the most 7.0 % (day-ahead 1.0/1.3/7.1); built on the same
  too-warm balance, so read as an upper bound.
- **2026-11-09 — why the balance reads too warm (offline, read-only).** Free-run refits of the
  2R2C over the 906-slot record (scratchpad `batchfit.mts`/`variants.mts`, Nelder–Mead on free-run
  RMSE, mass start free):
  1. *The outdoor input changed meaning mid-record.* Until 2026-11-02 pm `te` is the pump's BT1;
     from then the picked outdoor sensor, a Hue motion sensor ("Rörelse"). Against met.no 2 m
     temperature (Open-Meteo, 3–9 Nov, 391 unfed slots) BT1 reads +0.7 K (+1.2 at night, −0.4
     midday, a wall sensor); the Hue reads −0.9 K, −1.5…−2.4 K in the evening and night and +1.1 K
     at 11:00 (sun on it). So the model learns from an outdoor ~2.4 K colder than before 2 Nov,
     with a ~3.5 K false daily swing that the sun and gains terms soak up. Unifying the series on
     either sensor moves the EKF to H 238/gains 0.94 (Hue) or H 270/gains 0.82 (BT1): not a fix
     by itself. (Correction: the BT1 variant used the `bt1` column in 169 fed slots, which is the
     *fed* value, history.ts:217; that variant is contaminated, the Hue one is not.)
  2. *Heat loss and free heat cannot be told apart yet.* With the app's dynamics held, gains
     0 → 0.8 kW fits with H 191 → 236 W/K at free-run RMSE 0.404 → 0.437 K. ΔT has only spanned
     15–22 K; separating them needs a cold spell. The free-run fits also put sun at ~0 while the
     EKF learns 0.4–1.0 kW south at 500 W/m²: sun is not identified either.
  3. *Every model over-predicts the +6 period.* Fitted on data before 7 Nov 20:36 and run free
     through the held-out +6 period, every variant (EKF, batch, either outdoor) ends 0.44–0.76 K
     too warm after 37 h. The EKF's steady indoor for the last 24 h is 22.8–23.2 °C against
     21.26 measured. The batch fits want a mass of 100–200 kWh/K (τ 550–800 h) and halve the
     free-run error (0.40 → 0.20–0.23 K), but 9 days cannot pin a weeks-long mode either.
  Verdict: the extra heat from +6 is not showing up at the indoor sensor(s) as the previous
  week says it should, whichever parameters. Not explained by the outdoor switch alone.
  Candidates left, not testable from the history: thermostatic radiator valves throttling the
  sensed rooms (heat goes to unsensed rooms), indoor sensor placement or selection, or a real
  slow mass. Next: ask the owner about TRVs and which indoor sensors are picked; move the
  outdoor off the Hue sensor (BT1 or a shaded sensor) and record which source each slot used
  (flag 16 already does); refit after a colder week. 5b stays blocked.
  *Follow-up, same day: radiator valves and room sensors ruled out.* The owner has smart radiator
  valves, which also report temperature, everywhere; bedrooms are set cooler, every other valve
  is fully open. 16 of their Insights logs (hourly, 14 days) show every room moving together: after
  +6, against 5–7 Nov, common rooms rose 0.26–0.55 K, the pump's own room sensor (the model's
  `ti`, = MyUplink "room") 0.26 K. The sensors' house mean is 21.1 °C against the pump's 21.26.
  Refitting on that mean instead of the pump sensor changes nothing: the held-out +6 drift stays
  +0.57–0.89 K. Heat-meter sanity: heat/electricity per day 3.5–4.05, falling with supply
  temperature as it should, so 1577 is not obviously inflated.
  *What does agree:* the two near-steady days. On the BT1 basis, 31 Oct (3.86 kW, ΔT 16.7, indoor
  +0.04 K over the day) and 8 Nov (4.15 kW, ΔT 17.5, +0.15 K) give 231 and 237 W/K with no free
  heat: the same house. On the Hue basis 8 Nov reads 206 W/K: the outdoor source switch alone
  makes the same house look different. The days between (ladders, room control on until 4 Nov
  with its 1.5 K overshoot, a 2 K cool-down over 4–7 Nov, offsets 2/3/5/6) are transients that
  the gains term (0.6 kW) and the window areas absorb.
  Conclusions: (a) the pump sensor is representative; (b) replace the Hue outdoor sensor with a
  shaded one. BT1 is *not* an option: once Autopilot feeds 5217, input 1 shows the fed value and
  no copy of the wired BT1 is readable (plan §4.3), so the outdoor truth must be a Homey sensor,
  with the forecast as fallback; (c) the fit should not mix outdoor sources: re-anchor or ignore slots on
  a source change (the flag is there, nothing reads it); (d) internal gains need a tight prior
  until a cold spell can separate them from heat loss; (e) refit on a steady week. 5b stays
  blocked.
- **2026-11-09 — (c) and (d) built, offline, nothing installed.**
  - (d) The gains are now learned absolute (not per Ci) with a prior of 0.4 kW, ±0.35 in log
    space, not widened by unknown answers. On the live history: H 230 → 221 W/K, gains 0.62 →
    0.37 kW, 6 h RMSE 0.303 → 0.301, open-loop drift over +6 0.92 → 0.73 K. With met.no as
    outdoor the old prior ran off to H 405 / gains 3.5 kW; the new one gives 246 / 0.76 at the
    same RMSE.
  - (c) Each slot now records its outdoor source in `tesrc`, down to which sensor. Older slots
    read it from the flags. A change counts once the new source holds 4 h, so short fallbacks
    don't count. **A hard cut hurt:** fitting only the 7 days since the Hue gave RMSE 0.44–0.52
    and nonsense parameters. That held even with met.no as outdoor, so the window is too short
    or too confounded (+6, room control off), not the Hue. The cut therefore waits until the new
    source has 14 days (`SOURCE_RUN_DAYS`); until then the fit runs over everything, as before.
    14 is a guess and is not measured.
  - **Swap the outdoor sensor only after this build is installed.** Before then, slots carry no
    sensor identity, and Hue → new sensor will not read as a change.
  - Steady-state over-prediction (~2 K on the last 24 h) remains in every variant, including
    met.no. It reads as the +6 transient (heat going into slow mass), not the outdoor source.
- 2026-11-09 21:50 — 957 slots (30 Oct 20:45 → 9 Nov 21:15), 835 usable, 10 valid days; no new
  gaps, 0 partial today. Heat loss 221 W/K (first-order 164), τ 120 h, stored 26.4 kWh/K, gains
  0.37 kW, sun E/S/W 0.2/0.2/0.3 kW, lever 117 W/K (0.53·H), 6 h error 0.30 K: the local fit
  already runs on the new gains prior from (d). The app's `model.json` (old build) still says
  **ready**, heat loss 230, τ 136 h (daily 136.8 → 135.9), gains 0.61 kW;
  `fit-house-model.mjs` still learning (stability). Curve learner 473 slots, 1.53 K per offset
  step, 256 W per K of supply. Outdoor last 24 h: 96 sensor (Hue), 0 forecast, 0 fed; `tesrc`
  empty because the (c) build is not installed. Room loop off (202 reads 1, legacy), SPA off
  (843/846 = 0), offset +6 all day. Indoor 21.3–21.7 °C at te 0.4–5.0 °C.
  Shadow 815 slots: doing nothing 1 h 0.16 K (bias +0.03), 6 h 0.56 K (bias +0.14, still warm).
  Comfort bias today −7.7…−2.9 K (mean −4.6) with indoor ~1 K under 22.5: wrong sign and larger
  than yesterday, so **5b stays blocked**. Presets today −5…3 / −13…9 / −23…17 K, coasting
  3/16/55 %, planned saving 6.5/8.1/7.4 %; Save the most clamped ramp 15 %, max-bias 6 %, and its
  −23 K is past the −20 K pre-heat the ladder tested (the max-bias clamp let it through). Manual
  and nothing fed, so nothing unsafe happened, but the planner's range must stop at −20 K
  pre-heat and +15 K coast before any feed goes live.
  Preset evaluation, 30 SE3 days 10 Oct → 8 Nov (11-09 is look-ahead), app model, Manual, comfort
  22.5, lever 0.53·H, Open-Meteo history: day-ahead Comfortable 0.9 %, Save some 1.2 %, Save the
  most 7.2 % (best days 3.1/6.3/16.9 %; gross 3.1/4.4/19.5 %; off comfort 0.04/0.06/0.30 K RMS);
  perfect forecast 1.0/1.3/7.0 %. Same as the last three days; still on the too-warm balance,
  so an upper bound.
- 2026-11-09 21:45 — 957 slots (30 Oct 20:45 → 9 Nov 21:15), 835 usable, 10 valid days; no new
  gaps, no partials today. Live `model.json` (installed build, old gains prior): heat loss 230
  W/K, τ 136 h (135.6/136.8/135.9 over three days: settled), gains 0.61 kW, 6 h error 0.32 K,
  ready. Worktree fit (ba76580, new gains prior): heat loss 221 W/K (first-order 164), τ 120 h,
  stored 26.4 kWh/K, gains 0.37 kW, sun E/S/W 0.2/0.2/0.3 kW, lever 117 W/K (0.51·H), 6 h error
  0.30 K, learning (stability: no daily log offline). Curve learner 473 slots, 1.53 K per offset
  step, 256 W per K of supply. Outdoor last 24 h: 96 sensor, 0 forecast, 0 fed. Room loop off
  (202 reads 1, legacy), SPA off, offset +6 all day, **no hot water run in 24 h**.
  Balance: 106 kWh of heat held indoor at 21.44 °C over te 3.07 °C, 4.4 kW for 18.4 K, i.e. 240
  W/K with no gains. The new fit needs 221 × 18.4 − 370 = 3.7 kW: still ~0.7 kW too warm, the
  same gap as yesterday, now without hot water to blame.
  Shadow 815 slots: doing nothing 1 h 0.16 K (bias +0.03), 6 h 0.56 K (bias +0.14, still warm).
  Comfort bias today −7.7…−2.9 K (mean −4.6) with indoor 1 K under 22.5: wrong sign, more so
  than yesterday, so **5b stays blocked**. Presets today −5…3 / −13…9 / −23…17 K; Save the most
  clamped ramp 15 % and max-bias 6 %; Manual, nothing fed, nothing unsafe. Planned saving
  6.5/8.1/7.4 %.
  Preset evaluation, 31 SE3 days 9 Oct → 8 Nov, live model, Manual, comfort 22.5, lever 0.51,
  Open-Meteo history, planned on the day-ahead forecast: fair saving Comfortable 0.9 %, Save
  some 1.3 %, Save the most 6.9 % (best days 3.0/6.1/16.5 %; gross 3.2/4.5/18.7 %; off comfort
  0.04/0.06/0.28 K RMS). Perfect forecast 1.0/1.3/6.9 %. Unchanged from 8 Nov; still an upper
  bound on the too-warm balance.
- **2026-11-11 — the 0.7 kW gap re-checked (offline, read-only).** Scratchpad `balance/`.
  - The model's heat input *is* the meter (1577 spread by Hz, heat.ts), so input vs meter cannot
    disagree; the question is only the fit's split of heat loss vs free heat vs storage.
  - **The 9 Nov "0.7 kW" left out storage.** Indoor was rising ~0.3 K/day; at Ci+Cm 27 kWh/K
    that is ~0.3 kW. With it, the live model (H 227 W/K, gains 0.37 kW) against the meter over
    the last three 24 h windows: +0.35, −0.03, +0.35 kW. Within daily noise (a daily regression
    over 11 days leaves ±0.5 kW residuals whatever terms it gets).
  - Rolling 24 h heat per K on met.no outdoor since offset +6 settled: 216 → 250 → 226 → 238 W/K,
    no sun. A water-temperature loss term "explained" residuals only because it is the emission
    law (supply is set by the curve, collinear with ΔT): rejected.
  - **What still disagrees is the steady level.** At today's supply (38.0 °C, no hot water) the
    model's equilibrium indoor is 22.9 °C on recorded te, 23.4 on met.no, hence the −4 K comfort
    bias. The house sits at 21.9 °C and is still climbing at a fixed +6: 06–09 means 21.22,
    21.34, 21.40, 21.96 (8–11 Nov). Either a slow mass the 2R2C under-represents (indoor keeps
    climbing toward ~23) or heat loss/gains wrong (it levels near 22). **Test: leave +6 and
    room control off for 3–5 days and read where indoor levels off.** Nothing to change.
  - Confounder from today: the outdoor sensor moved Hue → Netatmo "Utetemperatur" (~21:20, app
    setting `autopilotOutdoorSensor`), which reads ~1 K warmer. The fit mixes both until the new
    source has 14 days. 5b stays blocked until the level-off is read.

## Autopilot heating: shift-only live test (ran 2026-11-12, replaced by the owner UI the same afternoon)

**Why.** The comfort bias rests on the model's steady level, which the +6 run has not confirmed
(entry above). Price shifting does not: `lib/autopilot/live.ts` plans with `pump = {lever}` (the
curve holds the house), comfort = the house's 24 h indoor mean, ±3 K bias, coasts ≤ 3 h, band
±0.5 K, no sun term. Feeds 5217 every 30 s, checks input 1 (4 × 750 ms); stops on 3 failed
cycles, 6 h without the outdoor sensor, immersion-only mode, SPA heating on, room-sensor control
on (2978), no model; no pre-heat while the immersion heater runs. Stop = one last feed of the
real outdoor. A Flow cannot write 5217 while it runs. Own fed slots set `FLAG.fedOutdoor` and stay
out of the wired-BT1 model. Switch: app setting `autopilotLive.<heating device id>` = `shift`.

**Bench (33 SE3 days, 9 Oct → 10 Nov, live model, day-ahead forecast, Manual):** bias −3.1…+3.1 K
(the 0.1 is the fed value's rounding), easing off 28 % of slots, pre-heating 9 %; fair saving
0.7 % (best day 2.9 %, worst −3.1 %), gross 2.3 %; heat −1.3 % against doing nothing (single days
−4.5…+3.8 %: plans move heat across midnight); indoor 21.4–21.7 °C. Tonight's plan on real
prices: ease off at 22:00 (−2 K) and 07:00–08:30 (−3 K), indoor −0.05 K.

**Test-run protocol (only after the maintainer's go to install):**
- [x] Install with the switch off (2026-11-12 ~13:55, f57b79e): app running, all four devices
      available, no `autopilotLive.*` setting. Input 1 read 6.9 °C against Utetemperatur 5.3 °C,
      so the pump is on its wired BT1, not a feed.
- [x] Turned on 2026-11-12 12:58:44 UTC: `homey api raw -X PUT --path
      /api/manager/apps/app/com.nibe.local/setting/autopilotLive.10.136.1.93%23heating --body
      '{"value":"shift"}'`. **`<id>` is the device's data id (`<ip>#heating`, `#` URL-encoded), not
      its Homey UUID**; the first try used the UUID, did nothing, and was deleted. Input 1 moved
      6.9 → 6.3 °C that second (sensor 5.3, so bias −1: easing off).
- Superseded: the remaining protocol steps (preconditions, first hour, daily check, turn off).
  The owner UI install at 15:00 (8362ed1) removed the `autopilotLive.*` switch and stopped the
  feed; the preconditions are now the Heating Setup checklist.

## Autopilot heating: setpoint trim (built 2026-11-14, 09f1322; PI since 2026-11-19, installed)

**What.** Autopilot heating now holds the Heating thermostat (`lib/autopilot/setpoint.ts`, design
in `docs/autopilot-plan.md` §7.3 "Setpoint trim"): a PI trim under the price shift, P = heat loss /
lever (0.5–3), I = 0.02 K per K·h, learning only while live and within 1 K of the setpoint, error on
the 24 h mean inside the comfort range and on indoor now beyond range + 0.5 K, clamped ±10 K. Away
is just another setpoint. Pairing now sets up Smart mode too (ffd1421), and setup ends on What
gets added / What changes (9d47329). Redesigned after the heating test: the integral is paced by
the house's time constant (16e3127), it runs from the day Autopilot is chosen (6ab59ce), holds
still 24 h after a setpoint change (ce2f988), and ignores implausible indoor (6549daa). Chosen on
200 simulated houses (`dev/simulate-trim*.ts`). Installed on the test Homey since 2026-11-20.

**Test plan:**
- Superseded: the confounders, the Simulated check and the 4–5 live days are the "evaluate the
  trim" section at the top.
- [ ] Away on and off once (now the home's switch on Main, 0a1d577): indoor heads to the Away
  temperature, and the trim holds still through the jump (`SETTLE_H`).

## Autopilot: solar, and pool and cooling (2026-11-12)

Plan: `~/.claude/plans/atomic-chasing-brooks.md`. As built: `docs/autopilot-plan.md` §10.0 "Solar".
- [x] Shared solar surplus service and budget; hot water moved onto it unchanged.
- [x] Heating: cooling guard, surplus effective price, sun gate (`sunReady`) and sun in live plans.
- [x] Smart mode for pool (848) and cooling (849), Autopilot "Soon".
- [ ] Read the sun gate on the S1155 over sunny days (daily fits log `sunOn`/`sunOff`).
- [ ] Heating reserves its surplus once cooling uses the budget.
- [x] One weather fetch per home: `gateway-weather.ts` keeps one forecast an hour and the GHI
  history once a day for the collector and the surplus (the hourly report shows one of each).
- [x] ~~Heating widget: draw the surplus.~~ Skipped 2026-11-23: a strip under the time axis and an area
  behind the bars were mocked; the owner found neither worked and isn't sure the chart needs it.
- **Phase 2: Pool and Cooling Autopilot** (design in the plan file):
  - Pool: band 687/689 at most 4 writes a day, plus a GHI gain coefficient for an outdoor pool.
  - Cooling: lever by probe (975 or 988, never BT1), pre-cool on price and surplus.
  - Both ship live, guarded; testers confirm.

## Autopilot heating: owner UI (built and installed 2026-11-12)

Replaces the hidden `autopilotLive.*` switch with the Price control settings, Heating Setup →
Autopilot (choose, checklist, outdoor sensor picker, profile + comfort, Verify, Return to NIBE),
status + reason + Insights on Heating, and Flow cards (status changed, status is, pause, resume,
set profile). Design and as-built notes: `docs/autopilot-plan.md` §10.0.

**Profiles are how far indoor may drift (maintainer, 2026-11-12):** Comfort ±0.5 °C, Save ±3 °C,
I'd rather freeze ±6 °C; the outdoor shift follows (±10 / ±15 / ±20 K, Ngenic went ±10). The first
±1.5 / ±3 / ±4 K limits were too timid: shift size alone barely mattered (±10 K at the old 3 h and
39 % spread: 0.9 %); coast length, price spread and comfort weight did. Bench (34 SE3 days, live
model, day-ahead forecast), fair / gross / heat vs nothing / indoor: Comfort 1.4 % / 4.4 % / −2.2 % /
21.1–21.8; Save 4.4 % / 10.2 % / −3.8 % / 20.6–22.1; Freeze 8.3 % / 25.5 % / −15.3 % / 20.1–22.6
(mean 21.45: part of it is running colder). Single days swing far more (heat moved across
midnight). All rests on the model; the live run has only tested 2 K so far.

**Installing it switches the running feed off** (the old setting is gone): BT1 is handed back,
then the maintainer turns Autopilot on in Heating → Repair → Autopilot. That is the UI test.
- [x] Installed 2026-11-12 15:00 local (c27c2bf): app running, all devices available, Price
      control heating Off, so the shift-only feed stopped. The setting is called Comfort range.
- [x] Revised the same evening (maintainer): Price control → **Smart mode** in each function's
      Repair; Comfort range, Away and Away temperature are Heating capabilities; comfort is the
      thermostat; Comfort range Off feeds unshifted; widget: indoor vs BT1 offset, ±12 h.
- [ ] Repair → Smart mode on Heating: checklist shows indoor, Utetemperatur, dynamic prices, room
      control off; Verify passes; the SPA heating tiles go.
- [ ] Hot water → Repair → Smart mode: choices save; SPA hot water tiles follow.
- Superseded: the Away check moved to the setpoint trim section (Away is now a setpoint the trim
  holds, on Main's switch).
- [ ] Autopilot widget on a dashboard: indoor and offset axes read right; Comfort range Off feeds 0.
- [ ] Heating tile: status, reason, fed outdoor, shift update each slot; Insights log them.

## Autopilot slice 1: data collection (branch `smart-heating/m1-data`)

**Goal.** Record what the house model will learn from, starting now, because learning needs weeks
of history. Nothing new is shown to the owner and nothing is written to the pump. Design source:
`docs/autopilot-plan.md` §5.2–5.5.

**No switch (maintainer, 2026-10-30).** Collection runs on every Heating device in this build,
which goes onto the maintainer's Homey with `homey app install`; it is not released. The
owner-facing mode choice (`mode.ts`) gates it before anything ships.

**Pure modules (`lib/autopilot/`, unit-tested with an injected clock):**
- [x] `prices.ts`: Homey Energy response → 15-min UTC slots. 60-min zones ×4; DST days (92/100
      slots); user-cost formula by a hand-written parser (numbers, + − * /, parentheses, unary
      minus; never `eval`) with the `highestPriceWithUserCosts` self-check, else spot and
      `costsApplied: false`; tomorrow-missing vs today-missing.
- [x] `weather.ts`: Open-Meteo URL builder (location rounded to 2 decimals, `metno_seamless`,
      tilted irradiance S) and response → per-slot values, linear interpolation hourly → 15 min,
      24 h staleness. MET Norway fallback is left for a later slice.
- [x] `history.ts`: 15-min bucket aggregator (mean, kWh sum, fraction, flags), `partial` below
      80 % poll coverage and after a reconnect, `Float32Array` ring of 28 × 96 slots, versioned
      (de)serialisation.
- [x] `heat.ts`: spread each whole-kWh step of 1577 over the slots since the previous step,
      weighted by Hz; drop hot-water slots.

**Glue:**
- [x] `lib/autopilot/collector.ts`: one per pump, owned by Heating (the `indoorOwners` pattern).
      It takes `onPollComplete`/`lastRawFor` samples and the pump's total electricity per poll.
      It runs a price timer (hourly, every 15 min from 12:45 to 16:00 until tomorrow appears) and a
      weather timer (hourly ± 5 min).
- [x] `lib/autopilot/store-file.ts`: `/userdata/autopilot-<random>.bin`, with the random name held in the
      device store. Writes go through a temp file and a rename. Flushed hourly and in `onUninit`.
- [x] `wantedRegisters()` on Heating adds 1, 5, 7, 10, 11, 1017, 1046, 1577, 1028, 1029 and indoor
      while collecting.
- [x] Hourly debug line: slots filled, partial count, price and weather age.
- [x] `dev/read-autopilot-history.mjs`: download and decode the file, then print slots as CSV, so the
      data can be checked by eye.

**Out of this slice:** the model, insights, mode choice, Setup/Repair UI, Insights backfill, the
real-outdoor source while feeding (input 1 is real as long as nothing feeds), analytics and the
six-language strings (the slice adds no owner-facing text).

**Verify:**
- [x] `npm test`, `npm run typecheck` and `npx homey app validate --level publish` pass.
- [x] After 24 h on the installed dev build, read the file back (2026-10-31, 92 slots, none
      partial). 79/79 of the day's slots match Homey Energy's spot and all-in price; spread heat
      85.81 kWh vs 1577's 85.80. 2166 summed 5.8 % under 3823, so per-slot electricity now
      spreads 3823 instead (`electricityPerSlot`).
- [x] Dev build installed on the maintainer's Homey (`homey app install`); no release. First hour
      read back 2026-10-30: prices match the cost formula, 2166 sums to within 1 % of 3823; 1577
      flat because the pump made hot water all hour, so heat spreading is still unverified.

**Open for the maintainer:**
- 28 days of 15-min history (~230 KB) is enough for M1/M2.

## Before 1.0 (0.9.13 to 0.9.15)

Shipped and recorded in `docs/releases.md` (0.9.13, 0.9.14, 0.9.15 and 1.0.0 rows). Left open:

- [ ] Split `PumpConnection` (`lib/connection.ts`, now 1654 lines) along `energy/diagnostics`,
      `energy/allocator`, `modbus/transport`; deliberately after 1.0.
- [ ] Reply to [issue #4](https://github.com/lovethyresson/com.nibe.local/issues/4) (halderex's
      myUplink cross-check behind moving the meters to 2305), if not already done.

## F-series: experimental driver (shipped in 1.3.x and 1.4.x; hardware validation open)

The `codex/f-series-diagnostics` branch adds a shared-engine F-series driver with automatic
feature detection, a curated register superset from seven model exports, gateway address
selection, and improved remote diagnostics. See [F-series support](../docs/f-series.md).

Remaining validation: compare readings on the volunteer's F730, then independently test
MODBUS 40 through a TCP bridge and other F models. Reviewed controls, conditional Heating rendering and experimental allocation/COP are included;
compressor scaling, production availability and scope still require real-pump validation.

- [x] Document F-series energy limits in the README: allocation covers
      compressor and immersion consumption by operating priority. Main may show zero or very
      little because fans, circulation pumps, controls and inverter losses are not accounted
      for. Zero on Main does not mean zero standby electricity, and the function allocations
      are not a complete whole-pump electricity breakdown. Match the wording to the final
      validated implementation.

F-series handover checklist: [owner tests](../docs/f-series-user-test.md).

- [x] Incorporate F730 gateway follow-up: LOG.SET fast baseline, one slow background parameter per poll, two detection passes, observation-only debug dumps, delayed simulator mode. Hardware cache freshness remains to verify.

## Overview widget (F3 mock, chosen 2026-11-19)

One widget per pump, picked by its Main device. Title: the Main device's name. Ring: today's use in
the day's cheapest / middle / most expensive third of hours (same thirds as Energy today and the
savings widgets). Beside it: savings this month (Heating + Hot water savings widgets' month figures,
summed), and a small line with what today cost (Energy today's figure). Rows: one per function
device, with indoor temperature in the comfort range and the tank level as small bars. At most two
attention lines: offline, pump alarm, a device warning (problems first, then advice).

- [x] thirds computed in overview.ts `priceThirds` from Energy today's hours (energy.ts unchanged)
- [x] savings.ts: the month figure as a number (`monthValue`)
- [x] lib/autopilot/overview.ts: pure model + tests
- [x] device.ts: `overviewWidget()` on Main; track warning and unavailable text
- [x] app.ts: register picker + endpoint; widgets/overview (compose, api, page, previews)
- [x] locales, six languages, both layers
- [x] npm test (719 pass), typecheck, homey app validate --level publish
- [x] install after the heating test ends; fetch the live endpoint and render it: installed
  2026-11-20, previews regenerated from the live debug route (4f4e3d9, 864907b)
