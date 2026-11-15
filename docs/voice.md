# Voice

These rules cover every string an owner can read in Nibe Live: tiles, settings, hints, Flow cards,
pairing and Repair, timeline messages, widgets, help pages, the FAQ and the store changelog. The full
rules are in `CLAUDE.md` under "Owner-facing writing". The November 2026 audit against them is in
[tone-review-2026-11.md](tone-review-2026-11.md).

## Write like a person explaining it

Imagine telling a neighbour how the thing works. Use normal sentences with a subject and a verb. Say
what the app does for them first, then how. Contractions are fine.

> Autopilot heats the tank in the hours when electricity is cheapest, so it's warm when you shower.

Write the fact and stop. Don't set it up for effect, sum it up, or reassure afterwards.

## Avoid the AI voice

Most of the copy in this app was drafted with an AI model, and the model's habits show. The maintainer
has rejected them. Each one below is followed by an example from this app and a plain version.

| Habit | From the app | Plain |
|---|---|---|
| Two-fragment headline | "Warm rooms. Your rules." | "Heating" |
| Cute idiom | "Summer, sorted." | "Cooling in summer" |
| Contrast pair: "X, not Y", "Not X. Y." | "Close to myUplink. Not identical." | "The figures can differ a little from myUplink." |
| Number hook | "Three things. Every fifteen minutes." | "Every fifteen minutes Autopilot checks prices, your usage and the tank." |
| Short closer | "Two switches. That's it." | Leave the closer out. |
| Reassurance | "Nothing changes.", "same as always", "Nothing to tune." | Say what happens: "Your heat pump keeps its own settings." |
| The app as a person | "Always knows why.", "It speaks your heat pump's language." | "The Hot water device shows why it charges." |
| Hype words | actually, real, really, quietly, genuinely, handled, smart, seamless, simply, just | Leave them out. |
| Colon reveal | "Paused: room control" | "Paused. Room control is on." |
| Em dash aside, semicolon | "…the tank — if it's cold — …" | Two sentences. |
| Developer words | register, allocator, bias, degree minutes, fed, poll | The name of the setting or the reading. |

**Headings name the topic.** "Settings", "How a charge is planned", "When the tank gets cold". A heading
doesn't need a full stop or a twist. `CLAUDE.md` still asks for "a short two-part headline with full
stops". That rule produced the headings in the table above and should be changed (see the review).

**Keep sensor codes and menu numbers** next to the plain words, such as "the outdoor temperature (BT1)"
or "On your heat pump, menu 7.5.9.2". Owners and installers find them on the display.

## Length

- UI text fits on one line. A hint is one or two sentences.
- A timeline message gives the decision, then the reason, then the numbers: "Charge at 22:00 to 56 °C ·
  Cheapest hours".
- A changelog entry is a few sentences on what changed for the owner and anything they need to do.
  Details go in `docs/releases.md`.
- If a hint has to explain a concept before the owner can use the screen, change the screen. Show the
  state ("Smart price adaption is on. Autopilot waits.") or draw it, and put the explanation on the
  help page.

## Words

| Concept | Use | Don't use |
|---|---|---|
| The machine | your heat pump | the pump, your device, the unit |
| A Homey tile | the Heating device, the Main device | device for anything else |
| The feature | Autopilot | smart heating |
| Its modes | Autopilot · Live, Autopilot · Simulated | Simulation, Test run |
| Where it's switched on | Smart mode, a step in Heating setup or Hot water setup | Smart mode setup |
| Comfort ranges | Comfort, Save, Save more | I'd rather freeze |
| Minimum hot water | Always enough for a shower: 20 L, 40 L, 60 L | minimum, cushion, reserve |
| Price | cheap, cheapest hours, expensive, most expensive hours, cost more | dear, dearest, pricey, pricier |
| Holiday setting | Away, for a week or more | Away for a day out |
| A day off | day off | holiday |
| Hot water | hot water | domestic hot water, DHW, tap water |
| Heating the tank | a charge | boost, top-up |
| Electric backup | immersion heater | additive heater, additional heat, electric addition |
| Heat curve | heat curve, heat curve offset | heating curve, displacement |
| Outdoor | outdoor temperature (BT1) | outside temperature |
| Flow card picker | setting | register |
| Volume | 40 L | 40 l |
| The maker | NIBE (the app is Nibe Live) | Nibe for the company |

Quote names exactly as the screen shows them, in sentence case: "Heating setup", "Hot water setup",
"Device setup", "Smart mode", "Smart price adaption", "More hot water".

## Other languages

English comes first. Translations follow once the English is right, and the translation findings
are parked in the appendix of the review.

## Before it ships

1. Read it aloud and ask whether you'd say it that way to a neighbour.
2. Search the text for `not `, ` — `, `;`, `That's`, `Nothing`, `actually`, `real`, `dear`, `pric`,
   `device`, `pump`, `register`, `Simulation`.
3. Check that every name matches the screen it points to, in every language.
4. If it runs longer than a line, look for a visual or an on-screen state that could replace it.
