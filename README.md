# Nibe Heatpumps (local Modbus, multi-device)

A [Homey](https://homey.app/) app that talks **directly to Nibe S-series heat pumps over Modbus TCP** on your
local network — no MyUplink cloud account required. A single physical pump is paired as **several logical
devices**, one per function, each with its own capabilities, its own energy meters, and its own **efficiency
(COP)**.

> Forked from [Jan Sparud's Nibe S-series app](https://github.com/sparud/net.sparud.nibe_s) and
> reworked into a local, multi-device app with per-function energy tracking, delivered-energy and COP
> readings, a Solar/PV device, and broad S-series coverage.

## Why multiple devices?

One heat pump serves several jobs — heating, hot water, pool, cooling — that you usually want to see and
automate separately. This app pairs each as its own Homey device:

| Device | What it carries |
| --- | --- |
| **Main** | The pump itself: operating priority and mode, the Smart Price Adaption master and status, diagnostics, runtime statistics, phase currents, ground-source (brine) temperatures, **alarms with readable descriptions**, compressor status — plus **total energy produced/consumed**, **Total COP**, **idle energy** (standby draw), and the pump's firmware/type in settings. |
| **Heating** | A thermostat: indoor and outdoor temperatures, the settable indoor setpoint, heat curve, supply/return temperatures, degree minutes, Smart Price Adaption, ventilation (if fitted) — plus **energy used**, **energy delivered**, and **Heating COP**. |
| **Hot Water** | Hot-water temperatures, demand mode, one-time boosts, periodic hot water, circulation (if fitted) — plus **energy used**, **energy delivered**, and **Hot Water COP**. |
| **Pool** | A thermostat with the POOL 40 accessory: pool temperature, settable target, start/stop setpoints, pump status — plus **energy used**, **energy delivered**, and **Pool COP**. |
| **Cooling** | Cooling permit, night cooling, auto start/stop temperatures, compressor runtime — plus **energy used**, **energy delivered**, and **Cooling COP**. |
| **Solar** | If a PV/self-consumption accessory (EME 20) is fitted: current generation and total generated, reported to Homey's Energy tab as **production**. |

You choose which devices (and which features within them) to add during pairing, and you can change the
selection later via the device's **Repair** flow. Devices/features your pump doesn't have are offered but
left unchecked.

## How each device works

### Main — the pump itself
- **Operating priority** — what the pump is doing *right now* (heating / hot water / pool / cooling / idle),
  plus a Flow trigger that fires on every switch and explains **why** in plain language. See
  [Flow cards](#flow-cards).
- **Operating mode** — Auto / Manual / Immersion heater only.
- **Smart Price Adaption** — the whole-pump on/off (menu 7.1.10), and a status naming which function it is
  adapting right now. Each function device carries its own on/off and influence; this is the master above
  them.
- **Total energy** produced and consumed, and **Total COP** (see below).
- **Energy consumed** and **Power** — on Main these are the pump's idle/parasitic draw (charged here rather
  than to a function), not the whole pump's; the true total is the sum across all your Nibe devices. This is
  Main's only entry in Homey's Energy tab.
- **Power** — current total draw, plus compressor and immersion heater power.
- **Diagnostics** — refrigerant temps (discharge, liquid line, suction gas), inverter temp, compressor
  frequency; **statistics** — compressor starts and runtime, immersion heater runtime; **phase currents**;
  **ground-source** brine in/out.
- **Alarms** — an alarm indicator plus the fault in plain language ("438: Lost connection to wireless
  device"), a **reset** button, a Flow trigger when a new alarm appears, the latest alarm in the device's
  settings, and the full history in the app's own **Alarms** settings page. See [Alarms](#alarms).
- **Compressor status**.
- **Immersion heater power**, **Immersion heater active** and its total runtime — the immersion heater is
  one piece of hardware with one set of readings, so those live here. Its *permits* do not: heating and hot
  water each have their own, on their own device (see below).
- Fuse rating; pump **firmware version** and **type code** in settings.

### Heating
- **Indoor temperature**, and which sensor it comes from — pairing states it outright, and asks you to choose
  when more than one sensor reports a plausible value.
- **Indoor temperature setpoint** — settable, and the same setting as menu 1.1 on the pump, so changing it
  here or there is one value. Together with the reading above this makes the device a **thermostat**: current
  and target on one tile, and a member of Homey's Climate view.
- **Outdoor temperature** and the **outdoor average**, which live here rather than on Main because the only
  things they are read against — the curve, and the summer cut-off — are heating's.
- **Smart Price Adaption** — on/off for heating, and how strongly the electricity price may move the indoor
  temperature (1–10). The whole-pump master and the status live on Main; every function device carries this
  same pair, so the feature reads identically wherever you open it.
- **Heat curve** (slope) and **offset**, as numeric values and as dropdown selectors.
- Supply/return and calculated-supply temperatures, flow, heating-pump speed.
- **Min/max supply**, and the **degree-minute** thresholds that start the compressor and the immersion heater.
- **Only heat below** / **only use immersion heater below** — the outdoor averages at which each stops, next
  to the **outdoor average** they are judged against.
- **Allow heating** toggle. Exhaust-air **ventilation (FTX)** folds in here if fitted.
- **Allow immersion heater** — Nibe's permit is heating-only ("Permit additional heat, heating"), so it lives
  here rather than on Main. It does **not** affect hot water, which has its own switch.
- Energy **used** + **delivered** + **Heating COP**.

### Hot Water
- **Demand mode** — Small / Medium / Large / Smart control.
- **Start/stop temperatures for each of the three modes** (Small, Medium, Large) — see the quirk below.
- **Allow hot water** — the master on/off. Off disables *all* hot water (see quirks — it also
  blocks the manual boost).
- **More hot water** — a timed one-time boost (only usable while hot water is allowed).
- **Periodic hot water** — a scheduled anti-legionella charge every N days.
- **Allow immersion heater, hot water** — separate from the heating permit, and **off from the factory**. Without
  it the compressor charges the tank alone and stops where it can go no higher, which on a ground-source pump
  can be well below the temperature you asked for. Not present on S2125, S320/S325 or S735.
- **Smart Price Adaption** — on/off for hot water, and how strongly the price may shift charging (**1–4**
  here, not 1–10 like the others).
- Hot-water-circulation temperatures if that accessory is fitted.
- Energy **used** + **delivered** + **Hot Water COP**.

### Pool
- With the POOL 40 accessory: pool water temperature (BT51) and a settable target, so this is a
  **thermostat** too. Pool heating runs on a band — the pump heats to the *stop* temperature and restarts at
  the *start* temperature — so the dial sets **stop**, and a value that would cross *start* is refused.
- Start/stop setpoints, pool-pump status, period time, **Allow pool**.
- **Smart Price Adaption** — how strongly the price may shift pool heating (0–10, where 0 is not at all).
  Pool is the one function with no on/off of its own, because none is documented in any Nibe register map
  and the one address it could occupy is dead on hardware, so it follows the master on Main.
- Energy **used** + **delivered** + **Pool COP**.

### Cooling
- **Allow cooling**, night cooling, auto start/stop-cooling outdoor temperatures, cooling degree minutes.
- **Smart Price Adaption** — on/off for cooling, and how strongly the price may shift it (0–10).
- **Compressor runtime** spent on cooling. Nibe splits compressor runtime three ways and no further —
  lifetime total, hot water, cooling — so Heating and Pool have no runtime of their own, and deriving one
  from the remainder would fold in defrost and pool time.
- Energy **used** + **delivered** + **Cooling COP**.

### Solar
- Current generation and total generated, reported to Homey's Energy tab as **production**.

## Energy & efficiency (COP)

This is the heart of the app. Three related things, all measured **since you added the device** so the numbers
across devices reconcile:

- **Energy used** (electricity in). The pump reports one *total* instantaneous power draw and its current
  *operating priority* (heating / hot water / pool / cooling / idle). Every poll the app integrates that power
  into kWh and charges it to whichever function is active — so each function device gets its own consumption
  meter and appears individually in Homey's **Energy** tab. **Idle/standby draw** (circulation, electronics,
  year-round ventilation) is charged to **Main**, not to a function — so Heating's used energy (and COP)
  isn't polluted by the pump just sitting there. Functions (active) + Main (standby) still sum to the pump's
  true total in the Energy tab.
- **Energy delivered** (heat out). Read directly from the pump's per-function delivered-energy counters — so
  this is *measured*, not attributed. Main also shows the pump's own **total** produced and consumed counters.
- **COP** (coefficient of performance = heat delivered ÷ electricity used), computed over a **rolling 30-day
  window** so it tracks the season instead of sitting at a flat lifetime average. It needs a little runtime
  (and some consumption) before it settles.
  - **Total COP** on Main uses the pump's own production and consumption counters — *both* sides measured, so
    it's the most trustworthy figure.
  - **Per-function COP** (Heating / Hot Water / Pool / Cooling) divides that function's *delivered* energy
    (measured) by its *used* energy (attributed).

Because the pump exposes only a single *total* consumption figure, per-function **used** energy is
time-attributed by operating priority — a good estimate — whereas **delivered** energy and both sides of the
**Total COP** are read from the pump's own counters directly.

> **The full mechanism, with diagrams, lives in
> [`docs/energy-attribution.md`](docs/energy-attribution.md)** — how a watt gets assigned to one device, why
> the two COP derivations differ, and how accurate the attribution has actually measured (−0.8% on an
> instrumented hot-water cycle). That file is kept current with each release.

### Solar / PV

If the EME 20 accessory is present, Solar pairs as its own `solarpanel`-class device and reports current
generation (W) and cumulative generation (kWh) as **production** in Homey's Energy tab — separate from the
pump's consumption.

## Does it match myUplink?

Temperatures, states and settings: yes, exactly — same registers, no arithmetic. Energy totals: no, and
deliberately so. Counters are baselined at pairing, Main holds the *remainder* rather than the pump's total,
and per-function consumption is attributed rather than metered.

**[docs/FAQ.md](docs/FAQ.md)** answers this properly, along with blank COP, short-window comparisons that
look alarming, missing capabilities and Modbus write errors.

## Modes & quirks worth knowing

- **Hot water has three temperature pairs — one per demand mode.** Nibe keeps separate start/stop
  temperatures for Small (low), Medium (normal) and Large (high), and the current **demand mode** selects
  which pair is actually used. So editing "Hot water start (Medium)" only affects Medium — it does nothing
  while the mode is set to Small or Large. All three pairs are editable in the app.
- **Allow hot water is all-or-nothing.** Turning it off disables *all* hot water — and the pump then blocks
  the demand-mode and "More hot water" registers entirely (Modbus "Illegal Function"), so the manual boost
  can't be used either. For an **"auto off, manual boost only"** setup, keep Allow hot water **on** and set
  the *active* demand mode's **start temperature very low** (e.g. 5 °C) so automatic charging never triggers,
  while **More hot water** still works on demand.
- **"More hot water" is a *timed* boost.** The one-time increase raises the target for a number of hours (the
  simple toggle is a 2-hour boost; the duration selector offers 2/3/6/12/24/48 h). It only works while hot
  water is allowed.
- **Periodic hot water** is a separate scheduled high-temperature charge every N days (legionella
  prevention), independent of the demand mode.
- **The immersion heater is shared** between heating and hot water, so its permit and its
  power/step readouts live on **Main**, not on the Heating device.
- **Degree minutes** are the running heating deficit that drives the compressor: once low enough the
  compressor starts, and a further threshold brings in the immersion heater. Shown on the Heating device.
- **Operating mode (Auto / Manual / Immersion heater only)** on Main governs the whole pump; some manual-only
  settings (e.g. forced pump speeds) only take effect in Manual.
- **Energy is attributed, delivered is measured.** Used energy is charged to whichever function the pump is
  prioritising at each poll; **idle draw goes to Main** (so it doesn't wreck a function's COP — dividing
  real delivered energy by idle-inflated used energy gave nonsense). Delivered energy comes
  from the pump's own per-function counters, so *used* is a good estimate and *delivered*/*Total COP* are exact.
- **Unpaired functions fold into Main.** The draw is only charged to a function device if that device exists.
  If you haven't paired the Heating, Hot Water, Pool or Cooling device, the energy the pump uses while
  producing *that* function is attributed to **Main** instead (it lands in Main's Idle energy). So pair every
  function you want metered on its own — otherwise its consumption quietly folds into Main. (The app logs a
  warning when this happens, so a *missing* device doesn't go unnoticed.)
- **Energy figures are "since pairing."** Counters are baselined when you add the device, so per-device
  numbers reconcile with each other — they won't match the pump's lifetime totals in MyUplink.
- **One Modbus client.** The pump accepts a single Modbus TCP connection at a time; don't run another
  integration against it simultaneously.
- **Offer-all pairing.** Registers your model or accessories don't have are still offered, just left
  unchecked (detection saw no data). Adding one that isn't present does no harm — it simply reads nothing.

## Alarms

The pump reports faults as a bare **number**: register 1975 carries a code like `438` and nothing else.
Neither Nibe's Modbus register documentation nor the open-source register libraries map those numbers to
text, so the app ships **NIBE's own alarm-code database** — all **467 S-series codes**, generated by
`dev/fetch-alarms.mjs` and including NIBE's cause/suggested-action text.

> **The S- and F-series number their alarms differently, and it matters.** 301 codes appear in both lists
> and **300 of them mean different things** — `438` is "lost connection to wireless device" on S but
> "temporarily overheated inverter" on F; `163` is "incorrect phase sequence" on S but "high condenser in
> temperature" on F. Each driver is pinned to its own table.

The alarm register is deliberately surfaced as **text, not a number**: a numeric capability would make Homey
auto-generate "Alarm code becomes greater/less than" Flow triggers, which are meaningless for an unordered
fault code.

On the **Main** device:

- **Alarm active** — Homey's standard `alarm_generic` capability, so the pump gets native alarm treatment in
  the UI and works with Homey's built-in alarm Flow cards.
- **Alarm** — the fault in plain language: `438: Lost connection to wireless device` /
  `438: Tappad anslutning till trådlös enhet`, or `No alarm`.
- **An alarm occurred** — a Flow trigger carrying the description *and* the numeric code as tags, so a push
  notification can say what actually happened rather than just a number.
- **Reset alarm** — acknowledges an active alarm on the pump.
- **Latest alarm** — an at-a-glance line in the device's settings, pointing to the page below.
- **The app's "Alarms" settings page** — the full history, where each entry expands to NIBE's cause and
  suggested action, with a link to the source. (Homey device settings can only render a flat label, so the
  interactive view lives in the app's own settings.)

A code that isn't in the table still reads as `Alarm <n>` rather than blank, so a newer or model-specific
fault is never silently swallowed.

**Languages:** the alarm capabilities, Flow cards and the Alarms settings page are localized into all six
app languages. The **fault descriptions themselves are Swedish and English only** — NIBE publishes this
database on nibe.eu in Swedish alone, with no official edition in the other languages, so Swedish is NIBE's
own wording, English is our translation, and German/Dutch/Norwegian/Danish fall back to English rather than
to an unverifiable machine translation. **The fallback is always English, never Swedish**: NIBE's
cause/action text exists only in Swedish, so a Swedish user sees it inline while everyone else gets the
English summary plus an explicit, localized "show NIBE's original guidance (Swedish)" disclosure — the UI
never silently hands you a language you didn't ask for.

**Where the pump keeps more:** Modbus exposes only the *current* alarm number, so the app's log starts when
you install it. The pump itself keeps the 10 most recent alarms in **menu 3.4**, and **menu 7.9.2** can
export the extended alarm log to USB.

## Works across the S-series

The app drives everything from a single register table that is the **union** of the S-series models
(S1155/S1255, S1156/S1256, S2125, S320/S325, S330/S332, S735, …). Model differences are handled at runtime:
a register your model or accessory doesn't have simply isn't there, so detection leaves it out. (An
address means the same thing on every S-model — verified by cross-checking all six model register maps — so
one table is safe.) The pump's firmware version and type code are read on connect and shown in the Main
device's settings, which is handy for support.

**"Absent registers just drop out" is only true when nothing depends on them.** The energy allocator needs
*one* register — the pump's instantaneous power draw, 2166 — and that register does not exist on
S320/S325, S330/S332 or S2125. With no power reading the allocator was skipped wholesale, so on those
models every per-function energy meter and every COP stayed permanently empty, in complete silence. Three
things came out of that:

- **Power sources are an ordered fallback list**, not one register. Each entry is a group whose registers
  are summed (an inverter F needs compressor + electric addition); the first group that actually reads
  wins. S prefers 2166 and falls back to the energy log's 2305 — the two must not be summed, since a pump
  can carry both.
- **Detection asks whether a value is real, not merely present.** Register 2727 "Current power" looked like
  the obvious fallback — right title, right units, on all six models — but a live S1155 answers all 31 of 31
  reads with a flat zero straight through a 3.3 kW compressor run, because it belongs to the EME 20
  accessory. So a power source must have *moved or read non-zero* during detection to count, the same
  standard the `inRange` heuristics already applied to sensors.
- **`dev/audit-registers.mjs` checks both directions.** It lists registers present in the CSVs but not the
  app, reports which mapped registers are absent per model, calls out **engine-critical** ones (power
  sources, priority, energy counters, each role's primary on/off) separately, and cross-checks every declared
  width against the CSVs. That width check matters: a counter of *tenths* of an hour read as 16-bit wraps at
  6553.5 h.

Known model gaps that have no fallback: register 195 "Hot water permitted" is absent on **S2125,
S320/S325, S330/S332 and S735**, so the Hot Water device on those pumps has no on/off control — the pump
does not expose that setting over Modbus. Cooling and pool delivered-energy counters (1579/1581) are
likewise missing on several models, which removes that function's COP but nothing else.

## When something has no data

Every value in the app comes from a register, and a register your pump doesn't implement simply never
answers. Rather than leaving the capability blank with no explanation:

- The **first time** a register fails, it is named in the app log with its address, batched into one line
  per poll. Scoped to the app start, not to the process's whole life, because a register missing on your
  model fails on the very first poll — long before anyone thinks to turn on debug logging.
- If **no** power source reads at all, the log says so explicitly and states the consequence, rather than
  leaving you to work out why the energy figures never move.
- Turning on **Debug logging** (Advanced settings) restates everything still failing, so a log you send for
  support contains the cause even though it happened hours before you enabled it. It also logs which
  register each capability was mapped to at pairing — including what the *derived* ones (Energy used,
  Current power, the COP sensors) are computed from, which is otherwise unknowable from the outside.

## Requirements

- A Nibe S-series heat pump on the same local network as your Homey.
- **Modbus TCP enabled** on the pump: menu **7.5.9**.
- Homey Pro (SDK 3, runs locally).

## Pairing

1. Add device → **Nibe S-Series**.
2. **Find your pump** — autodetect sweeps your local subnet for pumps, or enter the IP address manually.
3. **Detection** samples the pump's registers for ~30 s to see which functions and accessories are live.
4. **Choose devices & features** — every function device is listed, pre-checked where data was detected;
   expand any to fine-tune which capabilities it carries. Add one or all.

Re-run pairing any time to add more function devices to a pump you've already set up, or use a device's
**Repair** flow to change its feature selection later.

Detection also settles **where** a register lives: a few of them sit at a different address on some models,
and one — room temperature on the S735 — answers at its documented address with a permanent "no value" while
the real reading sits at an undocumented one. Detection tries the alternates, keeps whichever actually reads,
and stores the answer with the device. **[docs/pairing.md](docs/pairing.md)** has the flow as a diagram, what
detection decides, and how to pick a resolved address up on a device you already paired (run Repair).

## Flow cards

Generic, register-driven cards rather than one per sensor: set any writable value, enable/disable a feature,
compare a reading, and triggers for when a value changes or a toggle flips. On top of those, dedicated cards
where a named card is clearer: every numeric setting has a **"set …"** action, every switch has its own
**on/off** action, enum settings (hot-water mode, operating mode, …) get their own cards, and there is an
**"An alarm occurred"** trigger with the alarm description as a tag.

**"Operating priority changed"** fires on the Main device whenever the pump switches what it is producing
(hot water → heating → off → …), with the new and previous priority as tags plus a **reason** tag that says
*why*, in plain language:

> The house fell behind on heat: degree minutes are down to -60, at or past the -60 threshold that starts
> the compressor. The supply line is 34.2 °C against a calculated 35.1 °C.

> Hot water ran down to 43.6 °C, reaching the 44.0 °C start point for Medium demand.

> The house has caught up on heat — degree minutes are back to 0 (the compressor restarts at -60). Heating
> stays off anyway while it is 17.3 °C outside (the limit is 17.0 °C).

Nibe publishes no "why did it do that" register — the control logic is internal — but the decision comes
down to a handful of readable comparisons (degree minutes against the compressor start threshold, the tank
against its demand-mode start point, the outdoor cut-off), so the app reads those at the moment of the
change and reports the one that actually fired, with the numbers that justify it. It mentions the electric
addition or an SG Ready price signal only when they are genuinely affecting the outcome. The same sentence
is appended to the `Priority change:` entry in the app log when **Debug logging** is on.

Each device's **on/off is a real control**: on a function device it is that function's *Allow* register
(Allow heating / hot water / pool / cooling), so turning the device off disables that function on the pump.
Main is always on — the pump has no whole-unit on/off; its equivalent is the **operating mode**.

## Notes & limitations

- Modbus TCP has no discovery protocol and Nibe pumps don't advertise themselves, so "autodetect" is a subnet
  sweep of port 502 verified by reading the outdoor-temperature register.
- The pump accepts only **one Modbus client**, so run only one integration against it at a time.
- COP and the rolling window build up over time; expect the first useful readings after the pump has run
  through some heating/hot-water cycles.
- The **alarm log** is the app's own record, covering the time it has been running — Modbus exposes only the
  *current* alarm number, not the pump's internal alarm history, so it can't be backfilled.
- Logging is deliberately quiet: by default only pairing, Flow actions, manual changes, alarms and errors are
  logged. Turn on **Debug logging** (device settings → Advanced) for polling, connection and energy detail
  before collecting logs for support.
- Changing settings affects a live heating system. The changes are the same ones available in the MyUplink
  app, but be careful when automating them. Provided as-is, with no warranty.

## Releases

Newest first. The user-facing wording lives in `.homeychangelog.json` (shown in the Homey app store);
this table is the engineering view — what changed and, where it matters, why. The reasoning behind a register's address or a detection rule lives in [`docs/`](docs/); the trail of what was measured and rejected lives in [`tasks/`](tasks/).

| Version | Highlights |
|---|---|
| **0.9.15** | **Smart Price Adaption, completed symmetrically.** 0.9.13 shipped it half-built: `845` (heating influence) was a `measure_count_NIBE`, which is `setable: false`, and both it and `1918` carried `"uiComponent": null` — invisible in the device UI and reachable only through the generic numeric Flow action. Every function now carries the same pair, an **enable** and an **influence**: heating `844`/`845` (1–10), hot water `846`/`902` (**1–4**, not 1–10), pool `—`/`848` and cooling `849`/`850` (both 0–10). Pool is the one gap and it is Nibe’s: no pool enable is documented in any of the six model CSVs or in yozik04/nibe, **and holding `847` — the one address it could occupy, since the block is otherwise a strict activated/influence sequence — does not answer on a live S1155** (a raw scan of 840..855 hit 842-846 and 848-854 and skipped it). Worth checking rather than assuming, because a register absent from every source is exactly how 2505 hid as `id:12801`. Nor is that an artefact of the test pump lacking POOL 40: it has no cooling either, yet `849` (cooling activated) answers and reads 1, so these registers are not gated on fitted hardware. Pool therefore follows the master at `843`, which lands on Main: it had sat on Heating since 0.9.13, when there was no per-function enable to confuse it with, and adding one left two toggles named Smart Price Adaption on the same device. The whole family moves into a new **`price` feature group**, spread across devices by `role` exactly as the per-function energy meters are, so one checkbox at pairing governs all of it. That placement is deliberate over the obvious `core`: `deviceTemplate()` skips core when writing "this register never answered" overrides, because core is the fixed baseline — so a control parked there can never be dropped by detection, and this release found two registers (`1914`, `902`) that Nibe documents for the S1155 and the firmware does not implement. Titles drop the redundant "for heating"/"on cooling" now that the device itself says which function you are looking at, and the hot water immersion runtime loses its ", hot water" suffix for the same reason. **Insights is trimmed to things that actually move**: the seven hot water start/stop setpoints, the two period times and the three degree-minute thresholds were all charting flat lines, and the SPA status enum no longer carries a `secondary` numeric twin — that twin exists only to make an enum chartable, which is not worth a second capability here. On/off histories stay, since when a permit or Smart Price Adaption changed is often what explains the rest. **Cooling gains `279`, compressor runtime**, which Nibe publishes and this app had never mapped; runtime is split three ways only — total, hot water, cooling — so Heating and Pool genuinely have none. **The enables are not the booleans their titles imply** — `844` is documented 0–3 and `846` 0–4, and on a live S1155 `846` was watched going 0 → 4 → 0 as hot water adaption was toggled on the pump’s own panel, with `844` sitting steady at 3: in both cases “on” is the register’s documented *maximum*, handled by `onValue`/`offValue` the way 697’s boost already is. **A picker register must not also carry `scale`**: `fromRegisterValue` tests `scale` before `picker` and would hand an enum capability a number, which is why heat curve has no scale — and no Flow card either, since `set_numeric_value` filters on `scale > 0`. Pairing `enum` **with** `picker`, as register `237` does, buys both a dropdown and a dedicated `.enum` card. **`1918` speaks the operating-priority code space**, so it is now a labelled enum on `priorityMap` rather than a bare number: it read 30 (“Heating”) while adapting heating and 10 (“Off”) the moment the master was cut, with a `secondary` numeric twin for Insights since Homey cannot chart a string. That decoding is original — yozik04/nibe, the library behind Home Assistant’s integration, carries **no enums at all**, not even for priority or operating mode. The per-function **offsets are deliberately not capabilities**. `1914` (heating) does not answer on this firmware despite being documented for the S1155/S1255, which would have left a live impact figure on pool and cooling but not on heating or hot water; a measurement that exists for some functions and not others is worse than none. It also sidesteps an unsettled question — Nibe’s CSV and yozik04/nibe both give `1916`/`1917` factor 1 while both give `1914` factor 10, and neither states a unit, so raw 14 and −7 are either +14 °C or +1.4 °C and nothing on hand decides which. `851` (“area”, read 22) stays out for the same reason. `dev/probe-spa.mjs` carries the probe, including a `--scan` mode that walks raw address ranges because a CSV-driven sweep cannot find what the CSV omits — though the lesson from `1919`, briefly mistaken for the missing heating offset, is to grep the CSV *by address* first: it is the brine pump dT, and always was. |
| **0.9.14** | **Fixes energy sometimes landing on the wrong device.** The operating-priority register (1028) was observed reading idle (10) throughout a genuine, demand-driven heating cycle — degree minutes crossing the compressor-start threshold, real compressor draw, the produced-energy counter advancing — while an undocumented second register in the energy-log block, **3804**, correctly named the active function the whole time. Confirmed independently live: myUplink's own "Priority" reading agreed with 3804, not 1028, within about a second of the transition. `applyEnergyLogPriorityOverride()` now corrects the raw value once, in `poll()`, before the tile, the `priority_changed` trigger, the reset rules and the energy allocator each read it — so all four stay consistent rather than four separate judgment calls. Only overrides an *idle* 1028 reading; an active one (hot water/heat/pool/cooling) is left alone — a live "More hot water" boost had 1028 and 3804 agree in the same poll, so there's no evidence to act on that direction. Absent on S2125, S320/S325 and S330/S332 (per third-party register dumps) — falls back to 1028 alone there, unchanged. Also fixes a batch of register reads occasionally failing right after a write: reads and writes shared one Modbus client with nothing serializing them, and a write landing mid-poll could collide with the read batch — confirmed 100% correlated live, now impossible by construction (`withWireAccess()`). Separately measured and documented (no code change): cancelling a "More hot water" boost stops the request immediately, but a compressor cycle already running finishes regardless — normal short-cycling protection, not a bug; toggling "Allow hot water" off/on does force a stop but is deliberately not automated, since doing that on every cancellation is likely worse for the compressor than letting it finish. |
| **0.9.13** | **Breaking — run Repair on every device.** **Heating and Pool became thermostats** — current and target temperature on one tile, and Heating joins Homey's Climate view. The indoor setpoint is holding **2505**, untitled as `id:12801` on five of the six model maps, which is why it was never mapped; it is *not* register 206, which accepts writes the controller then ignores. Writing a 32-bit register turns out to need one exact shape — a two-word FC16 assembled **high word first**, the opposite of the read order — while the other three shapes are acknowledged and silently discarded, so a partial test looks identical to a read-only register. Room temperature was reading climate system **6** (111) rather than **1** (116) and was blank on most pumps; where several sensors are live, pairing now asks which one regulates. Mechanism and evidence from [halderex's PR #5](https://github.com/lovethyresson/com.nibe.local/pull/5). **Energy meters move from register 2166 to 2305**, the source the pump uses for its own hourly books — measured to be exactly what myUplink publishes (halderex, 2293 vs 25138: 0.930 vs 0.93). 2166 ran ~3% low on hot water across two models and missed the exhaust-air fan entirely on an S735 (10 W against 50 W at idle); the live tile stays on 2166, which is unfiltered. Operating mode becomes settable — which matters because the immersion permit (180) is titled "Permit additional heat, heating" in the CSV but is really *"Allow add.heat (at operation mode manual)"*, so it does nothing in Auto. Six capabilities that showed one setting twice are collapsed to one, and Nibe's "additional heat"/"additive" wording is standardised on **immersion heater**. Indoor and outdoor temperatures moved onto Heating, beside the cut-off they are judged against; Smart Price Adaption is exposed; three registers dropped as uninterpretable. Three crash classes fixed: read-only registers rendered as clickable toggles, a picker handed a value outside its declared list, and a picker that also carried an enum decoding to the label rather than the id. Capabilities now have a declared reading order per device — set on the list the pairing picker submits, which is what a device stores and renders, not the manifest. The Hot Water tile's on/off state follows "Allow hot water" again: a tile's on/off appearance *is* its quick action, so pinning "More hot water" there had silently cost it. Pump-side changes are logged, so a schedule or panel edit is visible rather than silent — which is what a year-old "block additional heat" schedule had been hiding. |
| **0.9.12** | Fixed per-function COP reporting impossible figures (a hot-water COP of 15): the delivered-heat counter ran unobserved while the electricity side only advanced when the app was watching, so weeks of heat were divided by hours of measurement. Both sides now cover the same span, and poisoned history is discarded rather than migrated. Adds the pump's own hourly per-function energy log as an hourly self-check on the allocator — measurement only, no correction: an instrumented hot-water cycle came in at −0.8%. Registers can declare **alternate addresses**, resolved once during detection, for the handful that live elsewhere on some models (room temperature on the S735, pump speed, night cooling, the pulse meter). Evidence and mechanism from [halderex](https://github.com/lovethyresson/com.nibe.local/pull/3). |
| **0.9.11** | Enabling Debug logging dumps every register the model knows — raw *and* decoded, including ones the feature selection has switched off. Nearly every bug found so far was "the pump doesn't report what we assumed", each costing several round-trips with a user; this makes one report enough. Main only (the debug setting mirrors to all five devices), sequential reads, grouped into a dozen long lines rather than a hundred short ones, and re-emitted on debug-enable so it lands at the end of a rolling buffer rather than the start. |
| **0.9.10** | Diagnostics for energy that looks wrong. An operating-priority code the model doesn't map, or a function whose device isn't paired, silently booked that function's electricity as idle on Main — both are now logged plainly instead of only under debug. On models that expose it, the pump's energy-log inclusion settings (menu 3.1) are reported, since they're configured on the pump and change what the totals mean. Optional lookups (firmware, those settings) no longer masquerade as failed registers. Store description shortened per Homey app review. |
| **0.9.9** | Per-function energy and COP on the split models. Register 2166 doesn't exist on S320/S325, S330/S332 or S2125, so the allocator was skipped wholesale and every per-function meter and COP stayed empty in silence. Power sources became an ordered fallback list (2166 → 2305, first that reads wins, never summed). Read failures and missing power sources are logged; detection learned that a register *answering* isn't a register *working*; repair lets a fresh detection pass un-tick capabilities; seven registers documented as 32-bit were being read as 16-bit. |
| **0.9.8** | Alarms in plain language with NIBE's own cause/action text, an Alarms settings page and an "alarm occurred" trigger. Each device's on/off became its "Allow" function; Main pinned on. Debug-logging switch. Operating-priority-changed trigger with a plain-language reason. **Breaking — re-pair required.** |
| **0.9.7** | Fixed idle-energy misattribution: a device whose capability setup threw in `onInit` never subscribed to the pump, so the allocator charged its draw to Main. |
| **0.9.6** | New app icon and store imagery after the v0.9.5 store rejection, plus a refreshed pairing flow (animated search/detection icons, NIBE-red progress bars). |
| **0.9.5** | Hot water on/off and per-mode start/stop temperatures. Idle draw tracked as standby energy on Main, so per-function COP stops absorbing it. Write errors surfaced to the user instead of swallowed. |
| **0.9.4** | Pairing logic rewritten. PV/Solar support, per-function produced energy, and rolling 30-day COP per device — the release that made the energy features real. |
| **0.9.3** | Polling frequency exposed in advanced settings. |
| **0.9.2** | Fixed images. |
| **0.9.1** | New app name, fixed icons. |
| **0.9.0** | First release on the Homey App Store. |

> **Keep this current.** Add a row here as part of every release, alongside the version bump in
> `.homeycompose/app.json` + `package.json` and the user-facing entry in `.homeychangelog.json`.

## Credits

- Original app: [Jan Sparud](https://github.com/sparud).
- Local multi-device rework, per-function energy, delivered-energy/COP, Solar device and S-series coverage:
  Love Thyresson.
- [Henrik Aldermo (halderex)](https://github.com/halderex) — independent verification of the per-function
  energy log on a Nibe S735 (against MyUplink on the same hardware), which corrected our reading of both
  standby attribution and the lifetime counters' timing; and the register-fallback mechanism behind
  [alternate address resolution](docs/pairing.md), found via a room-temperature sensor that reads at an
  undocumented address on the S735.
- Register definitions cross-checked against [yozik04/nibe](https://github.com/yozik04/nibe)
  (GPL-3.0), a per-model Modbus register library for Nibe heat pumps — used as a reference
  to verify addresses, scales and ranges across the S-series; no code is bundled from it.
- Alarm-code descriptions transcribed from NIBE's own published alarm list ("Alarm overzicht", nibe.eu,
  November 2018), which is the only source that maps the alarm register's numbers to text.

Not affiliated with or endorsed by NIBE Energy Systems.
