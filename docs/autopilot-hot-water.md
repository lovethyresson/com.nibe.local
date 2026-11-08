# Autopilot hot water

Status: design, 2026-11-08. The maintainer asked for it to be built now (2026-11-08), ahead of
heating Autopilot. It extends M4 ([autopilot-plan.md](autopilot-plan.md) §12, §19.3–19.4).
§1–§3 are the measurements, §4 is the feature, §5 is the build plan.

## 1. What the S1155 does today

**Settings (read 2026-11-08):** demand mode Small (56 = 0) with start 5 °C (60), so the pump
almost never starts a charge itself. Stop temperatures are Small 48, Medium 50 and Large 60 °C.
Periodic hot water is off and SPA hot water (846) is off.

**Charging** comes from the owner's Homey Flow "Hot water (v2)", which turns on "More hot water"
(697), a 2 h charge to the Large stop temperature:

- **Top-up:** runs on every price change while BT7 is below 52 °C.
  - Working day: the cheapest hour of 21–06, or one of the 3 cheapest hours of the day.
  - Free day: the cheapest hour of 22–06, or any day hour except the 3 most expensive.
- **Rescue:** when the litres estimate drops below 50 L, it charges at once if guests are home,
  and otherwise notifies the owners, who often start a manual charge.

Home Assistant and Homey users do the same thing: they charge in the N cheapest hours, using a
cheapest-hours sensor, a blueprint or SPA. Nibe's own demand mode "Smart control" (56 = 4)
learns past use but knows nothing of prices or solar. Nobody we found combines a learned draw
pattern with prices and surplus. That is the gap.

## 2. Measured

### 2.1 The tank (Insights, 25 Oct → 8 Nov, hourly; 5-min for the last 24 h)

| Quantity | Value | How |
|---|---|---|
| Hot water electricity | **6.3 kWh/day** | Hot water device `meter_power.total` (allocator) |
| Hot water heat | 17.8 kWh/day, **COP 2.82** | 1575 produced (30-day rolling COP shown is 2.74) |
| Charges | 1.7/day, median **4.4 kWh el**, maximum 5.6 | Runs of hours above 0.15 kWh |
| Charge rate | about 1.9 kWh el / 5.5 kWh heat per full hour | 36 full charging hours |
| Usable tank | about 290 L V40 at full, about 10 kWh heat | Litres estimate 0 → 288 L; 1 L V40 ≈ 0.035 kWh |
| Standing loss | BT7 **−0.6 K/h** idle (57.8 → 49.3 °C over 14 h), about 0.1 kWh heat/h, **about 2.4 kWh/day** | 5-min night with no draws |
| Immersion on hot water | 0.2 h in 14 days | 1069 |

**41 % of hot water electricity falls in 16–20, the most expensive hours of the day, and almost
none in 01–04, the cheapest.** The tank empties at the evening showers, BT7 drops below 52 °C,
and the next acceptable hour, or a person reacting to the rescue notification, refills it in
the evening. The Flow charges *after* the peak demand. The cheap move is to charge *before* it.

10 of 24 charges had no 697 boost within 2 h. Either the pump starts some charges itself despite
start 5 °C, or the allocator counts some heating as hot water. H0 (§5) settles it.

### 2.2 Working days and free days (Insights, 10 Aug → 8 Nov, 89 days)

Daily heat from the hot water produced meter (1575, 6-hour Insights):

| Day | Days | Mean kWh heat | Median |
|---|---|---|---|
| Mon | 13 | 8.9 | 7.3 |
| Tue | 13 | 12.2 | 11.7 |
| Wed | 13 | 9.6 | 7.4 |
| Thu | 13 | 11.1 | 10.3 |
| Fri | 12 | 12.5 | 12.4 |
| **Sat** | 13 | **19.1** | 19.8 |
| **Sun** | 12 | **16.8** | 15.1 |

- **Free days use 1.7× a working day:** 18.0 against 10.8 kWh heat. Saturday is the largest day,
  Monday the smallest.
- **The school autumn break (26–30 Oct) sat in between:** its weekdays averaged 14.4 kWh, 37 %
  above the other weekdays (10.5). A calendar that knows only weekends and public holidays
  would get such weeks wrong; a learner that scores each day after the fact would not.
- **Day-to-day noise is large:** the standard deviation is 4–8 kWh on every weekday. Planning
  for the mean would run short on one day in two, so the floor uses a high quantile (§4.2).
- **Use rises into winter:** 11–13 kWh/day from August to October, 18.5 in the first week of
  November. The inlet water gets colder, so each litre takes more heat. COP fell from about
  3.3 in September to 2.9.
- A few days are near zero (26 Aug, 16 Sep, 21 Sep: under 1.1 kWh). These are days without a
  charge, not necessarily days without use. The meter only moves while the pump charges, so
  daily totals are lumpy. The learner uses the tank balance instead (below).

Hourly draw from the tank balance, draw = fall in stored heat + produced heat − standing loss.
This also counts water drawn during a charge, which the litres estimate alone misses. kWh heat
per hour, 14 days (10 working, 5 free):

```
hour     05  06  07  08  09  10  11  12  13  14  15  16  17  18  19  20  21  22   day
working 0.2 1.6 0.4 0.5 0.2 0.3 1.1 0.1 0.1 0.1 0.3 0.5 0.6 1.6 1.9 1.7 1.4 0.3   13.2
free    0.0 1.0 0.3 0.6 0.9 1.8 2.1 1.7 1.3 2.6 0.4 1.2 3.9 1.2 1.9 2.9 1.0 0.0   24.9
```

A working day has a short morning peak at 06 and a long evening one, 18–21. A free day has no
early peak, draws all day from 09, and peaks again at 17 and 20. Two different shapes, not one
shape scaled: one profile per day type is needed.

### 2.3 Solar (Homey Energy, 2026)

| Month | Generated (SolarEdge) | Exported to the grid |
|---|---|---|
| Apr | 926 kWh | 40 |
| May–Aug | 980–1084 / month | **444–593 / month** |
| Sep | 595 | 364 |
| Oct | 296 | 214 |
| Nov–Feb | under 200 | under 100 |

Export is measured after the home battery has taken its share. Hot water takes 150–190 kWh of
electricity a month, so from May to September the export alone could cover all of it. Every kWh
used at home instead of sold is worth about 1 kr more (§19.3): **roughly 100–150 kr a month from
May to August**, more than price shifting is worth in November. On a sunny day the tank is the
best sink in the house. Storing more of the surplus means heating hotter, which is where the
temperature knob earns its keep.

## 3. What timing is worth (13 full days, 26 Oct → 7 Nov, SE3)

Prices are all-in, `(spot + 0.609) × 1.25`, as in `dev/evaluate-presets.mjs`. The mean was
2.48 kr/kWh. The simulation is an hourly tank: 10 kWh heat usable, a floor of 2.5 kWh (about
70 L), 5.5 kWh heat per hour, COP 2.85, standing loss 0.1 kWh/h, and the measured draw shape
scaled to 17.8 kWh/day. The optimum is a dynamic programme over the 13 days.

| Strategy | kr/day | kr/month | vs actual |
|---|---|---|---|
| Pump alone (reheat at 40 % of the tank) | 17.75 | 533 | +8 % |
| **Actual: owner's Flow** | **16.46** | **494** | – |
| Optimal timing, same temperatures | 13.01 | 390 | **−21 %, −104 kr** |
| Optimal timing, boosts to about 60 °C (COP 2.2 above normal) | 12.31 | 369 | −25 %, −125 kr |
| Optimal timing, floor 4 kWh (about 115 L) | 13.52 | 406 | −18 % |

The Flow paid 2.63 kr/kWh, 6 % above the mean price. The optimum knows every draw in advance,
which no controller will. A planner that learns the draw shape and keeps a margin should reach
**50–70 kr a month in winter, 10–15 % of the hot water cost**, plus the summer surplus (§2.3).

Alarm 382 on charges to about 60 °C is being taken up with Nibe as a probable setting fault, so
hotter charges are not ruled out. They stay behind a setting until that is settled (§4.3).

## 4. The feature

Autopilot hot water learns when the household uses hot water, then decides **when** to charge and
**how hot**, so the tank is full before each usual peak and is charged in the cheapest or sunniest
hours. It is generic: everything below is learned per installation, nothing is tuned to the
S1155.

### 4.1 Learner

- **Stored heat**, kWh, every poll: from the litres estimate (`lib/hotwater.ts`) when the owner
  has picked a tank size, otherwise from BT6/BT7 and a tank size learned from full charges.
- **Draw per 15 min:** the tank balance in §2.2. Standing loss is learned from draw-free nights
  (stored heat falling slowly with no charge running), as a function of tank temperature.
- **Charge model:** heat per hour and COP against the tank temperature, from the hot water
  produced and consumed meters during charges. This prices "how hot" (§4.3).
- **Day types:** a profile per weekday (96 slots, each with a median and an 80th percentile),
  pulled toward one of two pooled profiles, *working* and *free*, while a weekday has few days
  behind it. Public holidays for the Homey's country (the six the app ships in) count as free.
  Each day is also scored after the fact by its own draws, so a week off from school becomes
  "free" without a calendar entry, and the owner can say so ahead (§4.5).
- **Away:** a day with near-zero draw is marked away, kept out of the profiles, and the tank
  coasts until draws resume or the owner ends away.
- **Seasonal drift:** recent days weigh more (half-life about 3 weeks), which tracks colder inlet
  water in winter.
- **Starts with history, not empty:** on first start the learner reads the app's own Homey
  Insights through `homey-api` (`homey:manager:api` is approved): hourly for 14 days and 6-hourly
  for up to a year for litres, BT6, BT7 and the hot water meters. A household that has had the
  app a while gets a usable profile on day one. After that it learns from the 15-min history.

### 4.2 Planner

Every 15 min, and whenever prices or the forecast change, a dynamic programme over the known
prices (to midnight, or the next midnight after about 13:00):

- **State:** stored heat. **Action per slot:** no charge, normal charge, or hot charge (§4.3).
- **Cost per kWh of electricity:** the all-in import price, or the export price in a slot with
  surplus (§4.4). COP falls with tank temperature, from the charge model.
- **Constraint:** stored heat never below a floor. The floor is the coming hours' 80th-percentile
  draw plus a minimum reserve (default 60 L V40), so it rises ahead of each learned peak.
- **Result:** the next charge slot and its target temperature. A new plan replaces the old one;
  only the next action is ever taken.
- **Rescue:** if stored heat drops below the reserve anyway, charge now at any price. This
  replaces the owner's rescue branch.

### 4.3 Knobs: what Autopilot changes on the pump

| Knob | Register | Used for | Limit |
|---|---|---|---|
| **When**: start a charge | 697 "More hot water" | a planned slot, surplus, rescue | only when BT7 < stop − 3 K; at most 3 a day |
| **How hot**: the charge's stop temperature | 62 (Large stop), written before a 697 charge | normal ≈ the owner's own stop; hot (up to 60 °C) for surplus and very cheap hours ahead of a peak | EEPROM: at most 2 writes a day; restored after |
| **Hold off**: keep the pump from starting itself | the active demand mode's start temperature (58/59/60) | pumps in Medium/Large: defer a charge out of an expensive block | EEPROM: at most 2 writes a day; snapshot and restore; at most 3 h |
| **Advice only** | periodic hot water 65/66/92 | "Your weekly boost runs at 03:00; the cheapest slot this week is Sunday 02:15" | never written |

- A hot charge costs COP (2.2 against 2.85 measured), so the planner uses it only when the price
  gap pays for it: surplus, or a very cheap hour before a peak that a normal charge cannot cover.
- **Never touched:** 195 (allow hot water), the legionella settings, SPA hot water. Autopilot hot
  water and SPA hot water (846) are mutually exclusive; turning one on turns the other off.
- **Pumps that start charges themselves** (Medium or Large with a normal start): Autopilot
  advances charges with 697 and defers them by lowering the start temperature. The owner's
  setup (start 5 °C) needs only 697 and 62.

### 4.4 Solar surplus

- **Live:** Homey Energy's cumulative meter (P1 dongle, grid sensor) gives import and export.
  Export above the compressor's hot water draw (learned, about 1.9 kW here) for 10 min, with room
  in the tank, starts a charge. That charge is hot when the surplus is expected to last.
- **Planned:** irradiance from the forecast (already in the history) against the Homey's own
  generator devices gives an expected surplus per slot. The planner prices those slots at the
  export value, so on a sunny day it leaves the tank room for the afternoon instead of buying a
  full charge at night.
- **A home battery** takes surplus before export. Using measured export means the tank only gets
  what the battery would have sold.

### 4.5 What the owner sees and controls

- **Hot water device:** an "Autopilot hot water" on/off, the next planned charge ("13:15, to
  55 °C, 0.84 kr/kWh") and why ("before the evening peak", "solar surplus", "rescue").
- **Settings:** minimum reserve (litres), allow hot charges (on/off, max temperature), solar
  surplus (on/off).
- **Flow cards** (six languages): action "Treat today/tomorrow as a free day / working day /
  away"; trigger "Autopilot started a hot water charge" with reason and temperature tokens;
  condition "A hot water charge is planned in the next … hours".
- **Insight:** "Typical use: working day 11 kWh, free day 18 kWh; peaks 06:00 and 18–21".
- The owner's Flow ("Hot water (v2)") has to be turned off when this is on. Setup says so.

### 4.6 Guards

- No charge in the 2 h before a planned heating pre-heat (when heating Autopilot is on), since a
  charge blocks space heating.
- Every write goes through the existing write lane, persist-before-write, and restart
  reconciliation restores 62/58–60 if the app stopped mid-charge.
- Pump alarms, a blocked 195, or a register the model lacks turn the feature off with a reason on
  the device. No silent failure.

## 5. Build plan

| Slice | What | Writes to the pump |
|---|---|---|
| **1. Learner** | `lib/autopilot/hotwater-learner.ts` (pure): tank balance, standing loss, charge model, day-type profiles, away. Insights bootstrap. Tank fields (BT6, BT7, litres, hot water meters) in the history. Unit tests against the Insights extracts in this doc. | none |
| **2. Planner** | `lib/autopilot/hotwater-planner.ts` (pure): DP, floor, hot/normal action, surplus pricing. `dev/evaluate-hot-water.mjs` back-test on real prices and draws, the draws *not* known ahead. | none |
| **3. Shadow** | Run the planner every slot on the maintainer's Homey and log what it would do; show the next planned charge on the device. | none |
| **4. Live** | 697 and 62 behind the on/off, guards, rescue, reconciliation; surplus live trigger; Flow cards; settings; six-language strings. | 697, 62 (58–60 on Medium/Large pumps) |
| **5. Docs** | `docs/` and FAQ; README row; analytics rows if events are added. | – |

Hardware tests, each with the owner's go-ahead:

| Test | What it settles | Writes |
|---|---|---|
| **H0** Watch 1028 at 5-min for a week (runs in shadow) | Whether the pump starts its own charges at start 5 °C | none |
| **H1** One midday 697 charge to 55 °C from a half-empty tank | Charge rate and COP against tank temperature; that a 62 write takes effect on a running boost | 697, 62 once |
| **H3** Autopilot live for 7 days, Flow off | Real kr against the Flow's week, and comfort (no rescue caused by the plan) | 697, 62 |

**Exit for live on the maintainer's Homey:** the back-test beats the Flow by ≥ 10 % over 14 days
with no floor violations, and shadow's predicted litres at the peaks are within ±50 L on ≥ 80 %
of days. Release to anyone else is a separate decision.
