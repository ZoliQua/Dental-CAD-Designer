# ADR-008: occlusal-patch G1 blend — per-station cubic-Hermite cross-sweep

**Status:** Accepted

## Context

Phase 5 Task 4 needed to restore the occlusal surface over a cavity and
blend it into the surrounding intact tooth with **G1 continuity along the
seam** (dihedral angle between the patch's and the tooth's outward normals,
measured densely along the boundary, must stay under 5° — the phase's
hardest new geometry, and one of the three headline PLAN §3 acceptance
criteria). Three candidates were brainstormed:

1. A boundary-constrained RBF with normal constraints at the seam.
2. A Hermite/Coons boundary strip swept into an interior anatomy height
   field.
3. A normal-field-blended SDF (marching-cubes offset with a blended normal
   target).

All three are geometrically plausible; the choice had to satisfy CLAUDE.md's
"accuracy over speed" rule and the acceptance criterion's own measurement
(the G1 gate reads the ACTUAL built patch, not a design intention).

## Decision

**Per-station cubic-Hermite buccolingual cross-sweep**
(`packages/kernel/src/cavity/occlusalPatch.ts`, `buildOcclusalPatch`). The
two occlusal margin runs of the cavity outline give paired buccal/lingual
station points `B_i`/`L_i` (a fixture contract: equal-length runs,
paired index-to-index — `SeamChainLengthMismatchError` otherwise). Each
mesiodistal station's cross-section is a cubic Hermite curve from `B_i` to
`L_i` along the insertion axis:

- **Endpoint positions** are the exact outline points — bit-exact, by
  construction (the patch boundary loop equals `dedupLoop(cavityOutline)`).
- **Endpoint tangents** are set equal to the SURROUNDING tooth surface's
  own tangent at that point, recovered analytically from the surrounding
  facet's outward normal `n`: `k = −(ê·n)/(â·n)` (`ê` the in-plane sweep
  direction, `â` the insertion axis) — the tangent a curve confined to the
  buccolingual plane must have to be tangent to that facet.

Because the boundary curve's tangent is set EQUAL to the surrounding
surface's tangent at every station analytically, the patch is **G1 with the
tooth at the seam by construction**, in the continuous limit — not
approximated by an iterative fit or a solved interpolant.

A companion measurement, `measureSeamDihedral` (`kernel/src/cavity/
seamDihedral.ts`), is built and validated INDEPENDENTLY of the blend method
(closed-form: 0° on a coplanar patch, exact wedge angle on two flat strips,
converging colatitude on a spherical cap) before it is ever used to judge
`buildOcclusalPatch`'s own output — so the acceptance gate is not
"grading its own homework".

The **seam/free partition** (which outline edges the G1 gate applies to) is
computed geometrically, not by construction-order bookkeeping: an outline
edge is a SEAM edge iff the surrounding tooth triangle's outward normal
satisfies `normal·â ≥ cos(60°)` (an occlusal-facing surface); otherwise it is
a FREE (proximal break-through) edge, reported separately and never diluting
the gate value.

### Why this over the alternatives

- An **RBF with normal constraints** only satisfies the tangent condition in
  an interpolation sense (approximately, at the discretization the RBF
  solve uses), and hides the interior anatomy inside an `(N+4)²` dense
  solve — no direct, inspectable relationship between "what shape is the
  interior" and "does the boundary satisfy G1".
- A **normal-field-blended SDF** (marching-cubes offset) reintroduces a
  chord/pitch-scale approximation error exactly at the seam — the very
  quantity the acceptance gate measures — undermining the gate's own
  meaning (passing because the measurement tool and the construction
  method share the same blur, not because the geometry is genuinely
  G1-continuous).
- The Hermite cross-sweep makes the **bit-exact outline boundary trivial**
  (the boundary rows ARE the outline points, no snapping/resampling step)
  and gives an **a-priori, before-the-fact error bound**
  (`seamDihedralBoundDeg`, `@errorBound`-documented) that the measured value
  can be checked against, not just a post-hoc pass/fail.

## Consequences

- **Positive:** the phase's hardest acceptance criterion is met with an
  order of margin on the fixture (measured **0.4558°** default inlay,
  **0.7552°** reduced-cusp onlay variant, **2.178°** on the T7 extended-outline
  onlay fixture — all `< 5°`), and the measured value equals the a-priori
  construction bound almost exactly (the surrounding cusp incline is a
  single ruled facet on the fixture, so the chord-vs-tangent residual the
  bound predicts is exactly what gets measured) — strong evidence the
  method is doing what it claims, not passing by a wide unexplained margin.
- **Positive:** because the boundary is bit-exact on the outline (0 mm
  geometric error), the patch's `errorBoundMm` is 0 and T6's shell stitch
  can weld it to the fit surface along the identical ring with no seam-band
  fabrication (see ADR-009).
- **Negative / accepted honesty note:** the interior anatomy is a **modest
  procedural placeholder** — a mesiodistally-running central groove, with
  NO mesiodistal cusp/ridge features. This is not an oversight: forcing the
  seam to be G1-exact against a RULED surrounding cusp incline (as on the
  fixture) mathematically forces the cross-section to stay uniform along
  the arch. A richer interior anatomy library, with genuine mesiodistal
  relief, is future work and would need a more elaborate interior field
  (still G1-exact at the boundary, but no longer a plain cross-sweep).
- **Negative / accepted limit:** the method assumes an occlusal cavity
  outline with exactly TWO paired, equal-length occlusal margin runs (the
  fixture's "2 occlusal seams / 2 proximal frees" topology). A near-vertical
  butt-margin onlay (a real clinical margin design where the coverage
  margin does NOT sit on an axis-facing incline) would need this seam/free
  partition and the cross-sweep generalized — flagged in
  `docs/demos/phase-5.md`'s open items, not attempted here.
