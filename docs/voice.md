# Voice

How Nibe Live talks to owners, in every language. It applies to every string an owner can read: tiles,
settings, hints, Flow cards, pairing and Repair, timeline messages, widgets, help pages, the FAQ and the
store changelog. `CLAUDE.md` ("Owner-facing writing") has the full rules. This is the short version to
keep open while writing. The approved example is `help/autopilot-hot-water.html`. The November 2026 audit
against these rules is [tone-review-2026-11.md](tone-review-2026-11.md).

## Sound like a person

Write the way you'd explain it at the kitchen table. Warm, plain and short.

- Start with what the owner gets, then how it works. "Heats the tank in the cheapest hours."
- Use contractions, and mix sentence lengths. A short one after a long one.
- End a point with a full stop. "Autopilot is waiting. Turn off Smart price adaption."
- Say it straight. Write "Live readings", and leave the comparison out of the sentence.

Never use these:

| Pattern | Write this instead |
|---|---|
| Contrast pairs: "X, not Y", "Not X. Y.", "No X, no Y" | Say what it is: "How much shower is left." |
| Em dashes as asides, semicolons in UI text | Two sentences |
| Colon punchlines: "Paused: room control" | "Paused. Room control is on." |
| "simply", "just", "seamless", "smart", "please", "!" | Nothing. Leave the word out. |
| Savings figures that weren't measured | A measured number, or none |
| Developer words: register, allocator, bias, degree minutes, fed, poll, payload | Name the setting or the reading |

**Keep the link to the heat pump.** Sensor codes and menu numbers stay, after the plain words: "the
outdoor temperature (BT1)", "On your heat pump, menu 7.5.9.2." Owners and installers look for them on the
display.

## Length

- **UI text** is one short line. **A hint** is one or two sentences.
- **A timeline message** puts the decision first, then the reason, then the numbers: "Charge at 22:00 to
  56 °C · Cheapest hours".
- **A changelog entry** is a few sentences: what changed for the owner, and anything they have to do.
  Details go in `docs/releases.md`.
- **If a hint has to explain a concept, the screen is wrong.** Show the state ("Smart price adaption is
  on. Autopilot waits.") or draw it, and move the explaining to the help page.

## Words

| Concept | English | Never |
|---|---|---|
| The machine | your heat pump | the pump, your device, the unit |
| A Homey tile | the Heating device, the Main device | (only use "device" for these) |
| The feature | Autopilot | smart heating, smart steering |
| Its modes | Autopilot · Live, Autopilot · Simulated | Simulation, Test run, Test |
| Where you turn it on | Smart mode, a step of Heating setup or Hot water setup | Smart mode setup |
| Comfort ranges | Comfort, Save, Save more | I'd rather freeze |
| Safety net setting | Always enough for a shower: 20 L, 40 L, 60 L | minimum, cushion, reserve |
| Price | cheap, cheapest hours, expensive, most expensive hours, cost more | dear, dearer, dearest, pricey, pricier |
| Holiday setting | Away, for a week or more | Holiday for a day off, "while you're out" |
| A day off | day off | holiday |
| Hot water | hot water | domestic hot water, DHW, tap water |
| Heating the tank | a charge, charge the tank | boost, top-up |
| Electric backup | immersion heater | additive heater, additional heat, electric addition |
| Heat curve | heat curve, heat curve offset | heating curve, heatcurve, displacement |
| Outdoor | outdoor temperature (BT1) | outside temperature |
| Flow card picker | setting | register |
| Volume | L (40 L) | l, litres in a label |
| The maker | NIBE | Nibe (except in the app name, Nibe Live) |

On-screen names are quoted exactly, in sentence case: "Heating setup", "Hot water setup", "Device setup",
"Smart mode", "Smart price adaption", "More hot water".

## Per language

Each translation has to sound like it was written in that language. Use the words NIBE's own manuals
and local installers use. Don't translate English word for word. Use the same word for a concept every
time, and make device and card names match the tiles and cards character for character.

| | Formality | Hot water | Tank | Electric backup | Heat curve offset | Away | Simulated |
|---|---|---|---|---|---|---|---|
| sv | du | varmvatten | tank | elpatron | as NIBE's display (now Värmeförskjutning, check) | Bortrest | Simulerad |
| nl | **je, jouw**, never u/uw | warm water | boiler | bijverwarming | Verschuiving stooklijn | Afwezig | Gesimuleerd |
| de | **Sie, Ihr**, never du/dein | Warmwasser, never Brauchwasser | Speicher | Zusatzheizung | Parallelverschiebung | Abwesend | Simuliert |
| no | du | varmtvann | bereder | elkolbe | kurveforskyvning | Bortreist | Simulert |
| da | du | varmt vand | beholder | elpatron | kurveforskydning | Bortrejst | Simuleret |

- **Heating the tank** uses the heating word in nl, no and da (opwarmen, oppvarming, opvarmning). The
  battery words (laden, lading, oplade) read as charging a car.
- **Sensors on the heat pump** are givare, voeler, Fühler, føler and føler. "Sensor" is for Homey's own
  sensors.
- **Smart price adaption and Smart control** use whatever the heat pump's display shows in that
  language. Check the display or NIBE's manual before choosing. Don't guess.
- **Device names** come from `roleNames` in `lib/roles.ts`. Every language needs an entry there, and the
  copy uses exactly that name.

## Before it ships

1. Read it aloud. Would you say it to a neighbour?
2. Search for: `not `, ` — `, `;`, `dear`, `pric`, `device`, `pump`, `register`, `Simulation`, ` u `,
   ` uw `, ` du `, ` dein`.
3. Does every name match the screen it points to, in every language?
4. Is it one line? If not, can a visual or a state on screen do the job?
5. All six languages updated, in both locale layers where the key lives.
