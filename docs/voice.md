# Voice

These rules cover every string an owner can read in Nibe Live: tiles, settings, hints, Flow cards,
pairing and Repair, timeline messages, widgets, help pages, the FAQ and the store changelog. The full
rules are in `CLAUDE.md` under "Owner-facing writing". The November 2026 audit against them is in
[tone-review-2026-11.md](tone-review-2026-11.md).

# Part 1. Voice

Part 1 applies to everything an owner reads. Part 2 adds the format for text inside the app.

## Write like a person explaining it

Imagine telling a neighbour how the thing works. Use normal sentences with a subject and a verb. Say
what it does for them first, then how. Contractions are fine.

> Autopilot heats the tank in the hours when electricity is cheapest, so it's warm when you shower.

Write the fact and stop. Don't set it up for effect, sum it up, or reassure afterwards.

## Avoid the AI voice

Most of the copy in this app was drafted with an AI model, and the model's habits show. The maintainer
has rejected them. Each row has an example from the app and a plain version.

| Habit | From the app | Plain |
|---|---|---|
| Two-fragment headline | "Warm rooms. Your rules." | "Heating" |
| Cute idiom | "Summer, sorted." | "Heating in summer" |
| Contrast pair: "X, not Y", "Not X. Y." | "Close to myUplink. Not identical." | "The figures can differ a little from myUplink." |
| Number hook | "Three things. Every fifteen minutes." | "Every fifteen minutes Autopilot checks prices, your usage and the tank." |
| Short closer | "Two switches. That's it." | Leave the closer out. |
| Reassurance | "Nothing changes.", "same as always", "Nothing to tune." | Say what happens: "Your heat pump keeps its own settings." |
| The app as a person | "Always knows why.", "It speaks your heat pump's language." | "The Hot water device shows why it charges." |
| Hype words | actually, real, really, quietly, genuinely, handled, smart, seamless, simply, just | Leave them out. |
| Verdicts | "Nothing to gain from shifting now" | Say what happens: "Holding · no change planned" |
| "We", "please", "!" | "We've ticked what your heat pump reported.", "You're all set!" | "Ticked items have data from your heat pump", "All set" |
| Em-dash asides and semicolons | "…the tank — if it's cold — …" | Two sentences. |
| Developer words | register, allocator, bias, degree minutes, fed, poll, capabilities | The name of the setting or the reading. |

Headings name the topic, for example "Settings", "How a charge is planned" or "When the tank gets
cold". They don't take a full stop or a twist. `CLAUDE.md` still asks for "a short two-part headline
with full stops". That rule produced the headings in the table above, so it should be changed.

Keep sensor codes and menu numbers next to the plain words: "the outdoor temperature (BT1)", "On your
heat pump, menu 7.5.9.2." Owners and installers look for them on the display.

## Words

| Concept | Use | Don't use |
|---|---|---|
| The machine | your heat pump | the pump, your device, the unit |
| A Homey tile | the Heating device, the Main device | "device" for anything else |
| The feature | Autopilot | smart heating |
| Its modes | Autopilot · Live, Autopilot · Simulated. Use "Simulated · …" before a status line | Simulation, Test run |
| Where it's switched on | Smart mode, a step in Heating setup or Hot water setup | Smart mode setup, Heating Setup |
| Comfort ranges | Comfort, Save, Save more | I'd rather freeze |
| The hot water floor | The setting is "Always enough for a shower" (20 L, 40 L, 60 L). Anywhere else, call it the safety net | minimum, cushion, reserve |
| Heating the tank | charge, charging | heating the tank, charging run. Keep "boost" only for More hot water |
| What Autopilot does to BT1 | Outdoor shift (BT1) | Shift °C, nudge |
| Room regulation | room-sensor control | room control, room sensor regulation |
| NIBE's price feature | Smart price adaption | Smart Price Adaption, Smart price |
| Price | cheap, cheapest hours, expensive, most expensive hours, cost more | dear, dearest, pricey, pricier |
| Holiday setting | Away, for a holiday of a week or more | Away for a day out |
| A day off | day off | holiday |
| Hot water | hot water | domestic hot water, DHW, tap water |
| Electric backup | immersion heater | additive heater, additional heat, electric addition |
| Heat curve | heat curve, heat curve offset | heating curve, displacement |
| Outdoor | outdoor temperature (BT1) | outside temperature |
| Flow card picker | setting, or reading for sensors | register |
| How often it reads | update interval | poll interval |
| Volume | 40 L | 40 l |
| The maker | NIBE (the app is Nibe Live) | Nibe for the company |

Quote names exactly as the screen shows them, in sentence case: "Heating setup", "Hot water setup",
"Device setup", "Smart mode", "Smart price adaption", "More hot water".

## Other languages

English comes first. The translations follow once the English is settled. The translation findings are
parked in the appendix of the review.

# Part 2. App UI format

People glance at the app and read the help pages. Text on a tile, a widget, the timeline or a Flow card
gets one look, so keep it to the one line a person reads. The help pages, the FAQ and the changelog use
full sentences.

These rules apply on top of Part 1 to text inside the app. The maintainer approved them on 2026-11-15.

1. **Labels end without a full stop.** That covers titles, buttons, status lines, legend items and list
   rows. Hints, empty states and timeline bodies are sentences and do end with one.
2. **A status line gives the state first, then one fact, joined by " · ".** "Paused · no outdoor
   temperature", "Charge 22:00 to 56 °C · Cheapest hours". The dot replaces a colon or a second
   sentence.
3. **A hint is one sentence, two at most**, and about 90 characters in English so the German still fits
   on a phone. The first sentence says what the setting does. Reasons and edge cases go on the help page.
4. **A button says what happens when you press it**, like "Check my heat pump".
5. **An error says what's wrong, then how to fix it.** Give the fix as an instruction with the place to
   do it: "No NIBE data at this address. Check the IP and that Modbus TCP is on (menu 7.5.9)."
6. **Put the number where the eye lands first.** "Tank 120 L now · never below 40 L".
7. **Flow cards follow Homey's guidelines.** Card titles have no parentheses or colons, and "to" goes
   before every value: "Set outdoor temperature BT1 to [[value]] °C". Leave out a hint that only
   repeats the title. A trigger hint starts with "When".
8. **Check the length before adding a line.** If a hint has to explain a concept before the owner can
   use the screen, change the screen instead. Show the state or draw it, and put the explanation on
   the help page.
9. **Hints and sentences keep a subject and a verb.** Status lines use the "state · fact" form from rule
   2. Anywhere else, "Expected line shows after learning" or "Optional. Off for Autopilot." reads as
   shorthand. Write "The expected line shows once Autopilot has
   learned your house."

Timeline messages lead with the decision, then the reason, then the numbers. A changelog entry is a few
sentences about what changed for the owner and anything they need to do. The details go in
`docs/releases.md`.

## Before it ships

1. Read it aloud and ask whether you'd say it that way to a neighbour.
2. Search the text for `not `, ` — `, `;`, `That's`, `Nothing`, `actually`, `real`, `we`, `please`,
   `dear`, `pric`, `device`, `pump`, `register`, `Simulation`.
3. Check that every name matches the screen it points to.
4. If it runs longer than a line, look for a visual or an on-screen state that could replace it.
