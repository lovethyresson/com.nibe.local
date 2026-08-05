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

**How well does that hold up?** On a measured hot-water cycle the app came within **1%** of the pump's own
figure. That is the reason it's left alone rather than nudged toward the hourly numbers.

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

Because a boost does not use the stop temperature of the demand mode you have selected. It charges to its
own, higher setpoint — shown in the app as **Hot water stop (boost)**, and adjustable there.

Measured on an S1155 with demand mode **Small** (stop 48 °C): two manual "More hot water" boosts both ran to
**54.6–55.0 °C**, which is the boost setpoint's default of 55 °C. It isn't the Large mode's stop point either,
which was set to 58 °C on that pump.

The same setpoint governs the periodic anti-legionella charge — Nibe's own name for the register is "stop
temperature HW periodic increase", and the manual boost appears to share it. The pump will not let it be set
below 55 °C.

This is worth knowing if you use the "automatic off, manual boost only" setup described in the README: your
demand mode's stop temperature controls nothing during a boost.

## Room temperature and the thermostat

### What does the "Room temperature" control actually change?

Exactly what **menu 1.1** on the pump changes, and nothing else — it is the same setting, so moving the
slider in Homey and turning the dial on the pump are two ways of writing one value. (If you also use
myUplink, it is what that calls "Room setpoint".) The app reads it back every poll, so if you change it on
the pump the tile follows within seconds.

How the pump *uses* it depends on your installation. With a room sensor set to control heating (pump menu
1.3.3, sensor assigned to a zone with "Värme" ticked), the pump regulates towards that temperature using the
sensor. Without one, the heat curve is what governs, and the pump may not offer a room setpoint at all — in
which case the app doesn't show the control either (see below).

### My heating device has no room temperature control.

Then your pump answered with no usable setpoint when the app looked. Pumps report a flat `0` for a zone that
isn't set up, and a thermostat reading 0 °C would be worse than none, so the control is only added when the
pump reports a sensible value (5–35 °C). Everything else is unaffected: the room sensor reading is still
shown, and the device still appears in Homey's Climate view.

If you have since configured a room sensor or zone on the pump, run **Repair** on the device (device menu →
Repair) — that re-runs detection and picks the control up.

### Why does the pump show up in Homey's Climate view now?

Because the room sensor reading is published as the device's own temperature rather than as one of its many
named temperatures. Homey's Climate feature only looks at a device's main temperature, which is why the pump
used to contribute nothing to it even though the value was there all along.

The **Main** device reports to Climate too, using the outdoor sensor (BT1). That is genuinely useful — the
pump's own outdoor reading is what its heating decisions are based on — but it comes with a catch worth
knowing.

### The pump is dragging my indoor temperature down.

Homey reads a device's main temperature as the ambient temperature of **the zone the device sits in**. Main
reports outdoor temperature, so if it sits in an indoor zone it pulls that zone's average — and the home
average with it — toward the weather.

Two ways to fix it, both in Homey rather than the app:

- **Move Nibe Main to an outdoor zone.** The reading then lands where it belongs and the indoor zones are
  left alone. This is the recommended one.
- **Turn off "Include in Climate"** in the device's settings, if you would rather Main didn't count at all.

The heating device is unaffected either way — it reports the room sensor, which is a genuine indoor
temperature and belongs in the average.

### A Flow that used the room temperature stopped working.

The room-temperature register changed name in 0.9.13 (that rename is what makes Homey see it at all). Open
the Flow, pick the register again from the dropdown, and save. Its Insights history also starts fresh from
that release — the old graph is still there under the previous name, it just doesn't continue.

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
