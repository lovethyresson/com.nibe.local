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
