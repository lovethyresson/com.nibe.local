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

## Phase 2 — Add `nibe_f` driver (after gate)
- [ ] 2a. F register table + profile + compose + pair/repair + locales + assets
- [ ] 2b. Energy/COP: native produced meters + summed powerSources; fixed-speed degrade
- [ ] 2c. Generalize `dev/audit-registers.mjs` to both tables
- [ ] Verify: F simulator harness, audit, static deviceTemplate dry-run; beta for live gateway user

---

# (prior work) Full register set + per-function energy/COP + model info

Plan: `~/.claude/plans/i-got-the-current-goofy-crescent.md` (approved 2026-07-21;
model-detection scope cut back 2026-07-21 — see Architecture decision below)

## Phase 1 — 32-bit register support (blocker + latent s32 fix) ✅
- [x] Add `size?: 16 | 32` to `Register`; helpers `combineRaw`/`signedValue`/`isUnavailableRaw`
- [x] `connection.ts readRegisterRaw()` reads 2 words for size-32, combines low-word-first
- [x] `device.ts fromRegisterValue` branches two's-complement on size (writes stay 16-bit; no 32-bit writes in scope)
- [x] `registers.ts toNumericValue()` + `detection.ts readNumeric()` 32-bit aware
- [x] Retag existing s32 registers 1025 / 1083 / 1087 as `size: 32`
- [x] Verified: build green; decode matches live probe (1585→117140.4, 3821→143907, 3823→41486.3, etc.)

## Phase 2 — Total energy + total COP quick win (3821/3823) ✅
- [x] Added 3821 (Tot. production) + 3823 (Tot. consumption), size 32 scale 10, group statistics → main
- [x] New capability types `meter_kwh_NIBE` (custom, NOT meter_power → no Energy-tab double-count) + `measure_cop_NIBE`
- [x] Total COP = 3821/3823 derived on main (extra cap `measure_cop_NIBE.total`, gated on statistics group)
- [x] Verified: tsc build + `homey app build` + `homey app validate --level publish` all green

## Architecture decision (2026-07-21) — keep ONE driver + superset; drop model fingerprinting
Evidence: diffed all 94 app registers across the 6 S-model CSVs → **0 genuine semantic collisions** (an
address means the same thing on every S-model; models differ only by which addresses exist). So the single
superset table + "read it; if absent it excepts and gets gated" is safe. Per-model drivers would only remove
the not-yet-built model-ID layer while duplicating the real complexity (per-function split + feature
detection) across N drivers plus N compose/pair-view copies — net more complex. Decision: stay single-driver;
replace auto model-identification with the trivial "read/ask" version; make the CSV work a dev tool, not a
shipped pipeline.

## Phase 4 (revised) — Model info, not model detection [minimal] ✅
- [x] Read **1497** (type code) + **1496** (firmware) on Main's connect (`updatePumpInfo`); log them and
      write to read-only "Heat pump" settings labels (firmware + type code), mirrored to all devices on the pump.
- [x] Cut entirely: fingerprint classifier, marker matching, confidence, per-model detection scoping, generic
      fallback, runtime catalog. Detection unchanged (feature/accessory only).
- [ ] Optional (not built): a model dropdown pairing step for a friendly name — skipped unless wanted.
- [ ] Verify on hardware: firmware 1496 display format (raw "1036" vs a dotted version) once running.

## Phase 3 (revised) — CSV audit script [dev tool, not shipped] ✅
- [x] `dev/audit-registers.mjs` + `dev/README.md`; `dev/` in `.homeyignore` (not bundled), `dev/csv/` git-ignored.
- [x] Does (a) cross-model semantic-collision check (8 cosmetic-wording hits, 0 real), (b) unmapped-register
      worklist (present in CSVs, absent from registers.ts) — the source for Phase 5-tail additions.
- [x] No `models.generated.ts`, no runtime catalog, no per-model sets. Verified runs green.

## Phase 5 — Offer-all expansion ✅ (verified slice; full accessory set pending via Phase 3 pipeline)
- [x] +10 registers (all specs verified vs yozik04 s1155_s1255.csv), 84 → 94 total:
      1975 alarm code, 1100 compressor status, 398 pulse meter, 2176/2180 PV, 87/174/175 HW-circ temps,
      1063 HW-circ pump, 183 auto cooling start-temp
- [x] Solar is its own **`solarpanel`-class device** (role "solar", not on main, not a function role):
      2176 → official `measure_power` (generation W), 2180 → `meter_power.solar` (cumulative, `relative`),
      declared as exported via `setEnergy({meterPowerExportedCapability})` → shows as production in Energy tab.
      Allocator scoped to functionRoles so it never charges solar; new `assets/solar.svg`; `allRoles` drives pairing.
      Note: reused base `measure_power` id (Homey needs it for real-time) → benign overlap with the function
      energy-extra in cleanSelection; traced, no functional impact.
- [x] Folded HW-circulation sensors into `hotwater` (detection gates the missing ones per-pump)
- [x] Compose sync: capabilities + options + `groups.solar` locale (6 langs); all 94 registers mapped (verified)
- [x] Verified: build + `homey app validate --level publish` green
- [ ] Remaining accessories (extra climate ECS, shunt/step add-heat, full cooling accessories, pool-310
      extras, ground-water pump, AUX smart-grid write interface) — add to the table on demand as forum users
      ask; use the Phase 3 audit script to spot what's available. Not a pipeline.

## Phase 6 — Per-function produced meters + COP ✅ (rolling 30-day, since-pairing)
- [x] Per-function produced registers 1577/1575/1581/1579 (heating/hotwater/pool/cooling), detection-gated
- [x] `relative` flag → all energy counters (3821/3823 + produced) baselined at pairing → "since added"
- [x] Rolling 30-day COP everywhere: main `measure_cop_NIBE.total`, functions `measure_cop_NIBE.rolling`
      (produced-delta / used-delta over trailing 30d via device-store snapshots, cadence 6h)
- [x] Function used-meter retitled "Energy used" (vs "Energy delivered" produced + rolling COP)
- [x] Verified: build + `homey app validate --level publish` green; 6 new caps in app.json driver

## Gotcha (2026-07-21)
- A `number`/`uiComponent:sensor` capability **must** declare `units`, or Homey silently fails to register
  the type at install — `hasCapability` is true but `getCapabilityOptions`/`setCapabilityValue` throw
  "Invalid Capability". `homey app validate` does NOT catch this. `measure_cop_NIBE` hit it; fixed by adding
  `units:"COP"`. `ensureCapabilityOptions` now try/catches so it can't spam onInit either.

## Pairing grouping fix (2026-07-21)
- COP capabilities weren't shown, and produced meters displayed under Heating/Cooling instead of Energy.
- Fixed by moving the produced + total production/consumption meters into the shared `energy` group, with a
  new per-register `role` pin (registersForRole/roleRegisters filter on it) so each still lands on the right
  device. Added `energy` to Main's roleGroups; Total COP now gates on the energy group.
- `energyGroupEntries()` now returns the full energy group (real registers + derived used/power pair + rolling
  COP); both pairing (candidateGroups) and repair (groupInfo) render it. Verified routing per role.
- No new capability types → a normal app reload (not a clean reinstall) picks this up.
- Follow-up fix: moving produced/COP into `energy` made that group "recommended" (its meters move), which
  leaked into per-device pre-check (Pool/Cooling pre-checked without hardware). Fixed: `detected` in
  pairingCandidates now excludes the universal `energy` group — judges presence by function-specific groups only.

## Design decisions (from user, 2026-07-21)
- COP = rolling **30-day** (not lifetime — must visibly move through the season)
- Energy = **everything since pairing** (3821/3823 rebaselined at pairing so main totals reconcile with
  the sum of function meters; lifetime odometer numbers deliberately not shown)

## Debug logging (ad-hoc, for "restart → reproduce → send logs") ✅
- [x] Driver init logs app version + register/device counts
- [x] onPair: session start, discover scan/results, detection path + "X/Y responded" + per-group evidence, devices offered
- [x] onRepair: start (role+selection) + detection summary
- [x] Device init: role/host/enabled-groups + synced capability list
- [x] `ensureCapabilityOptions` guards `hasCapability` (no "Invalid Capability" throw on stale manifest)

## Verification
- [ ] build + lint + validate; `homey app run` against live S1155 (probe values as oracle)

## Review
**Phases 1–2 landed (2026-07-21).** Foundational 32-bit support + the headline energy/COP win.
- 32-bit read path added (`combineRaw`/`signedValue`/`isUnavailableRaw`), threaded through connection poll,
  device value decode, and detection sampling. Existing s32 counters 1025/1083/1087 retagged (fixes a latent
  wrap once they pass 65535).
- New: `meter_kwh_NIBE.i3821_total_production`, `meter_kwh_NIBE.i3823_total_consumption`, and derived
  `measure_cop_NIBE.total` (lifetime COP) on the main device.
- Verified against live-probe values: 3821=143,907 kWh, 3823=41,486 kWh → COP 3.47. Build + publish validate green.
- **Needs live `homey app run` on the S1155** to confirm the values render and Insights log (per plan verification).

**Not committed** (no commit requested). Remaining: Phase 3 (CSV pipeline), 4 (model detection + pairing UI),
5 (offer-all register grind), 6 (per-function produced meters + per-function COP — epoch-sensitive, wants a
live heating/HW cycle to verify).

---

# App-review asset fixes (v0.9.5 store rejection, 2026-07-22)

Reviewer rejected on four points:
1. Readme contains a URL → **DONE**: removed `github.com/yozik04/nibe` URL from `readme.txt`
   (credit text de-linked). Jan Sparud already credited via manifest `contributors.developers`.
   `README.md` is the GitHub readme, not store-published — left as-is.
2. App icon (4 white squares) → new `assets/icon.svg`: NIBE wordmark + white "LIVE" pill w/ green
   live-dot (concept 3, user-approved). Transparent SVG. brandColor teal `#174E56` → red `#D81E28`.
3. App image (generic green squares) → NIBE logo lockup on white, `assets/images/{small,large,xlarge}.png`.
4. Driver image (identical to app image) → Nibe indoor-unit illustration on white, UNIQUE vs app image,
   `drivers/nibe_s/assets/images/{small,large,xlarge}.png`.

Tooling: SVG→PNG via headless Chrome (exact opaque dims) + `sips -z` downscale; `homey app build` + validate.

- [x] readme.txt URL removed
- [x] icon.svg + brandColor (NIBE+LIVE wordmark, concept 3; brandColor → #D81E28)
- [x] app images ×3 (NIBE S2125 lifestyle photo, crop B "balanced", 10:7)
- [x] driver images ×3 (NIBE S-Series product family on white — unique vs app image)
- [x] homey build + validate green — `homey app validate --level publish` ✓

## Review
All four rejection points fixed; validates at publish level.
1. readme.txt URL removed (credit de-linked; Jan Sparud stays in manifest contributors).
2. Icon: NIBE + green-dot "LIVE" pill wordmark, transparent SVG; brandColor teal → NIBE red #D81E28.
3. App image: NIBE S2125 lifestyle photo cropped to 10:7 (balanced framing).
4. Driver image: NIBE S-Series family on white, fully distinct from the app image.
Assets rasterized via headless Chrome (exact opaque dims) + sips downscale. Not committed / not published.
