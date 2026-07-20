# Phase 3 Task 8 — margin auto-proposal acceptance evidence (staging note)

**Status: staging note for Task 11** (`docs/plans/phase-3-margin-axis.md`
Task 11, deliverable 3: `docs/demos/phase-3.md`'s acceptance evidence
section). This file is NOT that final phase doc — it is the structured
markdown block Task 11 should lift wholesale (or adapt) into
`docs/demos/phase-3.md` when it lands, per Task 8's own brief deliverable 4
("leave a structured markdown block the T11 task can lift"). Full narrative
analysis: `.superpowers/sdd/p3-task-8-report.md`. Harness:
`scripts/margin-acceptance.ts` + `test/golden/margin-acceptance.test.ts`.

## Phase acceptance criterion (verbatim, PLAN.md / phase-3-margin-axis.md)

> on 3 real prep fixtures, auto margin proposal is within 100 µm (mean) of a
> hand-traced reference polyline for ≥ 90% of its length

Read as (this task's brief, matching the real case's clinical context):
**mean deviation ≤ 100 µm, computed over the best 90% of the proposal's
length** (i.e. the worst ≤10% of length — the plausibly gingiva-obscured
stretches — may be excluded before averaging). Stricter alternate readings
(full-length mean; per-sample 100 µm fraction) are reported alongside for
completeness.

## Verdict: **BLOCKED** — 0 of 3 measurable teeth pass

**≥ 3 of 4 required. Measured: 0 of 3** (tooth 11 does not auto-close at
all — a documented, genuine real-scan coverage gap, not a measurement
candidate). This is a real, structurally-explained limitation of a
curvature-ridge-following detector on a real case with extensive
gingiva-obscured/low-signal margin stretches — not a fixable parameter, and
not weakened to force a pass. See "Why BLOCKED" below.

## Per-tooth measured numbers

Seed derivation: ambient centroid of each reference's own `resampledPoints`,
projected to the mesh surface (`snapToSurface`) — fully reproducible from
the committed reference files alone (no hand-picked ambient coordinate).
Metric: dense proposal polyline (anchor-to-anchor `geodesicPath`,
concatenated — the SAME construction the reference `resampledPoints`
themselves use) resampled to a fixed 20 µm arc-length step; per-sample
ambient closest-point-on-segment distance to the reference's own closed
polyline.

| FDI | Seed → closes? | Anchors | Proposal / Ref. perimeter (mm) | Full-length mean | **Best-90%-length mean (ACCEPTANCE)** | Frac. of length ≤100µm | Max deviation | Passes (≤100µm) |
|---|---|---|---|---|---|---|---|---|
| 12 | closes | 274 | 28.434 / 18.863 | 379.9 µm | **323.0 µm** | 11.8% | 1026.0 µm | **NO** |
| 11 | **does NOT close** (`NoClosureError`, closest approach 1.663 mm) | — | — | — | — (excluded) | — | — | excluded |
| 21 | closes | 261 | 29.708 / 22.482 | 235.0 µm | **193.7 µm** | 33.7% | 670.6 µm | **NO** |
| 22 | closes | 262 | 30.190 / 17.262 | 648.4 µm | **586.2 µm** | 4.5% | 1420.7 µm | **NO** |

KERNEL_VERSION 0.5.0. Mesh: `test-fixtures/real-scans/arch-case-01/arch-case-01-upperjaw.stl`
(content hash `e7397eb8a92373a35bfa5d9bedc27e3056e438433ba13699b8a76abe0052c578`).
Full per-tooth worst-cluster breakdowns (contiguous >100µm runs, arc-length
span, ambient centroid): harness console output / test log
(`test/golden/margin-acceptance.test.ts`).

## Why BLOCKED (not a tuning miss)

1. **One legitimate tuning WAS applied and IS credited**: `findRidgeStart`
   picking an isolated curvature-noise blip (component size 1) instead of
   the real ridge component when a seed lands near — but not precisely
   on — the true crest. Fixed via a new `MARGIN_MIN_RIDGE_COMPONENT_SIZE`
   floor (default 20; see `docs/CHANGELOG-kernel.md` 0.5.0 and
   `packages/kernel/src/margin/marginRidge.ts`'s TSDoc). This is what makes
   tooth 21 measurable at all with a reference-derived seed (it did not
   close before the fix); VERIFIED a no-op for every existing golden entry.
2. **The remaining gap is a real curvature-signal limitation, not a
   tunable one**: sampling `k2` directly at the dentist's own reference
   points shows only **10.9%–51.1%** of each reference trace's own length
   sits on curvature strong enough to qualify as "ridge" at all
   (`k2 < -3 mm⁻¹`) — the rest is background or, in several measured spots,
   measurably **convex** (`k2` up to +5.05 mm⁻¹). `proposeMarginLoop`
   architecturally can only ever walk qualifying ridge vertices — it cannot
   trace a path across terrain with no ridge signal, regardless of any
   `MARGIN_MIN_RIDGE_STRENGTH`/`MARGIN_LOOKAHEAD_STEPS`/`MARGIN_CLOSURE_TOLERANCE_MM`
   retuning. This matches the tracing dentist's own disclosure (collapsed
   gingiva obscuring the true margin in several regions on this real case)
   — but the AFFECTED length fraction (49–89% of each loop, per the above)
   is far larger than the criterion's ≤10%-of-length exclusion allowance.
3. Worst-deviation clusters are **not confined to one interproximal spot**
   (which the ≥90% window would comfortably absorb) — they are numerous and
   spread across large arcs of each loop (see the harness's `worstClusters`
   output, e.g. tooth 21: 18 separate clusters spanning most of the loop).

## Recommendation for Task 11 / phase wrap-up

Do not represent Phase 3's acceptance criterion as met from this evidence
alone. Options (not decided by this task): (a) acquire additional real prep
fixtures with less gingival obscuration and re-run this SAME harness
(architecture-neutral — no code change needed, just more
`test-fixtures/margins/<case>/` fixtures) to see whether a cleaner case
clears the bar; (b) treat this as a documented, accepted Phase 3 limitation
(auto-propose is a starting point the user always reviews/edits before
confirm — Task 6's validation gate — not a claimed final-accuracy
guarantee) and adjust what "Phase 3 acceptance" means for auto-propose
specifically; (c) invest in a different/blended scalar field or
low-signal-region interpolation strategy (a real kernel R&D task, out of
this task's scope). This task's own scope (brief) ends at "BLOCKED with the
numbers and analysis" — decision (a)/(b)/(c) is a controller/product call.
