# Nibe F-series support (branch: feature/nibe-f-series)

Plan: `~/.claude/plans/i-d-like-a-review-hidden-pony.md` (approved 2026-07-23)

## Phase 1 — Extract shared engine into `lib/` (S must stay byte-identical)
- [x] 1a. `lib/registers.ts` — Dir/Register/Selection/GroupId types + pure helpers + catalog builders
- [x] 1a. `lib/profile.ts` — `ModelProfile` type + `makeProfile()` factory
- [x] 1a. `lib/roles.ts` — generic role logic (registersForRole, extraCapabilities, roleGroups/Class/Names, cap-id constants)
- [x] 1a. `lib/connection.ts` — profile-parameterized (powerSources list, addressBase, transport)
- [x] 1a. `lib/detection.ts` — profile-parameterized (plausible + discoveryProbe from profile)
- [x] 1a. `lib/discovery.ts` — port + probe parameterized (DiscoveryOptions)
- [x] 1a. `lib/device.ts` (NibePumpDevice base) + `lib/driver.ts` (NibePumpDriver base)
- [x] 1a. `drivers/nibe_s/registers.ts` → S data only (imports types from lib); old engine files deleted
- [x] 1a. `drivers/nibe_s/profile.ts` → S profile (role consts, transport 502/1, compose, plausible, pumpInfo)
- [x] 1a. `drivers/nibe_s/{device,driver}.ts` → thin subclasses supplying sProfile
- [x] 1b. transport (port/unitId settings) + addressBase transform + powerSources — all S-neutral defaults
- [x] 1c. Test harness: `test/unit.test.ts` (21) + `test/integration.modbus.test.ts` (4, in-proc jsmodbus sim); `npm test`; `Dockerfile.test`
- [x] 1d GATE (automated): `npm run build` clean, `homey app validate --level publish` ✓, `npm test` 25/25 ✓, app.json **IDENTICAL** to committed
- [ ] 1d GATE (live): **needs user** — `homey app run` on S1155 @ 10.136.1.93; confirm 5 role devices, polling, energy/COP, a flow, repair
- note: `npm run lint` is a pre-existing dead signal on this repo (athom config not wired to TS parser — fails on untouched app.ts too); not a Phase 1 blocker

## Phase 2 — Add `nibe_f` driver — PAUSED, and expect to re-plan rather than resume

Parked deliberately (2026-07-30): S-series comes first, and it is not finished — per-function
attribution is still wrong on split models (see 0.9.10/0.9.11 below). When F does come back it
should start from a fresh plan rather than this checklist. The engine has moved a long way
since this was written — ordered power-source fallbacks, detection that requires a register to
be *usable* and not merely present, per-capability support gating, the register dump — and the
F design was drawn up before any of that existed. The `feature/nibe-f-series` branch has been
deleted; its Phase 1 work (the `lib/` extraction) is all in main, so nothing is lost.

The items below are kept as a record of what was intended, not as a plan to pick up:

- [ ] 2a. F register table + profile + compose + pair/repair + locales + assets
- [ ] 2b. Energy/COP: native produced meters + summed powerSources; fixed-speed degrade
- [ ] 2c. Generalize `dev/audit-registers.mjs` to both tables
- [ ] Verify: F simulator harness, audit, static deviceTemplate dry-run; beta for live gateway user

---

# Shipped

Compressed from the full working notes once each programme landed — the detail is in the
commits, the durable rules are in `CLAUDE.md`, `README.md` and `tasks/lessons.md`. Kept here
only where a decision still constrains the code.

**Full register set, per-function energy + COP, model info** — `f83ed21`, 2026-07-21.
32-bit read path; 3821/3823 + total COP; per-function produced meters (1577/1575/1581/1579);
rolling 30-day COP; solar as its own `solarpanel` device; `dev/audit-registers.mjs`.
Two product decisions from this round still hold: **COP is rolling 30-day**, not lifetime, so
it visibly moves through the season; and **energy is everything since pairing** — 3821/3823
are rebaselined at pairing (`relative`) so Main's totals reconcile with the sum of the
function meters, rather than showing lifetime odometer numbers.
The "one driver + superset table" decision is written up in README (*Works across the
S-series*); the custom-capability `units` gotcha is in memory and in the capability JSON.

**Store-rejection asset fixes (v0.9.5 → v0.9.6)** — `91994c2`, 2026-07-22.
readme.txt URL removed, icon/brandColor reworked, app and driver images made distinct.
Validates at publish level.

**S2125 / VVM S320 energy + silent-failure visibility (v0.9.9)** — `68077da`, `f0b32db`,
`7f071d6`, 2026-07-28/29.
Register 2166 does not exist on S320/S325, S330/S332 or S2125, so the allocator was skipped
wholesale and every per-function meter and COP stayed empty in silence. Power sources became
an ordered fallback list (2166 → 2305, first that reads wins, never summed); read failures,
missing power sources and the pairing capability map are now logged; the audit tool gained
app→CSV coverage and a width cross-check; detection learned that a register answering is not
the same as a register working (2727 answers 31/31 and is always zero; the not-available
sentinel is not a reading); and repair lets a fresh detection pass un-tick capabilities.
The reasoning is in `tasks/lessons.md` and the commit messages.

---

# Backlog (small, unscheduled)

- [ ] Firmware display format — 1496 reads a raw `1036` (confirmed on the live S1155, which
      logs "heat-pump type 55, firmware 1036"). Decide whether to render it dotted (`10.36`)
      or leave it raw. Cosmetic; nobody has asked.
- [ ] Optional model dropdown at pairing, purely for a friendly name. Deliberately not built.
- [ ] Further accessory registers (extra climate ECS, shunt/step add-heat, full cooling
      accessories, pool-310 extras, ground-water pump, AUX smart-grid write interface) —
      added on demand when a forum user asks. Use `dev/audit-registers.mjs` to see what is
      available. Deliberately not a pipeline.

---

# Per-function energy that matches myUplink (0.9.12 →)

Plan: `~/.claude/plans/breezy-nibbling-zebra.md` (approved 2026-08-01)

**The finding that drives it**, measured on the maintainer's S1155 against the myUplink app on
the same Homey, over the same 24 h:

| | Δ |
|---|---|
| myUplink "Total consumed energy" | 1.00 kWh |
| Nibe Live Main, register 3823 | 1.00 kWh — exact, same 5-minute bucket |
| Nibe Live Hot Water "Energy used" (allocator) | **1.37 kWh** |

Hot water alone claims 37% more than the pump says the whole unit used — on the model where
2166 exists and the allocator is supposed to work. Register-sourced figures match myUplink;
derived ones cannot. Users check against myUplink, so cumulative energy must come from the pump.

## Step 1 — observe + stop the bleeding (0.9.12) ✅ shipped to main, not published
- [x] COP numerator advances only while the allocator can measure. The old pairing divided the
      pump's always-running counter by an app-accumulated series: 40 ÷ 2.64 = 15.15, reported as
      14.96; cooling 14 ÷ 1.4 = 10.0 vs 10.17. Main (3821/3823) untouched.
- [x] Poisoned `copSamples` discarded on upgrade rather than migrated.
- [x] Energy log 2283–2303 + compressor-only 1583/1585 mapped `internal`; the poll loop now
      reads internal registers, and force-polls **both** lifetime counters (it previously forced
      only consumption, so the produced half of any reconciliation depended on Main happening to
      carry 3821 as a capability).
- [x] Each hourly step logged, with the startup reading taken as a baseline and the first step
      used to align the counters on a real `:00`.
- [x] `dev/analyse-energylog.mjs` — hour-by-hour reconciliation from a log alone.

## What the live run established (2026-08-01)

**The gate is passed.** On the S1155 with a forced hot-water cycle, the pump's own per-function
split against its own totals: hour 11:00 used **1.44 vs 1.40 (+2.9%)**, produced **4.77 vs 4.80
(−0.6%)**. The counters step in 0.1 kWh, so that *is* the quantisation floor. For contrast the
allocator over the same run: **+75.2%**, while shadow strategy B tracked **1.3%**.

**The counters lag the energy log by about an hour.** At 11:00 the log had booked 1.44 kWh while
3823 had not moved at all; 3823 caught up over the next hour. Same-hour comparison reads
1.44 vs 0.00 and looks catastrophic — both the log line and the analyser got this wrong first
time. The log is the timelier source as well as the finer one, so it is what corrections target.

**CSV presence ≠ the pump serves it.** 2289/2297 (cooling) are listed for the S1155 and return
"no answer" on the actual unit — so per-function fallback is needed regardless of Erik's pump,
which removes `cooling=NO` as a blocker.

**No current-hour register exists.** Every "hour" title across all six maps says *past* hour;
Nibe's symbol list has no input registers in 2280–2420; the myUplink Homey device has no hourly
capabilities; and 2293 held exactly 1.99 for 59 minutes before stepping. The pump's menu 3.1
shows a filling current-hour bar, so the data exists internally but is not published.

**Rejected: a user-facing "real-time vs volume" toggle.** It asks users a question they cannot
answer, one mode is known to disagree with myUplink by 37%, and it doubles the code paths. The
2166-vs-2305 difference is already abstracted by the `powerSources` chain — there is one path.

**Rejected: stepping the meter hourly.** The dominant error is not lost intra-hour resolution
but being a full hour late, and hour-to-hour spot swings are 2–5× while intra-hour ones are
small. Homey history is append-only, so forward correction is the only lever.

## Step 2 — see the plan file
Integrate live for the shape, correct onto the pump's hourly figure for the level. Time-based
gain, clamped so no meter can decrease, per-function fallback to plain integration. COP from the
hourly pair. **Idle stays broken out**, derived as `counter delta − Σ(functions)` — hour 10:00
showed every function at 0.00 while the counters moved 0.10 kWh, so the residual is real, and
taking it that way makes Σ(functions) + idle ≡ the pump's total by construction.

## External verification — Nibe S735 (Henrik / halderex)

Independent run on a **third model**, using our own probe unmodified:
[`todo-halderex.md`](todo-halderex.md), full write-up
[`s735-energylog-verification.md`](s735-energylog-verification.md).

Confirms previous-hour semantics and per-function accuracy on a **1.24 kWh** cycle (three-way
corroborated, implied COP 2.86) — a much stronger data point than our own 0.13 kWh one. Also
confirms the counter lag independently.

**It corrects us on standby.** The S735 shows 2291 at 0.05–0.06 kWh/h through pure standby, so
standby *does* fold into heating. Our S1155 hour 10:00 (all functions 0.00, counters +0.10) looked
like evidence for a real residual, but the S1155 idles at ~10 W — 0.01 kWh/h, below the log's
resolution — and that 0.10 was one quantisation tick covering several hours. So the earlier note in
this file claiming the residual is real was wrong, and **idle-by-subtraction is doubly
questionable**: the lag makes a per-hour subtraction go negative on a real cycle, and the residual
may be near zero anyway.

Method worth stealing: **hot-water boost overrides Smart Price Adaptation**, so a cycle can be
forced on demand rather than waited for.

## Next: soak before asking anyone
Run 0.9.12 on the S1155 for **24 h+** with debug on, then `node dev/analyse-energylog.mjs`,
compare Main's 3823 against the myUplink device via Homey MCP, and watch the COP rebuild toward
2–4. Only then is it worth publishing or asking users for logs.
