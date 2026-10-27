# ADR-023 — A closed prep die extracted from an open scan; library anatomy fitted to the margin

**Status:** Accepted (2026-10-27; Phase 10 implements it — Task 1 lands Decision 1's op; see the Phase 10 plan)
**Date:** 2026-10
**Relates:** ADR-022 (case-derived design inputs, provenance), ADR-007
(morph–shell coupling), ADR-013 (closed-form abutment scoping), ADR-017
(server-authoritative export re-validation).

## Context

Phase 9 closed with two crown gaps on real data (docs/demos/phase-9.md, open
items 1 and 5):

1. **A crown cannot be designed on an intraoral scan.** The crown session
   takes the whole target scan as the die. A real intraoral scan is an *open*
   surface: `arch-case-01`'s upper jaw has one boundary loop of 2624 edges,
   the arch's base cut, about 9.3 mm from tooth 11's margin centroid. Two
   crown steps need a closed die, and only these two:
   - **The intaglio** (`innerSurfaceSolid`): a signed-distance field built
     with angle-weighted pseudonormals, which `computePseudonormals` refuses
     on any boundary edge (`NonWatertightMeshError`). Only the prep above the
     margin, inside the margin footprint plus a crop band, influences the
     field. But every cell's sign comes from its closest feature on the
     *whole* die.
   - **The seating gate** (`measureSeating`): `crown ∩ die` through the
     manifold wrapper, which needs closed operands. An open die makes the gate
     "unverifiable" and it fails. **A closed full arch would fail as well**:
     the crown's proximal contacts are morphed to a target penetration into
     the neighbours, so `crown ∩ arch` contains those contact volumes. The
     seating question is about the *prep*, so the die must be the prep alone.

   The client sends the same die to the server as `dieSolid`, and the server
   re-runs seating on it. Anatomy placement reads the die's world-Z maximum,
   which on a full arch is the arch's, not the tooth's.

2. **The library anatomy is not fitted to the margin.** Placement scales the
   template's *full* mesio-distal extent into the proximal gap, and the morph
   then freezes a 0.6 mm cervical band where placement left it. The built-in
   template works only because it is a cylinder of exactly the margin radius.
   A library incisor's cervix is narrower than its contact level, so it lands
   inside the margin. On the phase-4 shoulder die the shell self-intersected,
   seating failed (175 mm³) and the minimum wall was 0. The shell also trims
   the outer anatomy with one plane through the margin centroid, which leaves
   an uneven seam on a non-planar margin.

## Decision

### 1. The crown designs on a closed prep die extracted from the case scan

A new kernel op `extractPrepDie(scan, marginLoop, insertionAxis, params)`
returns a **closed, validated solid** made of two parts.

**The kept scan surface, verbatim.** Whole scan triangles are kept, never
clipped or moved, so every point of the die that touches the intaglio is the
patient's scan. A triangle is kept when it lies in the connected component of
the margin and all three vertices, projected along the axis, are within
`radialSkirtMm` of the margin polygon (inside it, or within the band outside
it). They must also be at most `depthSkirtMm` below the lowest margin point
along the axis. The footprint follows the margin polygon, not a circle, so
the neighbours' contact surfaces are not part of the die.

**A synthetic closure.** The cut rim is extruded along `−axis` to a floor
plane below the kept surface, as a wall of quads plus a planar floor cap. This
is the `closeRegion` pattern of neighbour capture. The result is checked to be
watertight, manifold, free of self-intersection (geometric scan), and of
positive volume. If any check fails, extraction throws and nothing else runs.

**A clearance certificate makes the synthetic part provably irrelevant.** The
op measures, exactly, the minimum distance from every synthetic triangle (wall
and floor) to two regions:
- the intaglio's evaluation region (the margin-footprint prism plus its crop
  band, above the crop plane);
- the crown's footprint above the margin.

It requires that distance to exceed the inner surface's largest offset plus
its error bound, so that no evaluated part of the intaglio can depend on
synthetic geometry. Otherwise it fails closed with the measured value. The die
is a genuine closed solid, so the sign of every cell, deep interior cells
included, is correct by construction.

The certificate, the kept and synthetic triangle counts, both skirt
parameters and the die's content hash are returned, journaled (op
`crown-die-extract`, `inputHashes` = scan mesh, margin loop, axis) and shown
in the crown panel. The skirt parameters are algorithmic, not clinical (like
`INNER_SURFACE_ROI_RADIUS_FACTOR`). They are kernel constants with documented
derivations, and they are journaled.

The extracted die replaces the whole scan in:
- the intaglio;
- the seating gate (client QC and the `dieSolid` sent to the server);
- the die height used by anatomy placement, measured along the insertion axis
  instead of world Z.

A scan that is already closed and covers only one tooth (the Phase 4 dies)
goes through the same op. So does any other scan: there is one code path.

**Dual validation stays dual.** The server does not trust the client's
`dieSolid`. It re-extracts the die from the saved case's scan (content
addressed), confirmed margin and axis, and refuses the export (409) if the
die's hash differs from the one the client used.

### 2. Library anatomy is fitted to the margin before the morph

The cervical fit is a new kernel op, run after placement and before the
contact morph.

**The template declares its cervical ring.** The tooth-library schema gains
an optional `cervicalRing`: an ordered, closed loop of template vertex indices
on the cervical rim. The generators emit it (asset version 1.2.0; the checksums
change because the metadata changes). An asset without it is not fitted, and
falls back as below.

**The fit.** Each ring vertex is paired, by azimuth around the insertion
axis, with a target on the **emergence loop**. That loop is the confirmed
margin pushed outward, normal to the axis, by the intaglio's marginal gap plus
the material's minimum margin thickness. Both values are read from
`clinical-profiles`, never hardcoded. A deterministic RBF (the existing φ(r)=r
solver with its affine term) then moves the ring onto the emergence loop. The
anatomy above `cervicalBlendMm` stays fixed, as far-field anchors. The fit
reports, as its `@errorBound`, the maximum distance between the fitted ring
and the emergence loop. A template fold is caught by the existing shell
self-intersection and minimum-wall gates, not hidden.

**The shell trims along the fitted ring.** It no longer uses a plane through
the margin centroid. For a fitted template, the outer rim is the fitted ring
itself, so the seam follows a non-planar margin. The existing azimuth zipper
stitches it to the intaglio's margin rim. Unfitted templates keep the plane
trim, unchanged.

**The library template becomes the crown default when it applies.** It
becomes the default when its asset is verified, carries a `cervicalRing`, and
fits within the bound. Otherwise the built-in template is used, with the
reason disclosed (as in Phase 9 Task 4). The choice and the fit are journaled.
Anatomy provenance still does not decide any gate by itself, per ADR-022
Decision 5.

## Consequences

**Positive**
- A crown can be designed on an intraoral arch scan. The intaglio and the
  seating gate are statements about the patient's prep, and the synthetic
  closure is provably outside the region they read.
- The seating gate no longer depends on what else is in the scan.
- The library anatomy can be the default, and on a non-planar margin the seam
  follows the margin.

**Negative / costs**
- Two new kernel ops, so two `KERNEL_VERSION` bumps. Existing pins stay
  byte-identical: the Phase 4–9 goldens call neither op. The server and client
  crown QC pins move only through the version string, plus a documented
  change where the `dieSolid` input becomes the extracted die.
- New library asset version: the server seeds 1.2.0 next to 1.1.0, and saved
  cases that reference 1.1.0 still verify.
- The export request carries a smaller `dieSolid` (the prep, not the arch).
  The server must now re-extract it, which costs one extra kernel op per
  export.

**Not decided here**
- A crown on an *unprepared* tooth (both real cases) is not clinically
  meaningful. On `arch-case-01` extraction and the intaglio will run, but the
  thickness gates will honestly fail, because the natural crown fills the
  space. The full-gate acceptance is a closed-form prepped die embedded in an
  open arch, entered through the real path. A real prepped scan stays a
  tracked pending.
- Bridge abutments keep the built-in template (their morph step is still
  pending from ADR-022 Decision 4).
- An open antagonist scan still goes through the opposite-arch capture.
