# Registers that live somewhere else on some models

**Status: done, 0.9.12.** Implemented as described below — resolution at detection, stored in the
device's selection as `addresses`. Live reference is [`docs/pairing.md`](../docs/pairing.md); this
file is kept as the reasoning trail (why not a model-code table, why the band matters).

Not carried over: PR #3's runtime per-read fallback, superseded by resolving once at detection.
Still open — reply to PR #3 crediting the mechanism.

Prompted by [PR #3](https://github.com/lovethyresson/com.nibe.local/pull/3) (halderex): on his
S735 the room-temperature tile is empty because register **111** returns the not-available
sentinel there, while the real BT50 value sits at **26**.

## There are two different problems here

Worth keeping apart, because they need different evidence:

**(a) Relocation — documented.** The register genuinely lives at another address on that model.
Predictable from the CSVs. Four cases found by diffing our table's registers against every model
map for the same *title* at a different address:

| our register | moves to | on |
|---|---|---|
| `i1102_heating_pump` — Heating medium pump speed (GP1) | **1636** | S330/S332 |
| `h227_nightchill` — Night cooling 1 | **2955** | S330/S332, S2125 |
| `i398_pulse_energy` — Pulse energy meter (BE6) | **396** | S320/S325 |

**(b) Present but dead — undocumented.** The register is listed for the model and answers, but
with the sentinel, and the value lives elsewhere. **BT50 on the S735 is this case** — which is why
it does *not* appear in the table above. Only reading the pump finds these.

This distinction is the reason a model-map alone cannot solve it.

## Decision: alternates resolved at detection

A register may declare `altAddresses` (plus a plausibility band). **Detection** probes them once,
records which address actually works, and the runtime reads the resolved one.

Detection is already the component that samples every register and decides what a pump can do, so
this is where the knowledge belongs. It also means:

- one mechanism covers both (a) and (b)
- no type-code → model table to build or maintain
- no per-poll cost — resolved once, not probed forever
- it closes the gap in PR #3 by construction (see below)
- consistent with `powerSources`, the ordered-fallback pattern we already validated in 0.9.9

**User choice stays the narrow case:** offer it only when several candidates read plausibly *and*
genuinely differ in meaning — e.g. 26 is "Roomsensor 1-1" while 111 is "Room average temp. clim.
system 6", which are not the same quantity in a multi-zone house. Nobody can usefully be asked
whether their pulse meter is at 396 or 398.

## Why not a model check

Considered and rejected, but for reasons worth recording since it will come up again:

- **No type-code → model mapping exists.** We read type `55` (S1155) and `32` (Erik's S2125 +
  VVM S320). Nibe publishes no mapping we could find; we would be reverse-engineering it from
  users, and a wrong entry means reading wrong registers.
- **It does not solve (b) at all.** BT50 on the S735 needs a live read whatever the model says.
- **The CSVs are demonstrably imperfect.** Already found twice: 2289/2297 listed for the S1155 but
  absent on the unit; 26 unlisted for the S735 but working. A model map inherits those errors.
- **It reverses the July architecture decision without cause.** That decision rested on there
  being zero semantic collisions across models — an address means the same thing everywhere. That
  is still true: relocation is the same meaning at a different address, not a collision.
- Unknown model still needs the probe path, so you maintain both.

Model identification stays what it is today: **reporting** (type code + firmware in settings and
logs), not branching.

## Review findings on PR #3 — to fold in when we pick this up

The mechanism he wrote is good and follows `powerSources`; these are the gaps.

- **Detection never sees the fallback.** `lib/detection.ts:63` reads registers directly rather
  than through `readRegisterRaw`, so on a *fresh pair* of an S735: 111 → sentinel →
  `toNumericValue` returns undefined → `reads: 0` → `deviceTemplate` sets the override false →
  **the capability is dropped**, and the runtime fallback never gets a chance. He does not hit
  this because his device already carries the capability. Resolving at detection fixes it by
  construction.
- **26 and 111 are different quantities** (see above). He kept 111 primary to leave S1155
  behaviour untouched, which is defensible — but our capability is *named* `i26_inside` and
  titled "room sensor 1", which matches 26. Worth deciding deliberately rather than by accident.
- **26 is not in the S735 CSV at all**, yet reads 22.5 °C. Same shape as the 2727 trap — a
  plausible number from an unlisted register. His corroboration against the real room temperature
  is decent evidence, but it should be stated as such.
- **The band `[-10, 50]` accepts exactly 0.** A disconnected sensor reading a true zero would be
  taken as 0 °C rather than falling through. Given how much trouble flat zeros have caused us
  (2727 answered 31/31 reads and was always zero), consider whether 0 should be excluded — noting
  a genuinely 0 °C room is possible.

## How it landed

1. ✅ `altAddresses` + `altPlausible` band on `Register` (lib/registers.ts).
2. ✅ Resolved by `resolveAlternates()` after sampling (lib/detection.ts), carried through
   `DetectionResult.addresses` into the device's stored selection.
3. ✅ Reads resolve in `registersForRole()`; writes resolve at call time in `writeRegister()`,
   so a repair that moves a register doesn't need a restart. No per-poll probing.
4. ✅ All four populated: 111→26, 1102→1636, 227→2955, 398→396.
5. ✅ The register dump marks a resolved register `[was <primary>]`.
6. ⬜ Reply to PR #3.

On the four review findings above: the detection gap is closed by construction; 26-vs-111 was
decided by keeping 111 primary and only falling back when it reads nothing at all; the S735's
undocumented 26 is guarded by the band rather than trusted; and the "band accepts exactly 0"
problem is solved per register rather than globally — room temperature uses 5..40 so a dead
sensor's 0 falls outside, while the pulse meter's band includes 0 because there it is data.
