# Nibe Heatpumps (local Modbus, multi-device)

A [Homey](https://homey.app/) app that talks **directly to Nibe S-series heat pumps over Modbus TCP** on your
local network — no MyUplink cloud account required. A single physical pump is paired as **several logical
devices**, one per function, each with its own capabilities and its own energy meter.

> Forked from [sparud/net.sparud.nibe_s](https://github.com/sparud/net.sparud.nibe_s) (by Jan Sparud, with
> Kjell Blomberg) and reworked into a local, multi-device app with per-function energy tracking.

## Why multiple devices?

One heat pump serves several jobs — heating, hot water, pool, cooling — that you usually want to see and automate
separately. This app pairs each as its own Homey device:

| Device | What it carries |
| --- | --- |
| **Main** | Shared sensors: outdoor temperature, operating priority and mode, plus diagnostics/statistics/electrical/ground-source |
| **Heating** | Heat-curve, supply/return temperatures, degree minutes, ventilation (if present) |
| **Hot Water** | Hot-water temperatures, demand mode, one-time boosts, periodic hot water |
| **Pool** | Pool temperature, start/stop setpoints, pool pump status |
| **Cooling** | Cooling on/off (and its energy) |

### Per-function energy

The pump reports its **total** instantaneous power and its current **operating priority** (heating / hot water /
pool / cooling / off). Every poll, the app integrates the total power into kWh and charges it to the device that
matches the current priority. So each function device gets a real `meter_power` meter and shows up individually in
Homey's **Energy** tab — letting you compare, for example, how much energy goes to heating versus cooling over a
year. Standby/idle draw is charged to Heating.

## Requirements

- A Nibe S-series heat pump (S1155, S1255, S1156, S1256, …) on the same local network as your Homey.
- **Modbus TCP enabled** on the pump: menu **7.5.9**.
- Homey Pro (SDK 3, runs locally).

## Pairing

1. Add device → **Nibe Heatpumps**.
2. **Autodetect** scans your local subnet (using Homey's real netmask) for pumps and, if it finds one, moves on
   automatically. You can also enter the IP address manually.
3. **Detection** samples the pump's registers for ~30 s to see which functions are live.
4. **Device picker** lists all function devices, highlighting the ones data was detected for. Add any or all.

Re-run pairing any time to add more function devices to a pump you've already set up.

## Notes & limitations

- Modbus TCP has no discovery protocol and Nibe pumps don't advertise themselves, so "autodetect" is a subnet sweep
  of port 502 verified by reading the outdoor-temperature register.
- The pump accepts only **one Modbus client**, so run only one integration against it at a time.
- The **model name is not available over Modbus** — enter it manually in the device's advanced settings if you want
  it recorded.
- Changing settings affects a live heating system. The changes are the same ones available in the MyUplink app, but
  be careful when automating them. Provided as-is, with no warranty.

## Development

```bash
npm install
npm run build          # tsc
npx homey app validate # validate app.json / compose
npx homey app run      # run on a linked Homey
```

The app is driven by a single register table (`drivers/nibe_s/registers.ts`); see `CLAUDE.md` for an architecture
overview.

## Credits

- Original app: [Jan Sparud](https://github.com/sparud) and Kjell Blomberg.
- Local multi-device rework and per-function energy: Love Thyresson.

Not affiliated with or endorsed by NIBE Energy Systems.
