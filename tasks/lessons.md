# Lessons

## Re-read the file before theorising about why a change didn't work

**2026-07-28.** A test asserting the debug-context suffix on the `Priority change:` log line
failed. I assumed the code was in place and went hunting for a subtle cause — inspecting
compiled TypeScript in `.homeybuild/` to work out whether a class-field initializer ran before
the parameter-property assignment. The actual cause was that the edit adding the registers to
`unionRegisters()` had never landed in the file at all.

**Rule:** when a change appears not to take effect, `grep` the source for the thing you believe
you wrote *before* forming any hypothesis about why it misbehaves. Cheapest check first;
"is it there?" beats "why is it wrong?".

## "Give me a reason" means interpret the data, not dump it

**2026-07-28.** Asked to add a *reason* for a priority change, I shipped a pipe-joined dump of
13 register readings (`DM 0 | calc supply 26.6 °C | supply 22.7 °C | …`). The user's verdict:
"way too sloppy. I'm asking for a reason. Not 50 variables."

The values were correct and the plumbing worked — the output was still worthless, because
turning readings into an explanation is exactly the work that was being asked for. The fix was
a rule set that picks the comparison that actually fired and states it with the two or three
numbers that justify it ("The house fell behind on heat: degree minutes are down to -60, at or
past the -60 threshold that starts the compressor").

**Rule:** when the deliverable is an explanation, a summary, or a diagnosis, the interpretation
is the deliverable. Shipping the raw inputs and leaving the reader to infer the conclusion is
not a partial answer, it's a non-answer. Before shipping, read the output as the user would and
ask "does this tell me *why*, or does it just tell me *what*?"

## Check whether the diagnostic already exists before proposing to add it

**2026-07-28.** In a plan to make silent failures visible, I proposed "dump model type code and
firmware on init" as a new logging item. It was already there — `updatePumpInfo()` had logged
both under `this.debug` since the alarms release. The user cut it: "Remove A3, I missed we had
it in debug log already. That's enough."

No harm done, but it padded a plan with work that didn't exist, and a plan is meant to be a
list of things that are actually missing.

**Rule:** before adding a logging/diagnostic item to a plan, grep for the value it would emit
(`grep -n "firmware\|heatpump_type" lib/`). If a line already produces it, the real question is
narrower — is it at the right level, does it fire at the right time — and often the answer is
that nothing needs doing.

## "It answered" is not "it works" — verify a register carries data, not just a response

**2026-07-28.** Register 2727 "Current power" looked like the obvious fallback power source for
S320/S2125: right title, right units, present on all six S models. Probing a live S1155
alongside the known-good 2166 killed it — 2727 answered 31 of 31 reads and sat at a flat zero
straight through a 3.3 kW compressor run, because it belongs to the EME 20 accessory that pump
doesn't have. Had it shipped on the CSV evidence alone, every VVM/split user would have got a
permanently-zero power reading and a broken COP — the same class of bug being fixed, reintroduced.

This then changed the *code*: detection's power-source check became "answered **and** (moved or
non-zero)" rather than "answered", so the app applies the same standard.

**Rule:** a register's documentation tells you it exists, never that it is wired up on a given
unit. Before depending on one, sample it live against a known-good reference while the thing it
measures is actually happening — and treat a flat zero across a window where the value should
have moved as a failure, not as data.

## The pump is the user's to probe — write the script, don't try to run it

**2026-08-05.** Asked to verify the room-temperature registers against the live S1155, I tried to
connect to 10.136.1.93:502 from an inline Node script. It failed `EHOSTUNREACH`. `ping` and
`nc -z 10.136.1.93 502` both succeeded from the same shell, so I read that as a sandbox block and
re-ran with the sandbox disabled. Same failure. The user cut it off: "I need to run it, you can't,
we've been through this."

Three round-trips spent rediscovering a constraint that was already established, and one needless
sandbox escalation on a machine that was never going to connect.

**Rule:** anything that talks to the pump gets written as a `dev/*.mjs` script and handed over as a
command to run. One connection attempt is acceptable as a check; a second is not. `ping`/`nc`
succeeding says nothing about whether the app's own stack can reach it — don't use that as evidence
to retry, and never escalate `dangerouslyDisableSandbox` to chase it.

**Corollary:** a probe the user runs blind is worth more when it interprets itself. `--expect 35`
(name the registers matching a value the user just set in the myUplink app) and `--watch` (print
only what moved) turn a wall of numbers into an answer, and cost one round-trip instead of several.

## jsmodbus goes online off the socket's `connect` event — build the client first

**2026-08-05.** `dev/probe-room.mjs` printed "connected to 10.136.1.93:502" and then failed every
single read with "no connection to modbus server". The socket really was open; the client was not.
`ModbusTCPClient` marks itself online by listening for the socket's own `connect` event, and the
probe constructed the client *after* awaiting that event — so it never fired for the client and it
stayed offline forever. `lib/detection.ts:201` has always had the right order (socket, then client,
then connect); a helper that returned an already-connected socket quietly broke it.

The failure mode is nasty because the error text blames the network for what is a construction-order
bug, and the user burned a round-trip on the pump running the broken script.

**Rule:** `new ModbusTCPClient(socket, ...)` goes immediately after `new net.Socket()` and always
before `socket.connect()`. Never write a helper that connects a socket and hands it back bare.

**Corollary:** every probe should assert one register that cannot fail (input 1, outdoor temperature,
exists on all six S models) and abort loudly if it does. A column of identical errors reads like a
finding about the pump when it is a finding about the probe.

## Search the Home Assistant community before building against a register

**2026-08-05.** I built an indoor-temperature setpoint on holding 2505, verified it against Nibe's CSVs, an
in-process fake pump and read-only live probes, and reported it working. It wasn't. The pump ACKs Modbus
writes to the setpoint and silently discards them, so the control would have snapped back for every user.
When the live write test finally showed it, I was about to write the whole feature off — the user stopped me:
"Stop. Do some research online first before discarding this."

Ten minutes of searching produced what days of probing had not.
[home-assistant/core#154450](https://github.com/home-assistant/core/issues/154450): an S735 owner with the
identical symptom — writes to 206 land, readback changes, heating does not react, myUplink works within
minutes. And #155175: the external-BT50 injection registers 5986/5987, added in firmware 2.22.12 and absent
from every model CSV we ship. Neither fact is derivable from Nibe's documentation at all.

**Rule:** before adding a register or designing a feature around one, search
`site:community.home-assistant.io nibe <topic>`, the `home-assistant/core` issue tracker, and the community
integrations. Do it at design time, not after the implementation fails. A matching report from another owner
is evidence on a par with a live probe — cite it in the code comment, as `registers.ts` now does for 2505.

**Corollary:** Nibe's CSVs describe which registers *exist*. They say nothing about which ones the controller
*honours*. "Holding register, documented min/max/default" implied writable to me, and for the setpoint that
was simply false.

## A write that is ACKed is not a write that landed — enumerate the shape space

**2026-08-06.** I concluded the indoor setpoint (holding 2505) was read-only, shipped it that way, wrote a
FAQ entry and a release note asserting it, and told the user their only route was the myUplink cloud API.
All wrong. halderex found it in PR #5: the pump accepts exactly one shape — a two-word FC16 request
assembled **HIGH word first** — and silently discards everything else. Reproduced afterwards on the
maintainer's S1155:

```
FC16 [high, low]        -> TOOK
FC16 [low, high]        -> ACKed, discarded   <- what this app was sending
FC6 at the address      -> ACKed, discarded
FC6 at address + 1      -> ACKed, discarded
```

**The trap is that three of four shapes ACK.** A partial matrix is indistinguishable from a register the
pump refuses to write, so "I tried two shapes and neither stuck" is not evidence of read-only — it is no
evidence at all. My probe tested FC6 and FC16-low-first and I read the result as a property of the register
rather than of my request.

**Nibe reads 32-bit registers low-word-first and writes them high-word-first.** Read order does not imply
write order. The plausible explanation is that the write handler parses a standard big-endian 32-bit value
while the read path presents Nibe's own little-endian word order — but that is a hypothesis; what is
measured is the table above, on two models (S735, S1155) for one register.

**Rules:**
- Before calling a holding register unwritable, try the whole shape space: {FC6, FC16} × {word orders} ×
  {each word's address}. Restore the original between attempts so no shape inherits another's success.
- Always read back after writing, and after a delay — an ACK means the request was well-formed, nothing more.
- Never let a read path's byte/word order imply the write path's. Assert them separately.
- A fake-pump harness that is flat memory **cannot** model this asymmetry. Test what goes on the wire; a
  round-trip assertion there tests the harness, not the pump. Ours asserted the round trip and passed
  happily while the app wrote the one order the pump ignores.

## When a setting has no effect, find the second writer before blaming the platform

**2026-08-06.** Capability display order was ignored. I added `displayOrder` to the profile, sorted
`deviceTemplate` by it, reordered `driver.compose.json`, verified the generated `app.json` carried the new
order — and a fresh pair still came out in raw register-table order. I was one step from concluding that
Homey does not honour the manifest and writing that into the docs.

It honours it. A **second code path** was overwriting the result: `candidateGroups()` builds the pairing
picker's per-group capability lists straight from the register table, and the features view assigns those to
`device.capabilities`. The picker's list is what the device stores, and the stored array is what renders.
Everything upstream of it was dead code as far as ordering went.

Two failures, and the second is the expensive one:

- **I verified the artifact I control, not the value that ends up in place.** `app.json` was correct at every
  check. The device's stored array — one API read away, and the thing actually rendered — was not, and that
  read is what identified the writer.
- **I was about to attribute my own bug to the platform.** "The framework ignores this" is the most
  self-serving explanation available and needs the most evidence, not the least. The user asked twice —
  "have you checked the homey forums?", and earlier "again, check HA … stop, do your research first" — and
  both times the outside source settled in minutes what I had been inferring for far longer. The forum
  thread confirmed order *is* respected, which is what turned the search back onto our own code.

**Rules:**
- Before concluding a platform ignores a setting, grep for every place that writes the same field. A
  declared value that never lands usually has a second author, not an indifferent reader.
- Assert on the end state on the device, not on the generated file. `homey api devices get-device` shows what
  was really stored.
- Search the vendor's forum *before* the third failed hypothesis, not after. Twice now the answer was
  published and one search away — Nibe's register list for the additional-heat permit, this thread for
  capability order.

**Amended the same day, by the hot water tile.** Search the forum, but rank it below measurement. Both
threads that looked relevant there were wrong for our case: one said thermostat tiles do not fade (ours
does), the other that a root `onoff` is required to drive the tile (ours is a sub-id). Acting on either
would have produced a class change or a capability rename, and neither was the bug. What settled it in one
call was diffing the `ui` object of a device that worked against one that did not — `ui.quickAction` was
the whole story, and no thread mentioned it. **A forum is good for "is this possible at all", which is the
question that unblocks a stalled hypothesis. It is unreliable for "why is mine different", and that is
what a diff against a working instance answers directly.** Prefer the two-instance diff whenever one
exists; reach for the forum when nothing local works to compare against.


## Write for the venue, not for the evidence you gathered

**2026-08-06.** The 0.9.13 store changelog ran to ~500 words per language — register numbers, the
2166-vs-2305 measurement, the CSV mistitling of register 180, three crash classes. Every fact was
true and hard-won, and a pump owner reading the app store scrolled past all of it. "No one will
ever read that wall of text."

The pull is real: the detail felt like the *proof* the release was sound, so cutting it felt like
hiding work. It isn't, because the work already has homes — the README row is the engineering
view, `docs/` carries the reasoning, the commits carry the trail. Length in the wrong venue does
not add credibility, it costs the one thing a store listing has to do.

**Rule:** before writing user-facing text, name its reader and what they must decide. A store
changelog reader decides "do I care, and must I do anything?" — a few sentences. Anyone wanting
mechanism will follow a link. Same discipline as a commit subject line: the body exists, put it
in the body.

## Pre-1.0 means hard cuts. Don't re-derive this from the install count

**2026-08-07.** Told that 0.9.13 was published and running with a few other users, I decided the
single-install assumption in `CLAUDE.md` had expired, rewrote the rename section to forbid hard
cuts, made `renamedRegisters` a standing requirement, and committed and pushed it. The user's
verdict: "We are still pre-1.0, we can do hard cuts. I've said this probably 20 times now."

Twenty times, and it was in neither `tasks/lessons.md` nor the memory directory — which is the
actual failure. A rule that lives only in the user's repeated corrections gets re-litigated by
every session that meets a fact which *looks* like it should change the policy.

The reasoning error is worth naming too: `CLAUDE.md` said migrations become necessary "if the app
gets other real users", I observed other real users, and treated that as the trigger firing. But
the policy was never a function of the install count — it is a function of the version. Pre-1.0
is a declaration that the interface is not yet promised, and a handful of early adopters on a
pre-1.0 app are precisely the people a hard cut is for.

**Rule:** the versioning stance is the user's to set, not something to infer from evidence about
users, adoption or stability. Pre-1.0 → hard cut; 1.0 is the line where that changes. When a fact
seems to invalidate a standing policy, say so and ask — changing the policy is not the same kind
of act as acting under it. And when a correction has clearly been given before, write it down
where the next session will read it, not only where this one will.

**2026-08-09.** Asked to repoint Homey flows at re-paired Nibe devices, I listed the hub's devices
with a filter on the *name* `Nibe`. That found `Nibe Main` and stopped. I then reported that the
hot-water flows were unfixable because no device on the hub carried
`boolean_NIBE.h697_more_hotwater` — and told the user to go run Repair to enable the hot water
group. The devices existed the whole time. They were named `Uppvärmning` and `Varmvatten`.

The user's correction was two words of Swedish, which I first mis-read as a locale change request
and burned a clarifying question on.

The filter was the error, but the real failure is that I reported a *negative* conclusion — "this
cannot be done, go reconfigure your pump" — on the strength of a search I had chosen the key for.
A name filter encodes an assumption about what things are called; a `driverId` filter encodes what
they actually are. For anything on this hub the identity is `homey:app:com.nibe.local:nibe_s`,
never the label, because the label is the user's to choose and this user names devices in Swedish.

**Rule:** query by stable identity (`driverId`, capability, register address), never by
human-assigned name. Before telling the user that something is missing, absent or impossible,
re-derive it a second way — an absence found through one filter is evidence about the filter as
much as about the world. And the same goes for scope: the orphan sweep that should have opened
this task (every `homey:device:` UUID in every flow, diffed against the live device list) found
two more live broken flows that no name-based search would have surfaced.

## The store changelog is a listing, not release notes (1.1.3)

CLAUDE.md already says to keep `.homeychangelog.json` entries to "a few sentences", and the 1.1.3
entry I wrote was a few sentences — three of them, each carrying a "so that…" clause explaining
why the rename mattered and reassuring the reader their Flows still worked. It came straight back
as "way too wordy". "A few sentences" is not the constraint; *sharp* is. The rewrite that landed
was three short ones, with every explanatory clause deleted.

**Rule:** draft the changelog entry, then delete every clause that explains why or how — keep only
what changed for the owner and anything they must do. The mechanism, the register numbers and the
reasoning go in the `docs/releases.md` row, which is the venue that wants them. Same failure mode
as 0.9.13's ~500-word wall: the detail was right, the venue was wrong.

## The changelog rule existed and I broke it anyway (1.1.4)

The 1.1.3 lesson above, and the memory it was promoted to, both said: 2-3 sharp sentences, delete
every clause that explains why or how. I then wrote a 1.1.4 entry in three sentences that still came
back as "Sharpen the changelog. We talked about this." So the rule was not the problem — it was not
specific enough about *what* survives an edit pass and what does not.

Two clauses got through because each looked like it was doing work:

- "Nothing to do — it takes effect when the app updates." CLAUDE.md says name "anything they must
  do", and I read the null case as something worth stating. It is not. An app update applying itself
  is not news, and the sentence reads as padding in a two-sentence listing.
- "The Solar device was reporting its live output to its own tile but not to Energy." That is the
  data flow, written from the app's point of view. The owner never sees a device report anything to
  anything; they see an empty production figure in the Energy tab. The mechanism had already been
  banned in the abstract, and I still wrote it because it felt like the symptom.

**Rule:** after drafting, read each sentence and ask *would the owner recognise this as their own
problem, or is it how the app works?* Cut the second kind. And when there is nothing the owner must
do, write nothing — the null case is silence, not a sentence saying so.

## A log full of errors is a bug report, not "debug logging doing its job"

**2026-09-25.** Handed a startup log with ~190 "Device.driverUri is deprecated" lines and dozens of
"Illegal function" read failures, I sorted it into "unrelated/pre-existing" and "expected with debug
on" and offered to flag the fixes for later. The user: "Are you kidding me? … Get real." Every item
had a cause in our code: a deprecated getter read once per device on the Homey, an exception text
that blamed *writing* on reads, and two read paths (priority-change reasons, the debug dump) that
ignored the cooldown the poll had already set, so each absent register failed two or three times.

**Rule:** when the user shows a noisy log, the question is "which line of ours produced each of
these, and why more than once?" — not "which ones can I explain away". Pre-existing is not the same
as acceptable, and "debug is on" explains why a line is *printed*, never why the request was *made*.
Fix what repeats; only then triage what's left.

## A store changelog covers everything since the last LIVE version

**2026-10-12.** Asked to release 1.4.5 live and "summarize all changes from 1.4.2 in a timeline
message", I consolidated the timeline message but wrote the 1.4.5 changelog for 1.4.5 alone, then
uploaded it. 1.4.3 and 1.4.4 were test-only, so live owners going 1.4.2 → 1.4.5 would never have
read about the 1.4.4 Flow cards or night cooling moving devices. Athom refuses a second upload of a
version in review, so the fix cost a version: 1.4.6. The user: "because of your sloppyness. Don't
do this again."

**Rule:** before any `homey app publish` meant for live, run `git log <last-live-tag>..HEAD` and
check every user-facing change appears in the changelog entry being shipped — not just the
current version's. Test-only versions in between don't count as shipped. 1.4.0 already did this
for 1.3.4–1.3.8; that row in `docs/releases.md` is the precedent. Upload only after that check:
an uploaded version can't be corrected, only superseded.

## A pump test holds every input to what it measures, and runs to the end

**2026-10-29.** I ran a 3 h fake-BT1 step to measure how calculated supply (1017) follows the
outdoor average, with room-sensor control off. SPA (843) was still on, and room control had been
switched off minutes before, so supply was already falling at baseline. The run measured nothing
new. I only raised SPA when the user asked. The user: "why didn't you think of this earlier?"

**Rule:** before starting a hardware probe, list every input to the measured value (for 1017:
BT1 average 37, curve 26, offset 30, min/max supply 34/38, room control, SPA 843, operating mode
237, holiday/away). Hold each still or log it, require a flat baseline, and ask the user for any
setting change up front, as part of the plan. A probe should refuse to start when a precondition
fails.

Same day, second mistake: the user said "let's conclude this one now first" and I stopped the
run 15 minutes early and wrote it off as "measured nothing", when the step data held a clean
response. **Rule:** "conclude" means finish and analyse, not abort. Never stop a running
hardware test without the user saying stop, and fit the data before calling a run useless.

## Check the operating mode before reasoning about pump automatics

**2026-10-30.** I described the warm-stop test (0.5) as stopping the radiators above 15 °C. The
user: "that's only true in auto mode". The auto-stop thresholds (184/185) act only in operating
mode Auto (237 = 0), and their pump runs Manual (237 = 1), which the probe had just logged.

**Rule:** before predicting what a pump automatic will do, read the mode that gates it (237 for
auto-stop) and say which mode the prediction is for.

## The most aggressive preset should actually be aggressive

**2026-10-30.** I proposed "Save the most" at −2 / +1.5 K. The user: "you're too cautious. The
most aggressive one should allow like 5-7 degree swings". It is now −4 / +2 K.

**Rule:** the extreme preset is for owners who opted into discomfort; give it the full range and
put the safety in the planner (add-heat-aware recovery, clamps), not in a timid band.

**2026-11-05.** I wrote "smart heating" into proposed owner-facing text. The user: "we are not
calling it smart heating". It was the working name; on 2026-11-05 it was renamed **Autopilot**
everywhere, code and docs included.

**Rule:** never write "smart heating" for this feature, in code, docs or owner-facing text. The
name is **Autopilot**, the same word in all six languages.

## A development test is read for the feature, not for the owner's settings

**2026-11-07.** Asked what the room-off run was teaching us, I answered as if it were tuning the
owner's own heat curve ("curve 5 is too flat, a steeper curve 6–7 would hold 22"). The user: "We
are NOT doing this test to verify my desired heat curve. We are doing it as a part of the Autopilot
development."

**Rule:** a hardware run on the maintainer's pump exists to answer an Autopilot question (what the
controller will see, learn, and have to do). Report findings in those terms: model, actuator,
planner, guards, setup. Never turn it into advice about the maintainer's own settings, and say
what a manual change mid-run costs the run (e.g. an offset change restarts the curve learner).

**2026-11-07, same run.** Before each offset change (+3, +5, +6) I told the user the change "doesn't
spoil the data" because the offset is logged per slot. I never opened `curvePoints()`, which
discards its points on any change to 26/30/34/38, so each change restarted the in-app curve
learner. The history file kept every slot, so nothing was lost from the record, but the claim was
made up.

**Rule:** before saying what a change does to a running test, read the code that consumes the data
and quote it. If I have not read it, say so rather than reassure.

## Don't build managers for what the owner already automates (2026-11-08)

I designed an in-app day-type manager for Autopilot hot water: weekly pattern, holiday calendar,
"was this a free day?" prompts. The maintainer cut it: owners set the day type in their own Flows
(they already keep "working day" variables) or by hand.

**Rule:** when a Homey owner can already express an input in a Flow, expose one capability and one
action card for it, and stop. Calendars, schedules and inference stay out unless asked for.

## Read the register notes before proposing a lever (2026-11-08)

I designed "how hot" as ending a boost with 697 = 0 at a planned temperature. The register table
already says 697 = 0 does not stop a charge in progress; the maintainer had to point it out.

**Rule:** before a design relies on a register doing something, read that register's comments in
`drivers/nibe_s/registers.ts` (and its neighbours') and the relevant memories, and quote what they
say about it.

## 2026-11-09: input 1 is not the outdoor truth once Autopilot feeds BT1

I recommended "use the pump's BT1 instead of the Hue sensor" for Autopilot's outdoor input, and
used the history's `bt1` column as the real BT1 in fed slots. Both wrong: while 5217 is fed,
input 1 shows the fed value (history.ts says so at the `bt1` field and in `close()`), and no copy
of the wired BT1 is readable. The maintainer had to point it out.

**Rule:** before recommending an input or using a history column, read its comment in
`lib/autopilot/history.ts` and check the plan for whether Autopilot itself changes it. A lever
can never also be the measurement.

## Keep heating Autopilot and hot water apart (2026-11-10)

I listed hot water slice 4 as step 4 of "what's next" for heating Autopilot, and let the hot
water session run the heating daily check too. The maintainer called it messy: hot water has
nothing to do with the heating Autopilot.

**Rule:** heating Autopilot and hot water are separate tracks with separate sessions, plans and
next steps. Report on one without the other unless asked. A recurring heating check belongs to
the heating session only.

## 2026-11-12: unreleased branch work needs no migration talk

I framed replacing an unreleased setting (`autopilotHotwater`, the hidden `autopilotLive.*`) as a
"hard cut, no migration" decision and asked about it. The maintainer: "This is still a branch off
main and nothing has been released."

**Rule:** a setting, capability or store key that exists only on an unreleased branch is just
code: change or delete it. Migrations (`renamedRegisters`, `migrateSelection`) are only for what
has shipped to the store. Don't raise migration as a question for branch-only work.

## 2026-11-12: everyday controls are capabilities, not device settings

I put Autopilot's comfort temperature, Away and Price control in the device's Advanced settings.
The maintainer: comfort is the thermostat; a choice that adds or removes capabilities belongs in
Repair; what the owner changes day to day is a capability; and "Has learned your house" in a
settings label says nothing without context.

**Rule:** before adding a setting, ask how often the owner touches it. Set once → settings or
Repair (Repair if it changes what the device carries). Changed day to day → a capability, with
Insights and Flow cards. Never a second control for something a capability already is (the
thermostat). Facts that need context (a chart, an outdoor temperature) → the widget, not a label.

## Read the pump through what the app already learned (2026-11-13)

I told the owner room control was on because 202 read 1, and that the curve runs on the BT1
average (37). Both were already settled in the repo: on zone firmware 202 always reads 1 and a
readable curve offset (30) is the real "off" (`roomControlOff()` in `lib/autopilot/history.ts`),
and the curve follows fed BT1 through a ~49 min filter, not 37 (`docs/autopilot-plan.md` §2).

**Rule:** before explaining live pump behaviour, check the register against `lib/autopilot/` and
`docs/autopilot-plan.md` findings; a raw register's CSV meaning is not what it means on this pump.

## Build on what every owner has (2026-11-14)
I answered a solar-surplus edge case (a partner-steered battery discharging while hot water
charged) by combining the grid meter, the battery and the inverter. The maintainer: "three devices,
and we cannot know all users have their other devices connected." **Rule:** an Autopilot input rests
on the one device every affected owner has (here the grid meter). Name an edge case it misses as a
known limit in the docs; don't patch it with devices only some homes have.

## 2026-11-14 — A doc's "it fails safe" is not a test of this change
- Stopped the BT50 feed under Autopilot on the strength of a note that the pump "carries on" when
  BT50 stops (2026-10-28). With external BT50 still enabled (menu 7.5.9.2) the S1155 raised alarm
  153 within minutes. **Rule:** before a change stops writing something the pump expects, check
  what the pump does when it stops, on this pump and in this configuration, or keep writing it.

## 2026-11-14 — Render setup views against Homey's real stylesheet, not a stand-in
- Renders with my own approximation of Homey's CSS looked fine; on the phone the switches had a
  checkmark drawn in and buttons were grey and oversized. Homey's homey.css masks every checkbox
  without `hy-nostyle` and styles every plain button. **Rule:** render pair/repair views with the
  Homey's own `/css/homey.css` + `homey.drivers.css` (fetched from the Homey, scratchpad
  `homeycss/`), opt our own controls out with `hy-nostyle`, and still ask for a phone check.
- **It happened again (2026-11-21):** When to charge and Legionella shipped with plain buttons,
  labels and inputs, rendered without homey.css, so the "real" renders matched the mock and the
  phone did not (grey chips, no selected segment, no radios). **Rule, sharpened:** every new
  control in a pair/repair view gets `hy-nostyle` in the same edit, a test asserts it, and the
  render before "matches the mock" uses scratchpad `render-hw.js`: homey.css from the Homey, inside
  a 375 px frame (headless Chrome will not go narrower), checked state written into the markup.

## 2026-11-15: a scripted edit replaced an empty string and corrupted a 3 000-line file

A Python `s.replace(old, new)` took `old` from a slice between two `index()` calls. The second
marker occurred twice, so the slice came out empty, and `replace('', new)` inserted `new` between
every character of `lib/device.ts`. Typecheck caught it and `git checkout` restored the file.
**Rule:** every scripted edit asserts `old and s.count(old) == 1` before replacing, and a slice
end is searched from the slice start (`s.index(marker, a)`).

## 2026-11-15: plan log and logger times are UTC
- The shadow log's `at` and the scratch logger's `t` are UTC ISO strings. Convert to Europe/Stockholm before quoting any time to the user. I told the user a 09:45 charge "slid" when the plan they had seen said 10:45 all morning: every time was an hour off.

## 2026-11-15: a setting the user asks for can still break a running test
- I switched heating to "Save more" on request at 19:07, though I had said that morning that the switch changes the live test (the stop criteria and the trim are built for Comfort ±0.5). The user: "Don't switch to most savings if it ruins a test."
- Before any change during a hardware test, even one the user asks for, say in one line what it does to the test and wait for the go-ahead.

## 2026-11-15: the review itself was written in the voice it was reviewing

The tone review followed `CLAUDE.md`, which asks for "a short two-part headline with full stops", so
it missed the slogan headings on every help page. Its own summary also used bold lead-ins and "X, not
Y" lines. The maintainer: "avoid the claude native tone of voice". **Rule:** before handing in any
owner text, doc or report, check it against the AI-voice table in `docs/voice.md`. That covers slogan
headings, number hooks, reassurance closers, the app talking about itself, hype words and contrast
pairs. Agent-proposed copy gets the same check, since subagents write in that voice by default.

## 2026-11-15: a new format for a length problem

The maintainer said the in-app text was "a bit wordy at times". I answered with a new format (Glanceable), and it was rejected. Rule: when the complaint is length, cut the long lines and keep the current voice. Offer a new format only when asked for one.

## 2026-11-15: invented phrasing

I kept "Turn it off so Autopilot can work" as the warm version. The maintainer: the normal way is "Turn it off to enable Autopilot", and they wanted the pattern learned, not the line fixed. The pattern: my warm and crisp attempts both invented their own phrasing ("carries on as usual", "the day averages", "so no sensor alarm"). Rule: write each line the way mainstream software says the same thing ("to enable", "Requires", "Loading", "This may take a few minutes", "Preview without making changes"), and when corrected on one line, re-check every line for the same habit.

- **A multi-day log never lives in the scratchpad.** The scratchpad is under /private/tmp, which a
  reboot clears: on 2026-11-16 a restart took the 48 h hardware-test logger's script and its 30 s CSV
  with it. Long-running test logs and the scripts that write them go in a folder outside /tmp
  (`~/nibe-logs/`), written in append mode so a restart continues the file.

## Read the mode the code reads, not a leftover setting (2026-11-16)
I told the maintainer hot water was "set to Simulated" from a device setting (`autopilotHotwater:
shadow`) that the app no longer reads; it was live, and hot water has no Simulated mode at all.
Rule: before stating what mode a function runs in, read what the code reads (Smart mode, the
widget's `test` flag), and check the UI offers the state I am about to name.

## Scope a UI change to the widget asked for (2026-11-16)
- Asked to redesign Hot water savings, I edited the page it shared byte-for-byte with Heating savings and
  shipped five commits that changed Heating too, without saying so.
- Rule: before editing a shared file, list every surface it drives. If the request names one, split the file
  or ask first; never let a change ride along to a surface nobody asked about.

## A figure must match where else the owner sees it (2026-11-17)
- The Energy today widget said 22.7 kWh / 86 kr while Homey Energy said 24.4 kWh / 92 kr: the widget
  stopped at the last hourly Insights refresh. Each figure was "right"; together they read as a bug.
- Rule: for every displayed figure, name the other places the same quantity shows (Homey Energy,
  Insights, other widgets, myUplink) and make them agree in source, time span, price basis and
  rounding, or label what differs. Check it before calling a widget ready.

## Plan vs actual is a verdict on the plan (2026-11-18)
I explained "above plan" away as a forecast check rather than a saving. The owner: it measures
whether the plan is good. A plan that runs 13–16 % low is a planner problem, since Autopilot
decides from that forecast. Treat a plan miss as a defect to explain (kWh or price, which
function), not as noise, and don't lead with what the card does not measure.

## "Expensive", never "dear" — in chat too (2026-11-19)
The rule covers everything I write to the user, not only owner text: recaps, wrap-up boxes, chat.
Before sending, scan for dear/dearer/dearest and write "more expensive" / "most expensive".

## Check the page as published, not the local copy (2026-11-19)
- The Autopilot loop artifact went out three times with garbled characters (° − – ·) and text running out
  of its boxes. I checked a local copy whose garbling I explained away as "local only", and judged the
  diagram by eye.
- Rule: write non-ASCII as HTML entities in published pages, so the encoding never matters. Before
  saying a page is done, measure every diagram label against its box with a script, and look at it
  in light, dark and phone width.

## Simulate a control change before proposing it (2026-11-19)
- I proposed a "trim per outdoor temperature" to the maintainer as the fix. The simulation afterwards
  showed it made both test houses worse, and that any faster trim overshoots a slow house.
- Rule: run a fix through the simulator (several house types, a wrong curve, weather that turns) before
  it is presented as the plan. Present the measured result, not the idea.

## 2026-11-20: never implement UI before the user has seen it
Added a pairing card and a Heating setup step straight into code, on a "yes" to the idea.
A yes to an idea is not a yes to its UI. **Rule:** any visible change (view, step, card, copy
placement, widget) is mocked and shown first: a rendered screenshot of the real page with the
change, light and dark. Build only after the user approves that mock.

## 2026-11-20: review what runs, not only what changed; check crash count after install
The app was stopped seven times for memory ("Memory Warning Limit Reached"): every hourly meter
read fetched all 184 devices, cached, to find the device's own id. The code came in on 13–15 Nov;
the review covered only the commits since the last install and asked only about correctness, and
the after-install check read `crashed` (true only while down), never `crashedCount`.
**Rules:** a review before an install covers everything that will run on the Homey since the last
review, not only new commits, and asks per repeated call: what does it cost per hour on a large
home (100+ devices), does it cache, does it grow. Every after-install check reads `crashedCount`
and memory; any rise is a failure, never "running".

## 2026-11-20: a test double must have the real library's shape
The Gateway's Proxy passed every test and broke every Homey API call in production: homey-api
defines manager methods as read-only, non-configurable properties, and the fake API used plain
objects. **Rule:** a double for a third-party object copies its property descriptors (or is built
from the real class), and anything that wraps a library is tried once against the real library
before an install. The after-install check fails on any device warning or a paused Autopilot.

## 2026-11-21: we heat hot water, we do not charge tanks
- The maintainer: "Sluta säg tanken. Vi värmer varmvatten, inte laddar tankar." Owner text had
  borrowed "charge" (laddning, Ladung) and "the tank" from the register names and NIBE's manual.
  **Rule:** owner text says what the owner gets, hot water heated, never the mechanism. "Tank"
  only for the physical tank (its model or size). Code identifiers and docs/ may keep "charge".

## Read a register the way the code reads it (2026-11-21)
I told the user room-sensor control was on because 202 read 1. The S1155 on zone firmware always
reports 202 = 1; the app treats an answering curve offset (30) as "off" (history.ts
`roomControlOff`). Rule: before stating a pump fact from a register, grep how the app interprets
that register, and say what the code concludes, not the raw value.

## Decide owner-facing methods for every owner, not from the maintainer's pump (2026-11-22)
I proposed choosing the heating savings method by logging both figures "for you" for a week on
the maintainer's Homey, and framed the trade-off around their autumn and their prices. The user:
"Who are we building this for?" Rule: a method choice is argued from what is right for any owner
in the six countries (SE, NO, DK, NL, DE and Homey's other markets), checked against several price
zones and house types in tests; the maintainer's pump is one sanity check, never the deciding data.

## Read a feature's mode where that feature lives (2026-11-22)
I told the user Hot water Autopilot was in shadow because the heating device's settings held
`autopilotHotwater: 'shadow'`, a stale copy. The hot water device's own log showed it live, writing
62/697 and starting a reserve charge at 12:15. Rule: before stating a feature's state, read it from
the device that runs it and confirm in that device's recent log lines (writes, charges); never infer
it from a setting on another device.

## 2026-11-23: a filtered stage must be compiled as staged

I staged my hunks with `git apply --cached --unidiff-zero` from a `git diff -U0` of a file another
session was also editing. With no context lines the hunk landed at the old line number, inside
`usage()`, and b55d94c did not compile; the working tree did, so my checks passed. Rule: when
staging part of a shared file, keep context (`git diff -U3`, no `--unidiff-zero`), then check the
staged tree itself before committing: `git stash`-free, e.g. `git diff --cached` read in full, or
`git worktree add` / `git archive` of the index and run `npm run typecheck` there.

## Check a cause against the days before it (2026-11-24)
I blamed the indoor drift on the Getting started hold (push 9 K → 3 K) from four days of 6 h blocks, and the
owner said "make your changes". Fourteen days of daily means showed the house did not warm on the two 9 K days
either, and sat at 22.0–22.4 on 4 K the week before. Before naming a cause, pull the daily means for at least a
week before the change and check the effect was there when the cause was.

## A back-test fits only on what came before (2026-11-24)
The first heat-loss back-test fitted through the end of each day it then predicted, so the fitted value had
seen the answer and won (7.7 % against 9.8 %). Fitted only on earlier days, it was a tie (9.6 % against
9.7 %). Every back-test cuts the training data strictly before the first predicted slot, and that includes
fits made "for convenience" to get states or parameters.

## Explain to the owner in plain words (2026-11-24)
A reply full of internal names (trim integral, curve advice, liveAt, flat-price hold) and tables read as
jibberish to the owner. When explaining results or risks: short sentences, everyday words, what happens to the
house. Code names only when asked.

## 2026-11-26: list every card before saying one is missing
I said hot water had no Autopilot trigger after filtering card ids by "autopilot". The trigger
`hotwater_charge_started` ("Hot water heating started", reason + detailed reason + autopilot) exists.
Rule: when asked whether a Flow card exists, list all cards for that device/feature by title,
not by an id pattern.

## 2026-11-26: one position on an unproven effect
I flip-flopped on wind: "doesn't matter" one day, "cost 0.8 °C, must account for it" the next.
Rule: an effect that is unproven and parked stays out of explanations and test designs. State it
once as unproven, and change that only with a back-test result.

## 2026-11-26: check a "too high" reading against the meter, at minute resolution
I called the 220 L after a hot water run inflated, from a guessed power limit (2.4 kW) and
per-run meter figures taken from hourly Insights, which are hourly means, not counter readings.
The minute meter showed the run made 2.4 kWh in 19 min (7.6 kW): the 220 L was right, and the
87 L before the run was the wrong one. Rule: before calling a sensor-derived figure impossible,
read the pump's own meter at minute resolution for that window, and test both ends of the jump.

## 2026-11-26: research prior work before planning a model
I planned a hot water litres investigation (logging, a draw test, three candidate models) from
this repo's own docs alone. Estimating the hot water left in a stratified tank from a few sensors
is a well-studied problem (manufacturers, theses, hobbyists). Rule: before planning any model or
estimator, search the literature, manufacturers and the HA community first, and build the plan
on what they found (memory: research-ha-community-first).
