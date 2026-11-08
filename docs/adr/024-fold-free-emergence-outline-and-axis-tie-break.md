# ADR-024 — A fold-free emergence outline; the axis suggestion's tie-break; incisor proportions

**Status:** Accepted (2026-11-08; implemented by Phase 11 — see
docs/demos/phase-11.md for the measured outcomes, and Decision 2's refine-cap
amendment below)
**Date:** 2026-11
**Relates:** ADR-023 (the prepared die and the cervical fit, which this
refines), ADR-022 (provenance), ADR-007 (morph–shell coupling).

## Context

Phase 10 closed with the fitted library template as the crown default, and
every crown gate passing on the closed-form open-arch case. On real data,
though, the library template is never used (docs/demos/phase-10.md, open
items 1–3):

1. **The cervical fit refuses every dense real margin.** ADR-023's emergence
   loop moves each margin point outward by the emergence offset `d`
   (0.651 mm for zirconia) along the normal of its central difference. That
   is the *pointwise* offset of a curve. It folds wherever the margin's
   projection is concave with a radius of curvature below `d`, and wherever
   point-to-point noise swings the local normal. On `arch-case-01` tooth 11
   (513 points, median spacing 36 µm, concave interproximally) 50 of 450
   azimuth steps of the offset loop reverse. The fit then refuses with
   `margin-not-star-shaped`, correctly, and the built-in template is placed.
   The margin itself is star-shaped around its centroid. Only its offset is
   not.
2. **The axis suggestion lands off the die's axis when the undercut ties.**
   On a die that is a height field over its margin plane, every direction
   near the true axis scores zero undercut. The documented tie-break keeps
   the earliest generated candidate: index 0 of the coarse Fibonacci
   hemisphere around the ROI's area-weighted normal (the *pole*). Index 0 is
   the sample *nearest* the pole, not the pole itself: on the 32-sample
   sweep it lies ~12° away (z = 47/48). The refine cap cannot displace it,
   because a tie never replaces the best. The clinician has to correct the
   axis with the elevation slider (`e2e/phase10.spec.ts` does).
3. **The placeholder incisor is a plate.** The central incisor's cervical
   section is 6.2 mm mesio-distally but 1.9 mm bucco-lingually
   (`ryBuccalCervicalMm` 1.0 + `ryLingualCervicalMm` 0.9). A textbook upper
   central is ~7 mm by ~6 mm at the cervix. On a round die it
   self-intersects with or without the fit (Phase 10 Task 4), so the incisor
   site falls back to the built-in template wherever the fit does not refuse
   first.

## Decision

### 1. The emergence outline is the exact outer boundary of the margin's projection dilated by `d`

Let `P` be the region bounded by the margin projected onto the plane normal
to the insertion axis (the frame of ADR-023: origin at the margin centroid
`c`, basis `u`, `v`). The fit already requires `P` to be star-shaped around
`c` (the margin's azimuths strictly monotone, one turn). The emergence
outline is the boundary of the Minkowski sum `P ⊕ D(d)`: the set of points
at distance exactly `d` from `P`.

- **It never folds.** If `P` is star-shaped around `c`, so is `P ⊕ D(d)`:
  for `x = p + w` with `p ∈ P` and `|w| ≤ d`, every point
  `c + t(x − c) = (c + t(p − c)) + t·w` lies in `P ⊕ D(d)` for `t ∈ [0, 1]`.
  So the outline has exactly one point per azimuth, at radius
  `R(θ) = sup { t : dist(c + t·e(θ), P) ≤ d }`. The `margin-not-star-shaped`
  refusal for the *emergence loop* disappears. The refusal of a margin that
  is itself not star-shaped stays.
- **It is exact, in closed form.** Along a ray, `dist(·, segment) ≤ d` is a
  convex set (an interval), the intersection with the segment's capsule. So
  `R(θ)` is the largest exit parameter of the ray over the capsules of the
  projected margin's segments: the larger root of a quadratic for each end
  disk, and a linear solve for each of the segment's two offset lines,
  clipped to the segment's slab. There is no sampling, no SDF and no
  tolerance. `@errorBound`: floating-point rounding only (asserted at 1e-12
  mm on the analytic cases).
- **Height.** Each outline point takes the height along the axis of its
  *nearest* margin point (the closest point on the generating segment, with
  its 3-D height interpolated linearly along that segment). On a convex
  margin this is ADR-023's "each point at its own height". Inside a filled
  concavity the nearest point can jump between the notch's two sides. The
  height then steps, and the RBF blend absorbs it. The wall and
  self-intersection gates measure the result, as before.
- **Sampling.** The emergence loop returned for the bound and the journal is
  `R(θ)` evaluated at every margin point's azimuth (after `dedupLoop`). It
  is star-shaped by construction, with monotone azimuths. Ring targets are
  **evaluated exactly at each ring vertex's azimuth**, no longer by a
  ray-polyline hit on the sampled loop. The fit's `errorBoundMm` keeps its
  definition: the two-way polyline distance between the fitted ring and the
  loop, which is the template ring's tessellation chord.
- **What changes numerically.** On a convex polygon the pointwise offset
  linearly interpolates chords between vertex offsets, while the exact
  outline is the offset segment plus a circular arc at each vertex. On the
  192-gon of the Phase 10 fixtures the difference is below
  `d(1 − cos(π/192))` ≈ 0.09 µm. The cervical-fit and open-arch library pins
  therefore move: a kernel bump with a changelog entry, and the new pins
  proven as the only moves.

### 2. Tied axis candidates resolve toward the pole, and the pole is a candidate

- The coarse sweep gains the pole itself as candidate 0, before the
  Fibonacci directions.
- A candidate replaces the current best when its score is strictly lower,
  **or equal with a strictly smaller angle to the pole** (an exact
  comparison of `dot(direction, pole)`). `ranked` sorts by
  `(scoreMm3 ascending, dot(direction, pole) descending)`, then generation
  order, so `ranked[0] === best` still holds by construction.
- The ROI-normal pole (`deriveHemispherePole`) is unchanged. On a region
  with no undercut anywhere, the suggestion is the pole: the ROI's own
  area-weighted normal, the least surprising answer. An explicit
  `options.pole` keeps working as before.
- The axis pins move only where scores tie, which is the case these changes
  target. A kernel bump with a changelog entry.
- **Amendment (Phase 11 Task 2).** The refine cap stays centred on the
  Fibonacci sweep's winner, not on the overall winner. Centred on a winning
  pole, it searched a worse basin on real `arch-case-01` tooth 11 (0.734 →
  1.660 mm³). With the cap on the sweep's winner, the candidates are the
  previous set plus the pole, so the winner never scores worse.

### 3. The placeholder incisor gets textbook cervical proportions (library asset 1.3.0)

- Central (11/21): cervical section ~7.0 × 6.0 mm (MD × BL), contact level
  ~8.5 mm MD, incisal edge ~1.2 mm thick. Lateral (12/22): ~5.0 × 5.0 mm
  cervical, ~6.5 mm MD at contact. These are placeholder textbook averages,
  like every figure in `toothParams.ts`, and are not clinically sourced.
- **A saved case keeps verifying.** The incisor *meshes* change, so the
  previous versions cannot be re-derived from the new tables. The 1.1.0 /
  1.2.0 incisor tables are kept frozen (`*_V1`). The starter set builds
  every served version from its own tables, and the server seeds all of them
  (1.1.0, 1.2.0 and 1.3.0), generalising `PREVIOUS_STARTER_ASSET_VERSION` to a
  list. The premolar and molar meshes are byte-identical in 1.3.0, and only
  their metadata version moves.

## Consequences

- On real margins the library template can now be fitted. Whether it fits
  within `CERVICAL_FIT_MAX_RESIDUAL_MM` (50 µm) depends on the template ring's
  tessellation against the outline's detail. This is measured on
  `arch-case-01` tooth 11. If the bound refuses it, the refusal is
  `fitOverBound` with the measured residual, disclosed, never a weakened
  bound.
- The axis suggestion on a symmetric prep is its axis, with no slider
  correction.
- The incisor sites can use the library template on a round or real die.
  Its gates measure it.
- Golden pins move under three deliberate changes (two kernel bumps and
  library asset 1.3.0), each proven to move only the pins it names.
