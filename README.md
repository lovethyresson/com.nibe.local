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
| **Main** | The pump itself: outdoor temperature, operating priority and mode, diagnostics, runtime statistics, phase currents, ground-source (brine) temperatures, alarm code, compressor status — plus **total energy produced/consumed** and **Total COP**, and the pump's firmware/type in settings. |
| **Heating** | Heat curve, supply/return temperatures, degree minutes, ventilation (if fitted) — plus **energy used**, **energy delivered**, and **Heating COP**. |
| **Hot Water** | Hot-water temperatures, demand mode, one-time boosts, periodic hot water, circulation (if fitted) — plus **energy used**, **energy delivered**, and **Hot Water COP**. |
| **Pool** | Pool temperature, start/stop setpoints, pump status — plus **energy used**, **energy delivered**, and **Pool COP**. |
| **Cooling** | Cooling permit, night cooling, auto start/stop temperatures — plus **energy used**, **energy delivered**, and **Cooling COP**. |
| **Solar** | If a PV/self-consumption accessory (EME 20) is fitted: current generation and total generated, reported to Homey's Energy tab as **production**. |

You choose which devices (and which features within them) to add during pairing, and you can change the
selection later via the device's **Repair** flow. Devices/features your pump doesn't have are offered but
left unchecked.

## Energy & efficiency (COP)

This is the heart of the app. Three related things, all measured **since you added the device** so the numbers
across devices reconcile:

- **Energy used** (electricity in). The pump reports one *total* instantaneous power draw and its current
  *operating priority* (heating / hot water / pool / cooling / idle). Every poll the app integrates that power
  into kWh and charges it to whichever function is active — so each function device gets its own consumption
  meter and appears individually in Homey's **Energy** tab. (Idle/standby draw is charged to Heating.)
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
