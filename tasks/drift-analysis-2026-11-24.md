# Indoor drift 21–24 Nov: analysis

Question: why did the heating device's indoor reading fall from 22.0–22.4 °C (Wed–Fri 18–20 Nov) to
21.6–21.9 °C (Sat–Tue 21–24 Nov) against a 22.5 °C setpoint, and why didn't Autopilot pull it back?

## Data
All measured; nothing assumed.
- **Autopilot 15-min history:** read over the LAN from the app's userdata (`dev/read-autopilot-history.mjs`),
  30 Oct → 24 Nov 08:00. Fields: ti, te, wind, cloud, GHI, supply, compressor Hz, electric power, the heating heat
  meter (qheat_kwh), hot water share, BT1 fed.
- **Insights, 14 days hourly:** the heating device, and all 25 room and outdoor sensors (tado valves, frient smoke
  alarms, Netatmo, Airthings).
- **Change timeline:** git, 34 run logs, tasks/todo.md, kept at
  `scratchpad/timeline.md`. Setpoint 22.5, curve 5, offset 6 and room control off throughout. No pump-side
  change to a heating register in any log.

## Daily view (history)
| day | indoor | outdoor | wind m/s | push K | heat kWh | hot water share |
|---|---|---|---|---|---|---|
| Wed 18 | 22.38 | 0.73 | 3.8 | 4.0 | 122.3 | 0.03 |
| Thu 19 | 22.03 | 0.06 | 3.3 | 3.5 | 121.8 | 0.07 |
| Fri 20 | 22.04 | 0.47 | 3.7 | 4.2 | 118.5 | 0.08 |
| Sat 21 | 21.83 | 0.70 | 6.9 | 9.4 | 126.6 | 0.11 |
| Sun 22 | 21.90 | 0.77 | 8.3 | 7.6 | 117.5 | 0.20 |
| Mon 23 | 21.68 | 1.17 | 6.9 | 3.3 | 120.7 | 0.05 |
| Tue 24 (to 08) | 21.57 | 0.29 | 4.5 | 4.0 | 111.1* | 0.20 |

*Tuesday is a partial day scaled to 24 h.

## Hypotheses and verdicts
1. **The Getting started hold cut heat** (my first answer). *Rejected.*
   - Monday got the same heat as Wed–Fri (120.7 vs 118.5–122.3 kWh), and the same daily mean push (3.3 vs 3.5–4.2).
   - The house was colder on the weekend's doubled push too.
2. **The indoor reading changed source or froze** (gateway and sensor-read changes 20 Nov 12:34 and 13:17).
   *Rejected.*
   - The reading is the average of the four frient smoke alarms in the halls (basement, ground, upper, attic).
     That set reproduces it to 0.018 K RMS before the change and 0.043 K after; no other set comes close.
   - The value changes as often per day after 20 Nov as before.
3. **Hot water took compressor time.** *Not the cause.*
   - Hot water share rose on Sun (0.20) and Tue (0.20), but Monday was 0.05 and still cold.
   - The heat meter counts heating only, and it held up.
4. **The house lost more heat: wind.** *Supported.*
   - Wind rose from about 3 to 5.7 m/s at 21:00 on Fri 20 Nov and stayed at 6–9.5 m/s until Tue morning.
   - From that night the pre-heat stopped warming the reading. Indoor was flat at 21.8–21.9 with a push of
     11.6–11.8 K and 5.8–6.6 kW delivered. The night before, a push of 10.4 K had lifted it 21.6 → 22.5.
   - The drop is in the exposed upper floors. Attic hall 21.2 → 20.5 and upper hall 21.8 → 21.3 within six hours
     that night, then stayed there. The basement and ground-floor halls did not move (−0.08 / −0.11 K
     Wed–Fri → Sat–Mon).
   - The unheated storage room fell to 10–11 °C on Sun 22, the windiest day (9.5 m/s), at an unchanged outdoor
     temperature.
   - Heat delivered rose on Saturday (126.6 kWh) while indoor fell, so losses went up.
   - Floor by floor, using only the four hall sensors the app averages (bedrooms have night setbacks and are
     left out):

     | day | basement | ground | upper | attic | reading | wind |
     |---|---|---|---|---|---|---|
     | Wed 18 | 21.66 | 24.24 | 22.07 | 21.52 | 22.37 | 3.8 |
     | Thu 19 | 21.45 | 23.79 | 21.67 | 21.15 | 22.02 | 3.3 |
     | Fri 20 | 21.54 | 23.79 | 21.70 | 21.10 | 22.03 | 3.7 |
     | Sat 21 | 21.67 | 23.89 | 21.34 | 20.52 | 21.86 | 6.9 |
     | Sun 22 | 21.63 | 23.92 | 21.32 | 20.72 | 21.90 | 8.3 |
     | Mon 23 | 21.11 | 23.70 | 21.25 | 20.61 | 21.67 | 6.9 |

   - The same pattern holds over all 14 days, not only this weekend. Upstairs (upper and attic halls) minus
     downstairs (basement and ground) correlates with the day's wind at −0.81. That is −0.85 to −1.2 K on calm
     days and −1.5 to −1.85 K on windy ones (13–15 Nov too), about −0.15 K per m/s. Hourly the correlation is
     −0.64, flat from 0 to 6 h of lag.
   - This gap is between floors, so it does not depend on what Autopilot fed: the same heat reaches both. The
     upstairs halls are two of the four sensors, so an upstairs drop of 0.6–0.7 K moves the reading by about
     0.3 K. That is the size of the drop.
   - Monday the basement hall also fell 0.4 K while the ground hall held. The wind does not explain that on its
     own; it may be the lag of a cold weekend upstairs reaching the stairwell.
   - A daily fit of heat against the indoor–outdoor gap with a wind term gives about 4 % more loss at 7.5 m/s
     than at 3.5 m/s. At fixed heat that is worth about 0.8 K at steady state. The daily fit is noisy; the
     hourly timing is the stronger evidence.
5. **Someone opened a window or changed a radiator valve.** *Unlikely.* The upstairs halls stepped down
   together on the night the wind rose, and the same floor gap shows on the windy days a week earlier. The
   bedrooms run night setbacks on their tado valves and are left out of this analysis. The tado setpoint history
   was not fetched.

## Why Autopilot didn't correct it
- **The model has no wind term.** Neither the planner nor the house model sees wind, so a windy spell reads as
  an unexplained loss.
- **The trim is slow by design.** It is a PI trim on the 24 h mean (setpoint.ts): P 2 K per K of error plus
  about 0.7 K per day of integral at a 0.8 K error (house τ 109 h). Each K of push is about 111 W, against
  roughly 250–300 W of extra loss here. It takes days to close a wind-driven gap.
- **Price pushes move heat in time; they add little.** The weekend's push went from 4 to 9.4 K but heat
  delivered rose only about 6 %. The planner piled it into night pre-heats, at a lower COP: 2.9 / 2.5 against
  3.2–3.5.

## Open
- The tado setpoint history (valves) for 18–24 Nov, to close hypothesis 5.
- Monday's basement drop (hypothesis 4) is not explained.
- A wind term in the house model (the history already has wind per slot) would let the planner and the trim
  anticipate a windy spell instead of chasing it.

## Step 0: back-test with the app's own house model (24 Nov)
`dev/backtest-drift.mjs` fits the house model on the history up to a cut-off, exactly as the app does (thermal
mass included, no wind). It then runs the model open-loop on the heat the pump actually delivered and the real
outdoor temperature. "Residual" is measured minus predicted, daily mean of the reading.

| day | wind m/s | residual (fit to 16 Nov) | residual (fit to 20 Nov 21:00) |
|---|---|---|---|
| Mon 16 | 3.0 | +0.02 | |
| Tue 17 | 3.7 | −0.07 | |
| Wed 18 | 3.8 | +0.08 | |
| Thu 19 | 3.3 | −0.45 | |
| Fri 20 | 3.7 | −0.46 | |
| Sat 21 | 6.9 | −1.09 | −0.45 |
| Sun 22 | 8.3 | −1.09 | −0.50 |
| Mon 23 | 6.9 | −1.29 | −0.72 |
| Tue 24 | 4.3 | −1.35 | −0.79 |

The fit cut at 18 Nov 00:00 is unstable (it predicts a run-away to 24.8 °C) and is left out.

- **Not thermal-mass lag.** The model carries the house's mass, and fed the heat actually delivered it predicts
  the house holding at 22.3–23.0 °C, not cooling. The house lost more heat than the model allows.
- **The gap opens in two steps.**
  - About −0.45 K from Thu 19 Nov, on calm days (3.3–3.7 m/s), the first full days after outdoor fell from 3–5 °C
    to about 0 °C.
  - A further −0.6 K from Sat 21 Nov, when the wind rose to 7–8 m/s.
- **Two candidates for the losses.**
  - Losses that rise faster than linearly as it gets colder, for example air leakage growing with the
    indoor–outdoor gap. The model learned its heat loss on milder days.
  - Wind.
- **The fit's own heat loss moves with what it is fitted on.** It is 238 W/K to 16 Nov, 212 to 18 Nov and 245 to
  20 Nov 21:00.

## Refit: wind against a cold-dependent loss (24 Nov)
`dev/backtest-drift-terms.mjs` adds terms to the fitted heat loss, centred on the training period's means:
- wind: kw × (wind − mean);
- cold: kc × (indoor–outdoor gap − mean).

The coefficients are fitted on the 6 h windows before the cut-off only. They are then tested out of sample:
open-loop from the cut-off on the heat actually delivered.

**Cut at 16 Nov** (the training data includes the windy 13–15 Nov). Fitted kw = 9 W/K per m/s; kc came out
negative, the wrong sign. Out-of-sample gap, measured minus predicted, K:

| day | wind | none | wind | cold | both |
|---|---|---|---|---|---|
| Thu 19 | 3.3 | −0.45 | −0.31 | −1.11 | −0.83 |
| Fri 20 | 3.7 | −0.46 | −0.39 | −1.45 | −1.14 |
| Sat 21 | 6.9 | −1.09 | −0.61 | −2.35 | −1.58 |
| Sun 22 | 8.3 | −1.09 | −0.05 | −2.61 | −1.17 |
| Mon 23 | 6.9 | −1.29 | +0.19 | −3.05 | −1.02 |
| Tue 24 | 4.3 | −1.35 | +0.20 | −3.26 | −1.04 |

**Cut at 19 Nov.** Fitted kw = 3 W/K per m/s. The base fit is poor: its open loop drifts −0.7 to −2.8 K
whatever the terms. The wind term still narrows the gap by 0.4–0.8 K from Saturday.

- **Wind is supported.** Fitted on earlier days and tested on unseen ones, it closes the weekend and Monday
  gap.
- **A cold-dependent loss is rejected.** Its fitted sign is wrong and it widens the gap.
- **About −0.3 to −0.4 K on calm Thu–Fri is still unexplained.**
- **The size is uncertain.** 9 W/K per m/s (cut 16) against 3 (cut 19). The 6 h error barely improves
  (0.256 → 0.250), so short windows hardly identify it; the multi-day open loop does. At 9 W/K per m/s, 7.5 m/s
  against 3.3 adds about 0.8 kW of loss at a 21 K gap.
- **A separate finding: the base fit is unstable.** Its heat loss is 238 / 212 / 216 W/K for cuts at
  16 / 18 / 19 Nov. The open-loop predictions from the 18 and 19 Nov fits run 2–3 K too warm within days. The
  planner relies on this fit; the trim hides the level error.
