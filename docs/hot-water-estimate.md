# How the hot water estimate works

**This file is the source of truth for the litres-of-hot-water business logic.** Update it before
any release that touches the formula, the calibration, the tank catalogue or the sensor mapping.
[docs/FAQ.md](FAQ.md) carries the user-facing version and links here.

Last verified against the code: **1.1.2** (unreleased).

## The problem

The pump reports tank **temperatures**. It never reports a volume, and it does not report the size
of the tank it is charging.

NIBE does compute a hot water volume — firmware 4.4.7 (2025-08-26) added one to the myUplink hot
water tile — but only for **S125x, VVM S320/S325, S735 and S735C**, only in the cloud, and in
**minutes** rather than litres. That changelog names every Modbus register the release added and
names none for this; no S or F register map in the open-source datasets carries one either. NIBE
excludes exactly the models with no integrated tank, because it does not know what tank is fitted.

So the number is computed here or not at all, and our figure will never match myUplink's for an
owner who sees both. NIBE's algorithm is unpublished, so the two cannot be reconciled.

## What the number means

**V40** — the litres of 40 °C water the heat currently in the tank is worth. This is the same
quantity NIBE prints on its own tank datasheets as "equivalent amount of hot water", and it is a
legal term (EU Ecodesign / EN 16147). It is what an owner actually wants: 172 L at 50 °C is 230 L of
showerable water, not 172.

Consequences that look like bugs and are not:

- **It legitimately exceeds the tank volume.** A 178 L tank at 55 °C shows about 267 L. Not capped.
- **Water below 40 °C counts for nothing.** You cannot blend 38 °C water up to 40 °C, so a layer
  below the mix point contributes zero rather than a negative.

## Why two sensors are not enough on their own

The tank has two sensors, and they are not near each other:

- **BT7** (register 8) — the *delivery* sensor near the top. Holds up during a draw until the
  thermocline reaches it.
- **BT6** (register 9) — the *charge-coil* sensor, lower down. Falls first and fastest.

Measured on a live S1155-16 (type 55, compressor 16, firmware 1036), settled and fully idle —
compressor 0.0 Hz, 21 W standby, priority 10 on both 1028 and 3804, degree minutes +169 — five
samples over 24 s, rock stable:

```
BT7  56.0 °C
BT6  38.0 °C
```

Eighteen degrees apart, with the lower sensor **below the mix point entirely**. What you assume
about how the tank divides between those two readings is not a detail — it is the whole answer:

| Assumption | V40 on a 180 L tank, at those readings |
|---|---|
| BT7 speaks for the whole tank | 276 L |
| upper 70 % | 193 L |
| upper 50 % | 138 L |
| BT6 speaks for the whole tank | 0 L |

**0 to 276 litres.** A hard-coded split would not be an estimate, it would be a guess wearing a
unit label. So it is measured.

**A third sensor, BT5 (address 2014), is listed for this family and does not answer on an S1155.**
It was probed directly. If a model does have it, the same maths extends to three layers.

## The model: interpolate the thermocline

```
hot  = max(BT7, BT6)      cold = min(BT7, BT6)

hot <= 40           ->  0
cold >= 40          ->  litres x (mean(hot, cold) - inlet) / (40 - inlet)
otherwise           ->  litres x (hot - 40)/(hot - cold) x ((hot + 40)/2 - inlet) / (40 - inlet)
```

The middle case is a fully hot tank. The last is the normal one: the front lies between the two
sensors, a linear profile puts it at `(hot − 40)/(hot − cold)` of the way up, and the water above it
averages `(hot + 40)/2`.

**Parameter-free.** There is nothing to tune, which is the point.

### What it replaced, and why

The first version lumped each sensor into a fixed share of the tank — the upper sensor "speaking
for" 35 %. Two live failures killed it:

- **It could not see a draw.** Hot water leaves from the top and cold enters at the bottom, so the
  lower sensor collapses while the upper stays hot until the front reaches it. With the lower sensor
  already below the mix point and contributing nothing, a real shower moved the estimate **1.0 L
  while ~50 L left the tank** — out by a factor of 48.
- **It was discontinuous at the mix point.** A fixed share held at the upper sensor's temperature
  vanishes in one step as that sensor crosses 40 °C: **61.5 L at BT7 40.1, zero at BT7 40.0**. On the
  owner's Insights chart that drew as a vertical drop to zero and read as the app breaking.

Both are fixed by interpolating rather than lumping, measured on the same trace:

| | Lumped | Thermocline |
|---|---|---|
| A real shower (5 min, ~50 L) | 1.0 L | **6.4 L** |
| A 20-minute draw (~200 L) | 27.5 L | **58.9 L** |
| Step as BT7 crosses 40 °C | **61.5 L → 0** | 0.9 L → 0 |
| VPB 200 uniform at 50 °C | 229.3 L | 229.3 L ✓ |

It also deletes the guessed upper-share constant, which was the largest single source of error in
the whole feature (moving it 0.25 → 0.45 swung the answer ~57 %), and with it the entire
charge-cycle calibration that existed only to measure that share.

**Reaching zero is correct, not a failure.** Once the hottest water in the tank is below 40 °C there
is genuinely no 40 °C shower left in it. What was wrong before was arriving there in one jump.

## The tank volume comes from the user, and here is why

The original design worked the tank out from delivered energy. Across a charge, register **1575**
gives the kWh that went in, water takes `1.163e-3` kWh per litre per kelvin, and two differently
shaped charges solve for the volume.

**Three days on a live S1155-16 with a confirmed 176 L VPB 200 killed it.** The method measured
**436 L**.

Everything else checked out first:

- **1575 is accurate.** Cross-checked against the pump's own hourly log (2285), which
  [energy-attribution.md](energy-attribution.md) records as matching myUplink exactly: four separate
  hours gave ratios of **0.99, 1.01, 0.98, 1.01**.
- **The immersion heater is irrelevant** — 1575 grew 37.4 kWh while 1583 (compressor only) grew 37.3.
- **Standing losses are irrelevant.** An 11-hour overnight cooldown with no charge and nobody awake
  measured **79 W**, right on VPB 200 spec — about 0.09 kWh across a charge.

The gap is **water drawn while the pump is charging**, and it is structural rather than occasional. A
charge ends only when the bottom sensor reaches its stop temperature, so water drawn meanwhile just
makes the charge run longer, and the surplus energy is indistinguishable from tank volume. Power is
near-constant at 7-8 kW, so energy tracks duration:

| Charge | Ran for | Filling 176 L needs | Delivered | Ratio |
|---|---|---|---|---|
| 08-29 10:45 | 77 min | 43 min | 9.7 kWh | 1.79 |
| 08-29 13:50 | 91 min | 44 min | 12.0 kWh | 2.05 |
| 08-30 09:00 | 95 min | 44 min | 12.3 kWh | 2.17 |
| 08-30 21:45 | 68 min | 34 min | 8.0 kWh | 1.97 |

**2.00x, ±0.16** — far too consistent to be variable household use. It is consistent because a
price-optimised automation triggers a charge *because* hot water is being used, so the household
draws at roughly the refill rate throughout.

So the volume is asked for, once, and never derived. No tank chosen means no estimate.

## Known warts

- **It is an upper bound, and the gap widens with tank size.** The model assumes stratification is
  preserved during the draw. NIBE's tested figures show it is not: small cylinders come in at a
  ratio of 1.33 (which this reproduces to within 0.5 %), but VPB 500 is 1.21 and VPB 1000 is 1.19,
  measured at a 30 l/min draw. Asserted in the tests so nobody "fixes" the formula to chase a
  published number it was never computing.
- **V40 is not a property of the tank alone.** NIBE publishes **376 L and 455 L** for the same VPB
  S300 in two of its own documents — a 21 % spread — because the second is measured at double the
  draw rate with the coil recharging throughout. Ours is the no-recharge, stored-heat figure, which
  is the conservative one.
- **It still under-reports a draw in progress**, just far less than before. It cannot see the water
  above the upper sensor or below the lower one, so a real shower moves it about 6 L where ~50 L
  actually left the tank. It moves in the right direction continuously, which is what a gauge needs;
  it is not a flow meter.
- **Two sensors is not many for a whole tank.** Where the front actually sits between them is
  interpolated, not measured. A third sensor would help — BT5 at address 2014 is listed for this
  family and was probed on a live S1155-16, where it does not answer.

## The cold-water inlet, learned

The other half of the conversion, and it used to be a field in the picker. Almost nobody knows their
mains temperature, so that field was asking for a number it would usually get wrong.

The lower tank sensor sits above the cold feed, so after a deep draw it settles close to what is
coming in. The app keeps that sensor's **daily minimum** for 30 days and takes the lowest — daily
minima rather than an all-time low so one anomalous reading cannot pin the estimate for a month, and
so a genuinely warmer summer supply pushes it back up as old days age out.

**The bias is optimistic, not conservative — which is the opposite of how it looks, and the first
version of this code got it backwards.** The observed minimum is at or *above* the true inlet
(the sensor is above the very bottom). But V40 scales as `(T − inlet)/(40 − inlet)`, so raising the
inlet shrinks the denominator faster than the numerator and the estimate goes **up**. On a 65 L upper
layer at 56 °C: 8 °C → 97 L, 12 °C → 102 L, 24 °C → 130 L.

So the upper clamp of **20 °C** is load-bearing rather than a sanity check. Mains water is not 22 °C
in a Swedish house; a minimum that high means the tank was never drawn far enough to see the inlet,
and believing it would overstate the hot water available by a third. Above the clamp the app
declines and falls back to NIBE's own 10 °C, which is the safer answer. A unit test pins both the
direction and the clamp so the reasoning cannot quietly revert.

`Selection.hotwater.inletC` survives as an override that nothing writes any more, honoured if
present so a device configured by the old picker keeps its answer. `cleanTankChoice()` must leave it
**absent** rather than defaulting it — a stored default is indistinguishable from an explicit answer
and would permanently suppress the learned figure.

## The pairing and repair picker

A card headed **Hot water tank**: a one-line explanation, a dropdown, and a compact
"cold water coming in" row. "Work it out for me (recommended)" is first and selected by default;
"Other tank…" is last and reveals a labelled litres field. In Repair it is a card of its own; in
pairing it is nested inside the Hot Water device's card (`.tank-nested`, which adds the separating
rule) and hides with that device's checkbox.

Verified in a browser at 375 px and 400 px, light and dark, English and Swedish, including the
longest catalogue entry and the "Other tank…" path — see `dev/preview/` (gitignored; serve the repo
over HTTP and open `dev/preview/view_repair.html`). What that caught:

- **A bare `<select>` sizes itself to its widest option**, so "NIBE VPB S300, stainless · 282 l"
  pushed the control past the viewport. Fixed with an explicit width plus `min-width: 0` — the
  latter is what actually stops intrinsic content width winning. With that in place a long option
  is safe, which is why the built-in-tank entry can name the models it covers.
- **No pair or repair view declared a charset**, while `▸ ▾ — °` already shipped in their JS. Homey
  evidently serves UTF-8, so it never bit, but the views now say so themselves. Both copies of
  `detect.html` were patched identically; they remain byte-identical.
- **`°C` is wider than `l`**, so with `space-between` the two number fields did not line up. The
  unit span has a fixed min-width.

## Related notes

- [FAQ.md](FAQ.md) — the user-facing version.
- [energy-attribution.md](energy-attribution.md) — why 3804 rather than 1028, and what 1575 counts.
