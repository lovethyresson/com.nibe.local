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

### How does the app work out how much electricity heating, hot water and cooling each used?

Your pump has one electricity meter, not four. What it does publish is its **total power right now** and
**what it is currently working on**. So every few seconds the app asks both questions, works out the energy
used since it last asked, and puts all of it on whichever function the pump named. Standby goes to Main.

Because each moment is charged to exactly one function, the four devices always add up to the pump's real
total — that's what Homey's Energy tab shows.

Delivered heat works the other way round: the pump *does* count that per function, so those figures are read
straight off the pump and are exact.

### Why not use the pump's own per-function energy figures instead?

The pump does keep them — but it publishes them **once an hour, for the hour that just ended**. That's too
late to be useful for the thing most people want it for:

- **Electricity pricing moves faster than that.** With hourly or 15-minute tariffs, knowing at 15:00 what hot
  water cost between 14:00 and 15:00 puts the cost in the wrong price slot. Homey can't go back and rewrite an
  hour that has already passed, so being late can never be repaired afterwards.
- **There'd be no live power reading at all.** The pump publishes no "right now" figure per function, so the
  power shown on each device tile would simply not exist.
- **Everything would move in hourly steps** rather than while things are actually happening.

So the app uses the live method — and then checks itself against the pump's hourly figures every hour, which
is the best of both: timely numbers, continuously audited against the pump's own books.

**How well does that hold up?** Within about **1%** of the pump's own hourly figure on measured hot-water
cycles, across two different pump models. That is the reason it's left alone rather than nudged toward the
hourly numbers — and since the pump's hourly figures have been measured to be exactly what myUplink shows,
it is also roughly how close to myUplink you should expect to land.

**What you give up.** Per-function electricity is a very good estimate, not a meter reading, so it won't tie
out to the last decimal against myUplink. And if Homey restarts or loses contact with the pump, the
electricity used while it wasn't watching is never counted — the pump kept counting, the app couldn't. Both
are the price of having numbers that arrive while they still matter.

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

### Why does a hot water boost heat past my stop temperature?

Because a boost temporarily promotes the pump to its **Large** hot water mode and charges to
*that* stop temperature, whatever mode you normally run. NIBE's manuals describe menu 2.1 "More
hot water" as temporarily raising the pump to luxury hot water, and measurement agrees: on an
S1155 in demand mode Small (stop 48 °C), with Large set to 68 °C, a boost ran to **68.4 °C**.

So the setting that decides how hot a boost gets is **Hot water stop (Large)** — even if Large is
not the mode you use day to day.

### My boost stops well short of that. Why?

Almost certainly because the immersion heater is not available, and the compressor alone cannot
get there.

The compressor has a hard ceiling — it must condense several degrees hotter than the tank, and
a heat pump cannot push past a certain discharge temperature. Expect roughly **55–60 °C** in the
tank on the compressor alone, less when the source is cold. Above that the immersion heater has
to make up the difference, and there are two common reasons it does not:

- **Operating mode is Auto.** The immersion tick box in the pump's menu 4.1 — the app's **Allow
  additional heat** — only applies in mode **Manual**. In Auto the pump decides for itself, and
  the setting is ignored. You can switch mode from the Main device.
- **A schedule is blocking it.** Each schedule mode has a **"Block additional heat"** switch
  covering heating and hot water alike. It is not readable over Modbus, so the app cannot show
  you it — see the schedules question above.

Measured on an S1155: five boosts in a row stopped at 53–59 °C with the immersion drawing 0 W,
first because a schedule had blocked it for a year and then because Auto mode ignored the permit.
With both cleared and the mode set to Manual, the immersion ran to its full **7 kW** and the same
boost reached 68 °C.

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
