# ADR-027 — Crown height from the neighbours' occlusal level when there is no antagonist

**Status:** Proposed (2026-11-16)
**Date:** 2026-11
**Relates:** ADR-022 (case provenance; the captured neighbour), ADR-026
(verified contacts; its open consequence, the contact location).

## Context

Phase 13 left one clinical open item: on real `arch-case-01` tooth 11 the
morph picks a cervical vertex as the mesial contact vertex, because it is the
crown's globally nearest point to 21 (docs/demos/phase-13.md, open item 1).
The proposed fix was a proximal contact height band. Before building it,
the real lane was measured (2026-11-16, kernel 0.43.0, the axis-projected
height `h` above the margin centroid):

| quantity | value |
|---|---|
| natural tooth 11 on the scan (unprepared): incisal edge | 5.64 mm |
| tooth 21 / tooth 12 on the scan: highest point above their own margin | 5.70 / 5.62 mm |
| the placed library incisor's highest point | **11.68 mm** |
| distance from that point to the nearest scan surface | **6.05 mm** |
| the captured neighbours' real surface, as a fraction of the crown's height | 0.00–0.29 (21), 0.00–0.47 (12) |

**1. Without an antagonist the crown has no height datum.** The placement
(`anatomy/placement.ts`) scales the occluso-gingival axis to the antagonist
when there is one. Without one it reuses the mesio-distal scale, which keeps
the library tooth's proportions. On this arch that makes the crown about
twice as tall as the teeth beside it, 6 mm proud of the arch. Every
downstream result inherits this. The crown's lower third is the only part
near the neighbours, so the contact falls cervically. A contact height band
cannot fix that: in the incisal third the band would choose a vertex 2–5 mm
from 21.

**2. The gates pass a crown that is twice too tall.** No gate measures the
crown against the neighbours. The synthetic premolar lane (Phase 10 Task 5)
passes every gate with its crown about 10 mm above the neighbours' tops.

**3. A prototype measured the plain neighbour level.** Scaling the height to
the neighbours' occlusal level, interpolated at the site, gives:

| lane | neighbour level | intaglio top | outcome |
|---|---|---|---|
| real tooth 11 (unprepared) | 4.72 mm | ≈ 5.7 mm | the die pierces the crown: wall 0 µm, 1036 self-intersecting pairs |
| synthetic open-arch die | 4.98 mm | ≈ 5.6 mm | wall 0–2 µm, 730–1099 self-intersecting pairs |

On both, the die is taller than the neighbours' level. On the real tooth this
is true: it is unprepared. The synthetic fixture's die (5.5 mm above its
margin) is also 0.5 mm taller than its neighbours (6.5 mm above the gingiva,
the margin at 1.5 mm). A crown that the die pierces is not a solid. The
right report is "the preparation is too tall for its neighbours by X mm", not
a cascade of self-intersections.

**4. A capture can truncate the neighbour.** A captured neighbour is cut by a
ball of `radiusMm` around the pick (`neighbour/extractNeighbourRegion.ts`,
rule 3). Within `windowBoundaryBandMm` of that sphere, its highest point can
be a cut, not the tooth's top. On the real lane the captured tops match the
scan's tops (21: 8.283 vs 8.287 mm; 12: 10.288 vs 10.294 mm), so the ball
does not truncate them. That is a property of this capture, not a guarantee.

## Decision

### 1. The neighbours' occlusal level is the height datum when there is no antagonist

- `solveAnatomyPlacement` takes an optional `neighbourOcclusalDatum`, which
  holds, per side, the capture's window: the seed, `radiusMm`,
  `windowBoundaryBandMm`, and the count of leading real vertices.
- **Peak.** Each side's peak is its real vertex with the largest height
  `(p − origin)·og`. On an exact tie, the lowest index wins. A capture's
  closure vertices share their real vertices' heights but sit displaced
  along the approach direction, so they are excluded.
- **Truncation.** A peak is **truncated** when its distance to the seed
  exceeds `radiusMm − windowBoundaryBandMm`: the ball may have cut the tooth
  there.
- **Level.** The level is the line through the two peaks, evaluated at the
  site: their heights interpolated linearly by their mesio-distal position
  `u = (p − origin)·md`. The interpolation parameter is clamped to [0, 1].
  It is linear, so the arch's tilt along `md` cancels to first order. It
  needs no per-tooth clinical rule.
- **Scale.** The O-G scale puts the library tooth's highest point at the
  level: `scaleOG = level / nativeTop`. Here `nativeTop` is the library
  mesh's highest point above its canonical origin along its canonical O-G
  axis, not its whole extent, because the target is a height above the
  origin. The antagonist rule is unchanged.
- **When it applies.** The engine passes the datum only when there is no
  antagonist and both proximal neighbours are case captures (ADR-022
  provenance `case`). A stand-in has no anatomical top.
- **Fallback.** A truncated peak, a missing side, or a non-positive level
  falls back to today's uniform scale. The reason is journaled and shown:
  `neighbourPeakTruncated`, `neighbourNotCaptured` or `levelNotAbove`.

### 2. The crown covers the intaglio, and the shortfall is reported

- The datum carries the intaglio and the profile's
  `occlusalMinWallThicknessMm` (t).
- **The floor** is the lowest O-G scale at which every intaglio point q
  lies at least t below the crown's outer surface, along `og`.
  - The O-G scale is linear about the origin, so the placed surface over a
    lateral position is `s · H₁`, where H₁ is its height at scale 1. That
    gives `s_floor = max over q of (h(q) + t) / H₁(q)`.
  - H₁ is the topmost hit of a ray cast down `−og` through q's lateral
    position. A point whose ray misses the library constrains nothing.
- If the level is below the floor, the crown's top is placed at the floor.
  The difference is reported as `occlusalReductionShortfallMm`, journaled
  with the placement, and shown as a warning in the crown panel. It is how
  far the crown stands above its neighbours to cover the preparation: the
  occlusal reduction is insufficient for this anatomy.
- The floor holds along the axis, not normal to the surface. On a slope the
  normal wall is thinner, and the minimum-wall gate measures it. No gate
  changes.
- **Rejected on measurement:** an apex-only floor (the intaglio's top plus
  t). It let the die pierce the premolar's central fossa and the incisor's
  incisal third, with 687 and 1159 self-intersecting face pairs (Phase 14
  Task 1).

### 3. The proximal contact vertex lies in a profile height band

- The morph's contact vertex is the nearest non-fixed vertex whose
  fractional height above the margin lies in the profile's proximal contact
  band:
  - `PROXIMAL_CONTACT_BAND_ANTERIOR` = [0.60, 0.95] of the crown height
    (incisal third to its junction with the middle third);
  - `PROXIMAL_CONTACT_BAND_POSTERIOR` = [0.45, 0.90] (the occlusal and
    middle thirds' junction).
  - Both are documented clinical placeholders in `clinical-profiles`.
- The band rides on `MorphContactInput.heightBand?`: the margin origin, the
  axis, the crown height and the fraction pair. Absent means today's global
  nearest vertex, bit for bit.
- An empty band (no vertex) is a `RangeError` before any root-find. It
  cannot happen on a placed crown, whose height runs from 0 to 1.
- Whether the banded contact reaches real neighbour surface is measured on
  the real lane and asserted, whatever it is.

## Consequences

- Kernel 0.44.0 (Decisions 1–2) and 0.45.0 (Decision 3). Each is proven at
  the previous version with the new code. The datum and the band are opt-in
  inputs, so without them every kernel path is unchanged. The crown lanes
  that pass them move, and each moved pin is named.
- The synthetic open-arch lanes report the 0.5 mm shortfall of their own
  fixture. The fixture is not edited to hide it. Whether a corrected fixture
  is added beside it is a Phase 14 plan decision, made on measurement.
- Bridges (pontic placement) keep the uniform fallback. They are a later
  phase.
- The real tooth 11 is expected to report a shortfall of about the intaglio
  top minus the neighbour level, around 1.4 mm. That is the true clinical
  message for an unprepared tooth.
