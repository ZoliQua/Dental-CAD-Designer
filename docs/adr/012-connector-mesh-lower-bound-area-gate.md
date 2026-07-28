# ADR-012: connector cross-section gate uses a fail-safe MESH lower bound, not the ideal analytic minimum

**Status:** Accepted

## Context

Phase 6 Task 4 needed a connector minimum-cross-section-area measurement
accurate enough to gate patient safety (a connector that is too thin
fractures) while staying fast enough for a LIVE UI readout (redrawn on
every slider edit). The connector is a deterministic ruled loft between two
editable closed 2D profiles. For an IDEAL ruled surface, the cross-section
area along the axial parameter `t` is exactly a quadratic
`A(t) = a·t² + b·t + c` (each ring vertex is linear in `t`, so each
shoelace term is quadratic) — `analyticConnectorMinArea` derives this
closed-form minimum exactly, and it was tempting to treat that as the gate
value: exact, fast, no sampling needed.

It is the WRONG value to gate on. The gate must operate on the REAL
triangulated solid a manufacturing pipeline would mill/print, and that
solid's true minimum cross-section can fall BELOW the ideal ring's
analytic minimum whenever the connector is TWISTED (the two profiles'
vertex correspondence is not a pure taper): the triangulated ruled surface
bows inward between stations, because straight triangle edges cut inside
the ideal circular/elliptical arc a continuous sweep would trace. Measured
on a 45°-twist connector: the real dense-sampled waist is **10.4909 mm²**,
while the ideal analytic ring minimum is **10.7088 mm²** — the ideal value
OVER-reports the true minimum by ~0.2 mm², in the unsafe direction for a
patient-safety gate.

A second failure mode compounds this: even sampling the REAL mesh at
sparse/coarse stations can MISS a waist that falls between two samples. On
the same 45°-twist connector, naive coarse sampling at `t ∈ {1/3, 2/3}`
(straddling but missing the true waist at `t=0.5`) reports **10.7193 mm²**
— also over-reporting, for a different reason (sampling density, not model
choice).

## Decision

The gate value is a **proven, fail-safe LOWER BOUND on the real
triangulated solid's minimum cross-section area**, never the ideal analytic
minimum:

1. `sampleConnectorCrossSectionAreas` sections the REAL solid at dense
   interior stations, equally spaced in `t`, bracketed by the two exact
   profile caps.
2. It computes a rigorous **second-difference station margin**,
   `max_k |A_{k−1} − 2A_k + A_{k+1}| / 8`. On the interior of a single ruled
   segment (fixed cut-edge set), the real mesh's sectioned area `A_mesh(t)`
   is ITSELF a single quadratic in `t` between adjacent stations — for a
   quadratic, this exact `secondDiff/8` term bounds the maximum dip a
   between-station waist can hide below the nearest sample.
3. `guaranteedLowerBoundMm2 = sampledMin − margin` is what
   `measureConnectorMinArea` reports as the gate's `minAreaMm2`. The
   analytic ideal-ring minimum is still computed and reported ALONGSIDE, as
   a closed-form validation oracle and a journaled audit field
   (`analyticMinAreaMm2`) — never as the verdict driver.

**Falsifiable evidence (the fail-safe actually works, on the same
45°-twist adversarial case):** guaranteed lower bound = **10.4909 mm²**,
which EQUALS the real dense-sampled ground-truth waist exactly — the
margin restores exactly the safety the coarse sampling lost, without
requiring dense sampling in the live-readout path (measured timing:
7.10 ms for a 64-gon profile / 63-station connector, well under a 100 ms
interactive budget).

A second, independent guard was added on review: the never-over-report
proof only holds if each cross-section is a SINGLE SIMPLE polygon
(`|shoelace area| = enclosed area`). `sampleConnectorCrossSectionAreas`
now scans each interior station for exactly one simple closed loop (a 2D
proper-intersection scan) and `measureConnectorMinArea` **refuses** (throws
`NonSimpleConnectorSectionError`) rather than report a number when an
adversarial editable profile PAIRING (two individually-simple profiles
whose index correspondence crosses) produces a self-intersecting ruled
section — proven on a purpose-built L-shape/index-shifted pairing, with no
false positive on the default ellipse or a 45° twist.

## Consequences

- **Positive: the gate cannot be fooled by a twisted connector into passing
  a solid whose real waist is thinner than reported.** This is the
  patient-safety-critical property — a connector that would actually
  fracture below the clinical minimum cannot read as compliant because the
  IDEAL model happened to compute a rosier number.
- **Positive: still live-readout-fast.** The fail-safe does not require
  arbitrarily dense sampling — the second-difference margin recovers
  correctness from a MODERATE station count, which is what keeps the
  interactive editor under 10 ms per re-measure.
- **Positive: the analytic value is not discarded, just demoted.** It
  remains a genuine closed-form cross-check (`sampledVsAnalyticMaxAbsMm2`),
  useful for spotting a gross implementation bug, and it is what an
  untwisted/simple-taper connector — the PLAN's acceptance case — actually
  measures to within the sub-0.01 mm² tessellation term.
- **Negative / accepted cost:** the gate's documented `@errorBound` is more
  subtle than "exact closed-form value" — a reviewer or future maintainer
  must understand it is a proven LOWER bound, not the true minimum, and
  that this is deliberate. An earlier draft of the module doc got this
  backwards (claimed the gate used the exact analytic value and called the
  sampled instrument "secondary") — a review caught the contradiction with
  the shipped code before it shipped; the corrected doc and this ADR exist
  specifically so that mistake cannot recur silently.
- **Negative / honest limit:** the simple-section guard assumes each
  station is tested independently; it is a genuinely new, project-specific
  instrument (not reused from an existing kernel primitive) and carries its
  own test surface (3 dedicated tests) to keep confidence in it separate
  from the area-measurement math itself.
