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
  above the other weekdays (10.5). Only the owner knows such a week is coming, so the day type
  is theirs to set (§4.1).
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

**Standing loss against timing.** The table above models loss as a constant 0.1 kWh/h, so it
never charges for holding heat. Re-run with loss tied to stored heat (0.05 kWh/h near empty,
0.10 full, the measured value): the optimum costs 12.74 kr/day instead of 12.59, about 5 kr a
month. Loss is about 1.9 kWh heat a day either way, and most of it is unavoidable because the
tank has to stay warm. Per charge: charging at 03:00 (1.95 kr/kWh) for an 18:00 peak instead of
at 17:00 (3.30) holds a full tank 14 h longer, which loses about 0.7 kWh heat, 0.25 kWh
electricity, 0.6 kr, against 5.9 kr saved on the 4.4 kWh charge. Holding wins whenever the price
gap is above about 6 % of the price, so the planner needs loss in the model (§4.2) but loss
rarely changes the answer. The empty-tank loss is assumed; the learner measures it.

Alarm 382 on charges to about 60 °C is being taken up with Nibe as a probable setting fault, so
hotter charges are not ruled out. They stay behind a setting until that is settled (§4.3).

## 4. The feature

Autopilot hot water learns when the household uses hot water, then decides **when** to charge, so the tank is full before each usual peak and is charged in the cheapest or sunniest
hours. It is generic: everything below is learned per installation, nothing is tuned to the
S1155.

### 4.1 Learner

- **Stored heat**, kWh, every poll: from the litres estimate (`lib/hotwater.ts`) when the owner
  has picked a tank size, otherwise from BT6/BT7 and a tank size learned from full charges.
- **Draw per 15 min:** the tank balance in §2.2. Standing loss is learned from draw-free nights
  (stored heat falling slowly with no charge running), as a function of tank temperature.
- **Charge model (revised 2026-11-14):** what the tank itself gains per hour of charging, as a
  falling line in the heat already stored, plus the compressor's electricity while it runs. The
  heat counter (1575) only times the charge: it books about 6 kWh an hour whatever the tank takes,
  so from 1575 a charge looked twice as fast as it is and its unstored heat was booked as water
  drawn (`docs/hot-water-heat-accounting.md`). On the S1155: 6.5 kWh/h up to half full, 3.3 at
  9 kWh stored, 1.9 near full; 2.3 kW; tank COP about 2.
- **Day type comes from the owner, through a Flow or by hand.** The **main device** (it serves every
  function, as ventilation does since 1.4.7) gets one picker, *Day type*: working, free or away.
  It is household state, so heating Autopilot reads the same value: its away mode (plan §19.2)
  is this "away", not a second switch. A Flow card sets it ("Set day type to …"), so a
  calendar, a Homey variable or a presence Flow can drive it; the owner can also set it on the
  device. It holds until changed. Each slot is learned under the type set at the time, and the
  planner assumes the current type until it changes. There is always a day type (maintainer,
  2026-11-13). **Where none was set, the calendar decides (2026-11-14):** Saturday and Sunday
  are free, other days working (`calendarDayType()`); that covers every day before the first
  change, every day of a home that never sets one, and the days after Away ends in such a home
  (an `auto` log entry hands back to the calendar instead of logging working). The planner takes
  each slot's own type, so a Friday plan sees Saturday's profile. Main's picker shows the type in
  force and is checked each hour. The hot water setup step says today's type and where it comes
  from. Measured on the maintainer's tank over 31 days: weekends 25.9 kWh of hot water heat a
  day against 12.7 on weekdays, and a weekend's heat goes in 06–12 (48 %), almost none 18–24
  (4 %; weekdays 23 %). Before, every unset day was working, so a Saturday was planned with
  weekday evening showers. Public holidays are not in the calendar yet (they differ by country).
- **Away:** while the type is away, no draws are planned for and the tank coasts to the reserve.
- **Away is a trip, not a kind of day** (maintainer, 2026-11-13). The heating Away switch, its Flow
  card and the day type "away" are one state (`setAway()` in `lib/autopilot/day-type.ts`). A
  *Set day type* Flow card run while away (a nightly "working day" Flow) does not end it: it only
  sets `base`, the type the home goes back to when Away is turned off. The Main picker is a
  deliberate act and does end it. Away does not touch the pump's own hot water demand mode, so the
  pump still keeps its own start temperature; Autopilot only stops adding charges.
- **Seasonal drift:** recent days weigh more (half-life about 3 weeks), which tracks colder inlet
  water in winter.
- **Starting point:** with less than 14 days of history, setup asks a few questions (§4.6) and
  the learner starts from them; learned values replace the answers as days accumulate.
- **Starts with history where it exists:** on first start the learner reads the app's own Homey
  Insights through `homey-api` (`homey:manager:api` is approved): hourly for 14 days and 6-hourly
  for up to a year for litres, BT6, BT7 and the hot water meters. A household that has had the
  app a while gets a usable profile on day one. After that it learns from the 15-min history.

### 4.2 Planner

Every 15 min, and whenever prices or the forecast change, a dynamic programme over the known
prices (to midnight, or the next midnight after about 13:00):

- **State:** stored heat. **Action per slot:** no charge, or a charge to a target temperature,
  in 1 K steps between the floor and the ceiling below. The temperature is an output of the
  plan, not a setting: the planner weighs one hot charge against two cooler ones, using the
  learned draws until the next cheap or sunny slot, the tank's capacity at each temperature,
  COP and standing loss against temperature, and the prices.
- **Bounds, all derived, none asked:**
  - *Floor:* the lowest stop that still gives 40 °C water at the top after a charge, about 45 °C.
  - *Ceiling:* the lowest of the register's range for 62, and the highest stop the compressor
    reaches on its own, learned per pump (§4.8). The plan's target stays a degree under it: 57 °C
    until anything is learned. Above it every kWh is immersion, COP 1.
- **Planned draws** (`plannedHours()`): the learned hours give the shape, the day totals the
  amount. A day is planned at the mean day plus half the way to the 80th-percentile day. The
  hours alone over-forecast twice over: each hour's draw is clipped at 0, so reading noise only
  adds (hours summing to 21.8 kWh against a 13.9 kWh mean day, 2026-11-13), and summing each
  hour's busy figure plans a day busy in every hour at once. Read hour by hour the plan was
  32.5 kWh a day; it is now 17.6. On the test run's log, the if-nothing-charges error 3 h ahead
  fell from 84 to 44 L RMS, and the planned target for an unchanged start stopped jumping
  (moves of 3 K or more: 11 → 1).
- **Cost per kWh of electricity:** the all-in import price, or the export price in a slot with
  surplus (§4.4). COP falls with tank temperature, from the charge model.
- **Constraint:** no planned draw takes stored heat below the owner's "always keep at least"
  reserve (default 40 L V40, about one shower; 0 = off). Only draws count against it: standing
  loss below it is not worth a charge at any price, and the rescue covers a tank that is really
  under it.
- **Result:** the next charge slot and its target temperature. A new plan replaces the old one;
  only the next action is ever taken.
- **Rescue:** if stored heat drops below the reserve anyway, charge now at any price. This
  replaces the owner's rescue branch. **A tank top at or above 45 °C vetoes it:** after a big
  draw the estimate keeps falling for hours with no water drawn (measured 2026-11-08 after a
  bath: 71 → 52 L in 3 h while the top went 52 → 49 °C), and the rescue would buy a peak-price
  charge for a reading.
- **Why the reserve is on by default:** owners want the hot water guaranteed more than the last
  few öre. The pump's own start temperature is no safety net to lean on: in demand mode Small
  with start 5 °C, as on the S1155 here, it never starts a charge on its own (the tank sat at
  52 L with BT6 at 14 °C for 3 h after the bath).

### 4.3 Knobs: what Autopilot changes on the pump

**Rule: as few writes to the pump's permanent memory (EEPROM) as possible.** Temperatures are set
once; Autopilot works inside them.

**How much EEPROM wear is acceptable.** Nibe publishes nothing. The only figure found is second
hand: a Nibe reply quoted on energiesparhaus.at, 1 million writes per position, which that thread
turns into a budget of 182 writes a day per setting over 15 years. At this design's limit (697 at
most 3 a day, 62 at most 3) that is about 1,100 writes a year per register: centuries at 1
million, about 90 years even at 100,000. Whether the controller levels wear is unknown. What does
wear a pump out is a write every poll or every second (11.5 days at 1 million), which is why
Autopilot never writes on a timer, only per planned charge.

**Lever (maintainer, 2026-11-08): "More hot water" plus the Large stop.** 697 always heats to the
Large stop temperature (62). So a charge is: write 62 to the planned temperature if it differs
from what is there, then 697 = 2. The pump stops at 62 by itself, so a charge never has to be
stopped (which the pump will not do: 697 = 0 does not end a charge in progress, `registers.ts`
at 195).

| Knob | How | Used for |
|---|---|---|
| **When** | 697 = 2 | a planned slot, surplus, rescue; only when BT7 < the planned temperature − 3 K; at most 3 a day |
| **How hot** | 62 before the charge, only when it changes | the target temperature the plan chose for that charge (§4.2) |
| **Advice only** | periodic hot water 65/66/92 | "Your weekly boost runs at 03:00; the cheapest slot this week is Sunday 02:15"; never written |

- **Writes:** one or two per charge, at most 6 a day. 62 is left at its last value, not restored:
  only boosts use it, and a hotter or cooler tank afterwards is harmless if the app stops.
- **Owners in demand mode Large:** 62 is also their own stop temperature, so changing it would
  change every normal charge. For them Autopilot chooses *when* only and never writes 62.
- **Pumps that start charges themselves** (Medium or Large with a normal start): Autopilot
  advances charges but does not defer them, which would need start-temperature writes. Setup
  says so and offers the owner's own setup (Small with a low start) as a one-time change.
- **Considered: the three demand modes as presets** (switch 56 to Medium or Large to charge,
  Small to hold). It would also defer charges on every pump, but it rewrites all six of the
  owner's start and stop temperatures and changes how the pump behaves without the app. Kept in
  reserve if deferring turns out to matter.
- **Example, this house** (tank about 176 L, so about 235 L of 40 °C water at 50 °C and 290 L at
  60 °C). After standing loss, a working day draws about 240 L and a free day about 450 L. So a
  working day *can* run on one charge to about 58 °C at night, at a lower COP and more loss
  through the day; or on two: a night charge only as hot as the morning needs and a midday one
  sized for the evening. A free day always takes two or three. Which is cheaper depends on that
  day's prices and sun, which is why the temperature is planned, not set.
- **Rejected: stopping a charge by toggling 195 (allow hot water) off and on.** It is the only
  way seen to end a running charge (`registers.ts` at 195), but it is two more likely-EEPROM
  writes, and if the app dies between them the house has no hot water at all. Setting 62
  before the charge makes stopping unnecessary.
- **Never touched:** 195 (allow hot water), the legionella settings, SPA hot water, Smart control
  (56 = 4). SPA and Autopilot are exclusive per pump ([autopilot-plan.md](autopilot-plan.md) §0.5), so
  Autopilot hot water runs only with SPA off.

### 4.4 Solar surplus

**Built (slice 4).** Surplus is measured at the grid meter, so a home battery and the house's own
use come first and the tank only gets what would have been sold:

- **Live:** Homey Energy's live report, once a minute. Surplus is the grid export and nothing
  else; what the inverter makes is not looked at (maintainer, 2026-11-14: a battery, the house or
  a car can take all of it, and then there is no surplus, as on 14 Nov with 3.4 kW of sun all going
  into the battery). The grid meter is the one device every owner with surplus has, so nothing
  else is read. Live export counts only in an hour the forecast has sun (≥ 50 W/m², the weather
  already fetched for the plan): at night it is a battery selling. Whether the home has panels
  is the owner's answer in setup (below). Before they have answered, live export counts only once
  the planned fit exists, which stands in as the proof. Known limit: by day, a battery
  that sells, or covers our charge to hold its own grid target, still shows as export and is taken
  for surplus (14 Nov 10:14: 1.3 kW exported, 1.0 kW of it the battery's). The mean of the last 10 minutes (8 readings at least) is the expected surplus
  for the next half hour. Hot water's own draw is added back to each reading (surplus =
  max(0, own draw − grid W)), or a charge started on surplus would read as having used it up; it
  never adds more than the charge draws, so a house importing more than that sees none.
  **Live only (2026-11-14):** unless the owner turned the forecast on, nothing past the live
  reading is planned. The reading is held for up to 2 h while the forecast sun keeps up, scaled
  down where it has less sun than now and never up (`heldLive`), so a charge started on it is
  priced on it. The plan stays a price plan and solar can only replace a grid charge: the
  maintainer, 2026-11-14, "the only thing we can rely on is real-time availability", since a
  battery or a car charger takes the sun first and neither is known ahead. No start/stop gap was
  needed: a charge, once started, runs to its stop on the pump, so a dip in export cannot stop it.
- **Planned:** every 3 h, the grid meter's export history (Insights: hourly for 14 days, 6-hourly
  back to about three months) is fitted by weighted least squares against Open-Meteo's sun on the
  ground for the same hours (`shortwave_radiation`, `past_days=92`). An hourly bucket counts when
  it had at least 50 W/m²; a coarser one only when every hour in it did, so night export (a battery
  selling) never enters. At least 20 sunny hours are needed. Older hours weigh less, halving every
  30 days, because winter sun lands on tilted panels differently from summer sun. The fit, export
  = a × sun + b, turns the next two days' forecast into expected export per slot. No panel size,
  orientation or inverter model is asked. Looking back three months (changed 2026-11-14, was 14
  days) means a meter that has been in Homey since late summer has its fit on the setup screen,
  even in a grey November.
- **Setup (2026-11-14):** after the hot water questions, a Solar step scans the home: grid meters
  (as below) and devices Homey Energy counts as generators, each with its live power, plus the fit
  from the meter's history ("In recent weeks you sent up to 2.4 kW to the grid on sunny hours").
  Then two switches: "Charge when you're selling solar" (live, on by default) and "Plan around
  tomorrow's sun" (the forecast, off by default; its hint says to leave it off with a battery or
  car charger). Without a grid meter it says what to add, shows no switches and saves nothing.
  The answer is home-wide (app setting `autopilotSolar` = `{live, forecast, meter?}`, the meter
  chosen when there are several) and replaces the old per-pump "Use solar surplus" setting; an
  owner who had turned that off is carried over as both off, and the earlier yes/no answer
  (`{panels}`) reads as live = panels with the forecast off. The generators are only shown, never
  read for surplus.
- **Forecast check:** with the forecast on, each relearn (3 h) compares the last 7 days' sunny
  hours: export the fit expected against what the meter recorded. Under half arrived → the
  forecast pauses, live keeps counting, and the widget shows "Solar plan paused"
  (`forecastHeld`; nothing to judge under 2 kWh expected). It resumes by itself when a week holds.
- **Which meter:** the one the owner picked in setup; otherwise, of the devices that declare
  themselves cumulative with an export meter, the one whose power is nearest the live report's
  grid figure. A P1 dongle and a battery's own grid
  sensor can both measure the same connection, and adding them would count each kWh twice.
  Without a grid meter there is no surplus at all; a home without panels learns no fit (export
  does not follow the sun), so it never sees surplus, live or planned.
- **Price:** an exported kWh is priced at the slot's spot price, what selling it would earn, near
  enough.
- **On the maintainer's Homey, 9 Nov:** 79 sunny hours in two weeks, a = 3.7 kW per 1000 W/m²,
  b = −0.16 kW, R² 0.11. November export is small and noisy, so the forecast only shades the plan.
  Only 3 of the 79 hours exported more than the inverter produced, so a battery selling by day
  barely touches the fit. Capping each hour at the generator's output was tried and changed
  a by 2 %, so it was left out. 32 kWh went out in sunless hours (the battery), which the
  50 W/m² floor keeps out.
- **Same Homey, 14 Nov, three months back:** 226 sunny hours (64 hourly, the rest 6-hourly from
  August on), a = 1.6 kW per 1000 W/m², b = +0.21 kW. Graded one day ahead over the last 7 days
  (21 sunny hours, 1.6 kWh actually exported): the 14-day hourly fit errs by 0.67 kWh an hour, the
  three-month fit by 0.43, and predicting no export at all by 0.12. The battery now takes nearly
  all the sun, so export has stopped following it, and every fit overpredicts 6–7×. Neither a
  shorter half-life (3–30 days) nor scaling the forecast by the last 3 or 7 days' realised share
  fixed it. Resolved by making the forecast opt-in and self-checking (above): live is the default.

The design as first written:

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

- **Hot water device:** "Autopilot": the next planned charge, its target and why ("Next
  charge 13:15 to 52 °C · Cheapest hours"), what is heating the tank now, or what it waits for
  (learning, prices). Prefixed "Simulation:" in a simulation. The Smart mode is the on/off.
  **Naming (2026-11-14):** the Smart mode the code calls `test` is shown to owners as
  **Simulation** (it was "Test run"); older entries below keep the name they had then.
- **Settings (moved 2026-11-14):** none in the device settings. Repair → Smart mode, hot water
  step: "Always enough for a shower" (was "Always keep at least"; Up to your device / 20 / 40 / 60 L, default 40; stored on the Hot water device,
  `autopilotReserve`, carried over from the old setting that was shown and mirrored on every
  device of the pump). Solar is two home-wide switches in the next step (§4.4). The tank is picked
  in Repair's Hot water section; the incoming water it learns is a capability on the Hot water
  device, "Incoming water" (`measure_temperature.hotwater_inlet`, blank until learned), no longer
  a read-only setting.
- **Morning plan** (timeline, 07:00, six languages): what goes into the day's plan and what
  comes out of it. The inputs are the day type, the expected use in litres (the learned mean,
  and the 80th percentile as "a heavy day"), the tank now and the safety net. The output is
  each charge starting in the next 24 h: target, start time, price, and a reason. The reasons
  are "among the cheapest hours" (the day's mean price is given alongside), "in time for the
  use that follows", "N % from solar surplus", "now, to keep the safety net" and "already
  charging". The message ends with the expected cost and how far ahead prices are known.
  A charge is called cheap only when it bought within 2 % of the cheapest run of its length
  between the previous charge and its own end. A charge that had to reach into dearer hours
  to be ready is told as timed for the use instead: when the day does not fit a 60 °C tank,
  the night charge runs across the 06:00 shower. Built in `dailyPlan()` (the facts, pure)
  and `dailyPlanText()` (the wording) in `hotwater-shadow.ts`. In shadow it ends "Test run:
  nothing is changed on the pump". The plan is redone every slot, so the morning message says
  what is planned, not what is promised. It opens with a recap of the charges since the last
  morning, each with its reason and whether the plan had it. The recap is grouped as
  "Yesterday:" and "Last night:" (this date's small hours, an older date if a morning was missed),
  and the plan follows under "Today:". A recap that ran from yesterday morning to this morning
  in one list read as one day.
- **Plan update** (when prices arrive or are revised): the plan is redone at once, and the owner
  is told what the prices changed and why. Each change is one of four kinds: a charge
  resized (by 3 K or more), moved (within 3 h), dropped, or added. Same-time charges are paired
  first, so a charge that only moved cannot take another's partner. The why is concrete:
  - "The charge tomorrow at 03:45 takes over the rest, at 1.62 kr/kWh". Not always cheaper per
    kWh; nearer the use it loses less on the way.
  - "The 14:00 hours now cost 3.90 instead of 2.21" for revised prices.
  - "The tank covers the day without it".
  The comparison is not with the morning plan. By afternoon the tank has drifted from the
  morning's projection, and a first version reported that drift as a change every day ("53 →
  45 °C, it needs less now"). It is with the plan the old prices give from the tank as it is
  now, so every change told is the prices' doing. A charge only added in hours that had no
  price before is no push: tomorrow's prices arrive every afternoon, and the charge message
  and the next morning's recap tell it. The new plan becomes the one later charges are
  compared with ("As planned", "Not in the plan"). Built in `planChanges()` and
  `planUpdateText()`. Today the shadow fetches prices itself and calls this on any new or
  revised slot. With the collector split the fetch moves to the home service, and this
  becomes the hot water side of its "prices changed" event; heating needs the same event.
- **Charge message** (when a charge starts): a short `reason` from the same vocabulary as the
  morning plan (Cheapest hours, In time for use, Tank full until then, Less heat lost in the
  tank, Solar surplus, Safety net, Started by the pump), and a `detailedReason` with the
  numbers. A charge that is not the cheapest of its window says why it is not earlier
  (`chargesOf`, since 2026-11-15): no hour before its start is cheaper, so it reaches into
  dearer hours for a use ("In time for use"); cheaper hours before it found the tank too full
  for a 4 kWh charge under the highest target ("Tank full until then"); or the tank had room then and the
  plan judged the heat would stand too long ("Less heat lost in the tank"). Before, the last
  two read "In time for use", which on 2026-11-15 explained a 10:45 charge after a cheap
  night when the tank was simply still full from the evening before. Those numbers are the target, the run
  length, the price against the day's mean, the tank and the safety net for a rescue, and the
  stop for a pump charge. It ends with how the charge compares with the morning plan:
  - "As planned": a charge in the plan in force within 45 min.
  - "Changed: the plan had it at 14:15": a price-driven start within 3 h of a planned charge.
  - "Not in the plan": anything else.
  A safety-net start and the pump's own charge are never "the plan moved". They come on top of
  the plan, or a pump charge says "the plan had a charge then too". The two texts are the Flow
  trigger's tokens. The timeline hears only what the morning plan did not say: safety-net,
  moved and unplanned Autopilot starts. Charges as planned and the pump's own go to Flows and
  the recap, since two expected messages a day is noise an owner learns to skip. There is no
  "charge finished" message; the recap covers it. Built in `autopilotCharge()`, `pumpCharge()`,
  `againstPlan()`, `chargeText()` and `recapLines()`. In shadow a would-be start is told once per
  planned run ("Test run, would start…"). Every real charge is the pump's, so the recap compares
  the two side by side.
- **Flow cards** (six languages): action "Set day type to working / free / away"; trigger "Autopilot started a hot water charge" with `reason` and `detailedReason` tokens (below), and the same trigger for a charge the pump started itself;
  condition "A hot water charge is planned in the next … hours".
- **Insight:** "Typical use: working day 11 kWh, free day 18 kWh; peaks 06:00 and 18–21".
- **Hot water use widget** (`widgets/hotwater_use`, separate from the Autopilot widget): the use
  Autopilot expects today as the headline, the day type and its typical day under it, and a bar
  chart of litres of 40 °C water per day for the six days before today and today, from the learner's days (`HotwaterModel.recent`, 28 days kept). Each bar is
  coloured by the day type in force that day, exactly as set (working, free or away). The chart
  never guesses a type from the weekday, and neither does the learner. Today's bar is the use Autopilot expects. Dashed lines mark a typical day of
  each type over the four weeks, recency-weighted as in learning. A day with under 22 h of
  knowable draw is a light bar marked "≥": the tank top fell below 40 °C for a while, so the
  draw is a lower bound. Such a day is left out of the typical lines, as it is out of learning.
- Flows that switch "More hot water" fight the planner. Setup lists them (read through
  `homey-api`) and asks the owner to turn them off.

### 4.6 What the app reads and what the owner tells it

Read without asking (S-series). Prices, weather, location, the real outdoor temperature, grid
export, the solar generators and the day type are **shared inputs**, collected once per home for
every controller, and the history is one file per pump ([autopilot-plan.md](autopilot-plan.md)
§2.1). Only the tank's own readings are hot water's.


| Need | Source |
|---|---|
| Tank temperatures BT6, BT7; priority (1028) | Modbus |
| Hot water heat and electricity, COP | the pump's energy log (hot water produced 1575, consumption via the allocator, compressor power 2166); no extra power meter |
| History to start from | the app's own Insights, via `homey-api` |
| Prices | Homey Energy dynamic prices and the owner's cost formula (as heating Autopilot) |
| Grid export (surplus) | Homey Energy's cumulative meter, *if* the owner has one in Homey (P1 dongle, grid sensor) |
| Expected solar | Open-Meteo irradiance (already collected) against the Homey's generator devices, *if* any |
| Location | the Homey |
| Flows that start hot water charges | `homey-api` flow list |

Without dynamic prices the planner still keeps the tank as cool as the profile allows (less
loss, better COP) and uses surplus. Without a grid meter there is no surplus feature, and setup
says what to add. Other model families: which of these registers exist is checked per model,
not yet done for the F-series.

Asked of the owner:

| When | What | Why |
|---|---|---|
| Setup | tank size (the existing tank picker) | litres and stored heat |
| Setup, only with < 14 days of history | people in the household; usual morning shower time on working days; evening or daytime use on free days | starting profile: about 2.5 kWh heat (70 L of 40 °C water) per person a day, free days 1.5×, peaks at the given times |
| Setup | always keep at least (default 40 L, off possible), solar: live and forecast switches | the safety net |
| Whenever it changes | day type working / free / away: Flow action card, or the picker on the main device | which profile applies; heating's away |

### 4.7 Guards

- Charges and heating pre-heats are sequenced by the orchestrator ([autopilot-plan.md](autopilot-plan.md)
  §2.1): hot water plans first, and heating Autopilot plans around its charges. The earlier
  "no charge in the 2 h before a pre-heat" rule is gone.
- Every write goes through the existing write lane, persist-before-write. A restart does not
  end a boost the app started: 697 = 0 does not end a running charge (§4.3), and a charge to a
  planned temperature is harmless if the plan has since changed. What a restart keeps (device
  store `autopilotHotwaterPlan`, `resumePlan()`): the plan in force, the charges since the last
  morning for its recap, and that the morning message went out, so it is not sent twice. With
  no current plan saved, the plan from now becomes the one in force, without a message.
- Pump alarms, a blocked 195, or a register the model lacks turn the feature off with a reason on
  the device. No silent failure.

### 4.8 Keeping the immersion heater out (built 2026-11-15)

On the S1155 the compressor gives up near 58 °C at BT6 (alarm 216 or 382) and the immersion heater
finishes the charge at about a third of the efficiency: the 13 Nov charge to 60 °C ran 85 min on the
compressor, then 37 min on the immersion, about 3 of its 6.5 kWh
([hot-water-heat-accounting.md](hot-water-heat-accounting.md)). Where that happens differs per
pump, brine and season, so it is learned (`lib/autopilot/hotwater-ceiling.ts`, pure).

- **What it learns from.** An *onset*: the immersion heater (1029) came on while hot water was
  charging (the allocator gives hot water power), with BT6 at or above 50 °C. A *clean end*: a
  charge that ended on the compressor alone, at the hottest BT6 it reached. From two sources:
  - every poll (`watchCharge`, on the Hot water device, which polls 1029 from Main while Autopilot
    runs). Onsets and clean ends land in the device store `autopilotHotwaterCeiling`.
  - each relearn from Insights (`ceilingFromHistory`): hourly buckets or finer; a run of charging
    hours with immersion hours for hot water (1069) rising is an onset at the hottest bucket while
    it ran, a run without is a clean end at its hottest bucket. Bucket means put an onset a little
    high and a clean end a little low, so history moves the ceiling less than a poll does. The Hot
    water device carries 1069 and BT6 while Autopilot runs, so their Insights exist.
- **The ceiling** (`learnCeiling`): 58 °C, or the highest clean end of the last 60 days if higher,
  lowered to the lowest onset of the last 60 days that no later clean end got above (a warmer brine
  in spring lifts it again). Never under 50 or over 60. An immersion heater seen under 50 °C is
  heating's, or a cold tank on a degree-minute deficit, and teaches nothing.
- **The target** stays `CEILING_MARGIN_K` = 1 K under it, in whole degrees (`targetCap`): 57 °C by
  default, where the cap was 58 before. Every charge the planner makes, and the Large stop (62) it
  writes, stays under that.
- **Two cooler charges over one hot one.** The planner already weighs this (§4.2): the tank fills
  slower the fuller it is, so its last degrees cost far more electricity than a second, cooler
  charge does, start cost included. Tested: at one price all day with 9 kWh of use and 60 °C
  allowed, the plan charges twice to at most 55 °C, and pays less electricity per kWh of heat than
  one charge to 60 °C. When a day needs more than fits under the cap, it charges twice and stays
  under it.
- **When an Autopilot charge starts the immersion heater anyway** (`immersionInCharge`): the onset
  is recorded on the charge event (`immersion`: when, BT6 then, the new cap), counted at most at the
  charge's own target (the compressor did not reach it, so the ceiling goes under it and the next
  charge plans cooler), and said in the charge's detailed reason: "The immersion heater took over
  at 57 °C. Autopilot now charges to at most 56 °C." The Flow trigger fired at the start, so the
  sentence goes to the timeline as a fresh charge message (Autopilot's live charges only), the log
  and the morning recap ("Immersion heater from 57 °C."). The pump's own charges teach the ceiling
  and get the recap line, but no message.
- **The charge is not stopped.** 697 = 0 does not end a running charge, and toggling 195 is
  rejected (§4.3). The heater finishes this one; the next plans under it.
- **Left out: DM-aware add heat** (autopilot-plan.md §12: plan the bias so predicted degree minutes
  never cross `start − 0.7 × 679`). That rule is about heating's bias and lives in heating's
  planner, which this change does not touch. Hot water charges do not move degree minutes
  through a bias, and nothing in the hot water plan predicts DM. What the code can measure (DM in
  register 11, 679, 1029) is collected in the heating history already, so the heating side can
  build it there. Also left out: telling apart an immersion heater that hot water's charge needed
  from one heating's DM deficit started during a charge, beyond the 50 °C floor. 1069 rising
  separates them in history; live, the polls only have 1029.
- **Not verified on hardware.** No real onset has been seen by the poll watcher yet; the first
  charge that trips the heater on the S1155 should log "the immersion heater came on at … °C".

## 5. Build plan

| Slice | What | Writes to the pump |
|---|---|---|
| **1. Learner** (built 2026-11-08, branch `autopilot/hot-water`) | `lib/autopilot/hotwater-learner.ts` (pure): tank balance, standing loss against stored heat, charge model with COP against tank top, profiles for `any`/working/free with the prior filling a young type's shortfall, away. `hotwater-insights.ts`: Insights → readings, finest resolution wins. `dev/learn-hot-water.mjs` runs it on a real device. Tank fields go into the per-pump history with the collector split (plan §2.1). | none |
| **2. Planner** (built 2026-11-08) | `lib/autopilot/hotwater-planner.ts` (pure): DP over 15-min slots, state = stored heat and whether a charge runs (a run cannot be stopped, so each run's end is its target, 45–60 °C); COP and loss from the learner; surplus priced at export; reserved slots honoured; a running charge ends at the Large stop in force; a charge under 4 kWh waits unless the reserve is breached. `dev/evaluate-hot-water.mjs`: back-test, draws not known ahead. | none |
| **3. Shadow** (built 2026-11-08, not installed) | `lib/autopilot/hotwater-shadow.ts`: on the Hot water device while Autopilot hot water is set to Test run (slice 4 replaced the hand-set app setting `autopilotHotwaterShadow`). Learns from the device's own Insights every 6 h, fetches prices itself, plans each 15-min slot from the tank as read and logs the action (rescue / start / running / wait), the next planned charge and the litres it expects 1–12 h ahead if nothing charges (`coast`) to a JSON-lines file in /userdata (named in the app setting `autopilotHotwaterFile.<id>`), with an hourly summary in the app log. At 07:00 it sends the morning plan (§4.5) to the timeline and logs its facts as JSON. Each charge start, Autopilot's would-be or the pump's own, is logged with its reason; the timeline gets the off-plan ones (§4.5). The Flow trigger is slice 4. Standalone: hot water is likely to ship before heating, and the collector split is heating's (autopilot-plan.md, shared inputs). No day type yet: every day plans with the pooled profile. | none |
| **4. Live** (built 2026-11-09, not installed) | **Setting** "Autopilot hot water": Off / Test run / On, with "Always keep at least … L" (default 40) and "Use solar surplus" (on). Pump-wide like the poll interval: set on any of the pump's devices, mirrored to all, and turning it on needs the Hot water device and a picked tank, or the save fails saying which. **Lever** (`hotwater-lever.ts`, pure): when the plan starts a charge, the pump is read first (BT7, 62, 56, 195, 843 and 846). Then 62 is written to the planned temperature if it differs by half a degree or more, then 697 = 2. The charge must leave BT7 at least 3 K under its target. Caps: 3 starts and 3 writes of 62 a day; past the 62 cap a charge runs to the stop already set. In demand mode Large, 62 is never written. Smart price adaption for hot water, Smart control (56 = 4) or hot water off (195) block it, with a warning on the device saying what to change. The charge and the day's write count are stored before the pump is written, so after a restart the charge is still Autopilot's, not reported as the pump's, and the writes still count. A failed write is a device warning. There is no restart reconciliation that ends a boost: 697 = 0 does not end a running charge (§4.3), and a charge to a planned temperature is harmless if the plan has since changed. **Day type** (`day-type.ts`): one app setting for the home (`autopilotDayType`) with every change and its time. The learner files each Insights reading under the type in force then. Main shows it as a picker (`day_type_NIBE`) only while Autopilot is on or in a test run. **Flow cards:** trigger "A hot water charge started" (`reason`, `detailed_reason`, `autopilot`: Autopilot's real starts and the pump's own, never a test run's would-be start); condition "A hot water charge is planned within … h" (a running charge counts); action "Set day type to …" on Main. **Solar surplus** (`hotwater-surplus.ts`): §4.4. **Built 2026-11-13:** the Hot water device's "Autopilot" line (`autopilot_reason_NIBE`, heating's, while hot water's Smart mode runs Autopilot): the next charge, its target and why, from the plan redone each slot (`hotwaterStatusText()`). Repair → Smart mode for hot water lists the enabled Flows that switch More hot water by themselves (`hotwater-flows.ts`; a Flow started by hand is a button and is left out), and with under 14 days of history (`STARTER_DAYS`) asks the household (people, working-day shower, when a day off uses most), stored as `autopilotHotwaterHousehold`: `starterProfiles()` is the learner's prior until each day type has 5 days of its own. The plan in force survives a restart (§4.7). **Planned draws** (`plannedHours()`): the hours give the shape, the day totals the amount; see §4.2. | 697, 62 |
| **5. Docs** | `docs/` and FAQ; README row; analytics rows if events are added. | – |

**Slice 1 on the S1155's Insights (8 Nov, 58 full days):** charge 6.1 kWh heat/h, COP 2.88 at a
48 °C mean top, falling 0.022 per K; standing loss 0.018 kWh/h per kWh stored (0.18 kWh/h full,
above the 0.1 from one 5-min night: the hourly litres estimate loses more than BT7 alone shows);
13.2 kWh drawn a day, p80 18.5, peaks at 06 and 19–20; no away days. No day types yet: the
picker does not exist, so everything is pooled until the owner sets them.

**Slice 2 back-test (26 Oct → 8 Nov, 11 full days, SE3).** All rows but the first run on one
simulated tank with the learned loss and COP; the planner relearns each midnight from readings
before it and sees only the prices known at the time.

| Strategy | kr/day | kr/month | charges/day | mean target | 15-min slots below the 60 L reserve |
|---|---|---|---|---|---|
| Owner's setup, as it ran (real meter) | 17.02 | 511 | – | – | – |
| Owner's Flow, simulated | 17.62 | 529 | 2.9 | 60 °C | 60 |
| Pump alone (start 42, stop 50 °C) | 18.39 | 552 | 5.8 | 50 °C | 2 |
| **Planner, learned profile** (weekends set free) | **16.41** | **492** | 2.1 | 54 °C | 21 |
| Planner, draws known ahead | 16.31 | 489 | 2.4 | 54 °C | 0 |

- **About 7 % below the Flow on the same simulated tank, about 35 kr a month**, with a third of
  the time under the reserve. Less than the 50–70 kr estimated in §3, whose optimum knew every
  price for 13 days ahead; with only the published prices, even knowing the draws gains little
  more (16.31). In November the prices, not the forecast, set the ceiling.
- **Day types barely matter here** (16.41 against 16.52 without): only two weekends of hourly
  shape exist yet. That changes once the owner sets the day type for real.
- **Settled by the back-test:** no margin above the reserve (it kept the tank hot for nothing),
  plan halfway between the mean draw and the 80th percentile, no charge under 4 kWh unless the
  reserve is breached (replanning every slot otherwise made 10 short charges a day, many at
  peak prices), a start cost of 1 kr, and the value function read between levels (rounding
  hid the standing loss and made the plan top up in slivers).
- Summer, with surplus at export price, is not in this window; §2.3's 100–150 kr a month is
  still an estimate.

**Reserve 40 L, draws-only floor (2026-11-08).** Same days, the reserve as the default
"always keep at least" and only draws counted against it:

| Strategy | kr/day | kr/month | slots below the reserve |
|---|---|---|---|
| Owner's Flow, simulated | 17.62 | 529 | 8 (of 40 L) |
| **Planner, learned profile, 40 L** | **15.91** | **477** | 22 |
| Planner, learned profile, 60 L | 16.40 | 492 | 22 |
| Planner, draws known ahead, 40 L | 15.61 | 468 | 0 |

- **About 10 % below the Flow, about 50 kr a month.** The safety net at 60 L costs 15 kr a
  month more than at 40 L.
- The 22 slots under the reserve are about one unforeseen draw a day, rescued within half an
  hour.

Hardware tests, each with the owner's go-ahead:

| Test | What it settles | Writes |
|---|---|---|
| **H0** Watch 1028 at 5-min for a week (runs in shadow) | Whether the pump starts its own charges at start 5 °C | none |
| ~~H1~~ Skipped (maintainer, 2026-11-08): the charge model learns rate and COP from real charges, and the first live charges show whether a written 62 holds | – | – |
| **H3** Autopilot live for 7 days, Flow off | Real kr against the Flow's week, and comfort (no rescue caused by the plan) | 697 |

**Exit for live on the maintainer's Homey:** the back-test beats the Flow by ≥ 10 % over 14 days
with no floor violations, and shadow's predicted litres at the peaks are within ±50 L on ≥ 80 %
of days. Release to anyone else is a separate decision.

The litres check is scored by `node dev/review-hotwater-shadow.mjs <url of the .shadow.jsonl>`.
Since 2026-11-10 each log line has `coast`: the litres it predicts 1 to 12 h ahead if nothing
charges. A test run cannot score the plan's own charges, because the charges that really happen
are the pump's. So a peak counts only when no real charge ran between the prediction and the
peak. The peaks are the hours of the pooled profile that draw at least 70 % of its busiest hour.
Each peak window is scored at its end, from the prediction made 3 h before (`--lead`).
