# External verification notes — Henrik (halderex), Nibe S735

Contributed via [PR #2](https://github.com/lovethyresson/com.nibe.local/pull/2). Kept as its own
file rather than folded into `todo.md`, so the independent evidence stays attributable and
separable from our own working notes.

Full write-up: [`s735-energylog-verification.md`](s735-energylog-verification.md).

## Cross-confirmed on a second model — Nibe S735 (2026-08-01)

Independent verification on a Nibe **S735** (Henrik's rig — the same physical pump on Modbus
*and* MyUplink, so readings can be checked against an independent source). Ran our own
`dev/probe-energylog.mjs` unmodified, so the results are directly comparable to the S1155 run.

- Block present; `2291`/`2293`/`2285` classify **PREVIOUS HOUR**; pool/cooling absent (as on S1155).
- Per-function *used* validated on a **1.24 kWh** boost-forced hot-water cycle — matched the
  live-power integral, `produced`-vs-Δ`3821`, and a sane COP (2.86). Standby-into-heating confirmed.
- **New caveat:** `3821`/`3823` were found to **lag** the per-function `:00` publication.
- Method worth reusing: **hot-water boost overrides Smart Price Adaptation**, so a cycle can be
  forced on demand instead of waiting for a natural one.

## The idle-by-subtraction caveat

> ⚠️ **S735 caveat (2026-08-01):** `3821`/`3823` do **not** advance in lockstep with the
> per-function `:00` step. On a verified 1.24 kWh cycle the boundary-sampled Δ`3823` was only
> 0.10 kWh (this subtraction would compute *negative* idle), yet the window totals reconciled —
> the counters register the completed cycle's energy late/out of phase with the log. Count
> `3823` on *its own* settling, not the shared boundary.

Open item that follows from it:

- [ ] Characterise `3821`/`3823` update timing vs the per-function `:00` step before building
      idle-by-subtraction — log the counters per-sample across a cycle + boundary (S735 shows a lag).

## What this changed on our side

**Standby-into-heating is confirmed, and our own "correction" of it was wrong.** The S735 shows
`2291` at 0.05–0.06 kWh/h through pure standby. Our S1155 run had appeared to contradict that —
hour 10:00 reported every function at 0.00 while the counters moved 0.10 kWh — and we concluded
the standby fell out as a residual. It does not. The S1155 idles at ~10 W, i.e. 0.01 kWh/h, which
rounds to nothing at the log's resolution; and the 0.10 kWh counter movement in that hour was a
single quantisation tick covering several hours' accumulation, not that hour's consumption. The
S735's constantly-running fan draws 50–60 W, which is large enough to see — and it lands in
heating.

So **idle-by-subtraction is doubly questionable**: the counter lag makes a per-hour subtraction go
negative on a real cycle, and the residual may be near zero anyway because the pump already books
standby under heating.

## Offered follow-ups (not yet taken up)

1. **Characterise the counter lag** — log `3821`/`3823` per sample across a boost-forced cycle and
   the following `:00`, to settle whether they step shortly after the per-function publication or
   integrate with a real delay.
2. **MyUplink cross-check on identical hardware** — compare the per-function used figures against
   MyUplink's own per-category energy. This would *measure* the "agrees with myUplink" claim
   rather than arguing it by construction. Needs a cloud read; MyUplink's per-function counters
   are not exposed on Homey.

Both are things we cannot do on our own rig: our S1155 lacks cooling and pool entirely, and its
standby is below the log's resolution.
