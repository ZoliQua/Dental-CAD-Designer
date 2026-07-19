// packages/kernel/src/spline/surfaceSpline.ts
//
// Phase 2 Task 5, deliverables 2 & 3: the margin-line data structure Phase 3
// edits interactively — a centripetal Catmull-Rom spline (catmullRom.ts)
// whose control points AND every resampled point are constrained to lie on
// a mesh surface (BVH `closestPoint`), fitted/refitted with the SAME per-
// control-point locality guarantee `catmullRom.ts`'s `affectedSpanIndices`
// establishes for the pure ambient math (`refitSurfaceSplineControlPoint`
// below — mirrors `geodesic/snapPolyline.ts`'s `resnapPolylineAnchor`
// locality pattern closely, deliberately, for a familiar shape to Phase 3
// callers already using that API).
//
// ## Density (points-per-mm) — clinical guidance (this task's guardrails)
//
// Clinical margin lines run ~20-40mm circumference. Phase 3 wants ~0.05-
// 0.1mm sampling, i.e. `pointsPerMm` in [10, 20] — a 30mm margin line at
// that density produces 300-600 total points across every span, comfortably
// inside the "400-800 samples stays interactive" guardrail (see this
// module's perf test, kernel-workers/splineJobs.test.ts, for measured
// timing on the real upperjaw fixture).
//
// ## Surface-projection algorithm (deliverable 2): iterative re-projection
//
// For each span, independently (see "Locality" below for why per-span, not
// global):
//  1. Evaluate the pure AMBIENT Catmull-Rom span (catmullRom.ts's
//     `resampleCatmullRomSpan`) through the span's 4 role control points'
//     already-on-surface ambient positions — this is the smooth curve
//     SHAPE, evaluated in free 3D space, which can (and generally does)
//     drift off the piecewise-linear mesh surface between its anchor
//     control points (a smooth interpolant through on-surface points is not
//     itself on-surface in between them, exactly analogous to a straight
//     chord vs. a curved arc — just in 3D against an arbitrary
//     triangulation instead of against a single circle).
//  2. Project every point of that ambient polyline onto the mesh (BVH
//     `closestPoint`) — see `@errorBound` below for what this guarantees.
//  3. ITERATE: because projection moves points, the resulting ON-SURFACE
//     polyline's point spacing has drifted away from the even arc-length
//     spacing step 1 targeted (a concave surface region pulls points closer
//     together where the ambient curve bulged away from it; a convex region
//     spreads them apart). Each further iteration re-resamples the CURRENT
//     (already on-surface, piecewise-LINEAR) polyline evenly by arc length
//     — trivial exact interpolation along straight segments, no smooth-curve
//     re-evaluation needed once step 1's shape has been captured — then
//     re-projects. This repeats until the polyline's total length changes
//     by less than `relativeTolerance` between iterations (genuine
//     convergence) or `maxIterations` is reached (hang-guard cap) — the
//     SAME `iterations`/`converged` shape `geodesic/geodesicPath.ts`'s
//     widening loop already establishes for this codebase, deliberately
//     reused here for a familiar contract. Unlike that loop (whose length
//     sequence is provably non-increasing by construction), THIS loop's
//     length can move in either direction between iterations (a surface can
//     pull a resampled point either closer to or farther from its
//     neighbors depending on local curvature sign) — so convergence is
//     checked on the ABSOLUTE relative change, not a one-directional
//     "still shrinking" test.
//
// ## @errorBound (max off-surface distance)
//
// Two DIFFERENT distances matter here — this module's earlier draft
// conflated them under one name (`maxOffSurfaceDistanceMm`) and its own
// tests caught the mistake (a >1mm "off-surface distance" that should have
// been ~0 by construction — see catmullRom.ts's sibling doc for this
// project's convention of documenting a caught mistake rather than quietly
// fixing it), so they are now named and reported separately:
//
// 1. **Off-surface distance of a RETURNED point** (what "the final curve
//    lies on-surface" literally means). EVERY point this module ever
//    returns — every control point and every span's resampled point — is
//    the direct output of a BVH `closestPoint` call (`surfacePoint.ts`'s
//    `snapToSurface`/`surfacePointFromClosestPoint`), i.e. a point ON an
//    actual mesh triangle by construction (`closestPointOnTriangle`'s
//    Voronoi-region projection, bvh/geometry.ts). This distance is
//    therefore not an approximation to bound — it IS (up to IEEE754 double
//    rounding in the projection arithmetic itself, ~1e-15 relative to the
//    mesh's coordinate magnitude) zero, for every returned point, always.
//    Not stored as a field (a field that is always ~0 by construction is
//    not a useful diagnostic) — verified directly in
//    surfaceSpline.test.ts's `@errorBound` suite by re-querying
//    `closestPoint` on each returned point's own evaluated position and
//    asserting the result is `<= MESH_WELD_EPSILON_MM` (the project's
//    1e-6mm weld tolerance — intake/weld.ts), i.e. floating-point noise,
//    exactly this task's brief's "assert <= weld-epsilon x documented
//    factor" (factor = 1 here — the bound is not just tight, it is exact
//    up to rounding).
// 2. **`maxAmbientDeviationMm`** (per span and aggregated on the whole
//    `SurfaceSpline` — a genuinely useful, and genuinely NOT tiny,
//    diagnostic): how far the PRE-projection ambient Catmull-Rom sample
//    point (step 1 of the algorithm above) was from the surface before
//    step 2 pulled it back on — i.e. how hard the surface constraint had
//    to work at that point. This is expected to be on the order of the
//    local mesh feature size / curvature radius for a spline whose control
//    points bow away from the surface between anchors, NOT weld-epsilon —
//    see surfaceSpline.test.ts's icosphere test for a measured example.
//    Surfaced per CLAUDE.md ("error bound surfaced in results") as a QC-
//    relevant signal: a large `maxAmbientDeviationMm` on a real margin line
//    is a sign the control points are too sparse for the local anatomy
//    (consider mitigation 1 below), NOT a sign of an off-surface bug.
//
// The bound that DOES require real derivation (per this task's guardrails:
// "the honest bound relates to where evaluated points land vs facets") is a
// THIRD quantity this module does NOT claim to bound tightly: the deviation
// of the STRAIGHT CHORD connecting two consecutive on-surface output points
// from the mesh surface IN BETWEEN them (since a caller that renders/
// measures this spline as a polyline is implicitly relying on those chords,
// not just the vertices, staying close to the surface). That deviation is a
// function of local mesh curvature and the density (`pointsPerMm`) —
// exactly analogous to `geodesicPath.ts`'s tessellation `@errorBound`, but
// for the SPLINE's own resampling spacing on top of the mesh's
// tessellation, compounding both. This module does not compute or assert a
// closed-form bound on it (would require carrying local curvature estimates
// through every span — YAGNI for this task; `curvature/` already exists as
// the building block a future task could use). Two DOCUMENTED mitigations
// are available to a caller who needs a tighter guarantee than "every
// VERTEX is exactly on-surface":
//  1. Increase `pointsPerMm` in high-curvature margin regions (smaller
//     chords deviate less — see the density-convergence property test,
//     catmullRom.test.ts, for the measured relationship between density and
//     accuracy for the pure ambient curve, which composes with mesh
//     curvature here).
//  2. Use `geodesic/snapPolylineGeodesic` (Phase 2 Task 4) directly between
//     this module's CONTROL POINTS instead of this module's straight-chord
//     resampled spans, for an EXACT on-surface path between anchors (no
//     chord-deviation question at all, at the cost of losing the smooth
//     Catmull-Rom shape between them — a geodesic is the shortest path, not
//     a curvature-continuous interpolant). This module's control-point
//     projection step is deliberately factored so a caller can do exactly
//     this (`spline.controlPoints` is already an ordered `SurfacePoint[]`,
//     the exact input shape `snapPolylineGeodesic`'s pre-projected-anchor
//     variant expects) — see this file's bottom doc, "Geodesic-snapped
//     mode (left as a seam, not implemented)".
//
// ## Locality (deliverable 3)
//
// `refitSurfaceSplineControlPoint` moves exactly one control point and
// recomputes ONLY the (up to 4) spans `catmullRom.ts`'s
// `affectedSpanIndices` identifies as touching it — every other span is
// carried over as the exact SAME object reference (`===`), never
// recomputed. This is WHY resampling is done PER SPAN (this file's
// algorithm doc above) rather than as one global arc-length pass over the
// whole curve: a global pass's point PLACEMENTS all depend on the total
// curve length, so moving one control point would shift every subsequent
// point's position even in untouched spans, defeating locality entirely.
// The tradeoff (documented, accepted): point spacing is only guaranteed
// even WITHIN a span, not perfectly uniform exactly at a span boundary —
// see surfaceSpline.test.ts's locality test for the `===`-identity
// assertion this guarantees, matching `geodesic/snapPolyline.ts`'s
// `resnapPolylineAnchor` test's exact same assertion style.
//
// ## Geodesic-snapped mode (left as a seam, not implemented — this task's
// guardrails: "OPTIONAL this task if projection meets tolerance... the API
// should leave room")
//
// This module's control points are plain `SurfacePoint[]`
// (`SurfaceSpline.controlPoints`) — the exact shape `geodesic/
// snapPolylineGeodesic` needs as pre-projected anchors. A future
// `fitGeodesicMarginLine`-style sibling function (Phase 3's call, per this
// task's guardrails) can call `snapPolylineGeodesic`/`resnapPolylineAnchor`
// directly on THIS module's `controlPoints`, entirely independent of this
// file's straight-chord span resampling — no changes to this module's types
// are needed to add it later; the two modes share only the "control points
// are on-surface anchors" convention, not any span-shaped data.
import type { Vec3 } from '../bvh/geometry.ts';
import { closestPoint } from '../bvh/closestPoint.ts';
import type { Bvh } from '../bvh/types.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { evaluateSurfacePoint, snapToSurface, surfacePointFromClosestPoint } from '../geodesic/surfacePoint.ts';
import type { SurfacePoint } from '../geodesic/types.ts';
import {
  affectedSpanIndices,
  polylineLength,
  resampleCatmullRomSpan,
  spanCountOf,
  spanRole,
  validateControlPoints,
} from './catmullRom.ts';

/** Hard cap on per-span re-projection passes — mirrors
 * `geodesic/geodesicPath.ts`'s `GEODESIC_MAX_ITERATIONS` (same hang-guard
 * role: a pathological mesh/spline combination could in principle oscillate
 * rather than settle). */
export const SURFACE_SPLINE_MAX_ITERATIONS = 8;
/** Relative arc-length change below which a span's re-projection loop is
 * treated as converged — mirrors `geodesic/geodesicPath.ts`'s
 * `GEODESIC_REL_TOL`. */
export const SURFACE_SPLINE_REL_TOL = 1e-9;

export interface SurfaceSplineOptions {
  maxIterations?: number;
  relativeTolerance?: number;
}

/** One resampled, on-surface span of a `SurfaceSpline` — see this module's
 * top doc for the iterative re-projection algorithm and `@errorBound`. */
export interface SurfaceSplineSpan {
  /** Evenly (within this span) arc-length-spaced on-surface points.
   * `points[0]` is the exact SAME `SurfacePoint` object as this span's start
   * control point (`SurfaceSpline.controlPoints[i]`); `points[last]` is the
   * exact same object as the end control point (`controlPoints[i+1]`,
   * wrapped for closed) — shared by reference, not just equal by value (see
   * `catmullRom.ts`'s `evenlySpacedPoints` doc for why float round-trip
   * equality isn't trusted at span boundaries). */
  readonly points: readonly SurfacePoint[];
  /** On-surface straight-chord polyline length (mm) — sum of consecutive
   * `evaluateSurfacePoint` distances over `points`. */
  readonly length: number;
  /** Pure ambient (pre-projection) Catmull-Rom arc-length estimate for this
   * span (catmullRom.ts's `CatmullRomSpan.ambientLength`) — the density
   * target `points`'s count was originally computed against; diagnostic
   * only (surfaced since it's a meaningful "how much did projection change
   * this span's length" comparison against `length` above). */
  readonly ambientLength: number;
  /** Re-projection passes actually performed — see this module's "Iterate"
   * doc. Always ≥ 1: the convergence check compares consecutive passes, so
   * even a span whose first projection already meets `relativeTolerance`
   * reports 1 (the pass that confirmed it). NOTE this is the OPPOSITE
   * counting convention from `geodesic/types.ts`'s `GeodesicPathResult.
   * iterations` (0 if the very first pass was already locally taut) — the
   * two fields are not directly comparable despite the similar name; only
   * `converged`'s PASS/FAIL semantics (below) match across the two
   * modules. */
  readonly iterations: number;
  /** `true` if re-projection genuinely converged (relative length change
   * below tolerance on some pass, or nothing left to project — e.g. a
   * 2-point span with no interior points), `false` only if `maxIterations`
   * fired first (best-effort result, not verified stable) — same semantics
   * as `geodesic/types.ts`'s `GeodesicPathResult.converged`. */
  readonly converged: boolean;
  /** How far the pre-projection AMBIENT sample point (this span's smooth
   * Catmull-Rom curve, before being pulled onto the surface) was from the
   * mesh, maximized over every projection this span's fit performed
   * (including intermediate iterations) — NOT the off-surface distance of
   * the RETURNED `points` (which is ~0 by construction — see this module's
   * `@errorBound` doc, item 1, for that separate guarantee). This is
   * legitimately non-tiny for a span whose control points bow away from the
   * surface. */
  readonly maxAmbientDeviationMm: number;
}

/** A cubic spline lying on a mesh surface — the fitted/refit result this
 * task's brief calls "the margin-line data structure Phase 3 edits
 * interactively". See `marginLine.ts` for the (documented, lossy in one
 * direction) adapter to/from shared-types' `MarginLine`. */
export interface SurfaceSpline {
  /** On-surface control points, in order — each the direct BVH projection
   * of the corresponding input ambient point (`fitSurfaceSpline`) or, after
   * a `refitSurfaceSplineControlPoint` call, of that call's `newPoint`. */
  readonly controlPoints: readonly SurfacePoint[];
  readonly closed: boolean;
  /** Density this spline was (most recently, per-span — see
   * `resampleSurfaceSpline`) resampled at. */
  readonly pointsPerMm: number;
  /** `spanCountOf(controlPoints.length, closed)` entries. */
  readonly spans: readonly SurfaceSplineSpan[];
  /** `true` only if EVERY span converged — same aggregate-convenience
   * pattern as `geodesic/snapPolyline.ts`'s `SnappedPolyline.converged`. */
  readonly converged: boolean;
  /** Max of every span's `maxAmbientDeviationMm`. */
  readonly maxAmbientDeviationMm: number;
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Evenly-by-arc-length resample of an ALREADY on-surface (piecewise
 * LINEAR) polyline — the "re-resample the current on-surface polyline"
 * half of this module's iterative re-projection loop (top doc, step 3):
 * exact interpolation along straight segments, no smooth-curve evaluation
 * needed once the ambient ANGLE/shape has already been captured by the
 * first (catmullRom.ts) evaluation pass. */
function resamplePolylineEvenly(positions: readonly Vec3[], pointCount: number): Vec3[] {
  const cumulative: number[] = [0];
  let total = 0;
  for (let i = 1; i < positions.length; i++) {
    total += dist(positions[i - 1]!, positions[i]!);
    cumulative.push(total);
  }
  const out: Vec3[] = new Array(pointCount);
  const lastIndex = positions.length - 1;
  for (let k = 0; k < pointCount; k++) {
    const targetLength = pointCount === 1 ? 0 : (total * k) / (pointCount - 1);
    let i = 0;
    while (i < lastIndex && cumulative[i + 1]! < targetLength) i++;
    const segStart = cumulative[i]!;
    const segEnd = cumulative[Math.min(i + 1, lastIndex)]!;
    const frac = segEnd > segStart ? (targetLength - segStart) / (segEnd - segStart) : 0;
    const a = positions[i]!;
    const b = positions[Math.min(i + 1, lastIndex)]!;
    out[k] = [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac, a[2] + (b[2] - a[2]) * frac];
  }
  return out;
}

/**
 * Fits/refits ONE span, given its 4 ambient role points (already-on-surface
 * neighbor/endpoint positions — `catmullRom.ts`'s `spanRole`) and the exact
 * `SurfacePoint` objects for its own start/end control points (reused
 * directly at `points[0]`/`points[last]` — see `SurfaceSplineSpan.points`'s
 * doc). This is the single primitive BOTH `fitSurfaceSpline` (whole-curve)
 * and `refitSurfaceSplineControlPoint` (locality — deliverable 3) call,
 * exactly the same way `geodesic/snapPolyline.ts` shares one
 * `geodesicPath` call between its whole-polyline and single-anchor-move
 * entry points.
 */
export function fitSurfaceSplineSpan(
  mesh: IndexedMesh,
  bvh: Bvh,
  role: readonly [Vec3, Vec3, Vec3, Vec3],
  startPoint: SurfacePoint,
  endPoint: SurfacePoint,
  pointsPerMm: number,
  options: SurfaceSplineOptions = {},
): SurfaceSplineSpan {
  const maxIterations = options.maxIterations ?? SURFACE_SPLINE_MAX_ITERATIONS;
  const relTol = options.relativeTolerance ?? SURFACE_SPLINE_REL_TOL;

  const ambient = resampleCatmullRomSpan(role, pointsPerMm);
  const pointCount = ambient.points.length;

  let currentPositions: Vec3[] = ambient.points.slice();
  currentPositions[0] = evaluateSurfacePoint(mesh, startPoint);
  currentPositions[pointCount - 1] = evaluateSurfacePoint(mesh, endPoint);

  let projected: SurfacePoint[] = [];
  let projectedPositions: Vec3[] = [];
  let maxAmbientDeviationMm = 0;
  let prevLength = Infinity;
  let iterations = 0;
  let converged = false;

  for (let iter = 0; iter <= maxIterations; iter++) {
    projected = new Array(pointCount);
    projectedPositions = new Array(pointCount);
    for (let k = 0; k < pointCount; k++) {
      if (k === 0) {
        projected[k] = startPoint;
        projectedPositions[k] = evaluateSurfacePoint(mesh, startPoint);
        continue;
      }
      if (k === pointCount - 1) {
        projected[k] = endPoint;
        projectedPositions[k] = evaluateSurfacePoint(mesh, endPoint);
        continue;
      }
      const cp = closestPoint(mesh, bvh, currentPositions[k]!);
      maxAmbientDeviationMm = Math.max(maxAmbientDeviationMm, cp.distance);
      projected[k] = surfacePointFromClosestPoint(cp);
      projectedPositions[k] = cp.point;
    }

    const newLength = polylineLength(projectedPositions);
    iterations = iter;
    const relChange = Math.abs(prevLength - newLength) / Math.max(prevLength, 1e-12);
    if (iter > 0 && relChange < relTol) {
      converged = true;
      break;
    }
    prevLength = newLength;
    if (iter === maxIterations) break; // hang-guard cap; `converged` stays false

    currentPositions = pointCount <= 2 ? projectedPositions : resamplePolylineEvenly(projectedPositions, pointCount);
  }

  return {
    points: projected,
    length: polylineLength(projectedPositions),
    ambientLength: ambient.ambientLength,
    iterations,
    converged,
    maxAmbientDeviationMm,
  };
}

function aggregateConverged(spans: readonly SurfaceSplineSpan[]): boolean {
  return spans.every((s) => s.converged);
}

function aggregateMaxAmbientDeviation(spans: readonly SurfaceSplineSpan[]): number {
  return spans.reduce((max, s) => Math.max(max, s.maxAmbientDeviationMm), 0);
}

/**
 * Deliverable 2's top-level entry point: projects `points` onto `mesh`'s
 * surface (BVH `closestPoint`) as the spline's control points, then fits
 * and iteratively re-projects every span (this module's top doc) at
 * `pointsPerMm` density.
 *
 * @throws {RangeError} via `validateControlPoints` (topology/finiteness/
 * near-duplicate checks — applied to the AMBIENT `points`, before
 * projection) or if `pointsPerMm` is not finite and > 0.
 */
export function fitSurfaceSpline(
  mesh: IndexedMesh,
  bvh: Bvh,
  points: readonly Vec3[],
  closed: boolean,
  pointsPerMm: number,
  options: SurfaceSplineOptions = {},
): SurfaceSpline {
  validateControlPoints(points, closed);
  if (!(Number.isFinite(pointsPerMm) && pointsPerMm > 0)) {
    throw new RangeError(`fitSurfaceSpline: pointsPerMm must be finite and > 0, got ${pointsPerMm}`);
  }
  const controlPoints = points.map((p) => snapToSurface(mesh, bvh, p));
  return fitSpansFromControlPoints(mesh, bvh, controlPoints, closed, pointsPerMm, options);
}

function fitSpansFromControlPoints(
  mesh: IndexedMesh,
  bvh: Bvh,
  controlPoints: readonly SurfacePoint[],
  closed: boolean,
  pointsPerMm: number,
  options: SurfaceSplineOptions,
): SurfaceSpline {
  const ambientPositions = controlPoints.map((sp) => evaluateSurfacePoint(mesh, sp));
  const spanCount = spanCountOf(controlPoints.length, closed);
  const spans: SurfaceSplineSpan[] = new Array(spanCount);
  for (let i = 0; i < spanCount; i++) {
    const role = spanRole(ambientPositions, i, closed);
    const startPoint = controlPoints[i]!;
    const endPoint = controlPoints[closed ? (i + 1) % controlPoints.length : i + 1]!;
    spans[i] = fitSurfaceSplineSpan(mesh, bvh, role, startPoint, endPoint, pointsPerMm, options);
  }
  return {
    controlPoints,
    closed,
    pointsPerMm,
    spans,
    converged: aggregateConverged(spans),
    maxAmbientDeviationMm: aggregateMaxAmbientDeviation(spans),
  };
}

/**
 * Deliverable 3: moves `spline.controlPoints[index]` to `newPoint`
 * (re-projected onto `mesh`'s surface) and recomputes ONLY the spans
 * `catmullRom.ts`'s `affectedSpanIndices` identifies as touching it — every
 * other span is the exact SAME object reference as in `spline.spans` (see
 * this module's "Locality" doc). `spline` itself is never mutated.
 *
 * @throws {RangeError} if `index` is out of range for `spline.controlPoints`.
 */
export function refitSurfaceSplineControlPoint(
  mesh: IndexedMesh,
  bvh: Bvh,
  spline: SurfaceSpline,
  index: number,
  newPoint: Vec3,
  options: SurfaceSplineOptions = {},
): SurfaceSpline {
  if (index < 0 || index >= spline.controlPoints.length || !Number.isInteger(index)) {
    throw new RangeError(
      `refitSurfaceSplineControlPoint: index ${index} out of range for a spline with ${spline.controlPoints.length} control points`,
    );
  }

  const controlPoints = spline.controlPoints.slice();
  controlPoints[index] = snapToSurface(mesh, bvh, newPoint);
  const ambientPositions = controlPoints.map((sp) => evaluateSurfacePoint(mesh, sp));

  const spans = spline.spans.slice();
  const touched = affectedSpanIndices(controlPoints.length, spline.closed, index);
  for (const i of touched) {
    const role = spanRole(ambientPositions, i, spline.closed);
    const startPoint = controlPoints[i]!;
    const endPoint = controlPoints[spline.closed ? (i + 1) % controlPoints.length : i + 1]!;
    spans[i] = fitSurfaceSplineSpan(mesh, bvh, role, startPoint, endPoint, spline.pointsPerMm, options);
  }

  return {
    controlPoints,
    closed: spline.closed,
    pointsPerMm: spline.pointsPerMm,
    spans,
    converged: aggregateConverged(spans),
    maxAmbientDeviationMm: aggregateMaxAmbientDeviation(spans),
  };
}

/**
 * Re-resamples EVERY span of `spline` at a new `pointsPerMm` density,
 * reusing its EXISTING (already-projected) `controlPoints` — no re-
 * projection of control points, since they haven't moved. Deliberately NOT
 * local (a density change legitimately affects every span, unlike a single
 * control-point move — see this module's "Locality" doc, which only ever
 * claims locality for `refitSurfaceSplineControlPoint`). `spline` itself is
 * never mutated.
 */
export function resampleSurfaceSpline(
  mesh: IndexedMesh,
  bvh: Bvh,
  spline: SurfaceSpline,
  pointsPerMm: number,
  options: SurfaceSplineOptions = {},
): SurfaceSpline {
  if (!(Number.isFinite(pointsPerMm) && pointsPerMm > 0)) {
    throw new RangeError(`resampleSurfaceSpline: pointsPerMm must be finite and > 0, got ${pointsPerMm}`);
  }
  return fitSpansFromControlPoints(mesh, bvh, spline.controlPoints, spline.closed, pointsPerMm, options);
}
