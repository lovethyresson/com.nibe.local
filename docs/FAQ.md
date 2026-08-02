# FAQ

Mostly "why doesn't this match?" questions. The mechanism behind the energy answers is in
[`energy-attribution.md`](energy-attribution.md).

## Numbers that don't match myUplink or the pump

### Should the app agree with my pump's own display?

For temperatures, pressures, speeds, states and settings — yes, exactly. Those are read straight from the
pump's registers with no arithmetic. If one disagrees with the pump's own menu, that's a bug worth reporting.

Energy and COP are a different story; see below.

### Why doesn't my energy total match MyUplink?

Counters are **baselined when you add the device**, so everything reads "since you paired it" rather than
since the pump was installed. That's deliberate — it's what lets the per-device figures reconcile with each
other — but it means the absolute numbers will never equal MyUplink's lifetime totals.

The *change* over a given window should agree. Compare a day or a week, not the raw totals.

### Why does Main show so little energy used?

Because Main is the **remainder**, not the whole pump. It carries standby draw plus any function you haven't
paired a device for. The pump's true total is the sum across all your Nibe devices, which is exactly what
Homey's Energy tab adds up.

The capability is titled "Total energy consumed" on every device, which is misleading on Main specifically —
Homey applies capability titles per capability, not per device, and renaming it would orphan the Insights
history. It's a known wart, not a miscalculation.

### Why is per-function energy slightly off from the pump's own figures?

The pump publishes **one** total power figure and separately says what it's currently doing. It does not
meter electricity per function. So the app integrates total power and charges it to whichever function is
active at each poll — measured at **under 1% off** over an instrumented hot-water cycle, but attributed
rather than metered.

Delivered heat is the opposite: the pump *does* keep per-function counters for that, so delivered energy is
read directly and is exact.

### I compared for ten minutes and it's wildly wrong.

Compare over a day. The pump's lifetime counters move in 0.1 kWh steps and settle about an hour behind its
own internal hourly log, so a short comparison can look catastrophic while both figures are perfectly fine.
A single 0.1 kWh tick can represent several hours of quiet accumulation.

### The app and myUplink show different power right now.

Both are probably right. This app polls the pump directly every 5 seconds; myUplink goes via Nibe's cloud
and can lag by minutes. They won't be in step moment to moment.

### Can I see this hour's energy, like menu 3.1 on the pump?

No. The pump computes it — that's the filling bar in the menu — but publishes no Modbus register for it.
Checked three ways: every "hour" title across all six S-series register maps, Nibe's published symbol list,
and the myUplink Homey device. Modbus offers only the *previous completed* hour.

## COP

### Why is my COP blank?

One of three reasons, all intentional:

- the rolling 30-day window needs an earlier snapshot to compare against, so it's blank on a fresh pair;
- the value is withheld until more than 0.1 kWh has been used in the window, because a tiny sliver of
  consumption divides into nonsense;
- a function that never runs — a pool you don't have — never crosses that threshold, and showing nothing is
  more honest than showing zero.

### Which COP should I trust?

**Total COP on Main.** Both sides of it are the pump's own counters, so it reconciles with myUplink over the
same window. A per-function COP divides a measured delivered figure by an attributed used figure, so it
inherits the attribution's error — small, but present.

### Why 30 days and not lifetime?

A lifetime average stops moving. A 30-day window tracks the season, so you can actually see the effect of a
setting change or a cold snap.

### My hot water COP was 15. What happened?

A bug, fixed in **0.9.12**. The delivered counter ran whenever the pump ran, while the used meter only
advanced when the app could measure — so a numerator covering months was divided by a denominator covering
hours. Both sides now advance over identical intervals. The affected history is discarded rather than
migrated, so COP is blank for a while after upgrading and then rebuilds correctly.

## Setup and connectivity

### Can I run this and myUplink at the same time?

Yes. myUplink is a cloud service and never touches Modbus. What you *can't* do is point a second **Modbus**
integration at the pump — it accepts one client at a time.

### Autodetect didn't find my pump.

Modbus TCP has no announcement mechanism and Nibe pumps don't advertise themselves, so "discovery" is a sweep
of your Homey's subnet for port 502. It only works when **Modbus TCP is enabled on the pump (menu 7.5.9)**
and the Homey is on the same subnet. Otherwise enter the IP manually — that path always works.

### A capability sits blank forever.

Your model probably doesn't implement that register. Turn on **Debug logging** in the app's advanced
settings: it names every register that has failed, with its address, and restates them after you enable it —
so a log you send for support contains the cause even though the failure happened hours earlier.

### Why did a Flow action fail with a Modbus error?

The pump refuses writes it considers invalid — most often "Illegal Function", which usually means the
feature is disabled. The classic case: turning **Allow hot water** off makes the pump block the demand-mode
and "More hot water" registers entirely. The app now logs the exception name and the full response, so the
log says which of these it was.
