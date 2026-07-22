# Phase 3 Task 8 — margin auto-proposal acceptance evidence (staging note)

**Status: staging note for Task 11** (`docs/plans/phase-3-margin-axis.md`
Task 11, deliverable 3: `docs/demos/phase-3.md`'s acceptance evidence
section). This file is NOT that final phase doc — it is the structured
markdown block Task 11 should lift wholesale (or adapt) into
`docs/demos/phase-3.md` when it lands, per Task 8's own brief deliverable 4
("leave a structured markdown block the T11 task can lift"). Full narrative
analysis: `.superpowers/sdd/p3-task-8-report.md` (Task 8),
`.superpowers/sdd/p3-task-8b-report.md` (Task 8b — amended criterion).
Harness: `scripts/margin-acceptance.ts` + `test/golden/margin-acceptance.test.ts`
(both Task 8's original measurement and Task 8b's amended-criterion
extension live in the same two files — see `margin-acceptance.ts`'s module
doc, "Task 8b addendum", for the extension's own design rationale).

**Task 8b update (2026-07-15): PLAN.md's Phase 3 acceptance criterion was
AMENDED** after Task 8's BLOCKED verdict below — see "Amended criterion"
section further down for the reframed (ridge-visible-only) measurement and
its own verdict. Task 8's ORIGINAL full-length verdict (immediately below)
is preserved verbatim, unweakened — it is still the honest answer to the
original question, and the amended criterion is additive, not a
replacement of this evidence.

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

---

## Amended criterion (Task 8b, PLAN.md amended 2026-07-15)

**Decision made:** option (b) above — Phase 3's stated acceptance criterion
(PLAN.md, Phase 3 §Acceptance) now reads: on real prep fixtures, auto
margin proposal is within 100 µm (mean) of the hand-traced reference along
the **ridge-visible** portion of the margin, for ≥ 3 preps, with the
visible-coverage fraction honestly measured and reported per tooth. The
ORIGINAL full-length criterion (≤100 µm mean over ≥90% of length) moves to
a **future scan-visible prep fixture** (e.g. a retraction-cord impression
scan) that has not yet been supplied — see "Pending fixture" below.

**Ridge-visible classification** (see `scripts/margin-acceptance.ts`'s
module doc, "Task 8b addendum", for the full method): each reference sample
point is classified visible iff `k2 < -MARGIN_MIN_RIDGE_STRENGTH` (the
EXACT threshold/comparison `proposeMarginLoop`'s own walk uses — reused
directly from `@dqcad/kernel`, not re-derived) at that point's
barycentric-interpolated location, not boundary-affected, AND part of a
contiguous qualifying run of ≥3 samples (`VISIBLE_STRETCH_MIN_RUN_SAMPLES`
— filters isolated 1-2-sample curvature-noise blips, not real short
stretches). The reported **visible-coverage fraction** is length-weighted
(Voronoi-style per-sample weighting), post-smoothing.

### Amended-criterion table — per tooth

| FDI | Closes? | Reference samples | Raw k2-qualifying (point %, pre-smoothing) | **Visible-coverage fraction (length-weighted, THE reported figure)** | Visible stretches | Full-length mean (for contrast) | **Visible-stretch mean (AMENDED METRIC)** | Visible-stretch max | Passes (≤100µm) |
|---|---|---|---|---|---|---|---|---|---|
| 12 | yes | 468 | 38.0% | **28.7%** | 12 | 379.9 µm | **304.9 µm** | 832.2 µm | **NO** |
| 11 | **NO** (`NoClosureError`) | 513 | 18.9% | **13.9%** | 10 | — (no proposal) | — (coverage evidence only) | — | excluded |
| 21 | yes | 629 | 50.6% | **40.9%** | 19 | 235.0 µm | **127.0 µm** | 528.0 µm | **NO** |
| 22 | yes | 367 | 10.9% | **6.6%** | 5 | 648.4 µm | **337.4 µm** | 775.4 µm | **NO** |

KERNEL_VERSION 0.5.0 (unchanged — this is a measurement-only extension;
`proposeMarginLoop` itself was not modified for Task 8b). Same mesh/hash as
Task 8's table above. Full per-tooth worst-cluster and visible-stretch
breakdowns: harness console output / test log
(`test/golden/margin-acceptance.test.ts`, `Task 8b: logs the full
amended-criterion evidence table` case).

### Verdict: still **BLOCKED** under the amended criterion — 0 of 3 assertion teeth pass

The amended-criterion assertion set is exactly the 3 closing teeth (12, 21,
22) — tooth 11 cannot produce a proposal to measure at all
(`proposeMarginLoop` only ever returns a closed loop or throws; per this
task's brief, no partial-walk output was hacked together), so it
contributes visible-coverage-fraction evidence only (13.9% visible, 10
distinct visible stretches — itself useful evidence that this tooth's
non-closure correlates with unusually low ridge visibility).

**The reframing is a real, substantial improvement, verified not assumed**:
visible-stretch mean deviation is 20–46% lower than the full-length mean
for every closing tooth (12: 379.9→304.9 µm; 21: 235.0→127.0 µm, the
closest of the three; 22: 648.4→337.4 µm). This was checked against a
sensitivity concern before trusting it: the visible stretches per tooth are
numerous (5–19) and each short (≤1.2 mm), and the visible-stretch *sample*
fraction of the proposal curve (31.1% / 44.8% / 6.2%) closely tracks each
tooth's own reference-side visible-*coverage* fraction (28.7% / 40.9% /
6.6%) — consistent with a proposal that broadly tracks the reference shape,
not a harness artifact concentrating samples in one favorable spot.

**But the improvement does not cross the 100 µm bar for any of the 3
teeth.** This is the same structural limitation Task 8 already diagnosed,
not a new one: `marginRidge.ts`'s own module doc documents that a real
`k2`-qualifying region is a WIDE 2D band around the true crest, not a crisp
1D curve — the walker's "strongest-`k2`-in-the-band" selection rule doesn't
always land exactly on the dentist's own hand-traced line even where a
genuine ridge signal exists throughout. No `proposeMarginLoop` parameter
retuning was found or applied here (Task 8's own established conclusion —
"Why BLOCKED" above — already ruled out `MARGIN_MIN_RIDGE_STRENGTH`/
`MARGIN_LOOKAHEAD_STEPS`/`MARGIN_CLOSURE_TOLERANCE_MM` as fixes for a
signal-shape issue, not a threshold issue; this task's own stretch-
fragmentation check corroborates that conclusion rather than finding a new,
fixable cause).

### Pending fixture

The original full-length criterion (≤100 µm mean over ≥90% of length) is
**not** demonstrated by this evidence — it awaits a scan-visible prep case
(e.g. a retraction-cord impression scan) that has not yet been supplied by
the practice (tracked in the user's own case-fixture memory note,
`real-scan-cases.md`: "prep-die case still missing"). When that fixture
lands, re-running this SAME harness (architecture-neutral, per the
"Recommendation" section above) against it is the intended path to
demonstrating the original criterion, per PLAN.md's amended acceptance
text.
