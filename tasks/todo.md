# Working plan

Two things are live. Everything else that used to be here has shipped — the history is in the
commits and in the **Releases** table in [`README.md`](../README.md), the durable rules are in
[`CLAUDE.md`](../CLAUDE.md), and the design write-ups are under [`docs/`](../docs).

## 0.9.13 — release candidate

Built, tested and validated at publish level. Not published.

**It breaks.** Capability names change and several capabilities are removed, so **Repair is
needed on every Nibe device**, not just Heating. Flows pointing at a renamed setting must have it
picked again, and their Insights history starts fresh. This is stated in the changelog in both
languages.

What is in it:

- the Heating device becomes a real thermostat, reading the register that actually regulates
- **energy meters move to register 2305**, the source the pump uses for its own hourly books —
  measured to be exactly what myUplink publishes. The live tile stays on 2166, which is unfiltered
- operating mode becomes settable, which matters because the immersion permit only applies in
  Manual
- six capabilities that showed one setting twice collapse to one each
- three crash classes fixed: read-only registers offered as switches, a picker handed a value
  outside its list, and a picker that also carried an enum decoding to the label
- capabilities have a declared reading order per device
- pump-side changes are logged, so a schedule or a panel edit is visible rather than silent

Before publishing:

- [ ] push (30 commits on `feature/room-control`, no upstream set, ahead of `main`)
- [ ] `homey app publish`
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
