# FAQ

Mostly "why doesn't this match?" questions. The mechanism behind the energy answers is in
[`energy-attribution.md`](energy-attribution.md).

## F-series (experimental)

### What does the F-series driver support?

Choose **Nibe F-series (experimental)** when you pair through a compatible Modbus gateway. Which
readings and controls you get depends on your heat pump, its accessories and whether the gateway
accepts changes. You can start testing with writing turned off on the gateway. LOG.SET should
include the energy readings you use most. Other readings update more slowly. See the
[F-series guide](f-series.md).

Splitting energy between functions is experimental. On an F730 the compressor power reading
moved, but its scale in watts isn't verified, and the produced-energy counters stayed at zero.
COP needs working production figures. Don't treat F-series energy figures as a verified meter.

## Heating cutoff

### Why is heating running when it is warmer outside than the heating-stop setting?

In Auto mode, your heat pump compares the heating-stop setting with the **average outdoor
temperature**. The current outdoor reading can be above the limit while the average is still below
it. For example, 16.8 °C outside with a 14.8 °C average doesn't reach a 15 °C heating stop. This
doesn't apply in Manual mode. Since 1.4.2, the app's explanation of what your heat pump is doing
uses the average too, and leaves out the heating-stop reason if that reading isn't available.

## Homey temperature sensors

### Can I use my own sensors instead of NIBE's room sensor?

Yes, if your heat pump and its software support an external room sensor (BT50). Open
**Heating → Repair → Heating setup** and choose **Use your own Homey temperature sensors**. Search by
sensor name, room or device type, or select **Show all sensors**. Rooms follow Homey's order. Choose
one sensor, or several for an equal average. With three sensors, each counts for a third. There are
no custom weights or floor groups.

The app accepts standard Homey temperature sensors that report in Celsius, including the
temperature on devices such as smoke alarms. It leaves out Nibe Live's own readings to avoid a loop.

### What do I change on my heat pump?

The setup screen guides you through it. Turn on external room sensor BT50 in menu **7.5.9.2**,
assign BT50 to the right zone in the room sensor and zone settings (**1.3.3 / 1.3.4**), and select
it to control heating. Replace the previous controlling sensor if that's what you want. Menus and
support vary by model and software. BT50 updates were verified to take effect on an S1155-16. The
temperature is sent again every 30 seconds, even when it hasn't changed.

Use **Verify settings** in Repair to start sending and check the BT50 reading on your heat pump.
This confirms that your heat pump receives the temperature. It can't show which zone your heat
pump uses for control. Pairing saves your choice without sending anything. Finish the setup in
Repair when you're at your heat pump.

### Does this replace my thermostat or Smart Price Adaption?

No. The app sends the measured indoor temperature. Your heat pump still controls heating with its
own target temperature and Smart Price Adaption settings. BT50 and the zone's average temperature
can differ if your heat pump combines BT50 with other room sensors.

### Does Autopilot follow my thermostat?

Yes. The Heating device's thermostat is Autopilot's target. Autopilot steers the house toward it
through the outdoor temperature it sends (BT1), and shifts heating in time within your comfort
range. Change the thermostat and Autopilot follows. Away sets the thermostat to the Away
temperature, so the house cools to that. A small steady offset is corrected slowly, over a few
days. With Comfort range Off, Autopilot doesn't shift or steer.

Room-sensor control on your heat pump must be off. Autopilot regulates on your Homey sensors.
They're still sent to your heat pump as BT50 while external BT50 is on (menu 7.5.9.2), to prevent
a BT50 sensor alarm (alarm 153). With room-sensor control off, your heat pump only shows them. In
**Heating → Repair → Heating setup**, right after Smart mode, Autopilot asks which indoor
temperature to hold: your heat pump's own sensor or Homey sensors.

### How long does Autopilot heating learn before it starts?

At least 5 days, or 3 if your Homey already has a few weeks of readings from your heat pump. Until
then Autopilot keeps your house at the thermostat temperature, but doesn't move heating to cheaper
hours. Price shifting starts once all three hold:

- 5 days with enough readings to learn from.
- It predicts your indoor temperature 6 hours ahead within 0.35 °C.
- Its estimate of how fast your house cools stays about the same for 3 days in a row.

The Heating device's Autopilot status shows the day count, then which check is still open. A day
with gaps in the readings doesn't count. Once it has started, it keeps running.

### Why is my house below my temperature in the first week?

When Autopilot heating starts, room-sensor control is off and your heat curve holds the house
alone, often a little off your thermostat. Autopilot then raises or lowers the level until it holds
your temperature. A light house gets there in a day or two. A heavy one, with concrete floors or
thick walls, can take more than a week. Until then indoor can be up to about 1 °C off.

Autopilot heating starts in four steps, and the **Getting started** widget shows where you are:

1. **Learning** (5+ days): it learns how your house holds heat.
2. **Settling**: it brings the house to your temperature. Each morning a timeline message gives
   yesterday's average. Two days in a row within 0.2 °C of your thermostat end this step. Changing
   the thermostat starts it over.
3. **Curve check**: it changes your curve offset, or asks you to, then checks that the house holds
   your temperature for 2 days in a row. When Autopilot changes the offset itself, that can happen
   while the house is still settling, and then those days count. If your curve already fits, this
   step ends at once. Without a verdict it ends after 10 days.
4. **Done**: your house holds your temperature and your curve is checked.

Autopilot starts moving heat away from expensive hours the first day your house is within your
comfort range, usually partway through Settling, and keeps doing so through the rest. The widget
shows "Saving since" once it has started. Days with Away or a thermostat change don't count.

### Will Autopilot change my heating curve?

Only if you chose **Adjust it for me** in Heating setup. Once your house holds your temperature
(the Settling step), Autopilot knows how far your heating curve is from holding it alone. It then changes the curve offset (menu 1.1.1)
once, by up to 3 steps, and tells you in the Timeline. You can undo it in Heating setup. With **I'll
do it myself**, it tells you what to change instead. It never changes the heating curve itself (menu
1.30.1). If that is off, it tells you which way.

Why it matters: when Autopilot isn't running, for example while Homey restarts, your heat pump goes
by its heating curve alone.

### Why does the app need permission to access other Homey devices?

It uses Homey's API permission to find temperature sensors, show their rooms, and read their
values and update times. The permission covers more than temperatures, but this feature uses it to
read sensors and rooms. It doesn't change those devices. Sensor names, room names and readings
aren't sent as anonymous usage data.

### What happens if a sensor stops reporting?

The app sends the latest temperature to BT50 every 30 seconds after each completed update, even
when the value hasn't changed. When a sensor last changed doesn't affect this, and an old reading
doesn't expire.

Every selected sensor must be available and have a valid temperature. If a sensor is missing,
unavailable or outside 5–40 °C, the app stops sending and tries again. If it keeps failing for 5
minutes, you get one warning on the Heating device and in the Timeline. The app doesn't drop a
room from the average on its own. Homey's availability status depends on the sensor's app. It
doesn't guarantee that a battery sensor is still reporting.

Once set up, sending continues after Repair closes and resumes after an app restart. If Homey or
the updates stop for long enough, your heat pump can raise a BT50 alarm. Don't assume it switches
back to its own sensor by itself.

### How do I go back to my heat pump's own sensor?

First, on your heat pump, make its own sensor the zone's controlling sensor again and turn off
external BT50. Then choose **Use your heat pump’s own temperature sensor** in Heating setup. The
app checks that external BT50 is off before it stops sending.

### Can the thermostat show one of my NIBE wireless room sensors?

Yes, since 1.5.0 on S-series. Open **Heating → Repair → Heating setup** and keep your heat pump's
own sensor. Each wireless sensor is listed with its current reading, next to your heat pump's
average. Your heat pump doesn't name the sensors, and their order matches neither the zone list nor
menu 5.4, so use the reading to tell them apart. Each sensor can also have its own temperature on
the Heating device.

### My heat pump has two zones. Which one does the thermostat set?

The one you choose. On heat pumps with two or more zones, Heating setup first asks which zone the
thermostat sets. Pick the zone whose room sensor controls the heating (menu 1.3.3). Before 1.5.0
the thermostat always set zone 1, which on some heat pumps only displays.

### What does Set outdoor temperature (BT1) do?

This Heating Flow card sends one outdoor temperature reading. It's separate from the indoor
temperature the app sends automatically. If the card succeeds, your heat pump accepted the value,
but that doesn't prove it uses it. Turn on Modbus TCP/IP in menu **7.5.9**, then turn on
**Outdoor temperature (BT1)** under **7.5.9.2 External sensor inputs**. Modbus alone isn't enough.
See the [README setup steps](../README.md#set-outdoor-temperature-bt1). What happens when the
readings stop isn't verified. Don't assume that stopping a Flow brings the wired sensor back.

### Where did the hot water tank settings move?

Open **Hot water → Repair → Hot water setup**. The tank list, automatic estimate, custom size and
no-estimate choices are all still there. **Save changes** saves straight away.

The incoming cold water temperature is now **Incoming water** on the Hot water device. Autopilot's
**Always enough for a shower** is in **Hot water → Repair → Hot water setup**, under Smart mode
after the tank, next to the other Autopilot hot water choices. Your earlier value carries over.

## Numbers that don't match myUplink or your heat pump

### Should the app agree with my heat pump's own display?

For temperatures, pressures, speeds, states and settings, yes, exactly. The app reads those
straight from your heat pump with no arithmetic. If one disagrees with the menu on your heat pump,
report it as a bug.

Energy and COP work differently. See below.

### Where did fan speed, fan mode and night cooling go?

To the **Nibe Main** device, since 1.4.7. Ventilation serves heating and hot water alike, so it's
on Main next to the other settings for the whole heat pump. Your on/off choice for ventilation
moved with it. Flows that used these cards on the Heating or Cooling device need the Main device
picked again. History from before the update stays on the old device.

### Do I need to update my heat pump's software?

Yes, before pairing if you can. Many readings the app uses only exist on recent software, and older
software has been seen counting several times too much delivered energy. One S1255 showed a hot
water COP near 9 until a software update, after which its counters matched the heat pump's own
hourly log within 1%. Updating later works too. Run **Repair** on each device afterwards so the
app checks what your heat pump now offers. The COP is a 30-day average, so readings from before the
update take a month to roll out.

### Why doesn't my energy total match myUplink?

Counters start at zero **when you add the device**, so everything reads "since you paired it".
That's what lets the figures on
each device add up to the same total. It also means the totals will never equal myUplink's
lifetime totals.

The *change* over a given period should agree. Compare a day or a week.

### My solar panels show up in the Energy tab but with no production figure

Fixed in **1.1.4**. The Solar device published its live output under a name only its own tile
could read, so Homey's Energy tab listed the device without a production value. The tile was
right. Update the app to fix it. You don't need to change anything on your heat pump or in the
device settings.

The solar energy total counts from when you added the device, like every other energy figure in
this app. Your heat pump's own lifetime total is still in myUplink and in its menus.

### Why does Main show so little energy used?

Main shows what's left over: standby draw, plus any function you haven't added a device for. Your
heat pump's full total is the sum across all your Nibe devices, which is what Homey's Energy tab
adds up.

On Main this figure is called **Idle energy**. On the other devices it's **Energy used**.

### How does the app work out how much electricity heating, hot water and cooling each used?

Your heat pump has one electricity meter for everything. It reports its **total power right now**
and **what it's working on**. On every update (every 10 seconds by default) the app reads both,
works out the energy used since the last update, and puts all of it on the function your heat pump
named. Standby goes to Main.

Each moment goes to exactly one function, so the devices always add up to your heat pump's full
total. That's what Homey's Energy tab shows.

Delivered heat works the other way round. Your heat pump counts it per function, so those figures
are read straight from your heat pump and are exact.

### My Heating device shows energy produced but 0 kWh used, even though it's heating

A bug, fixed in **0.9.14**. The reading the app uses for "what is your heat pump working on"
sometimes said **idle** through a whole heating cycle, while the compressor was running and the
produced-energy counter was going up. So all the electricity for that cycle went to Main instead of
Heating. Energy *produced* stayed right, because it's read straight from your heat pump. The
Heating device showed 0 kWh *used*.

The app now cross-checks that reading against a second one and corrects it when it says idle by
mistake. See [`energy-attribution.md`](energy-attribution.md) for how. It only ever corrects an
idle reading. If the first reading already names a function, the app trusts it. The S2125,
S320/S325 and S330/S332 don't have the second reading, so they use the first one alone, as before
0.9.14.

### Why not use my heat pump's own per-function energy figures instead?

Your heat pump keeps them, but it only publishes them **once an hour, for the hour that just
ended**. That's too late for what most people want them for:

- **Electricity prices change faster.** With hourly or 15-minute prices, learning at 15:00 what hot
  water cost between 14:00 and 15:00 puts the cost in the wrong price slot. Homey can't rewrite an
  hour that has passed, so late figures can't be fixed afterwards.
- **There'd be no live power reading.** Your heat pump publishes no current figure per function, so
  the power on each device tile wouldn't exist.
- **Everything would move in hourly steps** instead of while things happen.

So the app uses the live method and checks it against your heat pump's hourly figures every hour.

**How close is it?** Within about **1%** of your heat pump's own hourly figure on measured hot water
cycles, across two heat pump models. That's why the app doesn't adjust toward the hourly numbers.
Your heat pump's hourly figures match what myUplink shows, so that's also about how close to
myUplink you can expect to be.

**What you give up.** Per-function electricity is a close estimate from live readings, so it won't
match myUplink to the last decimal. If Homey restarts or loses contact with your heat pump, the
electricity used during the gap isn't counted. Your heat pump keeps counting, but the app can't see
it.

### I compared for ten minutes and it's wildly wrong.

Compare over a day. Your heat pump's lifetime counters move in 0.1 kWh steps and settle about an
hour behind its own hourly log, so a short comparison can look far off while both figures are fine.
A single 0.1 kWh step can hold several hours of slow build-up.

### The app and myUplink show different power right now.

Both are probably right. Nibe Live reads your heat pump directly every 10 seconds by default.
myUplink goes through NIBE's cloud and can lag by minutes, so they won't match moment to moment.

### Can I see this hour's energy, like menu 3.1 on my heat pump?

No. Your heat pump works it out (that's the filling bar in the menu) but doesn't make it available
over Modbus. Checked three ways: every "hour" title in all six S-series Modbus lists, NIBE's
published symbol list, and the myUplink Homey device. Modbus offers only the *previous completed*
hour.

## COP

### Why is my COP blank?

One of three reasons:

- The 30-day average needs an earlier snapshot to compare against, so it's blank after you first
  pair.
- It stays blank until more than 0.1 kWh has been used in the 30 days, because a tiny amount gives
  a meaningless number.
- A function that never runs, such as a pool you don't have, never reaches that amount, so it shows
  nothing instead of zero.

### Which COP should I trust?

**Total COP on Main.** Both sides of it come from your heat pump's own counters, so it matches
myUplink over the same period. A per-function COP divides a measured heat figure by an estimated
electricity figure, so it carries the estimate's small error.

### Why 30 days and not lifetime?

A lifetime average stops moving. A 30-day average follows the season, so you can see the effect of
a setting change or a cold spell.

### My hot water COP was 15. What happened?

A bug, fixed in **0.9.12**. The delivered-heat counter ran whenever your heat pump ran, while
electricity used only counted when the app could measure it. So months of heat were divided by
hours of electricity. Both now count over the same periods. The affected history was discarded, so
COP is blank for a while after the update and then rebuilds correctly.

### How does the app know how much hot water I have left?

You tell it which tank you have, and it reads the tank's two temperature sensors.

**How it's worked out.** "Hot water available" is litres of **40 °C** water. NIBE uses the same
measure on its tank datasheets, and it's what matters for a shower. 175 litres at 55 °C gives a lot
more than 175 litres of 40 °C water. The app works out how much of the tank is still above 40 °C
from where the boundary between warm and cold water sits between the two sensors, and how hot that
part is. That's also why the figure can read higher than your tank's size. Hot water mixed down to
40 °C makes more than the tank holds.

**Setting it up.** Open the Hot water device, run **Repair**, and pick your tank. There's one entry
per tank family. You don't need to know whether yours is copper, stainless or enamel, because that
changes the answer by about 2%. Without a tank there's no estimate.

**Why you have to choose it.** The app used to work out the size by itself, from the heat your heat
pump reported and how far the sensors rose. On a heat pump with a known 176 L tank it measured
436 L. A charge only stops when the bottom sensor reaches its target, so hot water used *during*
the charge makes it run longer, and that extra heat looks the same as a bigger tank. Charges
usually start because someone is using hot water, so this happens most of the time.

**Treat it as a guide.** Two sensors aren't many for a whole tank. The app can't see the water
above the top sensor or below the bottom one, so during a shower it lags behind the water being
used. It changes steadily in the right direction, which is what a Flow needs.

### It went to zero but the tank isn't empty.

That's expected. "Hot water available" counts water you could still shower in at 40 °C. Once the
hottest water in the tank is below 40 °C, there is none, even if the tank is full of 39 °C water
that's fine for washing up.

### Hot water available is blank or missing.

If it's missing, no tank has been chosen yet. Run **Repair** on the Hot water device.

If it's there but empty, your heat pump hasn't reported both tank temperatures yet. That clears on
the next update.

### Why does a hot water boost heat past my stop temperature?

Because a boost temporarily switches your heat pump to its **Large** hot water mode and heats to
*that* stop temperature, whatever mode you normally use. NIBE's manuals describe menu 2.1 "More hot
water" as temporarily raising it to luxury hot water, and measurements agree. On an S1155 in demand
mode Small (stop 48 °C), with Large set to 68 °C, a boost ran to **68.4 °C**.

So the setting that decides how hot a boost gets is **Hot water stop (Large)**, even if you don't
use Large day to day.

### My boost stops well short of that. Why?

Most likely the immersion heater isn't available, and the compressor alone can't get there.

The compressor has a hard limit. It must run several degrees hotter than the tank, and a heat pump
can't go past a certain discharge temperature. Expect about **55–60 °C** in the tank on the
compressor alone, less when the source is cold. Above that the immersion heater has to make up the
difference. Two common reasons it doesn't:

- **Operating mode is Auto.** The immersion heater tick box in menu 4.1 on your heat pump,
  **Allow immersion heater** in the app, only applies in **Manual** mode. In Auto your heat pump
  decides for itself and ignores the setting. You can change the mode from the Main device.
- **A schedule blocks it.** Each schedule mode has a switch that blocks the immersion heater, for
  heating and hot water alike. It can't be read over Modbus, so the app can't show it.

On an S1155, five boosts in a row stopped at 53–59 °C with the immersion heater drawing 0 W. First
a schedule had blocked it for a year, then Auto mode ignored the setting. With both fixed and the
mode set to Manual, the immersion heater ran at its full **7 kW** and the same boost reached
68 °C.

### Why doesn't cancelling "More hot water" stop the compressor?

Cancelling ends the *request* straight away. Measured live, your heat pump's own minutes-remaining
and status readings both reset within one update after the boost was turned off. It doesn't
interrupt a compressor cycle that has already started. Your heat pump finishes that cycle to
protect the compressor, like any heat pump.

Turning **Allow hot water** off and on again does stop a running cycle, which was also confirmed,
but the app doesn't do this for you. Forcing the compressor off like that on every cancelled boost
is likely worse for it than letting the cycle finish. It's something you can choose to do now and
then.

## Setup and connectivity

### Can I run this and myUplink at the same time?

Yes. myUplink is a cloud service and doesn't use Modbus. You can't connect a second **Modbus**
integration to your heat pump at the same time. It accepts one client at a time.

### Autodetect didn't find my heat pump.

Modbus TCP has no way to announce itself, and NIBE heat pumps don't advertise themselves, so the app
searches your Homey's subnet for port 502. It only works when **Modbus TCP is on in your heat pump
(menu 7.5.9)** and Homey is on the same subnet. Otherwise enter the IP address by hand. That always
works.

### My devices say "Can't reach your heat pump".

Nothing answered at your heat pump's address. Usually the router gave your heat pump a new IP
address, or it dropped off the network (Wi-Fi is the usual cause). The app tries again by itself,
less often as the outage goes on (down to once a minute). After three minutes it also searches your
Homey's subnet for your heat pump. If it finds **exactly one** unpaired heat pump of the same model,
it moves all of that heat pump's devices there and sends a notification. It won't guess between
two. If the address is a host name instead of a number, the app never replaces it.

The lasting fix is a **DHCP reservation** for your heat pump in your router. To change the address
by hand, edit **IP address** on any one of its devices. The others follow.

"Refused the connection" is different. Something is at that address, but Modbus TCP is off
(menu 7.5.9 on S-series).

"Returns no NIBE data" means something at that address speaks Modbus but returns nothing a heat pump
would. This used to show as -1 everywhere. Check that the address is your heat pump's own and not
another device's, and that Modbus TCP is on (menu 7.5.9). The log records what that address turned
out to be.

### A reading stays blank.

Your model probably doesn't have that reading. Turn on **Debug logging** under **Advanced** in the
device's settings. It lists every reading that has failed, with its Modbus address, and lists them
again after you turn it on. So a log you send for support shows the cause even if the failure
happened hours earlier.

### Why did a Flow card fail with a Modbus error?

Your heat pump refuses changes it considers invalid, most often with "Illegal Function", which
usually means the feature is turned off. The classic case: turning **Allow hot water** off makes
your heat pump block demand mode and "More hot water" entirely. The app logs the error name and the
full response, so the log says which one it was.

## Privacy

### What does "Share anonymous usage data" send?

Your heat pump's model and software (as the code your heat pump reports), which of the six devices
you created (Main, Heating, Hot water, Pool, Cooling, Solar), which features you turned on for each,
which Flow cards and buttons get used, alarm codes, how Autopilot is set up and how each day went,
whether detection worked, and whether the connection to your heat pump drops. Plus your Homey's
version, model, timezone and language.

It doesn't send any reading from your heat pump: no temperatures, no power, no hot water use. A
timestamped log of when your compressor ran and when someone showered would say a lot about when
you're home, and none of the questions the data is for need it. It also sends no IP address, no
serial number, no device or Flow names, and nothing that identifies you. The only ID attached is a
random number created on your Homey.

### Why does the app want this at all?

It's maintained by one person with one heat pump. Whether a feature works on an S1255, an S320 or an
S2125, or whether detection finds anything on them, is otherwise guesswork, because people whose
setup works don't post about it. Knowing which models and functions are in use decides where the
work goes.

### How do I turn it off?

Open the settings of any Nibe device and untick **Share anonymous usage data** under **Privacy**.
It changes for all your Nibe devices and takes effect straight away. You don't need to delete or
repair anything. It's off unless you turned it on. The box during pairing starts unticked.

### Where is the data stored?

In the EU. The app sends to Amplitude's European servers and the data is kept in their EU instance.
It isn't transferred outside the EU. [docs/analytics.md](analytics.md) lists every event and
property, and everything deliberately left out.

### Why did hot water available or COP briefly go blank?

Since 1.2.1, an update must include every reading that estimate needs. If one is missing, the app
shows no estimate until readings resume. It doesn't combine a new temperature with an old one, or
fire a low hot water trigger across a gap in readings.

### Why does a setting now say my heat pump didn't confirm it?

The app checks your heat pump's value after every change from a tile or a Flow. Your heat pump
accepting the change over Modbus doesn't guarantee it applied it. A confirmation error means the new
value couldn't be verified. Check the current value before you try again.
