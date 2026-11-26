# Hot water litres: get a ground truth first

Status: plan, 2026-11-26. Nothing built.

## Why every earlier attempt failed

Every attempt scored the two-sensor estimate against something that was not the truth:

| Attempt | Scored against | Why it could not decide |
|---|---|---|
| Lumped → interpolated thermocline (1.2) | Watching it on live data | No reference at all |
| Heat accounting (2026-11-13/14) | 1575 | 1575 counts heat that never reaches the tank once it is warm (0.44 kWh tank heat per kWh el above 50 °C) |
| Refill energy back-test (38a40f5) | 1575 at the next heating | Same 1575 problem, and only scores the moment a heating starts |
| Countdown back-test (3d57dd5) | 1575 at the next heating | Scores only heating starts, which are exactly when the sensors have just caught up ("stacked in the sensors' favour") |

## The ground truth we have and never used

The house water meter (Vattenmätare, Aquaro, `meter_water`, 1 L resolution, 5-min Insights for
24 h). It counts all water, hot and cold. A shower mixed to about 40 °C is about what V40 counts,
so for a hot water draw the metered litres are close to the V40 litres used (an upper bound, since
toilets and the cold tap count too).

26 Nov, from the meter and the estimate's Insights:

| UTC | Water used | Estimate fell | BT6 |
|---|---|---|---|
| 05:20–06:35 | 76 L | 10 L | 46.6 → 43.9 |
| 08:35–09:45 | 40 L | 115 L | 40.1 → 32.3 |
| 12:35–16:25 | 153 L | 40 L | 51.4 → 40.0 |
| 16:45 (17:42 local) | 51 L | 118 L (205 → 87) | 40 → 28 |
| 18:30–18:50 | 161 L | 115–180 L | 46.5 → 11 |

The pattern: after a full tank, draws push a cold layer up from the bottom, below BT6. The
sensors cannot see it, so the estimate stays high for 100–150 L of use. When the layer reaches
BT6 the estimate collapses, and the straight-line assumption between the sensors then over-shoots
and reads too low (87 L shown, about 154 L real: 205 − 51 by the meter, 220 − 69 by 1575 over a
cold-band run).

So the error is not a factor to calibrate. It is information the two sensors do not have: the
water drawn since the tank was last full, until the cold reaches BT6.

## Plan

1. **Collect** (app, TEMP-tagged, this house only): a per-minute tank trace to a jsonl file:
   BT6, BT7, 1575, priority, compressor Hz, the estimate, and the water meter's `meter_water` and
   flow (read via `homey:manager:api`, approved). 3 weeks. Reads only.
2. **One controlled draw evening** (with the owner): from a full tank, only the hot tap open at one
   tap, read the meter and a thermometer in the stream every 20 L until it falls under 40 °C.
   Gives the true V40 of a full tank and the sensors' response to known litres. Confounder: the
   pump starts heating when BT6 falls under its start temperature (42 °C); note when it does and
   stop the test there, or raise the start temperature for the evening (a pump write: owner's yes).
3. **Score candidates at every minute** against "last full reading − metered water since", not
   only at heating starts:
   - (a) today's interpolation;
   - (b) a hidden-use count (learned use per hour) until the cold reaches BT6, then the sensors;
   - (c) a tank model with memory: the cold layer's height as state, moved by draws, corrected
     only when a sensor changes.
   Pass: (b) or (c) beats (a) on mean absolute error over the day, and in the 6 h before each
   heating, by at least 30 L, with no worse error at heating starts.
4. **Owners with a water meter** could feed it in directly. That is a separate decision, after 3.

Out of scope until 3 passes: any change to the planner, the tile or the reserve.
