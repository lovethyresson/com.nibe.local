# Working plan

Three things are live. Everything else that used to be here has shipped — the history is in the
commits and in the **Releases** table in [`README.md`](../README.md), the durable rules are in
[`CLAUDE.md`](../CLAUDE.md), and the design write-ups are under [`docs/`](../docs).

## Smart heating slice 4: shadow, weather feed-forward, sun per wall (2026-11-01)

Maintainer's go: "Do it" (shadow), sun impact differing per window direction, ±20 K test "Ok",
FAQ claim "a few percent" "Ok".

- [x] `solar.ts`: sun position + wall irradiance; east/west walls from DNI/DHI in the same
      Open-Meteo request; matched Open-Meteo's own walls within 1–2 W/m² RMSE over 14 days.
      History fields `gtiE`/`gtiW` appended; older files and journals load (journal read with the
      saved file's field count; every start saves first).
- [x] Model: one window area per wall, absolute (per-Ci drifted to 9 kW on day 1). Stage 2 seeded
      from the energy balance (RLS ranged 0.06×–26× on a slab warm-up). West-facing sim house
      learns its west sun.
- [x] Planner: comfort = setpoint (`comfortReference`), `comfortWeight` = 2 − price, no early exit
      on a thin spread, coast cap counts slots below comfort only; forecast sun discounted by
      trust. Real-weather bench (`--weather`/`--forecast`): steadier at Comfortable/Save some.
- [x] Shadow (`shadow.ts`, collector): all three presets every slot, log + state files,
      `dev/review-shadow.mjs`. Live on the Homey since 2026-11-01 08:45 (2.3 s a slot).
- [x] `probe-bt1.mjs --ladder` for §3.3, dry-run on the fake pump (0.55 per rung).
- [x] §3.3 pre-heat ladder on the S1155, 2026-11-02: gain 0.42/0.46/0.44/0.43 at −5…−20 K (0.44
      overall), all within 20 % of 0.50, so −20 K stands; 583 writes, 0 failures, DM ≥ −102, no
      immersion. Hot-water Flow re-enabled after the run.
- [ ] §3.3 coast ladder (`--ladder 5,10,15,20`), another day, needs the maintainer's go-ahead.
- [ ] Planner: check where it assumes the BT1 gain and use the measured 0.44, not 0.50.
- [ ] Shadow behind a hidden setting before any test-channel build.
- [ ] The planner's doing-nothing is the curve alone; if shadow's live error tracks sun or indoor,
      model the room loop (or require it off, as M3 does anyway).

## Smart heating slice 3: planner (offline)

- [x] `presets.ts`, `actuator.ts` (clamps on 184/183/185 in Auto, ramp, pass-through),
      `planner.ts` (cost at equal comfort, linear-response greedy). Tests in
      `test/smart-control.test.ts`.
- [x] `dev/evaluate-presets.mjs`: 20 SE3 days, measured lever → 0.9 / 2.3 / 5.2 % at no-worse
      comfort (plan §7.3 has the table and the three rejected objectives).
- [x] Why *Save the most* didn't use its depth: replans started from zero bias (fixed: warm
      start), and the lever is ~0.45·H, not H (measured; `PumpCurve.lever`).
- [ ] Rerun on the maintainer's learned house once the model is ready (`--model`).
- [ ] Learn the lever live per pump (`estimateLever` over the history) and keep it in the model file.

## Smart heating slice 2: house model (branch `smart-heating/m1-data`)

Offline only; nothing runs on the Homey yet. Design: `docs/smart-heating-plan.md` §4.2, §6.

- [x] `lib/smart/outdoor.ts`: real outdoor source (wired while not feeding, Homey sensor, forecast
      + per-hour bias), 6 h degraded limit.
- [x] `lib/smart/model.ts`: stage 1 RLS (heat-loss seed), stage 2 2R2C EKF with priors from the two
      Setup answers, gating, 6 h prediction RMSE, `toModelSlots`.
- [x] `test/smart-house-sim.ts` + `test/smart-model.test.ts`: radiator and slab houses recovered
      within 10 % heat loss / 15 % τ; a wrong answer still predicts inside 0.35 K.
- [x] `dev/fit-house-model.mjs` runs on the real file (day 1: 77/92 usable, 6 h RMSE 0.21 K;
      too short to read the parameters).
- [ ] Fit again after ≥ 5 valid days. Passive data has no excitation (§6.3), so expect τ low.
- [x] Run the model online: the collector refits over the whole history every hour
      (`lib/smart/house.ts`; heat for a slot lands slots later, so a refit beats stepping) and
      writes `smart-<id>.model.json` beside the history. Answers default to "Don't know".
- [x] `lib/smart/insights.ts`: heat loss, cool-down from the heated steady state, stored heat,
      sun, fast/slow; readiness (§6.4) and drift (§6.2) over one fit per day.
- [x] A reinstall at 20:23 on 2026-10-31 lost the slots since the 19:46 save, and a second one
      confirmed `homey app install` ends the process before `onUninit` saves. Each closed slot is
      now appended to `smart-<id>.bin.journal` (92 bytes, 100 since the wall fields) and replayed on load; the hourly save
      empties it.

**Daily model log** (`dev/fit-house-model.mjs … --system radiators`, history + journal):
- 2026-10-31 21:43 — 96 slots (30 Oct 20:45 → 21:15), 1 valid day, 78 usable; gap 19:45–20:15
  (lost to the reinstall before the journal), 21:00 partial (restart). Heat loss 310 W/K, τ 57 h,
  stored 17.6 kWh/K, lever 128 W/K, 6 h error 0.17 K. Learning (days, stability). No live
  `model.json` yet (first hourly fit ~22:03).
- 2026-11-01 21:45 — 192 slots, 158 usable, 2 valid days, no gaps today. Heat loss 296 W/K (live
  300), τ 72–75 h, sun E/S/W 0.5/1.1/0.6 kW at 500 W/m² (mostly south; E/W moved off the prior),
  lever 127 W/K (0.42·H), 6 h error 0.21 K. Learning (days, stability): too early for
  evaluate-presets. Shadow: 52 slots, 124 ms a slot; doing nothing predicted 1 h 0.18 K RMS (bias
  +0.14), 6 h 0.66 K RMS (bias **+0.62**, model too warm). Presets: Comfortable −6…0 K (coasting
  77 %), Save some −12…+2 (52 %), Save the most −20…0 (85 %); no clamps, ramps ≤ 2 K/slot, no
  pre-heat near add-heat (pre-heat max +2 K at 9 °C real). Planned saving 6.5/6.8/9.1 %.
  **The 6 h bias is the pump's own control, not the house model:** SPA is on (843 = 1) and cut
  calculated supply from 36 to 26 °C over the 17–20 price peak (3.4–3.5 kr), the compressor
  stopped 19–20 h with DM positive, and indoor fell 22.5 → 21.4 °C while outdoor rose. The
  doing-nothing baseline (curve alone) knows neither SPA nor the room loop, so live error is only
  a fair test of the feed-forward on slots with both off and nothing fed (the ladder's own slots
  are fed, so they aren't; the evening after it, with SPA and the room loop still off, would be). Settings
  read back unchanged (curve 5, 184 = 15, 185 = 5, 237 = Manual).

## Smart heating slice 1: data collection (branch `smart-heating/m1-data`)

**Goal.** Record what the house model will learn from, starting now, because learning needs weeks
of history. Nothing new is shown to the owner and nothing is written to the pump. Design source:
`docs/smart-heating-plan.md` §5.2–5.5.

**No switch (maintainer, 2026-10-30).** Collection runs on every Heating device in this build,
which goes onto the maintainer's Homey with `homey app install`; it is not released. The
owner-facing mode choice (`mode.ts`) gates it before anything ships.

**Pure modules (`lib/smart/`, unit-tested with an injected clock):**
- [x] `prices.ts`: Homey Energy response → 15-min UTC slots. 60-min zones ×4; DST days (92/100
      slots); user-cost formula by a hand-written parser (numbers, + − * /, parentheses, unary
      minus; never `eval`) with the `highestPriceWithUserCosts` self-check, else spot and
      `costsApplied: false`; tomorrow-missing vs today-missing.
- [x] `weather.ts`: Open-Meteo URL builder (location rounded to 2 decimals, `metno_seamless`,
      tilted irradiance S) and response → per-slot values, linear interpolation hourly → 15 min,
      24 h staleness. MET Norway fallback is left for a later slice.
- [x] `history.ts`: 15-min bucket aggregator (mean, kWh sum, fraction, flags), `partial` below
      80 % poll coverage and after a reconnect, `Float32Array` ring of 28 × 96 slots, versioned
      (de)serialisation.
- [x] `heat.ts`: spread each whole-kWh step of 1577 over the slots since the previous step,
      weighted by Hz; drop hot-water slots.

**Glue:**
- [x] `lib/smart/collector.ts`: one per pump, owned by Heating (the `indoorOwners` pattern).
      It takes `onPollComplete`/`lastRawFor` samples and the pump's total electricity per poll.
      It runs a price timer (hourly, every 15 min from 12:45 to 16:00 until tomorrow appears) and a
      weather timer (hourly ± 5 min).
- [x] `lib/smart/store-file.ts`: `/userdata/smart-<random>.bin`, with the random name held in the
      device store. Writes go through a temp file and a rename. Flushed hourly and in `onUninit`.
- [x] `wantedRegisters()` on Heating adds 1, 5, 7, 10, 11, 1017, 1046, 1577, 1028, 1029 and indoor
      while collecting.
- [x] Hourly debug line: slots filled, partial count, price and weather age.
- [x] `dev/read-smart-history.mjs`: download and decode the file, then print slots as CSV, so the
      data can be checked by eye.

**Out of this slice:** the model, insights, mode choice, Setup/Repair UI, Insights backfill, the
real-outdoor source while feeding (input 1 is real as long as nothing feeds), analytics and the
six-language strings (the slice adds no owner-facing text).

**Verify:**
- [x] `npm test`, `npm run typecheck` and `npx homey app validate --level publish` pass.
- [x] After 24 h on the installed dev build, read the file back (2026-10-31, 92 slots, none
      partial). 79/79 of the day's slots match Homey Energy's spot and all-in price; spread heat
      85.81 kWh vs 1577's 85.80. 2166 summed 5.8 % under 3823, so per-slot electricity now
      spreads 3823 instead (`electricityPerSlot`).
- [x] Dev build installed on the maintainer's Homey (`homey app install`); no release. First hour
      read back 2026-10-30: prices match the cost formula, 2166 sums to within 1 % of 3823; 1577
      flat because the pump made hot water all hour, so heat spreading is still unverified.

**Open for the maintainer:**
- 28 days of 15-min history (~230 KB) is enough for M1/M2.

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

## F-series — experimental driver in progress

The `codex/f-series-diagnostics` branch adds a shared-engine F-series driver with automatic
feature detection, a curated register superset from seven model exports, gateway address
selection, and improved remote diagnostics. See [F-series support](../docs/f-series.md).

Remaining validation: compare readings on the volunteer's F730, then independently test
MODBUS 40 through a TCP bridge and other F models. Reviewed controls, conditional Heating rendering and experimental allocation/COP are included;
compressor scaling, production availability and scope still require real-pump validation.

- [x] Document F-series energy limits in the README: allocation covers
      compressor and immersion consumption by operating priority. Main may show zero or very
      little because fans, circulation pumps, controls and inverter losses are not accounted
      for. Zero on Main does not mean zero standby electricity, and the function allocations
      are not a complete whole-pump electricity breakdown. Match the wording to the final
      validated implementation.

F-series handover checklist: [owner tests](../docs/f-series-user-test.md).

- [x] Incorporate F730 gateway follow-up: LOG.SET fast baseline, one slow background parameter per poll, two detection passes, observation-only debug dumps, delayed simulator mode. Hardware cache freshness remains to verify.

## Connection stability and IP changes (2026-09-24)

Triggered by diagnostic 70825e9c ("Tappar ofta kommunikation"): 4 min of `EHOSTUNREACH` every 8 s
to 192.168.1.29 — the pump was not on the LAN at that address (DHCP move or Wi-Fi drop).

- [x] 7. One reconnect path: every attempt goes through `openSocket()` (fresh socket + client).
- [x] 4. Connect timeout (10 s) on the live socket; a silently dropped SYN no longer takes ~2 min.
- [x] 5. Backoff 5 → 10 → 30 → 60 s; log the first failure and any change of error, then one
      summary every 10 min; log the reconnect with attempts + duration.
- [x] 6. Fan out `onConnectionDown` only on up→down (or when the problem kind changes), not per attempt.
- [x] 3. `setUnavailable(message)` explaining why (unreachable / refused / silent / searching), 6 languages.
- [x] 2. Address change in settings moves every device of the pump; refuse an address another pump uses;
      indoor-feed guard becomes pump-wide.
- [x] 1. Auto-relocation: after 3 min of connect failures, sweep the subnet (existing discovery);
      exclude every paired address; keep candidates whose model code (1497) matches the stored
      `heatpump_type` when known; move the pump only if exactly one remains. Rescan every 30 min
      while still down. Logged un-gated either way.
- [x] Tests: backoff/timeout/dedup (integration), relocation choice (unit), pump-wide move (device harness).
- [x] Docs: FAQ entry, releases row, CLAUDE.md connection section.

**Review.** All seven items done; `Lost Connection` now fires only on real drops (it fired on every
failed retry). Tests added for backoff/quiet logging/single down, the connect timeout, the search
trigger and window, candidate choice, the pump-wide settings move, relocation and BT50 ownership.
Shipped as part of 1.3.6, combined with the F-series work: one changelog entry, one releases row. Not verified against a real pump changing address; the sweep is the pairing
discovery code, which is.
