# Test value audit — 2026-09-20

Reviewed all nine test files, their fixtures and assertions, the production paths they exercise,
`npm test`, both TypeScript checks, CI, and the Docker test entry point. The criterion was whether
an assertion catches a plausible product regression, protocol error, data mismatch, or failure
of the simulator used for development. Test count and line coverage were not deletion targets.

## Suite decisions

| File | Before → after | Decision and protected behaviour |
| --- | ---: | --- |
| `unit.test.ts` | 89 → 86 | Keep decoding, selection, migrations, profile/manifest consistency, alarms and explanations. Replace vacuous fixtures and tests of copied logic. |
| `hotwater.test.ts` | 28 → 26 | Keep published reference values, thermocline regressions, invalid choices, learned inlet and capability placement. Remove two misleading checks. |
| `integration.modbus.test.ts` | 21 → 20 | Keep actual TCP encoding, allocation, polling, reconnects and diagnostics. Merge total-loss logging into the watchdog scenario. |
| `reliability.test.ts` | 24 → 25 | Keep device/driver regressions, write validation, energy continuity and indoor sensor ownership. Exercise real decoding and selection cleaning. |
| `f-series.test.ts` | 15 → 15 | Keep gateway pacing, addressing, controls, power sources and captured-value regressions. Remove the arbitrary register-count assertion. |
| `f-simulator.test.ts` | 6 → 6 | Keep: recorded owner packets provide an independent protocol reference, and simulator checks protect the development tool from giving misleading results. |
| `indoor-sensors.test.ts` | 4 → 4 | Keep: invalid sources, averaging, feedback exclusion, source age and inventory order have distinct failure modes. |
| `setup-ui.test.ts` | 6 → 6 | Keep user navigation, retained choices, delayed commit, failure/retry and activation. Remove incidental CSS-class, DOM-order and attribute assertions. |
| `release-announcements.test.ts` | 11 → 11 | Keep targeting, persistence, retry and disabled behaviour. Validate configured content without pinning an old release ID or snippet count. |
| **Total** | **204 → 199** | **Five fewer tests; useful assertions retained or strengthened.** |

## Changes and evidence

- Removed the hot-water “parameter-free” test: calling the same function twice with identical
  inputs cannot establish that its model has no tunable parameter. Real shower, continuity and
  published-reference tests remain.
- Removed the catalogue “not a V40 figure” test: multiplying any positive volume by the same
  conversion factor passes even if the input is already an inflated V40 figure. Its concrete
  VPB 200 volume assertion was already covered by the catalogue-choice test. Full catalogue
  accuracy still requires independent manufacturer data; arithmetic cannot establish it.
- Replaced picker tests that returned without assertions when the live catalogue had no pair.
  A fixed paired/standalone fixture now exercises the helper regardless of catalogue changes.
  Profile construction checks literal expected mappings instead of calling the same helpers
  to build its expected answer.
- Changed unavailable-sensor detection to feed raw sentinel replies through `readNumeric`,
  `sampleRegisters` and `buildDetectionResult`, with a valid-reading control. Previously the
  test supplied `reads: 0` itself and asserted that it remained zero.
- Replaced the test-local boolean condition predicate with production `flowPredicates.boolState`.
  Added a rejected alternate-address value to a test that previously asserted only acceptance
  of zero despite claiming to test rejection.
- Removed a picker/enum “decoding” test that only compared metadata. Expanded the existing
  device decoding test to cover both S and F profiles and assert actual picker IDs for every
  declared picker value.
- Renamed the pure tank-cleaning round-trip test to describe its real scope. Added coverage of
  the driver's actual selection whitelist when unrelated feature settings change.
- Removed the “every custom type has an instance” test. Keeping retired capability types is an
  explicit upgrade requirement in `CLAUDE.md`; lack of a current instance is not a defect.
  Register-to-capability consistency tests and CI manifest validation remain.
- Merged the separate 14-second all-reads-fail logging test into the 30-second watchdog test.
  The combined scenario checks loss notification, an actual second TCP connection, and absence
  of misleading unsupported-register reports. Also made the active-priority assertion reject
  an empty callback list.
- Removed the exact F register count and obsolete announcement ID/count assertions. Retained
  capability mappings, readonly controls, valid announcement audiences and six translations.
- Removed a prefix assertion on a string constructed with that very prefix inside the test.
  Cross-checks against real register and capability tables remain.
- Repaired the Docker test recipe: it omitted `dev`, `assets`, `locales` and `.homeycompose`,
  which tests import/read. Aligned its Node version with CI's Node 22.

## Why the remaining overlap is useful

Pure helper tests isolate boundary cases cheaply. Device tests establish that Homey-facing
methods use the helpers correctly. TCP tests verify wire encoding and that the running poller
actually delivers the resulting values and callbacks. Similar assertions at these different
boundaries are not interchangeable. In particular, deleting integration coverage because a
mocked method passes would lose transport, scheduling and reconnect evidence.

Static profile assertions are valuable where they express independently established register
addresses, scaling, read/write permissions, capability IDs, or cross-file compatibility. They
are not simply implementation snapshots: a valid TypeScript edit can still silently address
the wrong pump register or remove an owner's working capability.

CI's application typecheck, test typecheck, behavioural suite and publish-manifest validator
have different responsibilities. None was disabled. No test was marked skipped or todo.

## Validation and limits

- Baseline: **204/204 passed**, about **207.5 seconds** with local fake-pump servers allowed.
- Revised suite: **199/199 passed**, about **193.7 seconds** (approximately 14 seconds faster).
- Application and test TypeScript checks passed; `git diff --check` passed.
- Four deliberate regressions in an isolated temporary copy were all caught by assertion
  failures: counting unavailable readings, returning enum labels for picker IDs, dropping the
  saved tank in driver selection cleaning, and disabling boolean state predicates.
- Docker recipe execution could not be verified because the local Docker daemon is not running.
- Tests still use real-time waits. The longest scenarios cover watchdog recovery, hourly-log
  transitions and live discovery; those scenarios remain valuable. Replacing fixed sleeps with
  bounded waits for observed events is a separate reliability/performance improvement.
- This is a complete manual suite review plus four targeted mutation checks, not exhaustive
  mutation testing or proof that every real-device failure is covered. Simulators do not
  establish undocumented firmware behaviour, and DOM tests do not establish visual layout.
- Existing uncommitted application/release changes were preserved; audit changes are limited
  to tests, the Docker test recipe and this report.
