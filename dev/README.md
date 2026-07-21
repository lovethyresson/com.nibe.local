# dev/ — maintainer tools (not shipped)

This directory is excluded from the built Homey app (see `.homeyignore`) and is only for
working on `registers.ts`.

## audit-registers.mjs

Cross-checks the app's register table against Nibe's per-model Modbus register CSVs. It does
two things:

1. **Semantic-collision check** — flags any address the app uses whose *meaning* differs
   across S-models. The single superset register table is only safe while this stays empty
   (as of 2026-07-21 it is: models differ by which addresses exist, not what they mean).
2. **Unmapped-register list** — registers present in the CSVs but not yet mapped in
   `registers.ts`, so you can see what's available to add when a user asks. This is how new
   registers get added: pick one off the list, add a curated row to `registers.ts` + the
   compose entry (the usual 3-place flow). There is deliberately **no** codegen/pipeline.

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
