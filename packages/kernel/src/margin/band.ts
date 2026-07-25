// packages/kernel/src/margin/band.ts
//
// Phase 4 Task 1: the margin-BAND primitive — from a CONFIRMED `MarginLine`
// (a dense, on-surface, closed loop), builds the geometric structures every
// downstream Phase 4 crown-design stage needs: the ordered loop as a plain
// Float64 polyline, the loop's local frame (centroid + normal + an
// orthonormal tangent-plane basis — e.g. Task 5's anatomy placement
// derives its occluso-gingival axis "from the margin plane + insertion
// axis"), and `marginLoopMesh`, a thin ribbon mesh of the loop for boolean
// stitching (Task 7's shell construction: "outer + inner surface + margin
// band ... joined at the margin band into a closed shell — the margin band
// is the seam").
//
// ## CHORD-CAP (the fix this file's brief specifically calls out)
//
// This module NEVER reads `MarginLine.anchors` for geometry — only
// `resampledPoints` (the dense, on-surface polyline `apps/client/src/
// engine/marginEditor.ts`'s geodesic snapping actually commits). Anchor
// CHORDS (straight lines between the sparse control points, `MARGIN_
// ANCHOR_MAX_SPACING_MM` apart — margin/marginRidge.ts) are straight-line
// secants of a curved surface, not on-surface paths: measured localized
// deviation between an anchor chord and the true on-surface geodesic is
// 220-290µm on real fixtures (this task's report) — comfortably enough to
// FALSELY FAIL Task 4's ≤10µm margin-fit gate if this module (or anything
// downstream of it) ever consumed anchor chords instead of the dense
// resampled polyline. `resampledPoints` is therefore a REQUIRED field on
// this module's input type (`MarginBandInput`, below) — unlike
// `shared-types`' `MarginLine.resampledPoints`, which is optional (absent
// for a fresh, unconfirmed manual trace) — enforced by construction: there
// is no code path in this file that ever falls back to `anchors`.
//
// ## Method
//
//  - `marginLoopPolyline`: `resampledPoints`, deduplicated of consecutive
//    (within `MESH_WELD_EPSILON_MM`) near-identical points, INCLUDING the
//    closing wraparound pair — mirrors `margin/validate.ts`'s
//    `validatedPoints` dedup precedent (see that function's doc for why
//    this is necessary: `resampledPoints` is built by concatenating
//    per-segment arrays that share an anchor at every segment boundary, by
//    construction, always).
//  - `computeMarginLoopFrame`: Newell's method for the loop's average plane
//    normal (the standard robust polygon-normal formula — exact for a
//    planar simple polygon, a well-defined "total signed area vector" for a
//    noisy/non-planar one; see this function's own `@errorBound`), the
//    arithmetic-mean centroid of the loop's own vertices (NOT an
//    area-weighted centroid of the enclosed disk — a deliberately simpler,
//    documented choice; see that field's own doc), and an orthonormal
//    tangent-plane basis via `axis/hemisphere.ts`'s already-reviewed
//    `orthonormalBasis` (reused, not reimplemented).
//  - `marginLoopMesh`: two copies of the loop offset by `+/-halfThicknessMm`
//    along the frame normal (or a caller-supplied direction), triangulated
//    into a thin, OPEN ribbon (two boundary loops — top rim, bottom rim; no
//    end caps, since the loop itself has none) connecting corresponding
//    points — see that function's own doc for the exact triangulation and
//    winding.
//
// @errorBound Every quantity here is a DIRECT, EXACT (Float64) function of
// the input polyline's own points — no interpolation, no iteration, no
// approximation of a continuous quantity. `computeMarginLoopFrame`'s normal
// is Newell's method's EXACT total signed-area vector for whatever polyline
// it is given (exact for a planar simple polygon; for a genuinely
// non-planar loop it is the honest "total, not a least-squares fit" answer
// — see that function's own doc, which is the one place this module's own
// judgment enters rather than inherited float-rounding noise).
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { MESH_WELD_EPSILON_MM } from '../intake/weld.ts';
import { orthonormalBasis } from '../axis/hemisphere.ts';

/** Minimum DEDUPLICATED point count for a margin band to be geometrically
 * meaningful — mirrors `margin/validate.ts`'s own `MARGIN_VALIDATE_MIN_ANCHOR_COUNT`
 * floor (a closed loop needs at least 3 distinct points to bound any area /
 * have a well-defined normal). */
export const MARGIN_BAND_MIN_POINT_COUNT = 3;

/** Default half-thickness (mm) for `marginLoopMesh`'s ribbon — "degenerate
 * -thin" per this task's brief: small enough to be a seam, not a visible
 * wall, comfortably above `MESH_WELD_EPSILON_MM` (1e-6mm) so the ribbon's
 * two rims never accidentally weld back together under any later
 * `weldVertices` pass a boolean-stitching consumer might run. 1 µm: three
 * orders of magnitude above the weld epsilon, three orders of magnitude
 * below any clinically meaningful gap (the smallest profile gap,
 * `marginalGapMm`, is 0-50 µm per PLAN §3) — a seam, not a feature. */
export const MARGIN_BAND_DEFAULT_HALF_THICKNESS_MM = 0.001;

/** Thrown when `MarginBandInput.resampledPoints` is missing or empty — the
 * CHORD-CAP guard (see this file's module doc): this module refuses to
 * silently fall back to anchor chords, which would reintroduce the
 * 220-290µm localized deviation the margin-fit gate must never see. */
export class MarginBandChordCapError extends Error {
  constructor() {
    super(
      'margin/band.ts: resampledPoints is required and must be non-empty — this module NEVER derives ' +
        'geometry from anchor chords (see band.ts module doc, "CHORD-CAP"). Resample the margin spline ' +
        '(spline/marginLine.ts) before building a margin band.',
    );
    this.name = 'MarginBandChordCapError';
  }
}

/** Thrown when the (deduplicated) loop has too few points, or is not
 * `closed` — a margin band is only meaningful for a confirmed, closed
 * finish line (CLAUDE.md domain vocabulary: "margin line (finish line)" is
 * closed by definition — margin/validate.ts's own
 * `MarginValidationHardFailureKind` `'open'`/`'degenerate'` precedent). */
export class DegenerateMarginBandError extends Error {
  constructor(reason: 'notClosed' | 'tooFewPoints', pointCount: number) {
    super(
      reason === 'notClosed'
        ? 'margin/band.ts: margin.closed must be true — a margin band requires a confirmed, closed finish line'
        : `margin/band.ts: margin loop has only ${pointCount} deduplicated point(s), need >= ${MARGIN_BAND_MIN_POINT_COUNT}`,
    );
    this.name = 'DegenerateMarginBandError';
  }
}

/**
 * The minimal shape `band.ts` needs from a confirmed margin — a STRICTER
 * subset of `spline/marginLine.ts`'s `MarginLineLike` (which itself mirrors
 * shared-types' `MarginLine`): `resampledPoints` is REQUIRED here (never
 * optional) — see this file's module doc, "CHORD-CAP".
 */
export interface MarginBandInput {
  readonly closed: boolean;
  readonly resampledPoints: readonly Vec3[];
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * `margin.resampledPoints`, deduplicated of consecutive near-identical
 * points (within `MESH_WELD_EPSILON_MM`), INCLUDING the closing wraparound
 * pair for a closed loop — mirrors `margin/validate.ts`'s `validatedPoints`
 * dedup (see that function's own doc for why this is necessary: a
 * real-production `resampledPoints` array has an exact duplicate point at
 * every segment boundary, by construction).
 *
 * @throws {MarginBandChordCapError} if `margin.resampledPoints` is missing
 * or empty.
 * @throws {DegenerateMarginBandError} if `margin.closed` is `false`, or the
 * deduplicated loop has fewer than `MARGIN_BAND_MIN_POINT_COUNT` points.
 */
export function marginLoopPolyline(margin: MarginBandInput): Vec3[] {
  if (!margin.resampledPoints || margin.resampledPoints.length === 0) {
    throw new MarginBandChordCapError();
  }
  if (!margin.closed) {
    throw new DegenerateMarginBandError('notClosed', margin.resampledPoints.length);
  }
  const raw = margin.resampledPoints;
  const deduped: Vec3[] = [raw[0]!];
  for (let i = 1; i < raw.length; i++) {
    if (dist3(deduped[deduped.length - 1]!, raw[i]!) > MESH_WELD_EPSILON_MM) deduped.push(raw[i]!);
  }
  if (deduped.length > 1 && dist3(deduped[deduped.length - 1]!, deduped[0]!) <= MESH_WELD_EPSILON_MM) {
    deduped.pop(); // closing wraparound pair — same duplicate-boundary reasoning as validate.ts
  }
  if (deduped.length < MARGIN_BAND_MIN_POINT_COUNT) {
    throw new DegenerateMarginBandError('tooFewPoints', deduped.length);
  }
  return deduped;
}

export interface MarginLoopFrame {
  /** Arithmetic mean of the loop's (deduplicated) vertices — NOT an
   * area-weighted centroid of the enclosed disk (that would need a
   * triangulation this module deliberately doesn't build); a simple,
   * documented reference origin for the frame. */
  centroidMm: Vec3;
  /** Unit normal via Newell's method (see this file's module doc) — exact
   * for a planar simple polygon; the total signed-area-vector direction for
   * a non-planar/noisy one. Right-handed with the loop's own point order
   * (CCW around this normal, by the standard Newell/shoelace convention). */
  normal: Vec3;
  /** Orthonormal tangent-plane basis (`axis/hemisphere.ts#orthonormalBasis`,
   * reused verbatim) — `{ normal, tangentU, tangentV }` forms a right-handed
   * orthonormal frame. */
  tangentU: Vec3;
  tangentV: Vec3;
}

/**
 * Newell's method: `2x` the polygon's signed area vector, accumulated over
 * every consecutive pair (wrapping) — the standard robust formula for a
 * (possibly slightly non-planar) simple polygon's average normal. Exact
 * (Float64 sums/products only, no iteration) for whatever polyline it is
 * given.
 */
function newellNormalUnnormalized(points: readonly Vec3[]): Vec3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const cur = points[i]!;
    const next = points[(i + 1) % n]!;
    nx += (cur[1] - next[1]) * (cur[2] + next[2]);
    ny += (cur[2] - next[2]) * (cur[0] + next[0]);
    nz += (cur[0] - next[0]) * (cur[1] + next[1]);
  }
  return [nx, ny, nz];
}

/** Thrown when the loop's Newell-method normal is (numerically) zero — a
 * genuinely degenerate configuration (e.g. every point collinear) with no
 * well-defined plane. */
export class DegenerateMarginLoopNormalError extends Error {
  constructor() {
    super('margin/band.ts: computeMarginLoopFrame: the loop\'s Newell-method normal is degenerate (zero length) — every point may be collinear');
    this.name = 'DegenerateMarginLoopNormalError';
  }
}

/**
 * Computes the margin loop's local frame — see this file's module doc and
 * `MarginLoopFrame`'s own field docs. `loopPoints` should already be
 * deduplicated (`marginLoopPolyline`'s output) — this function has no
 * opinion on that itself, only on the geometry.
 *
 * @throws {DegenerateMarginBandError} if `loopPoints.length <
 * MARGIN_BAND_MIN_POINT_COUNT`.
 * @throws {DegenerateMarginLoopNormalError} if the Newell-method normal is
 * (numerically) zero.
 */
export function computeMarginLoopFrame(loopPoints: readonly Vec3[]): MarginLoopFrame {
  if (loopPoints.length < MARGIN_BAND_MIN_POINT_COUNT) {
    throw new DegenerateMarginBandError('tooFewPoints', loopPoints.length);
  }
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of loopPoints) {
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  const n = loopPoints.length;
  const centroidMm: Vec3 = [cx / n, cy / n, cz / n];

  const raw = newellNormalUnnormalized(loopPoints);
  const len = Math.hypot(raw[0], raw[1], raw[2]);
  if (!(len > 0)) {
    throw new DegenerateMarginLoopNormalError();
  }
  const normal: Vec3 = [raw[0] / len, raw[1] / len, raw[2] / len];
  const { u, v } = orthonormalBasis(normal);

  return { centroidMm, normal, tangentU: u, tangentV: v };
}

export interface MarginLoopMeshOptions {
  /** Half-thickness of the ribbon, mm — default `MARGIN_BAND_DEFAULT_HALF_THICKNESS_MM`. */
  halfThicknessMm?: number;
  /** Offset direction — default the loop's own `computeMarginLoopFrame`
   * normal. Need not be normalized (normalized internally). */
  direction?: Vec3;
}

export interface MarginLoopMeshResult {
  /** An OPEN ribbon: `2 * loopPoints.length` vertices (top rim, then bottom
   * rim, same order/index correspondence), `2 * loopPoints.length`
   * triangles (2 per loop segment) — two boundary loops (top rim, bottom
   * rim), no end caps (the input loop itself has none). CCW winding
   * chosen so the ribbon's outward normal points in `+direction` on the
   * "top" (offset `+halfThicknessMm`) side — see this function's body for
   * the exact triangulation. */
  mesh: IndexedMesh;
  directionUnit: Vec3;
  halfThicknessMm: number;
}

function normalizeDirection(direction: Vec3): Vec3 {
  const len = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(len > 0)) {
    throw new TypeError('marginLoopMesh: direction must be a non-zero-length vector');
  }
  return [direction[0] / len, direction[1] / len, direction[2] / len];
}

/**
 * Builds the loop as a thin, OPEN ribbon mesh — "the loop as a degenerate
 * -thin ring for boolean stitching" (this task's brief). Two copies of
 * `loopPoints`, offset by `+/-halfThicknessMm` along `direction` (default:
 * the loop's own frame normal), triangulated into a side wall connecting
 * corresponding points. Deliberately NOT closed (no end caps) — a ring, not
 * a solid; see this file's module doc.
 *
 * @throws {DegenerateMarginBandError} if `loopPoints.length <
 * MARGIN_BAND_MIN_POINT_COUNT`.
 * @throws {TypeError} if `options.halfThicknessMm` is not `> 0`, or
 * `options.direction` is the zero vector.
 * @throws {DegenerateMarginLoopNormalError} if `options.direction` is
 * omitted and the loop's own Newell-method normal is degenerate.
 */
export function marginLoopMesh(loopPoints: readonly Vec3[], options: MarginLoopMeshOptions = {}): MarginLoopMeshResult {
  if (loopPoints.length < MARGIN_BAND_MIN_POINT_COUNT) {
    throw new DegenerateMarginBandError('tooFewPoints', loopPoints.length);
  }
  const halfThicknessMm = options.halfThicknessMm ?? MARGIN_BAND_DEFAULT_HALF_THICKNESS_MM;
  if (!(halfThicknessMm > 0)) {
    throw new TypeError(`marginLoopMesh: halfThicknessMm must be > 0, got ${halfThicknessMm}`);
  }
  const directionUnit = normalizeDirection(options.direction ?? computeMarginLoopFrame(loopPoints).normal);

  const n = loopPoints.length;
  const positions = new Float64Array(n * 2 * 3);
  for (let i = 0; i < n; i++) {
    const p = loopPoints[i]!;
    // Top rim (offset +halfThickness): vertex index i.
    positions[i * 3] = p[0] + directionUnit[0] * halfThicknessMm;
    positions[i * 3 + 1] = p[1] + directionUnit[1] * halfThicknessMm;
    positions[i * 3 + 2] = p[2] + directionUnit[2] * halfThicknessMm;
    // Bottom rim (offset -halfThickness): vertex index n + i.
    positions[(n + i) * 3] = p[0] - directionUnit[0] * halfThicknessMm;
    positions[(n + i) * 3 + 1] = p[1] - directionUnit[1] * halfThicknessMm;
    positions[(n + i) * 3 + 2] = p[2] - directionUnit[2] * halfThicknessMm;
  }

  // 2 triangles per loop segment (i -> i+1 mod n), connecting top[i],
  // top[i+1], bottom[i], bottom[i+1] — CCW-from-outside winding chosen so
  // the ribbon's outward face normal (cross of the two triangle edges)
  // points along +directionUnit on the top side and -directionUnit on the
  // bottom side (a standard "prism side wall" triangulation).
  const indices = new Uint32Array(n * 2 * 3);
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const iNext = (i + 1) % n;
    const top0 = i;
    const top1 = iNext;
    const bot0 = n + i;
    const bot1 = n + iNext;
    // Triangle 1: top0, bot0, bot1
    indices[idx++] = top0;
    indices[idx++] = bot0;
    indices[idx++] = bot1;
    // Triangle 2: top0, bot1, top1
    indices[idx++] = top0;
    indices[idx++] = bot1;
    indices[idx++] = top1;
  }

  return {
    mesh: { positions, indices },
    directionUnit,
    halfThicknessMm,
  };
}
