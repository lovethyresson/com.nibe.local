# Tone review, November 2026

This review checks every owner-facing English text in Nibe Live against the writing rules in
`CLAUDE.md` and the maintainer's corrections from 2026-11-15. It changes no code or copy. Each
finding comes with a proposed text. The short version of the rules is in [voice.md](voice.md).

English comes first. The translations were reviewed as well, but those findings are set aside in the
appendix until the English is right.

## Scope

`.homeycompose/locales/en.json`, `locales/en.json`, `.homeycompose/capabilities/*.json`,
`.homeycompose/app.json`, `drivers/nibe_s/driver.compose.json`, `drivers/nibe_s/driver.flow.compose.json`,
the `info` lines in `drivers/nibe_s/registers.ts`, the pairing and repair views, `assets/pair/*.js`,
widget names and fallback text, owner text in `lib/`, `lib/release-announcements.ts`, `help/*.html`,
`docs/FAQ.md`, and the three newest changelog entries. Changelog entries that are already uploaded
can't be changed, so those findings only apply to the next entry.

Findings are grouped by rule, then by file. One row can cover several strings that need the same fix.

| ID | Rule |
|---|---|
| R0 | Errors: wrong meaning, typos, facts the app contradicts |
| R1 | Plain voice: no contrast pairs, em-dash asides, colon punchlines or developer words |
| R2 | "Expensive" and "cost more", never "dear" or "pricier" |
| R3 | "Your heat pump" for the machine, "device" only for a Homey tile |
| R4 | "Autopilot", with the modes "Live" and "Simulated" |
| R6 | One line for UI text, one or two sentences for a hint |
| R7 | Natural English and the right heat-pump terms |
| R8 | One term for each concept |
| R9 | Text that explains what the screen or a visual should show |
| R10 | The AI voice: slogan headings, number hooks, reassurance, the app talking about itself |

## Summary

There are 293 English findings.

| R0 | R1 | R2 | R3 | R4 | R6 | R7 | R8 | R9 | R10 | Total |
|---|---|---|---|---|---|---|---|---|---|---|
| 27 | 95 | 3 | 16 | 9 | 7 | 4 | 37 | 16 | 79 | 293 |

Most of the problems are on the help pages and in the FAQ. The settings and Flow cards are mostly
fine. The word rules are mostly followed. "Dear" no longer appears in owner text, and only three
cases of "pricier" or "pricey" are left.

The biggest problem is the voice of the help pages. Almost every heading is a two-part slogan, such as
"Warm rooms. Your rules.", "Summer, sorted." or "Every kWh. In its place.", and the paragraphs
underneath use the same habits. `CLAUDE.md` asks for this headline style, so the first review pass
didn't flag it. R10 lists every heading with a plain replacement. Each help page needs a full
rewrite.

## Ten most important findings

1. Every help page heading is written as a slogan (R10). Change the `CLAUDE.md` rule along with them,
   so new pages don't come out the same way.
2. The help pages contain about 30 contrast pairs, for example "Not how full. How much shower.",
   "Cancel stops the ask. Not the run." and "Close to myUplink. Not identical."
3. The FAQ contradicts the app in six places (`docs/FAQ.md`). It puts night cooling on Heating and
   says the app reads every 5 s, when the default is 10 s. It also uses old names: "native sensor",
   "Always keep at least", "Allow additional heat" and "Total energy consumed". It says "the pump" on
   79 lines and uses "register" and "poll".
4. Heating setup describes Away as "A lower temperature while you're out"
   (`locales/en.json → pair.setup.smart.ctl_away_sub`). That suggests using Away every day. Use "A
   lower temperature while you're on holiday". Two help pages also use "holiday" to mean a day off
   (`help/autopilot-hot-water.html:61`, `help/flows.html:74`).
5. The Simulated mode still appears as "Simulation" in nine strings: the timeline, status lines, the
   widget badge, setup buttons and a Flow hint. Smart mode calls it "Autopilot · Simulated".
6. The ±6 °C comfort range is called "I'd rather freeze" on one Flow card
   (`driver.flow.compose.json:3188`). Everywhere else it is "Save more".
7. Flow cards that still appear in new Flows use the word "register": "Register turned on/off", "A
   register is on", "Value comparison", and the "Register" picker. Use "setting".
8. About 30 error messages and warnings are written straight into `lib/device.ts` and
   `lib/connection.ts`. They say "pump", "register" and "feed", and `write_failed` shows raw Modbus
   error text in the timeline.
9. The immersion heater has four names: "immersion heater" (36), "additive heater" (7), "additional
   heat" (5) and "electric addition" (4). The operating-mode hint says "additional heat only" next to
   the option "Immersion heater only". The "Allow immersion heater" hint also says "Hot water has its
   own separate switch", which the code doesn't confirm.
10. The heat curve info gives a range of 0–10, but the picker and the Flow hints go up to 15
    (`drivers/nibe_s/registers.ts:577`).

## Decisions for the maintainer

1. Help page headings: replace the slogan style with a heading that names the topic, and change the
   `CLAUDE.md` rule to match. R10 assumes yes.
2. Heat curve: "offset" or "displacement". Displacement is used 11 times and offset 4 times. The
   register info already says offset, so the proposal is offset.
3. Outdoor or outside temperature: 59 times against 2. The proposal is outdoor.

# Findings

## R0. Errors


### .homeycompose/capabilities/hotwater_periodic_interval_NIBE.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| .homeycompose/capabilities/hotwater_periodic_interval_NIBE.json → values[7/14/21/28].title (en) | 7 = Days | 7 days | Reads as "7 equals Days". Same for 14, 21, 28. |

### .homeycompose/capabilities/hotwater_periodtime_NIBE.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| .homeycompose/capabilities/hotwater_periodtime_NIBE.json → values[30/45/60/120].title (en) | 30 = Minutes | 30 min | Reads as "30 equals Minutes". Same for 45, 60, 120. |

### .homeycompose/locales/en.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| .homeycompose/locales/en.json → autopilot.hotwater_charge.detail.pump (en) | Your heat pump started it at __top__ °C on its own start temperature and runs to __stop__ °C. | Your heat pump started it on its own at __top__ °C and heats to __stop__ °C. | "on its own start temperature" is broken grammar. |
| .homeycompose/locales/en.json → autopilot.smart.paired_failed (en) | Smart mode from setup couldn't be applied: __reason__ Finish it in Repair. | Couldn't apply Smart mode from setup. Finish it in Repair. __reason__ | Reasons like pair.not_connected have no full stop, so sentences run together. |

### docs/FAQ.md

| Where | Current | Proposed | Why |
|---|---|---|---|
| docs/FAQ.md:99 | Use the heat pump’s native temperature sensor | Use your heat pump’s own temperature sensor | Old option name; app and heating.html:127 say this. |
| docs/FAQ.md:130 | Autopilot's **Always keep at least** | Autopilot's **Always enough for a shower** | Old setting name. |
| docs/FAQ.md:181 | The capability is titled "Total energy consumed" on every device | On Main it's called Idle energy. | Main shows Idle energy, others Energy used (lib/roles.ts:516). |
| docs/FAQ.md:246 | This app polls the pump directly every 5 seconds | Nibe Live reads your heat pump every 10 seconds | Default is 10 s (POLL_SECONDS_DEFAULT), help says 10 s. |
| docs/FAQ.md:313 | below 40, there is none | below 40 °C, there is none | Missing unit. |
| docs/FAQ.md:343–344 | the app's **Allow additional heat** | **Allow immersion heater** | The card and setting are named Allow immersion heater. |
| docs/FAQ.md:348 | see the schedules question above | (drop) | No schedules question exists in the FAQ. |
| docs/FAQ.md:370–375 | Where did night cooling go? Since 1.4.4 it is on the Heating device… | (delete; :142–146 already answers it) | Contradicts :144, which says Main since 1.4.7. |
| docs/FAQ.md:403 | "Answers, but returns no heat pump data" | "Answers, but returns no NIBE data" | Quote doesn't match the app string or troubleshooting.html:28. |

### drivers/nibe_s/driver.compose.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| drivers/nibe_s/driver.compose.json:615 | Compressor supplied power | Compressor power | Info says power drawn; "supplied" reads as the opposite. |
| drivers/nibe_s/driver.compose.json:637 | Fuse incoming | Main fuse | Word order isn't English. |

### drivers/nibe_s/driver.flow.compose.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| drivers/nibe_s/driver.flow.compose.json:911 (h93 hint) and registers.ts:604 | How long your heat pump makes heating before switching demand. | How long your heat pump heats the house before it moves on to hot water or pool. Accepts 0 to 180 minutes. | "makes heating" is ungrammatical, "switching demand" is jargon. |
| drivers/nibe_s/driver.flow.compose.json:2024, 2086, 2148, 2210, 2334, 2396, 2458 (hints of More hot water, Night cooling, Periodic hot water, Pool heating, Allow heating, Allow cooling, Allow hot water) | Night cooling using the exhaust air fan | Night cooling using the extract air fan. | No full stop; every other Flow hint has one. |
| drivers/nibe_s/driver.flow.compose.json:2272 (h180 hint) | …for heating. Hot water has its own separate switch. | Lets the immersion heater help with heating. | Unverified; registers.ts says hot water scope is untested, no such switch exists. |
| drivers/nibe_s/driver.flow.compose.json:2892 (set_numeric_value hint) | Prefer the named cards ("Set the heat curve to …") | Use a named card, like "Set heat curve", when there is one. | Quoted card doesn't exist; the real title is "Set heat curve". |
| drivers/nibe_s/driver.flow.compose.json:3188 | I'd rather freeze (±6 °C) | Save more (±6 °C) | Card hint and help say Comfort, Save, Save more. |
| drivers/nibe_s/driver.flow.compose.json:3219 + 3241/3243 (autopilot_heating_away) | title "Set Autopilot heating Away", sentence "Turn Autopilot heating Away [[away]]", values "on"/"off" | "Autopilot heating Away" / "Autopilot heating Away – [[state]]" / "On"/"Off" | Title and sentence disagree; lowercase values unlike every other on/off card. |

### drivers/nibe_s/registers.ts

| Where | Current | Proposed | Why |
|---|---|---|---|
| drivers/nibe_s/registers.ts:577 | Selector for the heat curve slope (0–10) | Selector for the heat curve slope (0–15) | pickerValues and both Flow hints run 0 to 15. |

### help/energy.html

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/energy.html:89 | Totals start when you added the device | Totals start from the day you added the device | Tense mismatch. |

### locales/en.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| locales/en.json → pair.setup.smart.ctl_away_sub (en) | A lower temperature while you're out | A lower temperature while you're on holiday | Away is for a week+ holiday, never for going out. |
| locales/en.json → pair.setup.smart.solar_evidence (en) | …to the grid on sunny hours. | …to the grid in sunny hours. | Wrong preposition. |
| locales/en.json → pair.setup.smart.solar_evidence_plain (en) | Your meter sends power to the grid on sunny hours. | Your meter sends power to the grid in sunny hours. | Wrong preposition. |
| locales/en.json → pair.setup.active_note (en) | …use Heating Setup to return to your NIBE sensor first. | …use Heating setup to return to your NIBE sensor first. | On-screen name is "Heating setup", sentence case. |

## R1. Plain voice


### .homeycompose/capabilities/curve_mode/curve_displacement/hotwater_demand/hotwater_periodic_interval/hotwater_periodtime_NIBE.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| .homeycompose/capabilities/curve_mode/curve_displacement/hotwater_demand/hotwater_periodic_interval/hotwater_periodtime_NIBE.json → title (en) | Heatcurve set, Heatcurve displacement, Hotwater demand set, Periodic hotwater interval set, Periodic hotwater length set | Heat curve, Heat curve offset, Hot water demand, Periodic hot water interval, Periodic hot water length | Code-style compounds and a stray "set". |

### .homeycompose/capabilities/hotwater_demand_NIBE.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| .homeycompose/capabilities/hotwater_demand_NIBE.json → values[0/1/2/4].title (en) | 0 = Small … 4 = Smart control | Small … Smart control | Raw register values leak into the picker. |

### .homeycompose/capabilities/hotwater_increase_NIBE.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| .homeycompose/capabilities/hotwater_increase_NIBE.json → values[*].title (en) | 0 = Off, 2 = 2 hours … 48 = 48 hours | Off, 2 hours … 48 hours | Raw value repeats the label. |

### .homeycompose/capabilities/measure_count/hour/minute/enum/percentage_NIBE.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| .homeycompose/capabilities/measure_count/hour/minute/enum/percentage_NIBE.json → title (en) | Measure Count, Measure Hour, Measure Minute, Measure enum, Measure percentage | Count, Runtime, Time, Status, Percentage | Developer names shown wherever an instance lacks a title. |

### .homeycompose/locales/en.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| .homeycompose/locales/en.json → pair.features.insights_note (en) | Disabling a feature removes its capabilities, including their Insights history. | Turning a feature off removes its readings and their Insights history. | "capabilities" is a developer word. |
| .homeycompose/locales/en.json → pair.discover.confirm (en) | Found your heat pump — tap to confirm | Found your heat pump. Tap to confirm. | Em dash aside. |
| .homeycompose/locales/en.json → pair.firmware.online_body (en) | …in the myUplink app — or on your heat pump's display: swipe to… | Approve it in the myUplink app, or on your heat pump's display. Swipe to the product overview and tap Update. | Em dash and colon delivery. |
| .homeycompose/locales/en.json → pair.firmware.f_body (en) | The steps differ between models — your heat pump's manual shows how. | The steps differ between models. Your heat pump's manual shows how. | Em dash aside. |
| .homeycompose/locales/en.json → autopilot.hotwater_charge.plan.moved (en) | Changed: the plan had it at __time__. | Moved. The plan had it at __time__. | Colon delivery; recap already says "Moved." |
| .homeycompose/locales/en.json → autopilot.heating.warning.no_outdoor (en) | Autopilot heating paused: no outdoor temperature. | Autopilot heating is paused. It has no outdoor temperature. | Banned "paused: …" colon pattern. |
| .homeycompose/locales/en.json → autopilot.heating.warning.spa_on (en) | Autopilot heating paused: Smart price adaption is on for heating. | Autopilot heating is paused. Smart price adaption is on for heating. | Colon delivery. |
| .homeycompose/locales/en.json → autopilot.heating.warning.room_control (en) | Autopilot heating paused: room-sensor control is on in your heat pump. | Autopilot heating is paused. Room-sensor control is on in your heat pump. | Colon delivery. |
| .homeycompose/locales/en.json → autopilot.heating.warning.immersion_only (en) | Autopilot heating paused: your heat pump runs on the immersion heater only. | Autopilot heating is paused. Your heat pump runs on the immersion heater only. | Colon delivery. |
| .homeycompose/locales/en.json → autopilot.heating.warning.cooling (en) | Autopilot heating paused: your heat pump is cooling. | Autopilot heating is paused. Your heat pump is cooling. | Colon delivery. |
| .homeycompose/locales/en.json → autopilot.heating.status.paused.{no_outdoor,spa_on,room_control,immersion_only,cooling} (en) | Paused: outdoor temperature stopped reporting (and 4 more) | Paused · no outdoor temperature (same `·` form for the rest) | Colon delivery; other status lines use `·`. |
| .homeycompose/locales/en.json → autopilot.heating.status.waiting (en) | Starting: waiting for the forecast | Starting · waiting for the forecast | Colon delivery; matches "Holding · …". |
| .homeycompose/locales/en.json → autopilot.heating.status.range_off (en) | Comfort range is Off: your heat pump sees the real outdoor temperature | Comfort range is Off. Your heat pump uses the measured outdoor temperature. | Colon delivery. |
| .homeycompose/locales/en.json → autopilot.heating.verify.no_outdoor (en) | No outdoor temperature yet: choose a sensor or set your location… | No outdoor temperature yet. Choose a sensor, or set your location for the weather forecast. | Colon delivery. |
| .homeycompose/locales/en.json → autopilot.smart.verify_first (en) | Turn Autopilot on in Heating → Repair → Smart mode: it checks your heat pump takes the outdoor temperature first. | Turn Autopilot on in Heating → Repair → Smart mode. It first checks that your heat pump takes the outdoor temperature. | Colon delivery; "first" is misplaced. |

### assets/pair/devices.js

| Where | Current | Proposed | Why |
|---|---|---|---|
| assets/pair/devices.js:86, assets/pair/features.js:112 | `' — ' + value + ' °C'` | `' · ' + value + ' °C'` | Em dash; the single-source line above already uses " · ". |

### docs/FAQ.md

| Where | Current | Proposed | Why |
|---|---|---|---|
| docs/FAQ.md (41 lines) | e.g. :159 That's deliberate — it's what lets the per-device figures reconcile… | This lets the devices add up to the same total. | Em-dash asides throughout the owner FAQ. |
| docs/FAQ.md:138, 150, 199–211, 251, 410–418 | "register(s)" (12×), e.g. :410 doesn't implement that register | doesn't have that reading | Developer word in owner text. |
| docs/FAQ.md:246, 321, 358 | polls / next poll / within one poll | reads / next reading / within seconds | Developer word in owner text. |
| docs/FAQ.md:26 | the S-series operational explanation uses the average too | the app's explanation of what your heat pump is doing uses the average too | Developer phrasing. |
| docs/FAQ.md:183 | It's a known wart, not a miscalculation. | (drop) | Contrast pair, and the answer is outdated (R0). |
| docs/FAQ.md:306 | Treat it as a good guide, not a gauge. | Treat it as a good guide. | Contrast pair. |
| docs/FAQ.md:360 | That's normal short-cycling protection, present on essentially every heat pump, not a bug here. | That protects the compressor, like on any heat pump. | Contrast pair plus jargon. |
| docs/FAQ.md:430–431 | That is a deliberate line, not an oversight: a timestamped log… | A timestamped log… | Contrast pair plus colon punchline. |

### drivers/nibe_s/driver.compose.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| drivers/nibe_s/driver.compose.json:1605 | Poll interval (seconds) | Update interval (seconds) | "Poll" is a developer word. |
| drivers/nibe_s/driver.compose.json:218, 956, 967, 978; driver.flow.compose.json:937, 953, 979, 995, 1021, 3287; registers.ts:606, 609 | Degree minutes / Compressor start degree minutes / Cooling degree minutes | Heat deficit (DM) / Compressor start (DM) / Cooling demand (DM) | Listed developer word; lead plain, keep Nibe's DM code beside it. |

### drivers/nibe_s/driver.flow.compose.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| drivers/nibe_s/driver.flow.compose.json:137 (priority_changed token example) | The house fell behind on heat: degree minutes are down to -60, at or past the -60 threshold that starts the compressor. | The house needs heat, so the compressor started. | Colon punchline, "degree minutes", "threshold", too long for an example. |
| drivers/nibe_s/driver.flow.compose.json:234, 250, 297, 313 (capability_turned_on/off, live cards) | Register turned on · Fires when the selected on/off register switches on. | A setting turned on · Fires when the setting you pick turns on. | "Register" in live, non-deprecated cards. |
| drivers/nibe_s/driver.flow.compose.json:178, 212, 262, 276, 325, 339, 2905, 2960, 3003, 3299, 3462 (arg/token titles) | Register | Setting | Developer word shown in every generic card's picker. |
| drivers/nibe_s/driver.flow.compose.json:3287 (numeric_value_comparison hint) | Compares any readable numeric register against a value. Useful for readings that have no card of their own, such as degree minutes or compressor frequency. | Compares a reading with a value. Useful for readings without a card, like compressor frequency. | "register", "degree minutes"; card is live. |
| drivers/nibe_s/driver.flow.compose.json:3433 (feature_enabled title) | A register is on (advanced) | A setting is on (advanced) | Developer word in a live card. |
| drivers/nibe_s/driver.flow.compose.json:2876, 2892, 2931, 2947, 2974, 2990 (deprecated set/enable/disable) | Set value of a register (advanced) · …— this is the escape hatch for registers that have none. | Set a setting (advanced) · Sets any adjustable setting by name. Use a named card when there is one. | "register", "Modbus", "escape hatch", em dashes; still shown in existing Flows. |
| drivers/nibe_s/driver.flow.compose.json:670 (autopilot status token example) | Easing off until 19:00: prices peak 17:00–19:00 | Easing off until 19:00 · Prices peak 17:00–19:00 | Colon-delivered reason; timeline style is decision · why. |
| drivers/nibe_s/driver.flow.compose.json:1247 (h61 hint) and registers.ts:657 | …needs the immersion heater — a compressor alone tops out in the high 50s… | Stop temperature for the periodic anti-legionella charge. It usually needs the immersion heater. Accepts 55 to 70 °C. | Em dash aside; the compressor reasoning belongs in help. |
| drivers/nibe_s/driver.flow.compose.json:1373 (h94 hint) and registers.ts:660 | …heats the pool before switching demand. | How long your heat pump heats the pool before it moves on to heating or hot water. | "Switching demand" is jargon. |
| drivers/nibe_s/driver.flow.compose.json:1646 | …towards cheaper hours. Runs 1 to 4, not 1 to 10 like heating. | How strongly Smart price adaption may move hot water to cheaper hours. Accepts 1 to 4. | "X, not Y" contrast pair. |
| drivers/nibe_s/driver.flow.compose.json:3033 (external BT1 hint) | Enable external BT1 in menu 7.5.9.2 on your heat pump. Sends one reading; your Flow must supply fresh readings regularly. Success means the write was accepted, not that heating uses it. | On your heat pump, menu 7.5.9.2. Turn on external BT1. Then run this card regularly with a fresh reading. | Semicolon, "not that" contrast, "write"; CLAUDE.md wording for BT1. |
| drivers/nibe_s/driver.flow.compose.json:3785 (hotwater_volume_below hint) | Needs a tank picked in Repair; false without one. | Needs a tank, set in Hot water setup. False without one. | Semicolon; screen is called Hot water setup. |

### drivers/nibe_s/registers.ts

| Where | Current | Proposed | Why |
|---|---|---|---|
| drivers/nibe_s/registers.ts:119, 250, 416 | Room sensor BT50 — wired or external input · Average outdoor temperature — what the heating cut-off is judged against · Smart Price Adaption — shift consumption… | Room sensor BT50, wired or external input · Average outdoor temperature. Automatic mode uses it to stop heating · Smart price adaption. Moves heating to cheaper hours | Em dashes as asides in pairing text. |

### help/autopilot-heating.html

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/autopilot-heating.html:16 | Warm home. Smarter hours. | Autopilot for heating | "Smart" flourish, and it blurs with Smart mode. |
| help/autopilot-heating.html:55 | No new controls inside your heat pump. Autopilot changes one thing it already listens to. | Autopilot changes the outdoor temperature (BT1) your heat pump uses. | "No X" opener for rhythm. |
| help/autopilot-heating.html:60 | Autopilot sends it a slightly different one: a touch colder before a price peak, so it heats more, and a touch milder during it… | Before a price peak it sends a slightly lower temperature, so your heat pump heats more. During the peak it sends a slightly higher one, so it heats less. | Colon delivers the point. |
| help/autopilot-heating.html:80–81 | For a week or more away, not a day at work. | For a week or more away. | Contrast pair. |
| help/autopilot-heating.html:102 | Easing off · Until 19:00: <em>prices peak 17:00–19:00</em> | Easing off · Until 19:00. Prices peak 17:00–19:00 | Colon punchline, copied from the app (heating-status.ts:84 `: ${why}`). |

### help/autopilot-hot-water.html

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/autopilot-hot-water.html:17 | No schedules. Nothing to tune. | It learns all of it from your own tank. | "No X. No Y." pair, even on the reference page. |

### help/devices.html

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/devices.html:30 | alarms in plain words instead of codes | alarms in plain words | Contrast pair. |
| help/devices.html:115 | add every job you want metered: skip Hot water, and the energy… | add every job you want metered. Skip Hot water, and the energy… | Colon delivers the point. |

### help/energy.html

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/energy.html:32 | Your heat pump has one electricity meter, not four. But it always says what it's busy with. | Your heat pump has one electricity meter, and it also reports what it is working on. | Contrast pair. |
| help/energy.html:46 | …lands on Main instead. Nothing goes missing. It's counted on Main instead of on its own. | …lands on Main. | Says the same thing twice. |
| help/energy.html:50 | so it's read straight off and not estimated. | so it's read straight off. | Contrast pair. |
| help/energy.html:86 | Close to myUplink. Not identical. | Compared with myUplink | "X. Not Y." |
| help/energy.html:89 | Totals start when you added the device, not when your heat pump was installed. Compare a day or a week, not the totals. | Totals start from the day you added the device. Compare a day or a week. | Two contrast pairs in one pill. |
| help/energy.html:91 | Live, not hourly | Counted live | Contrast pair as a title. |
| help/energy.html:102 | stays blank rather than showing nonsense. | stays blank. | Contrast pair. |

### help/flows.html

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/flows.html:39 | No long lists to scroll through. Each card is named after… | Each card is named after the setting it changes, on the device it belongs to. | "No X" opener. |
| help/flows.html:74 | Holidays and days working from home, without touching anything. | Days off and days working from home, set by your calendar. | "Without X" flourish (see R8 for holidays). |

### help/getting-started.html

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/getting-started.html:17 | No cloud account. Readings in seconds. | It works without a cloud account, and readings arrive in seconds. | "No X. Y." pair. |
| help/getting-started.html:103 | …at the same time: your heat pump takes one at a time. | …at the same time. Your heat pump takes one at a time. | Colon delivers the point. |
| help/getting-started.html:104 | COP is the exception: it's blank on purpose until there's enough to go on. | COP is the exception. It stays blank until there's enough to go on. | Colon delivers the point. |

### help/heating.html

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/heating.html:67 | …average outdoor temperature, not this minute's. So a warm afternoon… | …average outdoor temperature, so a warm afternoon doesn't switch heating off on its own. | Contrast pair. |
| help/heating.html:79 | Pick one, or several: each counts equally. | Pick one or several. Each counts equally. | Colon delivers the point. |
| help/heating.html:80 | turn on the external room sensor (setup calls it BT50) in 7.5.9.2 | turn on the external room sensor (BT50) in menu 7.5.9.2 | Code goes next to the plain words, without commentary. |
| help/heating.html:115 | A Flow that succeeds means your heat pump accepted the value, not that heating uses it. | A Flow that succeeds only means your heat pump accepted the value. | Contrast pair. |

### help/hot-water.html

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/hot-water.html:17 | No more guessing from temperatures. | (drop the bold line) | "No more X" flourish. |
| help/hot-water.html:39 | Not how full. How much shower. | What the litres mean | "Not X. Y." |
| help/hot-water.html:93 | Cancel stops the ask. Not the run. | Cancel stops the request. A started run finishes. | "X. Not Y." |
| help/hot-water.html:94 | That's normal protection for the compressor, not a fault. | That protects the compressor. | Contrast pair. |
| help/hot-water.html:105 | It's counting showers, not filling. | (drop) | Contrast pair, repeats the sentence before. |
| help/hot-water.html:108 | Treat it as a good guide, not a meter. | Treat it as a good guide. | Contrast pair. |

### help/index.html

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/index.html:33 | No cloud account, no waiting. | (drop; the Local tile already says readings arrive in seconds) | "No X, no Y." |

### help/troubleshooting.html

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/troubleshooting.html:40 | compare how much it changed over a day, not the totals. | compare how much it changed over a day. | Contrast pair. |
| help/troubleshooting.html:42 | stays blank rather than showing a made-up number. | stays blank. | Contrast pair. |
| help/troubleshooting.html:43 | Nibe Live shows nothing rather than mixing a fresh number with an old one. | Nibe Live shows nothing until it has a full reading again. | Contrast pair. |

### lib/connection.ts

| Where | Current | Proposed | Why |
|---|---|---|---|
| lib/connection.ts:134 | Illegal function — this pump doesn't have this register, or a pump setting has switched it off | Your heat pump doesn't have this setting, or it's switched off there. | Em dash, "register"; reaches Flow errors and timeline. |
| lib/connection.ts:135-139 | Illegal data address — no such register…; Illegal data value — the value is outside the range the pump accepts; Server device busy — the pump is busy; retry later | Your heat pump doesn't have this setting. / Your heat pump doesn't accept this value. / Your heat pump is busy. Try again in a minute. | Em dashes, semicolon, protocol jargon. |

### lib/device.ts

| Where | Current | Proposed | Why |
|---|---|---|---|
| lib/device.ts:148 | Heating feed is unavailable. | Homey can't send the temperature right now. | "feed" is a developer word. |
| lib/device.ts:157-159 | BT50 confirmation is still pending. Sent 21.0 °C; the pump reports 20.5 °C. The saved feed will retry in the background. | Your heat pump hasn't confirmed BT50 yet. Homey sent 21.0 °C and keeps trying. | Semicolon, "feed", "the pump". |
| lib/device.ts:173, 208 | A temperature update is in progress. Please try again. | A temperature update is running. Try again in a moment. | No "please". |
| lib/device.ts:329 | Nibe Live: indoor temperature feed needs attention. Open Heating → Repair. | Nibe Live can't send the indoor temperature. Open Heating → Repair. | "feed"; lead with what's wrong. |
| lib/device.ts:510, 512, 520 + lib/connection.ts:980-1020 | This driver is currently read-only. / BT50 is managed by the automatic indoor sensor feed. / This register is read-only | This setting can't be changed from Homey. / Homey sends BT50 for you while your sensors are set up. | "driver", "register", "feed". |
| lib/device.ts:1091-1093 | N capability/capabilities could not be applied: … The selection was saved — try Repair again, and if it keeps failing please report it with the app logs. | Some readings couldn't be added. Your choice is saved. Run Repair again, and report it if it keeps happening. | Slash, em dash, "please", "capabilities". |

### lib/driver.ts

| Where | Current | Proposed | Why |
|---|---|---|---|
| lib/driver.ts:1498 + lib/connection.ts:421 | This address is already paired with a different pump driver. Remove that device before changing series. | This address is already paired with another heat pump model. Remove those devices first. | "driver" and "series" are developer words. |

### lib/registers.ts

| Where | Current | Proposed | Why |
|---|---|---|---|
| lib/registers.ts:214, 240 | Invalid option "x" for measure_enum_NIBE.i1028_priority… | That option isn't valid any more. Pick it again in the Flow. | Shows the internal capability ID. |

### locales/en.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| locales/en.json → pair.setup.handover_hint (en) | …The current feed continues until you verify here. | …Homey keeps sending temperatures until you verify here. | "feed" is a developer word. |
| locales/en.json → pair.setup.no_nibe_sources (en) | No live NIBE source choices were detected. The current/default source will be kept. | No other NIBE sensors found. The current one stays in use. | Jargon and a slash. |
| locales/en.json → pair.setup.thermostat_zone_intro (en) | Choose the zone that controls the heating: on your heat pump, that zone's room sensor is set to control (menu 1.3.3). | Choose the zone that controls the heating. Its room sensor is set to control on your heat pump (menu 1.3.3). | Colon delivery. |
| locales/en.json → pair.setup.request_timeout (en) | Homey did not respond. Please try again. | Homey didn't respond. Try again. | No "please". |
| locales/en.json → pair.setup.success_title (en) | You're all set! | Setup is done. | No exclamation marks. |
| locales/en.json → pair.setup.smart.prices_fixed (en) | Fixed price: nothing to shift. Set dynamic prices in Homey Energy. | Autopilot needs hourly prices. Set them up in Homey Energy. | Colon punchline. |
| locales/en.json → pair.setup.smart.cmp_note (en) | Smart price adaption is NIBE's own: it runs in your heat pump… | Smart price adaption is NIBE's own. It runs in your heat pump and gets prices through myUplink. | Colon delivery. |
| locales/en.json → pair.setup.smart.indoor_homey_desc (en) | …Autopilot regulates on them, your heat pump doesn't. | One sensor, or the average of several rooms. Autopilot steers the heating by them. | Contrast pair. |

## R2. Expensive, never dear


### help/autopilot-hot-water.html

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/autopilot-hot-water.html (Always enough for a shower tile) | …the odd charge at a pricier hour. | …some charges happen in more expensive hours. | Same phrase; fix both together. |
| help/autopilot-hot-water.html:76 | the odd charge at a pricier hour | some charges happen in more expensive hours | "Pricey" family is banned. |

### locales/en.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| locales/en.json → pair.setup.smart.hw_reserve_hint (en) | A bigger cushion means the odd charge at a pricier hour. | With more water kept warm, some charges happen in more expensive hours. | "pricier" is a "pricey" variant. |

## R3. Your heat pump


### .homeychangelog.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| .homeychangelog.json → 1.4.10, 1.5.0 (en, lesson) | Pumps with more than one zone… / the pump's address | Heat pumps with more than one zone… / your heat pump's address | Uploaded; apply from the next entry on. |
| .homeychangelog.json → 1.5.0.en | On pumps with more than one zone … at the pump's address | On heat pumps with more than one zone … at your heat pump's address | Lesson: changelog says "your heat pump". |
| .homeychangelog.json → 1.4.10.en | Pumps with more than one zone … If your pump has several zones | Heat pumps with more than one zone … If your heat pump has several zones | Lesson: changelog says "your heat pump". |

### docs/FAQ.md

| Where | Current | Proposed | Why |
|---|---|---|---|
| docs/FAQ.md (79 lines) | "the pump" / "pump", e.g. :33 Yes, with a pump and firmware supporting external BT50. | Yes, if your heat pump's software supports an external room sensor (BT50). | Owner FAQ never says "your heat pump". |

### drivers/nibe_s/registers.ts

| Where | Current | Proposed | Why |
|---|---|---|---|
| drivers/nibe_s/registers.ts:130, 149, 151, 154, 175, 192, 260, 262, 395, 596, 598, 604, 660, 664, 685 (15×) | Supply temperature the pump is aiming for… / What the pump is producing right now… | Supply temperature your heat pump is aiming for… / What your heat pump is producing right now… | Flow hints say "your heat pump" (15×); pairing infos say "the pump". |

### help/getting-started.html

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/getting-started.html:24–25 | First, at the heat pump. … so the heat pump has to allow it. | On your heat pump … so your heat pump has to allow it. | The machine is "your heat pump". |

### lib/device.ts

| Where | Current | Proposed | Why |
|---|---|---|---|
| lib/device.ts:175, 181, 1255 | Another Heating device already supplies this pump. | Another Heating device already sends temperatures to this heat pump. | "pump" for the machine. |
| lib/device.ts:185 | Enable external BT50 on the heat pump before verifying. | Turn on external BT50 on your heat pump first. | "your heat pump". |
| lib/device.ts:211 | …and disable external BT50 on the heat pump. | …and turn off external BT50 on your heat pump. | "your heat pump". |
| lib/device.ts:518, 1685, 1904 + lib/connection.ts:264, 1580 | Not connected to the heat pump | Not connected to your heat pump | Locale pair.not_connected already says this; reuse it. |
| lib/device.ts:557 | The pump did not confirm the requested value | Your heat pump didn't confirm the new value. | "pump". |
| lib/device.ts:2988 | …before changing the pump address. | …before changing your heat pump's address. | "pump". |

### lib/driver.ts

| Where | Current | Proposed | Why |
|---|---|---|---|
| lib/driver.ts:729 | Electricity used while the pump is idle, since the device was added | Electricity your heat pump used while idle, since this device was added | "the pump". |
| lib/driver.ts:736 | Power the pump is drawing right now while idle | Power your heat pump draws right now while idle | "the pump". |
| lib/driver.ts:739 | Power the pump is drawing right now, when this function is the active one | Power your heat pump draws right now for this function | "the pump"; shorter. |

### lib/release-announcements.ts

| Where | Current | Proposed | Why |
|---|---|---|---|
| lib/release-announcements.ts:26 (en) | …and on pumps with several zones you choose which zone it sets. | …and on heat pumps with several zones you choose which zone it sets. | "pumps". |

## R4. Autopilot, Live and Simulated


### .homeycompose/locales/en.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| .homeycompose/locales/en.json → autopilot.hotwater_daily.shadow, autopilot.hotwater_update.shadow (en) | Simulation: your heat pump stays as it is. | Simulated. Your heat pump stays as it is. | Mode is "Simulated"; colon delivery. |
| .homeycompose/locales/en.json → autopilot.hotwater_charge.title_would (en) | Simulation: would start a charge · __reason__ | Would start a charge · __reason__ · Simulated | Old mode name; decision first. |
| .homeycompose/locales/en.json → autopilot.heating.status.test, autopilot.hotwater_status.test (en) | Simulation: __text__ | Simulated · __text__ | Old mode name. |
| .homeycompose/locales/en.json → autopilot.widget.test (en) | Simulation | Simulated | Old mode name on the widget badge. |

### drivers/nibe_s/driver.flow.compose.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| drivers/nibe_s/driver.flow.compose.json:554 (hotwater_charge_started hint) | Works with Autopilot on, or in Simulation. | Works with Autopilot · Live and Autopilot · Simulated. | "Simulation" is the old mode name. |

### help/index.html

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/index.html:42 | Smart. (tile title for Autopilot) | Autopilot | Autopilot tile titled "Smart" next to a Smart mode topic. |

### locales/en.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| locales/en.json → pair.setup.smart.start_test (en) | Start simulation | Start Autopilot · Simulated | Old mode name. |
| locales/en.json → pair.setup.smart.saved_test (en) | Simulation started | Autopilot · Simulated is on | Old mode name. |
| locales/en.json → pair.setup.changes.autopilot_simulated (en) | Autopilot, simulated: it plans and shows, your heat pump stays as it is | Autopilot · Simulated. It plans and shows, and your heat pump stays as it is. | Smart mode spells it "Autopilot · Simulated"; colon. |

## R6. Length


### .homeychangelog.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| .homeychangelog.json → 1.4.10.en | the app also logs zone temperatures once after each start, to help add a temperature per zone. | (drop) | Lesson: developer detail in a store entry. |

### docs/FAQ.md

| Where | Current | Proposed | Why |
|---|---|---|---|
| docs/FAQ.md:185–195 | How does the app work out… (3 paragraphs) | Keep the first two sentences, link energy-attribution.md for the rest. | Owner answer carries the mechanism. |
| docs/FAQ.md:197–211 | My heating device shows energy produced but 0 kWh used… (1028, degree minutes, second register) | Fixed in 0.9.14. Update the app. Details are in energy-attribution.md. | Register numbers and degree minutes in an owner answer. |
| docs/FAQ.md:213–236 | Why not use the pump's own per-function energy figures instead? (4 blocks) | Two sentences, rest to docs/energy-attribution.md. | Essay in an owner FAQ. |
| docs/FAQ.md:285–308, 333–366 | How does the app know how much hot water I have left? / My boost stops well short… / cancelling More hot water (3–4 paragraphs each) | Match the help page answers (hot-water.html), move measurements to docs. | Help page already says it in two lines. |

### drivers/nibe_s/driver.compose.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| drivers/nibe_s/driver.compose.json:1579 (analyticsConsent hint) | Off by default. Sends your heat pump's model, which devices you paired, which Flow cards ran, alarm codes, and how Autopilot is set up and how each day went. Never readings, IP, serial or names. | Sends your heat pump model, paired devices, Flow cards used, alarm codes and how Autopilot runs. Never readings, IP, serial or names. | Three sentences and a long list for a hint; the toggle shows it's off. |

### locales/en.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| locales/en.json → pair.setup.pending_hint (en) | Add your devices first, then open Heating → Repair to finish the setup. Leave your current NIBE sensor in control until then. No temperatures are sent during pairing. | Add your devices first, then finish this in Heating → Repair. Keep your current NIBE sensor in control until then. | Hint is three sentences. |

## R7. Native language and heat-pump terms


### lib/connection.ts

| Where | Current | Proposed | Why |
|---|---|---|---|
| lib/connection.ts:134-185, 264, 1580 + lib/indoor-sensors.ts:15-44 | Modbus exception summaries, "Not connected to the heat pump", sensor-choice errors | Locale keys, all six languages | Reach Flow errors, Repair and timeline untranslated. |

### lib/device.ts

| Where | Current | Proposed | Why |
|---|---|---|---|
| lib/device.ts:148-329, 510-564, 1091, 1255, 1262, 2988 | Hardcoded English throws and setWarning texts (BT50 feed, read-only, "Finish your Homey sensor setup…") | Move to `.homeycompose/locales` keys in all six languages | Shown in English to every non-English owner. |

### lib/driver.ts

| Where | Current | Proposed | Why |
|---|---|---|---|
| lib/driver.ts:657-659, 689-695, 729-739 | `{en, sv}` only descriptions and COP titles | Add de, nl, no, da | nl/de/no/da owners get English. |

### lib/roles.ts

| Where | Current | Proposed | Why |
|---|---|---|---|
| lib/roles.ts:503-523, 563-571 | `{en, sv}` only device names, energy/power and COP titles | Add de, nl, no, da | Default device names are English for Dutch owners. |

## R8. One term per concept


### .homeycompose/capabilities/measure_hour_NIBE.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| .homeycompose/capabilities/measure_hour_NIBE.json, measure_minute_NIBE.json → units (en) | Hours, Minutes | h, min | App writes durations as "h" and "min" everywhere else. |

### .homeycompose/locales/en.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| .homeycompose/locales/en.json → autopilot.hotwater_use.away_keeps; autopilot.hotwater_daily.tank; help/autopilot-hot-water.html | your minimum, at least __reserve__ L, cushion | safety net | safety net 10 / minimum 3 / cushion 2 for one setting. |
| .homeycompose/locales/en.json → groups.solar (en) | Solar / PV | Solar | Device is "Nibe Solar"; only slash group name. |

### assets/pair/tank.js

| Where | Current | Proposed | Why |
|---|---|---|---|
| assets/pair/tank.js:41, 77 | `tank.litres + ' l'` / unit `l` | `' L'` / `L` | Flow cards, setup.js:808 and help use "L". |

### docs/FAQ.md

| Where | Current | Proposed | Why |
|---|---|---|---|
| docs/FAQ.md:156, 160, 173 | MyUplink | myUplink | myUplink 26× vs MyUplink 3×. |
| docs/FAQ.md:33, 52, 55, 104, 111, 126, 130, 296, 318 | Heating Setup / Hot Water Setup / Smart Price Adaption / Hot Water device | Heating setup / Hot water setup / Smart price adaption / Hot water device | On-screen names are sentence case; help uses them so. Also firmware (6×) vs software (help 5×): use "software". |

### drivers/nibe_s/driver.compose.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| drivers/nibe_s/driver.compose.json → capabilitiesOptions.measure_temperature.i1_outside.title (en); nibe_f h40004 | Outside temperature (BT1) | Outdoor temperature (BT1) | outdoor 59 / outside 2. |
| drivers/nibe_s/driver.compose.json → h30_heat_curve_displacement title; curve_displacement_NIBE type | Heat curve displacement | Heat curve offset | displacement 11 / offset 4; registers.ts info already says offset. |
| drivers/nibe_s/driver.compose.json → h202_use_room_sensor title; registers.ts:500; widget.paused.room_control; lib/device.ts:525-527 | Room sensor regulation, Room control, room temperature control, Room regulation | Room-sensor control | room-sensor control 8 / regulation 2 / room control 1 / others 2. |
| drivers/nibe_s/driver.compose.json → fan_speed.h109_returnair_normal title vs flow hint; i1037 title vs hint | Extract air fan speed / exhaust air fan | One name for this fan, matching NIBE's manual | Same fan called two names, title vs hint. |
| drivers/nibe_s/driver.compose.json → h697_more_hotwater / h697_onetimeincrease_hotwater titles | More hot water / One-time increase | More hot water / More hot water for | Same setting, two names on one device. |
| drivers/nibe_s/driver.compose.json:248, 528 vs flow:452, 1415, 2086 and registers.ts:214, 565 | Extract air fan (2×) vs exhaust air fan (5×) | extract air fan | Hints should name the fan the way its tile does. |
| drivers/nibe_s/driver.compose.json:569 + driver.flow.compose.json:1882, 1890 vs compose h697 "More hot water" and flow:2008 | One-time increase / Set one-time increase [[mode]] | More hot water / Set More hot water to [[mode]] | Same register 697 under two names; owner sees two features. |
| drivers/nibe_s/driver.compose.json:647 | Outside temperature (BT1) | Outdoor temperature (BT1) | "outdoor" 21× vs "outside" 1×. |
| drivers/nibe_s/driver.compose.json:945, 1096 vs flow:895, 1357 | Period time heating / Period time pool | Heating period time / Pool period time | Flow cards already say "heating period time"; tile reads non-native. |

### drivers/nibe_s/driver.flow.compose.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| drivers/nibe_s/driver.flow.compose.json → triggers.hotwater_charge_started.hint (en) + R4 keys | in Simulation | in Simulated | Simulation 9 / Simulated 12. |
| drivers/nibe_s/driver.flow.compose.json:410 and registers.ts:526 vs registers.ts:26 and flow:1562, 3491 | Fires when the operating mode changes: auto, manual or additional heat only. | Fires when the operating mode changes between Auto, Manual and Immersion heater only. | The mode's own label is "Immersion heater only"; also drops colon. |
| drivers/nibe_s/driver.flow.compose.json:502 | Needs a tank picked in Repair. | Needs a tank, set in Hot water setup. | Name the actual screen, as the help page does. |
| drivers/nibe_s/driver.flow.compose.json:1940, 1982, 2148 and registers.ts:568, 587, 589 | periodic hot water boost (6×) | periodic hot water charge | "Boost" also means More hot water; flow:1247 already says "charge". |
| drivers/nibe_s/driver.flow.compose.json:3025 | Set outdoor temperature (BT1): [[value]] °C | Set outdoor temperature (BT1) to [[value]] °C | Every other set card uses "to [[value]]"; no colon. |
| drivers/nibe_s/driver.flow.compose.json:3094 | Working day | Workday | Help page and Autopilot copy say "Workday". |
| drivers/nibe_s/driver.flow.compose.json:3441 | [[register]] is !{{enabled\|disabled}} | [[register]] is !{{on\|off}} | Card title says "is on". |

### drivers/nibe_s/registers.ts

| Where | Current | Proposed | Why |
|---|---|---|---|
| drivers/nibe_s/registers.ts:223-271, 526, 602-609, 685; reason.ts:399-408; flow hint operating_mode changed | additional heat, additive heater, electric addition | immersion heater | immersion heater 36 / additive 7 / additional heat 5 / electric addition 4. |
| drivers/nibe_s/registers.ts:416, 450, 487, 493 | Smart Price Adaption | Smart price adaption | sentence case 49 / title case 4. |
| drivers/nibe_s/registers.ts (13 infos), reason.ts:170-421, lib/driver.ts:729-739 | the pump, The pump | your heat pump | your heat pump 224 / the pump 25 / the heat pump 6. |
| drivers/nibe_s/registers.ts:223, 238, 241, 243, 269, 271, 602, 609, 685 | electric additional heat / additive heater / electric additive / additional heat (11×) | immersion heater | Tiles and Flow cards say "immersion heater" (23×). |
| drivers/nibe_s/registers.ts:416, 450, 487, 493 and 579 | Smart Price Adaption (4×) · heat curve offset (1×) | Smart price adaption · heat curve displacement | On-screen names are "Smart price adaption" (19×) and "Heat curve displacement" (8×). |

### help/autopilot-hot-water.html

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/autopilot-hot-water.html, help/flows.html | Workday, workdays | Working day, working days | Day type says "Working day" (5) vs workday (3). |
| help/autopilot-hot-water.html:61, help/flows.html:74 | Holiday or working from home? … / Holidays and days working from home | A day off or working from home? … / Days off and days working from home | "Holiday" means Away (6 uses); here it means Day off. |
| help/autopilot-hot-water.html:61–63, help/flows.html:59 | workdays (3), Workday (1) | working days / Working day | App's day type is "Working day" (flows.html:79). |

### help/heating.html

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/heating.html:63 | so it stays out of mild days (the electric heater) | the immersion heater | immersion heater 7×, electric heater 1×, additional heat 3×. Keep "immersion heater". |

### help/hot-water.html

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/hot-water.html:84 | Your heat pump's schedules can block additional heat. | Your heat pump's schedules can block the immersion heater ("Block additional heat"). | Same term; menu name kept in quotes for the display. |

### help/smart-mode.html

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/smart-mode.html:33 | NIBE's own price feature | Nibe's own price feature | Nibe 91× vs NIBE 2× in help prose. |
| help/smart-mode.html:109 | Previous: Energy | Previous: Energy and COP | Page is "Energy and COP" in index and hot-water.html:118. |

### lib/device.ts

| Where | Current | Proposed | Why |
|---|---|---|---|
| lib/device.ts:527; nibe_f curve titles; curve_mode/curve_displacement type titles | heating curve, Heating curve, Heatcurve | heat curve | heat curve 27 / heating curve 6 / Heatcurve 2. |

### lib/roles.ts

| Where | Current | Proposed | Why |
|---|---|---|---|
| lib/roles.ts:505; help/getting-started.html | Nibe Hot Water | Nibe Hot water | Only title-case device name; others sentence case. |

### Across files

| Where | Current | Proposed | Why |
|---|---|---|---|
| repo-wide owner text (excl. app and device names) | Nibe heat pumps, Nibe's permit, NIBE data, NIBE sensor | NIBE for the maker and its parts | NIBE 24 / Nibe 29 mixed for the brand. |

## R9. Should be a better UI or visual


### .homeycompose/locales/en.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| .homeycompose/locales/en.json → autopilot.hotwater_charge.write_failed (en) | Autopilot couldn't start a charge. Your heat pump said: __error__ | Map the error to a plain cause, e.g. "Your heat pump didn't accept the new temperature." | __error__ is `Could not set "…": Modbus exception 3: …`. |

### drivers/nibe_s/registers.ts

| Where | Current | Proposed | Why |
|---|---|---|---|
| drivers/nibe_s/registers.ts:127 (wireless room sensor info) | The temperature at one wireless room sensor. NIBE's slot order follows neither the zones nor menu 5.4, so match it by its reading | The temperature at one wireless room sensor. Match it by its reading. | The live reading beside each option already does the explaining. |
| drivers/nibe_s/registers.ts:685 (h180 info) | Nibe's permit for additional heat, which they label as heating-only. Note the pump's own schedule modes carry a separate, global "block additional heat"… | Lets the immersion heater help with heating. | The schedule caveat belongs on the Heating help page. |

### help/autopilot-heating.html

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/autopilot-heating.html:60 | Your heat pump decides how hard to heat from the outdoor temperature it sees. Autopilot sends it a slightly different one… | Flow chips with numbers: "Outside 4 °C › Sent 2 °C › Heats more", second row "› Sent 6 °C › Heats less". | Paragraph explains what the chips should show. |
| help/autopilot-heating.html:70–75 | The comfort range says how far indoors may drift from it… (with tank glasses for ±°C) | A small band chart: thermostat line with ±0.5, ±3 and ±6 °C bands. | Tank glasses are the hot water metaphor; °C range needs a band. |

### help/energy.html

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/energy.html:37 | Every few seconds, Nibe Live reads how much power… books that energy… Since each moment goes to exactly one device… | A day strip coloured by what's running, summing into the existing bar. | Four sentences describe a picture. |
| help/energy.html:69 | Every COP is worked out over a rolling 30-day window. A lifetime average stops moving… | Two smooth curves: lifetime COP flat, 30-day COP dipping in a cold snap. | The claim is visual. |
| help/energy.html:78 | Both halves of Total COP come straight from your heat pump's own counters. A job's COP divides… | Two fractions: "Measured ÷ measured" for Total COP, "Measured ÷ shared out" for a job's. | Formula explained in prose. |

### help/getting-started.html

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/getting-started.html:68 | Before the devices are created, Device setup asks… In Hot water setup… In Heating setup… What gets added… | Crumbs: Device setup › Hot water setup › Heating setup › What gets added, one line under each. | Five-sentence walk-through of a sequence. |

### help/heating.html

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/heating.html:101 | If your heat pump has more than one zone, Heating setup first asks… menu 1.3.3… wireless room sensors… | A mock of the zone picker list, each sensor with its reading. | Long tile text describing a screen. |

### help/hot-water.html

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/hot-water.html:40 | Your tank is always full of water. What changes is how hot it is. Hot water comes out the top… | Tank glass with a hot layer on top and cold below, the line sinking as you shower. | Stratification described in words beside fill-level glasses. |
| help/hot-water.html:75 | A boost doesn't use your everyday stop temperature. It moves your heat pump up to Large… | Bar of Small, Medium, Large stop temperatures with the boost marker on Large. | Paragraph explains a comparison. |
| help/hot-water.html:81 | The compressor on its own tops out around 55–60 °C… the immersion heater has to help… | Temperature column: compressor up to 55–60 °C, immersion heater above it to the Large stop. | Two zones on one scale, told in prose. |

### help/troubleshooting.html

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/troubleshooting.html:26 | Nothing answered at your heat pump's address… keeps retrying, and after three minutes it searches… (two paragraphs) | Step strip: Retrying › After 3 min › Searching › Moved, plus one tip line. | Longest answer on the page describes a sequence. |

### lib/device.ts

| Where | Current | Proposed | Why |
|---|---|---|---|
| lib/device.ts:1091 | …could not be applied: measure_temperature.i1_outside, … | List failed readings by their titles in Repair | Owners can't act on capability IDs. |

### locales/en.json

| Where | Current | Proposed | Why |
|---|---|---|---|
| locales/en.json → pair.setup.smart.indoor_bt50_note (en) | Your Homey sensors keep going to your heat pump as BT50, so it reports no sensor fault. With room-sensor control off, it only shows them. Autopilot does the regulating. | Show a status row "BT50 · sent to your heat pump · display only" | Three sentences explain a mechanism a row can show. |

## R10. The AI voice

This rule was added after the first pass, on 2026-11-15. The other reviewers worked from `CLAUDE.md`,
which asks for "a short two-part headline with full stops", so they left these headings alone. The
maintainer has since ruled that this style reads as AI-written. Every heading below is affected. The
proposed headings name the topic in normal words and drop the trailing full stop.

Once these are fixed, change the `CLAUDE.md` rule ("a centred hero with an eyebrow and a short two-part
headline with full stops") to "a heading that names the topic". If it stays as written, the next page
will come out in the same voice.

### Page and section headings

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/index.html:32, getting-started.html:16 | Your heat pump. In Homey. | Nibe Live help | Two-fragment slogan |
| help/getting-started.html:24 | First, at the heat pump. | On your heat pump | Fragment |
| help/getting-started.html:37 | Homey does the looking. | Adding your heat pump in Homey | Personifies Homey |
| help/getting-started.html:49 | Choose what you want to see. | Choosing features | Fine as a sentence, but long for a heading |
| help/getting-started.html:67 | A little setup, then done. | Device setup | Reassurance, and it names the real screen |
| help/getting-started.html:76 | Give it a few days. | When the numbers appear | Says what the section covers |
| help/devices.html:16 | One heat pump. Several devices. | Devices | Two-fragment slogan |
| help/devices.html:24 | A tile for every job. | The six devices | Slogan |
| help/devices.html:65 | Each one counts for itself. | Energy and COP on each device | Vague |
| help/devices.html:77 | Automate one job. Leave the rest. | Flows for one device | Slogan |
| help/devices.html:91 | On means on. | Turning a device off | Cute. The body also says "a real control" |
| help/devices.html:100 | Change your mind anytime. | Adding or removing devices later | Reassurance |
| help/heating.html:21 | Warm rooms. Your rules. | Heating | Slogan |
| help/heating.html:46 | A real thermostat. | The thermostat | "real" is filler |
| help/heating.html:58 | Summer, sorted. | Heating in summer | Idiom |
| help/heating.html:66 | Measured over time. | Average outdoor temperature | Fragment |
| help/heating.html:75 | Let your rooms guide it. | Room sensors | Personifies |
| help/heating.html:88 | Your heat pump, still in charge. | What your heat pump still decides | Reassurance |
| help/heating.html:91 | Same thermostat. Same settings. | (cut, or "The thermostat stays the same") | Two fragments |
| help/heating.html:95 | Every 30 seconds. | How often the temperature is sent | Number hook |
| help/heating.html:100 | Two zones? You choose. | Heat pumps with two zones | Question hook |
| help/hot-water.html:16 | Hot water. In litres. | Hot water | Two fragments |
| help/hot-water.html:23 | One tile. Everything hot water. | The Hot water device | Two fragments |
| help/hot-water.html:34 | Litres you can shower in. | Litres of hot water | Cute |
| help/hot-water.html:39 | Not how full. How much shower. | What the litres mean | Contrast pair |
| help/hot-water.html:60 | Incoming water, learned. | Cold water temperature | Fragment |
| help/hot-water.html:69 | Need more? Ask for it. | More hot water | Question hook. Also the setting's name |
| help/hot-water.html:74 | Hotter than you set. | How hot a boost gets | Teaser |
| help/hot-water.html:80 | Or short of the mark. | When a boost stops early | Teaser |
| help/hot-water.html:93 | Cancel stops the ask. Not the run. | Cancelling a boost | Contrast pair |
| help/energy.html:24 | Every kWh. In its place. | Energy | Slogan |
| help/energy.html:31 | One meter. Shared out. | How energy is shared between devices | Two fragments |
| help/energy.html:36 | Whatever's running gets the bill. | Energy goes to what's running | Idiom |
| help/energy.html:45 | Add every job you have. | Devices you didn't add | Instruction posing as a heading |
| help/energy.html:49 | Heat out, measured. | Energy delivered | Fragment. Names the real capability |
| help/energy.html:58 | COP, in plain words. | What COP means | Announces its own plainness |
| help/energy.html:77 | Trust Total COP most. | Which COP to use | Imperative hook |
| help/energy.html:86 | Close to myUplink. Not identical. | Compared with myUplink | Contrast pair |
| help/smart-mode.html:16 | Pick who plans. | Smart mode | Names the screen |
| help/smart-mode.html:23 | Three choices. Side by side. | The three options | Number hook |
| help/smart-mode.html:58 | Different strengths. | Which to pick | Vague |
| help/smart-mode.html:61–63 | Learns your home. / Works from day one. / Nothing moves. | Learns from your home / Works straight away / Changes nothing | "Nothing moves" is a reassurance fragment |
| help/smart-mode.html:83 | Three taps away. | Where to find it | Number hook |
| help/autopilot-heating.html:16 | Warm home. Smarter hours. | Autopilot for heating | Slogan, and "smarter" |
| help/autopilot-heating.html:42 | Your house is a battery. | How Autopilot shifts heating | Metaphor as heading |
| help/autopilot-heating.html:45–47 | It looks ahead. / It stores a little warmth. / It coasts through the peak. | Checks prices ahead / Heats a little extra before / Heats less when it's expensive | Rhythmic triad |
| help/autopilot-heating.html:54 | It speaks your heat pump's language. | How it changes your heat pump | Personifies |
| help/autopilot-heating.html:59 | A nudge on the thermometer. | It adjusts the outdoor temperature (BT1) | Metaphor hides the mechanism |
| help/autopilot-heating.html:64 | That's why setup asks. | External outdoor sensor | Points back instead of naming |
| help/autopilot-heating.html:69 | How far it may go. | Comfort range | Names the setting |
| help/autopilot-heating.html:86 | It needs to feel the room. | Room temperature | Personifies |
| help/autopilot-heating.html:100 | Always says what it's doing. | Status and reasons | Personifies |
| help/autopilot-heating.html:115 | Watch first. Then hand over. | Try it in Simulated first | Two fragments |
| help/autopilot-hot-water.html:16 | Hot water. When it's cheap. | Autopilot for hot water | Two fragments |
| help/autopilot-hot-water.html:44 | Three things. Every fifteen minutes. | How a charge is planned | Number hook |
| help/autopilot-hot-water.html:46–48 | It watches prices. / It knows your routine. / It picks the moment. | Prices / Your usage / The charge | Rhythmic triad |
| help/autopilot-hot-water.html:55 | Made for how you actually live. | Settings | "actually" |
| help/autopilot-hot-water.html:60 | Weekends, handled. | Workdays and days off | Idiom |
| help/autopilot-hot-water.html:69 | Twice the heating. | (keep the 2× tile, drop the heading) | The number does the job |
| help/autopilot-hot-water.html:86 | Sun in. Hot water out. | Solar | Two fragments |
| help/autopilot-hot-water.html:91 | Two switches. That's it. | Solar settings | Closer |
| help/autopilot-hot-water.html:104 | Always knows why. | Reasons | Personifies |
| help/autopilot-hot-water.html:119 | Try it first. Nothing changes. | Try it in Simulated first | Reassurance |
| help/flows.html:31 | Your home. Your rules. | Flows | Slogan |
| help/flows.html:38 | Cards that say what they do. | One card per setting | Merge with :43 |
| help/flows.html:58 | Tell it about your day. | Day type | Names the setting |
| help/flows.html:68 | Three to start with. | Example Flows | Number hook |
| help/flows.html:110 | Plan around it. | Checking Autopilot's plan in a Flow | Vague |
| help/troubleshooting.html:16, index.html:68 | Something looks wrong? | Troubleshooting | Question hook |
| help/*.html (all h3 labels) | Main. / Update first. / Pair again. | Main / Update first / Pair again | Labels don't take full stops |

### Body copy in the same voice

Changing the headings alone won't fix it. The paragraphs under them use the same habits, and each
help page needs a full plain rewrite. Examples:

| Where | Current | Proposed | Why |
|---|---|---|---|
| help/energy.html:45 | Nothing goes missing. It's counted on Main instead of on its own. | It's counted on Main. | Reassurance, then a repeat |
| help/energy.html:77 | Close, but Total COP is the one to quote. | Use Total COP when you compare. | Verdict tone |
| help/heating.html:58 | …when your heat pump bothers to heat at all. | …when your heat pump heats. | "bothers" is cute |
| help/heating.html:66 | So a warm afternoon doesn't switch heating off on its own. | A warm afternoon doesn't turn heating off. | "So" lead-in |
| help/devices.html:91 | The on/off on Heating … is a real control. | The on/off switch on Heating … turns heating on your heat pump on and off. | "real" |
| help/autopilot-hot-water.html:16 | No schedules. Nothing to tune. | (cut) | "No X. Nothing Y." |
| help/autopilot-hot-water.html:48 | Your heat pump does the heating, same as always. | Your heat pump does the heating. | Reassurance |
| help/autopilot-hot-water.html:76 | A bigger cushion means the odd charge at a pricier hour. | With more water kept warm, some charges happen in more expensive hours. | "the odd", "pricier" |
| .homeycompose/locales/en.json:295 → autopilot heating status `holding` | Holding. Nothing to gain from shifting now | Holding. No change planned | Says what happens. `holding_even` already covers flat prices. |


# Appendix: translations (parked)

These findings were collected in the same pass. They're set aside until the English is right, because
most translation fixes should wait for the English wording to settle. There are 406 findings across
the five languages. A few of them are factual or code fixes that are worth doing whatever happens to
the English:

- `roleNames` in `lib/roles.ts:502` only has `en` and `sv`. Dutch, German, Norwegian and Danish owners
  get tiles called "Nibe Heating" while their copy names devices that don't exist.
- The German 1.5.0 announcement uses "du/deinem" (`lib/release-announcements.ts:28`). Three pairing
  strings use du as well.
- The Swedish "turned off" trigger says "Registervärde stängs på", which means "turned on"
  (`driver.flow.compose.json:298`).
- Eight Flow action hints exist only in English and Swedish.
- Smart price adaption and Smart control are spelled up to four ways per language. They should match
  whatever the heat pump's display shows, and someone needs to check a display.

| Rule | sv | nl | de | no | da |
|---|---|---|---|---|---|
| R0 Errors | 17 | 12 | 19 | 22 | 14 |
| R1 Plain voice | 19 | 16 | 17 | 9 | 10 |
| R3 Your heat pump | 1 | 1 | 0 | 0 | 2 |
| R4 Autopilot, Live, Simulated | 6 | 9 | 9 | 1 | 4 |
| R5 Formality | 0 | 0 | 4 | 0 | 0 |
| R6 Length | 2 | 3 | 4 | 3 | 1 |
| R7 Native language | 20 | 22 | 15 | 11 | 27 |
| R8 One term per concept | 23 | 20 | 16 | 17 | 17 |
| R9 Should be UI or visual | 3 | 2 | 4 | 2 | 2 |
| Total | 91 | 85 | 88 | 65 | 77 |

The proposed translations were written before R10. Check them against [voice.md](voice.md) before
using them.

### R0. Errors


#### .homeychangelog.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | .homeychangelog.json → 1.4.10, 1.4.11, 1.5.0 (da), lesson | …under Varme → Reparer / enheden Varme | Name the real device ("Nibe Opvarmning") once roleNames has da | Changelog points to a device name owners never see. |
| nl | .homeychangelog.json → 1.5.0 (nl), lesson | …stopt het koppelen en melden de apparaten dat, in plaats van overal -1 te tonen. | …stopt het koppelen en melden de apparaten dat. | "In plaats van" contrast; lesson only, entry is uploaded. |

#### .homeycompose/app.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| no | .homeycompose/app.json → name (no) | missing | Nibe Live | Key present in en, missing in no (brand, low impact). |
| sv | `.homeycompose/app.json → name` (sv) | (missing) | Nibe Live | Key present in en only. Brand name, add for parity. |

#### .homeycompose/capabilities/hotwater_demand_NIBE.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| sv | `.homeycompose/capabilities/hotwater_demand_NIBE.json → values.4.title` (sv) | 4 = Smart kontrol | 4 = Smart control | Typo. NIBE's own name for the mode on the display. |

#### .homeycompose/locales/da.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | .homeycompose/locales/da.json → autopilot.savings.band_dear (da) | Dyrt | Dyr | Must agree with "Billig" beside it. |

#### .homeycompose/locales/de.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| de | .homeycompose/locales/de.json → pair.discover.searching, pair.discover.pump (de) | NIBE Wärmepumpen / NIBE Wärmepumpe | NIBE-Wärmepumpen / NIBE-Wärmepumpe | German compound needs the hyphen. |
| de | .homeycompose/locales/de.json → autopilot.hotwater_update.moved_repriced (de) | …daher lädt sie auf __target__ °C… | …daher lädt Autopilot auf __target__ °C zu __price__/kWh. | "sie" has no referent. |
| de | .homeycompose/locales/de.json → autopilot.widget.hotwater.share (de) | __share__ % aus Solar | __share__ % aus Solarstrom | Matches hotwater_daily.reason.surplus wording. |

#### .homeycompose/locales/nl.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| nl | .homeycompose/locales/nl.json → autopilot.hotwater_setting.no_device / no_tank (nl) | Warm water-apparaat | het apparaat Warm water | Wrong compound spelling. |
| nl | .homeycompose/locales/nl.json → pair.discover.searching / pair.discover.pump (nl) | NIBE warmtepompen / NIBE warmtepomp | NIBE-warmtepompen / NIBE-warmtepomp | Missing hyphen (elsewhere "NIBE-sensor"). |
| nl | .homeycompose/locales/nl.json → autopilot.hotwater_use.learning (nl) | Leert je warmwatergebruik | Leert je warmwatergebruik kennen | Missing "kennen"; hotwater_status.learning has it. |

#### .homeycompose/locales/no.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| no | .homeycompose/locales/no.json → autopilot.hotwater_update.title.new_prices + .revised (no) | Nye priser er kommet. Varmtvannsplanen oppdatert. | Nye priser er kommet. Varmtvannsplanen er oppdatert. | Missing verb "er"; reads as a telegram. Same in .revised. |
| no | .homeycompose/locales/no.json → autopilot.hotwater_status.learning (no) | Lærer varmtvannsbruken deres | Blir kjent med varmtvannsbruken din | "deres" (plural you) clashes with "din" everywhere else. |
| no | .homeycompose/locales/no.json → pair.discover.searching, pair.discover.pump (no) | NIBE varmepumper … / NIBE varmepumpe | NIBE-varmepumper … / NIBE-varmepumpe | Split compound (særskriving); needs a hyphen. |

#### .homeycompose/locales/sv.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| sv | `.homeycompose/locales/sv.json → "4 = Smart control"` | 4 = Smart kontrol | 4 = Smart control | Same typo in the enum label layer. |
| sv | `.homeycompose/locales/sv.json → pair.discover.pump` | Nibe värmepump | Nibe-värmepump | Compound with a name needs the hyphen, as in "Nibe-värmepumpar". |

#### driver.compose.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | driver.compose.json → alarm_generic title; lib/roles.ts ALARM_ACTIVE da (da) | Alarm aktivt | Alarm aktiv | Gender: "alarm" is common gender. |
| da | driver.compose.json → settings pollInterval.units; .homeycompose/app.json → name | missing da ("s", "Nibe Live") | add da "s" / "Nibe Live" | Harmless fallback, but parity rule. |

#### driver.flow.compose.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | driver.flow.compose.json → actions.set_numeric_value.hint (da) | (»Indstil varmekurven til …«) | (»Indstil varmekurve …«) | Quotes a card title that doesn't exist (en too). |
| da | driver.flow.compose.json → 8 action hints (h697_more_hotwater, h227_nightchill, h65_periodic_hotwater, h691_pool_active, h180_enable_addition, h181/h182/h195 onoff) | missing da (only en, sv) | e.g. "Mere varmt vand: en engangsforøgelse på 2 timer" | Danish owners see English hints. |

#### drivers/nibe_s/driver.compose.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| nl | drivers/nibe_s/driver.compose.json → settings.pollInterval.units; .homeycompose/app.json → name | nl missing | add "s" / "Nibe Live" | Keys present in en, missing in nl (harmless fallbacks). |
| no | drivers/nibe_s/driver.compose.json → capabilitiesOptions.alarm_generic.title (no) | Alarm aktivt | Alarm aktiv | "alarm" is common gender, not neuter. |
| no | drivers/nibe_s/driver.compose.json → settings[5].children[pollInterval].units (no) | missing | s | Key present in en, missing in no. |
| sv | `drivers/nibe_s/driver.compose.json → settings.Advanced.pollInterval.units` (sv) | (missing) | s | Key present in en only. |
| sv | `drivers/nibe_s/driver.compose.json → capabilitiesOptions.target_temperature.h689_pool_stop.title` (sv) | Poolvärme stop | Poolvärme stopp | Spelling. "stop" is English. |
| sv | `drivers/nibe_s/driver.compose.json → capabilitiesOptions.hotwater_demand_NIBE.h56_hotwater_demand_mode.title` (sv) | Varmvatten behov | Varmvattenbehov | Split compound (särskrivning). |
| sv | `drivers/nibe_s/driver.compose.json → capabilitiesOptions.measure_enum_NIBE.i1037_return_fan_step.title` (sv) | Frånluft fläktläge | Fläktläge frånluft | Split compound reads as two words. |
| sv | `drivers/nibe_s/driver.compose.json → capabilitiesOptions.measure_watt_NIBE.i1048_compressor_add_power.title` (sv) | Kompressor tillförd W | Tillförd effekt kompressor | Unit used as a word, English is "power". |

#### drivers/nibe_s/driver.flow.compose.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| de | drivers/nibe_s/driver.flow.compose.json → triggers.hotwater_volume_dropped_below.hint (de) | …wenn die Schätzung Ihre Grenze nach unten überschreitet. Erfordert einen gewählten Speicher. | Wird einmal ausgelöst, wenn die Schätzung Ihre Grenze unterschreitet. Braucht einen Speicher, gewählt unter Reparieren. | "nach unten überschreiten" is self-contradictory; dropped "in Repair". |
| de | drivers/nibe_s/driver.flow.compose.json → conditions.hotwater_volume_below.hint (de) | Erfordert einen gewählten Speicher; sonst falsch. | Braucht einen Speicher, gewählt unter Reparieren. Ohne ihn ist die Bedingung falsch. | Dropped where to pick the tank. |
| de | drivers/nibe_s/driver.flow.compose.json → triggers.hotwater_charge_started.tokens.Detailed reason.example (de) | Auf 55 °C, 1 h 30 min, zu 0,84 €/kWh. | Auf 55 °C in etwa 1 Std. 30 Min., zu 0,84 €/kWh. | Runtime writes "Std./Min." (hotwater_charge.duration). |
| de | drivers/nibe_s/driver.flow.compose.json → conditions.autopilot_heating_status_is.title (de) | Autopilot Heizung … | Autopilot Heizung ist … | Verb missing from card title. |
| de | drivers/nibe_s/driver.flow.compose.json → 8 onoff action hints (de) | missing (English shown) | e.g. h195: Warmwasser zulassen. Aus sperrt das ganze Warmwasser, auch Mehr Warmwasser. | Missing translations. |
| de | drivers/nibe_s/driver.flow.compose.json → actions.target_temperature.h61_hotwater_stop_periodic.set.hint (de) | …Erfordert meist den Elektroheizstab. | …Erfordert meist die Zusatzheizung. | Third term for the immersion heater. |
| de | drivers/nibe_s/driver.flow.compose.json → actions.autopilot_heating_away.hint (de) | …und Warmwasser hält nur seine Reserve. | …und Warmwasser hält nur die Sicherheitsreserve. | "Sicherheitsreserve" is the term in every other string. |
| nl | drivers/nibe_s/driver.flow.compose.json → conditions[autopilot_heating_status_is] (nl) | Autopilot verwarming !{{is\|is niet}} [[status]] with values Leert / Houdt vast / Verwarmt voor | values: aan het leren / aan het wachten / aan het voorverwarmen / gepauzeerd | Renders "is Leert", "is Verwarmt voor": ungrammatical. |
| nl | drivers/nibe_s/driver.flow.compose.json → conditions[autopilot_heating_status_is].title (nl) | Autopilot verwarming … | Autopilot voor verwarming is … | Missing the verb. |
| nl | drivers/nibe_s/driver.flow.compose.json → actions[h697 more_hotwater, h227, h65, h691, h180, h181, h182, h195 .onoff].hint (nl) | (missing) | e.g. h195: "Uit zet alle warm water uit, ook Meer warm water." | 8 hints exist in English only. |
| no | drivers/nibe_s/driver.flow.compose.json → triggers[alarm_occurred].title (no) | Et alarm oppsto | En alarm oppsto | Wrong gender, "alarm" is en-word. |
| no | drivers/nibe_s/driver.flow.compose.json → triggers[hotwater_charge_started].tokens[1].example (no) | Til 55 °C, 1 t 30 min, til 0,84 NOK/kWh. | Til 55 °C, 1 t 30 min, for 0,84 kr/kWh. | Double "til"; the real string uses "for"; Norwegians write kr. |
| no | drivers/nibe_s/driver.flow.compose.json → triggers[hotwater_volume_dropped_below].hint (no) | … Krever valgt bereder. | … Krever at du velger bereder under Reparer. | Drops "in Repair", so the owner can't find where. |
| no | drivers/nibe_s/driver.flow.compose.json → actions[set_numeric_value].hint (no) | («Sett varmekurven til …») | («Still inn varmekurve») | Quotes a card title that doesn't exist in Norwegian. |
| no | drivers/nibe_s/driver.flow.compose.json → actions[boolean_NIBE.h697_more_hotwater.onoff].hint (no) | missing | Mer varmtvann i 2 timer, én gang. | Missing in no (en and sv only). |
| no | drivers/nibe_s/driver.flow.compose.json → actions[boolean_NIBE.h227_nightchill.onoff].hint (no) | missing | Nattkjøling med avtrekksviften. | Missing in no. |
| no | drivers/nibe_s/driver.flow.compose.json → actions[boolean_NIBE.h65_periodic_hotwater.onoff].hint (no) | missing | Slå på periodisk varmtvann. | Missing in no. |
| no | drivers/nibe_s/driver.flow.compose.json → actions[onoff.h691_pool_active.onoff].hint (no) | missing | Slå på bassengvarme. | Missing in no. |
| no | drivers/nibe_s/driver.flow.compose.json → actions[boolean_NIBE.h180_enable_addition.onoff].hint (no) | missing | Tillat elkolben for oppvarming. Varmtvann har sin egen bryter. | Missing in no. |
| no | drivers/nibe_s/driver.flow.compose.json → actions[onoff.h181_enable_heating.onoff].hint (no) | missing | Tillat varmedrift. | Missing in no. |
| no | drivers/nibe_s/driver.flow.compose.json → actions[onoff.h182_enable_cooling.onoff].hint (no) | missing | Tillat kjøledrift. | Missing in no. |
| no | drivers/nibe_s/driver.flow.compose.json → actions[onoff.h195_enable_hotwater.onoff].hint (no) | missing | Tillat varmtvann. Av stopper alt varmtvann, også Mer varmtvann. | Missing in no. |
| no | drivers/nibe_s/driver.flow.compose.json → conditions[autopilot_heating_status_is].title (no) | Autopilot oppvarming … | Autopilot for oppvarming er … | Verb "er" dropped; en says "is …". |
| sv | `drivers/nibe_s/driver.flow.compose.json → triggers.capability_turned_off.title` (sv) | Registervärde stängs på | Registervärde stängs av | Says "turned on". Contradicts the English and titleFormatted. |
| sv | `drivers/nibe_s/driver.flow.compose.json → actions/conditions h56_hotwater_demand_mode.enum.title, titleFormatted` (sv, 4 strings) | Ställ in varmvatten behov … / Varmvatten behov är … | Ställ in varmvattenbehov … / Varmvattenbehov är … | Split compound. |
| sv | `drivers/nibe_s/driver.flow.compose.json → conditions.autopilot_heating_status_is.title` (sv) | Autopilot uppvärmning … | Autopilot för uppvärmning är … | Verb missing. English has "is". |
| sv | `drivers/nibe_s/driver.flow.compose.json → actions.onoff.h195_enable_hotwater.onoff.hint` (sv), also `drivers/nibe_s/registers.ts:706` | …även engångshöjningen | Tillåt varmvatten. Av stänger av allt varmvatten, även Mer varmvatten. | English names the More hot water switch. |

#### drivers/nibe_s/registers.ts

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| nl | drivers/nibe_s/registers.ts info, drivers/nibe_s/reason.ts, lib/driver.ts:688 COP titles | en/sv only | add nl | Repair feature lines, reason tokens and COP titles fall back to English. |
| sv | `drivers/nibe_s/registers.ts:577` (sv, and en) | Väljare för värmekurvans lutning (0–10) | Väljare för värmekurvans lutning (0–15) | Flow hints and the capability say 0–15. |

#### lib/release-announcements.ts

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | lib/release-announcements.ts:31 (da) | …Kør Reparer på din Nibe Varme-enhed… | Kør Reparer på enheden Nibe Opvarmning for at sætte det op. | Names a device the owner doesn't have. |
| nl | lib/release-announcements.ts:29 (nl) | …op je Nibe Verwarming-apparaat… | …op het apparaat Nibe Verwarming… | Wrong compound spelling. |

#### lib/roles.ts

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | lib/roles.ts → roleNames, energyTitle, powerTitle, COP titles (outside listed scope) | Only en/sv, so Danish devices are "Nibe Heating", "Nibe Hot Water" | Add da: Nibe Opvarmning, Nibe Varmt vand, Nibe Pool, Nibe Køling, Nibe Solceller | Every da "Opvarmning → Reparer" names a device that doesn't exist. |
| de | lib/roles.ts:502 roleNames | Only en/sv, so German device names are "Nibe Heating", "Nibe Hot Water" | Add de: Nibe Heizung, Nibe Warmwasser, Nibe Pool, Nibe Kühlung, Nibe Solar, Nibe Main | German copy refers to device names that don't exist. |
| nl | lib/roles.ts:502 → roleNames | {en, sv} only: Dutch tiles are named "Nibe Heating", "Nibe Hot Water" | add nl: Nibe Main, Nibe Verwarming, Nibe Warm water, Nibe Zwembad, Nibe Koeling, Nibe Zonnepanelen | nl copy points at "Verwarming"/"Warm water" tiles that are named in English. |

#### locales/da.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | locales/da.json → pair.setup.smart.outdoor_intro (da) | …eller brug udsigten. | Vælg en sensor i skyggen, eller brug vejrudsigten. | "udsigten" means the view. |
| da | locales/da.json → pair.setup.feed_short (da) | Verifikation starter regelmæssige temperaturopdateringer, også når du lukker Reparer. | Verifikationen starter løbende temperaturopdateringer, som fortsætter, når du lukker Reparer. | Says something different from en. |
| da | locales/da.json → hotwater.cal_waiting (da) | …Der skal bruges to, der opvarmer beholderen forskelligt. | …Der skal bruges to, der opvarmer beholderen forskelligt, før størrelsen kan beregnes. | Dropped half the meaning. |
| da | locales/da.json → pair.setup.smart.hw_daytype_calendar, hw_daytype_set (da) | …lad en Flow følge… / …af en Flow. | …lad et Flow følge… / …af et Flow. | "flow" is neuter in Danish. |
| da | locales/da.json → pair.setup.smart.ctl_away_sub (da) | En lavere temperatur, mens du er ude | En lavere temperatur, mens du er på ferie | Away is a week+ holiday (en too). |

#### locales/de.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| de | locales/de.json → pair.setup.smart.verify_intro (de) | Autopilot prüft, dass Ihre Wärmepumpe ihre Außentemperatur übernimmt. | Autopilot prüft, ob Ihre Wärmepumpe die Außentemperatur übernimmt. | "prüfen, dass" is wrong; "ihre" is ambiguous. |
| de | locales/de.json → pair.setup.smart.intro, steer_intro (de) | Wählen Sie eines. | Wählen Sie einen. | Refers to "Planer" (masculine). |
| de | locales/de.json → pair.setup.smart.mode_note (de) | …Simuliert plant alles und zeigt, was es tun würde… | Live steuert Ihre Wärmepumpe. Simuliert plant alles und zeigt, was Autopilot tun würde. Ihre Wärmepumpe bleibt, wie sie ist. | "es" has no referent. |
| de | locales/de.json → pair.setup.smart.ctl_range_sub (de) | Wie weit innen abweichen darf | Wie weit die Innentemperatur abweichen darf | Sentence has no subject. |
| de | locales/de.json → pair.setup.smart.ctl_away_sub (de) | Eine niedrigere Temperatur, wenn Sie weg sind | Eine niedrigere Temperatur, wenn Sie verreist sind | Away is for a holiday, not being out (EN too). |
| de | locales/de.json → pair.setup.smart.bt1_detail (de) | …Schalten Sie externes BT1 ein. | An Ihrer Wärmepumpe, Menü 7.5.9.2. Schalten Sie den externen BT1 ein. | BT1 is a Fühler (masculine); flow hint says "Externen BT1". |
| de | locales/de.json → pair.setup.smart.return_reminder (de) | …externes BT1 in Menü 7.5.9.2 aus. | Schalten Sie an Ihrer Wärmepumpe den externen BT1 in Menü 7.5.9.2 aus. | Same gender error. |
| de | locales/de.json → pair.setup.handover_hint, pair.setup.feed_recovery (de) | …deaktivieren Sie externen BT50 / schalten Sie externen BT50… aus | …den externen BT50… | Missing article. |

#### locales/nl.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| nl | locales/nl.json → pair.setup.smart.hw_flows_unknown (nl) | Je flows konden niet worden gelezen. Zet flows uit… | Je Flows konden niet worden gelezen. Zet Flows uit… | Homey's "Flow" is capitalised everywhere else. |

#### locales/no.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| no | locales/no.json → hotwater.cal_waiting (no) | … Det trengs to som varmer berederen ulikt. | … Det trengs to som varmer berederen ulikt før størrelsen kan beregnes. | Drops the purpose that en states. |
| no | locales/no.json → pair.setup.smart.hw_household (no) | Husholdningen deres | Husholdningen din | Plural "deres" next to "din" in the same screen. |
| no | locales/no.json → pair.setup.smart.ctl_range_sub (no) | Hvor langt inne kan avvike | Hvor mye innetemperaturen kan avvike | Ungrammatical; "inne" is not a noun. |

#### locales/sv.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| sv | `locales/sv.json → pair.setup.smart.verify_intro` | Autopilot kontrollerar att din värmepump tar emot dess utetemperatur. | Autopilot kontrollerar att din värmepump tar emot utetemperaturen från Autopilot. | "dess" points at the heat pump, so meaning flips. |
| sv | `locales/sv.json → pair.setup.smart.solar_evidence_plain` | Din mätare säljer el till nätet under soliga timmar. | Din mätare visar att du säljer el under soliga timmar. | A meter doesn't sell power. |
| sv | `locales/sv.json → pair.setup.smart.ctl_away_sub` | En lägre temperatur när du är borta | En lägre temperatur när du är bortrest | Away is a holiday, never "while you're out". |

#### Across files

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | capabilities/measure_volume_NIBE units; flow hotwater_volume_dropped_below / hotwater_volume_below titleFormatted (da) | l | L | Every other da string uses L. |

### R1. Plain voice


#### .homeycompose/locales/da.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | .homeycompose/locales/da.json → pair.discover.confirm (da) | Fandt varmepumpen – tryk for at bekræfte | Din varmepumpe er fundet. Tryk for at bekræfte. | Dash aside; full stop instead (en too). |
| da | .homeycompose/locales/da.json → pair.firmware.online_body (da) | …i myUplink-appen – eller på din varmepumpes display: swipe til… | …i myUplink-appen eller på din varmepumpes display. Swipe til produktoversigten, og tryk på Opdater. | Dash aside and colon delivery (en too). |
| da | .homeycompose/locales/da.json → pair.firmware.f_body (da) | Trinnene er forskellige fra model til model – din varmepumpes manual viser hvordan. | Trinnene er forskellige fra model til model. Din varmepumpes manual viser hvordan. | Dash aside (en too). |
| da | .homeycompose/locales/da.json → pair.devices.analytics_desc (da) | …Ingen personlige oplysninger, ingen målinger fra dit hjem, ingen netværksoplysninger. … | …Personlige oplysninger, målinger fra dit hjem og netværksoplysninger sendes aldrig. … | "Ingen X, ingen Y" rhythm pattern (en too). |

#### .homeycompose/locales/de.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| de | .homeycompose/locales/de.json → pair.features.insights_note (de) | Wird eine Funktion deaktiviert, werden ihre Fähigkeiten entfernt – einschließlich des Insights-Verlaufs. | Wird eine Funktion abgewählt, verschwinden ihre Werte samt Insights-Verlauf. | Dash aside; "Fähigkeiten" is a literal of "capabilities". |
| de | .homeycompose/locales/de.json → pair.discover.confirm (de) | Wärmepumpe gefunden – zum Bestätigen tippen | Wärmepumpe gefunden. Zum Bestätigen tippen. | Dash aside. |
| de | .homeycompose/locales/de.json → pair.firmware.online_body (de) | …in der myUplink-App – oder am Display Ihrer Wärmepumpe: zur Produktübersicht wischen… | Bestätigen Sie ein Update in der myUplink-App oder am Display Ihrer Wärmepumpe. Dort zur Produktübersicht wischen und Aktualisieren tippen. | Dash aside plus colon delivery. |
| de | .homeycompose/locales/de.json → pair.firmware.f_body (de) | Die Schritte unterscheiden sich je nach Modell – das Handbuch… | Die Schritte unterscheiden sich je nach Modell. Das Handbuch Ihrer Wärmepumpe zeigt, wie es geht. | Dash aside. |
| de | .homeycompose/locales/de.json → pair.devices.analytics_desc (de) | …Keine personenbezogenen Daten, keine Messwerte aus Ihrem Zuhause, keine Netzwerkdaten… | …Messwerte, persönliche Daten und Netzwerkdaten bleiben bei Ihnen. Änderbar in den App-Einstellungen. | "Keine X, keine Y" chain. |
| de | .homeycompose/locales/de.json → autopilot.smart.verify_first (de) | …→ Smart-Modus ein: dort wird zuerst geprüft, dass… | Schalten Sie Autopilot unter Heizung → Reparieren → Smart-Modus ein. Dort wird zuerst geprüft, ob Ihre Wärmepumpe die Außentemperatur übernimmt. | Colon delivery; "prüft, dass" should be "prüft, ob". |
| de | .homeycompose/locales/de.json → autopilot.hotwater_charge.plan.moved (de) | Geändert: der Plan sah __time__ vor. | Geändert. Geplant war __time__. | Colon delivery; full sentence after colon needs capital. |
| de | .homeycompose/locales/de.json → autopilot.heating.verify.no_outdoor (de) | Noch keine Außentemperatur: Sensor wählen oder Standort… | Noch keine Außentemperatur. Wählen Sie einen Fühler oder legen Sie den Standort für die Wettervorhersage fest. | Colon delivery. |
| de | .homeycompose/locales/de.json → autopilot.heating.status.range_off (de) | Komfortbereich ist Aus: Ihre Wärmepumpe sieht die echte Außentemperatur | Komfortbereich Aus. Ihre Wärmepumpe sieht die echte Außentemperatur | Colon delivery. |

#### .homeycompose/locales/nl.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| nl | .homeycompose/locales/nl.json → pair.discover.confirm (nl) | Warmtepomp gevonden — tik om te bevestigen | Warmtepomp gevonden. Tik om te bevestigen. | Em dash as aside. |
| nl | .homeycompose/locales/nl.json → pair.firmware.online_body (nl) | …keur die dan goed in de myUplink-app – of op het display van je warmtepomp: veeg naar… | Staat er een update klaar? Keur die goed in de myUplink-app of op het display van je warmtepomp. Veeg naar het productoverzicht en tik op Bijwerken. | Dash aside plus colon delivery. |
| nl | .homeycompose/locales/nl.json → pair.firmware.f_body (nl) | De stappen verschillen per model – de handleiding van je warmtepomp laat zien hoe. | De stappen verschillen per model. De handleiding van je warmtepomp laat zien hoe. | Dash aside. |
| nl | .homeycompose/locales/nl.json → pair.devices.analytics_desc (nl) | Geen persoonlijke gegevens, geen metingen uit je huis, geen netwerkgegevens. | Persoonlijke gegevens, metingen en netwerkgegevens worden nooit verstuurd. | "Geen X, geen Y" rhythm pair. |
| nl | .homeycompose/locales/nl.json → pair.features.insights_note (nl) | …worden de bijbehorende mogelijkheden verwijderd, inclusief hun Insights-geschiedenis. | Zet je een functie uit, dan verdwijnen de waarden ervan, ook hun geschiedenis in Inzichten. | "Mogelijkheden" is capability-speak, a developer word. |
| nl | .homeycompose/locales/nl.json → autopilot.heating.status.range_off (nl) | Comfortbereik staat Uit: je warmtepomp ziet de echte buitentemperatuur | Comfortbereik staat uit. Je warmtepomp ziet de echte buitentemperatuur | Colon delivers the point. |
| nl | .homeycompose/locales/nl.json → autopilot.smart.verify_first (nl) | …→ Slimme modus: daar wordt eerst gecontroleerd of… | Zet Autopilot aan via Verwarming → Repareren → Slimme modus. Daar wordt eerst gecontroleerd of je warmtepomp de buitentemperatuur overneemt. | Colon delivers the point. |
| nl | .homeycompose/locales/nl.json → autopilot.hotwater_charge.plan.moved (nl) | Gewijzigd: het plan had hem om __time__. | Verschoven. Gepland was __time__. | Colon punchline; "hem" for "de opwarming" reads off. |

#### .homeycompose/locales/no.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| no | .homeycompose/locales/no.json → pair.devices.analytics_desc (no) | … Ingen personopplysninger, ingen målinger fra hjemmet ditt, ingen nettverksdetaljer. … | … Personopplysninger, målinger og nettverksdetaljer sendes aldri. … | "ingen X, ingen Y" rhythm pattern. |
| no | .homeycompose/locales/no.json → pair.discover.confirm (no) | Fant varmepumpen – trykk for å bekrefte | Fant varmepumpen din. Trykk for å bekrefte. | Dash aside; full stop delivers it. |
| no | .homeycompose/locales/no.json → pair.firmware.online_body (no) | … i myUplink-appen – eller på varmepumpens display: sveip … | … i myUplink-appen. Du kan også sveipe til produktoversikten på displayet og trykke på Oppdater. | Dash aside plus colon punchline. |
| no | .homeycompose/locales/no.json → pair.firmware.f_body (no) | Stegene er forskjellige mellom modeller – varmepumpens manual viser hvordan. | Stegene varierer mellom modeller. Manualen til varmepumpen din viser hvordan. | Dash aside. |

#### .homeycompose/locales/sv.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| sv | `.homeycompose/locales/sv.json → pair.devices.analytics_desc` | …Ingen personlig information, inga mätvärden från ditt hem, inga nätverksuppgifter. … | …Inga personuppgifter, mätvärden eller nätverksuppgifter skickas. … | "no X, no Y, no Z" rhythm. |
| sv | `.homeycompose/locales/sv.json → pair.discover.confirm` | Hittade din värmepump — tryck för att bekräfta | Hittade din värmepump. Tryck för att bekräfta. | Em dash aside. |
| sv | `.homeycompose/locales/sv.json → pair.firmware.online_body` | När en uppdatering väntar, godkänn den i myUplink-appen – eller på din värmepumps display: svep … | Godkänn uppdateringen i myUplink-appen eller på displayen. Svep till produktöversikten och tryck på Uppdatera. | Dash aside and colon punchline. |
| sv | `.homeycompose/locales/sv.json → pair.firmware.f_body` | Stegen skiljer sig mellan modeller – din värmepumps manual visar hur. | Stegen skiljer sig mellan modeller. Handboken till din värmepump visar hur. | Dash aside. NIBE says "handbok". |
| sv | `.homeycompose/locales/sv.json → autopilot.hotwater_charge.plan.moved` | Ändrat: planen hade den kl. __time__. | Flyttad. Planen hade den kl. __time__. | Colon delivery. Matches recap.moved "Flyttad." |
| sv | `.homeycompose/locales/sv.json → autopilot.heating.status.range_off` | Komfortspann är Av: din värmepump ser den verkliga utetemperaturen | Komfortspann Av. Din värmepump får den verkliga utetemperaturen. | Colon punchline. |
| sv | `.homeycompose/locales/sv.json → autopilot.smart.verify_first` | …→ Smart läge: där kontrolleras först att… | Slå på Autopilot i Värme → Reparera → Smart läge. Där kontrolleras att din värmepump tar emot utetemperaturen. | Colon punchline, passive. |

#### driver.flow.compose.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | driver.flow.compose.json → actions.spa_hotwater_influence_NIBE.h902….enum.hint (da) | …Går fra 1 til 4, ikke 1 til 10 som varmen. | Hvor meget Smart price adaption må flytte opvarmningen af varmt vand til billigere timer. Fra 1 til 4. | Contrast pair (en too). |
| da | driver.flow.compose.json → actions.external_temperature.h5217_bt1.set.hint (da) | …Sender én måling; Flow skal sende aktuelle værdier regelmæssigt. Succes bekræfter modtagelse, ikke brug til opvarmning. | Slå ekstern BT1 til i menu 7.5.9.2 på din varmepumpe. Kortet sender én måling, så dit Flow skal sende en ny jævnligt. | Semicolon plus contrast pair (en too). |
| da | driver.flow.compose.json → actions.set_numeric_value / enable_feature / disable_feature .hint (da) | …Brug helst enhedens egne til/fra-kort – dette er nødløsningen. | …Brug helst enhedens egne til/fra-kort. Dette kort er til resten. | Dash aside (en too), three cards. |

#### drivers/nibe_s/driver.flow.compose.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| de | drivers/nibe_s/driver.flow.compose.json → actions.external_temperature.h5217_bt1.set.hint (de) | …Sendet einen Messwert; der Flow muss… Erfolg bestätigt die Übertragung, nicht die Nutzung zur Heizungsregelung. | Schalten Sie den externen BT1 in Menü 7.5.9.2 ein. Die Karte sendet einen Wert, Ihr Flow muss regelmäßig neue senden. | Semicolon plus "X, nicht Y". |
| de | drivers/nibe_s/driver.flow.compose.json → actions.set_numeric_value / enable_feature / disable_feature.hint (de) | …Bevorzugen Sie die eigenen Ein/Aus-Karten des Geräts – dies ist die Ausweichlösung. | Nutzen Sie lieber die eigenen Karten des Geräts. Diese Karte ist für alles andere. | Dash aside (3 hints; deprecated cards). |
| nl | drivers/nibe_s/driver.flow.compose.json → actions[spa_hotwater_influence….enum].hint (nl) | …Loopt van 1 tot 4, niet 1 tot 10 zoals verwarming. | Hoe sterk Smart price adaption het opwarmen naar goedkopere uren mag verschuiven, van 1 tot 4. | "niet X zoals Y" contrast pair. |
| nl | drivers/nibe_s/driver.flow.compose.json → actions[external_temperature.h5217_bt1.set].hint (nl) | Verzendt één meting; de Flow moet… Succes bevestigt ontvangst, niet gebruik voor verwarming. | Zet eerst externe BT1 aan in menu 7.5.9.2 van je warmtepomp. Stuur daarna regelmatig een nieuwe waarde. | Semicolon plus "X, niet Y" contrast pair. |
| no | drivers/nibe_s/driver.flow.compose.json → actions[spa_hotwater_influence_NIBE.h902_spa_hotwater_influence.enum].hint (no) | … Går fra 1 til 4, ikke 1 til 10 som varmen. | Hvor mye Smart pristilpasning får flytte varmtvannet mot billigere timer, fra 1 til 4. | Contrast pair; the picker already shows 1–4. |
| no | drivers/nibe_s/driver.flow.compose.json → actions[external_temperature.h5217_bt1.set].hint (no) | … Sender én måling; Flow må sende ferske verdier regelmessig. Suksess bekrefter mottak, ikke bruk til oppvarming. | Slå på ekstern BT1 i meny 7.5.9.2 på varmepumpen din. Kortet sender én måling, så Flowen må sende nye verdier jevnlig. | Semicolon and an "X, ikke Y" pair. |
| no | drivers/nibe_s/driver.flow.compose.json → conditions[hotwater_volume_below].hint (no) | Krever valgt bereder; usant uten. | Krever at du velger bereder under Reparer. Uten bereder er svaret alltid nei. | Semicolon; "usant uten" is clipped code-speak. |
| no | drivers/nibe_s/driver.flow.compose.json → actions[set_numeric_value\|enable_feature\|disable_feature].hint (no) | … på/av-kort – dette er nødløsningen. | … Bruk helst enhetens egne kort. Dette kortet er for det som ikke har et eget kort. | Dash aside in three hints. |
| sv | `drivers/nibe_s/driver.flow.compose.json → actions.target_temperature.h61_hotwater_stop_periodic.set.hint` (sv), also `drivers/nibe_s/registers.ts:658` | …behövs oftast elpatronen — en kompressor ensam når knappt 60 °C. … | …behövs oftast elpatronen. Kompressorn ensam når knappt 60 °C. … | Em dash aside. |
| sv | `drivers/nibe_s/driver.flow.compose.json → actions.spa_hotwater_influence_NIBE.h902_spa_hotwater_influence.enum.hint` (sv) | …Går 1 till 4, inte 1 till 10 som värmen. | …Skalan går från 1 till 4. | "X, not Y" pair. |
| sv | `drivers/nibe_s/driver.flow.compose.json → actions.set_numeric_value.hint`, `enable_feature.hint`, `disable_feature.hint` (sv) | …— det här är reservutgången… | …Använd hellre de namngivna korten. Det här kortet är för register som saknar eget kort. | Em dash aside, and "reservutgång" is a literal "escape hatch". |
| sv | `drivers/nibe_s/driver.flow.compose.json → actions.external_temperature.h5217_bt1.set.hint` (sv) | …Lyckat betyder att skrivningen accepterats, inte att värmen använder värdet. | …Ett lyckat kort betyder bara att din värmepump tog emot värdet. | "X, not Y" pair and developer word "skrivning". |
| sv | `drivers/nibe_s/driver.flow.compose.json → conditions.hotwater_volume_below.hint` (sv) | Kräver en vald beredare under Reparera; falskt utan. | Kräver en vald tank under Reparera. Utan tank är villkoret falskt. | Semicolon in UI text. |

#### drivers/nibe_s/registers.ts

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| sv | `drivers/nibe_s/registers.ts:250` | Medelutetemperatur — det som värmestoppet jämförs mot | Medelutetemperatur. Värmestoppet jämförs mot den. | Em dash aside. |
| sv | `drivers/nibe_s/registers.ts:416` | Smart prisanpassning — flytta förbrukningen mot billigare timmar | Smart price adaption flyttar förbrukningen till billigare timmar | Em dash aside. |
| sv | `drivers/nibe_s/registers.ts:117`, `:119` (source labels) | Medelvärde klimatsystem 1 — trådade eller trådlösa rumsgivare / Rumsgivare BT50 — trådad eller extern ingång | Medelvärde klimatsystem 1 (trådade eller trådlösa rumsgivare) / Rumsgivare BT50 (trådad eller extern ingång) | Em dash aside. |

#### locales/da.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | locales/da.json → pair.tank.inlet_hint (da) | 10 °C er det sædvanlige; lidt lavere om vinteren, højere om sommeren. | 10 °C er det normale. Lidt lavere om vinteren og højere om sommeren. | Semicolon in UI text (en too). |
| da | locales/da.json → pair.setup.success_title (da) | Alt er klar! | Alt er klar. | Exclamation mark (en too). |
| da | locales/da.json → pair.setup.smart.indoor_homey_desc (da) | …Autopilot regulerer efter dem, ikke din varmepumpe. | Én sensor eller gennemsnittet af flere rum. Autopilot regulerer efter dem. | "X, ikke Y" contrast pair (en too). |

#### locales/de.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| de | locales/de.json → pair.tank.inlet_hint (de) | Üblich sind 10 °C; im Winter etwas weniger, im Sommer mehr. | Üblich sind 10 °C. Im Winter etwas weniger, im Sommer mehr. | Semicolon in UI text. |
| de | locales/de.json → pair.setup.request_timeout (de) | Homey hat nicht geantwortet. Bitte erneut versuchen. | Homey hat nicht geantwortet. Versuchen Sie es noch einmal. | No "bitte". |
| de | locales/de.json → pair.setup.success_title (de) | Alles bereit! | Alles bereit. | No exclamation marks. |
| de | locales/de.json → pair.setup.smart.cmp_note (de) | Die smarte Preisanpassung ist NIBEs eigene: Sie läuft… | Smart Price Adaption ist NIBEs eigene Lösung. Sie läuft in Ihrer Wärmepumpe und holt die Preise über myUplink. | Colon punchline; also wrong product name. |
| de | locales/de.json → pair.setup.smart.prices_fixed (de) | Festpreis: nichts zu verschieben. Dynamische Preise… | Festpreis. Es gibt nichts zu verschieben. Stellen Sie dynamische Preise in Homey Energie ein. | Colon delivery. |
| de | locales/de.json → pair.setup.smart.indoor_homey_desc (de) | …Autopilot regelt danach, nicht Ihre Wärmepumpe. | Ein Sensor oder der Durchschnitt mehrerer Räume. Autopilot regelt danach. | "X, nicht Y" contrast pair. |

#### locales/nl.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| nl | locales/nl.json → pair.tank.inlet_hint (nl) | 10 °C is gebruikelijk; in de winter iets lager, in de zomer hoger. | Meestal 10 °C. In de winter iets lager, in de zomer hoger. | Semicolon in UI text. |
| nl | locales/nl.json → pair.setup.thermostat_zone_intro (nl) | Kies de zone die de verwarming regelt: op je warmtepomp is de ruimtesensor… | Kies de zone die de verwarming regelt. Op je warmtepomp staat de ruimtesensor van die zone op regelen (menu 1.3.3). | Colon delivers the point. |
| nl | locales/nl.json → pair.setup.success_title (nl) | Alles is klaar! | Alles staat klaar. | Exclamation mark. |
| nl | locales/nl.json → pair.setup.smart.prices_fixed (nl) | Vaste prijs: niets te verschuiven. Stel dynamische prijzen in bij Homey Energie. | Met een vaste prijs valt er niets te verschuiven. Stel dynamische prijzen in bij Homey Energie. | Colon punchline. |
| nl | locales/nl.json → pair.setup.smart.indoor_homey_desc (nl) | Eén sensor, of het gemiddelde van meerdere kamers. Autopilot regelt erop, je warmtepomp niet. | Eén sensor of het gemiddelde van meerdere kamers. Autopilot regelt erop. | "X, je warmtepomp niet" contrast pair. |
| nl | locales/nl.json → pair.setup.smart.cmp_note (nl) | Slimme prijsaanpassing is van NIBE zelf: het draait in je warmtepomp… | Smart price adaption is van NIBE zelf. Het draait in je warmtepomp en haalt prijzen via myUplink. | Colon delivery (and term, see R8). |

#### locales/no.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| no | locales/no.json → pair.tank.inlet_hint (no) | 10 °C er det vanlige; litt lavere om vinteren, høyere om sommeren. | 10 °C er vanlig. Litt lavere om vinteren, høyere om sommeren. | Semicolon in UI text. |

#### locales/sv.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| sv | `locales/sv.json → pair.tank.inlet_hint` | 10 °C är det vanliga; något lägre på vintern, högre på sommaren. | 10 °C är vanligt. Lite lägre på vintern och högre på sommaren. | Semicolon in UI text. |
| sv | `locales/sv.json → pair.setup.success_title` | Allt är klart! | Allt är klart. | Exclamation mark. |
| sv | `locales/sv.json → pair.setup.smart.indoor_homey_desc` | En sensor, eller medelvärdet av flera rum. Autopilot reglerar efter dem, inte din värmepump. | En givare eller medelvärdet av flera rum. Autopilot reglerar efter dem. | "X, not Y" pair. |
| sv | `locales/sv.json → pair.setup.changes.autopilot_simulated` | Autopilot, simulerad: den planerar och visar, din värmepump förblir som den är | Autopilot · Simulerad. Den planerar och visar vad den skulle göra. | Colon delivery, and Smart mode's own name. |

### R3. Your heat pump


#### .homeycompose/locales/da.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | .homeycompose/locales/da.json → autopilot.heating.no_thermostat (da) | Opvarmning har ingen termostat at indstille. | Enheden Opvarmning har ingen termostat at indstille. | Device name used bare; en says "the Heating device". |

#### drivers/nibe_s/registers.ts

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| sv | `drivers/nibe_s/registers.ts:130, 149, 151, 154, 175, 192, 395, 596, 598, 604, 664` (sv info shown in Repair) | …pumpen siktar på / …pumpen får producera / …larm på pumpen | …din värmepump siktar på / …din värmepump får producera / …larm på din värmepump | Owner text calls the machine "din värmepump". |

#### locales/da.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | locales/da.json → pair.setup.smart.success_description (da) | Komfortinterval, Fraværende og status ligger på Opvarmning. | Komfortinterval, Bortrejst og status ligger på enheden Opvarmning. | Name the Homey device as a device. |

#### locales/nl.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| nl | locales/nl.json → pair.setup.analytics_benefit (nl) | Door te delen hoe de app met jouw pomp werkt… | Door te delen hoe de app met jouw warmtepomp werkt… | Machine is always "warmtepomp". |

### R4. Autopilot, Live and Simulated


#### .homeycompose/locales/da.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | .homeycompose/locales/da.json → autopilot.hotwater_daily.shadow, autopilot.hotwater_update.shadow (da) | Simulering: din varmepumpe forbliver, som den er. | Simuleret. Din varmepumpe kører videre som før. | Mode is Simulated, not Simulation (en too). |
| da | .homeycompose/locales/da.json → autopilot.hotwater_charge.title_would, autopilot.heating.status.test, autopilot.hotwater_status.test, autopilot.widget.test (da) | Simulering: … / Simulering | Simuleret: … / Simuleret | Old mode name, 4 keys (en too). |

#### .homeycompose/locales/de.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| de | .homeycompose/locales/de.json → autopilot.hotwater_daily.shadow, autopilot.hotwater_update.shadow (de) | Simulation: Ihre Wärmepumpe bleibt, wie sie ist. | Simuliert. Ihre Wärmepumpe bleibt, wie sie ist. | Mode is "Simuliert" in Smart mode; EN has same old word. |
| de | .homeycompose/locales/de.json → autopilot.hotwater_charge.title_would (de) | Simulation: würde eine Ladung starten · __reason__ | Simuliert · würde eine Ladung starten · __reason__ | Old mode name. |
| de | .homeycompose/locales/de.json → autopilot.heating.status.test, autopilot.hotwater_status.test (de) | Simulation: __text__ | Simuliert · __text__ | Old mode name. |
| de | .homeycompose/locales/de.json → autopilot.widget.test (de) | Simulation | Simuliert | Widget badge should match Smart mode label. |

#### .homeycompose/locales/nl.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| nl | .homeycompose/locales/nl.json → autopilot.hotwater_daily.shadow (nl) | Simulatie: je warmtepomp blijft zoals hij is. | Gesimuleerd. Je warmtepomp blijft zoals hij is. | Mode is "Gesimuleerd", not the old "Simulatie". |
| nl | .homeycompose/locales/nl.json → autopilot.hotwater_update.shadow (nl) | Simulatie: je warmtepomp blijft zoals hij is. | Gesimuleerd. Je warmtepomp blijft zoals hij is. | Old mode name. |
| nl | .homeycompose/locales/nl.json → autopilot.hotwater_charge.title_would (nl) | Simulatie: zou een opwarming starten · __reason__ | Gesimuleerd · zou nu opwarmen · __reason__ | Old mode name. |
| nl | .homeycompose/locales/nl.json → autopilot.heating.status.test / autopilot.hotwater_status.test (nl) | Simulatie: __text__ | Gesimuleerd · __text__ | Old mode name, colon. |
| nl | .homeycompose/locales/nl.json → autopilot.widget.test (nl) | Simulatie | Gesimuleerd | Widget badge should match Smart mode. |

#### .homeycompose/locales/no.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| no | .homeycompose/locales/no.json → autopilot.hotwater_daily.shadow, hotwater_update.shadow, hotwater_charge.title_would, heating.status.test, hotwater_status.test, widget.test; locales/no.json → pair.setup.smart.start_test, saved_test; flow → triggers[hotwater_charge_started].hint (no) | Simulering: varmepumpen din forblir som den er. / Simulering / i Simulering | Simulert: varmepumpen din endres ikke. / Simulert / Kjør simulert / med Autopilot · Simulert | Old name "Simulation" (9×); the mode is "Simulert" in Smart mode. |

#### .homeycompose/locales/sv.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| sv | `.homeycompose/locales/sv.json → autopilot.hotwater_daily.shadow`, `autopilot.hotwater_update.shadow` | Simulering: din värmepump förblir som den är. | Simulerad. Din värmepump ändras inte. | Mode is "Simulerad" (pair.setup.smart.mode_simulated). |
| sv | `.homeycompose/locales/sv.json → autopilot.heating.status.test`, `autopilot.hotwater_status.test` | Simulering: __text__ | Simulerad · __text__ | Old mode name, colon prefix. |
| sv | `.homeycompose/locales/sv.json → autopilot.hotwater_charge.title_would` | Simulering: skulle starta en laddning · __reason__ | Simulerad laddning · __reason__ | Old mode name, colon prefix. |
| sv | `.homeycompose/locales/sv.json → autopilot.widget.test` | Simulering | Simulerad | Widget badge should match the mode name. |

#### driver.flow.compose.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | driver.flow.compose.json → triggers.hotwater_charge_started.hint (da) | …Virker med Autopilot tændt eller i Simulering. | Virker med Autopilot · Live og Autopilot · Simuleret. | Old mode name (en too). |

#### drivers/nibe_s/driver.flow.compose.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| de | drivers/nibe_s/driver.flow.compose.json → triggers.hotwater_charge_started.hint (de) | …Funktioniert mit Autopilot an oder in der Simulation. | …Funktioniert mit Autopilot · Live und Autopilot · Simuliert. | Old mode name. |
| de | drivers/nibe_s/driver.flow.compose.json → actions.autopilot_heating_set_profile.args.values.save_most (de) | Lieber frieren (±6 °C) | Mehr sparen (±6 °C) | Range is "Mehr sparen" on the capability; EN also stale. |
| nl | drivers/nibe_s/driver.flow.compose.json → triggers[hotwater_charge_started].hint (nl) | …Werkt met Autopilot aan of in Simulatie. | …Werkt met Autopilot · Live en Autopilot · Gesimuleerd. | Old mode name. |
| sv | `drivers/nibe_s/driver.flow.compose.json → triggers.hotwater_charge_started.hint` (sv) | …Fungerar med Autopilot på eller i Simulering. | …Fungerar med Autopilot · Live och Autopilot · Simulerad. | Old mode name. |
| sv | `drivers/nibe_s/driver.flow.compose.json → actions.autopilot_heating_set_profile.args.profile.values.save_most.label` (sv) | Hellre frysa (±6 °C) | Spara mer (±6 °C) | Range is "Spara mer" everywhere, including this card's own hint. |

#### locales/da.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | locales/da.json → pair.setup.smart.start_test, pair.setup.smart.saved_test (da) | Start simulering / Simulering startet | Start Simuleret / Autopilot · Simuleret er startet | Must match the "Simuleret" mode label (en too). |

#### locales/de.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| de | locales/de.json → pair.setup.smart.start_test (de) | Simulation starten | Autopilot · Simuliert starten | Old mode name. |
| de | locales/de.json → pair.setup.smart.saved_test (de) | Simulation gestartet | Autopilot · Simuliert läuft | Old mode name. |
| de | locales/de.json → pair.setup.changes.autopilot_simulated (de) | Autopilot, simuliert: er plant und zeigt, Ihre Wärmepumpe bleibt, wie sie ist | Autopilot · Simuliert. Er plant und zeigt, Ihre Wärmepumpe bleibt, wie sie ist | Use the Smart mode label; drop colon. |

#### locales/nl.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| nl | locales/nl.json → pair.setup.smart.start_test (nl) | Simulatie starten | Gesimuleerd starten | Button names the old mode. |
| nl | locales/nl.json → pair.setup.smart.saved_test (nl) | Simulatie gestart | Autopilot · Gesimuleerd staat aan | Old mode name. |
| nl | locales/nl.json → pair.setup.changes.autopilot_simulated (nl) | Autopilot, gesimuleerd: hij plant en laat zien, je warmtepomp blijft zoals hij is | Autopilot · Gesimuleerd. Plant alles, je warmtepomp blijft zoals hij is | Smart mode lists "Autopilot · Gesimuleerd". |

### R5. Dutch je, German Sie


#### .homeycompose/locales/de.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| de | .homeycompose/locales/de.json → pair.firmware.usb_body (de) | Lade die neueste Software … Stecke ihn … und öffne Menü 8.1. | Laden Sie die neueste Software von myuplink.com auf einen USB-Stick. Stecken Sie ihn in den Anschluss über dem Display und öffnen Sie Menü 8.1. | du-form; German is formal Sie. |
| de | .homeycompose/locales/de.json → pair.firmware.note (de) | Dauert ein paar Minuten. Deine Einstellungen bleiben erhalten. | Dauert ein paar Minuten. Ihre Einstellungen bleiben erhalten. | du-form. |
| de | .homeycompose/locales/de.json → autopilot.hotwater_setting.no_tank (de) | Wähle zuerst die Speichergröße: Warmwasser-Gerät → Reparieren. | Wählen Sie zuerst die Speichergröße unter Warmwasser → Reparieren. | du-form; colon delivery. |

#### lib/release-announcements.ts

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| de | lib/release-announcements.ts:28 (de) | …wählst du, welche Zone er einstellt. Führe Reparieren auf deinem Nibe-Heizungsgerät aus… | …wählen Sie, welche Zone er einstellt. Führen Sie Reparieren am Gerät Heizung aus, um es einzurichten. | du-form in the live timeline message. |

### R6. Length


#### .homeychangelog.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| de | .homeychangelog.json → 1.5.0 (de), lesson | Features: Funk-Raumfühler. … Tweaks: Wenn unter der Adresse… | Next time: German section labels ("Neu:", "Verbessert:") instead of English "Features/Tweaks". | English labels left in a German store text. |
| no | .homeychangelog.json → 1.5.0 (no), lesson | … i stedet for å vise -1 overalt. | … og enhetene sier fra. | Lesson: contrast tail adds length, not meaning. |
| no | .homeychangelog.json → 1.4.10 (no), lesson | … logger appen også sonetemperaturer én gang etter hver oppstart, for å kunne legge til en temperatur per sone. | Drop the sentence. | Lesson: logging detail is developer news, not owner news. |
| sv | `.homeychangelog.json → 1.5.0` (sv), lesson | ~70 words over six sentences | Two sentences per item at most | Uploaded, cannot change. Keep the next one shorter. |

#### driver.flow.compose.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | driver.flow.compose.json → actions.set_numeric_value.hint (da) | Skriver til et vilkårligt skrivbart Modbus-register… (3 sentences, dash) | Skriver til et Modbus-register, valgt ved navn. Brug helst de navngivne kort. | Hint over two sentences (en too). |

#### drivers/nibe_s/driver.compose.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| de | drivers/nibe_s/driver.compose.json → settings.analyticsConsent.hint (de) | Standardmäßig aus. Sendet das Modell…, gekoppelte Geräte, ausgeführte Flow-Karten, Alarmcodes sowie … wie jeder Tag lief. Nie Messwerte… | Standardmäßig aus. Sendet Modell, Funktionen und Alarmcodes, nie Messwerte oder Namen. Details in der Hilfe. | Settings hint is a paragraph; list belongs in help. |
| no | drivers/nibe_s/driver.compose.json → settings[4].children[analyticsConsent].hint (no) | Av som standard. Sender varmepumpens modell, parede enheter, kjørte flytkort, alarmkoder og hvordan Autopilot er satt opp og hvordan hver dag gikk. Aldri … | Av som standard. Sender modell, enheter, Flow-kort som kjørte, alarmkoder og Autopilot-oppsett. Aldri målinger, IP, serienummer eller navn. | Settings hint runs long; list belongs in help. |
| sv | `drivers/nibe_s/driver.compose.json → settings.Privacy.analyticsConsent.hint` (sv) | Av som standard. Skickar din värmepumps modell, vilka enheter du parkopplat, vilka flödeskort som körts, larmkoder samt hur Autopilot är inställd och hur varje dag gick. Aldrig … | Av som standard. Skickar modell, valda funktioner och larmkoder. Aldrig mätvärden eller namn. | Three-part list in a hint. The full list belongs in help. |

#### drivers/nibe_s/driver.flow.compose.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| nl | drivers/nibe_s/driver.flow.compose.json → actions[external_temperature.h5217_bt1.set].hint (nl) | Activeer externe BT1… Verzendt één meting; … Succes bevestigt ontvangst, niet gebruik voor verwarming. | Zet eerst externe BT1 aan in menu 7.5.9.2 van je warmtepomp. Stuur daarna regelmatig een nieuwe waarde. | Three clauses of caveats; keep two sentences. |

#### locales/de.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| de | locales/de.json → pair.setup.smart.indoor_bt50_note (de) | Ihre Homey-Sensoren gehen weiter als BT50 an Ihre Wärmepumpe, damit … Mit ausgeschalteter … Autopilot übernimmt die Regelung. | Ihre Homey-Sensoren gehen als BT50 an Ihre Wärmepumpe. Autopilot übernimmt die Regelung. | Three sentences of mechanism in a hint. |
| de | locales/de.json → pair.setup.smart.solar_forecast_hint (de) | Lässt eine Nachtladung aus, wenn Sonne vorhergesagt ist, und pausiert sich selbst, wenn … Aus lassen, wenn ein Hausspeicher oder eine Wallbox… | Lässt eine Nachtladung aus, wenn Sonne kommt. Aus lassen, wenn ein Hausspeicher Ihren Solarstrom zuerst nutzt. | Too long for a hint; self-pause belongs in help. |

#### locales/nl.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| nl | locales/nl.json → pair.setup.pending_hint (nl) | Voeg eerst de apparaten toe en open daarna Verwarming → Herstellen om de installatie af te ronden. Laat je NIBE-sensor… Tijdens koppelen worden geen temperaturen verstuurd. | Voeg eerst de apparaten toe. Rond het daarna af via Verwarming → Repareren. | Three-sentence hint; the last two belong in help. |
| nl | locales/nl.json → pair.setup.smart.indoor_bt50_note (nl) | Je Homey-sensoren gaan als BT50 naar je warmtepomp, zodat die geen sensorfout meldt. Met de ruimtevoelerregeling uit toont hij ze alleen. Autopilot regelt. | Je warmtepomp toont je Homey-sensoren als BT50. Autopilot regelt. | Three sentences of mechanism in a hint. |

### R7. Native language and heat-pump terms


#### .homeychangelog.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | .homeychangelog.json → 1.5.0 (da), lesson | Features: … Tweaks: … | Nyt: … Forbedringer: … | English labels in a Danish store text. |
| nl | .homeychangelog.json → 1.5.0 (nl), lesson | Features: … Tweaks: … | Nieuw: … Verbeteringen: … | Template headings left in English for Dutch owners. |
| no | .homeychangelog.json → 1.5.0 (no), lesson | Features: … Tweaks: … | Nytt: … Forbedringer: … | Template headings left in English. |
| sv | `.homeychangelog.json → 1.5.0` (sv), lesson | Features: … Tweaks: … | Nyheter: … Förbättringar: … | English headings left in Swedish copy. |

#### .homeycompose/capabilities/autopilot_status_NIBE.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| sv | `.homeycompose/capabilities/autopilot_status_NIBE.json → values.holding.title`, `.homeycompose/locales/sv.json → autopilot.heating.status_name.holding`, `status.holding`, `status.holding_even`, `status.next_*`, flow `autopilot_heating_status_is` label | Håller | Avvaktar | "Håller" needs an object in Swedish. |

#### .homeycompose/locales/da.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | .homeycompose/locales/da.json → autopilot.hotwater_daily.charge (da) | Opvarm __time__ til __target__ °C · __reason__ | Opvarmer __time__ til __target__ °C · __reason__ | Imperative reads as an order to the owner. |
| da | .homeycompose/locales/da.json → autopilot.hotwater_charge.detail.pump (da) | …startede den ved __top__ °C på sin egen starttemperatur og opvarmer til __stop__ °C. | Din varmepumpe startede selv ved __top__ °C og opvarmer til __stop__ °C. | Literal, clumsy "på sin egen starttemperatur". |
| da | .homeycompose/locales/da.json → autopilot.hotwater_charge.recap.as_planned_pump (da) | Planlagt da også. | Også planlagt. | Unnatural word order. |
| da | .homeycompose/locales/da.json → autopilot.hotwater_update.title.new_prices / .revised (da) | Nye priser er kommet. Varmtvandsplanen opdateret. | Nye priser er kommet. Varmtvandsplanen er opdateret. | Missing verb next to a full sentence. |
| da | .homeycompose/locales/da.json → autopilot.hotwater_update.added, .added_new_hours, .moved, .moved_repriced; autopilot.hotwater_charge.detail.price (da) | …til __target__ °C til __price__/kWh… | …til __target__ °C for __price__/kWh… | Double "til" reads as "to 56 °C to 1.20 kr". |
| da | .homeycompose/locales/da.json → autopilot.hotwater_update.why.takes_over (da) | Opvarmningen __time__ tager over resten… | Opvarmningen __time__ overtager resten… | "tager over resten" is not Danish. |
| da | .homeycompose/locales/da.json → autopilot.hotwater_update.why.store_more (da) | …så den gemmer mere nu. | …så den lagrer mere varme nu. | "gemme" is save/keep, not store heat. |
| da | .homeycompose/locales/da.json → autopilot.heating.status.easing_off, .preheating, autopilot.widget.hotwater.until (da) | Til __until__ / Til __time__ | Indtil __until__ / Indtil __time__ | "Til 19:00" reads as "to", not "until". |
| da | .homeycompose/locales/da.json → autopilot.heating.status_name.holding, .status.holding, .holding_even, .next_*; capabilities/autopilot_status_NIBE values.holding; flow autopilot_heating_status_is holding (da) | Holder | Holder stille | Bare "Holder" means "holds" or "stops". |
| da | .homeycompose/locales/da.json → autopilot.heating.warning.no_model, status.learning, status.learning_short, status.paused.no_model, timeline.learned, widget.learning; locales pair.setup.smart.choose_on_desc_heating (da) | Lærer dit hus / har lært dit hus | Lærer dit hus at kende / har lært dit hus at kende | Danish needs "at kende" here. |
| da | .homeycompose/locales/da.json → autopilot.widget.hotwater.solar_live (da) | …kan Autopilot stadig lade med det. | …kan Autopilot stadig varme op med det. | "lade" is battery charging. |
| da | .homeycompose/locales/da.json → autopilot.widget.charge_grid / charge_solar (da) | Netopvarmning / Solopvarmning | Fra nettet / Fra soloverskud | "Solopvarmning" means solar thermal heating. |
| da | .homeycompose/locales/da.json → autopilot.savings.middle, autopilot.savings.band_middle (da) | Midten | Mellem | Price band is "mellem", not "the middle". |
| da | .homeycompose/locales/da.json → autopilot.savings.status_heating, status_hotwater; widgets/savings, savings_hotwater name (da) | Besparelse opvarmning / Besparelse varmt vand | Besparelse på opvarmning / Besparelse på varmt vand | Missing preposition. |

#### .homeycompose/locales/de.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| de | .homeycompose/locales/de.json → connection.moved (de) | Nibe Live: Ihre Wärmepumpe ist von __from__ nach __to__ umgezogen. | Nibe Live: Die IP-Adresse Ihrer Wärmepumpe ist jetzt __to__ statt __from__. Die Geräte in Homey sind angepasst. | "umgezogen" reads as the machine physically moved. |
| de | .homeycompose/locales/de.json → autopilot.hotwater_daily.use (de) | …bis zu __p80__ L an einem intensiven Tag. | …bis zu __p80__ L an einem Tag mit viel Verbrauch. | "intensiver Tag" is a literal of "busy day". |
| de | .homeycompose/locales/de.json → autopilot.hotwater_charge.detail.pump (de) | Ihre Wärmepumpe startete bei __top__ °C nach ihrer eigenen Starttemperatur und lädt auf __stop__ °C. | Ihre Wärmepumpe hat bei __top__ °C selbst gestartet und lädt bis __stop__ °C. | Literal, clumsy "nach ihrer eigenen Starttemperatur". |
| de | .homeycompose/locales/de.json → autopilot.hotwater_charge.plan.as_planned_pump (de) | Der Plan hatte dann auch eine Ladung. | Auch der Plan sah dann eine Ladung vor. | Literal; a plan doesn't "have" a charge. |
| de | .homeycompose/locales/de.json → autopilot.hotwater_charge.recap.as_planned_pump (de) | Dann auch geplant. | War auch geplant. | Not idiomatic. |
| de | .homeycompose/locales/de.json → autopilot.heating.status.learning, learning_short, paused.no_model, warning.no_model (de) | Lernt Ihr Haus · Tag __day__ von __of__ | Lernt Ihr Haus kennen · Tag __day__ von __of__ | "ein Haus lernen" is not German; "kennenlernen". |
| de | .homeycompose/locales/de.json → autopilot.heating.timeline.learned (de) | Autopilot Heizung hat Ihr Haus gelernt und verschiebt… | Autopilot Heizung kennt Ihr Haus jetzt und verschiebt Wärme aus teuren Stunden. | Same literal. |
| de | .homeycompose/locales/de.json → autopilot.heating.status_name.holding; .homeycompose/capabilities/autopilot_status_NIBE.json values.holding; flow conditions.autopilot_heating_status_is values.holding (de) | Hält | Konstant | Bare "Hält" lacks an object; reads unfinished as a status. |
| de | .homeycompose/locales/de.json → autopilot.savings.middle, autopilot.savings.band_middle (de) | Mitte | Mittel | Price band next to Günstig/Teuer is "Mittel". |
| de | .homeycompose/locales/de.json → autopilot.widget.offset (de) | Außenverschiebung (BT1) | Verschiebung Außentemperatur (BT1) | "Außenverschiebung" is not a word; matches capability title. |

#### .homeycompose/locales/nl.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| nl | .homeycompose/locales/nl.json → connection.moved (nl) | Nibe Live: je warmtepomp is verhuisd van __from__ naar __to__. | Nibe Live: je warmtepomp heeft een nieuw adres, __to__ (was __from__). De apparaten in Homey zijn bijgewerkt. | "Verhuisd" means moved house. |
| nl | .homeycompose/locales/nl.json → autopilot.hotwater_daily.none (nl) | Geen opwarming nodig. De boiler redt de dag. | Geen opwarming nodig. De boiler heeft genoeg voor vandaag. | "Redt de dag" is a literal calque. |
| nl | .homeycompose/locales/nl.json → autopilot.hotwater_update.why.covered (nl) | De boiler redt de dag zonder. | De boiler heeft ook zonder genoeg voor vandaag. | Same calque. |
| nl | .homeycompose/locales/nl.json → autopilot.heating.status.waiting (nl) | Start: wacht op de voorspelling | Opstarten. Wacht op de weersverwachting | "Start:" reads as a command; widget says "Opstarten". |
| nl | .homeycompose/locales/nl.json → autopilot.heating.status.holding / status_name.holding (nl), autopilot_status_NIBE values.holding, Flow autopilot_heating_status_is values.holding | Houdt vast | Wacht af | "Houdt vast" means grips; meaning is waiting for a better moment. |
| nl | .homeycompose/locales/nl.json → autopilot.widget.hotwater.solar_off (nl) | Zon uit | Zonnestroom uit | "Zon uit" reads as "sun off". |
| nl | .homeycompose/locales/nl.json → autopilot.widget.hotwater.solar_paused (nl) | Zonneplan gepauzeerd | Plannen op zon gepauzeerd | Zonneplan is a well-known Dutch energy supplier. |
| nl | .homeycompose/locales/nl.json → autopilot.widget.charge_grid / charge_solar (nl) | Netopwarming / Zonopwarming | Opwarmen met netstroom / Opwarmen met zonnestroom | Coined compounds no Dutch owner uses. |
| nl | .homeycompose/locales/nl.json → autopilot.widget.error (nl) | Kon Autopilot niet laden. Over een minuut probeer ik het opnieuw. | Kon Autopilot niet laden. Over een minuut opnieuw. | Only place the app speaks as "ik". |
| nl | .homeycompose/locales/nl.json → autopilot.widget.offset (nl) | Buitenverschuiving (BT1) | Verschuiving buitentemperatuur (BT1) | Not a Dutch word; capability already uses the proposed one. |
| nl | .homeycompose/locales/nl.json + Flow + locales (21 strings) → "Autopilot verwarming …" (nl) | Autopilot verwarming gestopt / staat uit / gepauzeerd… | Autopilot voor verwarming is gestopt / staat uit / is gepauzeerd… | Telegraphic; hotwater_use.off already says "Autopilot voor warm water". |

#### .homeycompose/locales/no.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| no | .homeycompose/locales/no.json → pair.sources.prompt (no) | Flere givere kan rapportere dette. | Flere følere kan måle dette. | "givere" is Swedish (givare); Norwegian says føler. |
| no | .homeycompose/locales/no.json → pair.detect.title, pair.detect.skip (no) | Oppdager funksjoner / Hopp over oppdagelse | Finner funksjoner / Hopp over søket | "oppdagelse" means discovery as in exploration; literal. |
| no | .homeycompose/locales/no.json → autopilot.heating.warning.no_model, status.learning, status.learning_short, status.paused.no_model, timeline.learned, widget.learning; locales/no.json → pair.setup.smart.choose_on_desc_heating (no) | Lærer huset ditt / har lært huset ditt | Blir kjent med huset ditt / har blitt kjent med huset ditt | "lære" also means teach; reads as teaching your house. |
| no | .homeycompose/locales/no.json → autopilot.heating.status.peak; flow → triggers[autopilot_heating_status_changed].tokens[1].example (no) | prisene topper __from__–__to__ | prisene er høyest __from__–__to__ | "topper" is an English calque here. |
| no | .homeycompose/locales/no.json → autopilot.* (21 strings), flow titles (no) | Autopilot oppvarming stoppet. / Autopilot varmtvann trenger … | Autopilot for oppvarming stoppet. / Autopilot for varmtvann trenger … | Bare juxtaposed nouns aren't Norwegian; "for" is already used once. |

#### .homeycompose/locales/sv.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| sv | `.homeycompose/locales/sv.json → "Heating"`, `"Cooling"` (priority labels) | Värmer / Kyler | Värme / Kyla | Verbs next to nouns Varmvatten and Pool. Flow example already says "Värme". |
| sv | `.homeycompose/locales/sv.json → pair.badge.insight` | Endast insikt | Endast avläsning | "Insikt" is a literal calque. It means read-only. |
| sv | `.homeycompose/locales/sv.json → groups.electrical`, `drivers/nibe_s/driver.compose.json → …i46/i48/i50_sensor_v2.title` | Strömsensorer / Strömsensor L1 (BE1) | Strömkännare / Strömkännare L1 (BE1) | NIBE's Swedish term for BE1–BE3. |
| sv | `.homeycompose/locales/sv.json → autopilot.hotwater_charge.detail.pump` | Din värmepump startade den vid __top__ °C på sin egen starttemperatur och laddar till __stop__ °C. | Din värmepump startade själv vid __top__ °C och laddar till __stop__ °C. | "på sin egen starttemperatur" is not Swedish. |
| sv | `.homeycompose/locales/sv.json → autopilot.heating.warning.feed_failed`, `autopilot.smart.spa_took_over.*` | …uppvärmning stoppade. | …stängdes av. | "stoppade" without object reads as unfinished. |

#### driver.compose.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | driver.compose.json → target_temperature.h183/h184/h185 titles (da) | …(udemiddeltemp) | …(gns. udetemperatur) | Made-up abbreviation. |
| da | driver.compose.json + capabilities/curve_displacement_NIBE + flow h30 cards (da), 8 strings | Varmeforskydning / Varmeforskydningen | Kurveforskydning / Kurveforskydningen | "Varmeforskydning" means heat shift, not curve offset. |

#### driver.flow.compose.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | driver.flow.compose.json → triggers.alarm_occurred tokens[0].example; triggers.priority_changed tokens[2].example (da) | 438: Lost connection to wireless device / The house fell behind on heat… | 438: Mistet forbindelse til trådløs enhed / Huset mangler varme, så kompressoren starter. | English left in Danish. |

#### drivers/nibe_s/driver.compose.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| de | drivers/nibe_s/driver.compose.json → capabilitiesOptions.measure_temperature.i175_hw_comfort_heater.title (de) | Brauchwasser Komfortheizer (BT83) | Warmwasser-Komfortheizung (BT83) | "Komfortheizer" is not German. |
| nl | drivers/nibe_s/driver.compose.json → capabilitiesOptions.measure_temperature.i20_supply_air.title (nl) | Ventilatielucht (BT21) | Uitblaaslucht (BT21) | BT21 is the air blown out; "ventilatielucht" reads as supply air. |
| nl | drivers/nibe_s/driver.compose.json → settings.cumulativeEnergy.hint (nl) | …Bewerk alleen om de meterstand te corrigeren. | Wordt automatisch bijgewerkt. Pas dit alleen aan om de meterstand te corrigeren. | "Bewerk alleen om" is stiff, literal. |
| no | drivers/nibe_s/driver.compose.json → capabilitiesOptions.curve_displacement_NIBE.h30_heat_curve_displacement.title; capabilities/curve_displacement_NIBE.json title; flow h30 trigger/action/condition (8×) (no) | Varmeforskyvning | Kurveforskyvning | "Varmeforskyvning" means shifting heat, not the curve offset. |
| sv | `drivers/nibe_s/driver.compose.json → …i1102_heating_pump.title`, `…i1104_source_pump.title` (sv) | Värme-pumphastighet (GP1) / Köld-pumphastighet (GP2) | Värmebärarpump (GP1) / Köldbärarpump (GP2) | NIBE terms, already used in the register info. |
| sv | `drivers/nibe_s/driver.compose.json → …h109_returnair_normal.title` (sv) | Frånluft fläkthastighet normal | Fläkthastighet frånluft, normal | Split compound. |
| sv | `drivers/nibe_s/driver.compose.json → …h92/h66 titles`, `driver.flow.compose.json → h92/h66 .enum title, titleFormatted` (sv) | Periodiskt varmvatten längd / Ställ in periodiskt varmvatten intervall | Periodiskt varmvatten, längd / Ställ in intervall för periodiskt varmvatten | Noun string without a link reads as broken Swedish. |

#### drivers/nibe_s/driver.flow.compose.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| de | drivers/nibe_s/driver.flow.compose.json → triggers.hotwater_volume_dropped_below.title/titleFormatted (de) | Verfügbares Warmwasser fiel unter [[litres]] l | Verfügbares Warmwasser fällt unter [[litres]] L | Trigger titles use present tense in Homey German. |
| de | drivers/nibe_s/driver.flow.compose.json → triggers.autopilot_heating_status_changed.title/hint (de) | Autopilot Heizung hat gewechselt / Zum Beispiel von Halten zu Drosseln vor teuren Stunden. | Status von Autopilot Heizung ändert sich / Zum Beispiel, wenn Autopilot vor teuren Stunden zu drosseln beginnt. | "hat gewechselt" lacks what changed; nouns don't match status labels. |
| de | drivers/nibe_s/driver.flow.compose.json → triggers.priority_changed.tokens.Reason.example (de) | The house fell behind on heat: degree minutes are down to -60… | Use a German example once `drivers/nibe_s/reason.ts` has `de` (it is en/sv only, so the token is English at runtime). | English shown to German users. |
| nl | drivers/nibe_s/driver.flow.compose.json → triggers[autopilot_heating_status_changed].title (nl) | Autopilot verwarming veranderde | Status van Autopilot voor verwarming gewijzigd | Other trigger titles use "gewijzigd"; past tense reads off. |
| nl | drivers/nibe_s/driver.flow.compose.json → actions[autopilot_heating_away].title / titleFormatted (nl) | Afwezig van Autopilot verwarming instellen / Afwezig van Autopilot verwarming [[away]] | Afwezig instellen / Afwezig [[away]] zetten | "Afwezig van Autopilot verwarming aan" is not Dutch. |
| nl | drivers/nibe_s/driver.flow.compose.json → actions[hotwater_increase….enum].hint (nl) | Warm water een aantal uur verhogen, of uitzetten. | Een aantal uur extra warm water, of uit. | You can't "verhogen" water. |
| nl | drivers/nibe_s/driver.flow.compose.json → triggers[alarm_occurred].tokens[0].example, triggers[priority_changed].tokens[2].example (nl) | 438: Lost connection to wireless device / The house fell behind on heat: degree minutes… | 438: Verbinding met draadloos apparaat verbroken / Het huis kreeg te weinig warmte, dus de compressor startte. | English left in nl token examples. |
| no | drivers/nibe_s/driver.flow.compose.json → triggers[priority_changed].tokens[2].example (no) | The house fell behind on heat: degree minutes are down to -60 … | Huset ligger etter med varme: gradminuttene er nede i -60. | English left in no; reason.ts has only en/sv, so owners get English. |
| sv | `drivers/nibe_s/driver.flow.compose.json → actions.measure_minute_NIBE.h93_periodtime_heating.set.hint` (sv), `registers.ts:604` | Hur länge din värmepump gör värme innan den byter behov. | Hur länge din värmepump värmer huset innan den går över till nästa behov. | "gör värme" is a literal of "makes heating". |

#### drivers/nibe_s/registers.ts

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| sv | `drivers/nibe_s/registers.ts:202` | Varmvatten laddtemperatur (BT6) | Laddtemperatur varmvatten (BT6) | Split compound. |
| sv | `drivers/nibe_s/registers.ts:306`, `:336`, `:269` | Levererad värme till värme… | Värme levererad till uppvärmningen… | "värme till värme" is a stutter. |
| sv | `drivers/nibe_s/registers.ts:685` | …som de märker som endast värme. Observera att… "blockera tillsatsvärme" som den här inte ser… | Tillåter elpatronen för uppvärmning. Värmepumpens schemaläge kan blockera den ändå. | Literal, long. Developer framing. |

#### locales/da.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | locales/da.json → pair.setup.smart.verify_intro (da) | Autopilot tjekker, at din varmepumpe modtager dens udetemperatur. | Autopilot tjekker, at din varmepumpe modtager udetemperaturen fra Autopilot. | "dens" is ambiguous here. |
| da | locales/da.json → pair.setup.smart.ctl_range_sub (da) | Hvor meget inde må afvige | Hvor meget indetemperaturen må svinge | "inde" is not a noun. |
| da | locales/da.json → pair.setup.smart.exp_acting (da) | Handler | Aktiv | "Handler" reads as "trades/deals". |
| da | locales/da.json → pair.setup.smart.is_on, success_title (da) | Autopilot er til | Autopilot er slået til | Clipped, sounds unfinished. |
| da | locales/da.json → pair.setup.smart.mode_note, changes.autopilot_simulated (da) | …mens din varmepumpe forbliver, som den er | …mens din varmepumpe kører videre som før | Stiff, formal phrasing. |
| da | locales/da.json → pair.setup.smart.solar_live / solar_live_hint (da) | Oplad når du sælger solstrøm / Varmtvandet oplades, mens… | Opvarm, når du sælger solstrøm / Vandet varmes op, mens dit hjem sælger strøm. | "oplade" is battery charging. |
| da | locales/da.json → pair.setup.smart.solar_forecast_hint (da) | Springer en natopladning over… | Springer en natopvarmning over… | Battery word for a tank charge. |
| da | locales/da.json → pair.setup.smart.solar_need_meter (da) | Solvarme kræver en elmåler… | Opvarmning med solstrøm kræver en elmåler… | "Solvarme" means solar thermal collectors. |
| da | locales/da.json → pair.setup.smart.price_spot (da) | Kun spot | Kun spotpris | Clipped. |

#### locales/de.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| de | locales/de.json → pair.setup.smart.choose_on_desc_heating (de) | Lernt Ihr Haus und heizt dann… | Lernt Ihr Haus kennen und heizt dann vor teuren Stunden etwas mehr und währenddessen etwas weniger. | Same literal. |

#### locales/nl.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| nl | locales/nl.json → pair.setup.smart.exp_acting (nl) | Handelen | Aan de slag | "Handelen" reads as trading. |
| nl | locales/nl.json → pair.setup.smart.price_spot (nl) | Alleen spot | Alleen spotprijs | "Spot" alone is unclear in Dutch. |
| nl | locales/nl.json → pair.setup.smart.solar_evidence / solar_evidence_plain (nl) | …terug aan het net op zonnige uren. | …terug aan het net tijdens zonnige uren. | "Op zonnige uren" is not idiomatic. |
| nl | locales/nl.json → pair.setup.changes.count_detail (nl) | Wat je van je warmtepomp koos | Wat je van je warmtepomp hebt gekozen | Simple past reads clipped here. |

#### locales/no.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| no | locales/no.json → pair.setup.smart.ctl_away_sub (no) | En lavere temperatur mens du er ute | En lavere temperatur mens du er bortreist | "ute" reads as out for the day; Away is a holiday. |
| no | locales/no.json → pair.setup.smart.solar_need_meter (no) | Solvarme krever en strømmåler … | Oppvarming med solstrøm krever en strømmåler … | "Solvarme" means solar thermal collectors in Norwegian. |
| no | locales/no.json → pair.setup.smart.price_spot (no) | Bare spot | Bare spotpris | "spot" alone is unclear in Norwegian. |

#### locales/sv.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| sv | `locales/sv.json → pair.setup.smart.room_control_on` | Stäng av den, annars tar den bort det Autopilot gör. | Stäng av den, annars motverkar den Autopilot. | "tar bort" is a literal "undo". |
| sv | `locales/sv.json → pair.setup.smart.room_control_optional` | Valfritt. På låter din värmepump rätta efter rumstemperaturen. … | Valfritt. Påslagen justerar din värmepump efter rumstemperaturen. … | "På låter" doesn't parse. |
| sv | `locales/sv.json → pair.setup.smart.solar_forecast_hint` | …Lämna av om ett batteri… | …Låt den vara av om ett batteri… | "Lämna av" means "drop off". |
| sv | `locales/sv.json → pair.setup.smart.hw_tank` | Först, din beredare | Först din tank | English comma calque. |
| sv | `locales/sv.json → pair.setup.smart.price_spot` | Bara spot | Bara spotpris | "spot" alone is jargon. |
| sv | `locales/sv.json → pair.setup.smart.household_invalid` | Välj hur många som bor där och en duschtid. | Välj antal personer och en duschtid. | "där" has nothing to point at. |

### R8. One term per concept


#### .homeycompose/capabilities/hotwater_demand_NIBE.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| nl | .homeycompose/capabilities/hotwater_demand_NIBE.json values[4] vs Flow h56 hint (nl) | Smart control 3 / slimme regeling 1 | Smart control | Same demand mode, two names. |

#### .homeycompose/locales/da.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | .homeycompose/locales/da.json → autopilot.hotwater_charge.blocked.spa (da) | Slå Smart pristilpasning for varmt vand fra… | Slå Smart price adaption for varmt vand fra på din varmepumpe. | Owner must find this name on the display. |
| da | .homeycompose/locales/da.json → autopilot.widget.not_function, autopilot.hotwater_use.pick, autopilot.savings.pick* ; hotwater_status.learning vs hotwater_use.learning (da) | Vælg en Opvarmnings- eller Varmtvandsenhed. / Vælg en varmtvandsenhed. / Vælg en enhed for Opvarmning… ; "Lærer jeres forbrug" vs "Lærer dit varmtvandsforbrug" | Vælg enheden Opvarmning eller Varmt vand. ; Lærer dit forbrug af varmt vand | Same message phrased three ways; "jeres" vs "dit". |

#### .homeycompose/locales/de.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| de | .homeycompose/locales/de.json → "Immersion heater only" vs .homeycompose/capabilities/operating_mode_NIBE.json values.2 (de) | Nur Heizstab / Nur Zusatzheizung | Nur Zusatzheizung | Same operating mode, two labels. |
| de | .homeycompose/locales/de.json → autopilot.hotwater_daily.reason.before_use vs hotwater_charge/hotwater_update.reason.before_use (de) | Rechtzeitig vor dem Verbrauch / Rechtzeitig für den Verbrauch | Rechtzeitig vor dem Verbrauch | Same reason pill, two wordings. |

#### .homeycompose/locales/nl.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| nl | .homeycompose/locales/nl.json → "Hot water", groups.hotwater (nl) | Warmtapwater | Warm water | Group label differs from "Warm water instellen" and "apparaat Warm water". |
| nl | .homeycompose/locales/nl.json → "Immersion heater only" vs .homeycompose/capabilities/operating_mode_NIBE.json values[2] (nl) | Alleen elektrisch element / Alleen bijverwarming | Alleen bijverwarming | Same mode value, two names. |
| nl | .homeycompose/locales/nl.json → pair.features.insights_note vs autopilot.savings.loading (nl) | Insights / Inzichten | Inzichten | Homey's Dutch name for Insights. |

#### driver.compose.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | driver.compose.json + flow → boolean_NIBE.h697_more_hotwater (da) | Mere varmtvand (title + Flow card) | Mere varmt vand | Setup text (pair.setup.smart.hw_flows) names "Mere varmt vand". |
| da | driver.compose.json → measure_temperature.title (da) | Indendørstemperatur | Indetemperatur | 9× "indetemperatur" elsewhere. |
| de | driver.compose.json → meter_power.total.title / settings.cumulativeEnergy vs meter_kwh_NIBE.i3823_total_consumption.title (de) | Gesamter Energieverbrauch / Verbrauchte Gesamtenergie | Gesamter Energieverbrauch | Same EN title, two German ones. |
| de | driver.compose.json → capabilitiesOptions.measure_temperature.title (de) | Raumtemperatur | Innentemperatur | EN "Indoor temperature" is Innentemperatur in 9 other strings. |
| no | driver.compose.json + flow (no): demand sizes | Lite, Medium | Liten, Middels | The picker says Liten, Middels, Stor. |

#### driver.flow.compose.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | driver.flow.compose.json → actions.autopilot_heating_away.hint (da) | …holder kun sin sikkerhedsmargin. | …holder kun sit sikkerhedsniveau. | 6× "sikkerhedsniveau" elsewhere. |
| da | driver.flow.compose.json → actions.autopilot_heating_set_profile values.save_most (da) | Hellere fryse (±6 °C) | Spar mere (±6 °C) | Hint and capability say "Spar mere" (en too). |
| de | driver.flow.compose.json → hotwater_demand_NIBE.h56_hotwater_demand_mode.enum.hint (action, condition) (de) | Klein, mittel, groß oder intelligente Steuerung. | Klein, Mittel, Groß oder Smart Control. | Mode is "Smart Control" in the picker and Autopilot text. |

#### drivers/nibe_s/driver.compose.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| nl | drivers/nibe_s/driver.compose.json + Flow h59/h63 titles (nl) | Warmtapwater start (Medium), …(Medium) ×6 | (Gemiddeld) | Klein/Groot are translated; enum says "Gemiddeld". |

#### drivers/nibe_s/driver.flow.compose.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| nl | drivers/nibe_s/driver.flow.compose.json → actions[autopilot_heating_set_profile].values[save_most].label (nl) | Liever kou lijden (±6 °C) | Meer besparen (±6 °C) | Capability and hint call it "Meer besparen". |
| no | drivers/nibe_s/driver.flow.compose.json → autopilot_heating_set_profile values[save_most] (no) | Heller fryse (±6 °C) | Spar mer (±6 °C) | Capability and hint say "Spar mer". |

#### lib/release-announcements.ts

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| no | lib/release-announcements.ts:30 (no) | Kjør Reparer på Nibe Varme-enheten din | Keep, once roleNames has "Nibe Varme" | Today the tile is called "Nibe Heating". |

#### lib/roles.ts

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| no | lib/roles.ts → roleNames (no missing) vs no copy | Device is named "Nibe Heating" / "Nibe Hot Water"; copy says "Oppvarming" (10×), "Varme" (pending_hint, changelog, announcement), "Varmtvann-enheten" | Add no role names (Nibe Varme, Nibe Varmtvann, Nibe Basseng, Nibe Kjøling, Nibe Sol) and say "Varme" in every reference | Copy names devices Norwegian owners don't have. |

#### locales/de.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| de | locales/de.json → pair.setup.smart.hw_flows, hw_flows_unknown vs driver.compose.json → boolean_NIBE.h697_more_hotwater.title (de) | Flows, die Mehr Warmwasser einschalten / capability "Mehr Brauchwasser" | Mehr Warmwasser (in both) | Setup quotes a card name that doesn't exist in German. |
| de | locales/de.json → pair.setup.source_cs1 vs flow h34/h38 hints (de) | Klimasystem 1 / Klimatisierungssystem 1 | Klimatisierungssystem 1 | NIBE German term; keep one. |
| de | locales/de.json → pair.setup.active_note, pair.setup.smart.saved_setup, summary_intro (de) | Heizungseinrichtung | Heizung einrichten (the on-screen name, pair.setup.heating) | Screen named one way, referred to another. |

#### locales/no.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| no | locales/no.json → pair.setup.nibe, pending_hint, pump_enable, enable_detail, active_note, return_nibe, handover_hint, feed_recovery, control_detail, smart.indoor_pump (no) | romsensor BT50 / NIBE-sensoren / temperatursensor | romføler BT50 / NIBE-føleren / temperaturføler | Pump sensors are "føler" elsewhere (romføler, strømføler). |

#### Across files

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | all da: Smart price adaption | "Smart pristilpasning"/"smart pristilpasning" 22×, "Smart price adaption" 8×, "Smart Price Adaption" 1×, "Smart pris" 1× | Smart price adaption everywhere | NIBE's on-screen name; CLAUDE.md quotes it as is. |
| da | all da: hot water | "varmt vand" 67×, standalone "varmtvand"/"Varmtvand" ~10× (groups.hotwater, key Hot water, Periodisk varmtvand, flow hints, token example) | "varmt vand" standalone, "varmtvands-" only in compounds | Two spellings of the same thing. |
| da | all da: heating device/function | "Varme" (groups.heating, key Heating, pending_hint "Varme → Reparer", thermostat_zone_review, changelog, announcement) vs "Opvarmning" (5 device refs) | Opvarmning | Two names for one device. |
| da | all da: tank | "tank/tanken" 22×, "beholder/beholderen" 14× | beholder | Pairing uses "Varmtvandsbeholder"; standard Danish term. |
| da | all da: immersion heater | "elpatron" 10×, "tilskudsvarme" 13×, "eltilskud" 1× | elpatron | en uses one term, immersion heater. |
| da | all da: Away | "Fraværende" 5×, "Bortrejst" 5×, "Væk" 2× | Bortrejst | Away means a holiday; one word. |
| da | all da: a hot water charge | "opvarmning" ~70×, "opladning/oplad/lade" 6× (incl. hotwater.cal_waiting, cal_done) | opvarmning | Battery word mixed in. |
| da | all da: sensor vs føler | Heat pump sensors called "sensor" in pending_hint, active_note, return_nibe, handover_hint, handover_confirm, feed_recovery, control_detail, indoor_pump; Homey sensor called "føler" in autopilot.widget.paused.no_outdoor | "føler" for the heat pump's, "sensor" for Homey's | Owners match "føler" to NIBE's display. |
| da | all da: solar surplus | "soloverskud" 5×, "solcelleoverskud" 3×, "fra sol"/"fra solstrøm" 3× | soloverskud | Three words for one reason pill. |
| da | all da: operating mode | "Driftsindstilling" 7×, "Driftstilstand" 1× (capability type) | Driftstilstand | One term; usual Danish for operating mode. |
| da | all da: Autopilot per function | "Autopilot opvarmning" 21×, "Autopilot varmt vand" 3×, "Autopilot for varmt vand" 1× | Autopilot for opvarmning / Autopilot for varmt vand | Bare juxtaposition is English word order. |
| de | all de: hot water | Brauchwasser 49 strings (capability titles, Flow cards, groups.hotwater, top-level "Hot water", "Mehr Brauchwasser") vs Warmwasser 63 (Autopilot, devices, widgets, setup) | Warmwasser everywhere | Two words for one thing, often on the same screen. |
| de | all de: immersion heater | Zusatzheizung 13, Heizstab 10, Elektroheizstab 1 | Zusatzheizung | One EN term ("immersion heater"), three German ones. |
| de | all de: Smart price adaption | Smart Price Adaption 20, Smart price adaption 8, Smarte Preisanpassung 3 (pair.setup.smart.choose_spa, cmp_note, autopilot.hotwater_charge.blocked.spa), Smarter Preis 1 (pair.setup.smart.col_spa) | Smart Price Adaption | NIBE's own name; translated forms aren't on the display. |
| de | all de: room sensor | Raumfühler 18 vs Raumsensor 3 (pair.setup.pump_enable, pair.setup.enable_detail, pair.setup.pump_zone) | Raumfühler | NIBE German term, used everywhere else. |
| de | all de: forecast | Prognose 3 (autopilot.heating.status.waiting, autopilot.widget.paused.no_outdoor, autopilot.widget.starting_heating) vs (Wetter)vorhersage 6 | Wettervorhersage | Two words for the same weather input. |
| de | all de: litre unit | "l" 3 (flow hotwater_volume_* titleFormatted, measure_volume_NIBE units) vs "L" in all others | L | Unit differs between Flow cards and widgets. |
| de | de: thermostat gender | der Thermostat 2 (pair.setup.thermostat_zone_*), das Thermostat 2 (pair.setup.smart.success_description, flow autopilot_heating_away.hint) | der Thermostat | Both correct, but pick one. |
| de | de: Heating device | Gerät Heizung 2, Heizungsgerät 2, Gerät für Heizung 2; Main-Gerät 2 vs Nibe Main 1 | Gerät Heizung, Gerät Main | Inconsistent device references. |
| nl | all nl files → hot water | warmtapwater 70, warm water 41 (+warme 2), warmwater- compounds 11 | warm water, compounds "warmwater…" | Owner word; setup already says "Warm water instellen". |
| nl | all nl files → tank | boiler 32, tank 2 ("Tanktemperatuur", Flow h59/h63 hints) | boiler | One word for the tank. |
| nl | all nl files → immersion heater | bijverwarming 12, elektrisch(e) element 7, "het element" 2 | bijverwarming | What the NIBE display calls it. |
| nl | all nl files → Repair | Repareren 5, Herstellen 3 (pair.setup.pending_hint, pair.setup.feed_short, autopilot.hotwater_setting.no_tank) | Repareren | Homey's own Dutch label. |
| nl | all nl files → Smart price adaption | Smart Price Adaption 14, Smart price adaption 8, Slimme prijsaanpassing 3, Slimme prijs 1 | Smart price adaption | One on-screen name, sentence case. |
| nl | all nl files → Simulated | Simulatie 9, Gesimuleerd 3 | Gesimuleerd | Smart mode shows "Autopilot · Gesimuleerd". |
| nl | all nl files → the device tiles | apparaat Verwarming 2, apparaat voor Verwarming 2, verwarmingsapparaat 2; apparaat Warm water/warmwaterapparaat 2/Warm water-apparaat 2 | het apparaat Verwarming / het apparaat Warm water | Quote the tile name one way. |
| nl | all nl files → charge | opwarming/opwarmen 29, laad-/lading/laden ~15, opwarmbeurten 1, laadbeurten 1, laadcycli 1 | opwarming / opwarmen | Owner copy mixes "laden" and "opwarmen" for one action. |
| nl | all nl files → safety net | veiligheidsmarge 6, reserve 1 (Flow autopilot_heating_away hint), buffer 1 (hw_reserve_hint) | veiligheidsmarge | One name for the minimum. |
| nl | all nl files → room sensor | ruimtesensor 10, kamersensor 2 (pump_enable, enable_detail), ruimtevoeler 8 (only in "ruimtevoelerregeling") | ruimtesensor (keep ruimtevoelerregeling) | BT50 is called two things. |
| nl | all nl files → operating mode | Bedrijfsstand 7, Bedrijfsmodus 1 (operating_mode_NIBE title) | Bedrijfsstand | Capability title differs from the instance title. |
| nl | all nl files → runtime | Bedrijfstijd 4, Draaiuren 2 (i1069, i279) | Bedrijfstijd | Same measure, two names on sibling devices. |
| nl | all nl units → litres | "l" 3 (Flow hotwater_volume titleFormatted ×2, measure_volume_NIBE units), "L" 15 | L | Mixed unit symbol. |
| nl | Flow triggers hints (nl) | Wordt geactiveerd wanneer 7, Gaat af wanneer 2 | Gaat af wanneer | Shorter, natural; pick one. |
| no | all no files: Smart price adaption | Smart pristilpasning 15, smart pristilpasning 7, Smart price adaption 8, Smart Price Adaption 1 | Smart pristilpasning everywhere (or the exact Norwegian pump display name) | Four spellings of one NIBE feature. |
| no | all no files: tank | tank/tanken 22, bereder/berederen 12 | bereder | "bereder" is the Norwegian word; both appear on one screen. |
| no | all no files: hot water charge | lading/lader/lades 18, oppvarming 17 | oppvarming (keep "Varmtvannslading (BT6)" as NIBE's sensor name) | "lading" reads as EV or battery charging. |
| no | all no files: immersion heater | elkolbe 11, tilleggsvarme 13 | elkolbe | en says immersion heater; "Kun elkolbe" vs "Kun tilleggsvarme" for one mode. |
| no | all no files: Away | Borte 8, Bortreist 5 | Bortreist | Same setting, two names; "bortreist" says holiday. |
| no | all no files: Flow | Flyter/Flytene/flytkort 3, Flow/Flow-kort 4 | Flow, Flow-kort | Homey keeps the name Flow in Norwegian. |
| no | all no files: Insights | Insights-historikken 1, Innsikt 1 | Match Homey's Norwegian app (one of them) | Two names for one Homey feature. |
| no | all no files: room-sensor control | Romføler-styring 7, Romfølerregulering 1 | romfølerstyring | Hyphenated compound and two names. |
| no | all no files: solar surplus | soloverskudd 5, solkraftoverskudd 3, fra sol 1, solstrøm 4 | soloverskudd (surplus), solstrøm (power) | Three words for the same surplus. |
| no | all no files: boost | heving/Engangsheving 7, økning/Engangsøkning 3 | Engangsøkning, varmtvannsøkning | Same picker value named two ways. |
| no | all no files: safety net | sikkerhetsnivå 6, sikkerhetsmarginen 1, minimumet 1 | sikkerhetsnivå | One setting, three names. |
| no | flow titles (no), measure_volume_NIBE units (no) | [[litres]] l / units l | [[litres]] L | Every other no string uses capital L. |
| sv | Heating device name: `.homeycompose/locales/sv.json → autopilot.heating.warning.feed_failed`, `verify.not_heating`, `no_thermostat`, `smart.no_heating`, `smart.verify_first`, `widget.not_function`, `savings.pick`, `savings.pick_heating`; `locales/sv.json → pair.setup.smart.success_description`, `smart.indoor_missing` | Uppvärmning (14 uses as the device) | Värme ("enheten Värme", "Värme → Reparera") | Device is "Nibe Värme" (lib/roles.ts). Värme used 3 times plus changelog. |
| sv | Device references: `autopilot.widget.not_function`, `hotwater_use.pick`, `hotwater_setting.no_device`, `savings.pick*` | Uppvärmnings- eller Varmvattenenhet / varmvattenenhet / Varmvatten-enheten / en enhet för Varmvatten | enheten Värme / enheten Varmvatten | Five patterns for one idea. |
| sv | Feature name, 25 strings across `.homeycompose/locales/sv.json` and flow cards | Autopilot uppvärmning (21) / Autopilot varmvatten (3) / Autopilot för varmvatten (1) | Autopilot för uppvärmning / Autopilot för varmvatten | Bare juxtaposition is not a Swedish sentence subject. |
| sv | Tank: `pair.tank.title`, `tank.custom`, `tank.litres`, `hotwater_setting.no_tank`, `pair.setup.smart.hw_tank*`, `changes.tank`, `hotwater.cal_*`, flow volume hints | tank (23) / beredare (12) | tank (product title may stay "Varmvattenberedare") | Autopilot status and widgets all say "tanken". |
| sv | Immersion heater: registers info, flow `operating_mode` hints, `.homeycompose/locales/sv.json → "Immersion heater only"` | elpatron (27) / tillsats, eltillsats, tillsatsvärme (12) | elpatron in owner text; "Endast tillsats" only as the operating mode label | Mode label says "Endast elpatron" here, "Endast tillsats" in the capability and the trigger hint. |
| sv | Smart price adaption: `driver.compose.json` h843/h844/h846/h849 titles, flow h843–h849 cards and spa hints, `blocked.spa`, `pair.setup.smart.choose_spa`, `cmp_note`, `registers.ts:416, 450, 487, 493` | Smart prisanpassning / smart prisanpassning (26) / Smart price adaption (8) / Smart Price Adaption (1) / Smart pris (1) | Smart price adaption | One name, matching the menu on the pump. Confirm on a Swedish display. |
| sv | Hot water demand values: `hotwater_demand_NIBE.json`, `blocked.smart_control`, flow h56 hints | Smart kontrol (2) / Smart kontroll (1) / smart styrning (2); Litet/Medel/Stort vs Liten, medel, stor | Smart control; Litet, Medel, Stort | Must match the display menu the owner changes. |
| sv | Away: `day_type_NIBE.json → values.away`, flow `set_day_type`, `hotwater_daily.title.away`, `hotwater_daily.away` vs `widget.away`, `hotwater_use.away`, `expected_away`, `ctl_away`, `success_description`, flow `autopilot_heating_away` | Bortrest (5) / Borta (9) | Bortrest | Holiday meaning. "Borta" invites presence-based use. |
| sv | Safety net: `hotwater_daily.*`, `hotwater_charge.reason.reserve`, flow `autopilot_heating_away.hint`, `hotwater_use.away_keeps` | säkerhetsnivå (6) / säkerhetsmarginal (1) / miniminivå (1) | säkerhetsnivå | One word for one setting. |
| sv | Sensor: `pair.setup.selected_sensors`, `smart.indoor_homey`, `smart.indoor_pump`, `smart.change_sensors`, `smart.indoor_homey_desc`, `smart.indoor_bt50_note` | sensor (6) / givare (54) | givare | NIBE says givare. |
| sv | Outdoor temperature: flow `external_temperature.h5217_bt1.set` title, titleFormatted; `registers.ts:78` | utomhustemperatur (3) / utetemperatur (37) | utetemperatur | One term. |
| sv | Today: `pair.setup.smart.hw_daytype_*`, `hotwater_daily.use` | idag (3) / i dag (5) | i dag | Mixed in neighbouring strings. |
| sv | Formality: `autopilot.hotwater_status.learning`, `pair.setup.smart.hw_household` | er varmvattenanvändning / Ert hushåll | din varmvattenanvändning / Ditt hushåll | Everything else says du. hotwater_use.learning already says "din". |
| sv | Litre symbol: flow `hotwater_volume_dropped_below.titleFormatted`, `hotwater_volume_below.titleFormatted`, `measure_volume_NIBE.json → units` | l (4) | L (138 elsewhere) | Same unit, two symbols. |
| sv | Supply/return: `driver.compose.json → i5_heating_supply.title`, `i7_heating_return.title` | Framledningstemp. (BT2) / Returledningstemp. (BT3) | Framledning (BT2) / Returledning (BT3) | Matches "Framledning (BT12)". |
| sv | Solar share: `autopilot.widget.hotwater.share` | från solen | från solel | `hotwater_daily.reason.surplus` says "från solel". |
| sv | In time for use: `hotwater_daily.reason.before_use` vs `hotwater_charge`/`hotwater_update.reason.before_use` | I tid till förbrukningen / I tid för förbrukningen | I tid till förbrukningen | Same English, two Swedish forms. |
| sv | Prices: `locales/sv.json → pair.setup.smart.prices_fixed` | rörliga priser (1) | dynamiska elpriser (2) | Matches Homey Energy wording elsewhere. |
| sv | Insights: `pair.features.insights_note` vs `autopilot.savings.loading` | Insights-historiken / Insikter | One form, whichever Homey's Swedish app shows | Same Homey feature, two names. |
| sv | Flow: `pair.setup.smart.hw_flows*` vs `hw_daytype_*`, `analytics_details` | flöden (5) / Flow (4) | One form, whichever Homey's Swedish app shows | Same Homey feature, two names. |
| sv | Reason token: flow `priority_changed` vs `hotwater_charge_started`, `autopilot_heating_status_changed` | Orsak (1) / Anledning (3) | Orsak | Same token concept. |
| sv | Priority: flow `measure_enum_NIBE.i1028_priority.enum`, `priority_changed` tokens, `measure_priority_NIBE.json` | Prioritet (4) / Prioritering (5) / Driftprioritering (4) | Driftprioritering | NIBE's term, used on the capability title. |
| sv | Genitive: `pair.setup.smart.cmp_note`, `choose_spa_desc`, `registers.ts:127`, `:685` | NIBEs / NIBE:s / Nibes | NIBEs | Three spellings of one name. |

### R9. Should be a better UI or visual


#### .homeycompose/locales/sv.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| sv | `.homeycompose/locales/sv.json → autopilot.hotwater_charge.detail.pump` | …startade den vid __top__ °C på sin egen starttemperatur och laddar till __stop__ °C. | Show start and stop temperatures as two values on the charge row. | The sentence exists to explain two numbers. |

#### drivers/nibe_s/driver.flow.compose.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| de | drivers/nibe_s/driver.flow.compose.json → actions.external_temperature.h5217_bt1.set.hint (de) | Three sentences on menu, refresh and what success means | One line plus a link to the Autopilot heating help page | Card hint carries setup instructions. |
| de | drivers/nibe_s/driver.flow.compose.json → actions.set_numeric_value.hint (de) | Three sentences on the escape hatch | One line; the card is deprecated and hidden from new Flows | Long hint on a card new users never see. |

#### drivers/nibe_s/registers.ts

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| sv | `drivers/nibe_s/registers.ts:685` | Long paragraph on Nibe's addition permit and schedule blocking | One-line info, caveat moved to the help page. | Edge-case reasoning in a feature-list line. |

#### locales/da.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| da | locales/da.json → hotwater.cal_waiting (da) | Registrerede opladninger indtil nu: __CYCLES__. Der skal bruges to… | Show a progress line, "__CYCLES__ af 2 opvarmninger målt". | A sentence explains what a counter could show. |
| da | locales/da.json → pair.setup.smart.indoor_bt50_note (da) | Dine Homey-sensorer sendes fortsat… (4 sentences) | Show a "BT50 · kun visning" tag on the sensor row and drop the note. | Four-sentence hint explains a state a badge shows. |

#### locales/de.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| de | locales/de.json → pair.setup.smart.indoor_bt50_note (de) | Three sentences on BT50, sensor fault and room-sensor control | Show a small row "Homey-Sensoren → BT50 · nur Anzeige" in the checklist instead | Mechanism explained in prose a visual can carry. |
| de | locales/de.json → pair.setup.smart.hw_reserve_hint (de) | …Ein größerer Puffer heißt ab und zu eine Ladung zu einer teureren Stunde. | Drop the second sentence; the 20/40/60 L options already explain it. | Options already say what the hint says. |

#### locales/nl.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| nl | locales/nl.json → hotwater.cal_waiting (nl) | Tot nu toe vastgelegde laadcycli: __CYCLES__. Er zijn er twee nodig die de boiler verschillend opwarmen. | Show progress instead: "Kalibreren · 1 van 2 opwarmingen". | A counter explains itself. |
| nl | locales/nl.json → pair.setup.smart.indoor_bt50_note (nl) | (three-sentence BT50 note) | Show a status row "BT50 · alleen weergave" next to the sensor list. | Explaining BT50 relay in prose means the UI hides it. |

#### locales/no.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| no | locales/no.json → pair.setup.smart.indoor_bt50_note (no) | Homey-sensorene dine sendes fortsatt til varmepumpen som BT50, så den melder ingen følerfeil. Med romføler-styringen av viser den dem bare. Autopilot regulerer. | Show a checklist row "BT50 · bare visning" with a check mark. | Three sentences explain a state a row can show. |
| no | locales/no.json → pair.setup.smart.mode_note (no) | Live styrer varmepumpen din. Simulert planlegger alt og viser hva den ville gjort, … | Put one short line under each option, "Styrer varmepumpen" and "Bare plan". | A note explains two options that can label themselves. |

#### locales/sv.json

| Lang | Where | Current | Proposed | Why |
|---|---|---|---|---|
| sv | `locales/sv.json → pair.setup.smart.indoor_bt50_note` | Dina Homey-sensorer skickas fortsatt till din värmepump som BT50, så den visar inget givarfel. Med rumsgivarstyrningen avstängd visar den dem bara. … | Show a "Visas bara" pill on the BT50 row in the checklist. | Three sentences explain a state a pill can show. |
