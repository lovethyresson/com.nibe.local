# F730 first hardware test

This is an experimental build. The purpose is to check the gateway, readings, controls and
energy accounting against your pump. No external electricity meter is required.

## Version 1.3.2: test-channel release only

Start with gateway writes disabled. The current owner's two circuits and display-only EP21-BT50
are already confirmed; do not ask him to repeat the configuration questions below.

1. Install 1.3.2 and choose **Nibe F-series (beta)**. Use nibegw-esp, the existing gateway IP,
   port 502 and the configured unit ID. Allow several minutes for detection. Pair Main, Heating
   and Hot Water if offered; report anything missing or unexpected. This first driver represents
   the main heating circuit, not separate allocation or controls for the upstairs/downstairs circuits.
2. Keep Main's polling interval at 10 seconds. Send screenshots of the detected devices and
   compare outdoor, supply/return and hot-water readings with the pump. Curve control should
   not produce an active room-thermostat dial. The circuit-2 room sensor is not a substitute for
   the main circuit's sensor.
3. Enable Main's Debug logging shortly before a normal hot-water cycle. Observe idle, hot-water
   operation and return to idle. Record approximate start/stop times and any lag in Homey's
   active function or power readings. Send the Homey diagnostic report promptly after the cycle.
4. Confirm whether the earlier CSV numbers were raw or already scaled. Beta watts/kWh remain
   provisional: the current export-based scale has not been established by the hardware log.
   Report blank/zero COP, but do not spend time trying to make the known zero production
   counters display a plausible COP. We need usable production before validating that feature.
5. If practical, restart the Homey app once and check reconnection and retained energy totals.
   Leave all write/Flow-control tests for later. No need to force heating or immersion.

LOG.SET: send the exact configuration used for this run if changed from the supplied 12-entry
file. Adding 43086, 43375, 43141, 42437 and 42439 would prioritize the energy inputs while
retaining those original entries (17 logical parameters total). Generate any revision through
ModbusManager and observe its capacity checks. Do not automatically overwrite his existing
file or assume other automations can lose their broadcast parameters.

## Tester response received 2026-09-13

[Forum response #54](https://community.homey.app/t/157330/54) and the supplied LOG.SET /
MyUplink JSON establish the following. Do not ask for these details again:

- F730 firmware reported as **9721R3**; gateway changes reported as LilyGo board compatibility
  only. Writes are deliberately disabled. Start with observation-only testing; skip control
  steps below unless the owner later chooses to enable writes. Polling does not write settings.
- The attached LOG.SET has **12**, not 15, addresses: 40067, 40004, 44874, 44908, 41928,
  43091, 43084, 43136, 45001, 40083, 40081, 40079. Only 43084 of the six requested energy
  inputs is present. The five priority additions to discuss are 43086, 43375, 43141, 42437,
  42439. Agree the full broadcast selection before replacing his file; the other existing
  parameters may serve his own automations.
- He uses curve control. API 47394 is 0; 47393 is also 0. His reported indoor sensor 40032
  is explicitly Climate system 2 / EP21-BT50. It is not an alias for system 1's 40033. Ask
  whether a second heating circuit is actually fitted and whether system 1 has any room sensor.
- He reports priority 10 and zeros from both power candidates, immersion power and both
  production counters while idle. Idle power zero is plausible; lifetime production counters
  do not normally become zero simply because the compressor stops. Their availability and
  movement still need validation through a complete normal cycle, including gateway word order.
- The 108-entry cloud export is not a Modbus register table. It contains priority as 49994,
  while local Modbus priority is 43086. Frequency is 41778 in the cloud export (0 Hz at its
  timestamp), versus 43136 in LOG.SET and the ModbusManager export. Do not change local
  addresses based solely on cloud IDs. His reported 4-versus-0 observation needs timestamps
  and clarification of which transport supplied each value.

Next useful evidence: agree LOG.SET additions; get timestamped local readings of the six
energy inputs during an ordinary compressor run and production counters before/after the
whole cycle; clarify the climate-system-2 sensor. EEPROM endurance/write persistence has not
been verified for these firmware registers; do not promise that repeated writes are harmless
or infer a lifespan from his report.

## Hot-water log received 2026-09-14

Source: owner's `Modbus-logging(Modbus).csv` (57 nonempty rows) and accompanying forum
screenshot. This is sparse observation, not a continuous power trace suitable for integrating
cycle consumption.

- Run markers: 11:21:00 start, 13:02:07 stop (about 101 minutes). One final 42439 row is dated
  2026-09-15 amid 2026-09-14 rows; do not treat it as a verified next-day follow-up.
- 43086 changes 10 -> 20 -> 10. 43375 changes from 0 to 40–60 and back to 0. 43141 initially
  remains 0 at 11:31 despite mean power 40, then reads 52–60 before returning to 0. Freshness
  remains relevant; active nonzero values are now observed, not just idle responses.
- Values are consistent with the previously reported F730 raw x10 W correction, but the log
  does not itself establish units or absolute accuracy. Confirm whether logger values are raw.
  Existing factor-1 mappings must not be described as validated by this run.
- 43084 remains 0 throughout, so nonzero immersion scaling remains untested.
- Both 42437 and 42439 remain 0 in all four observations each. There is still no usable
  production-counter evidence for this installation and no basis for a numeric COP claim.
- 43136 is 349–350 during operation and 0 after stopping. 41778 is initially 4, later 353–354,
  and still 353 after 43136 falls to zero. All rows are labelled Modbus, even where descriptions
  say API: clarify the actual acquisition path before interpreting this as cloud delay.
- Owner confirms two heating circuits: upstairs radiators and downstairs underfloor heating.
  The circuit-2 indoor sensor is display-only; no room-temperature regulation.

The owner's >=50000 address error does NOT establish a pump-side/cloud restriction. Upstream
[nibegw-esp main/sys_modbus.cpp](https://github.com/nptr/nibegw-esp/blob/master/main/sys_modbus.cpp)
defines MAX_REGS=10000 and adds 40000 to holding offsets. The callback rejects offsets >=10000
with MB_ENOREG; register-update handlers also discard those values. This gateway limitation
alone explains the result if his board-only fork retains that code. Expanding the gateway
would not, by itself, prove any particular cloud parameter is available over the pump bus.

## Before pairing

1. Send your F730 firmware version, the gateway firmware repository/version (including your
   modifications), and the list/export of your 15 LOG.SET parameters. Confirm whether gateway
   writes are enabled. Compare the file with the [suggested LOG.SET baseline](f-series.md#logset-and-slow-reads)
   before the energy test; prioritize operating state, power and production counters. Confirm
   whether an uncached read waits for a reply or first returns exception 04/an old value and
   becomes current on a later read. Do not send Wi-Fi passwords or other credentials.
2. Tell us which accessories/functions you actually have: an installed BT50 indoor sensor,
   whether room regulation is enabled, and any pool, cooling or solar equipment. A supplied
   but uninstalled room sensor does not count as installed.
3. Note or photograph your current heating curve/offset, operating mode, hot-water comfort
   and fan settings so each test change can be restored.

## Pairing and readings

4. Add the **F-series** driver with the gateway IP, port, unit and address mode. For your modified
   nibegw-esp, start with nibegw-esp mode. Send screenshots of the detection result and device
   list, including missing or unexpected functions. Report detection time and any timeouts.
   Leave the polling interval at its default 10 seconds on Main for the first test.
5. Compare Homey's outdoor, supply, return and hot-water temperatures with the pump display.
   If installed, compare BT50 too. Record both readings at approximately the same time.
6. Without active room regulation, Heating should be a heater with curve controls and no room
   temperature dial. With an installed working room sensor and regulation enabled, it should
   become a thermostat. Do not enable room regulation solely for this test if your installation
   normally uses curve control. Report which arrangement you have and what Homey shows.

## Controls: change one thing, confirm, restore

7. In curve mode, move the curve offset by one step; verify the pump panel changes, then restore
   it. In existing room-regulation mode, change the target by 0.5 °C and restore it instead.
8. Switch hot-water comfort between Economy and Normal, confirm at the pump, then restore.
   Start a temporary hot-water boost and cancel it; confirm both operations on the pump panel.
   It is fine to skip boost if it would disrupt your normal schedule.
9. Optionally change normal fan speed by a small amount, confirm it and restore the original.
   Leave periodic hot-water treatment and installer settings unchanged.
10. Test one equivalent Homey Flow action, then restore the value. Also change one tested setting
    at the pump and check Homey follows it (background settings may take several minutes). Report if Homey reports success but the panel does
    not change, or if it displays an error even though the panel did change. Record roughly how
    long each change takes to appear on the pump and in Homey.

Heating/immersion permission controls apply only in their stated operating modes. In Auto,
an explanatory rejection is expected. There is no need to force Manual/addition-only mode
or force the immersion heater just to test those controls.

## Energy and reliability

11. Enable Debug logging on Main before an ordinary heating or hot-water cycle. Ideally observe
    a transition between the two and then idle. Take before/after readings of the pump's heat
    production and consumed-energy counters where available. Include immersion operation if
    it occurs naturally. Send the Homey diagnostic report promptly after the cycle and give
    the approximate start/end times and what the pump was doing. At a transition, note when
    the pump changes function and when Homey's active function and power readings follow it.
12. Check whether live consumption follows the active function, inactive devices settle to zero,
    and production counters advance for the right function. COP starts blank until enough energy
    has accumulated; a stable value is not expected immediately. Main may show zero because
    auxiliary/standby consumption is not included. Flag readings that look ten times too small
    or large: compressor scaling is a specific unresolved question.
13. After restoring test settings, restart the Homey app and check that devices reconnect and
    accumulated app energy is retained. Run Repair and check selections survive. If practical,
    briefly interrupt only the gateway's network connection and restore it; check Homey becomes
    unavailable and recovers. Do not disconnect the gateway from the pump's accessory bus.

For each issue, send: what you did, approximate time, expected result, actual Homey result,
the corresponding pump-panel result, and the diagnostic-report reference. App version is
already included in the Homey report. There is no need to complete every optional test before
sending the first results; pairing, one control and one full operating cycle are the priorities.

Debug produces one compact energy/room snapshot per minute for up to two hours after enabling.
It also captures a short raw transport sample. Homey's log buffer is finite, so do not leave
report submission until the next day. Longer gateway/USB logs are useful if already available.

## What this test cannot establish

One F730 validates that pump/firmware/gateway combination. It does not prove MODBUS 40 bridge
compatibility or coverage of other F-series models. Without an independent meter we can check
consistency and timing, but cannot independently prove absolute electricity accuracy.

## First paired-device report, 1.3.3 (2026-09-15)

Manual connection succeeded; automatic discovery did not. The 122 detection count represents
61 parameters sampled twice, not a table of 122 different registers. Main, Heating, Hot Water
and an unexpected Solar device were added.

Confirmed mapping error: current labels were reversed. ModbusManager identifies 40079 as BE3,
40081 as BE2, and 40083 as BE1. Corrected the F labels without changing addresses or word order.

The reported currents 190054.4 A and 124518.4 A are exactly 65536 times 2.9 A and 1.9 A.
This is evidence to investigate word order/alignment; it is not proof of a specific fix. Get
actual words/count/address from diagnostics and verify the gateway's required pump word-swap
setting before changing decoding. Average outdoor -1451.6 °C and GP2 65304% are invalid too,
but those are 16-bit values and a 32-bit word-order correction alone cannot explain them.

Fan register 43108 conflicts across sources: ModbusManager calls it percentage fan speed,
whereas the owner's API export calls it current fan mode and reports 0. The separate cloud
50221 reports 85%. Do not blindly replace a local address with that cloud identifier or treat
zero mode as a confirmed zero fan speed. Compare local behavior before remapping.

Solar recommendation can currently follow any movement during detection, even when the final
values are zero. Raw detection evidence is needed to distinguish this from a positive cached
counter, corrupt value or manual selection. Do not treat the paired Solar device as hardware
presence. Zero production/COP continues to be unresolved. Cloud/local temperature comparisons
need aligned timestamps; do not use their differences alone to choose alternate registers.

## Follow-up: word swap confirmed and adjacent sensors identified (2026-09-16)

Word swap has been enabled throughout. The owner's five temperature comparisons consistently
show the next register (BT14 -> BT15, BT15 -> BT16, BT7 -> BT6, BT3 -> BT7, BT20 -> BT21).
The installation PDF confirms nibegw-esp selected and Solar recommended automatically.
This supports an address offset fault, not a request to turn word swap on again.

Corrected nibegw's profile base from 40000 to 40001 to account for ESP-Modbus's one-based
callback. Simulator and regression fixtures now model that convention. Request correction
applies to existing devices at app restart; use Repair to refresh feature selection afterwards.
Keep writes disabled until the owner confirms sensor identity on the corrected build.
47265 remains the normal fan-speed setting, not actual measured fan speed. Leave 43108's
meaning and production/power-source support open until reading the corrected addresses.

## Confirmed wire captures (2026-09-16)

QModMaster address base zero, unit 1, FC03 confirms:

| NIBE id | Wire address / words | Raw reply words (hex) | Interpretation |
| --- | --- | --- | --- |
| 40025 BT20 | 24 / 1 | 00DB | 21.9 °C, owner verified |
| 40026 BT21 | 25 / 1 | 00E4 | 22.8 °C, owner verified |
| 40079 BE3 | 78 / 2 | 0032 0000 | 5.0 A, low word first |
| Mid-value 40080 | 79 / 2 | 0000 0020 | Misaligned: 209715.2 A if decoded as BE3; not 3.2 A |

The last read crosses a parameter boundary. Samples were taken at different times;
there is no simultaneous comparison proving accuracy of a neighboring phase value.
Exact TCP request/response fixtures are covered by `test/f-simulator.test.ts`.

In the next test build, select **Register addressing: 40025 → 24**. Existing saved
`nibegw` selections keep this convention automatically. Keep writes disabled, restart
the app and run Repair to repeat detection; compare temperatures and all three phase
currents against the pump, then collect diagnostics over a hot-water cycle.
No word-order, scaling, energy-allocation or other business-logic changes accompany
this connection correction. Production and power remain to be verified on hardware.
