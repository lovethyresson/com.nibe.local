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
- **Energy consumed** and **Power** — on Main these are the pump's idle/parasitic draw (charged here rather
  than to a function), not the whole pump's; the true total is the sum across all your Nibe devices. This is
  Main's only entry in Homey's Energy tab.
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
- **The electric additive (immersion) heater is shared** between heating and hot water, so its permit and its
  power/step readouts live on **Main**, not on the Heating device.
- **Degree minutes** are the running heating deficit that drives the compressor: once low enough the
  compressor starts, and a further threshold brings in the additive heater. Shown on the Heating device.
- **Operating mode (Auto / Manual / Add-heat only)** on Main governs the whole pump; some manual-only
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
this table is the engineering view — what changed and, where it matters, why.

| Version | Highlights |
|---|---|
| **0.9.13** | Indoor temperature is now settable, and the reading of it was wrong. The setpoint is holding **2505**, not the obvious 206: Nibe's CSVs title the zone family only `id:12801`–`id:12840` (holding 2505–2583, step 2, s32), which is why searching the register maps for "zone" finds nothing but the `Zone N affected by ECS1` flags. Established by sweeping all 2065 registers of a live S1155 with 35 °C then 28 °C set in the myUplink app — 2505 followed both times and was the only register that did, and writing it drives real demand (DM −14.6 → −339.1, compressor start). 206/205/204/203 and 55 are **legacy** on zone firmware: they sit at their factory default with "Use room sensor" off and holding 2503 "External setting for adjustment migrated" reading 1, so exposing them would have shipped a control that silently does nothing. Reading side: 111 was primary on the mistaken belief the CSVs put BT50 there — it is climate system **6**, returns the sentinel on the maintainer's own pump, and its alternate 26 excepts, so the room-temperature tile was resolving to nothing at all. Climate system 1 is **116**. Since 116/111/26 are three different quantities rather than one relocated register, `altAddresses` (detection decides, silently) could not express it; registers can now declare **`sources`**, where every candidate is probed and two or more live ones become a radio group at pairing and repair — the case [`tasks/register-alternates.md`](tasks/register-alternates.md) scoped and left unbuilt. Zones 2–4 sit in a new **`zones`** group gated on a plausible setpoint, never on the register answering: on a single-zone pump 2507–2583 all respond, reading a flat 0 instead of their documented default of 20. Writes became width-aware — these are the first genuinely writable 32-bit registers, and `writeSingleRegister` would have left the high word untouched, working by accident for 5.0–35.0 and corrupting anything negative. The CSV's max of 300 for 2505 is wrong; the live register held 350. |
| **0.9.12** | Per-function COP was dividing two different spans of time: the delivered-heat counter is the pump's own and runs unobserved, while the electricity side only advances when the app is running *and* a power source reads. On a pump with no register 2166 that meant weeks of heat ÷ hours of measured electricity — 40 ÷ 2.64 = a reported "COP" of 14.96. The numerator now advances only in lockstep with the denominator; poisoned history is discarded rather than migrated. Maps the pump's own hourly per-function energy log (2283–2303) and the compressor-only counters (1583/1585) as internal registers, and reconciles the allocator against them every hour — **measurement only, no correction**: an instrumented 2.35 kWh hot-water cycle came in at −0.8%, so the corrector that earlier evidence seemed to justify was backed out (the +37% that motivated it was an artefact of comparing against a counter that lags an hour and quantises to 0.1 kWh). Registers can now declare alternate addresses, resolved once during detection and stored with the selection: room temperature answers only as the not-available sentinel at 111 on the S735 while undocumented 26 carries the real value, and pump speed / night cooling / the pulse meter relocate on other models. Mechanism and evidence from [halderex's PRs](https://github.com/lovethyresson/com.nibe.local/pull/3). Energy and pairing logic documented with diagrams under [`docs/`](docs/). |
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
