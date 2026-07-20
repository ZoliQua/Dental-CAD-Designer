// packages/kernel/src/margin/validate.ts
//
// Phase 3 Task 6: margin-line validation — a deterministic, REPORTING (never
// throwing) check of a `MarginLine` against the mesh it is anchored to.
// `validateMarginLine` computes a typed `MarginValidationReport`; it never
// decides what to DO about a finding (block a confirm action, allow it with
// an acknowledged warning, ...) — that's `classifyMarginValidation` (a pure
// bucketing helper, still not a "gate" in the sense of performing any
// action) plus, ultimately, the editor's own confirm flow
// (apps/client/src/engine/marginEditor.ts's `confirmMargin`). This mirrors
// this repo's established QC-gate shape (`QcGateResult.passed`/
// `.acknowledged`, packages/shared-types/src/index.ts) at the margin-line
// scale, ahead of Phase 4's full QC-gate machinery.
//
// ## What gets validated: `resampledPoints` if present, else raw anchor
// positions — NEVER re-derived from `(triangleIndex, barycentric)`
//
// This is the single most important design decision in this file. A
// `MarginAnchor` (shared-types) carries BOTH an ambient `position` AND a
// `(triangleIndex, barycentric)` pair that `position` is documented to be
// "the float-precision echo" of (never expected to disagree — see that
// interface's doc) — but nothing in the type system enforces that they
// actually agree. If this validator re-evaluated every point from
// `(triangleIndex, barycentric)` (the way `spline/marginLine.ts`'s
// `fromMarginLine` deliberately does, for its own, different, purpose — see
// its doc), a corrupted/tampered `position` field would be invisible: the
// re-derived point is BY CONSTRUCTION exactly on the surface, no matter what
// `position` says. An off-surface bug (a UI slip that writes a stale/wrong
// ambient position while leaving `triangleIndex`/`barycentric` untouched, or
// a hand-edited/imported document) would silently pass. This validator
// therefore reads AMBIENT positions straight off the document — exactly
// what would be rendered/exported — and checks THOSE against the mesh via
// the BVH, so a tampered position is exactly what the on-surface check
// (below) is built to catch (see validate.test.ts's off-surface case).
//
// `margin.resampledPoints`, when present, is preferred over raw anchor
// positions: it is the actual dense curve a consumer sees (rendering,
// export) — the more complete, more clinically relevant thing to validate.
// `resampledPoints` is absent for a fresh manual trace that hasn't been
// spline-fit yet (shared-types' `MarginLine.resampledPoints` doc); the
// fallback to `anchors.map(a => a.position)` keeps this validator usable
// even then, at the coarser (but still faithful, still ambient-position-
// based) anchor-polyline resolution.
//
// ## Self-intersection: ambient segment-pair distance + tolerance band — an
// HONEST, DOCUMENTED PROXY for a true on-surface/geodesic self-intersection
// test, not an exact one
//
// A margin line is a curve CONSTRAINED to a 2-manifold surface; "does it
// cross itself" is, precisely, a question about the curve's parametrization
// on that 2D surface (or, equivalently, its GEODESIC path), not about
// ambient 3D space. This validator does not attempt that — it treats the
// curve's points as a free 3D polyline and asks whether any two
// non-adjacent segments come within `MARGIN_SELF_INTERSECTION_TOLERANCE_MM`
// of each other in ordinary Euclidean 3D distance (`closestPtSegmentSegment`
// below, the standard clamped-parametric segment-segment closest-point
// algorithm — Ericson, "Real-Time Collision Detection" ch. 5.1.9).
//
// **Why this suffices at margin scale**: a margin line lies on a surface
// whose local curvature radius is, everywhere near a real prep, much larger
// than `MARGIN_SELF_INTERSECTION_TOLERANCE_MM` (a few mm at the very
// tightest anatomical features vs. this constant's 0.015mm — see that
// constant's own doc for the measured derivation) — i.e. the surface is
// well-approximated as LOCALLY FLAT at the scale this check operates at.
// Two points that are genuinely far apart geodesically (different, unrelated
// parts of the surface) cannot be brought within 0.015mm of each other in
// AMBIENT space without the surface itself folding back on itself at a
// radius far tighter than any real prep geometry has — so an ambient
// near-touch between two non-adjacent segments of the SAME margin curve is,
// in practice, always a genuine curve self-crossing (or so close to one that
// treating it as one is the clinically correct, conservative call — a
// dentist would call a 15-micron-separated crossing "touching"). A
// SEPARATE concern — ordinary NEARBY points along a locally-smooth stretch
// of curve ALSO fall within a small ambient tolerance of each other, purely
// from how densely the curve happens to be sampled, with no crossing
// involved at all — is handled by `findSelfIntersections`'s arc-length
// LOCALITY WINDOW (`SELF_INTERSECTION_LOCALITY_WINDOW_MM_FACTOR`), a
// distinct mechanism from the ambient tolerance itself; see that
// constant's own doc.
//
// **What this can miss (the honest limit, per this task's brief)**: on a
// surface with a genuine, tight FOLD (e.g. a deep undercut, or two
// DIFFERENT teeth's margins running close together across a thin
// interproximal septum), two AMBIENT-nearby points can be geodesically far
// apart and belong to two curves (or two parts of one curve) that never
// actually cross on the surface — this check could, in principle, false-
// positive there. It could also, symmetrically, false-NEGATIVE a true
// geodesic self-crossing where the ambient path between the two crossing
// arcs happens to run somewhere the tolerance band doesn't reach (a
// pathological "crosses on the surface but the two arcs approach from
// opposite sides of a thin wall, staying > tolerance apart in 3D the whole
// time" case) — not expected for a normal, single-tooth margin loop (which
// this project's real fixtures and the "15-35mm incisor" scale bound this
// module's own comments elsewhere establish), but a real, honestly-recorded
// limitation of an AMBIENT proxy for a GEODESIC property. A true
// geodesic/parametric self-intersection test (walking the curve's own
// surface parametrization and checking for a genuine topological crossing)
// would close this gap but is materially more machinery (curve
// parametrization + geodesic distance, not just ambient point comparisons)
// — out of this task's scope; see this task's report for the measured
// evidence (both fixtures below) that the ambient proxy catches the
// deliberately-constructed acceptance cases cleanly.
//
// ## On-surface: `MESH_WELD_EPSILON_MM` via BVH `closestPoint`
//
// Per this task's brief literally ("every resampled point <= weld epsilon
// via BVH") — reusing `intake/weld.ts`'s `MESH_WELD_EPSILON_MM` (1e-6mm)
// rather than a fresh epsilon, this repo's established convention (see
// `spline/catmullRom.ts`'s `MIN_CONTROL_POINT_SEPARATION_MM`,
// `section/polyline.ts`'s `ON_PLANE_EPSILON_MM`). A point genuinely produced
// by `evaluateSurfacePoint(mesh, {triangleIndex, barycentric})` (which is
// how EVERY legitimate producer of anchor/resampled positions in this
// codebase constructs them — `spline/marginLine.ts#toMarginLine`,
// `spline/surfaceSpline.ts`'s span points) sits on its triangle up to
// ordinary Float64 barycentric-combination rounding (~1e-13..1e-15mm at
// dental-scan coordinate magnitudes) — comfortably under 1e-6mm. A genuinely
// off-surface point (the tampered-position test case) is expected to be
// displaced by orders of magnitude more than that (any deliberate or
// accidental corruption large enough to matter clinically), so this
// threshold cleanly separates the two without needing a looser, ad hoc
// value.
//
// ## Smoothness warnings: discrete curve curvature (turning angle / local
// arc length), a documented fixed threshold
//
// Reuses `marginRidge.ts#simplifyRidgeLoopIndices`'s own turning-angle
// construction (`acos(clamp(dot(normalize(cur-prev), normalize(next-cur)),
// -1, 1))`) — that function budgets ANCHOR PLACEMENT by raw accumulated
// angle; this one flags OUTLIERS by discrete curvature (angle divided by the
// local mean segment length, `MARGIN_SMOOTHNESS_CURVATURE_THRESHOLD_MM_INV`
// mm^-1 — an actual 1/radius-of-curvature estimate, not a raw angle, so it
// is meaningful across anchor lists of very different point density: a
// densely-resampled curve's per-point turning angle is naturally small even
// through a legitimately tight corner, purely because the corner is spread
// over more points; normalizing by local spacing recovers a
// density-independent curvature estimate). See that constant's own doc for
// its derivation against this task's measured real-fixture evidence.
//
// @errorBound This module performs no interpolation/approximation of a
// continuous quantity beyond what its inputs already carry: `closestPoint`
// (bvh/closestPoint.ts)'s own `@errorBound` (exact triangle-level geometry,
// ordinary Float64 rounding only) bounds the on-surface check;
// `closestPtSegmentSegment` is the exact (to Float64 rounding) closed-form
// solution for two finite 3D line segments' closest approach, per Ericson's
// derivation — no iteration, no convergence tolerance of its own. The
// self-intersection check's AMBIENT-vs-GEODESIC proxy gap (above) and the
// smoothness check's fixed-threshold heuristic are the two places this
// module's OWN judgment (not merely inherited float-rounding noise) enters
// — both documented above/at their constants, per this task's guardrail.
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import type { Bvh } from '../bvh/types.ts';
import { closestPoint } from '../bvh/closestPoint.ts';
import { MESH_WELD_EPSILON_MM } from '../intake/weld.ts';
import type { MarginLineLike } from '../spline/marginLine.ts';

// ---------------------------------------------------------------------------
// Documented algorithmic defaults (kernel-level, not clinical-profiles — see
// this module's top doc and CLAUDE.md's "algorithmic default lives in the
// kernel" precedent, already established by margin/marginRidge.ts).
// ---------------------------------------------------------------------------

/** Ambient 3D distance (mm) below which two non-adjacent margin-curve
 * segments are reported as self-intersecting — see this file's module doc,
 * "Self-intersection", for the method. MEASURED derivation (this task's
 * report has the full sweep): the REAL arch-case-01 golden margin proposal
 * (261 raw `proposeMarginLoop` anchors, no smoothing/resampling applied —
 * see validate.ts's module doc for why raw anchor positions are exactly
 * what gets validated when `resampledPoints` is absent) is NOT a perfectly
 * smooth polyline — the real, noisy k2-ridge-band walk (marginRidge.ts's
 * own module doc) leaves small residual per-vertex jitter, and the
 * GLOBAL minimum ambient distance between any two non-adjacent segments
 * anywhere on that real, CLEAN loop measures 0.0222mm. A deliberately
 * corrupted "figure-eight" reordering of real, WIDELY-spaced (~1.8mm apart)
 * on-surface points from that SAME real mesh (this task's acceptance test)
 * measures genuine crossing distances of 0.0059-0.0075mm — small but
 * nonzero, because two chords of a curved surface are only APPROXIMATELY
 * coplanar (the surface's own curvature over the crossing region keeps a
 * true reordering-crossing from ever landing at EXACTLY 0, unlike a flat-
 * plane crossing). 0.015mm sits centered (log-scale) between these two
 * measured bounds — comfortably below the real noise floor (~1.5x) so a
 * clean real proposal is never falsely flagged, comfortably above the
 * measured genuine-crossing ceiling (~2x) so a real self-crossing is always
 * caught. */
export const MARGIN_SELF_INTERSECTION_TOLERANCE_MM = 0.015;

/** Discrete curvature (turning angle / local mean segment length, mm^-1)
 * above which a point is flagged as a smoothness-warning outlier — see this
 * file's module doc, "Smoothness warnings". MEASURED derivation (this
 * task's report has the full sweep): the SAME real, clean, unsmoothed
 * arch-case-01 golden 261-anchor proposal (see
 * `MARGIN_SELF_INTERSECTION_TOLERANCE_MM`'s doc for why raw anchor jitter is
 * real and expected here) reaches a measured max discrete curvature of
 * 44.8mm^-1 at its own anchor spacing (0.02-0.4mm) — this is real-scan
 * ridge-walk noise, NOT genuine macroscopic margin curvature (a real
 * anatomical margin's own physical curvature radius is never anywhere near
 * 1/44.8 ~= 0.022mm), but it is an expected, harmless byproduct of the
 * walk's own per-vertex tracking (marginRidge.ts's module doc) that a
 * smoothness check must tolerate. 80mm^-1 sits comfortably above that
 * measured ceiling (~1.8x). Since curvature = angle/spacing DIVERGES as
 * spacing shrinks for any fixed nonzero turning angle, a deliberately bad,
 * densely-resampled zigzag (this task's own smoothness test — fine angular
 * spacing, small alternating radial offset) trivially clears this threshold
 * by a wide margin (measured >90mm^-1 at a modest 2000-point/0.02mm-
 * amplitude construction, see that test). **Documented, honest limitation**:
 * because a genuinely bad but COARSELY-spaced manual trace (a human
 * dragging a handful of mm-apart anchors into a jagged shape) is bounded by
 * `curvature <= pi / spacing_mm` even at a full point-reversal, this
 * threshold — calibrated to tolerate the real algorithm's own fine-grained
 * noise — is NOT guaranteed to catch a coarse manual zigzag (e.g. a handful
 * of anchors spaced >0.04mm apart could reverse direction completely
 * without reaching 80mm^-1). This is acceptable because smoothness is a
 * WARNING only (`classifyMarginValidation` never blocks confirm on it
 * alone) — self-intersection/on-surface/degenerate remain the reliable
 * HARD-failure catches for a genuinely malformed margin; a future revision
 * with more real-fixture noise data to calibrate against could tighten this
 * (e.g. a windowed/robust curvature estimate less sensitive to single-
 * vertex noise) without changing this file's report shape. */
export const MARGIN_SMOOTHNESS_CURVATURE_THRESHOLD_MM_INV = 80;

/** Minimum ambient polyline length (mm, summed over consecutive validated
 * points, wrapping if closed) below which a margin is reported degenerate
 * ("zero length", this task's brief) — distinct from, and much tighter
 * than, any clinically-plausible margin size: this is a "did every point
 * basically collapse onto the same spot" sanity floor (e.g. a bug that
 * places every anchor at the seed), not a "is this margin clinically too
 * small" clinical judgment (which belongs in clinical-profiles, per
 * CLAUDE.md, and is out of this validator's scope). Set to
 * `1000 * MESH_WELD_EPSILON_MM` (1e-3mm, 1 micron): far above coincident-
 * point float noise, far below even the smallest real anatomical feature. */
export const MARGIN_VALIDATE_ZERO_LENGTH_EPSILON_MM = 1000 * MESH_WELD_EPSILON_MM;

/** Minimum anchor count for a margin loop to be structurally meaningful —
 * mirrors `marginRidge.ts#simplifyRidgeLoopIndices`'s own "a spline/loop
 * needs >= 3 control points" floor. */
export const MARGIN_VALIDATE_MIN_ANCHOR_COUNT = 3;

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

/** One flagged non-adjacent segment-pair close approach — see this file's
 * module doc, "Self-intersection". `pointMm` is the midpoint of the two
 * segments' closest-approach points (a representative location for the
 * UI/report to highlight, not a mathematically exact "the" intersection
 * point — the two segments generally approach at slightly different points,
 * within `distanceMm` of each other by definition). */
export interface MarginSelfIntersectionLocation {
  segmentIndexA: number;
  segmentIndexB: number;
  pointMm: Vec3;
  distanceMm: number;
}

/** One validated point whose distance to the mesh surface exceeds
 * `MESH_WELD_EPSILON_MM` — see this file's module doc, "On-surface".
 * `index` is the point's position within whichever array was validated
 * (`margin.resampledPoints` if present, else `margin.anchors`). */
export interface MarginOffSurfacePoint {
  index: number;
  pointMm: Vec3;
  distanceMm: number;
}

/** One discrete-curvature outlier — see this file's module doc, "Smoothness
 * warnings". `index` is the point's position within the validated array
 * (same convention as `MarginOffSurfacePoint.index`); endpoints of an OPEN
 * curve are never flagged (no well-defined turning angle there — see
 * `computeSmoothnessWarnings`). */
export interface MarginSmoothnessWarning {
  index: number;
  pointMm: Vec3;
  curvatureMmInv: number;
}

/** Deterministic validation report for a `MarginLine` against the mesh it is
 * anchored to — see this file's module doc. Every field is computed
 * independently (no field's presence/absence depends on another field
 * short-circuiting the computation, EXCEPT where fewer than 2 validated
 * points exist at all — see `validateMarginLine`'s doc) — this is a REPORT,
 * not a gate: `classifyMarginValidation` (below) or a caller decides what,
 * if anything, to do with a `true` finding. */
export interface MarginValidationReport {
  /** Echoes `margin.closed` — a prep finish line is closed by definition
   * (margin/marginRidge.ts's own module doc); an open margin is a hard
   * failure for confirm purposes, decided by the caller/
   * `classifyMarginValidation`, not by this field's mere presence. */
  closed: boolean;
  selfIntersecting: boolean;
  selfIntersections: readonly MarginSelfIntersectionLocation[];
  onSurface: boolean;
  /** Max distance (mm) from any validated point to the mesh surface, over
   * every point checked — 0 if there were no points to check. */
  maxSurfaceDeviationMm: number;
  offSurfacePoints: readonly MarginOffSurfacePoint[];
  smoothnessWarnings: readonly MarginSmoothnessWarning[];
  degenerate: boolean;
  /** `'tooFewAnchors'` (`margin.anchors.length < MARGIN_VALIDATE_MIN_ANCHOR_COUNT`)
   * and/or `'zeroLength'` (validated-polyline length <
   * `MARGIN_VALIDATE_ZERO_LENGTH_EPSILON_MM`) — both may fire together
   * (e.g. 1 anchor is always both). Empty iff `degenerate` is `false`. */
  degenerateReasons: readonly ('tooFewAnchors' | 'zeroLength')[];
  /** How many points were actually validated (`margin.resampledPoints.length`
   * if present and non-empty, else `margin.anchors.length`) — surfaced for
   * diagnostics/perf reporting, not a finding itself. */
  validatedPointCount: number;
}

// ---------------------------------------------------------------------------
// Small local vector helpers — duplicated rather than shared, matching this
// package's established convention for tiny, domain-local math (see
// margin/marginRidge.ts's own `dist3`/`sub3`/`normalize3`/`dot3`).
// ---------------------------------------------------------------------------

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale3(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
function normalize3(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 0];
}
function midpoint3(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

// ---------------------------------------------------------------------------
// Point/segment selection
// ---------------------------------------------------------------------------

/** The polyline this validator actually checks — `margin.resampledPoints` if
 * present and non-empty, else `margin.anchors.map(a => a.position)` — see
 * this file's module doc for why (ambient positions, never re-derived from
 * `(triangleIndex, barycentric)`). */
function rawValidatedPoints(margin: MarginLineLike): readonly Vec3[] {
  if (margin.resampledPoints && margin.resampledPoints.length > 0) return margin.resampledPoints;
  return margin.anchors.map((a) => a.position);
}

/**
 * `rawValidatedPoints`, DEDUPLICATED of consecutive (within
 * `MESH_WELD_EPSILON_MM`) near-identical points, INCLUDING the closing
 * wraparound pair for a `closed` curve.
 *
 * **Why this is necessary — a real production shape, not a hypothetical**:
 * `MarginLine.resampledPoints` (shared-types), as ACTUALLY produced by
 * `apps/client/src/engine/marginEditor.ts`'s `flattenResampledPoints`, is
 * every committed segment's own point array CONCATENATED — and consecutive
 * segments share an anchor (`segment[i]`'s last point IS `segment[i+1]`'s
 * first point, `LiveMarginSegment`'s own "ENDPOINTS INCLUSIVE" doc) — so a
 * real, correctly-produced `resampledPoints` array has an EXACT duplicate
 * point at EVERY anchor boundary, by construction, always. Without this
 * dedup step, `computeSmoothnessWarnings`'s turning-angle formula would
 * compute a spurious, meaningless turn at every such boundary (a zero-
 * length "segment" to/from a duplicate point makes `normalize3` return the
 * zero vector for that half of the turn, and `acos(dot([0,0,0], other))`
 * evaluates to a fabricated ~90-degree "turn" that has nothing to do with
 * the curve's real shape there) — i.e. EVERY multi-segment real margin,
 * clean or not, would spuriously trip a smoothness warning at every single
 * anchor. Caught by validate.test.ts's dedicated
 * "concatenated-segments-with-duplicate-boundary-points" regression test
 * (constructed the same way `flattenResampledPoints` actually builds
 * `resampledPoints` in production) before this shipped — see that test for
 * the reproduction this fix addresses.
 */
function validatedPoints(margin: MarginLineLike): readonly Vec3[] {
  const raw = rawValidatedPoints(margin);
  if (raw.length === 0) return raw;
  const deduped: Vec3[] = [raw[0]!];
  for (let i = 1; i < raw.length; i++) {
    if (dist3(deduped[deduped.length - 1]!, raw[i]!) > MESH_WELD_EPSILON_MM) deduped.push(raw[i]!);
  }
  if (margin.closed && deduped.length > 1 && dist3(deduped[deduped.length - 1]!, deduped[0]!) <= MESH_WELD_EPSILON_MM) {
    deduped.pop(); // the closing wraparound pair is ALSO a duplicate boundary (last segment's end anchor === first anchor)
  }
  return deduped;
}

interface Segment {
  a: Vec3;
  b: Vec3;
}

/** Consecutive segments over `points`, plus the closing segment
 * (`points[last] -> points[0]`) iff `closed` and there are >= 2 points. */
function buildSegments(points: readonly Vec3[], closed: boolean): Segment[] {
  const segments: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    segments.push({ a: points[i]!, b: points[i + 1]! });
  }
  if (closed && points.length >= 2) {
    segments.push({ a: points[points.length - 1]!, b: points[0]! });
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Self-intersection: segment-segment closest approach
// ---------------------------------------------------------------------------

/** Closest-approach distance (and the two closest points) between finite 3D
 * segments `[p1,q1]` and `[p2,q2]` — the standard clamped-parametric
 * closed-form solution (Ericson, "Real-Time Collision Detection", section
 * 5.1.9, `ClosestPtSegmentSegment`), reproduced directly (not a library
 * import — same "small, well-established algorithm kept auditable in this
 * file" convention as `marginRidge.test-fixtures.ts`'s `filletCorner`).
 * Exact to Float64 rounding — no iteration. */
function closestPtSegmentSegment(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): { distance: number; c1: Vec3; c2: Vec3 } {
  const EPS = 1e-15;
  const d1 = sub3(q1, p1);
  const d2 = sub3(q2, p2);
  const r = sub3(p1, p2);
  const a = dot3(d1, d1);
  const e = dot3(d2, d2);
  const f = dot3(d2, r);

  let s: number;
  let t: number;

  if (a <= EPS && e <= EPS) {
    s = 0;
    t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = dot3(d1, r);
    if (e <= EPS) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = dot3(d1, d2);
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }

  const c1 = add3(p1, scale3(d1, s));
  const c2 = add3(p2, scale3(d2, t));
  return { distance: dist3(c1, c2), c1, c2 };
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}


/** Multiplier on `MARGIN_SELF_INTERSECTION_TOLERANCE_MM` giving a FIXED
 * (density- and segment-length-INDEPENDENT) arc-length window: a segment
 * pair separated by LESS than this much arc length along the curve is
 * excluded from self-intersection consideration entirely — see
 * `findSelfIntersections`'s doc for why a pure "not literally adjacent"
 * exclusion is insufficient, and why this window is deliberately FIXED
 * (not scaled by the pair's own local segment lengths — an earlier design
 * this task's report documents trying and rejecting).
 *
 * **Why fixed, not scaled by local segment length (the rejected design)**:
 * scaling by local segment length fixes a DENSE curve's false positives
 * (nearby, non-crossing points are naturally close — see this constant's
 * "why a window at all" case below) but BREAKS detection on a COARSE curve
 * (few, long segments — e.g. a small loop resampled at only 2-4 points per
 * edge): there, a genuine crossing pair's own arc separation can be
 * SMALLER than `K * their own (long) segment length`, so a real crossing
 * gets excluded too. MEASURED (this task's report): a 4-anchor bowtie
 * margin's real geodesic-path resampling (2-4 points per edge, ~1.7mm
 * individual segment lengths on a small synthetic fixture) has a genuine
 * ambient crossing at EXACTLY 0mm distance, arc-separated by ~1.73mm — a
 * length-scaled window (5x ~1.7mm ~= 8.8mm) excluded it entirely (a real
 * regression caught before this shipped, by
 * ui/MarginPanel.validation.dom.test.tsx's own ACCEPTANCE test, which
 * exercises the REAL geodesic-path-based `resampledPoints` shape, not a
 * hand-built straight-chord approximation of one).
 *
 * **Why a window at all (the case a fixed window still needs to handle)**:
 * a fine, evenly-resampled polyline (e.g. geodesic-interpolated segments as
 * `apps/client/src/engine/marginEditor.ts`'s `flattenResampledPoints`
 * actually produces for a densely-placed real margin) can have LOCAL point
 * spacing well under `MARGIN_SELF_INTERSECTION_TOLERANCE_MM` itself —
 * without SOME window, a sufficiently dense, perfectly clean margin would
 * spuriously self-intersect against itself, purely from nearby-in-
 * parameter points being nearby in ambient space (true of ANY smooth
 * curve, self-crossing or not) — caught by validate.test.ts's dedicated
 * dense-resampling regression test.
 *
 * 5x tolerance (0.075mm at the default 0.015mm tolerance): small relative
 * to a real margin loop's own scale (15-35mm circumference — this window
 * is well under 1% of that), so a genuine self-crossing (arcs separated by
 * a meaningful fraction of the loop) is never excluded, while still
 * comfortably covering realistic local resampling density (real mesh edge
 * lengths near a margin measured at 0.02-0.4mm — Phase 3 Task 4's own
 * report — a few hops of that scale stays under 0.075mm). */
const SELF_INTERSECTION_LOCALITY_WINDOW_MM_FACTOR = 5;

/** Cumulative arc length along `points` (NOT wrapped) — `prefix[i]` is the
 * distance from `points[0]` to `points[i]` walking forward through
 * `points[0..i]`; `total` additionally includes the closing
 * `points[last] -> points[0]` distance when `closed` (0 otherwise, since an
 * open curve has no "the other way around" arc). */
function cumulativeArcLength(points: readonly Vec3[], closed: boolean): { prefix: number[]; total: number } {
  const prefix: number[] = new Array(points.length).fill(0) as number[];
  for (let i = 1; i < points.length; i++) prefix[i] = prefix[i - 1]! + dist3(points[i - 1]!, points[i]!);
  const total = closed && points.length > 1 ? prefix[points.length - 1]! + dist3(points[points.length - 1]!, points[0]!) : 0;
  return { prefix, total };
}

/**
 * O(segmentCount^2) brute-force segment-pair scan, EXCLUDING pairs whose
 * separation ALONG THE CURVE (the GAP between the two segments' own arc
 * INTERVALS — see `intervalGap` — shortest of forward/backward around a
 * closed loop) is less than a FIXED window
 * (`SELF_INTERSECTION_LOCALITY_WINDOW_MM_FACTOR x toleranceMm`) — see that
 * constant's doc for why this window is density-INDEPENDENT (a fixed
 * distance, not scaled by the pair's own local segment lengths). Measuring
 * the GAP BETWEEN INTERVALS (not "segment start to segment start") is
 * essential: two literally-adjacent segments (sharing an endpoint) have
 * arc-INTERVAL gap exactly 0 (segment i's interval ENDS exactly where
 * segment i+1's interval STARTS) — always below any positive window, so
 * adjacency is still handled correctly by this same rule, with no separate
 * "or literally adjacent" special case needed. See this file's module doc,
 * "Self-intersection", for the ambient-tolerance/method derivation and its
 * honest ambient-vs-geodesic limits. Deliberately no broadphase/AABB
 * culling beyond the locality window itself: measured fast enough at real
 * margin-line vertex counts (this task's report — a few hundred segments at
 * most) without one; a much longer curve would need one, out of this
 * task's scope.
 */
function findSelfIntersections(
  points: readonly Vec3[],
  closed: boolean,
  toleranceMm: number,
): MarginSelfIntersectionLocation[] {
  const segments = buildSegments(points, closed);
  const n = segments.length;
  if (n === 0) return [];
  const { prefix, total } = cumulativeArcLength(points, closed);
  const window = SELF_INTERSECTION_LOCALITY_WINDOW_MM_FACTOR * toleranceMm;
  // Segment i's own arc INTERVAL `[intervalStart(i), intervalEnd(i)]` —
  // for a regular segment (`i < points.length - 1`, connecting
  // `points[i]` to `points[i+1]`) that's `[prefix[i], prefix[i+1]]`; the
  // CLOSING segment (`points[last] -> points[0]`, only present when
  // `closed`) is `[prefix[last], total]` (wrapping back to `points[0]`,
  // whose own position is `total`, one full lap around).
  const intervalStart = (i: number): number => (i < points.length - 1 ? prefix[i]! : prefix[points.length - 1]!);
  const intervalEnd = (i: number): number => (i < points.length - 1 ? prefix[i + 1]! : total);

  const hits: MarginSelfIntersectionLocation[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // `i < j` by construction, so `j`'s interval starts at/after `i`'s.
      const forward = Math.max(0, intervalStart(j) - intervalEnd(i));
      const backward = closed ? Math.max(0, total - intervalEnd(j) + intervalStart(i)) : Infinity;
      const separation = Math.min(forward, backward);
      if (separation < window) continue;
      const segA = segments[i]!;
      const segB = segments[j]!;
      const { distance, c1, c2 } = closestPtSegmentSegment(segA.a, segA.b, segB.a, segB.b);
      if (distance <= toleranceMm) {
        hits.push({ segmentIndexA: i, segmentIndexB: j, pointMm: midpoint3(c1, c2), distanceMm: distance });
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// On-surface
// ---------------------------------------------------------------------------

function checkOnSurface(
  mesh: IndexedMesh,
  bvh: Bvh,
  points: readonly Vec3[],
): { onSurface: boolean; maxSurfaceDeviationMm: number; offSurfacePoints: MarginOffSurfacePoint[] } {
  let maxSurfaceDeviationMm = 0;
  const offSurfacePoints: MarginOffSurfacePoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const { distance } = closestPoint(mesh, bvh, p);
    if (distance > maxSurfaceDeviationMm) maxSurfaceDeviationMm = distance;
    if (distance > MESH_WELD_EPSILON_MM) {
      offSurfacePoints.push({ index: i, pointMm: p, distanceMm: distance });
    }
  }
  return { onSurface: offSurfacePoints.length === 0, maxSurfaceDeviationMm, offSurfacePoints };
}

// ---------------------------------------------------------------------------
// Smoothness warnings
// ---------------------------------------------------------------------------

/** Turning angle (radians, `[0, pi]`) at `cur` between the incoming segment
 * (`prev -> cur`) and the outgoing segment (`cur -> next`) — same
 * construction as `marginRidge.ts#simplifyRidgeLoopIndices`'s `turnAngle`
 * (see this file's module doc). */
function turningAngleRad(prev: Vec3, cur: Vec3, next: Vec3): number {
  const inTangent = normalize3(sub3(cur, prev));
  const outTangent = normalize3(sub3(next, cur));
  const cosAngle = Math.max(-1, Math.min(1, dot3(inTangent, outTangent)));
  return Math.acos(cosAngle);
}

/** Discrete curvature (turning angle / local mean segment length) at every
 * INTERIOR point — for a closed curve every point is interior (wraps); for
 * an open curve the two endpoints have no well-defined turning angle and
 * are never flagged (matches `marginRidge.ts`'s own convention of only ever
 * computing turning angle at points with both a predecessor and a
 * successor). See this file's module doc, "Smoothness warnings", for the
 * threshold derivation. */
function computeSmoothnessWarnings(
  points: readonly Vec3[],
  closed: boolean,
  thresholdMmInv: number,
): MarginSmoothnessWarning[] {
  const n = points.length;
  if (n < 3) return [];
  const warnings: MarginSmoothnessWarning[] = [];
  const start = closed ? 0 : 1;
  const end = closed ? n : n - 1;
  for (let i = start; i < end; i++) {
    const prevIdx = closed ? (i - 1 + n) % n : i - 1;
    const nextIdx = closed ? (i + 1) % n : i + 1;
    const prev = points[prevIdx]!;
    const cur = points[i]!;
    const next = points[nextIdx]!;
    const inLen = dist3(prev, cur);
    const outLen = dist3(cur, next);
    const avgLen = (inLen + outLen) / 2;
    if (avgLen <= MESH_WELD_EPSILON_MM) continue; // coincident points — not a curvature question (degenerate/self-intersection territory instead)
    const angle = turningAngleRad(prev, cur, next);
    const curvatureMmInv = angle / avgLen;
    if (curvatureMmInv > thresholdMmInv) {
      warnings.push({ index: i, pointMm: cur, curvatureMmInv });
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Degenerate
// ---------------------------------------------------------------------------

function checkDegenerate(
  margin: MarginLineLike,
  points: readonly Vec3[],
  closed: boolean,
): { degenerate: boolean; degenerateReasons: ('tooFewAnchors' | 'zeroLength')[] } {
  const reasons: ('tooFewAnchors' | 'zeroLength')[] = [];
  if (margin.anchors.length < MARGIN_VALIDATE_MIN_ANCHOR_COUNT) reasons.push('tooFewAnchors');
  const segments = buildSegments(points, closed);
  let totalLengthMm = 0;
  for (const seg of segments) totalLengthMm += dist3(seg.a, seg.b);
  if (totalLengthMm < MARGIN_VALIDATE_ZERO_LENGTH_EPSILON_MM) reasons.push('zeroLength');
  return { degenerate: reasons.length > 0, degenerateReasons: reasons };
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

export interface ValidateMarginLineOptions {
  /** Default `MARGIN_SELF_INTERSECTION_TOLERANCE_MM`. */
  selfIntersectionToleranceMm?: number;
  /** Default `MARGIN_SMOOTHNESS_CURVATURE_THRESHOLD_MM_INV`. */
  smoothnessCurvatureThresholdMmInv?: number;
}

/**
 * Validates `margin` against `mesh`/`bvh` — see this file's module doc for
 * the method, the deliberate "ambient position, never re-derived" point
 * selection, and each check's own documented tolerance/threshold. Pure,
 * deterministic, NEVER throws (a validation "REPORTS", per this task's
 * brief — the caller/`classifyMarginValidation` decides what a `true`
 * finding means for whatever action it's gating).
 *
 * Every field is computed independently over `validatedPoints(margin)` —
 * including when that set is degenerate (0 or 1 points): self-intersection
 * and smoothness naturally report no findings (nothing to compare), on-
 * surface checks whatever points DO exist, and `degenerate` reports the
 * reason. There is no early-return "skip everything else once degenerate is
 * detected" — a caller inspecting `offSurfacePoints` on an otherwise-
 * degenerate margin still gets a real answer, not a placeholder.
 */
export function validateMarginLine(mesh: IndexedMesh, bvh: Bvh, margin: MarginLineLike, opts: ValidateMarginLineOptions = {}): MarginValidationReport {
  const selfIntersectionToleranceMm = opts.selfIntersectionToleranceMm ?? MARGIN_SELF_INTERSECTION_TOLERANCE_MM;
  const smoothnessCurvatureThresholdMmInv = opts.smoothnessCurvatureThresholdMmInv ?? MARGIN_SMOOTHNESS_CURVATURE_THRESHOLD_MM_INV;

  const points = validatedPoints(margin);
  const closed = margin.closed;

  const selfIntersections = findSelfIntersections(points, closed, selfIntersectionToleranceMm);
  const { onSurface, maxSurfaceDeviationMm, offSurfacePoints } = checkOnSurface(mesh, bvh, points);
  const smoothnessWarnings = computeSmoothnessWarnings(points, closed, smoothnessCurvatureThresholdMmInv);
  const { degenerate, degenerateReasons } = checkDegenerate(margin, points, closed);

  return {
    closed,
    selfIntersecting: selfIntersections.length > 0,
    selfIntersections,
    onSurface,
    maxSurfaceDeviationMm,
    offSurfacePoints,
    smoothnessWarnings,
    degenerate,
    degenerateReasons,
    validatedPointCount: points.length,
  };
}

// ---------------------------------------------------------------------------
// Classification (still a REPORT, not an action — see this file's module doc)
// ---------------------------------------------------------------------------

export type MarginValidationHardFailureKind = 'open' | 'selfIntersecting' | 'offSurface' | 'degenerate';

export interface MarginValidationClassification {
  /** Empty iff the margin can be confirmed outright. */
  hardFailureKinds: readonly MarginValidationHardFailureKind[];
  hasWarnings: boolean;
  /** `true` iff `hardFailureKinds` is non-empty — confirm must be blocked. */
  blocked: boolean;
}

/**
 * Buckets a `MarginValidationReport` into hard-failure kinds (per CLAUDE.md
 * gate semantics: "block confirm") vs. warnings (acknowledgeable) — per this
 * task's brief: "hard failures (open when closed required, self-
 * intersecting, off-surface, degenerate) BLOCK confirm"; smoothness
 * findings are the only WARNING-class finding today. This is still
 * classification/reporting, not an action — `apps/client/src/engine/
 * marginEditor.ts`'s `confirmMargin` is what actually enforces it (decides
 * whether to journal a confirm, requires acknowledgement, etc.).
 */
export function classifyMarginValidation(report: MarginValidationReport): MarginValidationClassification {
  const hardFailureKinds: MarginValidationHardFailureKind[] = [];
  if (!report.closed) hardFailureKinds.push('open');
  if (report.selfIntersecting) hardFailureKinds.push('selfIntersecting');
  if (!report.onSurface) hardFailureKinds.push('offSurface');
  if (report.degenerate) hardFailureKinds.push('degenerate');
  return {
    hardFailureKinds,
    hasWarnings: report.smoothnessWarnings.length > 0,
    blocked: hardFailureKinds.length > 0,
  };
}
