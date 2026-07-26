# ADR-009: inlay/onlay shell — direct deterministic weld, not a boolean

**Status:** Accepted

## Context

The inlay/onlay shell must fuse two OPEN surfaces — the fit (inner/
intaglio) surface (Task 3) and the occlusal patch (Task 4, contact-adapted
by Task 5) — into a single watertight, 2-manifold solid, without perturbing
either surface's own already-measured, already-acceptance-critical
properties: the fit surface's **≤ 10 µm margin fit** and the patch's
**< 5° seam dihedral** (ADR-008). The Phase 4 crown shell
(`constructShell`) solves an analogous problem for a crown (intaglio +
morphed outer anatomy) using an azimuthal ZIPPER: it bridges two boundary
rims that are structurally DIFFERENT curves (the intaglio's margin loop and
the outer's own, separately-derived cervical trim loop), matched by
arc-length/azimuth pairing.

The inlay/onlay case is geometrically different in a way worth exploiting:
by construction (Tasks 3, 4, and 5 all engineered to it), the fit surface's
skirt and the occlusal patch's boundary are not just similar curves — they
are **the exact same cavity-outline ring**, bit-exact, because:

- Task 3's fit surface skirts to `dedupLoop(cavityOutline)` via an
  arc-length pairing chosen specifically for the cavity's non-planar,
  proximal-break-through outline (ADR-adjacent Task 3 finding).
- Task 4's occlusal patch boundary loop IS `dedupLoop(cavityOutline)` by
  construction (the Hermite cross-sweep's endpoints are the exact outline
  points — ADR-008).
- Task 5's proximal-contact adaptation PINS the outline exactly (the
  adapted rim vertices move; the outline coordinates never change — a hard
  invariant, verified byte-identical before/after).

## Decision

**A direct, deterministic WELD along the shared bit-exact ring** —
`constructInlayShell` (`packages/kernel/src/cavity/inlayShell.ts`), not a
boolean union:

1. Verify (at runtime, falsifiably) that both surfaces present exactly one
   boundary loop each (`InlayShellOpenBoundaryError` otherwise), and that
   the two rings' coordinate SETS are bit-exact equal
   (`InlayShellRingMismatchError` — a ring vertex perturbed by even 10 µm
   throws).
2. Concatenate the two surfaces and run `weldVertices` (exact-coordinate
   dedup at `MESH_WELD_EPSILON_MM`) — every outline edge, a boundary edge on
   BOTH input surfaces, gains its second incident triangle and becomes a
   manifold interior edge. No new geometry is fabricated at the seam; no
   triangle is re-tessellated.
3. Canonicalize orientation (`orientNormalsConsistently`) and re-validate
   through the `manifold-3d` wrapper (`cleanupMesh` — `NonManifoldInputError`
   on a genuine defect) and `analyzeMesh` (watertight + single-component,
   `InlayShellNotWatertightError` otherwise).

No insertion axis is required (the weld is purely coordinate-based); no
azimuth zipper is needed (unlike the crown, the two rims here are not
merely SIMILAR — they are the SAME ring).

### Why a weld over a boolean (CLAUDE.md: accuracy over speed)

A boolean union (`manifold-3d`'s intersect/union primitives) would
re-tessellate the margin/seam region through manifold-3d's internal Float32
boundary representation, perturbing the ≤ 10 µm marginal seal and the < 5°
seam dihedral that Tasks 3-5 already measured and journaled — silently
invalidating the phase's two headline acceptance numbers at the very last
assembly step. `weldVertices` never averages or perturbs a leader vertex's
position; every input Float64 vertex the two upstream stages already
validated survives assembly at its exact bit pattern.

## Consequences

- **Positive, and STRONGER than the crown shell's own guarantee:**
  margin fit and seam dihedral don't just stay "under threshold" after
  assembly — they are asserted **byte-identical** (`===`, not `<`) before
  vs. after the shell weld (`inlay-shell-acceptance.test.ts`,
  `onlay-acceptance.test.ts`). This is possible only because the weld adds
  zero approximation (`errorBoundMm: null` on the shell stage — the weld
  itself introduces no error; only the upstream `manifold-3d` cleanup has
  its own sub-µm bound).
- **Positive:** the crown's azimuth-zipper machinery (needed for two
  genuinely distinct rims) is correctly NOT reused here — reusing it would
  have reintroduced a resampling/pairing step this shell has no need for,
  and no way to prove bit-exact.
- **Negative / accepted coupling cost:** this construction is entirely
  dependent on Tasks 3-5 maintaining the shared-ring contract. A future
  stage that resamples or simplifies either surface's boundary (e.g. a mesh
  decimation pass) would silently break this precondition — mitigated, not
  eliminated, by the runtime `InlayShellRingMismatchError` check (the
  precondition failure is always loud, never silently wrong output), but a
  reviewer extending this pipeline must know the shared-ring invariant
  exists and is load-bearing.
- **Negative / accepted scope limit:** this exact-weld approach relies on
  the two surfaces sharing a SINGLE common boundary loop. It does not
  generalize, as written, to a restoration whose inner and outer surfaces
  might legitimately need independently-tessellated boundaries (not a
  concern for the inlay/onlay topology this phase covers).
