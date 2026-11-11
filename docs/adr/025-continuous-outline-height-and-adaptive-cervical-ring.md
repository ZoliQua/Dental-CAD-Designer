# ADR-025 — A continuous emergence-outline height; an adaptively refined cervical ring

**Status:** Accepted (2026-11-11; implemented by Phase 12 — measured
outcomes in docs/demos/phase-12.md)
**Date:** 2026-11
**Relates:** ADR-024 (the exact emergence outline, which this refines),
ADR-023 (the cervical fit), ADR-007 (morph–shell coupling).

## Context

Phase 11 made the emergence outline fold-free, so the cervical fit now runs
on real margins. On real `arch-case-01` tooth 11 it still refuses the
margin over the 50 µm bound (`CERVICAL_FIT_MAX_RESIDUAL_MM`): 178 µm in the
golden and 135 µm in the e2e (docs/demos/phase-11.md, open items 1 and 6).
The residual is the two-way 3-D polyline distance between the fitted ring
and the emergence loop. It is made of two parts.

1. **The outline's height is discontinuous.** ADR-024 gives each outline
   point the height of its *nearest* margin point. Inside a filled
   concavity the nearest point jumps between the notch's two sides. Exactly
   on the bisector, rounding picks the side. On tooth 11 the loop height
   steps by up to 163 µm between neighbouring samples. Even where it is
   continuous, the nearest point is not the margin point at the same
   azimuth unless the margin is locally circular (up to 65 µm off on a
   scalloped ellipse).
2. **The template ring is coarser than the margin's height profile.** The
   incisor margin's interproximal scallop spans 1.37 mm of height around
   the tooth. A 72-vertex ring's straight chords cannot follow it in 3-D.

A probe on tooth 11's committed trace (the golden's axis, `d` = 0.651 mm),
with the ring at uniform azimuths, measured this residual:

| Outline height | 72 ring vertices | 144 | 288 |
|---|---|---|---|
| nearest margin point (ADR-024) | 117 µm | 76 µm | 28 µm |
| the margin at the same azimuth (radial) | 73 µm | 27 µm | 16 µm |

Neither change alone brings the 72-vertex template within the bound.
Together they do, with margin to spare.

## Decision

### 1. The outline's height is the margin's height at the same azimuth

The outline point at azimuth θ takes the height of the margin where the ray
at θ crosses the margin's projection (linear along the crossed segment).
The margin is star-shaped around the centroid, so the crossing is unique
and the height is a **continuous** function of θ. At a margin point's own
azimuth it is exactly that point's height, which is ADR-023's "each point
at its own height", now true for every margin rather than only circular
ones. The horizontal outline (`R(θ)`, ADR-024) is unchanged.

Rounding at a shared vertex: when the ray passes through a margin vertex,
both adjacent segments give that vertex's height (linear interpolation at
s = 0 or 1). The crossing is computed with the vertex parameter clamped to
[0, 1], and the segment search starts deterministically, so the result is
the same bits on every platform (only +, ×, /).

### 2. The fit refines the template's cervical ring where its chords cannot follow the outline

Before the RBF, the fit **splits template ring edges** whose chord deviates
from the outline by more than the bound:

- For a ring edge (vertices `a`, `b`, with targets `T(a)`, `T(b)` on the
  outline), the deviation is the largest 3-D distance from the chord
  `T(a)T(b)` to the emergence-loop points whose azimuths lie within the
  edge's azimuth span, and to the outline point at the edge midpoint's
  azimuth.
- An edge over the bound is split at its **template midpoint** (the
  midpoint of the straight edge in the placed mesh). Each triangle using the
  edge is split in two. The new vertex lies on the existing edge, so **the
  template's shape before the fit is unchanged bit for bit**.
- This repeats up to `maxRingRefineLevels` (default 3, so at most 8× the
  ring). The bound and the level cap are inputs, journaled with the fit.
  The bound is the profile's `CERVICAL_FIT_MAX_RESIDUAL_MM`, passed in by
  the caller and never defaulted in the kernel.
- The fit returns the **refined ring** (its vertex indices in the output
  mesh). The morph's fixed vertices and the shell's trim ring use it.
- A ring whose edges are all within the bound is not touched. A fit that
  already met the bound is byte-identical to before.
- `@errorBound`: unchanged in definition (the two-way polyline distance).
  The refinement only lowers it.

The residual check stays where it is: the caller refuses `fitOverBound`
when the reported residual exceeds the bound. No bound is weakened.

## Consequences

- On real tooth 11 the library incisor is expected to fit within the bound.
  That is measured, not assumed, and the crown's later gates measure the
  result. The tooth is unprepared, so the wall and seating gates still fail.
  If the fitted incisor makes another gate fail, the golden and the e2e
  assert the honest verdict.
- Kernel version bump (0.39.0). On a planar margin both height rules give
  the same bits, so the open-arch library lanes are expected not to move.
  Tilted or scalloped fixtures move. Every moved pin is named in the
  changelog.
- The placed library mesh can have more vertices than the asset when the
  fit refines. The asset itself is unchanged, so its checksum still
  verifies. The journal records the refined ring size.
