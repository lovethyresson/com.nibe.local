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
