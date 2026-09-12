# FAQ

Mostly "why doesn't this match?" questions. The mechanism behind the energy answers is in
[`energy-attribution.md`](energy-attribution.md).

## Homey temperature sensors

### Can I use my own sensors instead of NIBE's room sensor?

Yes, with a pump and firmware supporting external BT50. Open **Heating → Repair → Heating Setup**
and choose **Use your own Homey temperature sensors**. Search by sensor name, room or device type,
or select **Show all**. Rooms follow Homey's order. Choose one sensor or several for an equal average:
three selected sensors each contribute one third. There are no custom weights or floor groups.

The app accepts standard Homey temperature sensors reporting Celsius, including temperature
capabilities on devices such as smoke alarms. It excludes Nibe Live's own readings to avoid a loop.

### What do I change on the pump?

The setup screen guides you through enabling external room sensor BT50 in menu **7.5.9.2**,
assigning BT50 to the intended zone in room sensor / zone settings (**1.3.3 / 1.3.4**),
and selecting it to control heating. Replace the previous controlling sensor if that is your intent.
Menus and support vary by model and firmware; effective BT50 writes were verified on an S1155-16.

Use **Verify settings** in Repair to start updates and check the pump's BT50 reading.
This verifies receipt of the temperature; it cannot prove which zone the pump uses for control.
Pairing saves a pending selection; finish activation in Repair while you can access the pump.

### Does this replace my thermostat or Smart Price Adaption?

No. The app supplies the measured indoor temperature. The pump still controls heating and uses its
existing target temperature and Smart Price Adaption settings. BT50 and the zone's averaged
temperature can differ if the pump combines BT50 with other room sensors.

### Why does the app need permission to access other Homey devices?

It uses Homey's API permission to discover temperature sensors, show their rooms, and read their
values and update times. The permission is broader than temperature access, but this feature uses
it to read sensors and room information. It does not change those devices. Sensor names, room names
and readings are not sent as anonymous usage data.

### What happens if a sensor stops reporting?

Every selected sensor must be available and have a valid reading within the configured reading-age
limit (two hours by default). If any fails that check, the app stops sending new temperatures,
shows a warning and retries. It does not silently drop a room from the average.

Sensors that report only when their temperature changes can exceed this limit even if they are
still online. Review the reading-age setting against how your sensors report.

Once activated, updates continue after Repair closes and resume after an app restart. If Homey
or the feed stops for long enough, the pump can raise a BT50 alarm. Do not assume it automatically
returns to the native sensor.

### How do I return to the pump's own sensor?

First restore the native sensor as the zone's controlling sensor and disable external BT50 on the
pump. Then choose **Use the heat pump’s native temperature sensor** in Heating Setup.
The app checks that external BT50 is disabled before stopping its feed.

### What does Set outdoor temperature (BT1) do?

This Heating Flow action sends one outdoor-temperature reading. It is separate from the automatic
indoor feed. A successful Flow action confirms the write was accepted, not that the pump is using
it. External BT1 must be configured on the pump. The wired-sensor fallback and loss-of-feed
behaviour are not verified; do not assume stopping a Flow restores the physical sensor.

### Where did the hot-water tank settings move?

Open **Hot Water → Repair → Hot Water Setup**. The existing tank catalogue, automatic estimate,
custom capacity and no-estimate choices remain available. **Save changes** saves directly.

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

### My solar panels show up in the Energy tab but with no production figure

Fixed in **1.1.4**. The Solar device was publishing its live output under a name only the device's own
tile could read, so Homey's Energy tab listed the device but had no production value to show. The tile
was right the whole time — it was the Energy tab that saw nothing. Updating the app fixes it; there is
nothing to change on the pump or in the device settings.

Note that the solar energy total counts from when you added the device, not from when the panels were
installed — same as every other energy figure in this app. Your pump's own lifetime total stays
visible in MyUplink and in the pump's menus.

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

### My heating device shows energy produced but 0 kWh used, even though it's genuinely heating

A bug, fixed in **0.9.14**. The register the app relies on for "what is the pump currently working
on" (1028) was observed reading **idle** throughout a real, demand-driven heating cycle — degree
minutes crossing the compressor-start threshold, real compressor draw, the produced-energy counter
advancing the whole time. With 1028 saying idle, every watt of that cycle was booked to Main instead
of Heating, which is exactly this symptom: energy *produced* (read straight off the pump, so still
correct) with 0 kWh *used* on the device that actually did the work.

The app now cross-checks 1028 against an undocumented second register, confirmed independently
against myUplink's own reading, and corrects the mistake when it happens — see
[`energy-attribution.md`](energy-attribution.md) for the mechanism. It only ever corrects an idle
reading; if 1028 already says a function is active, that's trusted as-is. Not available on every
model — S2125, S320/S325 and S330/S332 don't expose the second register, so they fall back to 1028
alone, same as every release before this one.

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

### How does the app know how much hot water I have left?

You tell it which tank you have, and it reads the tank's two temperature sensors.

**The arithmetic.** "Hot water available" is litres of **40 °C** water — the same thing NIBE prints
on its tank datasheets, and what you actually care about, since 175 litres at 55 °C is a lot more
than 175 litres of shower. The app works out how much of the tank is still above 40 °C from where
the warm/cold boundary sits between the two sensors, and how hot that part is. That is also why the
figure can read higher than your tank holds: it is not measuring how full the tank is, it is
measuring how much showering is in it.

**Setting it up.** Open the Hot Water device, run **Repair**, and pick your tank. One entry per
family — you do not need to know whether yours is copper, stainless or enamel, because that changes
the answer by about 2 %. Without a tank there is no estimate.

**Why you have to tell it.** The app did originally work the size out by itself, from the heat the
pump reported against how far the sensors rose. Tested on a real pump with a known 176 L tank it
measured 436 L. A charge only stops when the bottom sensor reaches its target, so any hot water used
*during* the charge just makes it run longer — and that extra heat is indistinguishable from a
bigger tank. Charges usually start because someone is using hot water, so this is the normal case.

**Treat it as a good guide, not a gauge.** Two sensors is not many for a whole tank: the app cannot
see the water above the top sensor or below the bottom one, so it under-reports a shower while it is
happening. It moves in the right direction continuously, which is what matters for a Flow.

### It went to zero but the tank is not empty.

That is correct. "Hot water available" counts water you could still shower in at 40 °C. Once the
hottest water in the tank is below 40, there is none — even though the tank is full of 39 °C water
that is perfectly good for washing up.

### Hot water available is blank, or the capability is missing.

If it is missing, no tank has been chosen yet — run **Repair** on the Hot Water device.

If it is present but empty, the pump has not reported both tank temperatures yet; that clears on the
next poll.

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

### Why doesn't cancelling "More hot water" stop the compressor?

It cancels the *request* immediately — measured live, the pump's own internal minutes-remaining
and status registers both reset within one poll of switching the boost off. What it doesn't do is
interrupt a compressor cycle that has already started; the pump finishes that cycle regardless.
That's normal short-cycling protection, present on essentially every heat pump, not a bug here.

Toggling **Allow hot water** off and back on does force a running cycle to stop — that was
confirmed too — but the app doesn't do this for you automatically. Forcing a running compressor
off that bluntly, on every boost cancellation, is likely worse for it than letting the current
cycle finish. It's left as something you choose to do occasionally, not something the app does
silently and routinely on your behalf.

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

## Privacy

### What does "Share anonymous usage data" actually send?

Which pump model and firmware you have (as the code the pump itself reports), which of the six devices you
created — Main, Heating, Hot water, Pool, Cooling, Solar — which features you enabled on each, which Flow
cards and buttons get used, whether register detection worked, and whether the connection to your pump drops.
Plus your Homey's version, model, timezone and language.

It does **not** send any reading from your pump — no temperatures, no power, no hot water activity. That is a
deliberate line, not an oversight: a timestamped log of when your compressor ran and when someone showered
would say a great deal about when you are home, and it answers none of the questions the data exists to
answer. It also sends no IP address, no pump serial, no device or Flow names, and nothing that identifies you.
The only identifier attached is a random number generated on your Homey.

### Why does the app want this at all?

It is maintained by one person with one heat pump. Whether a feature works on an S1255, an S320 or an S2125 —
or whether detection finds anything at all on them — is otherwise guesswork, because the people whose setup
works never post about it. Knowing which models and functions are actually out there is what decides where
effort goes.

### How do I turn it off?

**More → Apps → Nibe Live → Configure**, then untick it under **Privacy**. It takes effect immediately, and
you do not need to delete or repair anything. It is off unless you switched it on — the box during pairing
starts unticked.

### Where is the data stored?

In the EU. The app sends to Amplitude's European servers and the data is held in their EU instance; it is not
transferred outside. [docs/analytics.md](analytics.md) lists every single event and property, and everything
deliberately excluded.


### Why did hot-water availability or COP briefly go blank?

From 1.2.1, a completed poll must contain the readings needed for that estimate. If a required
reading is missing, the app shows no estimate until measurement resumes. It does not combine a
fresh temperature with an old one or trigger a low-water crossing across a measurement gap.

### Why does a setting now report that the pump did not confirm it?

The app checks the pump's value after writes from both tiles and Flows. A successful Modbus
acknowledgement alone does not guarantee that the pump applied the setting. A confirmation error
means the requested value could not be verified; check the current reading before retrying.
