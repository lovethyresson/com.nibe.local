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

# 0.9.10 — per-function attribution (branch: TBD)

Trigger: Erik (forum), S320-class pump on v0.9.9, diagnostic
`9de6c000-7bc0-4d8b-bb48-5901b0bdb60b`. Used and produced energy now appear — the 0.9.9
fallback worked, his log shows `2166 ... did not read` followed by
`Energy allocator power source: 2305` — but only **Main** matches MyUplink. Cooling and hot
water are "way off". Heating unknown (34 °C outside).

## Hypothesis

Main is right because it reads the pump's own lifetime counters (3821/3823) and computes
nothing. The per-function *used* figures come from the allocator integrating **2305**, which
is an **averaged** power reading — the probe on the S1155 showed it lagging badly on
transients (920 W vs 2166's 1621 W on the ramp, 3420 vs 3244 on the decay) while its integral
over a whole run still matched to 1.4%.

The allocator charges each poll to whatever the priority register named *at that instant*. A
lagging signal therefore carries the tail of the previous function's power into the next one.
**Total preserved, split skewed** — precisely the reported symptom. So 0.9.9 turned "no data"
into "misattributed data" on models without 2166.

## Step 0 — classify the energy log (gates everything below)

`dev/probe-energylog.mjs` against the live S1155, ≥90 min so it crosses a `:00` boundary,
ideally over a hot-water cycle. The pump computes the split itself:

    2283/2285/2287/2289  produced per function, "over the past hour"
    2291/2293/2295/2297  used per function
    2299/2301/2303       used by the additional heater, per function

All present on every model except the pool ones (S320 only). "Over the past hour" is
undefined in Nibe's docs and could be a **bucket** (resets at :00), a **rolling** 60-minute
window, or the **previous** completed hour. Only bucket/previous can be differenced safely.

Decisive test in the script: do the per-function "used" registers sum to the delta of 3823?

- [x] Run the probe, classify each register — S1155, 2026-07-29, 07:42–09:12, 181 samples
- [x] Confirm the decomposition against 3823 / 3821

### Result: PREVIOUS COMPLETED HOUR, and it reconciles

The value visible during hour H is the total for hour **H-1**. It is static within the hour
and steps at `:00` — it does not accumulate, so it must be **counted when it steps, never
differenced**. 2293 (used hot water) read 0 through 07:42–07:59 while the compressor pulled
2.2–2.5 kW, jumped to 1.99 at 08:00:24, held exactly 1.99 all hour, then stepped to 0.13 at
09:00:24.

Accuracy, on the one hour fully inside the window (08:00–09:00): the compressor ran 08:00:24
to ~08:03:54 and integrating 2166 over it gives **0.136 kWh** including standby. The log
reported 0.13 hot water + 0.01 heating = **0.14 kWh** — agreement inside the 0.01 kWh
quantisation.

The probe's own -5.2% / -6.2% headline was an **artefact** and has been fixed: it compared
everything the log published during the window against the lifetime counters' movement across
the window, but the first report covers time before sampling started and the final part-hour
is not reported yet. Whole-hour alignment is the only valid comparison.

Also learned: the pump folds standby into **heating** (2291 sat at 0.01–0.02 kWh/h ≈ 10–20 W
with no heating demand), so "idle" is not a separate bucket in the pump's own accounting.

The classifier has been corrected to tell a bucket from a previous-hour report by whether the
value changes *during* the hour, not merely whether it drops at `:00`.

## Design that follows

Per-function **used** energy comes from the log, counted on each hourly step; **not** from the
allocator. Exact, no lag, no priority mapping — and it agrees with MyUplink by construction
because it is the pump's own arithmetic.

- [ ] On each poll read 2283–2303; when a register's value *changes*, add the new value to
      that function's cumulative meter. Persist the last-counted hour per register so a
      restart cannot double-count, and never count the first reading after install (we cannot
      know whether it was already counted).
- [ ] `measure_power` (live watts) stays on 2166/2305 — instantaneous, unaffected by this.
- [ ] Main's idle energy becomes Δ3823 minus the sum of the per-function figures, so the whole
      set reconciles with the pump by construction. Note the standby-in-heating finding above
      before assuming idle should be non-zero.
- [ ] Keep the allocator for models where the block does not read; gate on it via the existing
      `extraCapabilitySupport` machinery.
- [ ] Per-function energy now updates once an hour, up to an hour late. Fine for a cumulative
      meter (Homey's Energy tab wants a monotonic counter) — but it must be explained in the
      changelog or it reads as a regression in responsiveness.
- [ ] Pool (2287/2295/2303) is S320-only; cooling (2289/2297) did not read on the S1155 either.
      Cannot be verified locally — needs Erik, who has cooling running.

## Evidence from Erik (2026-07-30, screenshots + MyUplink)

Homey vs MyUplink for the same day, S320-class pump on v0.9.9:

| device | produced (Geleverde) | used | COP shown |
|---|---|---|---|
| Main   | 51 kWh (3821) | 17 kWh (3823) | ~3.0 implied — **correct** |
| Hot water | 40 kWh (1575) | 2.64 kWh (allocator) | **14.96** |
| Cooling | 14 kWh (1579) | 1.4 kWh (allocator) | **10.17** |

Both function COPs are physically impossible, and the totals are right, so the fault is in
how the two sides are paired per function. Two independent arithmetic problems:

1. **Used is far too low.** 2.64 + 1.4 = 4.04 kWh against a 17 kWh total. ~13 kWh went to
   Main's idle bucket. That is the allocator failing to charge the functions.
2. **Produced does not decompose.** 40 + 14 = 54 kWh against a total production of 51 kWh —
   over already, before heating. These come straight from pump registers, so **3821 is not
   the sum of the per-function counters**; most likely it excludes cooling, which is not heat
   "production" in Nibe's accounting. Needs confirming against Erik's register dump.

Note (2) matters beyond this bug: it means Main's Total COP and the per-function COPs are not
measuring commensurable things, and no amount of fixing the allocator changes that.

### Research: what Nibe actually documents (2026-07-30)

Source: Nibe's own **Modbus Register S-Series** list (installer.nibe.eu), which carries the
internal symbol names the per-model CSVs omit. The general *Modbus S-Series technical
information* PDF is no use here — its register table stops around 2308 and never reaches 3821.

Our per-function mapping is confirmed exactly:

    eMbInput_eU32EnergykWHPart_eHWADDINCL      1575   hot water, add. heat included
    eMbInput_eU32EnergykWHPart_eHEATADDINCL    1577   heating, add. heat included
    eMbInput_eU32EnergykWHPart_eCOOLCPRONLY    1579   cooling, compressor only
    eMbInput_eU32EnergykWHPart_ePOOLCPRONLY    1581   pool, compressor only
    eMbInput_eU32EnergykWHPart_eHWCPRONLY      1583   (not mapped)
    eMbInput_eU32EnergykWHPart_eHEATCPRONLY    1585   (not mapped)

Note the prefix — these are **Parts**. 1583/1585 would give the additional-heat share of hot
water and heating by subtraction, which we do not currently expose.

**The find that settles the composition question** — holding registers, i.e. user-settable:

    eMbHolding_eU8EnergyLogSettingsIncHW         3092
    eMbHolding_eU8EnergyLogSettingsIncPool1      3093
    eMbHolding_eU8EnergyLogSettingsIncPool2      3094
    eMbHolding_eU8EnergyLogSettingsIncCooling    3095
    eMbHolding_eU8EnergyLogSettingsIncTempOutdoor 3096

`Inc` = include. **What the energy log counts is configured on the pump**, not fixed. 3095
exists on S320/S325 and S2125 — Erik's models — and NOT on the S1155. The CSVs show it only as
`id:12391`, so it is invisible unless you have the symbol names.

Still undocumented: 3821/3823 are absent from that register list entirely (added to the
protocol later), so whether *they* honour the same Inc flags is unverified — but it is now
measurable rather than guessed.

- [x] The app now reads the inclusion flags itself — `energyLogSettings` on the profile,
      read once per connect on Main alongside the model info and logged as
      `Energy log counts: cooling=NO`. No need to ask a user to poke at holding registers with
      a Modbus tool.
      Verified on the live S1155 (2026-07-30): the block is absent there, so nothing is logged
      — correct, and it means **only Erik's S2125 can answer the composition question**; an
      S1155 offers no way to know what its own totals include. Cross-checking all six model
      maps also showed IncHW (3092) and IncPool2 (3094) exist on *no* S-model, so only cooling
      (3095, on S320/S325 + S2125) and pool 1 (3093, on S320/S325 + S1156/S1256) are declared.
- [ ] Over a period, check whether Δ3821 ≈ Δ1575 + Δ1577, or includes Δ1579.
- [ ] Consider exposing 1583/1585 so the additional-heat share is visible per function.

## Ask Erik before building

- [ ] Which is wrong — **used** or **produced**? Produced comes straight from the pump's own
      counters (1575/1579), so if that is off it is not the allocator at all: those registers
      are `relative: true` and read *since pairing*, while MyUplink shows lifetime. That would
      be a presentation mismatch, not an attribution bug, and needs a different fix.
- [ ] A run with **Debug logging** on, to get the priority transitions and the 30-minute
      energy-reconciliation summary.
- [ ] Rough magnitude of the error, and his exact model (the log says 2166 and 1100 absent,
      so S320/S325, S330/S332 or S2125).

## 0.9.11 — register dump on debug (shipped)

Turning on Debug logging now dumps every register the model knows: raw and decoded, including
ones the feature selection has switched off. The pattern this fixes is that nearly every bug so
far was "the pump doesn't report what we assumed", and each cost two or three round-trips with
a user to establish something the pump could have said once.

Decisions worth keeping: Main only (the debug setting mirrors onto all five devices, so
otherwise the pump fields 500 concurrent reads); sequential reads, ~1 s for 101 registers, on a
pump that permits a single client; grouped into ~13 long lines rather than 101 short ones; and
emitted **both** at connect and on debug-enable, because a diagnostic report is a rolling
buffer of undocumented size and a dump written at startup is the first thing an hour of debug
output pushes out.

- [ ] **Unverified:** Homey does not document any size/line/time limit on diagnostic reports —
      checked the SDK full-text export, the sitemap and the community threads. Send yourself a
      report from the S1155 with debug on and confirm the dump arrives intact and where it sits.

## Also in 0.9.10

- [x] Un-gate the two silent-misattribution warnings — `logUnknownPriority` and
      `warnMissingRoleDevice` were still `this.debug` after 0.9.9. Both describe energy being
      charged to the wrong device, which is a functional fault, not a debugging detail. Either
      one firing on Erik's pump explains the 13 kWh in idle, and neither would appear in a
      normal log. Proposed in the original analysis, missed when the 0.9.9 plan was written.
- [x] readme.txt trimmed for the Homey app-review feedback — was ~450 words across eight
      paragraphs plus a bullet list, now ~195 words in two content paragraphs, a pointer to the
      Community topic and the attribution line. The removed detail should be pasted into the
      forum topic; retrieve it with `git show HEAD:readme.txt`.
- [x] `1 register(s) did not read: 1496 @1496` — fixed. The one-shot info reads now carry
      synthetic `__pumpinfo.*` / `__energylog.*` names, so they read properly *and* drop out of
      the read-failure report entirely, which is right: they are optional, model-dependent
      lookups, and a model that does not publish them is not a fault. Same `__` convention as
      the reason inputs.
