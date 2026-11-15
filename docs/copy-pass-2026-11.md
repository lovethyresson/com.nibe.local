# English copy pass, November 2026

What changed in the English text on 2026-11-15, one row per string. The maintainer chose to keep the
existing wording and sentence form, cut what was wordy, and phrase each line the way mainstream software
does (see [voice.md](voice.md)). The other five languages still carry the old meaning in a few places, so
this list is where the translation pass starts.

Corrections after the agents ran: `roleNames` keeps "Nibe Hot Water" and the hot water floor keeps "Autopilot keeps at least" and "your minimum" (both undecided). "You’re all set" has no full stop, and the room-sensor line reads "This is on in your heat pump. Turn it off to enable Autopilot."

## Status lines, timeline, errors

## .homeycompose/locales/en.json (73 strings)

| key or location | before | after |
|---|---|---|
| .homeycompose/locales/en.json → pair.detect.no_data | Something answers at this address, but it returns no NIBE data. Check the IP is your heat pump's own and that Modbus TCP is on (menu 7.5.9). | No NIBE data at this address. Check the IP address and that Modbus TCP is on (menu 7.5.9). |
| .homeycompose/locales/en.json → pair.detect.retry | Retry | Try again |
| .homeycompose/locales/en.json → pair.features.intro | Choose what to show. We've ticked what your heat pump reported. | Choose what to show. Ticked items have data from your heat pump. |
| .homeycompose/locales/en.json → pair.features.insights_note | Disabling a feature removes its capabilities, including their Insights history. | Turning off a feature also deletes its Insights history. |
| .homeycompose/locales/en.json → pair.sources.prompt | More than one sensor can report this. Pick the one that should regulate: | More than one sensor can report this. Choose the one to use: |
| .homeycompose/locales/en.json → pair.devices.intro | Your heat pump does several jobs. Each gets its own device in Homey. We ticked the ones with live data. | Each function of your heat pump gets its own device in Homey. Ticked devices have live data. |
| .homeycompose/locales/en.json → pair.devices.analytics_desc | Helps the app author see which models and features are actually used, and where setup fails. No personal data, no readings from your home, no network details. You can change this later under app settings. | Helps the developer see which models and features are used and where setup fails. No personal data, readings or network details are sent. You can change this later in the app settings. |
| .homeycompose/locales/en.json → pair.discover.searching | Searching your network for Nibe heat pumps… | Searching your network for NIBE heat pumps… |
| .homeycompose/locales/en.json → pair.discover.confirm | Found your heat pump — tap to confirm | Heat pump found. Tap to confirm. |
| .homeycompose/locales/en.json → pair.discover.none_found | No heat pump found automatically. Check that Modbus TCP is enabled on your heat pump (menu 7.5.9) or enter its IP address below. | No heat pump found. Check that Modbus TCP is on (menu 7.5.9), or enter the IP address below. |
| .homeycompose/locales/en.json → pair.discover.pump | Nibe heat pump | NIBE heat pump |
| .homeycompose/locales/en.json → pair.tank.hint | Needed for the hot water estimate. Pick your tank's series, like VPB. The lining doesn't matter. | Required for the hot water estimate. Choose your tank's series, such as VPB. The lining doesn't matter. |
| .homeycompose/locales/en.json → pair.gateway.type | Register addressing | Address format |
| .homeycompose/locales/en.json → pair.gateway.hint | Pick how your gateway numbers NIBE register 40025. Not sure? Ask whoever set it up. | Choose how your gateway numbers NIBE Modbus address 40025. Not sure? Ask whoever set it up. |
| .homeycompose/locales/en.json → pair.gateway.detect_intro | Checking the values your heat pump reports. Depending on the gateway, this can take several minutes. | Checking the values your heat pump reports. This may take a few minutes, depending on the gateway. |
| .homeycompose/locales/en.json → pair.firmware.intro | Many features need recent software on your heat pump. Older versions miss readings the app relies on and can even report wrong energy figures. | Many features require recent software on your heat pump. Older versions lack some readings and can report wrong energy figures. |
| .homeycompose/locales/en.json → pair.firmware.online_body | When an update is waiting, approve it in the myUplink app — or on your heat pump's display: swipe to the product overview and tap Update. | When an update is available, approve it in the myUplink app or on your heat pump's display. Swipe to the product overview and tap Update. |
| .homeycompose/locales/en.json → pair.firmware.f_body | The steps differ between models — your heat pump's manual shows how. | The steps differ between models. See your heat pump's manual. |
| .homeycompose/locales/en.json → pair.firmware.note | Takes a few minutes. Your settings are kept. | This takes a few minutes. Your settings are kept. |
| .homeycompose/locales/en.json → groups.solar | Solar / PV | Solar |
| .homeycompose/locales/en.json → connection.refused | Your heat pump at __host__ refused the connection. Check that Modbus TCP is enabled on it. | Your heat pump at __host__ refused the connection. Check that Modbus TCP is on (menu 7.5.9). |
| .homeycompose/locales/en.json → connection.silent | Your heat pump at __host__ stopped answering. Reconnecting… | Your heat pump at __host__ stopped responding. Reconnecting… |
| .homeycompose/locales/en.json → connection.no_data | Something at __host__ answers, but returns no NIBE data. Check the IP is your heat pump's own and that Modbus TCP is on (menu 7.5.9). | No NIBE data at __host__. Check the IP address and that Modbus TCP is on (menu 7.5.9). |
| .homeycompose/locales/en.json → connection.moved | Nibe Live: your heat pump moved from __from__ to __to__. Its Homey devices have been updated. | Nibe Live: your heat pump's IP address changed from __from__ to __to__. Its devices have been updated. |
| .homeycompose/locales/en.json → autopilot.hotwater_daily.none | No charge needed. The tank covers the day. | No charge needed today. |
| .homeycompose/locales/en.json → autopilot.hotwater_daily.shadow | Simulation: your heat pump stays as it is. | Simulated. No changes made to your heat pump. |
| .homeycompose/locales/en.json → autopilot.hotwater_charge.detail.price | To __target__ °C in about __duration__, at __price__/kWh. The day averages __mean__. | To __target__ °C in about __duration__, at __price__/kWh. Today's average: __mean__. |
| .homeycompose/locales/en.json → autopilot.hotwater_charge.detail.pump | Your heat pump started it at __top__ °C on its own start temperature and runs to __stop__ °C. | Started by your heat pump at __top__ °C. Runs to __stop__ °C. |
| .homeycompose/locales/en.json → autopilot.hotwater_charge.plan.moved | Changed: the plan had it at __time__. | Moved from __time__. |
| .homeycompose/locales/en.json → autopilot.hotwater_charge.plan.unplanned | Not in the plan. | Not planned. |
| .homeycompose/locales/en.json → autopilot.hotwater_charge.plan.as_planned_pump | The plan had a charge then too. | A charge was planned then too. |
| .homeycompose/locales/en.json → autopilot.hotwater_charge.title_would | Simulation: would start a charge · __reason__ | Simulated: would start a charge · __reason__ |
| .homeycompose/locales/en.json → autopilot.hotwater_update.title.new_prices | New prices are in. Hot water plan updated. | Hot water plan updated with new prices. |
| .homeycompose/locales/en.json → autopilot.hotwater_update.title.revised | Prices changed. Hot water plan updated. | Hot water plan updated after a price change. |
| .homeycompose/locales/en.json → autopilot.hotwater_update.added | Added: __time__, to __target__ °C at __price__/kWh (__reason__). | New charge __time__: __target__ °C at __price__/kWh (__reason__). |
| .homeycompose/locales/en.json → autopilot.hotwater_update.added_new_hours | Added: __time__, to __target__ °C at __price__/kWh (__reason__), in hours that now have prices. | New charge __time__: __target__ °C at __price__/kWh (__reason__), in newly priced hours. |
| .homeycompose/locales/en.json → autopilot.hotwater_update.moved | Moved from __was__ to __time__: to __target__ °C at __price__/kWh instead of __wasPrice__. | Charge moved from __was__ to __time__: __target__ °C at __price__/kWh instead of __wasPrice__. |
| .homeycompose/locales/en.json → autopilot.hotwater_update.dropped | The __time__ charge is gone. __why__ | Charge cancelled for __time__. __why__ |
| .homeycompose/locales/en.json → autopilot.hotwater_update.resized | Changed: __time__ now to __target__ °C instead of __was__ °C. __why__ | Charge changed for __time__: __target__ °C instead of __was__ °C. __why__ |
| .homeycompose/locales/en.json → autopilot.hotwater_update.why.covered | The tank covers the day without it. | Not needed. |
| .homeycompose/locales/en.json → autopilot.hotwater_update.why.store_more | The hours ahead cost more, so it stores more now. | Later hours cost more. |
| .homeycompose/locales/en.json → autopilot.hotwater_update.why.needs_less | It needs less now. | Less hot water needed. |
| .homeycompose/locales/en.json → autopilot.hotwater_update.shadow | Simulation: your heat pump stays as it is. | Simulated. No changes made to your heat pump. |
| .homeycompose/locales/en.json → autopilot.hotwater_update.moved_repriced | Moved from __was__ to __time__: the __was__ hours now cost __wasNow__/kWh instead of __wasPrice__, so it charges to __target__ °C at __price__/kWh. | Charge moved from __was__ to __time__: __was__ now costs __wasNow__/kWh instead of __wasPrice__. Charging to __target__ °C at __price__/kWh. |
| .homeycompose/locales/en.json → autopilot.hotwater_setting.no_device | Autopilot hot water needs the Hot water device. Add it first. | Autopilot for hot water requires the Hot water device. Add it first. |
| .homeycompose/locales/en.json → autopilot.hotwater_setting.no_tank | Pick your tank size first: Hot water device → Repair. | Choose your tank size first in Hot water → Repair. |
| .homeycompose/locales/en.json → autopilot.heating.status.test | Simulation: __text__ | Simulated: __text__ |
| .homeycompose/locales/en.json → autopilot.heating.status.holding | Holding. Nothing to gain from shifting now | Holding. No changes planned |
| .homeycompose/locales/en.json → autopilot.heating.status.paused.no_outdoor | Paused: outdoor temperature stopped reporting | Paused: no outdoor temperature |
| .homeycompose/locales/en.json → autopilot.heating.status.range_off | Comfort range is Off: your heat pump sees the real outdoor temperature | Comfort range is Off. Your heat pump uses the measured outdoor temperature |
| .homeycompose/locales/en.json → autopilot.heating.verify.no_outdoor | No outdoor temperature yet: choose a sensor or set your location for the weather forecast. | No outdoor temperature yet. Choose a sensor or set your location for the weather forecast. |
| .homeycompose/locales/en.json → autopilot.heating.not_on | Autopilot heating is not on. | Autopilot heating is off. |
| .homeycompose/locales/en.json → autopilot.smart.verify_first | Turn Autopilot on in Heating → Repair → Smart mode: it checks your heat pump takes the outdoor temperature first. | Turn on Autopilot in Heating → Repair → Smart mode first. This checks that your heat pump accepts the outdoor temperature. |
| .homeycompose/locales/en.json → autopilot.smart.paired_failed | Smart mode from setup couldn't be applied: __reason__ Finish it in Repair. | Couldn't apply Smart mode from setup. Finish it in Repair. __reason__ |
| .homeycompose/locales/en.json → autopilot.widget.test | Simulation | Simulated |
| .homeycompose/locales/en.json → autopilot.widget.aiming | Aiming for __c__ °C | Target __c__ °C |
| .homeycompose/locales/en.json → autopilot.widget.axis_offset | Shift °C (BT1) | Outdoor shift °C |
| .homeycompose/locales/en.json → autopilot.widget.paused.spa_on | Smart price adaption is on for heating. Turn it off so Autopilot can work. | Smart price adaption is on for heating. Turn it off to enable Autopilot. |
| .homeycompose/locales/en.json → autopilot.widget.paused.room_control | Room control is on in your heat pump. Turn it off so Autopilot can work. | Room-sensor control is on in your heat pump. Turn it off to enable Autopilot. |
| .homeycompose/locales/en.json → autopilot.widget.paused.immersion_only | Your heat pump is running on the immersion heater only. Autopilot waits. | Your heat pump is running on the immersion heater only. Autopilot is paused. |
| .homeycompose/locales/en.json → autopilot.widget.paused.cooling | Your heat pump is cooling. Autopilot waits. | Your heat pump is cooling. Autopilot is paused. |
| .homeycompose/locales/en.json → autopilot.widget.starting_heating | Reading the forecast and prices. Takes about a minute. | Loading the forecast and prices. This takes about a minute. |
| .homeycompose/locales/en.json → autopilot.widget.starting_hotwater | Reading prices and the tank. Takes about a minute. | Loading prices and the tank level. This takes about a minute. |
| .homeycompose/locales/en.json → autopilot.widget.starting_app | Reading your heat pump. Takes about a minute. | Loading data from your heat pump. This takes about a minute. |
| .homeycompose/locales/en.json → autopilot.hotwater_status.test | Simulation: __text__ | Simulated: __text__ |
| .homeycompose/locales/en.json → autopilot.savings.empty | Shows from tomorrow. Needs dynamic electricity prices in Homey Energy. | Available from tomorrow. Requires dynamic electricity prices in Homey Energy. |
| .homeycompose/locales/en.json → autopilot.savings.first_day | Savings show after its first full day. | Savings appear after Autopilot's first full day. |
| .homeycompose/locales/en.json → autopilot.savings.loading | Reading the last two weeks from Insights. Takes a few minutes. | Loading the last two weeks from Insights. This may take a few minutes. |
| .homeycompose/locales/en.json → autopilot.energy.pick | Pick your heat pump's main device. | Pick your heat pump's Main device. |
| .homeycompose/locales/en.json → autopilot.energy.no_prices | Needs dynamic electricity prices in Homey Energy. | Requires dynamic electricity prices in Homey Energy. |
| .homeycompose/locales/en.json → autopilot.custom_warning | For advanced users only. These settings apply to the Heating device, and only while its comfort range is Custom. Autopilot was tuned on Comfort, Save and Save most; other combinations are untested, and Autopilot may heat more, save less, or let the house get colder than you expect. | For advanced users only. These settings apply to the Heating device while its comfort range is Custom. Autopilot is tuned for Comfort, Save and Save more. Other combinations are untested and may heat more, save less or let the house get colder than you expect. |

## lib/**/*.ts (39 edits, count in brackets = occurrences replaced)

| key or location | before | after |
|---|---|---|
| lib/connection.ts (1x) | 1: 'Illegal function — this pump doesn\'t have this register, or a pump setting has switched it off', | 1: 'Illegal function. Your heat pump doesn\'t have this setting or reading, or another setting has turned it off', |
| lib/connection.ts (1x) | 2: 'Illegal data address — no such register on this model', | 2: 'Illegal data address. This model doesn\'t have this setting or reading', |
| lib/connection.ts (1x) | 3: 'Illegal data value — the value is outside the range the pump accepts', | 3: 'Illegal data value. Your heat pump doesn\'t accept this value', |
| lib/connection.ts (1x) | 4: 'Server device failure — the pump hit an error carrying out the request', | 4: 'Server device failure. Your heat pump hit an error carrying out the request', |
| lib/connection.ts (1x) | 5: 'Acknowledge — accepted but still processing', | 5: 'Acknowledge. Accepted but still processing', |
| lib/connection.ts (1x) | 6: 'Server device busy — the pump is busy; retry later', | 6: 'Server device busy. Your heat pump is busy. Try again later', |
| lib/connection.ts (1x) | return {summary: 'the pump did not answer in time'}; | return {summary: 'your heat pump didn\'t respond in time'}; |
| lib/connection.ts (1x) | throw new Error('This address is already paired with a different pump driver. Remove that device before changing series.'); | throw new Error('This address is already paired with another heat pump model. Remove those devices first.'); |
| lib/driver.ts (1x) | throw new Error('This address is already paired with a different pump driver. Remove that device before changing series.'); | throw new Error('This address is already paired with another heat pump model. Remove those devices first.'); |
| lib/connection.ts (3x) | throw new Error("This driver is currently read-only."); | throw new Error("Settings on this heat pump model are read-only in Nibe Live."); |
| lib/device.ts (1x) | throw new Error("This driver is currently read-only."); | throw new Error("Settings on this heat pump model are read-only in Nibe Live."); |
| lib/connection.ts (1x) | throw new Error('This register is read-only'); | throw new Error('This setting is read-only'); |
| lib/device.ts (1x) | throw new Error('This register is read-only'); | throw new Error('This setting is read-only'); |
| lib/connection.ts (2x) | new Error('Not connected to the heat pump') | new Error('Not connected to your heat pump') |
| lib/device.ts (3x) | new Error('Not connected to the heat pump') | new Error('Not connected to your heat pump') |
| lib/device.ts (1x) | throw new Error('Heating feed is unavailable.'); | throw new Error('Can\'t send the indoor temperature right now.'); |
| lib/device.ts (1x) | throw new Error(`BT50 confirmation is still pending. Sent ${value.toFixed(1)} °C; ` + (measured === null ? 'no BT50 reading was returned.' : `the pump reports ${(measured / 10).toFixed(1)} °C.`) + ' The saved feed will retry in the background.'); | throw new Error(`Your heat pump hasn't confirmed BT50 yet. Sent ${value.toFixed(1)} °C. ` + (measured === null ? 'No BT50 reading came back.' : `Your heat pump reports ${(measured / 10).toFixed(1)} °C.`) + ' Homey keeps trying in the background.'); |
| lib/device.ts (1x) | throw new Error('Only Heating can supply BT50.'); | throw new Error('Only the Heating device can send BT50.'); |
| lib/device.ts (2x) | throw new Error('A temperature update is in progress. Please try again.'); | throw new Error('A temperature update is running. Try again in a moment.'); |
| lib/device.ts (2x) | throw new Error('Another Heating device already supplies this pump.'); | throw new Error('Another Heating device already sends temperatures to this heat pump.'); |
| lib/device.ts (1x) | await this.setWarning('Another Heating device already supplies this pump.'); | await this.setWarning('Another Heating device already sends temperatures to this heat pump.'); |
| lib/device.ts (1x) | throw new Error('Enable external BT50 on the heat pump before verifying.'); | throw new Error('Turn on external BT50 on your heat pump first.'); |
| lib/device.ts (1x) | throw new Error('First select your NIBE sensor for the zone and disable external BT50 on the heat pump.'); | throw new Error('Choose your NIBE sensor for the zone and turn off external BT50 on your heat pump first.'); |
| lib/device.ts (1x) | throw new Error('Only Heating reads the indoor temperature.'); | throw new Error('Only the Heating device reads the indoor temperature.'); |
| lib/device.ts (1x) | excerpt: 'Nibe Live: indoor temperature feed needs attention. Open Heating → Repair. ' + error.message | excerpt: 'Nibe Live can\'t send the indoor temperature. Open Heating → Repair. ' + error.message |
| lib/device.ts (1x) | throw new Error('BT50 is managed by the automatic indoor sensor feed.'); | throw new Error('BT50 is set automatically from your Homey sensors.'); |
| lib/device.ts (1x) | throw new Error('This action is not available for this device'); | throw new Error('This action isn\'t available on this device'); |
| lib/device.ts (1x) | throw new Error('A working indoor sensor is required for room temperature control.'); | throw new Error('Room temperature control requires a working indoor sensor.'); |
| lib/device.ts (1x) | throw new Error('Room regulation is disabled. Adjust the heating curve instead.'); | throw new Error('Room-sensor control is off. Adjust the heat curve instead.'); |
| lib/device.ts (1x) | throw new Error('The pump did not confirm the requested value'); | throw new Error('Your heat pump did not confirm the new value'); |
| lib/device.ts (1x) | throw new Error(`Could not set "${this.registerTitle(register)}": ${error?.message ?? error}`); | throw new Error(`Couldn't set "${this.registerTitle(register)}": ${error?.message ?? error}`); |
| lib/device.ts (1x) | throw new Error(`${failed.length} capability/capabilities could not be applied: ` + `${failed.join(', ')}. The selection was saved — try Repair again, and if it ` + 'keeps failing please report it with the app logs.'); | throw new Error(`Some readings couldn't be added: ${failed.join(', ')}. Your choice is saved. ` + 'Run Repair again, and report it with the app logs if it keeps happening.'); |
| lib/device.ts (1x) | throw new Error('Return to your NIBE sensor in Repair before changing the pump address.'); | throw new Error('Return to your NIBE sensor in Repair before changing your heat pump\'s address.'); |
| lib/registers.ts (1x) | Re-pick the Flow option.`); | Choose it again in the Flow.`); |
| lib/registers.ts (1x) | throw new Error('Value cannot be represented by this register'); | throw new Error('This value isn\'t supported for this setting'); |
| lib/driver.ts (1x) | en: "Electricity used while the pump is idle, since the device was added", | en: "Electricity your heat pump used while idle, since this device was added", |
| lib/driver.ts (1x) | en: "Power the pump is drawing right now while idle", | en: "Power your heat pump draws right now while idle", |
| lib/driver.ts (1x) | en: "Power the pump is drawing right now, when this function is the active one", | en: "Power your heat pump draws right now while running this function", |

## Tests updated

- test/autopilot-hotwater-shadow.test.ts: daily plan (tank line, shadow line), charge detail (Today's average, Moved from, Started by your heat pump, A charge was planned then too, Simulated title), plan update (all four lines, revised move, cancelled).
- test/autopilot-savings.test.ts: first_day.
- test/autopilot-widget.test.ts: stripLead examples now use the current copy (Holding. No changes planned / Simulated:).
- test/unit.test.ts: Modbus exception 2 and timeout summaries.
- test/reliability.test.ts: not available, room-sensor control off, turn off external BT50, already sends temperatures.

## Left alone on purpose

- Widgets (widget.compose.json, public/index.html): English is already stock ("Loading…", "Couldn't load this widget. Trying again in a minute.").
- lib/autopilot/*: all owner text comes from locale keys; the hardcoded strings there are log lines.
- "charge"/"Heating the tank", "boost", "safety net" wording: undecided per brief.
- lib/indoor-sensors.ts errors: already plain.
- "BT1 is managed by Autopilot heating." kept (clear, test-asserted).

## Pairing, setup and Repair

key or location | before | after
---|---|---
locales/en.json → pair.setup.pending_hint | Add your devices first, then open Heating → Repair to finish the setup. Leave your current NIBE sensor in control until then. No temperatures are sent during pairing. | Add your devices first, then finish the setup in Heating → Repair. Until then, keep your NIBE sensor in control. No temperatures are sent during pairing.
locales/en.json → pair.setup.zone_confirm | I have selected BT50 to control the intended zone. | BT50 is set to control the right zone.
locales/en.json → pair.setup.active_note | Temperature updates continue in the background. To stop them, use Heating Setup to return to your NIBE sensor first. | Temperature updates keep running in the background. To stop them, return to your NIBE sensor in Heating setup.
locales/en.json → pair.setup.handover_hint | On your heat pump, select your original sensor to control the zone and disable external BT50. The current feed continues until you verify here. | On your heat pump, set your original sensor to control the zone and turn off external BT50. Temperature updates continue until you verify here.
locales/en.json → pair.setup.no_nibe_sources | No live NIBE source choices were detected. The current/default source will be kept. | No other sensors found on your heat pump. The current one is kept.
locales/en.json → pair.setup.thermostat_zone_intro | Your heat pump has more than one zone. Choose the zone that controls the heating: on your heat pump, that zone’s room sensor is set to control (menu 1.3.3). | Your heat pump has more than one zone. Choose the one that controls the heating. On your heat pump, it's the zone whose room sensor is set to control (menu 1.3.3).
locales/en.json → pair.setup.thermostat_zone_review | Heating: the thermostat sets __zone__ | The Heating thermostat sets __zone__
locales/en.json → pair.setup.request_timeout | Homey did not respond. Please try again. | Homey didn't respond. Try again.
locales/en.json → pair.setup.source_intro | Choose which sensor supplies the indoor temperature used to control your heating. | Choose which sensor your heating uses for the indoor temperature.
locales/en.json → pair.setup.source_homey_desc | Use one sensor or average several rooms. Your heat pump stays in control. | One sensor, or the average of several rooms.
locales/en.json → pair.setup.feed_short | Verification starts regular temperature updates, which continue after you close Repair. | Verifying starts temperature updates. They continue after you close Repair.
locales/en.json → pair.setup.success_title | You’re all set! | You’re all set.
locales/en.json → pair.setup.success_many | sensors working together | sensors connected
locales/en.json → pair.setup.smart.choose_spa_desc | NIBE's own. It runs in your heat pump and gets prices through myUplink. | Built into your heat pump. Gets prices through myUplink.
locales/en.json → pair.setup.smart.choose_off_desc_heating | Heating follows the curve only. | Heating follows the heat curve.
locales/en.json → pair.setup.smart.prices_fixed | Fixed price: nothing to shift. Set dynamic prices in Homey Energy. | Fixed price, so nothing to shift. Set dynamic prices in Homey Energy.
locales/en.json → pair.setup.smart.room_control_on | This is on in your heat pump. Turn it off, or it will undo what Autopilot does. | On in your heat pump. Turn it off to enable Autopilot.
locales/en.json → pair.setup.smart.start_test | Start simulation | Start Autopilot
locales/en.json → pair.setup.smart.saved_test | Simulation started | Autopilot started · Simulated
locales/en.json → pair.setup.smart.verify_confirm | Both are on | External BT1 is on
locales/en.json → pair.setup.smart.room_control_optional | Optional. On lets your heat pump correct by room temperature. Turn it off before choosing Autopilot. | Optional. When on, your heat pump adjusts heating by room temperature. Must be off for Autopilot.
locales/en.json → pair.setup.smart.cmp_note | Smart price adaption is NIBE's own: it runs in your heat pump and gets prices through myUplink. | Smart price adaption is built into your heat pump and gets prices through myUplink.
locales/en.json → pair.setup.smart.exp_learning_sub | At least 5 days. Nothing changes yet. | At least 5 days. No changes yet.
locales/en.json → pair.setup.smart.ctl_range_sub | How far indoor may drift | How far the indoor temperature may vary
locales/en.json → pair.setup.smart.ctl_away_sub | A lower temperature while you're out | A lower temperature while you're on holiday
locales/en.json → pair.setup.smart.hw_tank_intro | Autopilot plans in litres, so it needs your tank's size. Pick it once. | Autopilot plans in litres, so it needs your tank size.
locales/en.json → pair.setup.smart.hw_flows_unknown | Your Flows couldn't be read. Turn off any that switch on More hot water on a schedule. | Couldn't read your Flows. Turn off any that turn on More hot water on a schedule.
locales/en.json → pair.setup.smart.hw_household_intro | Autopilot is still learning (__days__ days so far). Tell it a bit about your home so it can start well. | Autopilot is still learning (__days__ days so far). Answer a few questions to help it get started.
locales/en.json → pair.setup.smart.hw_household_intro_unknown | Autopilot is still learning. Tell it a bit about your home so it can start well. | Autopilot is still learning. Answer a few questions to help it get started.
locales/en.json → pair.setup.smart.household_invalid | Choose how many people live there and a shower time. | Choose the number of people and a shower time.
locales/en.json → pair.setup.smart.hw_daytype_calendar | Today: __type__. Saturday and Sunday are days off. Holiday or working from home? Change it on the Main device, or let a Flow follow your calendar. | Today: __type__. Saturdays and Sundays are days off. For a weekday off or working from home, change it on the Main device, or use a Flow that follows your calendar.
locales/en.json → pair.setup.smart.hw_reserve_hint | The least hot water Autopilot lets the tank drop to. A bigger cushion means the odd charge at a pricier hour. | The least hot water Autopilot keeps in the tank. More means the occasional charge in a more expensive hour.
locales/en.json → pair.setup.smart.solar_evidence | In recent weeks you sent up to __kw__ kW to the grid on sunny hours. | In recent weeks you sent up to __kw__ kW to the grid in sunny hours.
locales/en.json → pair.setup.smart.solar_evidence_plain | Your meter sends power to the grid on sunny hours. | Your meter sends power to the grid in sunny hours.
locales/en.json → pair.setup.smart.mode_note | Live steers your heat pump. Simulated plans everything and shows what it would do, while your heat pump stays as it is. | Live steers your heat pump. Simulated previews the plan without making changes.
locales/en.json → pair.setup.smart.indoor_homey_desc | One sensor, or the average of several rooms. Autopilot regulates on them, your heat pump doesn't. | One sensor, or the average of several rooms.
locales/en.json → pair.setup.smart.indoor_note | Autopilot steers your heat pump through the outdoor temperature (BT1), so room-sensor control on your heat pump stays off. | Autopilot steers your heat pump through the outdoor temperature (BT1). Requires room-sensor control on your heat pump to be off.
locales/en.json → pair.setup.smart.indoor_source_prompt | More than one sensor can report this. Pick the one Autopilot reads: | More than one sensor reports this. Choose the one for Autopilot.
locales/en.json → pair.setup.smart.indoor_homey_read | only read | read only
locales/en.json → pair.setup.smart.indoor_bt50_note | Your Homey sensors keep going to your heat pump as BT50, so it reports no sensor fault. With room-sensor control off, it only shows them. Autopilot does the regulating. | The room temperature is still sent to your heat pump as BT50 to prevent sensor alarms.
locales/en.json → pair.setup.smart.success_indoor | indoors now · Autopilot steers it to __target__ °C | indoors now · Target __target__ °C
locales/en.json → pair.setup.gets_added_intro | Adding these devices, set up like this: | These devices will be added.
locales/en.json → pair.setup.changes.autopilot_simulated | Autopilot, simulated: it plans and shows, your heat pump stays as it is | Autopilot · Simulated. Previews the plan without making changes
locales/en.json → pair.setup.changes.autopilot_uses | Autopilot acts on these, so they stay on while it runs | Used by Autopilot, so they stay on while it runs
locales/en.json → pair.setup.changes.spa_back | Back, now that Autopilot is off | Restored because Autopilot is off
locales/en.json → pair.setup.changes.none | Nothing changes on your devices. | No changes to your devices.
assets/pair/devices.js:86 | text += ' — ' + source.value + ' °C' | text += ' · ' + source.value + ' °C'
assets/pair/features.js:112 | text += ' — ' + source.value + ' °C' | text += ' · ' + source.value + ' °C'
test/setup-ui.test.ts:157 | /You’re all set!/ | /You’re all set\./
test/setup-ui.test.ts:184 | /the thermostat sets Zone 2/ | /The Heating thermostat sets Zone 2/

## Flow cards, settings, capabilities

key or location | before | after
---|---|---
driver.flow.compose.json → triggers.alarm_occurred.hint | Fires when your heat pump reports a new alarm. Use the alarm description token to see what happened. | Triggers when your heat pump reports a new alarm. The Alarm token says what happened.
driver.flow.compose.json → triggers.priority_changed.hint | Fires when your heat pump switches between hot water, heating, pool, cooling and off. The reason token says why. | Triggers when your heat pump switches between hot water, heating, pool, cooling and off. The Reason token says why.
driver.flow.compose.json → triggers.capability_changed.title | Register changed | Setting changed
driver.flow.compose.json → triggers.capability_changed.hint | Fires when the selected register's value changes. Only registers with a fixed set of modes (operating mode, hot water demand, priority, fan mode) can be picked. | Triggers when the selected setting changes. Only settings with a fixed set of modes (operating mode, hot water demand, priority, fan mode) can be picked.
driver.flow.compose.json → triggers.capability_changed.args.0.title | Register | Setting
driver.flow.compose.json → triggers.capability_changed.tokens.1.title | Register | Setting
driver.flow.compose.json → triggers.capability_turned_on.title | Register turned on | A setting turned on
driver.flow.compose.json → triggers.capability_turned_on.hint | Fires when the selected on/off register switches on. | Triggers when the selected on/off setting turns on.
driver.flow.compose.json → triggers.capability_turned_on.args.0.title | Register | Setting
driver.flow.compose.json → triggers.capability_turned_on.tokens.0.title | Register | Setting
driver.flow.compose.json → triggers.capability_turned_off.title | Register turned off | A setting turned off
driver.flow.compose.json → triggers.capability_turned_off.hint | Fires when the selected on/off register switches off. | Triggers when the selected on/off setting turns off.
driver.flow.compose.json → triggers.capability_turned_off.args.0.title | Register | Setting
driver.flow.compose.json → triggers.capability_turned_off.tokens.0.title | Register | Setting
driver.flow.compose.json → triggers.curve_displacement_NIBE.h30_heat_curve_displacement.changed.title | Heat curve displacement changed | Heat curve offset changed
driver.flow.compose.json → triggers.curve_displacement_NIBE.h30_heat_curve_displacement.changed.hint | Fires when the heat curve displacement changes, whether set on your heat pump, in myUplink or from Homey. | Triggers when the heat curve offset changes, on your heat pump, in myUplink or from Homey.
driver.flow.compose.json → triggers.curve_displacement_NIBE.h30_heat_curve_displacement.changed.tokens.0.title | Displacement | Offset
driver.flow.compose.json → triggers.operating_mode_NIBE.h237_operating_mode.changed.hint | Fires when the operating mode changes: auto, manual or additional heat only. | Triggers when the operating mode changes to auto, manual or immersion heater only.
driver.flow.compose.json → triggers.measure_enum_NIBE.i1037_return_fan_step.changed.hint | Fires when the exhaust air fan switches mode: normal or speed 1–4. | Triggers when the exhaust air fan switches between normal and speed 1–4.
driver.flow.compose.json → triggers.hotwater_volume_dropped_below.hint | Fires once when the estimate crosses your limit going down. Needs a tank picked in Repair. | Triggers once when the estimate drops below the limit. Requires a hot water tank, set in Repair.
driver.flow.compose.json → triggers.hotwater_charge_started.hint | Fires when a charge starts, whether Autopilot or your heat pump started it. Works with Autopilot on, or in Simulation. | Triggers when a charge starts, by Autopilot or your heat pump. Works in Live and Simulated.
driver.flow.compose.json → triggers.autopilot_heating_status_changed.hint | For example from holding to easing off before expensive hours. | Triggers when the status changes, for example from Holding to Easing off.
driver.flow.compose.json → triggers.autopilot_heating_preheating_started.hint | Fires when the house gets extra heat ahead of expensive hours or your return. Works with Autopilot heating on, or in Simulation. | Triggers when the house gets extra heat before expensive hours or your return. Works in Live and Simulated.
driver.flow.compose.json → triggers.autopilot_heating_easing_off_started.hint | Fires when the house gets less heat through expensive hours or forecast sun. Works with Autopilot heating on, or in Simulation. | Triggers when the house gets less heat during expensive hours or forecast sun. Works in Live and Simulated.
driver.flow.compose.json → triggers.autopilot_heating_expensive_soon.hint | The same expensive hours the Heating status names. Good for moving the dishwasher, sauna or car charging. Works with Autopilot heating on, or in Simulation. | Triggers when the expensive hours shown in the Heating status are this many minutes away. Works in Live and Simulated.
driver.flow.compose.json → triggers.autopilot_heating_cheap_soon.hint | The cheapest hours in the plan, found the same way as the expensive ones. Good for starting the dishwasher, sauna or car charging. Works with Autopilot heating on, or in Simulation. | Triggers when the cheapest hours in the plan are this many minutes away. Works in Live and Simulated.
driver.flow.compose.json → actions.target_temperature.h34_min_supply.set.titleFormatted | Set the minimum supply temperature to [[value]] | Set the minimum supply temperature to [[value]] °C
driver.flow.compose.json → actions.target_temperature.h38_max_supply.set.titleFormatted | Set the maximum supply temperature to [[value]] | Set the maximum supply temperature to [[value]] °C
driver.flow.compose.json → actions.target_temperature.h183_auto_start_cooling.set.titleFormatted | Set the outdoor temperature that starts cooling to [[value]] | Set the outdoor temperature that starts cooling to [[value]] °C
driver.flow.compose.json → actions.target_temperature.h184_auto_stop_heating.set.titleFormatted | Set the outdoor temperature that stops heating to [[value]] | Set the outdoor temperature that stops heating to [[value]] °C
driver.flow.compose.json → actions.target_temperature.h185_auto_stop_addition.set.titleFormatted | Set the outdoor temperature that stops the immersion heater to [[value]] | Set the outdoor temperature that stops the immersion heater to [[value]] °C
driver.flow.compose.json → actions.target_temperature.h687_pool_start.set.titleFormatted | Set the pool start temperature to [[value]] | Set the pool start temperature to [[value]] °C
driver.flow.compose.json → actions.target_temperature.h689_pool_stop.set.titleFormatted | Set the pool stop temperature to [[value]] | Set the pool stop temperature to [[value]] °C
driver.flow.compose.json → actions.measure_minute_NIBE.h93_periodtime_heating.set.titleFormatted | Set the heating period time to [[value]] | Set the heating period time to [[value]] minutes
driver.flow.compose.json → actions.measure_minute_NIBE.h94_periodtime_pool.set.titleFormatted | Set the pool period time to [[value]] | Set the pool period time to [[value]] minutes
driver.flow.compose.json → actions.measure_minute_NIBE.h93_periodtime_heating.set.hint | How long your heat pump makes heating before switching demand. Accepts 0 to 180 minutes. | How long your heat pump heats the house before it moves on to hot water or pool. Accepts 0 to 180 minutes.
driver.flow.compose.json → actions.measure_minute_NIBE.h94_periodtime_pool.set.hint | How long your heat pump heats the pool before switching demand. Accepts 0 to 180 minutes. | How long your heat pump heats the pool before it moves on to heating or hot water. Accepts 0 to 180 minutes.
driver.flow.compose.json → actions.target_temperature.h60_hotwater_start_small.set.title | Set the hot water start temperature (Small) | Set the hot water start temperature for Small demand
driver.flow.compose.json → actions.target_temperature.h60_hotwater_start_small.set.titleFormatted | Set the hot water start temperature (Small) to [[value]] | Set the hot water start temperature for Small demand to [[value]] °C
driver.flow.compose.json → actions.target_temperature.h64_hotwater_stop_small.set.title | Set the hot water stop temperature (Small) | Set the hot water stop temperature for Small demand
driver.flow.compose.json → actions.target_temperature.h64_hotwater_stop_small.set.titleFormatted | Set the hot water stop temperature (Small) to [[value]] | Set the hot water stop temperature for Small demand to [[value]] °C
driver.flow.compose.json → actions.target_temperature.h58_hotwater_start_large.set.title | Set the hot water start temperature (Large) | Set the hot water start temperature for Large demand
driver.flow.compose.json → actions.target_temperature.h58_hotwater_start_large.set.titleFormatted | Set the hot water start temperature (Large) to [[value]] | Set the hot water start temperature for Large demand to [[value]] °C
driver.flow.compose.json → actions.target_temperature.h62_hotwater_stop_large.set.title | Set the hot water stop temperature (Large) | Set the hot water stop temperature for Large demand
driver.flow.compose.json → actions.target_temperature.h62_hotwater_stop_large.set.titleFormatted | Set the hot water stop temperature (Large) to [[value]] | Set the hot water stop temperature for Large demand to [[value]] °C
driver.flow.compose.json → actions.target_temperature.h59_hotwater_start.set.title | Set the hot water start temperature (Medium) | Set the hot water start temperature for Medium demand
driver.flow.compose.json → actions.target_temperature.h59_hotwater_start.set.titleFormatted | Set the hot water start temperature (Medium) to [[value]] | Set the hot water start temperature for Medium demand to [[value]] °C
driver.flow.compose.json → actions.target_temperature.h63_hotwater_stop.set.title | Set the hot water stop temperature (Medium) | Set the hot water stop temperature for Medium demand
driver.flow.compose.json → actions.target_temperature.h63_hotwater_stop.set.titleFormatted | Set the hot water stop temperature (Medium) to [[value]] | Set the hot water stop temperature for Medium demand to [[value]] °C
driver.flow.compose.json → actions.target_temperature.h61_hotwater_stop_periodic.set.title | Set the hot water stop temperature (Periodic) | Set the periodic hot water stop temperature
driver.flow.compose.json → actions.target_temperature.h61_hotwater_stop_periodic.set.titleFormatted | Set the hot water stop temperature (Periodic) to [[value]] | Set the periodic hot water stop temperature to [[value]] °C
driver.flow.compose.json → actions.target_temperature.h61_hotwater_stop_periodic.set.hint | Stop temperature for the periodic anti-legionella charge. Reaching it usually needs the immersion heater — a compressor alone tops out in the high 50s. Accepts 55 to 70 °C. | Stop temperature for the periodic anti-legionella charge. It usually needs the immersion heater. Accepts 55 to 70 °C.
driver.flow.compose.json → actions.operating_mode_NIBE.h237_operating_mode.enum.titleFormatted | Set operating mode [[mode]] | Set operating mode to [[mode]]
driver.flow.compose.json → actions.curve_mode_NIBE.h26_heat_curve.enum.titleFormatted | Set heat curve [[mode]] | Set heat curve to [[mode]]
driver.flow.compose.json → actions.hotwater_demand_NIBE.h56_hotwater_demand_mode.enum.titleFormatted | Set hot water demand [[mode]] | Set hot water demand to [[mode]]
driver.flow.compose.json → actions.hotwater_increase_NIBE.h697_onetimeincrease_hotwater.enum.titleFormatted | Set one-time increase [[mode]] | Set one-time increase to [[mode]]
driver.flow.compose.json → actions.hotwater_periodic_interval_NIBE.h66_periodic_hw_interval.enum.titleFormatted | Set periodic hot water interval [[mode]] | Set periodic hot water interval to [[mode]]
driver.flow.compose.json → actions.hotwater_periodtime_NIBE.h92_periodtime_hotwater.enum.titleFormatted | Set periodic hot water length [[mode]] | Set periodic hot water length to [[mode]]
driver.flow.compose.json → actions.sg_ready.h6008_requested_mode.enum.titleFormatted | Set SG Ready mode [[mode]] | Set SG Ready mode to [[mode]]
driver.flow.compose.json → actions.curve_displacement_NIBE.h30_heat_curve_displacement.enum.title | Set heat curve displacement | Set heat curve offset
driver.flow.compose.json → actions.curve_displacement_NIBE.h30_heat_curve_displacement.enum.titleFormatted | Set heat curve displacement [[mode]] | Set heat curve offset to [[mode]]
driver.flow.compose.json → actions.curve_displacement_NIBE.h30_heat_curve_displacement.enum.hint | Shifts the heat curve up or down (−10…+10). | Shifts the heat curve up or down, from −10 to +10.
driver.flow.compose.json → actions.operating_mode_NIBE.h237_operating_mode.enum.hint | Operating mode: auto, manual or immersion heater only. | Auto, manual or immersion heater only.
driver.flow.compose.json → actions.curve_mode_NIBE.h26_heat_curve.enum.args.0.title | Mode | Curve
driver.flow.compose.json → actions.hotwater_periodic_interval_NIBE.h66_periodic_hw_interval.enum.args.0.title | Mode | Interval
driver.flow.compose.json → actions.hotwater_periodtime_NIBE.h92_periodtime_hotwater.enum.args.0.title | Mode | Length
driver.flow.compose.json → conditions.curve_mode_NIBE.h26_heat_curve.enum.args.0.title | Mode | Curve
driver.flow.compose.json → conditions.hotwater_periodic_interval_NIBE.h66_periodic_hw_interval.enum.args.0.title | Mode | Interval
driver.flow.compose.json → conditions.hotwater_periodtime_NIBE.h92_periodtime_hotwater.enum.args.0.title | Mode | Length
driver.flow.compose.json → actions.curve_displacement_NIBE.h30_heat_curve_displacement.enum.args.0.title | Mode | Offset
driver.flow.compose.json → actions.hotwater_increase_NIBE.h697_onetimeincrease_hotwater.enum.args.0.title | Mode | Duration
driver.flow.compose.json → actions.spa_hotwater_influence_NIBE.h902_spa_hotwater_influence.enum.hint | How strongly Smart price adaption may shift hot water charging towards cheaper hours. Runs 1 to 4, not 1 to 10 like heating. | How strongly Smart price adaption may shift hot water charging towards cheaper hours. Accepts 1 to 4.
driver.flow.compose.json → actions.spa_influence_NIBE.h848_spa_pool_influence.enum.hint | How strongly Smart price adaption may shift pool heating towards cheaper hours. 0 leaves pool heating alone entirely. | How strongly Smart price adaption may shift pool heating towards cheaper hours. 0 is off.
driver.flow.compose.json → actions.spa_influence_NIBE.h850_spa_cooling_influence.enum.hint | How strongly Smart price adaption may shift cooling towards cheaper hours. 0 leaves cooling alone entirely. | How strongly Smart price adaption may shift cooling towards cheaper hours. 0 is off.
driver.flow.compose.json → actions.boolean_NIBE.h697_more_hotwater.onoff.hint | More hot water: a one-time 2-hour boost | A one-time 2-hour hot water boost.
driver.flow.compose.json → actions.boolean_NIBE.h227_nightchill.onoff.hint | Night cooling using the exhaust air fan | Night cooling using the exhaust air fan.
driver.flow.compose.json → actions.boolean_NIBE.h65_periodic_hotwater.onoff.hint | Enable the periodic hot water boost | Turns the periodic hot water boost on or off.
driver.flow.compose.json → actions.onoff.h691_pool_active.onoff.hint | Enable pool heating | Turns pool heating on or off.
driver.flow.compose.json → actions.boolean_NIBE.h180_enable_addition.onoff.hint | Allow the electric immersion heater for heating. Hot water has its own separate switch. | Allows the immersion heater to help with heating.
driver.flow.compose.json → actions.onoff.h181_enable_heating.onoff.hint | Allow heating operation | Allows your heat pump to heat the house.
driver.flow.compose.json → actions.onoff.h182_enable_cooling.onoff.hint | Allow cooling operation | Allows your heat pump to cool the house.
driver.flow.compose.json → actions.onoff.h195_enable_hotwater.onoff.hint | Allow hot water. Off disables all hot water, including the More hot water boost | Off turns off all hot water, including More hot water.
driver.flow.compose.json → actions.sg_ready.h3032_api_control.onoff.hint | On: Homey sets the SG Ready mode. Off: your heat pump's own SG Ready inputs decide. | When on, Homey sets the SG Ready mode. When off, your heat pump's own SG Ready inputs do.
driver.flow.compose.json → actions.sg_ready.h6008_requested_mode.enum.hint | Needs SG Ready set up on your heat pump and switched on. | Requires SG Ready to be set up and turned on in your heat pump.
driver.flow.compose.json → actions.set_numeric_value.title | Set value of a register (advanced) | Change a setting (advanced)
driver.flow.compose.json → actions.set_numeric_value.titleFormatted | Set value of [[register]] to [[value]] | Set [[register]] to [[value]]
driver.flow.compose.json → actions.set_numeric_value.hint | Writes any writable Modbus register, picked by name. Prefer the named cards ("Set the heat curve to …") — this is the escape hatch for registers that have none. Values outside the register’s range are rejected. | Changes any adjustable setting, picked by name. Use a named card, like "Set heat curve", when there is one. Values outside the setting's range are rejected.
driver.flow.compose.json → actions.set_numeric_value.args.0.title | Register | Setting
driver.flow.compose.json → actions.enable_feature.title | Enable a register (advanced) | Turn on a setting (advanced)
driver.flow.compose.json → actions.enable_feature.titleFormatted | Enable [[register]] | Turn on [[register]]
driver.flow.compose.json → actions.enable_feature.hint | Switches on any writable on/off register, picked by name. Prefer the device’s own on/off cards — this is the escape hatch. | Turns on any adjustable on/off setting, picked by name. Use the device's own on/off card when there is one.
driver.flow.compose.json → actions.enable_feature.args.0.title | Register | Setting
driver.flow.compose.json → actions.disable_feature.title | Disable a register (advanced) | Turn off a setting (advanced)
driver.flow.compose.json → actions.disable_feature.titleFormatted | Disable [[register]] | Turn off [[register]]
driver.flow.compose.json → actions.disable_feature.hint | Switches off any writable on/off register, picked by name. Prefer the device’s own on/off cards — this is the escape hatch. | Turns off any adjustable on/off setting, picked by name. Use the device's own on/off card when there is one.
driver.flow.compose.json → actions.disable_feature.args.0.title | Register | Setting
driver.flow.compose.json → actions.external_temperature.h5217_bt1.set.title | Set outdoor temperature (BT1) | Set outdoor temperature BT1
driver.flow.compose.json → actions.external_temperature.h5217_bt1.set.titleFormatted | Set outdoor temperature (BT1): [[value]] °C | Set outdoor temperature BT1 to [[value]] °C
driver.flow.compose.json → actions.external_temperature.h5217_bt1.set.hint | Enable external BT1 in menu 7.5.9.2 on your heat pump. Sends one reading; your Flow must supply fresh readings regularly. Success means the write was accepted, not that heating uses it. | Requires external BT1 on your heat pump (menu 7.5.9.2). Sends one reading per run. Repeat every few minutes.
driver.flow.compose.json → actions.set_away_until.hint | For a holiday of a week or more. Hot water keeps only its minimum warm, the house is warm again when you're back, and Away ends by itself. | For a holiday of a week or more. Hot water stays at its minimum, the house is warm again when you're back, and Away ends on its own.
driver.flow.compose.json → actions.autopilot_heating_set_profile.args.0.values.save_most.label | I'd rather freeze (±6 °C) | Save more (±6 °C)
driver.flow.compose.json → conditions.numeric_value_comparison.titleFormatted | Value of [[register]] is [[comparison]] [[value]] | [[register]] is [[comparison]] [[value]]
driver.flow.compose.json → conditions.numeric_value_comparison.hint | Compares any readable numeric register against a value. Useful for readings that have no card of their own, such as degree minutes or compressor frequency. | Compares a reading with a value. Useful for readings without a card of their own, like compressor frequency.
driver.flow.compose.json → conditions.numeric_value_comparison.args.0.title | Register | Reading
driver.flow.compose.json → conditions.curve_displacement_NIBE.h30_heat_curve_displacement.compare.title | Heat curve displacement is less/greater than | Heat curve offset is less/greater than
driver.flow.compose.json → conditions.curve_displacement_NIBE.h30_heat_curve_displacement.compare.titleFormatted | Heat curve displacement is [[comparison]] [[value]] | Heat curve offset is [[comparison]] [[value]]
driver.flow.compose.json → conditions.feature_enabled.title | A register is on (advanced) | A setting is on
driver.flow.compose.json → conditions.feature_enabled.titleFormatted | [[register]] is !{{enabled|disabled}} | [[register]] is !{{on|off}}
driver.flow.compose.json → conditions.feature_enabled.hint | Checks any on/off register, picked by name. | Checks any on/off setting, picked by name.
driver.flow.compose.json → conditions.feature_enabled.args.0.title | Register | Setting
driver.flow.compose.json → conditions.operating_mode_NIBE.h237_operating_mode.enum.hint | Operating mode: auto, manual or immersion heater only. | Auto, manual or immersion heater only.
driver.flow.compose.json → conditions.hotwater_volume_below.hint | Needs a tank picked in Repair; false without one. | Requires a hot water tank, set in Repair. False without one.
driver.compose.json → capabilitiesOptions.measure_watt_NIBE.i1048_compressor_add_power.title | Compressor supplied power | Compressor power
driver.compose.json → capabilitiesOptions.fuse_NIBE.h103_fuse.title | Fuse incoming | Main fuse
driver.compose.json → capabilitiesOptions.measure_temperature.i1_outside.title | Outside temperature (BT1) | Outdoor temperature (BT1)
driver.compose.json → capabilitiesOptions.curve_displacement_NIBE.h30_heat_curve_displacement.title | Heat curve displacement | Heat curve offset
driver.compose.json → capabilitiesOptions.boolean_NIBE.h202_use_room_sensor.title | Room sensor regulation active | Room-sensor control
driver.compose.json → capabilitiesOptions.measure_minute_NIBE.h93_periodtime_heating.title | Period time heating | Heating period time
driver.compose.json → capabilitiesOptions.measure_minute_NIBE.h94_periodtime_pool.title | Period time pool | Pool period time
driver.compose.json → settings.4.children.analyticsConsent.hint | Off by default. Sends your heat pump's model, which devices you paired, which Flow cards ran, alarm codes, and how Autopilot is set up and how each day went. Never readings, IP, serial or names. | Sends your heat pump's model, paired devices, Flow cards used, alarm codes, and Autopilot setup and daily results. Never readings, IP, serial or names.
driver.compose.json → settings.5.children.pollInterval.label | Poll interval (seconds) | Update interval (seconds)
driver.compose.json → settings.5.children.pollInterval.hint | How often Homey reads your heat pump. Set it on Nibe Main. Shorter is quicker but busier. | How often Homey reads your heat pump. Set it on the Main device. A shorter interval updates faster but sends more requests.
driver.compose.json → settings.6.children.custom_warning.hint | For advanced users only. These settings apply to the Heating device, and only while its comfort range is Custom. Autopilot was tuned on Comfort, Save and Save most; other combinations are untested, and Autopilot may heat more, save less, or let the house get colder than you expect. | For advanced users. These settings apply to the Heating device when its comfort range is Custom. Autopilot is tuned for Comfort, Save and Save more. Other values are untested and may heat more, save less or let the house get colder than expected.
driver.compose.json → settings.6.children.custom_coldest.hint | How far the house may cool below its indoor temperature while Autopilot eases off. Comfort 0.5, Save 3, Save most 6. | How far the house may cool below its indoor temperature while Autopilot eases off. Comfort 0.5, Save 3, Save more 6.
driver.compose.json → settings.6.children.custom_warmest.hint | How far a pre-heat may take the house above its indoor temperature. Comfort 0.5, Save 3, Save most 6. | How far a pre-heat may take the house above its indoor temperature. Comfort 0.5, Save 3, Save more 6.
driver.compose.json → settings.6.children.custom_price_ratio.hint | Heat is moved between two hours only when the expensive one costs at least this many times the cheap one. Lower moves heat more often. Comfort 1.2, Save 1.1, Save most 1.0. | Heat is moved between two hours only when the expensive one costs at least this many times the cheap one. Lower moves heat more often. Comfort 1.2, Save 1.1, Save more 1.0.
driver.compose.json → settings.6.children.custom_coast_hours.hint | How long the house may run on stored heat before it is bought back. Comfort 6, Save 12, Save most 24. | How long the house may run on stored heat before Autopilot heats it back up. Comfort 6, Save 12, Save more 24.
driver.compose.json → settings.6.children.custom_preheat_shift.hint | How far below the real outdoor temperature Autopilot may feed BT1 to heat harder. Comfort 10, Save 15, Save most 20. | How far below the measured outdoor temperature Autopilot may send BT1, to heat more. Comfort 10, Save 15, Save more 20.
driver.compose.json → settings.6.children.custom_coast_shift.hint | How far above the real outdoor temperature Autopilot may feed BT1 to heat less. Comfort 10, Save 15, Save most 20. | How far above the measured outdoor temperature Autopilot may send BT1, to heat less. Comfort 10, Save 15, Save more 20.
driver.compose.json → settings.6.children.custom_comfort_weight.hint | What a degree away from your temperature costs against the money a shift saves. Higher keeps the house closer to your temperature. Comfort 1.4, Save 1.2, Save most 1.0. | What a degree away from your temperature costs against the money a shift saves. Higher keeps the house closer to your temperature. Comfort 1.4, Save 1.2, Save more 1.0.
driver.compose.json → settings.6.children.custom_preheat_lead.hint | As a share of how slowly your house warms and cools (its time constant). 1 lets a pre-heat start a full time constant before a price peak. Comfort, Save and Save most all use 0.3. | As a share of how slowly your house warms and cools (its time constant). 1 lets a pre-heat start a full time constant before a price peak. Comfort, Save and Save more all use 0.3.
curve_displacement_NIBE.json → title | Heatcurve displacement | Heat curve offset
curve_mode_NIBE.json → title | Heatcurve set | Heat curve
hotwater_demand_NIBE.json → title | Hotwater demand set | Hot water demand
hotwater_demand_NIBE.json → values.0.title | 0 = Small | Small
hotwater_demand_NIBE.json → values.1.title | 1 = Medium | Medium
hotwater_demand_NIBE.json → values.2.title | 2 = Large | Large
hotwater_demand_NIBE.json → values.4.title | 4 = Smart control | Smart control
hotwater_increase_NIBE.json → values.0.title | 0 = Off | Off
hotwater_increase_NIBE.json → values.2.title | 2 = 2 hours | 2 hours
hotwater_increase_NIBE.json → values.3.title | 3 = 3 hours | 3 hours
hotwater_increase_NIBE.json → values.6.title | 6 = 6 hours | 6 hours
hotwater_increase_NIBE.json → values.12.title | 12 = 12 hours | 12 hours
hotwater_increase_NIBE.json → values.24.title | 24 = 24 hours | 24 hours
hotwater_increase_NIBE.json → values.48.title | 48 = 48 hours | 48 hours
hotwater_periodic_interval_NIBE.json → title | Periodic hotwater interval set | Periodic hot water interval
hotwater_periodic_interval_NIBE.json → values.7.title | 7 = Days | 7 days
hotwater_periodic_interval_NIBE.json → values.14.title | 14 = Days | 14 days
hotwater_periodic_interval_NIBE.json → values.21.title | 21 = Days | 21 days
hotwater_periodic_interval_NIBE.json → values.28.title | 28 = Days | 28 days
hotwater_periodtime_NIBE.json → title | Periodic hotwater length set | Periodic hot water length
hotwater_periodtime_NIBE.json → values.30.title | 30 = Minutes | 30 minutes
hotwater_periodtime_NIBE.json → values.45.title | 45 = Minutes | 45 minutes
hotwater_periodtime_NIBE.json → values.60.title | 60 = Minutes | 60 minutes
hotwater_periodtime_NIBE.json → values.120.title | 120 = Minutes | 120 minutes
measure_count_NIBE.json → title | Measure Count | Count
measure_enum_NIBE.json → title | Measure enum | Status
measure_hour_NIBE.json → title | Measure Hour | Runtime
measure_minute_NIBE.json → title | Measure Minute | Duration
measure_percentage_NIBE.json → title | Measure percentage | Percentage
app.json → description | Local Nibe control, split into the devices you actually automate | Local control of your NIBE heat pump, with a device for each function
registers.ts:127 info.en | The temperature at one wireless room sensor. NIBE's slot order follows neither the zones nor menu 5.4, so match it by its reading | The temperature at one wireless room sensor. The slot order doesn't follow the zones or menu 5.4, so identify it by its reading
registers.ts:130 info.en | Supply temperature the pump is aiming for (climate system 1) | Supply temperature your heat pump is aiming for (climate system 1)
registers.ts:149 info.en | Brine temperature entering the pump (BT10) | Brine temperature entering your heat pump (BT10)
registers.ts:151 info.en | Brine temperature leaving the pump (BT11) | Brine temperature leaving your heat pump (BT11)
registers.ts:154 info.en | What the pump is producing right now (heating, hot water, pool…) | What your heat pump is producing right now (heating, hot water, pool…)
registers.ts:168 info.en | Undocumented second priority register, logged for comparison against 1028 | Undocumented second priority value, logged for comparison with Priority
registers.ts:175 info.en | Total electrical power used by the pump right now | Total electrical power used by your heat pump right now
registers.ts:192 info.en | Total electrical power used by the pump right now (energy log, averaged) | Total electrical power used by your heat pump right now (energy log, averaged)
registers.ts:223 info.en | Whether the internal electric additional heat is running | Whether the immersion heater is running
registers.ts:227 info.en | Incoming main fuse rating | Main fuse rating
registers.ts:238 info.en | Power from the internal electric additive heater | Power from the immersion heater
registers.ts:241 info.en | Total runtime of the additive heater | Total runtime of the immersion heater
registers.ts:243 info.en | Additive heater runtime spent on hot water | Immersion heater runtime spent on hot water
registers.ts:250 info.en | Average outdoor temperature — what the heating cut-off is judged against | Average outdoor temperature, used to decide when heating stops
registers.ts:260 info.en | Heat energy the pump has delivered since this device was added | Heat energy your heat pump has delivered since this device was added
registers.ts:262 info.en | Electricity the pump has consumed since this device was added | Electricity your heat pump has used since this device was added
registers.ts:269 info.en | Heat energy delivered to heating (incl. electric additive) | Heat energy delivered to heating, including the immersion heater
registers.ts:271 info.en | Heat energy delivered to hot water (incl. electric additive) | Heat energy delivered to hot water, including the immersion heater
registers.ts:395 info.en | The indoor temperature the pump aims for (menu 1.1, the chosen zone) | The indoor temperature your heat pump aims for (menu 1.1, the chosen zone)
registers.ts:416 info.en | Smart Price Adaption — shift consumption towards cheaper hours | Smart price adaption. Shifts consumption towards cheaper hours
registers.ts:450 info.en | Let Smart Price Adaption act on heating | Let Smart price adaption act on heating
registers.ts:487 info.en | Let Smart Price Adaption act on hot water | Let Smart price adaption act on hot water
registers.ts:493 info.en | Let Smart Price Adaption act on cooling | Let Smart price adaption act on cooling
registers.ts:500 info.en | Whether room sensor regulation is switched on for climate system 1 | Whether room-sensor control is on for climate system 1
registers.ts:516 info.en | More hot water: a one-time 2-hour boost | A one-time 2-hour hot water boost
registers.ts:526 info.en | Operating mode: auto, manual or additional heat only | Auto, manual or immersion heater only
registers.ts:577 info.en | Selector for the heat curve slope (0–10) | Selector for the heat curve slope (0–15)
registers.ts:596 info.en | Lowest supply temperature the pump may produce (climate system 1) | Lowest supply temperature your heat pump may produce (climate system 1)
registers.ts:598 info.en | Highest supply temperature the pump may produce (climate system 1) | Highest supply temperature your heat pump may produce (climate system 1)
registers.ts:602 info.en | Outdoor temperature where automatic mode stops the additive heater | Outdoor temperature where automatic mode stops the immersion heater
registers.ts:604 info.en | How long the pump makes heating before switching demand | How long your heat pump heats the house before it moves on to hot water or pool
registers.ts:609 info.en | How many degree minutes below the compressor start the additive heater joins in | How many degree minutes below the compressor start the immersion heater joins in
registers.ts:657 info.en | Stop temperature for the periodic anti-legionella hot water charge. Reaching it usually needs the immersion heater — a compressor alone tops out in the high 50s, and lower still when the ground loop is cold. | Stop temperature for the periodic anti-legionella hot water charge. It usually needs the immersion heater.
registers.ts:660 info.en | How long the pump heats the pool before switching demand | How long your heat pump heats the pool before it moves on to heating or hot water
registers.ts:664 info.en | Acknowledge and reset an active alarm on the pump | Acknowledge and reset an active alarm on your heat pump
registers.ts:685 info.en | Nibe's permit for additional heat, which they label as heating-only. Note the pump's own schedule modes carry a separate, global "block additional heat" that this cannot see or override. | NIBE's permit for the immersion heater, labelled for heating only. A block set in your heat pump's schedule still applies.
registers.ts:706 info.en | Allow hot water. Off disables all hot water, including the More hot water boost | Off turns off all hot water, including More hot water

## Help pages

All 11 pages changed. Text only: no class, link, crumb, menu number, SVG shape or structure changed.
The only element removed is one `<b>` in hot-water.html (its bold line was dropped) and one in troubleshooting.html.
Tag balance checked with an HTML parser on every page: all balanced.

## Every page
| location | before | after |
|---|---|---|
| footer (11 pages) | Homey app for Nibe heat pumps | Homey app for NIBE heat pumps |
| "Good to know." h2 (10 pages) | Good to know. | Good to know |
| all tile/step h3s | trailing full stop | no full stop |

## Headings in full

### index.html (title "Help · Nibe Live")
| location | before | after |
|---|---|---|
| h1 | Your heat pump. In Homey. | Help |
| fact tiles | Local. / Split. / Smart. | Local / Split / Autopilot |
| topic h3s | Getting started. / One heat pump, several devices. / Heating. / Hot water. / Energy and COP. / Smart mode. / Autopilot for heating. / Autopilot for hot water. / Flows. | same without full stops |

### getting-started.html (title "Getting started")
| location | before | after |
|---|---|---|
| h1 | Your heat pump. In Homey. | Getting started |
| h2 | First, at the heat pump. | On your heat pump |
| h3 | Update first. / Turn on Modbus TCP. / Same network. | Update the software / Turn on Modbus TCP / Same network |
| h2 | Homey does the looking. | Adding it in Homey |
| h3 | Find your heat pump. / Detecting features. / Add devices. | no full stops |
| h2 | Choose what you want to see. | Choosing devices |
| h3 | Ticked where there's data. | Devices with data come ticked |
| h3 | Up to six. | Up to six devices |
| h3 | A little setup, then done. | Device setup |
| h2 | Give it a few days. | When the numbers appear |
| h3 | Right away. / From today. / After a month. | Right away / From the day you add it / After a month |

### devices.html
| location | before | after |
|---|---|---|
| title | Devices · Nibe Live | One heat pump, several devices · Nibe Live |
| h1 | One heat pump. Several devices. | One heat pump, several devices |
| h2 | A tile for every job. | The devices |
| h3 | Main. Heating. Hot water. Pool. Cooling. Solar. | no full stops |
| h3 | Up to six. | Up to six devices |
| h2 | Each one counts for itself. | Energy per device |
| h3 | Energy used. / Energy delivered. / COP. | no full stops |
| h2 | Automate one job. Leave the rest. | Automating one job |
| h3 | Running low. | Hot water running low |
| h3 | Away for the week. | Hot water off while you're away |
| h3 | On means on. | The on/off switch |
| h2 | Change your mind anytime. | Changing devices later |
| h3 | Pair again. / Use Repair. / Delete it. | no full stops |

### heating.html
| location | before | after |
|---|---|---|
| title | Heating · Nibe Live | The Heating device · Nibe Live |
| h1 | Warm rooms. Your rules. | The Heating device |
| h2 | A real thermostat. | The thermostat |
| h3 | See it. / Shape it. / Switch it. | Readings / Heat curve / On and off |
| h2 | Summer, sorted. | Heating in summer |
| h3 | Only heat below. | Only heat below |
| h3 | Measured over time. | Average outdoor temperature |
| h2 | Let your rooms guide it. | Using your own room sensors |
| h3 | Pick your sensors. / Let it listen. / Verify settings. | Pick your sensors / Turn on the external sensor / Verify settings |
| h2 | Your heat pump, still in charge. | How your heat pump uses the sensors |
| h3 | Same thermostat. Same settings. | Your thermostat and settings |
| h3 | Every 30 seconds. | Sent every 30 seconds |
| h3 | Two zones? You choose. | More than one zone |
| h2 | Outdoor temperature, from a Flow. | Outdoor temperature from a Flow |
| h3 | Allow it. / Keep it coming. / Look at the display. | Turn on external BT1 / Send it regularly / Check the display |

### hot-water.html
| location | before | after |
|---|---|---|
| title | Hot water · Nibe Live | The Hot water device · Nibe Live |
| h1 | Hot water. In litres. | The Hot water device |
| h2 | One tile. Everything hot water. | What the device shows |
| h3 | What's left. / How it heats. / What it costs. | no full stops |
| h2 | Litres you can shower in. | Hot water available |
| h3 | Not how full. How much shower. | What the litres mean |
| h3 | From a 178-litre tank. | A 178-litre tank |
| h3 | It needs your tank. | Your tank |
| h3 | Incoming water, learned. | Incoming water temperature |
| h2 | Need more? Ask for it. | More hot water |
| h3 | Hotter than you set. | Why a boost runs hotter |
| h3 | Or short of the mark. | Why a boost stops short |
| h2 | Cancel stops the ask. Not the run. | Turning off More hot water |

### energy.html (title "Energy and COP")
| location | before | after |
|---|---|---|
| h1 | Every kWh. In its place. | Energy and COP |
| h2 | One meter. Shared out. | How energy is shared out |
| h3 | Whatever's running gets the bill. | Energy goes to the job that's running |
| h3 | Add every job you have. | Jobs without a device |
| h3 | Heat out, measured. | Energy delivered |
| h2 | COP, in plain words. | What COP means |
| h3 | A COP of 3. / The last 30 days. | no full stops |
| h3 | Trust Total COP most. | Total COP is the most accurate |
| h2 | Close to myUplink. Not identical. | Compared with myUplink |
| pill | Live, not hourly | Counted live |
| pill | Gaps stay gaps | Gaps aren't filled |

### smart-mode.html (title "Smart mode")
| location | before | after |
|---|---|---|
| h1 | Pick who plans. | Smart mode |
| h2 | Three choices. Side by side. | The choices |
| h3 | Off. / Smart price adaption. / Autopilot. | no full stops |
| h3 | Autopilot, simulated. | Autopilot · Simulated |
| h2 | Different strengths. | Which one to choose |
| h3 | Learns your home. / Works from day one. | no full stops |
| h3 | Nothing moves. | Ignores prices |
| h2 | Heating and hot water today. | What Autopilot covers |
| h2 | Three taps away. | Where to change it |
| h3 | Pick one. / Follow the checks. / See what changes. | Pick a mode / Follow the checks / See what changes |

### autopilot-heating.html (title "Autopilot for heating")
| location | before | after |
|---|---|---|
| h1 | Warm home. Smarter hours. | Autopilot for heating |
| h2 | Your house is a battery. | How Autopilot shifts heat |
| h3 | It looks ahead. | Prices and weather |
| h3 | It stores a little warmth. | Before prices rise |
| h3 | It coasts through the peak. | During the most expensive hours |
| h2 | It speaks your heat pump's language. | How Autopilot controls your heat pump |
| h3 | A nudge on the thermometer. | The outdoor temperature (BT1) |
| h3 | That's why setup asks. | External outdoor sensor |
| h3 | How far it may go. | Comfort range |
| h3 | Away, for the holidays. | Away |
| h3 | It needs to feel the room. | What Autopilot needs |
| h2 | Always says what it's doing. | What Autopilot is doing |
| h2 | Watch first. Then hand over. | Trying Autopilot first |
| h3 | Room-sensor control off. / External outdoor sensor allowed. / One planner. | Room-sensor control off / External outdoor sensor on / One planner |

### autopilot-hot-water.html (title "Autopilot for hot water")
| location | before | after |
|---|---|---|
| h1 | Hot water. When it's cheap. | Autopilot for hot water |
| h2 | Three things. Every fifteen minutes. | What Autopilot checks every fifteen minutes |
| h3 | It watches prices. / It knows your routine. / It picks the moment. | Prices / Your routine / The best time to charge |
| h2 | Made for how you actually live. | Settings |
| h3 | Weekends, handled. | Working days and days off |
| h3 | Twice the heating. | Heating on a day off |
| h3 | Always enough for a shower. | Always enough for a shower |
| h3 | Sun in. Hot water out. | Solar power |
| h3 | Two switches. That's it. | Solar settings |
| h2 | Always knows why. | The reason for each charge |
| h2 | Try it first. Nothing changes. | Trying Autopilot first |
| h3 | Hourly prices. / Your tank. / One planner. | no full stops |

### flows.html (title "Flows")
| location | before | after |
|---|---|---|
| h1 | Your home. Your rules. | Flows |
| h2 | Cards that say what they do. | Flow cards |
| h3 | One card per setting. | One card per setting |
| h3 | Old Flows keep running. | Cards from earlier versions |
| h3 | Autopilot, in your Flows. | Autopilot cards |
| h3 | Tell it about your day. | Day type and Away |
| h2 | Three to start with. | Example Flows |
| h3 | Day type from your calendar. | Day type from your calendar |
| h3 | Away for the holidays. | Away while on holiday |
| h3 | A heads-up when the tank heats. | A notification when a charge starts |
| h2 | Plan around it. | Planning around Autopilot |

### troubleshooting.html (title and h1 "Something looks wrong?" kept: a plain question)
| location | before | after |
|---|---|---|
| h2 | Connection. / Values. / Hot water. / Flows. | no full stops |

## Body changes per page (main pairs)

### index.html
| before | after |
|---|---|
| meta: your Nibe heat pump | your NIBE heat pump |
| Nibe Live talks to your Nibe heat pump directly, over your own network. No cloud account, no waiting. | Nibe Live connects to your NIBE heat pump directly over your own network, without a cloud account. |
| what More hot water really does | what More hot water does |
| Off, Smart price adaption or Autopilot. Which one is for you. | Off, Smart price adaption or Autopilot, and which one to choose. |
| The questions people ask most, answered. | Answers to the most common questions. |

### getting-started.html
| before | after |
|---|---|
| **No cloud account. Readings in seconds.** | **It works without a cloud account, and readings arrive in seconds.** |
| …so the heat pump has to allow it. That's one switch on its display. | …so your heat pump has to allow it. You turn that on with one setting on its display. |
| what your model and accessories actually have | what your model and accessories have |
| Nibe's cloud … at the same time: your heat pump takes one at a time. | NIBE's cloud … at the same time. Your heat pump takes one at a time. |
| COP is the exception: it's blank on purpose until there's enough to go on. | COP is the exception. It stays blank until there's enough to go on. |

### devices.html
| before | after |
|---|---|
| Add the ones your heat pump actually does. | Add the ones for the jobs your heat pump does. |
| The heat pump itself. … alarms in plain words instead of codes | Your heat pump as a whole. … alarms in plain words |
| no off switch for the whole unit | no off switch for the whole heat pump |
| so you can finally see what your hot water costs | so you can see what your hot water costs |
| Heating carries on as usual. | Heating keeps running. |
| …is a real control. | …controls your heat pump. |
| Nothing is fixed after pairing. | You can add, change or remove devices after pairing. |
| add every job you want metered: skip Hot water, and the energy… | add every job you want metered. If you skip Hot water, the energy… |
| Your heat pump's real total | Your heat pump's total |

### heating.html
| before | after |
|---|---|
| **And it can listen to the sensors you already have.** | **It can also use the temperature sensors you already have in Homey.** |
| the colder it is outside (aria-label, phone note) | the colder it is/gets outdoors |
| Two settings decide when your heat pump bothers to heat at all. | Two settings decide when your heat pump heats. |
| does the same for the electric heater | does the same for the immersion heater |
| …average outdoor temperature, not this minute's. So a warm afternoon… | …average outdoor temperature, so a warm afternoon… |
| Pick one, or several: each counts equally. | Pick one or several. Each counts equally. |
| Setup lists the menus: turn on the external room sensor (setup calls it BT50) in 7.5.9.2, give it your heating zone in 1.3.3 / 1.3.4 | Setup lists the menus. Turn on the external room sensor (BT50) in menu 7.5.9.2, give it your heating zone in menu 1.3.3 / 1.3.4 |
| It keeps going after you close Repair. | Sending continues after you close Repair. |
| With Nibe's wireless room sensors | With NIBE's wireless room sensors |
| **Set outdoor temperature (BT1)** hands your heat pump… | **Set outdoor temperature BT1 to …** sends your heat pump… |
| status: Set outdoor temperature (BT1): 4.5 °C | Set outdoor temperature BT1 to 4.5 °C |
| The card sends one reading. Your Flow has to send fresh ones regularly, even when… | The card sends one reading per run. Your Flow has to repeat it every few minutes, even when… |
| A Flow that succeeds means your heat pump accepted the value, not that heating uses it. Check its outdoor reading follows. | A Flow that succeeds only means your heat pump accepted the value. Check that its outdoor reading follows. |
| It's warmer outside than Only heat below, but it's still heating. | The outdoor temperature is above Only heat below, but it's still heating. |
| It never quietly leaves a room out of the average. | Homey never drops a room from the average without telling you. |
| Only if … (BT50) turned on, so it reports no sensor fault. Room-sensor control stays off, so your heat pump only shows the temperature. Autopilot keeps it at your thermostat. | Only if … (BT50) turned on. The room temperature is then sent as BT50 to prevent sensor alarms. Room-sensor control must be off, so your heat pump only shows the temperature, and Autopilot keeps it at your thermostat. |
| That's who moves heating to cheaper hours | Smart mode decides who moves heating to cheaper hours |

### hot-water.html
| before | after |
|---|---|
| …tells you how much shower is left in your tank, and lets you ask… **No more guessing from temperatures.** | …tells you how much shower is left in your tank, in litres, and lets you ask… (bold line dropped) |
| the same measure Nibe prints | the same measure NIBE prints |
| Hot water stretches. At 55 °C, a 178-litre tank holds this much 40 °C shower water once it's mixed with cold. | Mixed with cold water, a 178-litre tank at 55 °C gives this much 40 °C shower water. |
| A real boost on a heat pump set to Small | A measured boost on a heat pump set to Small |
| schedules can block additional heat | schedules can block the immersion heater |
| That's normal protection for the compressor, not a fault. | That protects the compressor. |
| That's right, oddly enough. | That's right. |
| It's counting showers, not filling. | (dropped, repeats the sentence before) |
| Treat it as a good guide, not a meter. | Treat it as a good guide. |
| No. Nibe shows hot water in minutes | No. NIBE shows hot water in minutes |

### energy.html
| before | after |
|---|---|
| **So you can finally see what your hot water costs.** | **This shows what your hot water costs.** |
| Your heat pump has one electricity meter, not four. But it always says what it's busy with. | Your heat pump has one electricity meter, and it also reports what it's working on. |
| your heat pump's real total | your heat pump's total |
| …lands on Main instead. Nothing goes missing. It's counted on Main instead of on its own. | …is counted on Main. |
| so it's read straight off and not estimated | so Nibe Live reads it directly |
| what a cold snap or a settings change actually did | what a cold snap or a settings change did |
| Heating COP (30-day) and friends. | Heating COP (30-day) and the matching COP on each device. |
| Close, but Total COP is the one to quote. | The two are close, but Total COP is the one to quote. |
| Totals start when you added the device, not when your heat pump was installed. Compare a day or a week, not the totals. | Totals start from the day you added the device. Compare a day or a week. |
| Main isn't the whole heat pump. It carries standby… | Main only carries standby… |
| stays blank rather than showing nonsense | stays blank |
| Without it there's no COP, but the energy used still works. | Without it there's no COP. Energy used still works. |
| Nibe's cloud | NIBE's cloud |

### smart-mode.html
| before | after |
|---|---|
| Pairing asks for it. You can change your mind any time. | Pairing asks for it, and you can change it any time. |
| Nobody shifts anything. … The way it's always worked. | Nothing is moved to cheaper hours. … (closer dropped) |
| It plans everything and tells you what it would do. Your heat pump doesn't notice a thing. A good way to get to know it before you switch to Live. | Simulated previews the plan without making changes to your heat pump. Use it to get to know Autopilot before you switch to Live. |
| There's no wrong answer. It depends on what you want. | Each choice has different strengths. It depends on what you want. |
| your full electricity price, not only the spot price | your full electricity price, which includes more than the spot price |
| Simple and predictable. | (dropped) |
| Every reading and setting that comes or goes, and why. | It lists every reading and setting that's added or removed, and why. |
| Your heat pump wins. | Your heat pump's setting takes priority. |
| No. It plans and shows you the plan, and your heat pump runs exactly as before. | No. Simulated previews the plan without making changes to your heat pump. |
| Because it's new. You'll see the badge … so it's always clear which parts are fresh. | Autopilot is new. The badge shows wherever you choose Autopilot or see what it's doing. |
| is a perfectly good mix | is a good combination |

### autopilot-heating.html (warmth kept; only AI-voice habits removed)
| before | after |
|---|---|
| **Always within the comfort range you pick.** | **It stays within the comfort range you pick.** |
| Autopilot learns how long yours does, and uses it. | Autopilot learns how long your house holds it, and uses that. |
| Before prices climb, your home gets slightly warmer than usual. Never past your comfort range. | Your home gets slightly warmer than usual, within your comfort range. |
| the house gives back what it stored | the house gives back the heat it stored |
| No new controls inside your heat pump. Autopilot changes one thing it already listens to. | Autopilot changes the outdoor temperature (BT1) your heat pump uses. |
| Autopilot sends it a slightly different one: a touch colder before a price peak, so it heats more, and a touch milder during it, so it heats less. Your heat pump does the rest, same as always. | Before a price peak, Autopilot sends it a slightly lower temperature, so it heats more. During the peak it sends a slightly higher one, so it heats less. Everything else runs on your heat pump's own settings. |
| flow chips: Real outdoor › Autopilot's nudge | Measured outdoor › Outdoor shift |
| checks it worked | checks that it works |
| For a week or more away, not a day at work. | Away is for a holiday of a week or more. |
| Learning: At least five days, and nothing changes yet. | This takes at least five days, with no changes yet. |
| Holding: Nothing to gain right now, or prices are too even to bother. | No change planned right now, for example when prices are too even to shift heat. |
| Paused: Something it needs is missing… The line says what. | Something Autopilot needs is missing… Autopilot now shows what. |
| …fills in Autopilot now as if it were running, without touching your heat pump. | …fills in Autopilot now without making changes to your heat pump. |
| A small, steady offset it corrects slowly, over a few days. | It corrects a small, steady offset slowly, over a few days. |
| sees the real outdoor temperature | sees the measured outdoor temperature |

### autopilot-hot-water.html (warmth kept; only AI-voice habits removed)
| before | after |
|---|---|
| **No schedules. Nothing to tune.** | **There's no schedule to set.** |
| when prices bottom out | when prices are lowest |
| Today's and tomorrow's, straight from Homey Energy. | (unchanged) |
| Your heat pump does the heating, same as always. | Your heat pump does the heating with its own settings. |
| Days off look nothing like workdays. … Holiday or working from home? Change it on the Main device… | Days off use hot water differently from working days. … Taking a day off or working from home? Change the day type on the Main device… |
| bars label: Workday | Working day (matches the day type) |
| aria: on a real tank: workdays spread… | on a measured tank: working days spread… |
| That's what a day off needed, on a real tank measured over a month. Mostly before noon. | A day off needed twice the heating of a working day, measured on one tank over a month. Most of it came before noon. |
| A bigger cushion means the odd charge at a pricier hour. | A bigger safety net means some charges happen in more expensive hours. |
| …the tank can take it instead. Only what would go to the grid, so a battery or car charger always gets the sun first. | …Autopilot can heat the tank with it instead. It only uses what would go to the grid, so a battery or car charger gets the solar power first. |
| Skips a night charge when sun's forecast. Pauses itself if the forecast keeps missing. | Skips a night charge when sun is forecast. Pauses if the forecast is often wrong. |
| Your heat pump stepped in on its own. | Your heat pump started the charge itself. |
| Autopilot plans every charge and tells you what it would do, without touching your heat pump. When you agree with it… | Simulated previews every charge without making changes to your heat pump. When you agree with the plan… |
| only keeps your minimum warm | only keeps the safety net warm |

### flows.html
| before | after |
|---|---|
| **And the rest of your home can react to it.** | **The rest of your home can react to it too.** |
| No long lists to scroll through. Each card is named… | Each card is named… |
| for workdays and days off | for working days and days off |
| Holidays and days working from home, without touching anything. | Days off and days working from home, set by your calendar. |
| Whether Autopilot started it or your heat pump did, you'll know why. The card hands you the reason to use in the message. | The card gives you the reason to use in the message, whether Autopilot or your heat pump started the charge. |
| Does A hot water charge started fire … It fires for every charge | …trigger … It triggers for every charge |

### troubleshooting.html
| before | after |
|---|---|
| **Most have a simple cause.** | (dropped) |
| Wi-Fi is the usual suspect. | Wi-Fi is the most common cause. |
| It won't guess between two. | If it finds more than one, it changes nothing. |
| Nibe's cloud (2x) | NIBE's cloud |
| which is exactly what to send | which is what to send |
| compare how much it changed over a day, not the totals | compare how much it changed over a day |
| stays blank rather than showing a made-up number | stays blank |
| Nibe Live shows nothing rather than mixing a fresh number with an old one. | Nibe Live leaves the value blank. |
| The classic one: with Allow hot water off, it rejects… | The most common case is Allow hot water. When it's off, your heat pump rejects… |
| the log says exactly what was refused | the log shows what was refused |
| Turning on Debug logging first means the log already holds the answer. | Turn on Debug logging first, so the log has the details. |

## Left as is, on purpose
- "Heat curve displacement" (heating.html bold name, SVG label "Displacement up", chip "Set heat curve displacement"): it is the on-screen setting and Flow name today and not in the rename list. Change together if the app renames it to "Heat curve offset".
- Chip "Set the hot water stop temperature (Medium)" (flows.html): Flow title with parentheses. The new title isn't known yet, so it stays until the app text agent settles it.
- Status line "Easing off · Until 19:00: prices peak 17:00–19:00" (autopilot-heating.html) mirrors the app's status format. Match it to whatever the app shows after its pass.
- "Not really." (stop a charge halfway) kept as warm, plain answer.
- troubleshooting.html title/h1 "Something looks wrong?" kept: a plain question, matches the index tile.

## FAQ and announcements

The original FAQ is saved at scratchpad/FAQ.orig.md. Use `diff` against it for the full text. Rows are grouped
by question. "Global" rows apply to every question.

## Global (FAQ)

| Where | Before | After |
|---|---|---|
| whole file | "the pump" / "pump" (79 lines) | "your heat pump", or "it" |
| whole file | register(s) | reading(s), setting, or "Modbus list" |
| whole file | poll / polls / next poll / one poll | update / reads / next update / one update |
| whole file | em-dash asides (about 40) | full stops or parentheses |
| whole file | MyUplink, Nibe's cloud, Nibe pumps | myUplink, NIBE's cloud, NIBE heat pumps |
| whole file | Heating Setup / Hot Water Setup / Hot Water device / Smart Price Adaption | Heating setup / Hot water setup / Hot water device / Smart price adaption |
| whole file | firmware | software |
| whole file | Flow action | Flow card |
| whole file | semicolons in bullet lists | full sentences per bullet |

## Per question (FAQ)

| Where | Before | After |
|---|---|---|
| F-series heading + Q | ## F-series beta / What does the F-series beta support? / Choose **Nibe F-series (beta)** | ## F-series (experimental) / What does the F-series driver support? / Choose **Nibe F-series (experimental)** (FACT) |
| F-series energy | Energy allocation is experimental. F730 testing has shown changing compressor-power readings, but their watt scaling remains unverified… Do not treat beta energy figures as a verified meter. | Splitting energy between functions is experimental. On an F730 the compressor power reading moved, but its scale in watts isn't verified… Don't treat F-series energy figures as a verified meter. |
| Heating cutoff | From 1.4.2, the S-series operational explanation uses the average too, and omits the cutoff explanation if that reading is unavailable. | Since 1.4.2, the app's explanation of what your heat pump is doing uses the average too, and leaves out the heating-stop reason if that reading isn't available. |
| Own sensors | Yes, with a pump and firmware supporting external BT50. … or select **Show all**. | Yes, if your heat pump and its software support an external room sensor (BT50). … or select **Show all sensors**. (FACT: on-screen name) |
| Own sensors | three selected sensors each contribute one third | With three sensors, each counts for a third. |
| What do I change on the pump? | Unchanged temperatures are resent every 30 seconds. / Pairing saves a pending selection; finish activation in Repair while you can access the pump. | The temperature is sent again every 30 seconds, even when it hasn't changed. / Pairing saves your choice without sending anything. Finish the setup in Repair when you're at your heat pump. |
| Autopilot follows thermostat | moves heat in time around it… With Comfort range Off it neither shifts nor steers. | shifts heating in time within your comfort range… With Comfort range Off, Autopilot doesn't shift or steer. |
| Autopilot follows thermostat, para 2 | Room-sensor control on the heat pump must stay off, because Autopilot does that job itself. Your Homey sensors are what Autopilot regulates on; they are still sent as BT50 …, or it raises a BT50 sensor fault (alarm 153), but with room-sensor control off it only shows them: in … | Room-sensor control on your heat pump must be off. Autopilot regulates on your Homey sensors. They're still sent to your heat pump as BT50 while external BT50 is on (menu 7.5.9.2), to prevent a BT50 sensor alarm (alarm 153). With room-sensor control off, your heat pump only shows them. In …, right after Smart mode, Autopilot asks which indoor temperature to hold: your heat pump's own sensor or Homey sensors. |
| Sensor stops reporting | A source's last temperature-change timestamp does not determine this schedule and does not expire the reading. / It does not silently drop a room… | When a sensor last changed doesn't affect this, and an old reading doesn't expire. / The app doesn't drop a room from the average on its own. |
| Sensor stops reporting | Do not assume it automatically returns to the native sensor. | Don't assume it switches back to its own sensor by itself. (FACT: old name "native sensor") |
| Return to own sensor | ### How do I return to the pump's own sensor? … restore the native sensor … **Use the heat pump’s native temperature sensor** | ### How do I go back to my heat pump's own sensor? … make its own sensor the zone's controlling sensor again … **Use your heat pump’s own temperature sensor** (FACT) |
| Wireless sensors | The pump gives the sensors no names… so the reading is how you tell them apart. | Your heat pump doesn't name the sensors… so use the reading to tell them apart. |
| Zones | Until 1.5.0 … which on some pumps is a zone that only displays. | Before 1.5.0 … which on some heat pumps only displays. |
| Set outdoor temperature (BT1) | This Heating Flow action sends one outdoor-temperature reading. … A successful Flow action confirms the write was accepted, not that the pump is using it. … The wired-sensor fallback and loss-of-feed behaviour are not verified; | This Heating Flow card sends one outdoor temperature reading. … If the card succeeds, your heat pump accepted the value, but that doesn't prove it uses it. … What happens when the readings stop isn't verified. |
| Tank settings | Autopilot's **Always keep at least** … The existing tank catalogue… custom capacity | Autopilot's **Always enough for a shower** … The tank list… custom size (FACT) |
| Agree with display | Those are read straight from the pump's registers… that's a bug worth reporting. / Energy and COP are a different story; see below. | The app reads those straight from your heat pump… report it as a bug. / Energy and COP work differently. See below. |
| Software update | Many registers the app uses only exist on recent firmware … booking several times too much | Many readings the app uses only exist on recent software … counting several times too much |
| Energy total | Counters are **baselined when you add the device** … That's deliberate — it's what lets the per-device figures reconcile… | Counters start at zero **when you add the device**… That's what lets the figures on each device add up to the same total. |
| Solar | The tile was right the whole time — it was the Energy tab that saw nothing. … not from when the panels were installed — same as every other | The tile was right. … counts from when you added the device, like every other energy figure |
| Main shows little | Because Main is the **remainder**, not the whole pump. … The capability is titled "Total energy consumed" on every device, which is misleading on Main specifically — … It's a known wart, not a miscalculation. | Main shows what's left over: standby draw… On Main this figure is called **Idle energy**. On the other devices it's **Energy used**. (FACT) |
| How electricity is split | Your pump has one electricity meter, not four. … So every few seconds the app asks both questions | Your heat pump has one electricity meter for everything. … On every update (every 10 seconds by default) the app reads both (FACT) |
| 0 kWh used | The register the app relies on … (1028) … degree minutes crossing the compressor-start threshold … undocumented second register … Not available on every model — | The reading the app uses for "what is your heat pump working on" sometimes said idle… The app now cross-checks that reading against a second one… The S2125, S320/S325 and S330/S332 don't have the second reading |
| Per-function figures | …is the best of both: timely numbers, continuously audited… / very good estimate, not a meter reading… Both are the price of having numbers that arrive while they still matter. | So the app uses the live method and checks it against your heat pump's hourly figures every hour. / a close estimate from live readings… Your heat pump keeps counting, but the app can't see it. |
| Ten minutes | can look catastrophic while both figures are perfectly fine. … quiet accumulation | can look far off while both figures are fine. … slow build-up |
| Power right now | This app polls the pump directly every 5 seconds; myUplink goes via Nibe's cloud | Nibe Live reads your heat pump directly every 10 seconds by default. myUplink goes through NIBE's cloud (FACT) |
| Menu 3.1 | The pump computes it — that's the filling bar — but publishes no Modbus register for it. … six S-series register maps | Your heat pump works it out (that's the filling bar in the menu) but doesn't make it available over Modbus. … six S-series Modbus lists |
| COP blank | One of three reasons, all intentional: … more honest than showing zero. | One of three reasons: … so it shows nothing instead of zero. |
| Which COP | reconciles with myUplink … inherits the attribution's error — small, but present. | matches myUplink … carries the estimate's small error. |
| 30 days | so you can actually see … a cold snap | so you can see … a cold spell |
| COP 15 | so a numerator covering months was divided by a denominator covering hours. … discarded rather than migrated | So months of heat were divided by hours of electricity. … The affected history was discarded |
| Hot water left | …and what you actually care about, since 175 litres at 55 °C is a lot more than 175 litres of shower. … it is not measuring how full the tank is, it is measuring how much showering is in it. / Treat it as a good guide, not a gauge. … under-reports a shower | …and it's what matters for a shower. 175 litres at 55 °C gives a lot more than 175 litres of 40 °C water. … Hot water mixed down to 40 °C makes more than the tank holds. / Treat it as a guide. … during a shower it lags behind the water being used. |
| Went to zero | That is correct. … below 40, there is none — even though | That's expected. … below 40 °C, there is none, even if |
| Blank or missing | ### Hot water available is blank, or the capability is missing. … clears on the next poll. | ### Hot water available is blank or missing. … clears on the next update. |
| Boost past stop | promotes the pump to its **Large** hot water mode and charges to *that* stop temperature | switches your heat pump to its **Large** hot water mode and heats to *that* stop temperature |
| Boost stops short | the app's **Allow additional heat** … — see the schedules question above. | **Allow immersion heater** in the app … (schedules pointer dropped, no such question) (FACT) |
| Cancel More hot water | …status registers both reset within one poll … That's normal short-cycling protection, present on essentially every heat pump, not a bug here. … not something the app does silently and routinely on your behalf. | …status readings both reset within one update … Your heat pump finishes that cycle to protect the compressor, like any heat pump. … It's something you can choose to do now and then. |
| Where did night cooling go? (Setup section) | Since 1.4.4 it is on the **Heating** device… | Question deleted (FACT; the fan/night cooling question above already answers it: Main since 1.4.7) |
| myUplink at once | never touches Modbus. What you *can't* do is point a second **Modbus** integration at the pump — | doesn't use Modbus. You can't connect a second **Modbus** integration to your heat pump at the same time. |
| Autodetect | ### Autodetect didn't find my pump. … that path always works. | ### Autodetect didn't find my heat pump. … That always works. |
| Can't reach | ### My devices say "Can't reach the heat pump". … (up to once a minute) … posts a notification | ### My devices say "Can't reach your heat pump". … (down to once a minute) … sends a notification (FACT: quote) |
| No data | "Answers, but returns no heat pump data" … which used to show as -1 on every capability | "Returns no NIBE data" … This used to show as -1 everywhere. (FACT: quote) |
| Blank forever | ### A capability sits blank forever. Your model probably doesn't implement that register. Turn on **Debug logging** in the app's advanced settings: it names every register | ### A reading stays blank. Your model probably doesn't have that reading. Turn on **Debug logging** under **Advanced** in the device's settings. It lists every reading (FACT: location) |
| Modbus error | ### Why did a Flow action fail… The pump refuses writes… block the demand-mode and "More hot water" registers entirely. | ### Why did a Flow card fail… Your heat pump refuses changes… block demand mode and "More hot water" entirely. |
| What usage data sends | ### What does "Share anonymous usage data" actually send? … whether register detection worked … | ### What does "Share anonymous usage data" send? … alarm codes, how Autopilot is set up and how each day went, whether detection worked … (FACT: list matches the setting's hint) |
| What usage data sends | That is a deliberate line, not an oversight: a timestamped log… and it answers none of the questions the data exists to answer. … no pump serial | A timestamped log… and none of the questions the data is for need it. … no serial number |
| Why at all | the people whose setup works never post about it. Knowing which models and functions are actually out there is what decides where effort goes. | people whose setup works don't post about it. Knowing which models and functions are in use decides where the work goes. |
| Turn it off | **More → Apps → Nibe Live → Configure**, then untick it under **Privacy**. | Open the settings of any Nibe device and untick **Share anonymous usage data** under **Privacy**. It changes for all your Nibe devices and takes effect straight away. (FACT: location) |
| Where stored | it is not transferred outside. … lists every single event | It isn't transferred outside the EU. … lists every event |
| Briefly blank | From 1.2.1, a completed poll must contain… trigger a low-water crossing across a measurement gap. | Since 1.2.1, an update must include… fire a low hot water trigger across a gap in readings. |
| Didn't confirm | ### Why does a setting now report that the pump did not confirm it? … after writes from both tiles and Flows. A successful Modbus acknowledgement alone does not guarantee… | ### Why does a setting now say my heat pump didn't confirm it? … after every change from a tile or a Flow. Your heat pump accepting the change over Modbus doesn't guarantee it applied it. |

## lib/release-announcements.ts

| Where | Before | After |
|---|---|---|
| CURRENT_ANNOUNCEMENT (id 1.5.0-update) snippets[0].text.en | Your Heating thermostat can now follow one NIBE wireless room sensor, and on pumps with several zones you choose which zone it sets. Run Repair on your Nibe Heating device to set it up. | Your Heating thermostat can now show a NIBE wireless room sensor. On heat pumps with several zones, you choose which zone it sets. Run Repair on your Nibe Heating device to set it up. |
