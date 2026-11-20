# External I/O: one layer for everything outside the pump

Status: **proposal, for review** (2026-11-20). Nothing here is built.

## Why

On 2026-11-20 Homey stopped the app seven times with "Memory Warning Limit Reached". The
fixes that day (d674152, 34e97f3) removed a timer leak and several full device lists, but the
cause underneath is structural: every feature fetches what it needs from outside the app on its
own schedule, with its own retries and its own pacing. Nothing sees the total, so nothing caps
it, and a start-up fires most of it at once.

Pump Modbus traffic is out of scope: `PumpConnection` already is the one owner of the wire, with
one queue and a watchdog. This proposal gives everything else the same shape.

## What the app fetches today

Full inventory with call sites: the review of 2026-11-20 (31 call sites). The summary:

**Per hour, steady state** (Heating and Hot water Autopilot on, solar ready, one outdoor and one
indoor sensor): about **205 Homey API calls**.

| Resource | Calls/h | Who |
|---|---|---|
| One device (`getDevice`) | ~120 | outdoor sensor 60 s, indoor sensor 60 s (30 s with the BT50 feed), read separately even when it is the same device |
| Energy live report | 60 | solar surplus, every minute |
| Price type / user costs / currency | ~10 | collector, hot water and three savings devices, each on its own |
| Day prices | ~4 (16 from 12:45 to 16:00) | collector and hot water make **identical** requests |
| Insights logs | ~9, in bursts | savings (3 devices), hot water learn, solar |
| Geolocation | ~1.3 | collector, solar |
| Open-Meteo | 1.3 | collector forecast; solar fetches the same `shortwave_radiation` again |
| Full device list | 0 (0.33 on homes without a grid meter) | setup, first run, solar on homes without a meter |

**Duplicates.** Prices are fetched by five consumers. Hot water's meter log is read about 28
times a day (savings hourly, the learner every 6 h in three resolutions). Geolocation by two,
irradiance by two, sensors per consumer, dashboards once per driver.

**Start-up, first 5 minutes** on an established install: about 26 Insights requests, 2 full
device lists (~1 MB each), about 20 Energy calls, two whole shadow-log files read. Peak at
about 90 s, when Heating savings, the solar survey and the tail of the hot water learn overlap.
A first install adds the backfill: about 36 Insights requests and 1–2 more full lists.

**Three pacing rules for one Insights.** 1.5 s (hot water), 2 s plus a 20 s retry (backfill),
5 s (savings): each feature learned on its own that Homey refuses back-to-back reads.

**One client that resets on any error.** `withApi` drops the shared HomeyAPI client on every
error, including a sensor read that fails once a minute, so the next call builds a new one.

## Proposal: `Outside`, one owner of external I/O

An app-level service, created in `App.onInit`, stopped in `onUninit`. Features never call
homey-api or `fetch` themselves; they ask `Outside` for a resource and get it from its cache,
or subscribe to it.

```
features (collector, hot water, solar, savings, sensors, setup, announcements)
        │  get / subscribe
        ▼
   Outside ── resources (cache + age rule + subscribers)
        │
        ├── Homey queue ── one HomeyAPI client
        └── web queue   ── Open-Meteo
```

### Resources

Each resource is fetched once, kept with an age rule, and shared by everyone who asks.

| Resource | Refresh | Kept | Replaces |
|---|---|---|---|
| `prices(date)`: slots, price type, user costs, currency | hourly; every 15 min 12:45–16:00 until tomorrow is in | today, tomorrow, 14 past days | 5 consumers' own fetches |
| `weather`: forecast incl. GTI per wall and GHI, 3 days ahead | hourly | 3 days back, 3 ahead | collector + solar irradiance |
| `irradianceHistory` | daily | 92 days | solar every 3 h |
| `location` | daily | — | 3 consumers |
| `reading(deviceId, capability)` | at the fastest rate any subscriber asks, at least 30 s | latest value + time | per-consumer sensor reads |
| `liveReport` | every 2 min, only while subscribed | latest | solar every minute |
| `meterLog(device, capability)` | hourly, **incremental**: `last24Hours` merged into what is kept | 14 days | savings `last14Days` ×3 devices hourly, hot water learn ×3 resolutions |
| `ownDeviceId(dataId)` | once | device store | done in d674152 |
| `deviceList()` | never cached; setup and Repair only, through the queue | — | 7 call sites |

### Queue

- **One Homey queue** with one pacing rule (Insights: one at a time, 2 s apart; other calls
  without a gap) and one backoff (a "too many requests" pauses the queue 20 s, then 1 min, then
  5 min). One rule replaces the three that exist.
- **Priorities.** 1: what an owner is waiting for (Repair, setup, a Flow card). 2: what steers
  the pump now (sensor readings, prices for the next slot). 3: background (learning, savings,
  backfill, announcements).
- **Start-up.** For the first 5 minutes only priorities 1 and 2 run; background work starts
  after that, one item at a time. That removes the 90 s peak without any feature knowing about
  it.
- **The client** is reset only on errors that mean the connection is gone, never because one
  request failed.

### Measurable

One log line an hour: calls per resource, kilobytes, queue wait, retries, cache sizes and the
process's memory. A rise shows up there before Homey stops the app. A unit test runs a day of
the app against a fake Homey API and fails if any resource exceeds its call budget.

## Migration, one consumer at a time

Each step is installable on its own, has its own tests, and changes no behaviour an owner sees.

1. **Skeleton.** `Outside` with the queue, client and hourly line; `withApi` becomes a thin call
   into it. Nothing else changes. Gives the measurements before anything moves.
2. **Prices.** One `prices` resource; collector, hot water and savings read it.
3. **Weather and location.** Collector's forecast becomes the resource; solar reads GHI from it
   and its 92-day irradiance becomes the daily resource.
4. **Sensor readings.** Indoor, BT50 and outdoor subscribe to `reading`; one read per device.
5. **Meter logs.** Incremental `meterLog`; savings, hot water learn and solar read from it.
6. **Live report and start-up priorities.** Solar subscribes at 2 min; background work moves to
   priority 3.
7. **Budget test** and removal of the leftovers (`getJson`, the three `loop()` copies, the
   three pacing rules).

Rough size: 1 and 2 are a day each; 5 is the largest, because savings' ledger, the hot water
learner and solar each read the meter log in a different shape.

## Not in scope

- Pump Modbus: already one owner.
- Amplitude: one SDK, batched, one call site (`analytics.ts`).
- /userdata files: one owner already (`store-file.ts`). Its `trimLines` reads a whole file into
  memory; a separate small fix.

## To decide

- **Name.** `Outside` is a placeholder.
- **Order.** Proposed above: skeleton, then prices (most duplicated), then the rest.
- **Meter logs on disk.** Keep the incremental logs in memory only (rebuilt with one 14-day read
  per start), or in /userdata so a start reads only the last day.
- **The pending install.** Today's fixes (d674152, 34e97f3) are committed, not installed. Install
  them now, or wait for step 1 so the hourly line measures before and after.
