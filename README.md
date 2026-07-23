# Nibe Heatpumps (local Modbus, multi-device)

A [Homey](https://homey.app/) app that talks **directly to Nibe S-series heat pumps over Modbus TCP** on your
local network — no MyUplink cloud account required. A single physical pump is paired as **several logical
devices**, one per function, each with its own capabilities, its own energy meters, and its own **efficiency
(COP)**.

> Forked from [sparud/net.sparud.nibe_s](https://github.com/sparud/net.sparud.nibe_s) (by Jan Sparud) and
> reworked into a local, multi-device app with per-function energy tracking, delivered-energy and COP
> readings, a Solar/PV device, and broad S-series coverage.

## Why multiple devices?

One heat pump serves several jobs — heating, hot water, pool, cooling — that you usually want to see and
automate separately. This app pairs each as its own Homey device:

| Device | What it carries |
| --- | --- |
| **Main** | The pump itself: outdoor temperature, operating priority and mode, diagnostics, runtime statistics, phase currents, ground-source (brine) temperatures, alarm code, compressor status — plus **total energy produced/consumed**, **Total COP**, **standby energy** (idle draw), and the pump's firmware/type in settings. |
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
- **Operating priority** — what the pump is doing *right now* (heating / hot water / pool / cooling / idle).
- **Operating mode** — Auto / Manual / Add-heat only.
- **Total energy** produced and consumed, and **Total COP** (see below).
- **Standby energy** and **Standby power** — the pump's idle/parasitic draw (charged here instead of to a
  function); this is Main's only entry in Homey's Energy tab.
- **Power** — current total draw, plus compressor and internal-additive power.
- **Diagnostics** — refrigerant temps (discharge, liquid line, suction gas), inverter temp, compressor
  frequency; **statistics** — compressor starts and runtime, additive runtime; **phase currents**;
  **ground-source** brine in/out.
- **Alarm code** + reset, **compressor status**.
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
  year-round ventilation) is charged to **Main as "Standby energy"**, not to a function — so Heating's used
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

## Works across the S-series

The app drives everything from a single register table that is the **union** of the S-series models
(S1155/S1255, S1156/S1256, S2125, S320/S325, S330/S332, S735, …). Model differences are handled at runtime:
a register your model or accessory doesn't have simply isn't there, so detection leaves it out. (An
address means the same thing on every S-model — verified by cross-checking all six model register maps — so
one table is safe.) The pump's firmware version and type code are read on connect and shown in the Main
device's settings, which is handy for support.

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
compare a reading, and triggers for when a value changes or a toggle flips. Enum settings (hot-water mode,
operating mode, …) get their own dedicated cards.

## Notes & limitations

- Modbus TCP has no discovery protocol and Nibe pumps don't advertise themselves, so "autodetect" is a subnet
  sweep of port 502 verified by reading the outdoor-temperature register.
- The pump accepts only **one Modbus client**, so run only one integration against it at a time.
- COP and the rolling window build up over time; expect the first useful readings after the pump has run
  through some heating/hot-water cycles.
- Changing settings affects a live heating system. The changes are the same ones available in the MyUplink
  app, but be careful when automating them. Provided as-is, with no warranty.

## Credits

- Original app: [Jan Sparud](https://github.com/sparud).
- Local multi-device rework, per-function energy, delivered-energy/COP, Solar device and S-series coverage:
  Love Thyresson.
- Register definitions cross-checked against [yozik04/nibe](https://github.com/yozik04/nibe)
  (GPL-3.0), a per-model Modbus register library for Nibe heat pumps — used as a reference
  to verify addresses, scales and ranges across the S-series; no code is bundled from it.

Not affiliated with or endorsed by NIBE Energy Systems.
