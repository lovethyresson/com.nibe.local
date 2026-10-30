# External temperature Flow actions

Heating exposes **Set outdoor temperature (BT1)** when its outdoor-temperature capability is
selected. It accepts −50–60 °C as a number or numeric Flow token and writes holding register 5217.
Values are rounded to tenths, encoded as signed 16-bit words and sent using FC6 through the
existing shared connection/write queue. The range is an app guardrail.

BT50 is supplied by the automatic Homey sensor feed configured in Heating Setup, rather than a
standalone Flow card. Users can select one sensor or an equal average of several. Pairing saves a
pending configuration; Repair verifies and activates the persistent feed. See
[indoor sensor plan](indoor-sensor-plan.md) for its lifecycle and recovery requirements.

A successful BT1 action means the Modbus write was accepted, not proof that the external sensor is
enabled. Transport failures reach the Flow. No second pump connection is opened.

## Pump setup

Enable Modbus TCP/IP writes in menu 7.5.9 and the relevant external sensor in **7.5.9.2**.
BT50 writes were introduced in firmware **4.2.4**. Room-sensor/zone configuration must also select
an appropriate controlling sensor. Existing wireless zone control may continue to determine the
climate-system average; turning on external BT50 alone does not demonstrate replacement.
Do not automatically change zones, SPA, heating curves, or external-sensor activation.

The BT1 card sends once. A Flow must supply fresh readings regularly, including when the measured
value is unchanged. Its loss-of-feed timeout and wired-sensor fallback remain unverified; do not
assume stopping a Flow restores the physical sensor.

The activated BT50 feed refreshes in the background. Stopping it requires restoring the pump's
native sensor and disabling external BT50 on the pump before switching back in Heating Setup.
Installing the app does not activate a new feed; an already active feed resumes after restart.

## Hardware evidence — S1155-16, 2026-09-11

Pump reports raw firmware code 1036 (not mapped to a display version).

- Both holding registers initially returned 32768 (`0x8000`, unavailable).
- FC6 to 5987 with raw 238 was acknowledged and read back as 238 after 300 ms. After another
  1.2 seconds it returned 32768. A later raw 239 was also accepted; climate-system average input
  116 stayed at 238. Individual room inputs 26/25/24 returned exceptions. **Initial write acceptance was verified, but effective readback was unavailable.** After the
  owner selected BT50 to control the zone, input 26 became readable: writing 239 changed it from
  238 to 239 after two seconds. Restoring 238 restored input 26 to 238. **BT50 scale 10 and
  effective sensor replacement are now verified.** Input 116 stayed at 238 during this eight-second
  test; its aggregation/update timing and the eventual heating response remain unverified.
- FC6 to 5217 with raw 149 changed input 1 from 148 to 149 (14.8 → 14.9 °C). It remained 149 for a further 30-second test without refreshing, after
  the holding register cleared. Restoring raw 148 restored input 1 to 148. **BT1 scale 10 and
  effective temperature replacement are verified.**
- Both mailboxes clear to 32768 within roughly a second. Re-reading persistent state would give
  false failures. Writing 32768 back is not a way to undo a consumed temperature; restore the
  temperature itself. Final feeds were restored to BT50 23.8 °C and BT1 14.8 °C.
- Holding 5986 returned exception 1; do not use it as a universal activation switch.

This establishes a BT1 input for experimenting with outdoor-temperature compensation. It does not
establish a validated Ngenic-equivalent controller, loss-of-communication handling or energy savings.

## Smart heating lever probes — S1155-16, 2026-10-15

Run by Claude with the maintainer's go-ahead, using `dev/probe-bt1.mjs`. Before the runs, real
BT1 was 10.5 °C, the BT1 average 37 was 8.8 °C, and calculated supply 1017 was 34.5 °C.
- SPA master 843 = **1** (on) throughout. It was not changed, so it is a possible confounder.
- Input 5986 = 1, so the zone is controlled by the app's BT50 feed.
- 184 auto-stop heating = 15 °C. 185 auto-stop add heat = 5 °C. Curve 26 = 5.
- Holding 30 returned no value.

**0.1: one 5217 write expires after about 5 minutes.**
- One FC6 write of 5.5 °C held on input 1 for 275 s or more.
- At 306 s input 1 read the wired 10.5 °C again.
- The pump returns to the physical sensor by itself, so a crashed feeder hands control back
  within about 5 minutes. A 30 s refresh is well inside that window.

**0.2: the same expiry holds across Modbus disconnects.**
- The probe reconnected before every sample. The value was released at about 317 s, reading
  10.4 °C.

**0.3: no physical-BT1 copy found.**
- Over 60 s of feeding 5.4 °C, three inputs stayed near the real 10.4 °C:
  - 16, suction gas BT17 (9.1);
  - 1042, max compressor frequency (raw 102);
  - **108**, which the CSV lists only as "id:149" °C (9.6; it read about 23.4 °C in summer).
- 16 and 1042 are coincidences. 108 is unexplained: a slow average, or a physical copy. It is
  open until it is sampled over a longer feed.
- Only input 1 followed the fed value.

**0.4: fed BT1 barely moves calculated supply within an hour.**
- Feeding 5.4 °C (−5 K) every 30 s for 60 min (118 writes, 0 failures, which also covers 0.7)
  moved:
  - calculated supply 34.5 → 34.8 °C, i.e. **0.06 K per K**;
  - the BT1 average 37 from 8.8 → 8.6 °C.
- The ratio (+0.3 K supply per −0.2 K of average) matches a curve driven by the **average** (37),
  not by input 1.
- The size of the average's move fits roughly a 24-hour moving window.
- **Superseded 2026-10-29:** room control was on here and masked the curve. With it off, the
  curve follows fed BT1 with τ ≈ 50 min, not through 37 (see below).
- Consequence: a fed BT1 reaches the curve through the pump's own outdoor filter, the same path a
  physical BT1 emulator (Ngenic) takes. Smart heating must model that filter and plan with lead
  time (smart-heating-plan.md §4.5). Whether the 7.1.10.2 "filter time" setting governs the lag is
  unverified.

**0.4b: 3 h step, 2026-10-16.** BT1 was 14.1 °C, fed 9.1 °C (−5 K) every 30 s: 352 writes, 0
failures.
- **The filter:** 37 went 12.4 → 11.9 °C, i.e. **τf ≈ 18 h** for an exponential filter. That is
  consistent with a ~24 h average.
- **Supply:** calculated supply went 20.5 → 22.6 °C. DM stayed at +100 throughout. Indoor
  (26/116) was 22.5–23.0 °C. Priority was hot water or off.
- **Why the curve response is not measured:** the zone was under room-sensor control (BT50 feed
  active, 5986 = 1) with the house at or above setpoint. Room control held supply low, so the
  late rise in supply tracks indoor drifting down, not BT1.
- **Measuring it** needs room control off, which is also Ngenic's installation precondition.

**0.0: no flag (2026-10-30).** The maintainer switched Outdoor temperature (BT1) in 7.5.9.2
on → off → on while every S1155 CSV register plus input/holding 5900–6100 was read (1,694 answer,
about 30 s per snapshot). No register followed the switch: nothing read the same with BT1 on
both times and different with it off. The 5970–6000 neighbourhood of the BT50 flag (input 5986)
did not move either. So there is no readable "external BT1 enabled" flag. Repair verifies the
lever by feeding a value and checking that input 1 follows it (plan §8, `lever_error`).

## Fake-indoor (BT50) lever probes — S1155-16, 2026-10-28

Run by Claude with the maintainer's go-ahead. The Nibe app was disabled on Homey for the runs
(17:00–17:11 and 17:12–17:45) so its own BT50 feed could not overwrite the probe, then re-enabled.
- Room-sensor control on (5986 = 1).
- BT1 10.9 °C, BT1 average 37 = 11.9 °C, curve 26 = 5.
- SPA 843 = 1. **Operating mode 237 = 1 (Manual)**, which was 0 on 2026-10-15.
- Compressor idle (priority 10) throughout: a mild day with little heat demand.

**Feed loss is graceful.**
- After the app's feed stopped, input 26 (effective BT50) read normally for 4 min and was
  **unavailable from about 5 min**.
- Input 116 (climate-system average) kept reporting 22.5–22.7 °C.
- Calculated supply stayed at 24.2 → 24.0 °C, with no visible upset.

**A −1 K fake indoor for 30 min** (21.7 °C instead of 22.7 °C; 59 writes, 0 failures):
- Input 26 took the fed value at once.
- **Input 116 settled at 22.2 °C within about 5 min**, halfway between the fed 21.7 and the
  real 22.7. It returned toward 22.7 after restore.
- The climate-system average evidently includes a second room sensor, so only half of a fed
  BT50 error reaches the regulator.
- Calculated supply went 24.0 → 24.4 °C, rising only after about 15 min: about 0.4 K supply per
  K of fed indoor error (about 0.8 K per K of 116). The real outdoor temperature fell 10.9 → 10.5
  in the same window. The BT1 average 37 did not move, so the curve itself contributed nothing.

**Compared with fake outdoor (BT1), on this pump:**

| | Fake indoor (BT50) | Fake outdoor (BT1) |
|---|---|---|
| Response time | Minutes | τ ≈ 50 min on the curve (37 itself is slow, τ ≈ 18 h) |
| Gain | About 0.4 K supply per K | About 0.5 K supply per K (2026-10-29 and 10-30) |
| Other limits | Diluted by any other sensor in the climate-system average; bounded by the room factor | Needs room control off |

Both tests ran with the compressor idle on a mild day, so absolute responses are small.

## Fake-outdoor step with room control off — S1155-16, 2026-10-29

Run by Claude with the maintainer's go-ahead. The maintainer turned room-sensor control off
(menus 1.3.3/1.3.4) shortly before the run and back on after it.
- Real BT1 8.6–8.7 °C at the start, 9.4 °C at the end. BT1 average 37 = 8.5 °C. Curve 26 = 5.
- **SPA 843 = 1 throughout.** Operating mode 237 = 1 (Manual).
- 20 min baseline, then BT1 fed at 13.7 °C (+5 K) every 30 s for 2 h 44 min, then 30 min of
  recovery with the wired sensor.

**Baseline.** After room control went off, calculated supply fell from 36.7 to 28.3 °C within
8 min, then settled at 28.0–28.1 °C for the last 10 min before the step.

**Step: a clean first-order response.** Supply change from the settled 28.0 °C:

| Into step | 10 min | 21 min | 52 min | 1 h 23 min | 2 h | 2 h 25 min on |
|---|---|---|---|---|---|---|
| Supply 1017 | −0.4 | −0.9 | −1.9 | −2.4 | −2.6 | −2.8 (flat) |

- **Gain ≈ 0.55 K of supply per K** of fed BT1 (−2.8 / +5.1).
- **τ ≈ 50 min.** 63 % of the final move was reached at about 50 min.
- 37 moved only 8.5 → 9.2 °C, so the curve is **not** reading 37. It reads a faster-filtered
  BT1. 37 rising 0.7 K in 2.7 h still fits τ ≈ 18 h for that slower average.

**Recovery: the same lag in reverse.** Supply went 25.2 → 26.3 °C in 30 min. With real BT1 now
9.4 °C, the expected end point is about 27.6 °C, and a 50 min lag predicts +1.1 K at 30 min.

**Confounders, and why the result stands:**
- SPA was on. Midday prices were the day's cheapest (SE3 1.07–1.15 SEK/kWh), so SPA would have
  pushed supply up during the step. The recovery ran into rising prices (15:00 onward), where SPA
  would push supply down. Supply moved against SPA both times.
- Room control had only just been turned off, but supply was flat for 10 min before the step,
  and the step response has the shape of a filter, not of a continuing decay.
- A repeat with SPA off and a longer settled baseline would tighten the numbers.

**Comfort cost.** The compressor stayed off from 11:58 to 15:14, and indoor fell from 22.5 to
21.5 °C. With room control off, nothing pulled the supply back up as the house cooled.

## Clean repeat: SPA off, settled baseline — S1155-16, 2026-10-30

Run by Claude with the maintainer's go-ahead, using `probe-bt1.mjs --step -5 --force --minutes 180
--after 150` (plan §3.1). The maintainer switched SPA (843 = 0) and room-sensor control off just
before. Curve 5, offset 0, operating mode 237 = 1; none of them changed during the run.
- **Colder, not warmer,** so the house would not cool while the maintainer was out. Real BT1 was
  6.4 °C, so the fed 1.4 °C was below auto-stop add heat (185, 5 °C); `--force` allowed that on
  the maintainer's word that the immersion would not start. It did not: add heat stayed 0.
- **Settle:** 35 min, supply flat at 29.0 °C.
- **Step:** 3 h, 351 writes, 0 failures.
- **Recovery:** 2.5 h on the wired sensor. Real outdoor rose from 6.4 to 10.5 °C over the run.

| Point in the run | Supply 1017 |
|---|---|
| Start of step | 29.0 °C |
| Step, 1 h | 30.8 °C |
| Step, 2 h | 31.2 °C |
| Step, 3 h (end) | 31.3 °C |
| Recovery, 1 h | 28.9 °C |
| Recovery, 2.5 h | 27.6 °C |

**Result:**
- **Fitted separately:** step gain 0.47 K per K, τ 46 min. Recovery gain 0.52 K per K, τ 72 min.
  The gains agree. The recovery τ looks longer because the real outdoor temperature kept rising
  through it, by 2 K, which a fixed-end-point fit reads as a slow tail.
- **Fitted as one model** (`supply = c − g·f`, `f` a first-order filter of the BT1 the pump
  actually saw: the fed value, then input 1 on the wired sensor): **τ = 49 min, gain 0.50 K per
  K, rmse 0.06 K** over 644 samples.
- With 2026-10-29 (0.55 K per K around 9–14 °C), the gain is about 0.5 at curve 5 and varies a
  little with outdoor temperature, as a curve should.
- Indoor dipped from 22.8 to 22.0 °C in the first 1.5 h, while the compressor caught up on degree
  minutes from before the step, and ended at 22.5 °C.

**Conclusion:** a fed BT1 moves the curve with τ ≈ 50 min and about 0.5 K of supply per K. Both
directions and both days agree.

## Sources

- [NIBE firmware history](https://www.nibe.eu/webdav/files/myuplink_changelog/nibe-n.pdf), 4.2.4.
- [NIBE Modbus manual](https://assetstore.nibe.se/hcms/v2.3/entity/document/878103/storage/ODc4MTAzLzAvbWFzdGVy), external sensors. Its factor-1 statement conflicts with measured BT1 behaviour.
- [SMO S40 BT50 report and export](https://github.com/home-assistant/core/issues/155175), raw 217 = 21.7 °C; this is another model, not proof of this S1155's controlling input.
