// packages/kernel/src/spline/catmullRom.ts
//
// Phase 2 Task 5 (docs/plans/phase-2-kernel-core.md), deliverable 1: cubic
// spline through ordered control points — pure AMBIENT-SPACE math, no mesh,
// no BVH. `surfaceSpline.ts` (deliverable 2) layers surface projection on
// top of this module; every function here is a plain function of Vec3
// arrays only, directly testable without a mesh fixture (see
// catmullRom.test.ts's analytic great-circle / planar-square tests).
//
// ## Method: CENTRIPETAL Catmull-Rom via the Barry-Goldman recursive
// construction (alpha = 0.5)
//
// Catmull-Rom (not a solved-globally natural cubic spline) was chosen for
// two independent reasons, both load-bearing for this task's brief:
//
// 1. **No cusps/self-intersections within a segment for reasonable control
//    polygons.** The UNIFORM parametrization (equal knot spacing regardless
//    of control-point spacing) is well known to produce loops/cusps when
//    consecutive control points are very unevenly spaced (a classic
//    Catmull-Rom failure mode). CENTRIPETAL parametrization (Yuksel,
//    Schaefer & Keyser, "Parameterization and Applications of Catmull-Rom
//    Curves", 2011) — knot spacing `dt_i = |P_{i+1} - P_i|^alpha` with
//    `alpha = 0.5` — is proven in that paper to never produce a cusp or
//    self-intersection within a single segment, for ANY four control
//    points, unlike alpha=0 (uniform, cusps common) or alpha=1 (chordal,
//    can still self-intersect for sharp turns). alpha=0.5 is also the
//    standard choice cited by every subsequent production use of this
//    technique (this project follows that consensus rather than inventing
//    its own alpha).
// 2. **Locality — moving ONE control point recomputes only a BOUNDED number
//    of spans (this task's brief, deliverable 3; Phase 3 interactivity
//    depends on it).** Catmull-Rom's defining property is that each span
//    (the curve between control points `P_i` and `P_{i+1}`) is evaluated
//    from EXACTLY 4 control points: `P_{i-1}, P_i, P_{i+1}, P_{i+2}` (or
//    their open-curve reflection / closed-curve wrap — see `spanRole`
//    below). A GLOBALLY-solved spline (e.g. the classic "natural cubic
//    spline", which solves a tridiagonal system coupling every control
//    point at once) does NOT have this property: moving one control point
//    changes the tridiagonal solve's right-hand side everywhere, so EVERY
//    span's shape changes, even far from the moved point. Catmull-Rom's
//    per-span 4-point locality is exactly what makes `affectedSpanIndices`
//    (below) a small, bounded set (<= 4 spans) rather than "the whole
//    curve" — this is the primary reason Catmull-Rom (over a natural cubic
//    spline) was chosen for this task, not just cusp-avoidance.
//
// The actual per-span evaluation uses the BARRY & GOLDMAN recursive
// algorithm ("A Recursive Evaluation Algorithm for a Class of Catmull-Rom
// Splines", SIGGRAPH 1988): 6 nested linear interpolations (`lerpVec3`
// below) parametrized by the 4 role points' REAL (not renormalized-to-[0,1])
// centripetal knot values `t0 < t1 < t2 < t3`. This is the textbook
// reference construction (not a from-scratch tangent-formula reimplementation
// — an earlier draft of this module tried a closed-form Hermite/tangent
// shortcut and found BY DIRECT NUMERIC CHECK that it did not reproduce a
// single-valued tangent at a shared knot for non-uniform (unequal
// consecutive-distance) control points, i.e. it was only G1, not truly C1;
// Barry-Goldman's construction evaluates every span in one shared,
// consistently-scaled real-parameter frame and is the construction actually
// proven C1 at interior knots in the literature — see catmullRom.test.ts's
// closed-seam C1 test, which verifies this numerically for THIS
// implementation specifically, per this task's brief: "C1 verified
// numerically").
//
// ## Determinism
//
// Every function here is a pure function of its Vec3 array inputs — no
// `Math.random`/`Date.now`. Arc-length integration and inversion
// (`integrateArcLength`/`evenlySpacedPoints` below) use a FIXED substep
// count (`ARC_LENGTH_SUBSTEPS`), not an adaptive/data-dependent iteration
// count, so the same inputs always walk exactly the same number of
// evaluation steps in exactly the same order — see catmullRom.test.ts's
// determinism (hash-equivalent, bit-identical repeat-call) test.
//
// ## @errorBound (arc-length estimate)
//
// `integrateArcLength` approximates the true (smooth) span arc length by
// summing `ARC_LENGTH_SUBSTEPS` straight chords of the Barry-Goldman curve.
// Since a chord is always <= the true arc between its endpoints (triangle
// inequality applied to the limit of ever-finer inscribed polygons), this
// estimate systematically UNDERESTIMATES the true smooth-curve length, by an
// amount that shrinks as `O(1/substeps^2)` for a smooth (bounded-curvature)
// curve (standard polygon-inscribed-in-a-smooth-arc error order — the same
// chord-vs-arc reasoning `geodesicPath.ts`'s tessellation `@errorBound`
// documents for mesh edges, applied here to the spline's OWN internal
// subsampling rather than to a mesh).
//
// This bound is on the ARC-LENGTH ESTIMATE, not on `evenlySpacedPoints`'
// individual output POSITIONS: every output point is still an exact
// `evaluateSpan` call at a continuously-varying real parameter `u` (never
// snapped to one of the `ARC_LENGTH_SUBSTEPS` sample parameters) — what the
// substep count coarsens is only how evenly-spaced-by-TRUE-arc-length those
// points are, since the arc-length TABLE `evenlySpacedPoints` inverts
// assumes locally-linear speed within each substep bracket. At a target
// point count well below `ARC_LENGTH_SUBSTEPS` (64) — true for this
// project's realistic clinical density (`surfaceSpline.ts`'s module doc:
// ~10-20 points/mm on ~1-3mm-long spans, i.e. tens of points per span) —
// each substep bracket holds at most one or two output points, so the
// approximation is comfortably fine-grained. At a target point count
// APPROACHING OR EXCEEDING 64 (a caller requesting a much higher density,
// or an unusually long span), multiple output points fall inside the same
// substep bracket and their RELATIVE spacing within it becomes a locally-
// linear approximation rather than exact — catmullRom.test.ts's density-
// convergence property test exercises exactly this regime (densities up to
// 64 points/mm on ~5mm spans, i.e. hundreds of points per span, far past
// `ARC_LENGTH_SUBSTEPS`) and still measures smooth, well-behaved
// convergence (see that test's logged deviations) — i.e. this coarsening
// does not break correctness, only the theoretical tightness of "evenly
// spaced" at extreme oversampling, which is not this task's realistic
// operating range.
import type { Vec3 } from '../bvh/geometry.ts';
import { MESH_WELD_EPSILON_MM } from '../intake/weld.ts';

/** Centripetal parametrization exponent — see this module's top doc. Not
 * exposed as a caller-configurable option: alpha=0.5 is the property this
 * whole module's cusp-avoidance guarantee depends on; a different alpha is
 * a different (undocumented, unproven-for-this-codebase) algorithm, not a
 * tuning knob. */
const CENTRIPETAL_ALPHA = 0.5;

/** Fixed substep count for per-span arc-length integration/inversion — see
 * this module's "@errorBound (arc-length estimate)" doc. Deliberately a
 * constant, not data-dependent (determinism — see this module's top doc). */
export const ARC_LENGTH_SUBSTEPS = 64;

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Affine (lerp) combination of two points — see this module's top doc:
 * every Barry-Goldman step is one of these, which is why an affine
 * INVARIANT of the input points (e.g. "all Z coordinates are 0" — see
 * catmullRom.test.ts's planar-square test) is preserved EXACTLY (to
 * floating-point rounding) by the whole construction. */
export function lerpVec3(a: Vec3, b: Vec3, s: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
}

/** Total length of the straight-segment polyline through `points`, in
 * order (NOT closed — the caller adds a wrap-around segment separately if
 * needed). */
export function polylineLength(points: readonly Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += dist(points[i - 1]!, points[i]!);
  }
  return total;
}

/** Minimum consecutive-control-point distance below which centripetal knot
 * spacing degenerates (division by ~0 in `centripetalKnots`) — reuses
 * `MESH_WELD_EPSILON_MM` (1e-6 mm, imported rather than re-literaled — same
 * reason section/polyline.ts's `ON_PLANE_EPSILON_MM` does) for the same
 * reason: mesh intake already never leaves two DISTINCT points closer than
 * this, so two control points closer than it are, for spline-fitting
 * purposes, indistinguishable from a genuine duplicate — rejected outright
 * (see `validateControlPoints`) rather than silently producing a
 * near-singular knot interval. */
export const MIN_CONTROL_POINT_SEPARATION_MM = MESH_WELD_EPSILON_MM;

/**
 * Input validation shared by every public entry point in this module and
 * `surfaceSpline.ts`: `points` must have enough entries for the requested
 * topology (>= 2 open, >= 3 closed), every point must be finite, and no two
 * CONSECUTIVE points (wrapping for closed) may be closer than
 * `MIN_CONTROL_POINT_SEPARATION_MM` (see that constant's doc).
 *
 * @throws {RangeError} on any violation above.
 */
export function validateControlPoints(points: readonly Vec3[], closed: boolean): void {
  const minCount = closed ? 3 : 2;
  if (points.length < minCount) {
    throw new RangeError(
      `validateControlPoints: ${closed ? 'closed' : 'open'} spline needs at least ${minCount} control points, got ${points.length}`,
    );
  }
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) {
      throw new RangeError(`validateControlPoints: control point ${i} is not finite: [${p.join(', ')}]`);
    }
  }
  const pairCount = closed ? points.length : points.length - 1;
  for (let i = 0; i < pairCount; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const d = dist(a, b);
    if (d < MIN_CONTROL_POINT_SEPARATION_MM) {
      throw new RangeError(
        `validateControlPoints: control points ${i} and ${(i + 1) % points.length} are ${d.toExponential(3)}mm apart — ` +
          `below MIN_CONTROL_POINT_SEPARATION_MM (${MIN_CONTROL_POINT_SEPARATION_MM}mm); duplicate/near-duplicate ` +
          `control points are not supported (degenerate centripetal knot spacing)`,
      );
    }
  }
}

function reflect(anchor: Vec3, other: Vec3): Vec3 {
  return [2 * anchor[0] - other[0], 2 * anchor[1] - other[1], 2 * anchor[2] - other[2]];
}

/**
 * The 4 role points `[P0, P1, P2, P3]` Barry-Goldman needs to evaluate span
 * `spanIndex` (the curve segment from control point `spanIndex` to
 * `spanIndex + 1`): `P1`/`P2` are the span's own endpoints, `P0`/`P3` are
 * its neighbors (or a PHANTOM point — see below).
 *
 * - **Closed**: indices wrap modulo `points.length` — span `spanIndex`
 *   ranges `0 .. points.length - 1` (the last span wraps back to control
 *   point 0). This is the "classic off-by-one source" this task's
 *   guardrails call out: wrapping is `((i % n) + n) % n`, not `i % n` alone
 *   (JS `%` can return negative for a negative `i`, e.g. `spanIndex = 0`
 *   needs `P0 = points[n - 1]`, i.e. `i = -1`, and `-1 % n` is `-1` in JS,
 *   not `n - 1`) — see catmullRom.test.ts's directed wrap-indexing tests.
 * - **Open**: span `spanIndex` ranges `0 .. points.length - 2`. At either
 *   end, the missing neighbor is a REFLECTED phantom point
 *   (`2*anchor - other`, i.e. linear extrapolation one step past the real
 *   endpoint) rather than a repeated endpoint — a repeated endpoint would
 *   make that boundary's centripetal knot interval exactly 0 (division by
 *   zero in `centripetalKnots`); reflection keeps the interval equal to the
 *   adjacent real segment's own interval and gives a natural (roughly
 *   zero-curvature) end condition instead of an artificial kink.
 */
export function spanRole(points: readonly Vec3[], spanIndex: number, closed: boolean): readonly [Vec3, Vec3, Vec3, Vec3] {
  const n = points.length;
  if (closed) {
    const at = (i: number): Vec3 => points[((i % n) + n) % n]!;
    return [at(spanIndex - 1), at(spanIndex), at(spanIndex + 1), at(spanIndex + 2)];
  }
  const at = (i: number): Vec3 => {
    if (i < 0) return reflect(points[0]!, points[1]!);
    if (i > n - 1) return reflect(points[n - 1]!, points[n - 2]!);
    return points[i]!;
  };
  return [at(spanIndex - 1), at(spanIndex), at(spanIndex + 1), at(spanIndex + 2)];
}

/** Number of spans for `pointCount` control points — closed wraps back to
 * control point 0 (one span per control point); open has one fewer span
 * than control points. */
export function spanCountOf(pointCount: number, closed: boolean): number {
  return closed ? pointCount : pointCount - 1;
}

/**
 * The (up to 4) span indices whose Barry-Goldman role (`spanRole`) includes
 * control point `controlPointIndex` — i.e. the spans `refitSurfaceSplineControlPoint`
 * (surfaceSpline.ts) must recompute when that one control point moves,
 * every OTHER span being provably unaffected (this task's brief, deliverable
 * 3). A span's role always references real control points within
 * `[spanIndex - 1, spanIndex + 2]` — true even at an OPEN curve's reflected
 * boundary, since the reflection formula (`spanRole`'s doc) only ever reuses
 * the two real points already inside that same window — so this simple
 * window-based rule is exact for both topologies; closed wraps modulo
 * `spanCount`, open clips to the valid `[0, spanCount - 1]` range (no wrap).
 * Returned sorted ascending, de-duplicated (a small `spanCount`, e.g. closed
 * with < 4 control points, can make two of the 4 window entries land on the
 * same span index).
 */
export function affectedSpanIndices(pointCount: number, closed: boolean, controlPointIndex: number): number[] {
  const spanCount = spanCountOf(pointCount, closed);
  const window = [controlPointIndex - 2, controlPointIndex - 1, controlPointIndex, controlPointIndex + 1];
  const result = new Set<number>();
  for (const i of window) {
    if (closed) {
      result.add(((i % spanCount) + spanCount) % spanCount);
    } else if (i >= 0 && i <= spanCount - 1) {
      result.add(i);
    }
  }
  return Array.from(result).sort((a, b) => a - b);
}

/** Real (not renormalized-to-[0,1]) centripetal knot values `[t0,t1,t2,t3]`
 * for a span's 4 role points — see this module's top doc. `t0 = 0` always
 * (arbitrary global offset; only INTERVALS between knots matter to
 * Barry-Goldman). */
export function centripetalKnots(role: readonly [Vec3, Vec3, Vec3, Vec3]): [number, number, number, number] {
  const d01 = dist(role[0], role[1]);
  const d12 = dist(role[1], role[2]);
  const d23 = dist(role[2], role[3]);
  const t0 = 0;
  const t1 = t0 + Math.pow(d01, CENTRIPETAL_ALPHA);
  const t2 = t1 + Math.pow(d12, CENTRIPETAL_ALPHA);
  const t3 = t2 + Math.pow(d23, CENTRIPETAL_ALPHA);
  return [t0, t1, t2, t3];
}

/**
 * Barry & Goldman's recursive evaluation (this module's top doc) — 6 nested
 * `lerpVec3` calls parametrized by the real knot values `knots`. `u` MUST be
 * in `[knots[1], knots[2]]` (the span's own real-parameter range) for a
 * geometrically meaningful result; `u === knots[1]` returns exactly
 * `role[1]` and `u === knots[2]` returns exactly `role[2]` (verified
 * algebraically: every intermediate lerp's fraction reduces to select the
 * correct endpoint at either extreme — see catmullRom.test.ts's exact-
 * endpoint test).
 */
export function evaluateSpan(role: readonly [Vec3, Vec3, Vec3, Vec3], knots: readonly [number, number, number, number], u: number): Vec3 {
  const [p0, p1, p2, p3] = role;
  const [t0, t1, t2, t3] = knots;
  const a1 = lerpVec3(p0, p1, (u - t0) / (t1 - t0));
  const a2 = lerpVec3(p1, p2, (u - t1) / (t2 - t1));
  const a3 = lerpVec3(p2, p3, (u - t2) / (t3 - t2));
  const b1 = lerpVec3(a1, a2, (u - t0) / (t2 - t0));
  const b2 = lerpVec3(a2, a3, (u - t1) / (t3 - t1));
  return lerpVec3(b1, b2, (u - t1) / (t2 - t1));
}

/** Per-span arc-length table: `length` is the fixed-substep polyline
 * estimate (see this module's `@errorBound` doc), `cumulative[s]` is the
 * running length from `knots[1]` to substep `s`'s sample (`cumulative[0] ===
 * 0`, `cumulative[substeps] === length`) — `evenlySpacedPoints` inverts this
 * table to place points at even arc-length targets. */
export interface ArcLengthTable {
  readonly length: number;
  readonly cumulative: readonly number[];
  readonly substeps: number;
}

export function integrateArcLength(
  role: readonly [Vec3, Vec3, Vec3, Vec3],
  knots: readonly [number, number, number, number],
  substeps: number = ARC_LENGTH_SUBSTEPS,
): ArcLengthTable {
  const [, t1, t2] = knots;
  const cumulative: number[] = [0];
  let prev = evaluateSpan(role, knots, t1);
  let total = 0;
  for (let s = 1; s <= substeps; s++) {
    const u = t1 + ((t2 - t1) * s) / substeps;
    const cur = evaluateSpan(role, knots, u);
    total += dist(prev, cur);
    cumulative.push(total);
    prev = cur;
  }
  return { length: total, cumulative, substeps };
}

/**
 * `pointCount` points evenly spaced by arc length (per `arc`'s table) along
 * the span, `points[0]` at `knots[1]` exactly (`role[1]`) and
 * `points[pointCount - 1]` at `knots[2]` exactly (`role[2]`) — a caller that
 * needs bit-exact shared endpoints across adjacent spans should overwrite
 * these two slots with the shared control point's own stored value rather
 * than trust float round-trip equality (see surfaceSpline.ts, which does
 * this). `pointCount` must be `>= 2`.
 */
export function evenlySpacedPoints(
  role: readonly [Vec3, Vec3, Vec3, Vec3],
  knots: readonly [number, number, number, number],
  arc: ArcLengthTable,
  pointCount: number,
): Vec3[] {
  if (pointCount < 2) {
    throw new RangeError(`evenlySpacedPoints: pointCount must be >= 2, got ${pointCount}`);
  }
  const [, t1, t2] = knots;
  const { length, cumulative, substeps } = arc;
  const points: Vec3[] = new Array(pointCount);
  for (let k = 0; k < pointCount; k++) {
    const targetLength = (length * k) / (pointCount - 1);
    let s = 0;
    while (s < substeps && cumulative[s + 1]! < targetLength) s++;
    const segStart = cumulative[s]!;
    const segEnd = cumulative[Math.min(s + 1, substeps)]!;
    const frac = segEnd > segStart ? (targetLength - segStart) / (segEnd - segStart) : 0;
    const u0 = t1 + ((t2 - t1) * s) / substeps;
    const u1 = t1 + ((t2 - t1) * Math.min(s + 1, substeps)) / substeps;
    const u = u0 + (u1 - u0) * frac;
    points[k] = evaluateSpan(role, knots, u);
  }
  // Force exact endpoints — see this function's doc: floating-point
  // round-trip through the arc-length table can otherwise leave `points[0]`/
  // `points[pointCount-1]` a handful of ULPs off `role[1]`/`role[2]`.
  points[0] = role[1];
  points[pointCount - 1] = role[2];
  return points;
}

/** One resampled span of a pure ambient (no surface constraint) fit — see
 * `fitCatmullRomSpline`. */
export interface CatmullRomSpan {
  /** Evenly arc-length-spaced points; `points[0]`/`points[last]` are exactly
   * the span's own control-point endpoints. */
  readonly points: readonly Vec3[];
  /** Straight-chord polyline length of `points` (<= `ambientLength`, see
   * this module's top doc). */
  readonly length: number;
  /** Fixed-substep smooth-curve arc-length estimate (see this module's
   * `@errorBound` doc) — the density target (`pointsPerMm`) is computed
   * against THIS, not `length`. */
  readonly ambientLength: number;
}

export interface CatmullRomFitResult {
  readonly spans: readonly CatmullRomSpan[];
  /** Sum of every span's `length`. */
  readonly totalLength: number;
}

function pointCountForLength(length: number, pointsPerMm: number): number {
  return Math.max(2, Math.round(length * pointsPerMm) + 1);
}

/** Resamples ONE span at `pointsPerMm` density — the shared primitive both
 * `fitCatmullRomSpline` (below, whole-curve) and `surfaceSpline.ts` (single-
 * span refit, for locality) build on. */
export function resampleCatmullRomSpan(role: readonly [Vec3, Vec3, Vec3, Vec3], pointsPerMm: number): CatmullRomSpan {
  const knots = centripetalKnots(role);
  const arc = integrateArcLength(role, knots);
  const pointCount = pointCountForLength(arc.length, pointsPerMm);
  const points = evenlySpacedPoints(role, knots, arc, pointCount);
  return { points, length: polylineLength(points), ambientLength: arc.length };
}

/**
 * Deliverable 1's top-level entry point: fits a centripetal Catmull-Rom
 * spline through `points` (open or closed per `closed`) and resamples every
 * span at `pointsPerMm` (points per mm of estimated span arc length — see
 * `surfaceSpline.ts`'s module doc for the clinical density guidance this
 * project targets). Pure ambient-space: no mesh, no BVH — see this module's
 * top doc.
 *
 * @throws {RangeError} via `validateControlPoints` (topology/finiteness/
 * near-duplicate checks) or if `pointsPerMm` is not finite and > 0.
 */
export function fitCatmullRomSpline(points: readonly Vec3[], closed: boolean, pointsPerMm: number): CatmullRomFitResult {
  validateControlPoints(points, closed);
  if (!(Number.isFinite(pointsPerMm) && pointsPerMm > 0)) {
    throw new RangeError(`fitCatmullRomSpline: pointsPerMm must be finite and > 0, got ${pointsPerMm}`);
  }
  const spanCount = spanCountOf(points.length, closed);
  const spans: CatmullRomSpan[] = new Array(spanCount);
  let totalLength = 0;
  for (let i = 0; i < spanCount; i++) {
    const span = resampleCatmullRomSpan(spanRole(points, i, closed), pointsPerMm);
    spans[i] = span;
    totalLength += span.length;
  }
  return { spans, totalLength };
}
