# S735 verification of the per-function energy log (2283–2303)

**Contributed by:** Henrik (halderex fork), running a Nibe **S735** as a verification rig —
the same physical pump is polled over **local Modbus** *and* mirrored to **MyUplink cloud**, so
readings can be cross-checked against an independent source.

**Purpose:** independently verify, on a *second model*, the plan in
[`tasks/todo.md`](todo.md) → **“0.9.10 — per-function attribution”**. That work classified the
energy-log block on an **S1155** and concluded *“PREVIOUS COMPLETED HOUR, and it reconciles.”*
Several of its checkboxes are explicitly gated on evidence from other hardware (“Cannot be verified
locally — needs Erik”). This doc supplies S735 evidence and flags one caveat that affects the
“Design that follows” section.

**Pump / transport:** Nibe S735, Modbus TCP `192.168.1.59:502`, unit id 1, FC04 (input registers),
32-bit low-word-first. Tool: your own `dev/probe-energylog.mjs` (unmodified), so results are directly
comparable to the S1155 run.

---

## TL;DR

| todo.md item | S735 result |
|---|---|
| Block present on non-S1155 hardware | ✅ present (heating/hot-water/add-heat); pool & cooling absent, as expected |
| Semantics = “previous completed hour” | ✅ **confirmed** — `classify()` returns PREVIOUS HOUR for 2285/2291/2293 |
| Per-function *used* is accurate | ✅ **confirmed on a real 1.24 kWh cycle**, corroborated 3 independent ways |
| Standby folded into **heating** (not a separate bucket) | ✅ **confirmed** (2291 ≈ 0.05 kWh/h at idle) |
| “Main idle = Δ3823 − Σ(per-function)” per hour | ⚠️ **needs care** — 3821/3823 are **laggy**; per-hour Δ against boundary samples does **not** line up with the per-function step (details below) |

Net: the pump-native log is trustworthy on the S735 and can replace the priority allocator here —
**but the lifetime counters `3821`/`3823` do not advance in lockstep with the log**, so deriving idle
by per-hour subtraction against them is unsafe without first characterising their update timing.

---

## Method note — forcing a cycle on demand (beats Smart Price Adaptation)

The blocker to date has been *getting an attributable cycle when you want one* — natural cycles are
unpredictable and, with **Smart Price Adaptation** active, simply drawing hot water doesn’t force
the compressor if prices are high (the pump defers).

**“More hot water” / hot-water boost overrides SPA** — it’s a manual demand, so the pump heats now
regardless of price. On this rig it was triggered over the **MyUplink cloud** (register 7086),
which is independent of the single Modbus slot the probe holds, so the probe never had to yield the
connection. Sequence that gives a clean, fully-bracketed hour:

1. Start `probe-energylog.mjs`; let it cross a `:00` (clean hour start).
2. Fire hot-water boost (cloud, or the app’s control) → compressor starts within ~1 min.
3. Let it run through the hour; the pump publishes that hour’s totals at the next `:00`.
4. Probe spans past that `:00`, then reports. Turn boost off.

This turns “wait for Erik / a natural cycle” into a repeatable ~80-minute test.

---

## Run 1 — idle baseline (100 min, ~19:49–21:29 CEST, prior evening)

Pump in standby the whole window (priority Off, compressor 0 Hz, nothing produced).

- **Availability:** `2283/2285` (produced heat/HW), `2291/2293` (used heat/HW), `2299/2301`
  (add-heat) all read 201/201. `2287/2289/2295/2297/2303` (pool, cooling) **never read** — S735 has
  neither, matching the S1155.
- **Semantics:** `2291` classified **PREVIOUS HOUR** (steps at `:00`, static between).
- **Standby → heating:** `2291` sat at **0.05–0.06 kWh/h** through pure standby — confirming the
  todo.md finding *“the pump folds standby into heating … ‘idle’ is not a separate bucket in the
  pump’s own accounting.”*
- **Decomposition:** inconclusive — every figure sat at/under the 0.1 kWh resolution of `3823`
  (`classify` flagged “weak evidence”). An idle window physically can’t cross the quantisation
  floor. Hence Run 2.

## Run 2 — boost-forced hot-water cycle (80 min, 2026-08-01 ~20:58–22:19 CEST)

Boost fired at ~21:02 CEST; compressor ramped to **73 Hz, ~1150–1290 W held for the entire
21:00–22:00 CEST hour** (priority = Hot water throughout). Probe spanned 21:00 and 22:00, so the
21:00–22:00 hour is fully bracketed.

**The publication at 22:00 CEST (20:00 UTC) — a clean step:**

```
21:59:58 CEST   used_heating(2291)=0.05   used_hotwater(2293)=0
22:00:28 CEST   used_heating(2291)=0      used_hotwater(2293)=1.24   ← stepped to hour-21 total
```

**Per-function *used* = 1.24 kWh, corroborated three independent ways:**

| Evidence | Value |
|---|---|
| Published `2293` (used hot water, hour 21) | **1.24 kWh** |
| `2166` live power integrated over the hour (~1.2 kW × 1 h) | ~1.24 kWh ✓ |
| Published `2285` (produced HW) 3.55 kWh vs Δ`3821` over window 3.5 kWh | ✓ (~1 %) |
| Implied COP = produced/used = 3.55 / 1.24 | **2.86** — physically sane ✓ |

**Attribution was exact:** 1.24 kWh → hot water, **0 → heating** (no bleed; and with the pump
actively working, the standby-in-heating dribble went to 0). `classify()` returned **PREVIOUS HOUR**
for `2293`, `2291`, and `2285`.

---

## The caveat: `3821`/`3823` lag the per-function log ⚠️

Your script’s strict per-hour `decomposition()` reported a **false 1140 %** error for the cycle hour:

```
hour 19:00 UTC (21:00 CEST)  used     : log 1.24 kWh  vs  3823 delta 0.10 kWh  (1140.0%)
                             produced : log 3.55 kWh  vs  3821 delta 0.00 kWh
```

This is **not** a per-function error. The per-function log (1.24 kWh) is independently confirmed
above. The problem is the **reference counters**:

- Over the **full window** they reconcile: Δ`3823` = 2969.7 → 2971.1 = **1.4 kWh** (≈ 1.24 HW +
  standby); Δ`3821` = 9581.5 → 9585.0 = **3.5 kWh** (≈ 3.55 produced). ✅
- But **within the cycle hour’s boundary samples they barely moved** (Δ`3823` = 0.10, Δ`3821` =
  0.00). The counters’ visible advance came **after** the `20:00 UTC` boundary — `3823` climbed
  ~1.3 kWh between the 20:00 and 20:18 samples while the pump was already **idle** (10 W). So the
  lifetime counters register a completed cycle’s energy **later** than, and out of step with, the
  per-function log that publishes promptly at `:00`.

**Why this matters for [`todo.md`](todo.md) → “Design that follows”:**

> - [ ] Main's idle energy becomes Δ3823 minus the sum of the per-function figures, so the whole
>       set reconciles with the pump by construction.

On the S735, `Δ3823` sampled at the hour boundary is **out of phase** with `Σ(per-function)`
published at that same boundary — so a per-hour subtraction yields nonsense for that hour (here it
would compute idle ≈ 0.10 − 1.24 = **negative**), even though the two sides reconcile over a longer
span. The per-function log counted on its own `:00` step is reliable; **idle-by-Δ3823-subtraction is
not, unless `3823` is counted on *its* settling rather than the shared boundary.** Recommend
characterising `3823`’s exact update timing before building the subtraction (see below).

This is consistent with your own note in [`todo.md`](todo.md): *“3821/3823 are absent from that
[Nibe] register list entirely (added to the protocol later)”* — their update semantics are
undocumented, and here they demonstrably differ from the per-function block’s.

---

## What this settles vs. leaves open (against todo.md checkboxes)

**Settles (S735):**
- ☑ Block available and previous-hour on a second model — not S1155-specific.
- ☑ Per-function *used* is accurate on a substantial (1.24 kWh) cycle, not just the S1155’s 0.13 kWh.
- ☑ Standby folds into heating on the S735 too.

**Still open / newly flagged:**
- ☐ **Cooling / pool** remain unverifiable here (registers absent on S735, as on S1155) — still
  needs Erik’s S320-class pump.
- ☐ **`3821`/`3823` update timing** — new caveat; per-hour idle-by-subtraction is unsafe until the
  counters’ step/lag relative to the per-function `:00` publication is characterised.
- ☐ **Composition (`Δ3821 ≈ Δ1575 + Δ1577`, cooling inclusion via 3095)** — not addressed here.

---

## Recommended follow-up (cheap, on this rig)

1. **Characterise the counter lag:** a short probe that logs `3823`/`3821` *per sample* (they’re
   sampled but not printed by default) across a boost-forced cycle and the following `:00`. That
   pins down whether the counters step at `:00` (a few seconds/minutes after the per-function step)
   or integrate with a real delay — which decides whether idle-by-subtraction is salvageable.
2. **MyUplink cross-check:** because this rig sees the same pump on the cloud, the per-function used
   figures can be checked against MyUplink’s own per-category energy on identical hardware — the
   “agrees with MyUplink” claim measured, not just argued by construction. (MyUplink’s native
   per-function counters aren’t exposed on Homey, so this needs a cloud read; happy to run it.)

## Reproduce

```
node dev/probe-energylog.mjs 192.168.1.59 --minutes 80 --interval 30
# then force a cycle mid-window: hot-water boost (register 7086) via app/cloud, once past a :00.
# NB: probe timestamps are UTC (CEST − 2).
```
