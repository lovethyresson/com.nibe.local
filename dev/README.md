# dev/ — maintainer tools (not shipped)

This directory is excluded from the built Homey app (see `.homeyignore`) and is only for
working on `registers.ts`.

## audit-registers.mjs

Cross-checks the app's register table against Nibe's per-model Modbus register CSVs. It does
four things — the first two look CSV → app, the last two look app → CSV:

1. **Semantic-collision check** — flags any address the app uses whose *meaning* differs
   across S-models. The single superset register table is only safe while this stays empty
   (as of 2026-07-21 it is: models differ by which addresses exist, not what they mean).
2. **Unmapped-register list** — registers present in the CSVs but not yet mapped in
   `registers.ts`, so you can see what's available to add when a user asks. This is how new
   registers get added: pick one off the list, add a curated row to `registers.ts` + the
   compose entry (the usual 3-place flow). There is deliberately **no** codegen/pipeline.
3. **Per-model coverage** — which mapped registers are *absent* from each model, plus a
   separate list of the **engine-critical** ones (power sources, priority, the total and
   per-function energy counters, each role's primary on/off). A register missing on some
   models is normal for a superset table; a missing *engine-critical* register is a silent
   feature outage and needs either a fallback or detection that marks the feature unsupported.

   > This check exists because it was missing. The app shipped with register 2166
   > "Instantaneous used power" as its only power source — and 2166 does not exist on
   > S320/S325, S330/S332 or S2125. On those models the energy allocator had nothing to
   > integrate, so per-function energy and every COP stayed permanently empty. Only the
   > CSV → app direction was checked, so nothing flagged it.

4. **Declared size vs CSV width** — Modbus reads whole 16-bit words, so `u8`/`s8`/`u16`/`s16`
   all live in the app's default 16-bit register and only 32-bit values span two words and
   need `size: 32`. Nibe orders 32-bit values low word first, so reading one word of a 32-bit
   register silently returns the correct value *until it exceeds 65535* — which is exactly why
   these go unnoticed. Treat a mismatch on a counter (hours, kWh) as a real bug; on a bounded
   reading (watts, amps, degree minutes) it is latent, and worth a comment either way.

### Usage

```sh
npm run build                 # the script reads the compiled register table
node dev/audit-registers.mjs  # optionally: node dev/audit-registers.mjs --all
```

### CSVs (git-ignored, not committed)

Drop the yozik04/nibe model CSVs into `dev/csv/` (tab-separated, as published):

    dev/csv/s1155_s1255.csv
    dev/csv/s2125.csv
    dev/csv/s320_s325.csv
    dev/csv/s330_s332.csv
    dev/csv/s735.csv
    dev/csv/s1156_s1256.csv

Source: https://github.com/yozik04/nibe/tree/master/nibe/data (GPL-3.0 — kept out of this
repo on purpose; fetch locally). Column order: Title, Register type, Register(id), Division
factor, Unit, Size, Min, Max, Default.

**The Size column has two encodings.** The older exports (`s1155_s1255`, `s1156_s1256`,
`s735`) spell the type out — `u8`/`s8`/`u16`/`s16`/`u32`/`s32`. The newer ones (`s320_s325`,
`s330_s332`, `s2125`) use a numeric code, which the audit script maps as:

| code | 1 | 2 | 3 | 4 | 5 | 6 |
|------|---|---|---|---|---|---|
| type | `s8` | `s16` | `s32` | `u8` | `u16` | `u32` |

Derived by comparing registers that appear in both styles: 1028 Priority is `u8` there / `4`
here, register 1 (outdoor temp) is `s16` / `2`, and 1575 (hot water energy) is `u32` / `6`.
A few rows in the newer files carry the spelled-out form anyway (3821/3823), so the parser
accepts both. Anything else — including the blank `-` — is treated as unknown and skipped.

## fetch-alarms.mjs

Regenerates `lib/alarm-codes.json` from NIBE's own alarm-code database — the only public
source that maps a Nibe alarm *number* to text. Nibe's Modbus documentation and the
open-source register libraries all list the alarm register with no enum.

```sh
node dev/fetch-alarms.mjs
```

**The two series use different numbering.** 301 codes exist in both lists and 300 of them mean
different things (438 = "lost connection to wireless device" on S, "temporarily overheated
inverter" on F; 163 = "incorrect phase sequence" on S, "high condenser in temperature" on F).
Each profile therefore names its own series (`alarm: {series: 's'}`) and the lookup is
series-scoped. Applying the wrong table is worse than having none.

Output per code: `sv` (NIBE's own wording, authoritative), `en` (translated), and `advice`
(NIBE's cause/suggested-action text, Swedish only — it runs to paragraphs, so we surface it
verbatim and link to the source rather than machine-render it).

English is produced by phrase substitution over the `DICTIONARY` in the script, with
hand-written entries in `dev/alarm-en.json` for the Swedish compound nouns it can't reach.
The script prints anything that still looks Swedish; **the S-series list is clean, the
F-series still has ~112 titles to translate** — do that when the F driver lands.
