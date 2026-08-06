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

Because a boost ignores the demand mode you have selected. NIBE's manuals describe "More hot water" (menu
2.1) as temporarily raising the pump to its **luxury** hot water mode — called **Large** on the S-series —
and they note that luxury mode uses the **immersion heater alongside the compressor**.

Measured on an S1155 in demand mode Small (stop 48 °C), boosts ran to 53.4, 54.6, 55.0, 58.1 and 58.6 °C:
always well past Small's setting.

**Our own measurements can't confirm which setpoint it targets**, because on that pump the immersion heater for
hot water is blocked, so every boost ends where the compressor gives up rather than where the setting is. With
Large at 58 a boost stopped at 58.1; with Large at 66 it stopped at 58.6 — the second is the ceiling, not the
target, so it neither confirms nor refutes Large.

If you want to influence how hot a boost gets, **Hot water stop (Large)** is the setting to try — and see the
next two questions for why it may not be what limits you.

### My boost stops well short of what I set. Why?

Because the compressor has a hard ceiling, and on a boost you are usually asking for something above it.

To put heat *into* a 58 °C tank the refrigerant has to condense several degrees hotter still, and a heat
pump's compressor cannot push past a certain condensing temperature. Compressor-only, expect roughly
**55–62 °C** in the tank — and where in that band you land moves with conditions:

- **How cold the source is.** The five runs above span 53.4 to 58.6 °C on the same pump in the same week. The
  best of them happened with the ground loop at 21 °C, about as easy as this machine will ever have it. Expect
  less in winter.
- **Protective cut-outs.** When it cannot manage the heat the pump throttles the compressor right down, and if
  that is not enough it ends the charge on a **high condenser temperature** alarm. Seeing that on hot water in
  winter is the machine protecting itself, not a fault.

**Above that ceiling you need the immersion heater** — which is a separate setting, see below. It is also why
the periodic anti-legionella charge has its own stop temperature with a 55 °C floor: 60–70 °C is not
compressor territory at all.

### Everything looks right and the pump still isn't doing it. Check your schedules first.

**Before suspecting a setting, check the pump's own schedule (menu 6).** A schedule can switch hot water off,
or block additional heat, entirely independently of everything the app can see — and it is *not* readable over
Modbus. The app will show hot water permitted, the demand mode correct, the start temperature correct, the
tank well below it, and the pump idle, with no way to explain the contradiction.

This is not hypothetical. The maintainer lost the better part of a day to exactly this: a tank sitting at
32 °C against a 52 °C start point, and five hot water boosts where the immersion heater never engaged. Both
were schedules — "hot water: off" on weekdays, and "block additional heat" — while every register the app
reads insisted the settings were fine.

If the pump is ignoring something you have set, and the app shows no reason why, the schedule is the first
place to look and the app cannot help you there.

### The immersion heater is on, so why isn't it helping hot water?

There are two separate permits, and the obvious one is the wrong one:

- **Allow immersion heater** on the Heating device is Nibe's "Permit additional heat, *heating*". It does
  nothing for hot water.
- **Allow immersion heater, hot water** on the Hot Water device is the one that matters, and it is **off from
  the factory**.

Even with both on, the pump may still decline. In **Auto** operating mode it blocks the immersion heater above an
outdoor-temperature limit ("only use immersion heater below", commonly 5 °C), so on a mild day it will let
the compressor work alone regardless of what you have permitted.

## Indoor temperature

### Can I set my indoor temperature from Homey?

**No — the pump does not allow it over Modbus.** You can *see* it: the Heating device shows **Indoor
temperature setpoint**, the same number the myUplink app shows. It is read-only, because Nibe provides no
Modbus path to change it.

That was measured, not assumed, on a live S1155:

- The register holding the setpoint (2505) tracks myUplink exactly — it followed changes to 35.0, 28.0 and
  22.5 °C. Writing to it is **accepted and then discarded**: the pump acknowledges the write and the value
  never changes. Checked with both Modbus write function codes, re-read immediately, after 3 seconds, and
  again minutes later on a fresh connection.
- Not a fault in this app: writing a *different* register the same way (Smart Price Adaption, 843) works
  perfectly, and the setpoint write is still discarded with Smart Price Adaption switched off.
- The older per-climate-system setpoint (206) *does* accept writes — and the pump ignores them. A controlled
  experiment (`dev/experiment-room-control.mjs`) with room-sensor control on and heating permitted swung the
  setpoint 10 °C, from 5 °C above the room temperature to 5 °C below it. Neither the pump's calculated supply
  nor the rate its degree minutes accumulated changed at all. Asking for heat 5 °C above the room is the
  loudest possible request, and it produced no response.

The same behaviour is reported independently on an S735 in
[home-assistant/core#154450](https://github.com/home-assistant/core/issues/154450), where myUplink changes
work within minutes while Modbus writes to the same register do nothing — and where myUplink is observed not
to touch register 206 either. The app uses an internal path Modbus does not expose.

### So how do I make the house warmer or colder from Homey?

Use the **heat curve offset** on the Heating device (Nibe's *värmeförskjutning*, register 30, −10 to +10).
That is Nibe's own control for exactly this, it works over Modbus, and it shifts the whole curve — so it
warms or cools the house without fighting whatever is managing the setpoint.

For an absolute target temperature you still need the myUplink app.

### Why do I still need the myUplink app, then?

Three things Modbus does not give you:

- **Setting the indoor temperature**, as above.
- **Away / holiday mode.** No way to switch it on, and the register reporting its status carries a value Nibe
  documents no meaning for — so the app doesn't show it rather than showing a number nobody can interpret.
- **Schedules.** Menu 6 is not on Modbus at all; Homey Flows do the same job and rather more.

Everything else you'd open myUplink for — reading the indoor temperature and its setpoint, hot water, curves,
modes, energy — is local and in this app.

### Which sensor is my indoor temperature coming from?

Pairing and Repair say so outright, under the Indoor temperature row: *Using: climate system 1 average —
23.5*. When more than one sensor reports a plausible temperature it becomes a list to choose from, showing
what each currently reads so you can tell them apart. To change it later, run **Repair** on the Heating
device and pick again.

### Is that BT50, the wired room sensor?

Not necessarily, and often not at all. Nibe's register documentation labels the value "BT50", but what it
reports is the *average for climate system 1* — which on current firmware comes from whatever sensors the
zone uses, including wireless room units. The maintainer's own pump has no wired room sensor fitted and
still gets a correct reading. That's why the app names the source rather than claiming a particular sensor.

### The room temperature was blank before I updated.

A bug, fixed in **0.9.13**. The app read register 111 believing it was the room sensor; it is climate system
*6*, and on most pumps it is empty. Climate system 1 is register 116. Run **Repair** on the Heating device
after updating so it picks up the corrected register.

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
