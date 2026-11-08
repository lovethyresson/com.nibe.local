# Autopilot hot water: exploration (M4)

Status: exploration, 2026-11-08. Nothing here writes a hot water register. This adds measured
numbers and an approach to M4 ([autopilot-plan.md](autopilot-plan.md) §12, §19.3–19.4); the
guard rules in §12 still apply.

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
cheapest-hours sensor, a blueprint or SPA. Nobody we found learns the household's draw pattern
or prices standing loss. That is the gap.

## 2. Measured (Insights, 25 Oct → 8 Nov, hourly; 5-min for the last 24 h)

| Quantity | Value | How |
|---|---|---|
| Hot water electricity | **6.3 kWh/day** | Hot water device `meter_power.total` (allocator) |
| Hot water heat | 17.8 kWh/day, **COP 2.82** | 1575 produced (30-day rolling COP shown is 2.74) |
| Charges | 1.7/day, median **4.4 kWh el**, maximum 5.6 | Runs of hours above 0.15 kWh |
| Charge rate | about 1.9 kWh el / 5.5 kWh heat per full hour | 36 full charging hours |
| Usable tank | about 290 L V40 at full, about 10 kWh heat | Litres estimate 0 → 288 L |
| Standing loss | BT7 **−0.6 K/h** idle (57.8 → 49.3 °C over 14 h), about 0.1 kWh heat/h, **about 2.4 kWh/day** | 5-min night with no draws |
| Immersion on hot water | 0.2 h in 14 days | 1069 |
| Draw pattern | Peak at **06**, then **18–21**; a small midday hump | Litres drops outside charges |

Electricity by hour of day against the mean all-in price:

```
hour  00-05  06-09  10-14  15   16   17   18   19   20   21-23
kWh/d 0.21   0.60   1.50   0.23 0.41 0.57 0.51 0.74 0.75 0.75
kr/kWh 1.95  2.66   2.40   2.86 3.19 3.30 3.26 3.03 2.75 2.29
```

**41 % of hot water electricity falls in 16–20, the most expensive hours of the day, and almost
none in 01–04, the cheapest.** The tank empties at the evening showers, BT7 drops below 52 °C,
and the next acceptable hour, or a person reacting to the rescue notification, refills it in
the evening. The Flow charges *after* the peak demand. The cheap move is to charge *before* it.

Two things in the data are unexplained:

- **10 of 24 charges had no 697 boost within 2 h.** Either the pump starts some charges itself
  despite start 5 °C, or the allocator counts some heating as hot water. Check this before
  trusting the baseline (see H0).
- **Visible draws add up to only 8.2 of 17.8 kWh/day.** Draws during a charge are hidden, and
  the litres estimate saturates near the top. The draw profile's shape is usable; its absolute
  size comes from the produced-heat meter.

## 3. What it is worth (13 full days, 26 Oct → 7 Nov, SE3)

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

The Flow paid 2.63 kr/kWh, 6 % above the mean price. It beats the pump alone by about 40 kr a
month and leaves about 100 kr a month on the table.

The optimum knows every draw in advance, which no controller will. A planner that learns the
draw shape and keeps a margin should reach **50–70 kr a month here, 10–15 % of the hot water
cost**, or about 600–850 kr a year at November prices. Boosts add about 20 kr a month more.
They are not worth it on this pump, where charges to about 60 °C already trigger alarm 382
(memory gp1-cap-inverter-limited).

Hot water is about 15–25 % of the pump's energy. So this is small next to space heating, but it
is the cheapest Autopilot part to build: its lever (697) is one the owner already pulls every
day.

## 4. Approach

A **day-ahead tank planner**, built like the heating planner:

1. **State:** stored heat in kWh, from BT6, BT7 and the tank catalogue (`lib/hotwater.ts`).
2. **Demand:** a learned hour-of-day draw profile, kept separately for weekdays and free days,
   plus standing loss learned from draw-free nights.
3. **Plan:** a dynamic programme over the next 24–36 h of prices. It keeps stored heat above a
   floor that rises before each learned peak, for example "≥ 150 L at 06:00 and at 18:00".
4. **Lever:** 697 in the planned slots only. One charge in the planned slot replaces the Flow's
   reactive top-ups.
5. **Guards** (§12): no charge within 2 h before a planned heating pre-heat, at most 2 planned
   charges a day, no boosts while away, and refill before return. The rescue stays: below
   the floor, charge now whatever the price.
6. **Pumps that start charges themselves** (Medium or Large with a normal start temperature):
   defer by lowering the start setpoint. That is an EEPROM write, at most 2 a day (§12).
   Advancing alone captures most of the value, and it is all the owner's setup needs.

**Interaction with heating:** a charge blocks space heating for about 1 h. At 1.7 charges a day
the house model already sees this as `dhw` slots. A planned charge has to sit outside heating
pre-heat blocks. Midday (10–14) is usually fine: it is cheap, and the house coasts then anyway.

## 5. Plan

### Phase A: offline, no pump writes (can start now, alongside M2)

- **A1. Collect tank state.** Add BT6, BT7 and litres to the Autopilot history (three fields).
  Hourly Insights are too coarse for draws. This is a data-collection change installed on the
  maintainer's Homey.
- **A2. Draw and loss learner:** an hour-of-day profile by day type, standing loss from
  draw-free nights, and charge rate and COP against tank temperature.
- **A3. Offline planner and back-test:** `dev/evaluate-hot-water.mjs` replays real prices and
  real draws, without the draws known in advance. It scores against the actual Flow and against
  the optimum, and counts litres-floor violations.
- **A4. Shadow:** log each day what the planner would have done, its predicted litres at 06 and
  18, and what actually happened.

### Phase B: hardware tests (each needs the owner's go-ahead)

| Test | What it settles | Writes |
|---|---|---|
| **H0** Watch 1028 at 5-min for a week | Whether the pump starts its own charges at start 5 °C (the 10 unexplained charges) | none |
| **H1** One midday 697 charge from a half-empty tank | Charge rate and COP against BT6, and whether a midday charge covers the evening | 697 once |
| **H2** One draw-free night logged at 5-min | Standing loss as a function of tank temperature | none |
| **H3** Planner-driven 697 for 7 days, Flow paused | Real kr against the Flow's baseline week, and comfort (no rescue fired) | 697 ≤ 2/day |
| **H4** (Medium/Large pumps only) Start setpoint −5 K for 3 h | Defer latency and restore | 59 twice |

### Exit criteria for going live (test channel)

- The back-test beats the actual Flow by ≥ 10 % over ≥ 14 days, with no floor violations.
- The shadow's 6 h litres prediction is within ±50 L on ≥ 80 % of days.
- H3 holds comfort (zero rescues caused by the plan) and shows a saving.
- H0 has explained the unexplained charges.

## 6. Recommendation

Pull hot water forward as **phase A now, in parallel with M2**. It does not depend on the house
model, the data is cheap to collect, and the lever is already in daily use.

Keep the live step (H3 onward) behind the same rule as heating: nothing ships, not even to the
test channel, until the back-test and shadow pass. The planner can go live before M3, because
its only interaction with heating is the "no charge before a pre-heat" guard, and without M3
there is no pre-heat to guard.

## 7. Open questions

1. On 2026-10-18 the owner did not want the app to own hot water charging. Does Autopilot
   replacing the Flow change that, or should Autopilot only *suggest* slots that the Flow acts
   on (for example a "planned hot water slot" condition card)?
2. Which floor is right: a fixed number of litres before each peak, or the owner's recent minimum
   (§12)?
3. Free days versus working days: the Flow takes this from a Homey variable. Should the planner
   use it, or learn it from the draws?
4. Legionella: periodic hot water is off on this pump. Advice only (§12)?
