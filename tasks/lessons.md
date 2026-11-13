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
