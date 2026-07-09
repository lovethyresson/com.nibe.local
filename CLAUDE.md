# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Homey (smart home platform) app that talks directly to Nibe S-series heat pumps over Modbus TCP on the local
network (bypassing Nibe's MyUplink cloud). It is a fork of https://github.com/sparud/net.sparud.nibe_s with
cumulative energy consumption added. Homey SDK v3, written in TypeScript.

## Commands

- `npm run build` — compile TypeScript (`tsc`).
- `npm run lint` — ESLint over `.js`/`.ts` using the `athom` config (`eslint-config-athom`).
- `homey app run` — run the app on a local/linked Homey for live testing (requires the `homey` CLI, `npm i -g homey`,
  and `homey login`). This project has no automated test suite; verification is manual via `homey app run` against a
  real or virtual Nibe device.
- `homey app validate` — validate `app.json`/compose files before publishing.

There is no test framework configured in this repo.

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

### The register table is the core abstraction

Everything in this app — capabilities, polling, flow cards, read/write behavior, feature detection — is driven by a
single array, `registers: Register[]`, defined in [drivers/nibe_s/registers.ts](drivers/nibe_s/registers.ts) (shared
by `device.ts`, `driver.ts` and `detection.ts`). Each entry maps one Nibe Modbus register to one Homey capability:

```ts
{ address: 1, name: "measure_temperature.i1_outside", direction: Dir.In, group: "core", scale: 10 }
```

- `direction: Dir.In` → Modbus *input* register (read-only, sensor data). `Dir.Out` → Modbus *holding* register
  (read/write, settings). This maps to `readInputRegisters` vs `readHoldingRegisters`/`writeSingleRegister`.
- `group` — the feature group the register belongs to (`core`, `heating`, `hotwater`, `pool`, `ventilation`,
  `groundsource`, `electrical`, `diagnostics`, `statistics`). `core` registers are always enabled; the rest follow
  the user's feature selection (see below).
- `scale` — divide raw register value by this to get the real value (e.g. temperature in tenths of a degree).
- `enum` — raw value maps to a human-readable string (see `returnairMap`, `priorityMap`, `hotwaterMap`,
  `onetimeincreaseMap`, `booleanMap`, `modeMap` near the top of the file).
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

`checkConfig()` in `device.ts` runs at device init and logs a warning for any register missing from the compiled
`capabilities` array or `capabilitiesOptions` (from `driver.compose.json`) — check the logs after changes here.
The compose `capabilities` array is the *superset* of what a device can have; each actual device carries only the
subset matching its feature selection.

### Feature selection, detection and static registers

Devices don't get all capabilities — the user picks feature groups (plus optional per-capability overrides) during
pairing, and can change the selection later via the device's **repair** flow (device menu → Repair):

- The selection is stored on the device as store value `selection` (`{ groups: {heating: true, ...},
  overrides: {"cap.name": bool} }`). `isRegisterEnabled()` in `registers.ts` resolves it; **a missing selection
  means everything enabled**, which is both the upgrade path for pre-existing devices and the "skip detection"
  default.
- `syncCapabilities()` in `device.ts` reconciles the device's capabilities with the selection at `onInit` and after
  repair — it also removes capabilities that no longer exist in the register table at all, so dropping a register
  from the table is self-cleaning on running devices.
- [drivers/nibe_s/detection.ts](drivers/nibe_s/detection.ts) samples every register 5× over ~30s and recommends
  groups whose registers *moved* (or, failing that, read plausible non-zero values — e.g. pool temp in a sane
  range). `probeHost()` opens its own short-lived socket for pairing; repair reuses the device's live connection via
  `device.probeForDetection()`.
- Static configuration registers (fuse size, periodic hot water start time) are **not** capabilities — they're in
  `staticRegisters` in `registers.ts` and get written to read-only `label` settings (declared in
  `driver.compose.json` `settings`) once per connect via `updateStaticSettings()`.

This app has no other installs beyond the maintainer's own device, so capability renames/removals are currently
done as a hard cut (change the name in `registers`/`driver.compose.json`, done) rather than a migration — the
device gets re-paired or manually fixed up if needed. **If that ever changes (the app gets other real users), a
capability rename needs a proper migration, and there are sharp edges worth knowing before adding one:**

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
`registerAutofillFlow()` in `device.ts` wires each card's autocomplete listener (filtered by a predicate over
`Register`, e.g. "only `Dir.Out` + numeric", always AND-ed with the device's current feature selection) and its run
listener. Enum registers instead get dedicated per-register
action/condition cards named `<capability_name>.enum` (registered dynamically in `onInit`, driven by
`actionSpecs`/`conditionSpecs` built from the flow compose file), since enums need a `mode` autocomplete rather than
a free-form value.

### Device lifecycle (`drivers/nibe_s/device.ts`)

- One shared module-level `net.Socket()` — connects on `onInit` to `getSettings().address` (the IP entered during
  pairing), port 502 (Modbus).
- On `connect`: device marked available, polls the currently *enabled* registers every 5s (`poll()` →
  `readRegisters()` → `setValue()` per register), with an initial delayed poll and a one-shot
  `updateStaticSettings()`.
- On `close`: device marked unavailable-ish (via the `error`/`close` handlers), auto-reconnects after 5s via
  `retryInterval`.
- `setValue()` writes the capability and fires the relevant trigger (`checkTrigger`) only when the value actually
  changed.
- Writable capabilities get a `registerCapabilityListener` that writes to the Modbus register and re-triggers flow
  cards.

### Pairing & repair (`drivers/nibe_s/driver.ts` + `pair/`/`repair/` views)

Three-step pairing: `ip_address` (IP validated with `net.isIP`, becomes device `data.id` + `address` setting) →
`detect` (runs `probeHost()` with a progress bar; skippable) → `features` (group checkboxes pre-checked from the
recommendation, expandable to per-capability overrides; creates the device with the filtered `capabilities` list
and the `selection` store value). The repair flow (`onRepair`) reuses the `detect` + `features` views — Homey
requires repair view HTML to live in `drivers/nibe_s/repair/`, so those files are copies of the `pair/` ones; the
actual logic is shared in `assets/pair/detect.js` and `assets/pair/features.js` (plus `assets/pair/pair.css`), and
the views differ only through the `mode` field the driver returns from the `get_context` handler. Keep the
`pair/` and `repair/` HTML copies identical.

### i18n

Two separate locale layers: `locales/*.json` (top-level app store listing text) and `.homeycompose/locales/*.json`
(compose-merged into `app.json`, used for in-app strings like enum labels via `this.homey.__(...)`). Keep both in
sync with English/Swedish when adding user-facing strings.
