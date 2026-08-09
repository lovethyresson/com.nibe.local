# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Homey (smart home platform) app that talks directly to Nibe S-series heat pumps over Modbus TCP on the local
network (bypassing Nibe's MyUplink cloud). It is a fork of [Jan Sparud's Nibe S-series
app](https://github.com/sparud/net.sparud.nibe_s) with
cumulative energy consumption added. Homey SDK v3, written in TypeScript.

## Commands

- `npm run build` — compile TypeScript (`tsc`) into `.homeybuild/`.
- `npm run typecheck` — `tsc --noEmit` over the app **and** `tsc -p tsconfig.test.json` over `test/`. The second
  half matters: `npm test` runs through `tsx`, which strips types without checking them, so the test suite is
  otherwise compiled by nothing. `tsconfig.json` excludes `test/` because its `outDir` is the shipped bundle.
- `npm run lint` — ESLint over `.js`/`.ts` using the `athom` config (`eslint-config-athom`).
- `npm test` — `node --test` over `test/*.test.ts` via `tsx`. Unit tests for the decode helpers, register-table
  invariants, role/selection logic, the capability-sync plan and the alarm tables, plus integration tests that
  run the real `PumpConnection` against an in-process `jsmodbus` fake pump (`test/integration.modbus.test.ts`).
  The fake pump can be given a bounded address space so reads past the edge behave like a register a model
  doesn't have, and a bare `net.Server` that accepts but never answers stands in for a wedged pump.
  **It takes ~3 minutes** — the integration tests wait on real timers rather than a fake clock.
- `homey app run` — run the app on a local/linked Homey for live testing (requires the `homey` CLI, `npm i -g homey`,
  and `homey login`). Tests cover the logic; anything about a *real* pump's register behaviour still has to be
  verified against hardware.
- `homey app validate` — validate `app.json`/compose files before publishing.

`npm run lint` fails repo-wide on pre-existing style (the codebase is 4-space, `eslint-config-athom` wants 2);
untouched files fail identically, so it is not a useful signal on a change. That is why CI
(`.github/workflows/ci.yml`) runs typecheck + tests + `homey app validate --level publish` and *not* lint.

Working in a git worktree? `node_modules` is gitignored, so a fresh worktree has none and `homey app install`
fails its dependency check. `worktree.symlinkDirectories` in `.claude/settings.local.json` symlinks it from the
main checkout for new worktrees. Beware: that makes `node_modules` **shared**, so run `npm install` in a
worktree only when its `package.json` genuinely diverges — and then give it a real directory, not the symlink.

### Releasing

Five things move together, and the last one is easy to forget:

1. `version` in `.homeycompose/app.json` **and** `package.json`.
2. `homey app build` to regenerate `app.json` (never hand-edit its version).
3. A user-facing entry in `.homeychangelog.json` — English and Swedish, written for a pump owner, not
   a developer. **Keep it to a few sentences.** It is a store listing, not release notes: name what
   changed for the owner and anything they must do, and stop. Register numbers, measurements, evidence
   and mechanism belong in the README row and `docs/`, which is where anyone who wants them will look.
   0.9.13 shipped a ~500-word wall nobody read — the detail was right, the venue was wrong.
4. A row in the **Releases** table in `docs/releases.md` — the engineering view: what changed and why it
   mattered. This is where register numbers, measurements and rejected alternatives belong. `README.md` is
   user-facing and deliberately carries none of it; don't add a release section back to it.
5. `docs/energy-attribution.md` if the release touched attribution, the power sources, the role mapping or
   the COP accumulators — it is the source of truth for that logic, carries the diagrams, and states which
   version it was last verified against. Bump that line even when nothing else in it changed. Add a Q to
   `docs/FAQ.md` if the release changes something a user would otherwise write in to ask about.

Per release, not per build — these are documentation, not generated artifacts.

Verify with `npm test`, `npm run typecheck`, `npx homey app validate --level publish` — the same
four steps CI runs (`.github/workflows/ci.yml`).

## Architecture

### Homey Compose

`app.json` is a generated/derived file — do not hand-edit the `capabilities`/`flow` sections that come from
`.homeycompose/`. The actual sources of truth are:

- `.homeycompose/app.json` — app-level manifest (id, version, author, category, etc.)
- `.homeycompose/capabilities/*.json` — custom capability *type* definitions (e.g. `measure_enum_NIBE`,
  `curve_mode_NIBE`, `hotwater_demand_NIBE`). These define UI component, units, icon, getable/setable — not the
  per-register instances.
- `.homeycompose/locales/*.json` — top-level app translations (English/Swedish).
- `drivers/nibe_s/driver.compose.json` — per-device capability *instances* (e.g.
  `measure_temperature_NIBE.i1_outside`) plus their `capabilitiesOptions` (title, decimals, units per instance).
- `drivers/nibe_s/driver.flow.compose.json` — flow card definitions (triggers/actions/conditions) used generically
  across all registers via autocomplete arguments (see below), not one flow card per register.

Homey's compose build step merges these into `app.json`. Run `homey app build`/`homey app validate` (via the
`homey` CLI) rather than editing `app.json` directly.

### Engine in `lib/`, model in `drivers/`

The app is written for more than one pump family, so nothing model-specific lives in the engine:

- **`lib/`** is the whole implementation — `device.ts`, `driver.ts`, `connection.ts`, `detection.ts`,
  `discovery.ts`, `registers.ts` (types + pure helpers), `roles.ts`, `profile.ts`, `alarms.ts`.
- **`drivers/nibe_s/`** is the S-series *model*: the register table, `profile.ts`, `reason.ts`, and two
  10-line subclasses. `drivers/nibe_s/device.ts` and `driver.ts` are literally
  `class NibeSDevice extends NibePumpDevice { profile = sProfile }` and nothing else.
- **`ModelProfile`** ([lib/profile.ts](lib/profile.ts)) is the seam between them, and is now more
  load-bearing than the register table: it carries the registers, the role config (power sources,
  priority mapping, per-function produced registers), the transport defaults, the alarm table, the
  detection rules, the mirrors, `displayOrder`, `renamedRegisters` and the compose surface.
  `makeProfile()` precomputes the derived catalog (`registerByName`, `pickerPrimary`).

So a register table is reached as `this.profile.registers`, never imported directly by the engine.

### The register table is the core data

Capabilities, polling, flow cards, read/write behavior and feature detection are all driven by a single
array, `registers: Register[]`, in [drivers/nibe_s/registers.ts](drivers/nibe_s/registers.ts). Each entry
maps one Nibe Modbus register to one Homey capability:

```ts
{ address: 1, name: "measure_temperature.i1_outside", direction: Dir.In, group: "core", scale: 10 }
```

- `direction: Dir.In` → Modbus *input* register (read-only, sensor data). `Dir.Out` → Modbus *holding* register
  (read/write, settings). This maps to `readInputRegisters` vs `readHoldingRegisters`/`writeSingleRegister`.
- `group` — the feature group the register belongs to. The list is `groupIds` in
  [lib/registers.ts](lib/registers.ts) plus `core`: `core`, `heating`, `hotwater`, `pool`, `cooling`,
  `ventilation`, `groundsource`, `electrical`, `solar`, `energy`, `alarm`, `diagnostics`, `statistics`.
  `core` registers are always enabled; the rest follow the user's feature selection (see below). Groups
  also decide which *device* a register lands on — see `roleGroups` in [lib/roles.ts](lib/roles.ts).
- `info` — required `{en, sv}` one-liner explaining what the register is; shown under each capability in the
  pairing/repair features view (deliberately inline here rather than in the locale files so a register is fully
  described in one place). The view also badges each capability as "Adjustable" vs "Insight only" based on
  `isAdjustable()` (`Dir.Out` and not `noAction`).
- `scale` — divide raw register value by this to get the real value (e.g. temperature in tenths of a degree).
- `enum` — raw value maps to a human-readable string (see `returnairMap`, `priorityMap`, `modeMap` near the
  top of the file). Pickers declare `pickerValues` instead — a curated shortlist of the values the capability
  offers, which is not the register's real domain.
- `bool` — register is a 0/1 on/off flag, exposed as an `onoff` capability and drives the
  `capability_turned_on`/`capability_turned_off` flow triggers.
- `picker` — exposes the raw value as a string for a dropdown-style settings capability (used alongside a
  numeric/enum capability that represents the same underlying register for a different UI purpose — several
  registers, e.g. address `26` and `30`, `56`, `66`, `92`, `109`, `5351`, intentionally appear twice in the table:
  once as a `measure_*`/`onoff` capability and once as a picker-style capability).
- `min`/`max` — valid range enforced when writing via the `set_numeric_value` flow action.
- `noAction` — register is read/displayed but excluded from the generic `set_numeric_value` flow action.

Capability *names* generally follow the convention `<capability_type>.<i|h><register_address>_<description>` — `i`
prefix = input register, `h` prefix = holding register (mnemonic, not enforced by code). Most types are custom
(`*_NIBE`, defined under `.homeycompose/capabilities/`), but registers that map onto Homey's official capability
types (`measure_power`, `meter_power`, `measure_current`, `target_temperature`, `onoff`) use the official type as
the prefix instead — this is what makes the device show up in Homey's Energy tab, so prefer an official type over a
custom `_NIBE` one whenever a register's semantics genuinely match it (e.g. don't use `meter_power` for a value
that resets periodically instead of counting up for the device's lifetime — Homey's Energy engine assumes
monotonically increasing counters).

When adding a new register/capability, you generally need to touch three places kept in sync:
1. Add the `Register` entry (with a `group`) in `drivers/nibe_s/registers.ts`.
2. Add the capability name to `drivers/nibe_s/driver.compose.json` (`capabilities` array + `capabilitiesOptions`).
3. If it's a new capability *type* that isn't an existing official Homey type or `*_NIBE` type, add a definition
   under `.homeycompose/capabilities/`.

`checkConfig()` in [lib/driver.ts](lib/driver.ts) runs at driver init and logs a warning for any register
missing from the compiled `capabilities` array or `capabilitiesOptions` (from `driver.compose.json`) —
check the logs after changes here. The compose `capabilities` array is the *superset* of what a device can
have; each actual device carries only the subset matching its role and feature selection.

Unit tests enforce the parts that are cheap to get wrong: every register present in the compose superset,
every custom capability type having at least one instance, every Flow card resolving to a live register, and
no register name colliding with a derived capability name.

### One pump, several devices: roles

A physical pump is paired as up to **six** Homey devices, one per function
([lib/roles.ts](lib/roles.ts)): `main`, `heating`, `hotwater`, `pool`, `cooling`, `solar`. This is the
app's headline feature, not an implementation detail — it is what lets a user automate "hot water" without
also getting every heating register on the same tile.

- `roleGroups` maps each role to the feature groups it carries. `main` owns `core` plus the
  diagnostic/statistic/electrical groups; ventilation folds into `heating`; `energy` is shared by every
  heat-producing function.
- `roleClass` gives each device a Homey device class (`heatpump`, `thermostat`, `waterheater`,
  `airconditioning`, `solarpanel`). The comments there record why each one — they were argued out against
  real tile behaviour, so read before changing.
- `functionRoles` (heating/hotwater/pool/cooling) each carry a slice of the pump's electricity via the
  allocator, plus a COP. `solar` is a producer, so it gets neither.
- Some capabilities are **derived, not registers**: `meter_power.total`, `measure_power`,
  `measure_cop_NIBE.total`/`.rolling`, `alarm_generic`. They are synthesized in `roles.ts` and excluded from
  register-table reconciliation. Their names share a namespace with register names — a unit test enforces
  that no register name collides with one, after the solar power register was literally called
  `measure_power`.
- `capabilitySyncPlan()` computes what a device should carry and the add/remove diff to get there. It is
  split out of `syncCapabilities()` precisely so it can be tested.

### Feature selection, detection and per-device settings

Devices don't get all capabilities — the user picks which devices to create and which feature groups they
carry (plus optional per-capability overrides) during pairing, and can change the selection later via the
device's **repair** flow (device menu → Repair):

- The selection is stored on the device as store value `selection` (`{ groups: {heating: true, ...},
  overrides: {"cap.name": bool} }`). `isRegisterEnabled()` in `registers.ts` resolves it; **a missing selection
  means everything enabled**, which is both the upgrade path for pre-existing devices and the "skip detection"
  default.
- `syncCapabilities()` in [lib/device.ts](lib/device.ts) reconciles the device's capabilities with the
  selection at `onInit` and after repair — it also removes capabilities that no longer exist in the register
  table at all, so dropping a register from the table is self-cleaning on running devices. It returns the
  capabilities that failed; `applySelection()` throws on them so a **repair reports what went wrong instead
  of claiming success it didn't have**. At `onInit` the failures are logged only — there is nobody to tell.
- [lib/detection.ts](lib/detection.ts) samples every register 5× over ~30s and recommends groups whose
  registers *moved* (or, failing that, read plausible non-zero values — e.g. pool temp in a sane range).
  `probeHost()` opens its own short-lived socket for pairing; repair reuses the device's live connection via
  `device.probeForDetection()`. Detection also resolves `altAddresses` (a register that lives elsewhere on
  some models) and records user-chosen `sources` into `Selection.addresses`.
- Read-only informational settings (firmware, pump model, alarm log) are **not** capabilities — they are
  written to `label` settings declared in `driver.compose.json` `settings` from `lib/device.ts`.

**This app is pre-1.0, so capability renames/removals are done as a hard cut** — change the name in
`registers`/`driver.compose.json` and you're done — rather than as a migration. Devices get re-paired or fixed up
by hand. That holds now that 0.9.13 is published and other people are running it: a handful of early users on a
pre-1.0 app is exactly who a hard cut is for, and asking them to run Repair is cheaper than carrying migration
machinery for every rename. Don't re-open this decision each time a release adds users — **1.0 is the line**, and
until then the answer is the hard cut.

`renamedRegisters` + `migrateSelection()` exist because 0.9.13's renames were worth carrying (a stored `selection`
is keyed by register name, so a rename otherwise loses that register's resolved address, not just its override).
That is a tool to reach for when a specific rename deserves it — not a standing requirement.

**After 1.0**, a rename needs a proper migration. Either way these sharp edges apply:

- **Don't delete a capability *type* definition (`.homeycompose/capabilities/*.json`) in the same release as a
  rename away from it.** A device that still has an instance of that type attached will have *every* capability
  operation in `onInit` fail (not just the orphaned one) as soon as the type becomes completely undeclared anywhere
  in the app — the SDK can't resolve a capability whose type it doesn't know, and every subsequent Homey RPC error
  in that `onInit` call confusingly echoes the *first* failure. Keep the old type declared for a release or two
  after devices have had a chance to migrate off it.
- **`addCapability()` alone does not apply `driver.compose.json`'s per-instance `capabilitiesOptions`** (title,
  decimals) for official capability types — it only applies the base type's built-in defaults (e.g. `measure_power`
  defaults to the generic title "Power"). Push the declared options explicitly with `setCapabilityOptions()` right
  after adding a capability (see `ensureCapabilityOptions()` in `device.ts`, which cheaply skips the call once
  options already match, since `setCapabilityOptions()` is documented as expensive).
- **A capability's Insights log display name is snapshotted once, the first time that exact capability ID is ever
  added, and never changes again** — not via `setCapabilityOptions()`, and not by removing and re-adding the same
  capability ID (Homey reattaches to the existing log rather than creating a fresh one). If a log was ever created
  with a wrong/generic name, the only fix is a genuine rename to a brand new capability ID.

### Flow cards are generic, not per-register

Rather than one flow card per register, `driver.flow.compose.json` defines a small set of generic cards
(`set_numeric_value`, `enable_feature`, `disable_feature`, `numeric_value_comparison`, `feature_enabled`,
`capability_changed`/`capability_turned_on`/`capability_turned_off`) that take a `register` autocomplete argument.
`registerAutofillFlow()` in [lib/driver.ts](lib/driver.ts) wires each card's autocomplete listener and its run
listener. The predicates deciding which registers each card offers are **named and exported** as
`flowPredicates` in [lib/registers.ts](lib/registers.ts), and the test asserting that a `noAction` register is
never writable imports those same predicates — it used to re-declare its own copies, which meant changing the
shipped predicate left the test green. Autocomplete is always AND-ed with the device's current feature
selection. Enum registers instead get dedicated per-register
action/condition cards named `<capability_name>.enum` (registered dynamically in `onInit`, driven by
`actionSpecs`/`conditionSpecs` built from the flow compose file), since enums need a `mode` autocomplete rather than
a free-form value.

### Connection and device lifecycle (`lib/connection.ts`, `lib/device.ts`)

**One `PumpConnection` per pump host, shared by that pump's devices.** `connections` is a module-level
`Map<string, PumpConnection>`; `PumpConnection.get(host, ...)` returns the existing one, and devices
`attach()`/`detach()` so the last one out destroys the socket. Five devices of one pump therefore share one
socket and one poll over the *union* of their registers (`unionRegisters()`); two pumps at different IPs get
two independent connections.

- Connects to `getSettings().address` (the IP entered during pairing), port 502 (Modbus).
- Polls every **10 s** by default (`POLL_SECONDS_DEFAULT`), user-settable 5–60 via the Advanced setting.
  Main owns the setting; function devices inherit it.
- Every request funnels through `withWireAccess()`, which serializes the wire — a write colliding with a
  poll's read batch was measured to cause batches of read failures. It has **two lanes**: writes jump ahead
  of queued reads, because a poll enqueues ~100 requests at once and each can take up to the 5 s jsmodbus
  timeout, so a user's write would otherwise wait minutes.
- **Watchdog**: `readRegisterRaw()` resolves `undefined` rather than rejecting, so a poll chain never fails.
  If two consecutive polls read *nothing at all*, the connection logs un-gated, marks subscribers down and
  drops the socket to force a reconnect. Without it, a pump that stopped answering while holding the TCP
  connection open left devices looking online with frozen values, indefinitely and silently.
- On `close`: devices marked unavailable, auto-reconnect after 5 s via `retryTimer`.
- `setValue()` writes the capability and fires the relevant trigger (`checkTrigger`) only when the value
  actually changed.
- Writable capabilities get a `registerCapabilityListener` that writes to the Modbus register and re-triggers
  flow cards. `readRegister()` and `writeRegister()` both resolve the register's address through the stored
  `Selection` — they must stay symmetric, since every write-then-verify Flow card uses the pair.
- The energy allocator, the 1028/3804 priority override and the hourly energy-log reconciliation all live in
  `connection.ts` too. See [docs/energy-attribution.md](docs/energy-attribution.md), which is the source of
  truth for that logic.

### Pairing & repair (`lib/driver.ts` + `pair/`/`repair/` views)

**Pairing and repair use different final steps, because they answer different questions.**

Three-step pairing: `ip_address` (auto-discovery + manual fallback; the chosen IP becomes part of device
`data.id`, as `<ip>#<role>`, plus the `address` setting) → `detect` (runs `probeHost()` with a progress bar;
skippable) → **`devices`** (which of the six role devices to create, pre-checked from the recommendation;
creates each with its filtered `capabilities` list and `selection` store value).

Repair (`onRepair`) is per-device and reuses `detect` → **`features`** (group checkboxes for that one device,
expandable to per-capability overrides).

So the view files are:

- `drivers/nibe_s/pair/` — `ip_address.html`, `detect.html`, `devices.html`
- `drivers/nibe_s/repair/` — `detect.html`, `features.html`

Homey requires repair view HTML to live under `repair/`, so **`detect.html` is duplicated in both and the two
copies must stay byte-identical** (a unit-testable invariant if it ever drifts). `features.html` exists only
under `repair/` and `devices.html` only under `pair/` — there is nothing to keep in sync for those. The shared
logic is in `assets/pair/detect.js`, `devices.js` and `features.js` (plus `assets/pair/pair.css`); the views
differ through the `mode` field the driver returns from `get_context`.

"Discovery" ([lib/discovery.ts](lib/discovery.ts)) is a subnet sweep, not a protocol: Modbus
TCP has no announcement mechanism and Nibe S-series pumps don't advertise via mDNS/SSDP, so the `ip_address` view
asks the driver to scan the Homey's /24 (from `homey.cloud.getLocalAddress()`) for open port 502 and verifies each
responder by reading input register 1 (outdoor temperature) — a plausible value marks it as a pump and doubles as
the label shown in the list. Already-paired IPs are excluded. This only works when Modbus TCP is enabled on the
pump (menu 7.5.9) and Homey shares the subnet, hence the manual IP field stays.

### i18n

Two separate locale layers: `locales/*.json` (top-level app store listing text) and `.homeycompose/locales/*.json`
(compose-merged into `app.json`, used for in-app strings like enum labels via `this.homey.__(...)`).

The app ships **six** languages — `en`, `sv`, `de`, `nl`, `no`, `da` — and `app.json` advertises all six in its
`description`, so a missing key shows a German user English. Both layers currently have full parity across all
six; keep it that way when adding user-facing strings. Note the compose step *merges into* `locales/` but never
prunes it, so a key removed from `.homeycompose/locales/` lingers there until deleted by hand.

Only two i18n keys are built dynamically — `groups.<id>` and `pair.evidence.<name>`. Everything else is a
literal, so an unreferenced key really is dead.
