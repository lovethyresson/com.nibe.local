# Nibe Live

**Control your Nibe heat pump from Homey, over your own network — no cloud account, no waiting.**

A [Homey](https://homey.app/) app for **Nibe S-series** heat pumps. It talks to the pump directly over
Modbus TCP on your local network, so it keeps working when myUplink is down or your internet is out, and
readings update in seconds rather than minutes.

The thing that makes it different: **one pump becomes several devices** — Heating, Hot Water, Pool, Cooling,
Solar — so you can see and automate each job on its own, and see **what each one actually costs**.

> Forked from [Jan Sparud's Nibe S-series app](https://github.com/sparud/net.sparud.nibe_s), reworked into a
> local, multi-device app with per-function energy tracking, COP, alarms in plain language, and broad
> S-series coverage.

---

## Why one pump becomes several devices

Your pump does several jobs, and you almost never want to automate them together. "Boost hot water when
power is cheap" has nothing to do with your heating curve. But a single device tile mixes all of it into one
long list of settings.

So each job gets its own device, with its own controls, its own energy meter, and its own efficiency figure:

| Device | What it's for |
| --- | --- |
| **Main** | The pump itself — what it's doing right now, operating mode, alarms in plain language, diagnostics and runtime stats. Carries the pump's total energy, **Total COP**, and the master switch for price adaption. |
| **Heating** | A proper thermostat: room temperature and setpoint on one tile, in Homey's Climate view. Heat curve, supply temperatures, the outdoor cut-offs. Ventilation folds in here if fitted. |
| **Hot Water** | Demand mode, the temperatures behind it, one-time boosts, periodic (anti-legionella) charging. |
| **Pool** | A thermostat for pool water, if you have the POOL 40 accessory. |
| **Cooling** | Cooling permit, night cooling, the outdoor temperatures that start and stop it. |
| **Solar** | If you have the EME 20 accessory: what your panels are making, reported to Homey's Energy tab as **production**. |

Every heat-producing device also carries **energy used**, **energy delivered**, its own **COP**, and its own
**price adaption** controls.

You pick which devices to add during pairing — add one, add all — and you can change your mind later with
the device's **Repair** flow. Anything your pump doesn't have is offered but left unticked.

## Know what each job actually costs

Your pump reports one total power draw. This app splits it by what the pump was doing at the time, so
**Heating, Hot Water, Pool and Cooling each get their own meter in Homey's Energy tab** — and you can finally
answer "how much is my hot water costing me?"

- **Energy used** — electricity in, charged to whichever job was running. Standby draw goes to **Main**, so
  sitting idle doesn't get blamed on your heating.
- **Energy delivered** — heat out, read straight from the pump's own counters. Measured, not estimated.
- **COP** — heat out ÷ electricity in, over a rolling 30-day window, so it tracks the season instead of
  flattening into a lifetime average. Give it a few days of running before you judge it.

**Total COP** on Main is the most trustworthy number, because the pump measures both sides of it itself.

> Used energy is a good estimate; delivered energy and Total COP are exact. The full mechanism, the diagrams
> and how accurate the split actually measured (−0.8% on an instrumented hot-water cycle) are in
> **[docs/energy-attribution.md](docs/energy-attribution.md)**.

## Shift usage to cheaper hours

If you're on an hourly electricity tariff, the pump can lean its work toward the cheap hours by itself —
Nibe calls it **Smart Price Adaption**. The app exposes it per job, so you decide how much the price is
allowed to push each one around:

| | On/off | How strongly the price may move it |
| --- | --- | --- |
| **Heating** | yes | 1–10 |
| **Hot Water** | yes | 1–4 |
| **Pool** | follows the master | 0–10 (0 = not at all) |
| **Cooling** | yes | 0–10 |

The **master switch for the whole pump** lives on the Main device — turn that off and none of it applies.
Pool is the one function without its own on/off, because Nibe doesn't publish one for it on any S-series
model, so it follows the master.

All of it works from a Flow, so you can tie the influence to something else you know — a price forecast,
whether you're home, or the time of year.

> Your pump is only given the parts it actually answers for. If a control doesn't appear for one of your
> functions, the pump didn't report it during detection — which is normal, and varies by model and firmware.

## Know why it did that

Heat pumps are opaque. This app makes two of the most annoying things legible.

**Alarms in words, not numbers.** The pump reports faults as a bare code like `438`. The app ships NIBE's own
database of all 467 S-series codes, so you get *"438: Lost connection to wireless device"* — plus a Flow
trigger with the description as a tag, so a phone notification tells you what actually happened. NIBE's own
cause-and-action text is there too, in the app's **Alarms** page.

**Why the pump switched.** A Flow trigger fires whenever the pump changes what it's producing, and it
explains itself:

> The house fell behind on heat: degree minutes are down to −60, at or past the −60 threshold that starts the
> compressor. The supply line is 34.2 °C against a calculated 35.1 °C.

> Hot water ran down to 43.6 °C, reaching the 44.0 °C start point for Medium demand.

Nibe publishes no "why" register — the app reads the handful of values the decision actually turns on and
reports the one that fired.

## Getting started

**You need**

- A Nibe S-series heat pump on the same network as your Homey
- **Modbus TCP switched on** at the pump: menu **7.5.9**
- Homey Pro

**Then**

1. Add device → **Nibe S-Series**
2. **Find your pump** — it sweeps your network for you, or type the IP yourself
3. **Detection** watches the pump for ~30 seconds to see which functions and accessories are really there
4. **Choose your devices** — pre-ticked where data was found; expand any to fine-tune what it carries

Run pairing again any time to add more devices for the same pump. **[docs/pairing.md](docs/pairing.md)** has
the flow as a diagram and explains what detection decides.

## Automating it

Every writable setting works from a Flow. There are generic cards (set any value, flip any switch, compare
any reading) plus named ones where that reads better — every switch has its own on/off action, dropdown
settings get their own cards, and there's an **"An alarm occurred"** trigger.

**Each device's on/off is a real control**: switching the Hot Water device off turns off hot water on the
pump. Main is always on, because the pump has no whole-unit off switch — its equivalent is the operating
mode.

## Good to know

A few things that surprise people, none of which are bugs:

- **"Allow hot water" is all-or-nothing.** Off blocks the manual boost too. If you want *"no automatic
  charging, boost on demand"*, leave it on and set the active demand mode's **start temperature very low**
  (say 5 °C) — automatic charging never triggers, **More hot water** still works.
- **Hot water has three temperature pairs**, one per demand mode (Small / Medium / Large). Editing the Medium
  pair does nothing while you're in Small.
- **The pump refuses writes to a feature it has switched off.** Turn "Allow hot water" off and the pump
  rejects the demand-mode and boost registers outright ("Illegal Function") rather than ignoring them — so a
  Flow that sets one will report an error. The same goes for price adaption: its per-function influence is
  only writable while that function's adaption is switched on.
- **Pair every function you want metered.** If you skip the Hot Water device, the energy the pump spends on
  hot water lands on Main instead. The app logs a warning when that happens.
- **Energy counts from when you added the device**, so the numbers reconcile with each other rather than
  matching myUplink's lifetime totals.
- **The pump accepts one Modbus connection at a time.** Don't point another integration at it simultaneously.
- **Changing settings changes a live heating system.** Same settings myUplink gives you, but automate with
  care. Provided as-is, no warranty.

**Does it match myUplink?** Temperatures, states and settings: exactly. Energy totals: deliberately not —
**[docs/FAQ.md](docs/FAQ.md)** explains why, along with blank COP figures and other things worth asking about.

## Which pumps

The whole S-series: S1155/S1255, S1156/S1256, S2125, S320/S325, S330/S332, S735 and relatives. One register
table covers them all, and detection quietly drops whatever your model doesn't have.

Two known gaps, both Nibe's rather than the app's: **"Allow hot water" doesn't exist over Modbus on S2125,
S320/S325, S330/S332 or S735**, so the Hot Water device has no on/off there; and pool/cooling delivered-energy
counters are missing on several models, which removes that function's COP but nothing else.

## Something looks empty?

A value your pump doesn't report simply never answers, and the app says so in its log rather than leaving you
guessing — including which register each capability was mapped to. Turn on **Debug logging** (device settings
→ Advanced) before collecting logs for support and it will restate everything still failing.

## Documentation

| | |
| --- | --- |
| [docs/FAQ.md](docs/FAQ.md) | Common questions — myUplink differences, blank COP, write errors |
| [docs/pairing.md](docs/pairing.md) | Pairing and detection, with diagrams |
| [docs/energy-attribution.md](docs/energy-attribution.md) | How a watt gets assigned to a device, and how accurate it is |
| [docs/engineering.md](docs/engineering.md) | Alarm database, S-series coverage, diagnostics |
| [docs/releases.md](docs/releases.md) | Full engineering changelog, newest first |

**Support:** the [Homey Community thread](https://community.homey.app/t/app-pro-nibe-live-local-nibe-control-split-into-the-devices-you-actually-automate/157330)
· **Bugs:** [GitHub issues](https://github.com/lovethyresson/com.nibe.local/issues)

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
