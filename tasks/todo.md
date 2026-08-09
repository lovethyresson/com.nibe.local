# Working plan

Three things are live. Everything else that used to be here has shipped — the history is in the
commits and in the **Releases** table in [`README.md`](../README.md), the durable rules are in
[`CLAUDE.md`](../CLAUDE.md), and the design write-ups are under [`docs/`](../docs).

## 0.9.15 — pre-1.0 audit, staged and not yet published

A full audit of the codebase and architecture ahead of 1.0. Everything below is committed and
stamped; what remains is the publish itself.

**Four runtime defects fixed.** In rough order of how badly they would have read on the forum:

- A pump that stopped answering while holding the TCP connection open was **invisible, forever**.
  `readRegisterRaw()` resolves `undefined` rather than rejecting, so the poll chain never failed —
  which made the recovery path behind its `.catch` unreachable dead code, sitting under a comment
  claiming it handled exactly this. No reconnect, no `setUnavailable()`, no log line: the device
  looked online with frozen values. Now two consecutive empty polls drop the socket and reconnect.
  Covered by an integration test against a server that accepts but never answers; verified it
  fails without the fix.
- **Writes could be starved behind a poll.** Serializing the wire fixed collisions and introduced
  unbounded head-of-line blocking: a poll enqueues ~100 requests and each can take the 5 s jsmodbus
  timeout, so a flow action could wait minutes while Homey's own timeout reported failure. Writes
  now take a priority lane; the one-at-a-time guarantee is unchanged.
- **`readRegister()` ignored the resolved alternate address** while `writeRegister()` honoured it —
  and every write-then-verify flow card uses the pair. Latent rather than loud today (only the
  night-chill register both writes and has an alternate), but it was one numeric alternate away
  from telling users a successful write had failed.
- **A device setting was persisted on every poll** — tens of thousands of flash writes a day across
  four devices, forever. Debounced to 0.01 kWh steps, flushed on `onUninit`.

Plus: repair now reports capabilities it failed to apply instead of returning success regardless;
three flow triggers no longer fire unhandled rejections; the enum reverse-lookup gives a real
message instead of a bare TypeError.

**Dead weight removed.** Two orphan flow cards that had shipped in 0.9.13 *and* 0.9.14 with no
matching register; two orphan capability types; three dead enum maps (the measured 697 facts moved
onto the register itself rather than deleted); `groupsForRole()`; the unused `crc` dependency;
three unreferenced assets; ~11 dead locale keys. Locales are now at full six-language parity in
both layers — de/nl/no/da had been missing the operating-mode enum and the pairing sensor prompt.

**One rename, and it must be pre-1.0.** The solar EME 20 power register was literally named
`measure_power` — the same string as the derived live-draw capability every function device
carries. Renamed to `measure_power.i2176_solar_current`, carried by `renamedRegisters`. **Solar
owners need to run Repair.**

**A gate, at last.** `.github/workflows/ci.yml` runs typecheck (app *and* tests), tests, and
`validate --level publish`. The test suite had never been type-checked — `tsx` strips types without
checking — and had three real type errors. `tsconfig.json` now pins `strict` explicitly and stops
sweeping in `dev/*.mjs`.

**Tests: 94 → 101.** New guards so the deleted things cannot come back (every flow card resolves to
a live register; every capability type has an instance; no register name collides with a derived
capability name), the watchdog test, and the first coverage of the capability-sync decision every
existing device runs through at init and after every repair — extracted as `capabilitySyncPlan()`
so it could be tested at all.

`CLAUDE.md`'s Architecture section was rewritten: it had been describing the layout of two
refactors ago, including a `staticRegisters`/`updateStaticSettings()` feature that does not exist.

Still open:

- [ ] `homey app publish`
- [ ] decide whether 1.0 is next. The audit's remaining recommendation — splitting the 1,341-line
      `PumpConnection`, whose seams are clear (`energy/diagnostics`, `energy/allocator`,
      `modbus/transport`) — is deliberately **after** 1.0: it touches the comments that encode
      irreplaceable live measurements and buys nothing a user can see.

## 0.9.14 and 0.9.13 — published, running with other users

Published and live. **This is the release that ends the single-install era** — see the rename
section in `CLAUDE.md`, which no longer permits a hard cut now that renames land on pumps that
are not ours.

**It breaks, and that is measured rather than assumed.** Against 0.9.12 the compose capability
set goes 105 -> 102: **15 removed, 12 added**, several of them renames of the same register onto
a new type (`boolean_NIBE.i1063_hw_circulation` -> `status_NIBE.i1063_hw_circulation`,
`measure_enum_NIBE.h237_operating_mode` -> `operating_mode_NIBE.h237_operating_mode`,
`measure_temperature.i26_inside` -> root `measure_temperature`). So **Repair is needed on every
Nibe device**, not just Heating. Flows pointing at a renamed setting must have it picked again,
and their Insights history starts fresh. Stated in the changelog in both languages.

The publish-time trap in `CLAUDE.md` — deleting a capability *type* in the same release as a
rename away from it, which breaks every capability operation in `onInit` — is checked and clear:
two type files were added (`operating_mode_NIBE`, `status_NIBE`) and none deleted, so every
orphaned instance still resolves.

What is in it:

- the Heating device becomes a real thermostat, reading the register that actually regulates
- **energy meters move to register 2305**, the source the pump uses for its own hourly books —
  measured to be exactly what myUplink publishes. The live tile stays on 2166, which is unfiltered
- operating mode becomes settable, which matters because the immersion permit only applies in
  Manual
- six capabilities that showed one setting twice collapse to one each
- three crash classes fixed: read-only registers offered as switches, a picker handed a value
  outside its list, and a picker that also carried an enum decoding to the label
- capabilities have a declared reading order per device — applied to the list the pairing picker
  submits, which is what a device stores and renders; ordering the manifest alone did nothing
- the Hot Water tile follows "Allow hot water" again. A tile's on/off appearance *is* its quick
  action, so pinning "More hot water" to that slot had silently cost it the state
- pump-side changes are logged, so a schedule or a panel edit is visible rather than silent
- indoor setpoint (2505) writable, room sensor resolved at pairing, Pool a thermostat, Smart
  Price Adaption exposed — mechanism and evidence from halderex's PR #5

Done:

- [x] push — `feature/room-control` and `main` both at `f71d36f` on origin, fast-forwarded
      (no merge commit). Gate on that exact tree: 90/90 tests, `validate --level publish` clean
- [x] `homey app publish`

Still open, and now with an audience:

- [ ] watch it. Stability on other people's pumps is what decides 1.0 vs 0.9.14
- [ ] reply to [issue #4](https://github.com/lovethyresson/com.nibe.local/issues/4) — halderex's
      myUplink cross-check measured the energy log against parameter 25138 on the same pump in the
      same hour, 0.930 against 0.93, which is what justified moving the meters to 2305
- [ ] ask Erik (S2125) for a debug log once published — the hourly attribution check will show
      how the split behaves on a pump where 2305 is the only power source

## F-series — parked, and expect to re-plan

Paused 2026-07-30 and still paused. When it comes back it should start from a fresh plan rather
than the old checklist: the engine has moved a long way since that was written — ordered
power-source fallbacks, detection that requires a register to be *usable* rather than merely
present, per-capability support gating, alternate address resolution at detection, the register
dump, the display-order machinery — and the F design predates all of it.

The `feature/nibe-f-series` branch is deleted. Its Phase 1 work (the `lib/` extraction that made
the engine model-agnostic) is all in main, so nothing is lost.

What it would still need: an F register table, profile, compose, pair/repair views, locales and
assets; energy and COP from native produced meters with summed power sources, degrading sensibly
on fixed-speed units; and a live gateway user willing to run a beta, since there is no F hardware
here to test against.
