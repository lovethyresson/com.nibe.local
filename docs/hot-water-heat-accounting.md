# Hot water: which heat figure to trust, and how to verify it

Status: **hypotheses, not verified.** Written 2026-11-13 after Autopilot's first live hot water charge
went late and expensive. Nothing in the planner changes until the checks below pass.

## What happened (measured)

The charge started by Autopilot at 13:45 on 2026-11-13:

| | Plan | Real |
|---|---|---|
| Heat | 4.7 kWh | 1575 says 10.9 kWh; the tank sensors say about 2–3 kWh |
| Run | about 0.8 h | 2 h 02: compressor 85 min, then the immersion 37 min |
| Electricity | about 1.8 kWh | 6.5 kWh, about 3 of it immersion |
| Cost | 3.35 kr | about 13 kr |
| End | 60 °C | alarm 216 (high condenser) at 15:32, top 59.6 °C on the immersion |

The plan slid from 11:30 to 13:45 while the price was flat at about 1.6 kr. The real run went
into 1.8–2.4 kr slots. My three app installs that day (about 08:45, 10:45 and 13:15) each restarted
the plan, and one changed how draws are planned (31c85ac, `plannedHours`).

## Three heat figures, and why they disagree

| Figure | What it is | Weak where |
|---|---|---|
| **1575** (pump's hot water heat counter) | Nibe's own figure | Unknown how it is computed. Reads an almost constant 1.5–1.6 kWh per 15 min while the compressor runs, whatever the tank temperature |
| **V40 litres** (`lib/hotwater.ts`) | Two sensors (BT7 top, BT6) and the tank size | Reads 0 (unknown) below a 40 °C top, so it jumps (0 → 191 L in 15 min at 03:10) |
| **Sensor heat** | 175 L × the change in mean of BT6 and BT7 | Two sensors in a stratified tank; the tank size is the owner's figure |

Per 15 min on 2026-11-13 (5-min Insights):

| Tank top | 1575 | V40 | Sensor heat (BT6 rise × 175 L) |
|---|---|---|---|
| 43 → 48 °C (03:25) | 1.63 | 1.18 | ≈1.1 |
| 48 → 56 °C (03:40–03:55) | 1.53–1.58 | 0.63–0.99 | 0.65–0.94 |
| 53 → 58 °C (04:10, 14:10–14:40) | 1.54–1.62 | 0.25–0.43 | 0.24–0.43 |

**Finding 1 (measured):** above about 48 °C, 1575 reports 1.6–6× what the tank's sensors show, and
the gap grows as the tank warms. The
gap is the same with GP1 on auto (03:00 charge) and at 100 % (13:45 charge), so the GP1 test is
not the cause.

**Finding 2 (code):** the learner computes draws as `fall in V40 + 1575 − loss`
(`hotwater-learner.ts:159`). Every kWh 1575 over-reports during a charge is booked as hot water drawn.
The charge model (rate and COP) is learned from 1575 too, while the tank state the planner fills is
V40. The planner adds 1575-sized heat to a V40-sized tank.

**Finding 3 (measured, earlier too):** the compressor's ceiling here is about 58 °C at BT6 (alarm 216
or 382). The planner's maximum is 60 °C, so the last 2 K is always the immersion.

## Hypotheses

| | Hypothesis | If true |
|---|---|---|
| **H1** | 1575 is an estimate (for example compressor power × a fixed COP), not measured heat, and it overstates at a hot condenser | Plan and learn from the tank's own heat, never 1575 |
| **H2** | The missing heat really leaves the condenser but goes elsewhere: through the reversing valve into the heating circuit (BT2 reads 55–61 °C during every charge), or lost in pipes | The fix is the valve, not the planner. The heat is not wasted, it heats the house |
| **H3** | The tank is larger than 175 L, or the two sensors miss heat stored low in the tank | V40 and sensor heat are both too low; 1575 may be right |
| **H4** | The planner's draw forecast is inflated by H1 | Charges that are not needed, like the 13:45 top-up |

Evidence so far against H2: indoor falls 0.2–0.3 K during a typical charge, about what two hours
without heating gives. A 4 kW leak into the house would hold it flat or warm it. Not conclusive: a
floor slab can take heat without the air showing it.

## Verification plan

Each check names the data, the pass test and what it decides. All reads, except where marked.

1. **Tank size (decides H3). Done 2026-11-13:** the nameplate reads NIBE VPB 200-Cu, 178 L tap
   water, heated through a coil. 178 against the 175 L used here is 2 %, so H3 is ruled out: the
   tank cannot hold 1575's extra heat.
2. **Where BT2 sits (decides part of H2).** Read the S1155 installer manual's sensor list for
   BT2 and BT12. During the next charge, log every 30 s over Modbus: BT2 (5), BT3 (7), BT12 (12),
   BT6 (9), BT7 (8), GP1 speed (1102), compressor Hz (1046), electric power, 1575, priority (1028)
   and the immersion (1029). If BT2 follows BT12 while the heating pump is stopped, BT2 sits before
   the valve and H2's main evidence goes. If BT2 is hot with GP1 running, hot water goes to the
   radiators.
3. **What 1575 is (decides H1).** From the same log: if 1575's rate is a fixed multiple of the
   compressor's electric power, whatever the tank or condenser temperature, it is an estimate.
   Compare against the pump's own energy log (3821/3823), which balanced to −0.8 % against the
   house meter in August.
4. **Draws against the water meter (decides H4).** The house has a water meter device
   (Vattenmätare). Check its Insights resolution. Hot water is a share of all water, so it cannot
   give litres of hot water, but it can show whether the model's "draws" happen when no water runs
   at all. Any booked draw during a charge with the meter flat is H1's phantom.
5. **Charge cost by tank temperature (for the planner).** Three charges logged as in step 2:
   from a cold tank to 50 °C, from cold to 55 °C, and a top-up from about 50 to 55 °C. Measure
   electricity and sensor heat per 5 K band. **This starts charges, which is a pump write (697 and
   62): only with the owner's yes, and with Autopilot hot water on Test run.** Hot water on
   Autopilot can serve instead if its target is capped at 55 °C first.

## Results so far (2026-11-13, evening)

Data: fresh hourly Insights for 6–13 Nov (1575, BT6, BT7, V40, the allocator's hot water
electricity, the water meter, 3821/3823), and 5-min for the last 24 h.

| Charge | Hours | 1575 kWh | El kWh | 1575/el | Top before → after | BT6 before → after | Water meter L |
|---|---|---|---|---|---|---|---|
| 6 Nov 23:00 | 2 | 8.8 | 2.6 | 3.4 | 27 → 49 | 12 → 49 | 0 |
| 7 Nov 09:00 | 3 | 16.1 | 5.3 | 3.0 | 47 → 54 | 46 → 44 | 454 |
| 7 Nov 13:00 | 3 | 15.7 | 5.5 | 2.9 | 55 → 58 | 54 → 57 | 279 |
| 8 Nov 09:00 | 3 | 11.8 | 4.0 | 3.0 | 49 → 51 | 47 → 17 | 272 |
| 8 Nov 15:00 | 4 | 15.4 | 5.4 | 2.9 | 50 → 58 | 13 → 56 | 193 |
| 10 Nov 07:00 | 3 | 16.0 | 5.5 | 2.9 | 29 → 58 | 15 → 57 | 205 |
| 12 Nov 03:00 | 3 | 13.4 | 4.7 | 2.9 | 32 → 58 | 18 → 46 | **0** |
| 13 Nov 02:00 | 3 | 11.4 | 4.0 | 2.9 | 37 → 58 | 16 → 52 | 35 |
| 13 Nov 13:00 | 3 | 10.7 | 6.4 | 1.7 | 54 → 60 | 43 → 58 | 47 |

(Hourly buckets, so a "3 h" charge is about 2 h. Water is the whole house, hot and cold.)

- **1575 reports more heat than the tank can hold (decides: H1 or H2, not H3).** 12 Nov 03:00, no
  water used at all: 1575 says 13.4 kWh. The tank started with BT6 at 18 °C and the top at 32 °C,
  and ended part-charged (BT6 46 °C). 178 L from the 11.4 °C inlet to 58 °C everywhere is 9.6 kWh,
  so this charge could have put at most about 8 kWh into the tank. At least 5 kWh of what 1575
  counts never reached it.
- **H4 confirmed: the learner books draws that never happened.** For that same charge it computes
  draw = fall in V40 + 1575 = −8.6 + 13.4 ≈ 4.8 kWh, about 137 L, while the water meter shows 0 L.
  On 13 Nov 02:00 it books about 2.1 kWh (60 L) against 35 L of all water, hot and cold.
- **The pump's energy log agrees with 1575.** During hot water hours 3821 (production) rises by
  about what 1575 does, so it is the same estimate and cannot check 1575. Its 1575/el sits at
  2.85–3.0 on every full compressor charge, whatever the start temperature.
- **GP1 is not the cause.** The gap is the same on the 03:00 (GP1 auto) and 13:45 (GP1 100 %) charges.

Open: H1 (an estimate) against H2 (heat leaving to the heating side). The 30 s log running from
20:02 on 13 Nov decides it on the next charge (Autopilot plans 09:00 on 14 Nov): watch BT2 against
BT12, the heating return BT3 and indoor while the charge runs.

**Pass test for changing the planner:** steps 1–3 explain the gap in finding 1, and step 5 gives
electricity per kWh of tank heat for each band, repeatable within ±20 % across two charges.

## What is safe now, whatever the checks find

- Cap the charge target at the learned compressor ceiling (about 58 °C here), never the 60 °C default.
- Plan a run at its real length: measured tank gain per slot falls from about 1.1 to 0.3 kWh as the
  top warms, so a top-up of a warm tank takes 2–4× as long as the planner assumes.

These two only change when and how hot a charge goes, and they hold under H1, H2 and H3 alike.

## Also measured on 2026-11-13 (heating)

Feeding BT1 at 80 °C (mailbox only, Autopilot heating on Test run): calculated supply fell from 30 to
20 °C (the minimum supply) within 6 minutes. Priority went to 10 and the compressor stopped at 19:32,
when the filtered BT1 the curve reads was about 29 °C. The pump accepted every value to 80 °C with no
alarm. So on curve 5, offset +6, a fed outdoor near 30 °C stops heating. The +20 K cap stops at
about 21 °C, which only halves it.
