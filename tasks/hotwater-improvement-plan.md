# Hot water Autopilot: plan to pay less without colder showers

2026-11-21. Based on the week 14–21 Nov, outside research, and two independent reviews against the
code and data. Evidence and scripts: scratchpad `hwa/`.

## What we know

- The prize is small and specific. Mon–Fri cost 65 kr, paying 1.025× each day's average price.
  Hindsight with perfect knowledge is 0.88×. That gap is about 7–12 %, roughly 1 kr a day here.
  Daily price indices spread ±0.18, so a week cannot show a 5 % change; anything we build must be
  judged on paired replays, not before/after weeks.
- Half the gap is not the forecast. The old back-test, on the same learned forecast, reached 0.95×;
  live paid 1.025×. It spread each hour's draw over four slots and ignored the start and write caps
  and the day-type labels. Reconciled 2026-11-22 (1.2): the gap is one day, not the planner (below).
- The single biggest identifiable cost is a stale midday shape: Tue 11–12 and Wed 11 runs at
  3.3–4.3 kr (≈ 14 kr, 22 % of the week) for water used later. Likely cause (not yet confirmed
  from the saved model): the owner's day types are logged only from 10 Nov (a Flow sets them at
  00:05). On 16 Nov the working-day profile had about 4 days of its own (10–13 Nov, the first a
  part day), under the 5 it needs (`SHRINK_DAYS`), so it leaned on the pooled profile, weekend
  middays included. Hour shapes also come only from hourly data (Insights keeps 14 days).
- Big evenings come in two blocks (Tue 104 L at 17, 164 L at 19–20; Thu 171 L at 17–18, 154 L at
  21) and exceed what a full tank holds above the floor (~230 L). A mid-evening run is unavoidable
  on those days; the question is only how cheap.
- The cap of 3 starts a day (`MAX_STARTS_PER_DAY`, `hotwater-lever.ts:10`) covered rescues too: a
  rescue was an ordinary start with reason 'reserve' that reached `leverDecision`, which never saw it
  was a rescue. The legionella run spends a start as well, and the pump's own charging is taken
  over. Tue used all three. A refused rescue was logged once and nothing else. Fixed in Step 2.
- Sun 15 13–15: ~8 kWh of compressor heating an already full tank (272 L, 56 °C → 57.5 °C, COP ≈ 1.1,
  plus 0.9 kWh immersion), ≈ 15 kr. The code that raises a running run's stop (`extendTarget`,
  capped by `maxC`, `hotwater-shadow.ts:280`) is still in, so it may recur.
- Legionella runs to 65 °C every 14 days, above the compressor's ~58 °C, so the last degrees are
  the immersion heater. Estimated 2.5–3 kWh, ≈ 5–6 kr a run (not measured); the pump's own 61 °C
  is also above the ceiling, so 65 vs 61 is ≈ 2 kr a run, ≈ 0.15 kr a day. Small; measure first.
- Day types are the owner's record of real days off (holidays, vacations, home days, sick days),
  and the only thing that keeps a day-off pattern out of the working-day profile. They exist from
  10 Nov; before that the learner falls back to weekends. Every analysis below that splits by day
  before 10 Nov is a **weekday/weekend proxy**, an assumption, and is labelled so.
- Weekday/weekend proxy (Insights, 1 Sep–20 Nov, 6-hour blocks on UTC boundaries, ±1 h at the clock
  change; litres rebuilt from the estimate's fall plus produced heat, standing loss ignored):

  | Proxy | Litres a day (mean / median / P80) | Electricity | 01–07 | 07–13 | 13–19 | 19–01 |
  |---|---|---|---|---|---|---|
  | Mon–Fri (59) | 325 / 282 / 430 | 4.0 kWh | 82 | 62 | 130 | 50 |
  | Sat–Sun (22) | 557 / 570 / 801 | 7.3 kWh | 132 | 232 | 154 | 38 |

  Weekends use about 1.7× the water, mostly at midday; weekdays use it in the evening. Holidays and
  home days inside "Mon–Fri" blur both rows, so the real working-day/day-off contrast is likely
  larger. Evenings also follow a weekly rhythm in the proxy: median evening litres Mon 81, Tue 184,
  Wed 121, Thu 171, Fri 134 (Tue above 230 L in 4 of the last 8 weeks, Mon in 2). To confirm on
  labelled days as they accumulate.

## Status (2026-11-22)

- **1.2, the back-test matches live.** `dev/evaluate-hot-water.mjs` now runs the live code slot by
  slot: `autopilotCharge`, `leverDecision` with the day's caps, `extendTarget`, `dueAt`, day types
  from the owner's log (`dayTypeAt`), each hour's draw in its first slot, local days, the tank
  re-read after a gap. On 14–20 Nov (Autopilot's days, Insights fetched 21 Nov):

  | | kr | kWh | Price index |
  |---|---|---|---|
  | As it ran | 119.7 | 47.1 | 1.06 |
  | Replay | 96.0 | 34.9 | 0.99 |
  | Hindsight (draws known, no caps) | 94.0 | 36.3 | 0.95 |
  | As it ran, without 15 Nov | 89.6 | 29.8 | |
  | Replay, without 15 Nov | 85.6 | 28.2 | |
  | Hindsight, without 15 Nov | 83.1 | 29.9 | |

  Without Sun 15 Nov, live and replay agree within 5 % on both kr and kWh. Sun 15 Nov alone is
  17.3 kWh live against 6.7 replayed: the full-tank run and the immersion heater (step 4.1). So
  the 0.95 → 1.025 gap was that one day, not the planner's timing, and the planner is about
  0.5 kr a day above hindsight. Hindsight is not a strict floor: it keeps the 40 L minimum with
  the draws known, while the replay dipped under it in 5 slots (5 rescues, none refused).
  Run: `node --import tsx dev/evaluate-hot-water.mjs --insights <dir> --prices <dir> --day-types
  <file> --from 2026-11-14`. Not modelled: legionella, heating's pre-heat slots, surplus, the
  learned ceiling (`--max`), a stratified top.
- **So step 4.1 is where the money is:** one day like 15 Nov costs as much as two weeks of the
  planner's gap to hindsight.
- **Done:**
  - 2: a rescue may use 5 starts a day (`MAX_RESCUE_STARTS_PER_DAY`), `leverDecision` takes
    `{belowK, rescue}`, a refused rescue is its own skip ('rescue limit'), a device warning cleared
    at midnight and counted in the day record; legionella was already counted (17d0914, fc17256).
  - 3.1: "Best time for your use" (17d0914).
  - 3.2: checked, with a different cause than guessed (below); fixed in 17d0914 and 75403d2.
  - 1.1: slot context in every log line, one record a day kept 400 days (`hotwater-days.ts`,
    `DAYS_KEPT`), the log path logged at start (f0a9742).
  - 1.3 tool: `dev/replay-hot-water.ts`, checked against a synthetic log: all replayable slots
    match (f0a9742; `dueAt` passed as live does, fc17256).
  - 5.0: the household questions are asked every time, with what they do; new questions on the
    working-day shower time and busy weekday evenings; the day type line says why to mark days off
    (2f551d1). Left out: prefilling from what was learned (it prefills the saved answers), and the
    per-answer reason lines ("Tuesday is a busy evening, so more is planned"), since 5.1 is not
    planned with yet.
  - 5.1 as a logged challenger: per-weekday working evenings, shrunk toward all working evenings
    until a weekday has 6 days, seeded 1.5× from the busy-evening answer; each day record holds
    both evening forecasts (b405d3b, 2f551d1). Not planned with.
- **Related, outside the plan:** the operating state's reason names Autopilot when it switches on
  More hot water. Before writing 697, `startCharge` in `hotwater-shadow.ts` calls the `starting` hook, which the device passes
  to `connection.noteReason` (`AUTOPILOT_HOTWATER_NOTE`); `reason.ts` uses the note for 10 min
  (0624c39). Hot water savings leave legionella boost days out of both sides (2604d13).
- **Partly:** 1.4. The day record holds starts, rescues, refused rescues and minutes under the
  minimum; kr above hindsight and kr per kWh drawn are not computed.
- **3.2, checked:** none of the working days 9–13 Nov was a full day (15–21 of 22 known hours:
  the tank sat under 40 °C overnight, so those hours are unknowable), and only full days gave hour
  shapes. Fixed: each hour learns from the days it was known on (part days included; a test fails
  on the old learner and passes on the new). An hour that empties the tank counts with at least
  its draw, and cold hours complete an evening only after a draw emptied the tank that evening.
- **3.2, not proven:** that this caused the Tue/Wed midday runs. The rebuild of the 16 Nov model
  used Insights fetched 21 Nov, whose hourly data starts 7 Nov; live on 16 Nov had hourly data from
  about 2 Nov, so 3–6 Nov may have been full working days with their own shape. With that data
  missing, the rebuild's working midday (10.4 → 1.5 kWh with the fix) cannot be taken as what
  live planned with, and it cannot be rechecked now. The day-type cold start is not ruled out
  either. The day records (1.1) keep this answerable next time.
- **4:** Insights cannot say who started Sun 15's run (697 has no log; the charge events kept two
  days are gone). The new slot context logs 697 and both stops, so a recurrence is identifiable.
  No legionella run yet. No change made: `extendTarget` is still capped by `maxC` only.
- **Open:** 4.1, 5.2, 5.3, 6, 7. The slot-by-slot diff against the live log (1.3) still waits on
  lines with context: the log restarted with the new Homey, and its 105 lines with context are
  under one price horizon, so none is replayable yet.
- **Waiting on an install:** the replay against live needs lines with context; the challenger
  needs mornings. 5.2 waits on state counts (the day records carry the hourly litres to score it);
  6 on evidence; 7 on its mock.
- **Not yet:** 1.2's hindsight score (kr above hindsight) needs the day records to accumulate; the
  learner still learns from Insights only, not from the day records.

## Considered and rejected

- Early-draw credit: Thu's 17:00 draw was the first of two; crediting it cancels the 19:00
  run before a 154 L draw at 21. The code computes it but does not pass it live (`early`,
  `hotwater-shadow.ts:86-91`; it cites a busy 17 Nov Saturday read as early draws); the log keeps
  what the plan would do with it.
- Faster half-life: over 14 days of hourly data it barely changes the weights.
- Quantile window (plan the evening at P85 within a few hours of it): with replanning every slot
  it moves the top-up to the window's first slot, not the cheapest, and adds starts.
- Smaller rescue: the planner already sizes the rescue; smaller means more starts.
- Crediting tank loss as space heat: standing loss is 0.05–0.1 kWh/h, the fill penalty is COP, and crediting
  it would make hot water cost disagree with Homey Energy.

## How we judge any change

- Cost: paired replay. Both planners on the same logged 15-minute draws, prices and starting state,
  with the start and write caps, scored per day as kr above hindsight. Paired differences vary far
  less than daily indices.
- Safety, from live and shadow: floor rescues, minutes under the floor, starts per day, "daily limit"
  skips. A change may not make any of these worse.
- Diagnostics only: price index, kr per kWh drawn, unplanned share (over-forecasting lowers it
  while cost rises, so it is never a target).
- The daily figures are computed by the same code as the savings card, so they agree.

## Step 1 — reconcile and measure (no behaviour change; can start now)

1.1 **Done (f0a9742).** The shadow log already holds 28 days of 15-minute lines (litres, top, produced, action, next;
    `KEEP`, `ShadowEntry`: `hotwater-shadow.ts:42-43, 97-123`) and is trimmed after that. Stop losing it: before the trim,
    write a compact per-hour record (draw rebuilt from litres + produced, top, starts, day type,
    price) to the store. Day types are not in the log today and cannot be re-fetched: add them.
1.2 **Done (2026-11-22, Status).** Make the back-test honest: each hour's draw in its first slot, the 3-start and stop-write caps,
    reserved slots, the real day-type labels, the live replan from the pump's real state (top, the
    Large stop in force, Large mode where 62 is never written), starting from the stored top rather
    than litres, and the hot top that vouches against a rescue (`hotwater-planner.ts:199-202`).
1.3 **Tool done (f0a9742); the run against live waits on logged lines.** Replay the logged days from the logged state and diff the action column (`action`, `next`) slot
    by slot against live. Explain the 0.95 vs 1.025 gap before trusting any other number.
1.4 **Partly:** the day record has rescues, refused rescues, minutes under the minimum and
    starts; kr above hindsight and kr per kWh drawn are open. Daily score in the log and a store: kr above hindsight, rescues, refused rescues, minutes under
    the floor, starts, kr per kWh drawn.

## Step 2 — a rescue is never refused (before anything that might add a start)

All done (17d0914, fc17256): `MAX_RESCUE_STARTS_PER_DAY` = 5, about 1,800 writes a year.

2.1 Give `leverDecision` a rescue flag (as `belowK` was added): a start with reason 'reserve' gets
    its own higher, bounded cap (e.g. 5 a day) instead of the shared 3. The cap is a wear guard on
    the pump's memory (`hotwater-lever.ts:6-7`), so the bound stays; check how much headroom the
    pump's EEPROM really has before choosing it.
2.2 Count the legionella start in the same tally (it already spends one).
2.3 A refused rescue becomes a tracked event and a device warning, not one log line. Gate for this
    step: zero refused rescues.

## Step 3 — cheap fixes

3.1 **Done (17d0914): "Best time for your use".** Reason label: "Less heat lost in the tank" is a leftover bucket in `dearer()`; the plan is a DP
    over the whole day, so no single cost term decided it and attributing one would be a guess that
    can disagree with the plan. Use a neutral line that is always true (e.g. "Cheapest time that
    still covers your use"). Six languages, owner text.
3.2 **Checked; cause differed (Status). Fixed in 17d0914, 75403d2.** Day-type check, now: read the saved model for how many days of its own each profile had on
    16 Nov. The day type log (from 10 Nov) suggests about 4 working days, under the 5 needed: if the
    model confirms it, the midday runs were a cold start, and Step 5.0's setup questions are the
    fix (a starting point per day type instead of the pooled one). Then decide whether keeping
    shapes beyond 14 days (via 1.1) helps; weights are nearly flat across 14 days at a 21-day
    half-life, so older days also bring older shapes: test, don't assume.

## Step 4 — the full-tank runs, and what legionella really costs

4.1 **Open.** Identify Sun 15's 13:15 run from the charge events (planned top-up, stop raise, or periodic).
    Score every stop raise (`extendTarget`) since: heat gained vs electricity at that fill. If stop
    raises on a nearly full tank lose money, cap them by fill, not only by `maxC`.
4.2 **Open (no run yet).** Measure the real legionella runs (immersion kWh from 1069, produced, kr) before any change.
    Only then price options with the replay: target, and timing after a big draw (which would need
    a new trigger: today the window is chosen up to 48 h ahead by price, `pickWindow` and
    `legionellaStep`, `legionella.ts:105-141`).

## Step 5 — a forecast that knows this household's week

5.0 **Done (2f551d1), except the prefill from learned values and the per-answer reason lines.**
    Setup: a better starting point, and why it matters. Today Hot water setup asks people,
    morning hour and the busiest time on a day off, and only while history is short. Change it to:
    - Say what the answers do, in one line each, in standard UI phrasing: Autopilot starts from
      your answers and learns your household's real pattern from your heat pump's readings; after
      about two weeks it relies on what it has measured, and you can change the answers any time.
    - Explain day types where they are set up: marking holidays, home days and vacations as days
      off (by hand or with a Flow that follows your calendar) keeps those days from shaping the
      working-day plan. Say it once, with the reason, and offer the Flow as the easy way.
    - Ask (always, editable later; prefilled from what was learned once there is enough):
      - "On working days, when does your household mostly shower?" (Mornings / Evenings / Both /
        It varies). Seeds the working-day shape, so a new or relabelled profile does not start
        from the pooled one (the 16 Nov case).
      - "Any weekdays with more hot water in the evening?" (Mon … Fri, multi-select, e.g. sports or
        bath nights). Seeds the per-weekday evening in 5.1.
      - Keep: people, morning hour, busiest time on a day off.
    - Each answer gives a one-line reason the owner can check: "Tuesday is a busy evening, so more
      is planned." Once learning has taken over, the reason names the learning instead.
    Mock first (light and dark, Homey's real CSS); six languages; "heat hot water" wording.
5.1 **Logged as a challenger, not planned with (b405d3b, 2f551d1).** Per-weekday evening: learn the evening draw per weekday (mean and P80), shrunk toward the day
    type's evening until a weekday has about 6 labelled days of its own, starting from the setup
    answer. Weekdays without a label before 10 Nov count only as the proxy, weighted down.
    Reason: "Tuesday evenings usually use more."
5.2 **Open.** One yes/no feature: did the morning (05–09) draw reach about 80 L? Forecast the evening from
    days in the same state (mean and P80), shrunk toward the unconditional profile, falling back to
    it below about 6 days per state. Hourly Insights are enough for the feature; the wait is for
    the state counts. One-line reason from the measured fact, not an inference: "More hot water was
    used this morning, so less is planned tonight." Gate: paired replay and safety metrics.
    A first look is mixed: in the week of 16 Nov low mornings came before big evenings and high
    ones before small; the week before showed no pattern. The state counts decide.
5.3 **Open.** "Days like today" (k nearest days on draws so far, same day type and weekday), once 1.1 holds
    enough 15-minute days per weekday. Built as a challenger: it runs in the replay against 5.1 and
    5.2 and replaces them only if it beats both on cost and safety. Its owner reason is the plan's
    own ("Planned for a usual Tuesday evening"), never "days like today". Too little 15-minute
    history exists today for it to be a first build (one odd day would dominate).

## Step 6 — only if the replay shows it pays

6.1 **Open.** Ready-by-evening floor: "by 17:00, stored ≥ floor + P85 of the evening" as a time-tied soft
    floor in `below()`, so the planner picks the cheapest slot of the whole day with COP and holding
    included. Reason: "Ready for a busy evening by 17:00". Only if the replay shows big-evening
    misses on days when the afternoon is cheaper than the evening (this week it was not).

## Step 7 — let the owner say it ahead

7.1 **Open.** "Extra hot water" one-offs counted in showers (Shower, Bath, Guests), planned into the cheapest
    hours before; Flow card "Plan extra hot water: [kind] by [time]" and a tile picker, no widget.
    No product does this ahead of time; the perfect-demand gap in Kepplinger et al. 2024 (~28 %) is
    what the information can be worth. To define: Guests vs the "free" day type; a one-off entered
    too late to be cheap (heats now, with its own reason line); its starts count under Step 2.
    Mock first.
7.2 No warn-and-ask: notifications cannot carry buttons, an unanswered question needs a safe
    default, and it would fire on exactly the days the forecast already misses.

## Order

1 (from the 28 days already logged) → 2 (protects every later step) → 3 (cheap) → 4 (measure first)
→ 5.0 and 5.1 (setup: explain day types and ask for a starting point, then per-weekday
evenings: likely the largest forecast gain, and the fix for a cold-start profile) → 5.2 when its state counts reach about 6 days each → 5.3 when 1.1 has enough
15-minute history. 6 only on evidence. 7 alongside, after the mock.

## Sources

Buechler, Goldin, Rajagopal 2024, arXiv 2408.02868 · Biagioni et al. 2021, arXiv 2111.04689 ·
Kepplinger, Huber, Preißinger 2024, Frontiers in Energy Research, doi 10.3389/fenrg.2024.1363378 ·
Purdue HPWH field study 2025, arXiv 2510.12955 · LBNL-4830E · energy-stats.uk, 700 heat pump hot
water runs · Mixergy support · NIBE S1155 manual · Boverket BBR 6:62.
