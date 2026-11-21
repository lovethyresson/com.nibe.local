# Hot water Autopilot: plan to pay less without colder showers

Draft 5, 2026-11-21. Draft 1 from the week's analysis, draft 2 with outside research, drafts 3 and 4
after two independent critiques against the code and data. Evidence and scripts: scratchpad `hwa/`.

## What we know (and what draft 1 got wrong)

- The prize is small and specific. Mon–Fri cost 65 kr, paying 1.025× each day's average price.
  Hindsight with perfect knowledge is 0.88×. That gap is about 7–12 %, roughly 1 kr a day here.
  Daily price indices spread ±0.18, so a week cannot show a 5 % change; anything we build must be
  judged on paired replays, not before/after weeks.
- Half the gap is not the forecast. The back-test, on the same learned forecast, reaches 0.95×;
  live paid 1.025×. The back-test spreads each hour's draw over four slots (`dev/evaluate-hot-water
  .mjs:59`), ignores the 3-starts-a-day cap, the Large-stop write cap, the orchestrator's reserved
  slots and the day-type labels. Until replay matches live, every back-test number is optimistic.
- The single biggest identifiable cost is a stale midday shape: Tue 11–12 and Wed 11 runs at
  3.3–4.3 kr (≈ 14 kr, 22 % of the week) for water used later. Cause is mechanical: hour shapes
  are learned only from hourly data (Insights keeps 14 days; live readings 36 h), and a day type
  with < 5 weighted days of its own leans on the pooled profile, weekends included.
- Big evenings come in two blocks (Tue 104 L at 17, 164 L at 19–20; Thu 171 L at 17–18, 154 L at
  21) and exceed what a full tank holds above the floor (~230 L). A mid-evening run is unavoidable
  on those days; the question is only how cheap.
- The cap of 3 starts a day (`hotwater-lever.ts:10, 58`) covers rescues too: a rescue is an ordinary
  start with reason 'reserve' that reaches `leverDecision`, which never sees it is a rescue. The
  legionella run spends a start as well, and the pump's own charging is taken over. Tue used all
  three. A refused rescue is logged once and nothing else: a silent cold-shower path, today.
- Sun 15 13–15: ~8 kWh of compressor heating an already full tank (272 L, 56 °C → 57.5 °C, COP ≈ 1.1,
  plus 0.9 kWh immersion), ≈ 15 kr. Draft 1 called it old code; the code that raises a running
  run's stop (`extendTarget`, df6cbf1, capped by `maxC`) is still in. Not established as fixed.
- Legionella runs to 65 °C every 14 days, above the compressor's ~58 °C, so the last degrees are
  the immersion heater. Estimated 2.5–3 kWh, ≈ 5–6 kr a run (not measured); the pump's own 61 °C
  is also above the ceiling, so 65 vs 61 is ≈ 2 kr a run, ≈ 0.15 kr a day. Small; measure first.
- Day type matters a lot, and so does the weekday (Insights, 1 Sep–20 Nov, 6-hour blocks, ±1 h at
  the clock change):

  | | Litres a day (mean / median / P80) | Electricity | 01–07 | 07–13 | 13–19 | 19–01 |
  |---|---|---|---|---|---|---|
  | Working days (59) | 325 / 282 / 430 | 4.0 kWh | 82 | 62 | 130 | 50 |
  | Days off (22) | 557 / 570 / 801 | 7.3 kWh | 132 | 232 | 154 | 38 |

  Days off use 1.7× the water and put it at midday; working days put it in the evening, with almost
  nothing 07–13. So a working-day profile with midday peaks (16 Nov) is a labelling or pooling
  fault, not the household. Evenings follow a weekly rhythm: median evening litres Mon 81, Tue 184,
  Wed 121, Thu 171, Fri 134 (Tue above 230 L in 4 of the last 8 weeks, Mon in 2). Fixed activity
  days, most likely.
- Dropped from draft 2, with reasons:
  - Early-draw credit (1.2): Thu's 17:00 draw was the first of two; crediting it cancels the 19:00
    run before a 154 L draw at 21. The code withholds it for this reason (hotwater-shadow.ts:84-89).
  - Faster half-life (2.2): over 14 days of hourly data it barely changes the weights.
  - kNN on "today so far" as a first build: ~10 working days of hourly data exist today, so one odd
    day would dominate. Not dropped: it returns in Step 5 once the history from 1.1 has grown, and
    competes there with the simpler rules on the same replay.
  - Quantile window (3.1 as written): with replanning every slot it moves the top-up to the window's
    first slot, not the cheapest, and adds starts.
  - Smaller rescue (3.2): the planner already sizes the rescue; smaller means more starts.
  - Recoverable loss (5): standing loss is 0.05–0.1 kWh/h, the fill penalty is COP, and crediting
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

1.1 The shadow log already holds 28 days of 15-minute lines (litres, top, produced, action, next;
    `hotwater-shadow.ts:41, 96-120`) and is trimmed after that. Stop losing it: before the trim,
    write a compact per-hour record (draw rebuilt from litres + produced, top, starts, day type,
    price) to the store. Day types are not in the log today and cannot be re-fetched: add them.
1.2 Make the back-test honest: each hour's draw in its first slot, the 3-start and stop-write caps,
    reserved slots, the real day-type labels, the live replan from the pump's real state (top, the
    Large stop in force, Large mode where 62 is never written), starting from the stored top rather
    than litres, and the hot top that vouches against a rescue (`planner.ts:200-202`).
1.3 Replay the logged days from the logged state and diff the action column (`action`, `next`) slot
    by slot against live. Explain the 0.95 vs 1.025 gap before trusting any other number.
1.4 Daily score in the log and a store: kr above hindsight, rescues, refused rescues, minutes under
    the floor, starts, kr per kWh drawn.

## Step 2 — a rescue is never refused (before anything that might add a start)

2.1 Give `leverDecision` a rescue flag (as `belowK` was added): a start with reason 'reserve' gets
    its own higher, bounded cap (e.g. 5 a day) instead of the shared 3. The cap is a wear guard on
    the pump's memory (`hotwater-lever.ts:6-7`), so the bound stays; check how much headroom the
    pump's EEPROM really has before choosing it.
2.2 Count the legionella start in the same tally (it already spends one).
2.3 A refused rescue becomes a tracked event and a device warning, not one log line. Gate for this
    step: zero refused rescues.

## Step 3 — cheap fixes

3.1 Reason label: "Less heat lost in the tank" is a leftover bucket in `dearer()`; the plan is a DP
    over the whole day, so no single cost term decided it and attributing one would be a guess that
    can disagree with the plan. Use a neutral line that is always true (e.g. "Cheapest time that
    still covers your use"). Six languages, owner text.
3.2 Day-type check, now: read the saved model and the 16 Nov log line ("own profiles for working
    and free days") for how many days of its own the working profile had. If it was mostly pooled,
    that explains the midday runs; then decide whether keeping shapes beyond 14 days (via 1.1)
    helps. Weights are nearly flat across 14 days at a 21-day half-life, so older days also bring
    older shapes: test, don't assume.

## Step 4 — the full-tank runs, and what legionella really costs

4.1 Identify Sun 15's 13:15 run from the charge events (planned top-up, stop raise, or periodic).
    Score every stop raise (`extendTarget`) since: heat gained vs electricity at that fill. If stop
    raises on a nearly full tank lose money, cap them by fill, not only by `maxC`.
4.2 Measure the real legionella runs (immersion kWh from 1069, produced, kr) before any change.
    Only then price options with the replay: target, and timing after a big draw (which would need
    a new trigger: today the window is chosen up to 48 h ahead by price, `legionella.ts:114-130`).

## Step 5 — a forecast that knows this household's week

5.0 Ask in setup (Hot water setup already asks people, morning hour and the busiest time on a day
    off when history is short). Add, always asked and editable later:
    - "Any weekdays with more hot water in the evening?" (Mon … Fri, multi-select; e.g. sports or
      bath nights). Seeds a per-weekday evening profile; the data above says this household has
      two such days.
    - "On working days, when does your household mostly shower?" (Mornings / Evenings / Both /
      It varies). Seeds the morning→evening rule in 5.1 and its sign.
    The answers are a prior that learning overrides as days accumulate (as the existing household
    answers are), and each gives a one-line reason: "Tuesday is a busy evening, so more is planned."
    Mock first; six languages.
5.1 Per-weekday evening: learn the evening draw per weekday (mean and P80), shrunk toward the day
    type's evening until a weekday has about 6 days of its own. Uses 6-hourly Insights back to the
    install, so it can start now. Reason: "Tuesday evenings usually use more."
5.2 One yes/no feature: did the morning (05–09) draw reach about 80 L? Forecast the evening from
    days in the same state (mean and P80), shrunk toward the unconditional profile, falling back to
    it below about 6 days per state. Hourly Insights are enough for the feature; the wait is for
    the state counts. One-line reason from the measured fact, not an inference: "More hot water was
    used this morning, so less is planned tonight." Gate: paired replay and safety metrics.
5.3 "Days like today" (k nearest days on draws so far, same day type and weekday), once 1.1 holds
    enough 15-minute days per weekday. Built as a challenger: it runs in the replay against 5.1 and
    5.2 and replaces them only if it beats both on cost and safety. Its owner reason is the plan's
    own ("Planned for a usual Tuesday evening"), never "days like today".
    First look supports testing it (week of 16 Nov: low mornings → big evenings, high → small) but
    the week before does not; 8 weeks decide.

## Step 6 — only if the replay shows it pays

6.1 Ready-by-evening floor: "by 17:00, stored ≥ floor + P85 of the evening" as a time-tied soft
    floor in `below()`, so the planner picks the cheapest slot of the whole day with COP and holding
    included. Reason: "Ready for a busy evening by 17:00". Only if the replay shows big-evening
    misses on days when the afternoon is cheaper than the evening (this week it was not).

## Step 7 — let the owner say it ahead

7.1 "Extra hot water" one-offs counted in showers (Shower, Bath, Guests), planned into the cheapest
    hours before; Flow card "Plan extra hot water: [kind] by [time]" and a tile picker, no widget.
    No product does this ahead of time; the perfect-demand gap in Kepplinger et al. 2024 (~28 %) is
    what the information can be worth. To define: Guests vs the "free" day type; a one-off entered
    too late to be cheap (heats now, with its own reason line); its starts count under Step 2.
    Mock first.
7.2 No warn-and-ask: notifications cannot carry buttons, an unanswered question needs a safe
    default, and it would fire on exactly the days the forecast already misses.

## Order

1 (from the 28 days already logged) → 2 (protects every later step) → 3 (cheap) → 4 (measure first)
→ 5.0 and 5.1 (setup questions and per-weekday evenings: data exists now, likely the largest
forecast gain) → 5.2 when its state counts reach about 6 days each → 5.3 when 1.1 has enough
15-minute history. 6 only on evidence. 7 alongside, after the mock.

## Sources

Buechler, Goldin, Rajagopal 2024, arXiv 2408.02868 · Biagioni et al. 2021, arXiv 2111.04689 ·
Kepplinger, Huber, Preißinger 2024, Frontiers in Energy Research, doi 10.3389/fenrg.2024.1363378 ·
Purdue HPWH field study 2025, arXiv 2510.12955 · LBNL-4830E · energy-stats.uk, 700 heat pump hot
water runs · Mixergy support · NIBE S1155 manual · Boverket BBR 6:62.
