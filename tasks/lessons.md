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
