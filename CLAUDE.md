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

Everything in this app — capabilities, polling, flow cards, read/write behavior — is driven by a single array,
`registers: Register[]`, defined at the top of [drivers/nibe_s/device.ts](drivers/nibe_s/device.ts). Each entry maps
one Nibe Modbus register to one Homey capability:

```ts
{ address: 1, name: "measure_temperature_NIBE.i1_outside", direction: Dir.In, scale: 10 }
```

- `direction: Dir.In` → Modbus *input* register (read-only, sensor data). `Dir.Out` → Modbus *holding* register
  (read/write, settings). This maps to `readInputRegisters` vs `readHoldingRegisters`/`writeSingleRegister`.
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
1. Add the `Register` entry in `drivers/nibe_s/device.ts`.
2. Add the capability name to `drivers/nibe_s/driver.compose.json` (`capabilities` array + `capabilitiesOptions`).
3. If it's a new capability *type* that isn't an existing official Homey type or `*_NIBE` type, add a definition
   under `.homeycompose/capabilities/`.

`checkConfig()` in `device.ts` runs at device init and logs a mismatch warning if `registers` and the compiled
`capabilities` array (from `driver.compose.json`) get out of order/sync — check the logs after changes here.

If you rename or drop a capability (e.g. migrating a `_NIBE` type to an official one), add an entry to
`capabilityRenames`/`retiredCapabilities` near the top of `device.ts` and call `migrateCapabilities()` (already
wired into `onInit`) so devices already in the field carry their last value over instead of silently losing it.
Note that renaming a capability still breaks any saved flow that references the old capability by name — that part
isn't avoidable, only the value/history loss is.

**Do not delete the old capability's *type* definition (`.homeycompose/capabilities/*.json`) in the same release
as the rename.** Existing devices still have an instance of the old type attached until `migrateCapabilities()`
actually runs and removes it — and the SDK refuses to perform *any* `addCapability`/`removeCapability` call on a
device that has an instance of a completely undeclared capability type attached (not just operations on that one
capability; the whole device's `onInit` capability handling breaks, with every subsequent Homey RPC error
confusingly echoing the *first* failure). Keep the old type file declared (even though nothing in
`driver.compose.json` references it anymore) for at least one release cycle, then delete it later once no in-field
device should still be carrying that capability.

### Flow cards are generic, not per-register

Rather than one flow card per register, `driver.flow.compose.json` defines a small set of generic cards
(`set_numeric_value`, `enable_feature`, `disable_feature`, `numeric_value_comparison`, `feature_enabled`,
`capability_changed`/`capability_turned_on`/`capability_turned_off`) that take a `register` autocomplete argument.
`registerAutofillFlow()` in `device.ts` wires each card's autocomplete listener (filtered by a predicate over
`Register`, e.g. "only `Dir.Out` + numeric") and its run listener. Enum registers instead get dedicated per-register
action/condition cards named `<capability_name>.enum` (registered dynamically in `onInit`, driven by
`actionSpecs`/`conditionSpecs` built from the flow compose file), since enums need a `mode` autocomplete rather than
a free-form value.

### Device lifecycle (`drivers/nibe_s/device.ts`)

- One shared module-level `net.Socket()` — connects on `onInit` to `getSettings().address` (the IP entered during
  pairing), port 502 (Modbus).
- On `connect`: device marked available, polls all registers every 15s (`poll()` → `readRegisters()` →
  `setValue()` per register), with an initial delayed poll.
- On `close`: device marked unavailable-ish (via the `error`/`close` handlers), auto-reconnects after 15s via
  `retryInterval`.
- `setValue()` writes the capability and fires the relevant trigger (`checkTrigger`) only when the value actually
  changed.
- Writable capabilities get a `registerCapabilityListener` that writes to the Modbus register and re-triggers flow
  cards.

### Pairing (`drivers/nibe_s/driver.ts` + `drivers/nibe_s/pair/ip_address.html`)

Custom pairing flow: user enters the Nibe's local IP address (validated with `net.isIP`), which becomes both the
device `data.id` and the `address` setting used to open the Modbus connection.

### i18n

Two separate locale layers: `locales/*.json` (top-level app store listing text) and `.homeycompose/locales/*.json`
(compose-merged into `app.json`, used for in-app strings like enum labels via `this.homey.__(...)`). Keep both in
sync with English/Swedish when adding user-facing strings.
