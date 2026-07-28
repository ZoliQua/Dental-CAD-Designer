# ADR-011: bridge shared insertion axis — reuse the P3 union-region machinery, add a given-axis verdict

**Status:** Accepted

## Context

A bridge seats as ONE rigid piece along ONE insertion axis — unlike a
single-unit crown or inlay/onlay, where each restoration gets its own
axis. Phase 6 Task 2 needed a falsifiable answer to "is there a shared
axis that is undercut-free across BOTH (all) abutment prep regions
simultaneously," in both directions: a parallel-die bridge should find one
(and be verified undercut-free at it), and a divergently-tilted bridge
should provably have NONE.

The undercut-scan and axis-suggestion machinery for a single region already
existed from Phase 3 Task 9 (`undercutScanIndices`, `unionRegions`,
`regionTriangleAreasMm2`, `suggestInsertionAxisForRegions`) — that
machinery was already built to operate over a UNION of regions (originally
for the "prep + tooth" case), not just one. The one capability it did not
have was a **given-axis verdict**: "at this SPECIFIC candidate direction,
what does the union of these regions' undercut look like, broken down per
region" — every existing entry point only reported at an axis the
suggestion search itself chose.

## Decision

Reuse the Phase 3 machinery **verbatim**, and add exactly one new op,
`packages/kernel/src/bridge/sharedAxis.ts`:

- **`assessSharedAxis(mesh, bvh, regions, directionUnit, options?)`** →
  `{ direction, union, perAbutment[], sharedAxisAcceptable }` — the
  falsifiable primitive. `sharedAxisAcceptable` is `true` iff EVERY
  abutment region has zero undercut at that exact axis. This is new code;
  everything it calls (`undercutScanIndices`, `unionRegions`,
  `regionTriangleAreasMm2`) is unchanged Phase 3 code.
- **`suggestSharedAxis(mesh, bvh, regions, options?)`** — thin wrapper: runs
  the existing `suggestInsertionAxisForRegions` (unchanged), then reports a
  uniform `assessSharedAxis` readout AT the suggested axis, so a caller gets
  both "the tool's best guess" and "the falsifiable verdict at that guess"
  from one call.

Per-abutment fit surfaces reuse the Phase 4 `buildInnerSurface` op
unchanged, called once per abutment against the SHARED axis (not each die's
own axis) — that choice lives in the bridge STAGE
(`stages/bridgeAbutmentSurfaces.ts`), not in a new kernel intaglio op. No
new offset/blockout/skirt algorithm was needed for the bridge case.

## Consequences

- **Positive: near-zero new surface area for a large new capability.** The
  entire "does a shared bridge axis exist" question is answered by ~one new
  function; the accuracy-critical undercut-scan math (ray-casting,
  occlusion, area weighting) is exactly the code Phase 3 already tested and
  the phase's real single-crown/inlay workflows already depend on — no
  parallel implementation to keep in sync.
- **Positive: genuinely falsifiable both ways, measured.** On the T1
  parallel fixture, the exact analytic axis `[0,0,1]` is verified
  undercut-free on BOTH abutments (0/1280 ROI triangles each). On the T1
  30°-tilt fixture, NO axis is acceptable: the analytic axis gives 469
  undercut triangles on the distal die; a 256-axis hemisphere sweep finds
  ZERO acceptable candidates, best-case worst-abutment residual 327
  undercut triangles (never zero). This is the axis-existence falsifiability
  the phase acceptance needs, proven on both sides.
- **Honest limit, disclosed (not smoothed over): the auto-SUGGESTION does
  not reach the exact-zero axis on the parallel fixture** — it converges to
  `[0.0158, 0.0135, 0.9998]`, 1.19° off `[0,0,1]`, residual 28.28 mm³. A
  shelf-margin prep's zero-undercut basin is narrow (a flat shelf + collar
  tolerate almost no tilt), unlike a cone-frustum prep's whole draft cone.
  This is not a defect in the new op — `assessSharedAxis` at the analytic
  axis IS exact-zero, proving the axis exists — it is a property of the
  discrete coarse→fine SEARCH the reused Phase 3 suggestion machinery runs.
  It is exactly why the live tool pairs auto-suggest with a manual-adjust
  slider + live undercut heatmap (the Phase 3 UI design intent) rather than
  trusting the suggestion blindly.
- **Honest limit, disclosed: a shared axis genuinely degrades a divergent
  abutment's fit surface.** On the 30°-tilt bridge, forcing both abutments
  through `[0,0,1]` costs the distal die real material: its fit-surface
  PATCH still draft-closes exactly along the shared axis (undercut-free by
  construction), but its MARGIN skirt carries a 117-triangle residual (the
  margin itself cannot draw along an axis that exceeds the die's own ~15°
  taper), and it blocks out more material than its own-axis ideal (4546 vs
  8440 blocked triangles). Margin fit stays ≤ 10 µm regardless — but this is
  real bridge physics, not a numerical artifact: abutments prepped too
  divergently for a common seating path cannot be undercut-free on any
  single shared axis, and Task 2 measures and reports this rather than
  hiding it inside a single pass/fail bit.
- **Negative / accepted cost:** this scoping means Task 2 added no new
  offset/blockout construction of its own — the entire bridge-specific
  contribution is the given-axis union verdict plus the stage-level
  decision to build every abutment's intaglio against ONE shared direction.
  A future task wanting a fundamentally different axis-search strategy
  (e.g., a weighted multi-objective optimizer rather than the existing
  coarse→fine grid) would still slot into `assessSharedAxis` as the
  falsifiable oracle it already is.
