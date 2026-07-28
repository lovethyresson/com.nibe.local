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
| **Main** | The pump itself: outdoor temperature, operating priority and mode, diagnostics, runtime statistics, phase currents, ground-source (brine) temperatures, **alarms with readable descriptions**, compressor status — plus **total energy produced/consumed**, **Total COP**, **idle energy** (standby draw), and the pump's firmware/type in settings. |
| **Heating** | Heat curve, supply/return temperatures, degree minutes, ventilation (if fitted) — plus **energy used**, **energy delivered**, and **Heating COP**. |
| **Hot Water** | Hot-water temperatures, demand mode, one-time boosts, periodic hot water, circulation (if fitted) — plus **energy used**, **energy delivered**, and **Hot Water COP**. |
| **Pool** | Pool temperature, start/stop setpoints, pump status — plus **energy used**, **energy delivered**, and **Pool COP**. |
| **Cooling** | Cooling permit, night cooling, auto start/stop temperatures — plus **energy used**, **energy delivered**, and **Cooling COP**. |
| **Solar** | If a PV/self-consumption accessory (EME 20) is fitted: current generation and total generated, reported to Homey's Energy tab as **production**. |

You choose which devices (and which features within them) to add during pairing, and you can change the
selection later via the device's **Repair** flow. Devices/features your pump doesn't have are offered but
left unchecked.

## How each device works

### Main — the pump itself
- **Operating priority** — what the pump is doing *right now* (heating / hot water / pool / cooling / idle),
  plus a Flow trigger that fires on every switch and explains **why** in plain language. See
  [Flow cards](#flow-cards).
- **Operating mode** — Auto / Manual / Add-heat only.
- **Total energy** produced and consumed, and **Total COP** (see below).
- **Idle energy** and **Idle power** — the pump's idle/parasitic draw (charged here instead of to a
  function); this is Main's only entry in Homey's Energy tab.
- **Power** — current total draw, plus compressor and internal-additive power.
- **Diagnostics** — refrigerant temps (discharge, liquid line, suction gas), inverter temp, compressor
  frequency; **statistics** — compressor starts and runtime, additive runtime; **phase currents**;
  **ground-source** brine in/out.
- **Alarms** — an alarm indicator plus the fault in plain language ("438: Lost connection to wireless
  device"), a **reset** button, a Flow trigger when a new alarm appears, the latest alarm in the device's
  settings, and the full history in the app's own **Alarms** settings page. See [Alarms](#alarms).
- **Compressor status**.
- **Allow immersion heater** — the electric additive heater is shared between heating and hot water, so its
  permit and its power/step readouts live here, not on a function device.
- Fuse rating; pump **firmware version** and **type code** in settings.

### Heating
- **Heat curve** (slope) and **offset**, as numeric values and as dropdown selectors.
- Supply/return and calculated-supply temperatures, flow, heating-pump speed.
- **Min/max supply**, and the **degree-minute** thresholds that start the compressor and the additive heater.
- **Auto stop** outdoor temperatures for heating and for the additive heater.
- **Allow heating** toggle. Exhaust-air **ventilation (FTX)** folds in here if fitted.
- Energy **used** + **delivered** + **Heating COP**.

### Hot Water
- **Demand mode** — Small / Medium / Large / Smart control.
- **Start/stop temperatures for each of the three modes** (Small, Medium, Large) — see the quirk below.
- **Allow hot water** — the master on/off. Off disables *all* hot water (see quirks — it also
  blocks the manual boost).
- **More hot water** — a timed one-time boost (only usable while hot water is allowed).
- **Periodic hot water** — a scheduled anti-legionella charge every N days.
- Hot-water-circulation temperatures if that accessory is fitted.
- Energy **used** + **delivered** + **Hot Water COP**.

### Pool
- Pool temperature, start/stop setpoints, pool-pump status, period time, **Allow pool**.
- Energy **used** + **delivered** + **Pool COP**.

### Cooling
- **Allow cooling**, night cooling, auto start/stop-cooling outdoor temperatures, cooling degree minutes.
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
  year-round ventilation) is charged to **Main as "Idle energy"**, not to a function — so Heating's used
  energy (and COP) isn't polluted by the pump just sitting there. Functions (active) + Main (standby) still
  sum to the pump's true total in the Energy tab.
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

### Solar / PV

If the EME 20 accessory is present, Solar pairs as its own `solarpanel`-class device and reports current
generation (W) and cumulative generation (kWh) as **production** in Homey's Energy tab — separate from the
pump's consumption.

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
- **The electric additive (immersion) heater is shared** between heating and hot water, so its permit and its
  power/step readouts live on **Main**, not on the Heating device.
- **Degree minutes** are the running heating deficit that drives the compressor: once low enough the
  compressor starts, and a further threshold brings in the additive heater. Shown on the Heating device.
- **Operating mode (Auto / Manual / Add-heat only)** on Main governs the whole pump; some manual-only
  settings (e.g. forced pump speeds) only take effect in Manual.
- **Energy is attributed, delivered is measured.** Used energy is charged to whichever function the pump is
  prioritising at each poll; **idle draw goes to Main as "Idle energy"** (so it doesn't wreck a function's
  COP — dividing real delivered energy by idle-inflated used energy gave nonsense). Delivered energy comes
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
- **`dev/audit-registers.mjs` checks both directions.** It used to list registers in the CSVs but not the
  app; it now also reports which mapped registers are absent per model, calls out **engine-critical** ones
  (power sources, priority, energy counters, each role's primary on/off) separately, and cross-checks every
  declared width against the CSVs. That last check immediately found seven registers read as 16-bit that
  NIBE documents as 32-bit — one of which, the hot-water additional-heat hour counter, would have wrapped
  at 6553.5 h because it counts *tenths* of an hour.

Known model gaps that have no fallback: register 195 "Hot water permitted" is absent on **S2125,
S320/S325, S330/S332 and S735**, so the Hot Water device on those pumps has no on/off control — the pump
does not expose that setting over Modbus. Cooling and pool delivered-energy counters (1579/1581) are
likewise missing on several models, which removes that function's COP but nothing else.

## When something has no data

Every value in the app comes from a register, and a register your pump doesn't implement simply never
answers. That used to be invisible — reads were swallowed and the capability sat blank forever. Now:

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

## Credits

- Original app: [Jan Sparud](https://github.com/sparud).
- Local multi-device rework, per-function energy, delivered-energy/COP, Solar device and S-series coverage:
  Love Thyresson.
- Register definitions cross-checked against [yozik04/nibe](https://github.com/yozik04/nibe)
  (GPL-3.0), a per-model Modbus register library for Nibe heat pumps — used as a reference
  to verify addresses, scales and ranges across the S-series; no code is bundled from it.
- Alarm-code descriptions transcribed from NIBE's own published alarm list ("Alarm overzicht", nibe.eu,
  November 2018), which is the only source that maps the alarm register's numbers to text.

Not affiliated with or endorsed by NIBE Energy Systems.
