// packages/kernel/src/register/icpRefine.ts
//
// icpRefine — point-to-plane Iterative Closest Point refinement (Besl &
// McKay 1992 for the classic point-to-point ICP; Chen & Medioni 1992 /
// Rusinkiewicz & Levoy 2001 for the point-to-plane linearization used here,
// which converges faster and handles sliding along locally-flat regions —
// exactly the geometry class dental arch/occlusal surfaces are — much
// better than point-to-point). Given a coarse `initial` transform (from
// `coarseAlignFromPointTriples` or any other source), iteratively:
//
//   1. sample `sampleCount` points on `srcMesh`'s surface (deterministic,
//      seeded — see sampling.ts's `samplePointsOnMesh`);
//   2. transform them by the CURRENT candidate transform;
//   3. find each transformed point's closest point on `dstMesh` (via the
//      caller-supplied `dstBvh` — never rebuilt here, see this module's
//      "BVH reuse" note below);
//   4. reject the farthest `outlierRejectionFraction` of correspondences
//      (distance-percentile, deterministic sort — see `selectInliers`);
//   5. solve the linearized 6-DOF point-to-plane normal equations for a
//      SMALL delta rotation + translation (small-angle approximation,
//      standard — see `solvePointToPlaneDelta`) via a direct 6x6 dense
//      solve (Gaussian elimination with partial pivoting — same technique
//      as repair/curvatureFill.ts's `solveDense`, re-implemented locally at
//      6x6 rather than imported: this repo's own precedent for small,
//      module-local numerical solvers is to duplicate rather than reach
//      across an unrelated module boundary for ~30 lines — see
//      scripts/kernel-ops-lib.ts's module doc, "duplicated rather than
//      shared... not shared logic");
//   6. compose the delta (via the EXACT Rodrigues rotation formula, not the
//      raw small-angle linearization, so the accumulated rotation stays a
//      proper orthonormal matrix even after many iterations — no separate
//      re-orthonormalization step needed) onto the current transform;
//   7. check convergence (relative RMS change below `convergenceRelTol`, or
///     `maxIterations` reached).
//
// ## Normal source: per-triangle geometric normals (not vertex-interpolated)
//
// The point-to-plane residual needs a surface normal AT each dst closest
// point. This module uses the CLOSEST TRIANGLE's flat geometric normal
// (`closestPoint`'s returned `triangleIndex`, cross product of two edges),
// not a Phong-style vertex-normal interpolation across the triangle's
// barycentric coordinates. This is a deliberate choice, not an oversight:
// intake-oriented scan meshes (CLAUDE.md: "everything goes through the
// intake pipeline") are dense relative to their own curvature almost
// everywhere a real arch/prep surface exists — Phase 2's curvature module
// already establishes per-VERTEX normals as a separate, more expensive
// (cotangent-weighted one-ring) computation whose whole point is smooth
// SHADING/analysis, not correspondence search. A flat per-triangle normal
// is: (a) exactly consistent with what `closestPoint`'s BVH traversal
// already computed (no extra per-query work — this module runs
// `sampleCount * maxIterations` closest-point queries, so avoiding an extra
// per-query vertex-normal interpolation pass is a real, not
// micro-, cost saving); (b) what `undercutScan.ts`'s `triangleUnitNormal`
// already uses for this exact codebase's other per-triangle-normal
// consumer, for consistency; (c) provably sufficient for ICP's purpose,
// which only needs the LOCAL TANGENT PLANE at the correspondence point, not
// a globally smooth field — any discrepancy between the flat and
// vertex-interpolated normal is O(triangle edge length x local curvature),
// i.e. bounded by the SAME tessellation-fineness argument
// undercutScan.ts's `@errorBound` doc already makes for its own flat-normal
// use, and shrinks with the (typically sub-100-micron) triangle size of a
// real intake scan.
//
// ## BVH reuse
//
// `dstBvh` is a REQUIRED parameter (never built inside this function) —
// same "already-built Bvh, not `(mesh, direction)`" shape as `undercutScan`
// (kernel/src/undercut/undercutScan.ts's module doc: "precisely so a caller
// running MANY queries against the same mesh ... builds the BVH exactly
// ONCE"). `icpRefine` runs `sampleCount * (iterations run)` closest-point
// queries against `dstMesh` — kernel-workers/src/jobs/register.ts's worker
// job builds `dstBvh` once (its per-worker BVH cache, jobs/bvh.ts) and
// passes it in.
//
// @errorBound LOCAL-MINIMUM CAVEAT (honest, not a numeric error bound): ICP
// is a local optimizer — it converges to the nearest local minimum of the
// point-to-plane objective from `initial`, with NO global-convergence
// guarantee. A poor `initial` (e.g. identity, when the true alignment is a
// large rotation) can converge to a WRONG local minimum that still reports
// `converged: true` and a deceptively small `rmsMm` (a locally-consistent
// but globally-wrong fit). This is why `coarseAlignFromPointTriples` (or an
// equivalent independent coarse step) is REQUIRED before this function for
// any pair of scans that do not already share a common coordinate frame —
// see this module's real-fixture test for a documented case (arch-case-01
// bite0 vs. upperjaw) where identity IS already a valid coarse init because
// both scans come from the same acquisition session in the scanner's own
// shared coordinate frame. Given a genuinely close `initial` (within the
// surfaces' local feature scale), convergence is to machine-precision-limited
// accuracy on clean/noiseless synthetic data (icpRefine.test.ts's analytic
// icosphere-pair case: RMS < 1e-6 mm) and to within the input noise level on
// noisy synthetic data (documented per-test tolerance).
import type { IndexedMesh } from '../mesh/types.ts';
import type { Bvh } from '../bvh/types.ts';
import { closestPoint } from '../bvh/closestPoint.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { applyMat4ToPoint, IDENTITY_MAT4, multiplyMat4, type Mat3, type Mat4 } from './transform.ts';
import { samplePointsOnMesh } from './sampling.ts';

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function triangleVertices(mesh: IndexedMesh, t: number): [Vec3, Vec3, Vec3] {
  const i0 = mesh.indices[t * 3]!;
  const i1 = mesh.indices[t * 3 + 1]!;
  const i2 = mesh.indices[t * 3 + 2]!;
  const p = mesh.positions;
  return [
    [p[i0 * 3]!, p[i0 * 3 + 1]!, p[i0 * 3 + 2]!],
    [p[i1 * 3]!, p[i1 * 3 + 1]!, p[i1 * 3 + 2]!],
    [p[i2 * 3]!, p[i2 * 3 + 1]!, p[i2 * 3 + 2]!],
  ];
}

/** Unit outward face normal (CCW-from-outside, matching `IndexedMesh`'s
 * winding convention — see mesh/types.ts) — same construction as
 * undercutScan.ts's `triangleUnitNormal` (see this file's "Normal source"
 * doc for why per-triangle, not per-vertex-interpolated). `[0,0,0]` for a
 * degenerate zero-area triangle (defense in depth only — intake's
 * `dropDegenerateTriangles` removes true degenerates upstream). */
function triangleUnitNormal(mesh: IndexedMesh, t: number): Vec3 {
  const [a, b, c] = triangleVertices(mesh, t);
  const n = cross(sub(b, a), sub(c, a));
  const len = Math.hypot(n[0], n[1], n[2]);
  return len > 0 ? [n[0] / len, n[1] / len, n[2] / len] : [0, 0, 0];
}

// ---------------------------------------------------------------------------
// Dense 6x6 Gaussian elimination with partial pivoting — see this file's
// module doc for why this is a local re-implementation rather than an
// import from repair/curvatureFill.ts.
// ---------------------------------------------------------------------------

function solveDense6(aIn: Float64Array[], bIn: Float64Array): Float64Array | null {
  const n = 6;
  const a = aIn.map((row) => Float64Array.from(row));
  const rhs = Float64Array.from(bIn);
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let pivotVal = Math.abs(a[col]![col]!);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(a[row]![col]!);
      if (v > pivotVal) {
        pivotVal = v;
        pivotRow = row;
      }
    }
    if (pivotVal < 1e-12) {
      return null; // singular/ill-conditioned normal-equations matrix (e.g. too few inliers)
    }
    if (pivotRow !== col) {
      const tmpRow = a[col]!;
      a[col] = a[pivotRow]!;
      a[pivotRow] = tmpRow;
      const tmpB = rhs[col]!;
      rhs[col] = rhs[pivotRow]!;
      rhs[pivotRow] = tmpB;
    }
    const pivot = a[col]![col]!;
    for (let row = col + 1; row < n; row++) {
      const factor = a[row]![col]! / pivot;
      if (factor === 0) continue;
      for (let k = col; k < n; k++) a[row]![k] = a[row]![k]! - factor * a[col]![k]!;
      rhs[row] = rhs[row]! - factor * rhs[col]!;
    }
  }
  const x = new Float64Array(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = rhs[row]!;
    for (let k = row + 1; k < n; k++) sum -= a[row]![k]! * x[k]!;
    x[row] = sum / a[row]![row]!;
  }
  return x;
}

/** Exact Rodrigues rotation for a small rotation VECTOR `r` (axis = r's
 * direction, angle = |r|, both in radians) — used (rather than the raw
 * linearized `I + [r]_x`) so composing many small ICP steps never drifts
 * away from a proper orthonormal rotation matrix (see this file's module
 * doc, step 6). Returns the identity rotation for `|r| ~ 0`. */
function rodrigues(r: Vec3): Mat3 {
  const theta = Math.hypot(r[0], r[1], r[2]);
  if (theta < 1e-15) {
    return [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
  }
  const axis: Vec3 = [r[0] / theta, r[1] / theta, r[2] / theta];
  const [x, y, z] = axis;
  const s = Math.sin(theta);
  const c = Math.cos(theta);
  const t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}

/** Composes a delta rigid transform (rotation vector `deltaR`, translation
 * `deltaT`, both applied AFTER `current`) onto `current`: `p -> R_delta *
 * (R_cur * p + t_cur) + t_delta`. */
function composeDelta(current: Mat4, deltaR: Vec3, deltaT: Vec3): Mat4 {
  const rotDelta = rodrigues(deltaR);
  const deltaMat4: Mat4 = [
    rotDelta[0][0], rotDelta[1][0], rotDelta[2][0], 0,
    rotDelta[0][1], rotDelta[1][1], rotDelta[2][1], 0,
    rotDelta[0][2], rotDelta[1][2], rotDelta[2][2], 0,
    deltaT[0], deltaT[1], deltaT[2], 1,
  ];
  return multiplyMat4(deltaMat4, current);
}

interface Correspondence {
  transformedSrc: Vec3;
  closestDst: Vec3;
  normal: Vec3;
  distance: number;
}

/** Sorts correspondences by `(distance, sampleIndex)` ascending (stable,
 * deterministic tie-break — CLAUDE.md invariant 2) and keeps the closest
 * `1 - outlierRejectionFraction` fraction as inliers. Always keeps at least
 * 6 points (the minimum for the 6-DOF solve to be well-posed) when at least
 * 6 correspondences exist. */
function selectInliers(correspondences: readonly Correspondence[], outlierRejectionFraction: number): Correspondence[] {
  const indexed = correspondences.map((c, index) => ({ c, index }));
  indexed.sort((a, b) => a.c.distance - b.c.distance || a.index - b.index);
  const keepCount = Math.max(
    Math.min(6, indexed.length),
    Math.round(indexed.length * (1 - outlierRejectionFraction)),
  );
  return indexed.slice(0, keepCount).map((entry) => entry.c);
}

export interface IcpRefineOptions {
  /** How many points to sample from `srcMesh`'s surface per iteration —
   * the SAME sample set (same seed) is reused every iteration (only their
   * TRANSFORMED positions change), so correspondence search is comparing
   * apples to apples iteration over iteration. */
  sampleCount: number;
  /** Deterministic sampling seed — CALLER-provided and journaled (this
   * module's doc / CLAUDE.md invariant 2: "no unseeded randomness"). */
  seed: number;
  /** Default 50 — see this module's module doc; a 6-DOF point-to-plane ICP
   * on a good coarse init typically converges within single-digit to
   * low-double-digit iterations, this is a generous ceiling. */
  maxIterations?: number;
  /** Convergence: stop when `|rms(i) - rms(i-1)| / max(rms(i-1), 1e-9) <
   * convergenceRelTol`. Default `1e-6`. */
  convergenceRelTol?: number;
  /** Fraction of correspondences (by distance, farthest) rejected as
   * outliers EACH iteration before solving — default `0.1` (keep the
   * closest 90%). */
  outlierRejectionFraction?: number;
}

export interface IcpRefineResult {
  /** Column-major 16-number rigid transform (SceneNode convention — see
   * transform.ts) mapping `srcMesh`'s own local geometry onto `dstMesh`. */
  transform: Mat4;
  /** RMS Euclidean closest-point distance (mm) over the FINAL iteration's
   * inlier set. */
  rmsMm: number;
  /** Fraction of `sampleCount` samples kept as inliers on the final
   * iteration (`1 - outlierRejectionFraction`, modulo the "at least 6"
   * floor — see `selectInliers`). */
  inlierFraction: number;
  /** Iterations actually run (<= `maxIterations`). */
  iterations: number;
  /** Whether the relative-RMS-change convergence criterion was met before
   * `maxIterations` was reached. */
  converged: boolean;
}

/** Defaults for `IcpRefineOptions` — also exported so
 * kernel-workers/src/jobs/register.ts's worker job (which drives
 * `icpRefineIteration` directly rather than calling `icpRefine`, per that
 * function's doc) can apply the SAME defaults without duplicating these
 * magic numbers. */
export const DEFAULT_MAX_ITERATIONS = 50;
export const DEFAULT_CONVERGENCE_REL_TOL = 1e-6;
export const DEFAULT_OUTLIER_REJECTION_FRACTION = 0.1;
/** Absolute RMS (mm) below which convergence is declared unconditionally,
 * regardless of the RELATIVE-change criterion — once `rmsMm` is already
 * this small (a small fraction of this repo's 1e-3 mm/1 micron clinical
 * display resolution), further iterations only chase Float64 rounding noise
 * around zero: the relative-change formula's `Math.max(previousRms, 1e-9)`
 * floor means relative change becomes an ever-more-sensitive (and
 * meaningless) ratio as `previousRms` approaches that floor from above,
 * which without this absolute escape hatch can prevent `converged` from
 * ever flipping true on a near-perfect (clean, noiseless) fit — see
 * icpRefine.test.ts's "converges ... to RMS < 1e-6 mm" test. */
export const ICP_ABSOLUTE_RMS_CONVERGED_FLOOR_MM = 1e-9;

export interface IcpIterationResult {
  /** `null` iff the linearized normal-equations solve was singular (too few
   * or degenerate inliers) — `icpRefineIteration` made NO change in this
   * case; the caller should stop iterating and report the transform/rms it
   * already had. */
  transform: Mat4 | null;
  /** RMS Euclidean closest-point distance (mm), over this iteration's
   * inlier set, BEFORE applying the just-solved delta (i.e. the residual
   * the delta was solved to reduce). */
  rmsMm: number;
  /** Fraction of `srcSamples.length / 3` samples kept as inliers this
   * iteration (see `selectInliers`'s "at least 6" floor). */
  inlierFraction: number;
}

/**
 * ONE point-to-plane ICP iteration — the chunked primitive both `icpRefine`
 * (below, a whole-run convenience loop) and
 * kernel-workers/src/jobs/register.ts's worker job are built on (same split
 * as undercutScanRange/undercutScan — see that module's "Chunked range API"
 * doc: the worker job drives THIS function iteration-by-iteration, awaiting
 * a cancellation check and reporting real per-iteration progress between
 * calls, which a single synchronous whole-run call could never offer).
 *
 * `srcSamples` is a FLAT xyz Float64Array (`samplePointsOnMesh`'s
 * `.points`) sampled ONCE by the caller and reused every iteration — only
 * their positions AFTER applying `currentTransform` change between calls.
 */
export function icpRefineIteration(
  srcSamples: Float64Array,
  dstMesh: IndexedMesh,
  dstBvh: Bvh,
  currentTransform: Mat4,
  outlierRejectionFraction: number,
): IcpIterationResult {
  const sampleCount = srcSamples.length / 3;
  const correspondences: Correspondence[] = new Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const srcLocal: Vec3 = [srcSamples[i * 3]!, srcSamples[i * 3 + 1]!, srcSamples[i * 3 + 2]!];
    const transformedSrc = applyMat4ToPoint(currentTransform, srcLocal);
    const closest = closestPoint(dstMesh, dstBvh, transformedSrc);
    correspondences[i] = {
      transformedSrc,
      closestDst: closest.point as Vec3,
      normal: triangleUnitNormal(dstMesh, closest.triangleIndex),
      distance: closest.distance,
    };
  }

  const inliers = selectInliers(correspondences, outlierRejectionFraction);
  const inlierFraction = inliers.length / sampleCount;

  let sumSq = 0;
  for (const c of inliers) sumSq += c.distance * c.distance;
  const rmsMm = Math.sqrt(sumSq / inliers.length);

  // ATA x = ATb for x = [rx,ry,rz,tx,ty,tz] — the linearized point-to-plane
  // normal equations (Rusinkiewicz & Levoy 2001, eq. 5): each inlier
  // contributes row = [p x n; n] (p = current transformed src point, n =
  // dst normal), rhs = n . (q - p) (q = dst closest point).
  const ata: Float64Array[] = Array.from({ length: 6 }, () => new Float64Array(6));
  const atb = new Float64Array(6);
  for (const c of inliers) {
    const pxn = cross(c.transformedSrc, c.normal);
    const row: readonly number[] = [pxn[0], pxn[1], pxn[2], c.normal[0], c.normal[1], c.normal[2]];
    const rhs = dot(c.normal, sub(c.closestDst, c.transformedSrc));
    for (let r = 0; r < 6; r++) {
      atb[r]! += row[r]! * rhs;
      const rowR = ata[r]!;
      for (let cIdx = 0; cIdx < 6; cIdx++) {
        rowR[cIdx]! += row[r]! * row[cIdx]!;
      }
    }
  }
  // Tiny Tikhonov regularization — guards a near-singular system (e.g. very
  // few inliers, or a locally planar patch with no constraint on in-plane
  // sliding along one axis) without perceptibly biasing a well-conditioned
  // solve (same guard curvatureFill.ts's dense solve uses,
  // `REGULARIZATION_EPS`-equivalent).
  for (let i = 0; i < 6; i++) ata[i]![i]! += 1e-9;

  const delta = solveDense6(ata, atb);
  if (!delta) {
    return { transform: null, rmsMm, inlierFraction };
  }
  const deltaR: Vec3 = [delta[0]!, delta[1]!, delta[2]!];
  const deltaT: Vec3 = [delta[3]!, delta[4]!, delta[5]!];
  return { transform: composeDelta(currentTransform, deltaR, deltaT), rmsMm, inlierFraction };
}

/**
 * Point-to-plane ICP refinement — see this file's module doc for the full
 * algorithm, the per-triangle-normal choice, and the `@errorBound`
 * local-minimum caveat. Loops `icpRefineIteration` above to convergence /
 * `maxIterations`; a WORKER caller that needs real per-iteration progress
 * and cancellation should drive `icpRefineIteration` directly instead (see
 * that function's doc) — this function is for non-worker/kernel-level
 * callers (tests, scripts) that just want a whole-run result.
 *
 * @throws {RangeError} for `sampleCount <= 0`, an out-of-`[0, 1)` outlier
 * fraction, or a zero-triangle `srcMesh`/`dstMesh`.
 */
export function icpRefine(
  srcMesh: IndexedMesh,
  dstMesh: IndexedMesh,
  dstBvh: Bvh,
  initial: Mat4,
  options: IcpRefineOptions,
): IcpRefineResult {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const convergenceRelTol = options.convergenceRelTol ?? DEFAULT_CONVERGENCE_REL_TOL;
  const outlierRejectionFraction = options.outlierRejectionFraction ?? DEFAULT_OUTLIER_REJECTION_FRACTION;
  if (!(outlierRejectionFraction >= 0 && outlierRejectionFraction < 1)) {
    throw new RangeError('icpRefine: outlierRejectionFraction must be in [0, 1)');
  }
  if (dstMesh.indices.length === 0) {
    throw new RangeError('icpRefine: dstMesh has no triangles');
  }

  const { points: srcSamples } = samplePointsOnMesh(srcMesh, options.sampleCount, options.seed);

  let currentTransform: Mat4 = initial ?? IDENTITY_MAT4;
  let previousRms = Infinity;
  let lastRms = 0;
  let lastInlierFraction = 0;
  let iterationsRun = 0;
  let converged = false;

  for (let iter = 0; iter < maxIterations; iter++) {
    iterationsRun = iter + 1;
    const step = icpRefineIteration(srcSamples, dstMesh, dstBvh, currentTransform, outlierRejectionFraction);
    lastRms = step.rmsMm;
    lastInlierFraction = step.inlierFraction;
    if (step.transform === null) break; // singular system — stop where we are, report what we have
    currentTransform = step.transform;

    const relChange = Math.abs(previousRms - lastRms) / Math.max(previousRms, 1e-9);
    previousRms = lastRms;
    if ((Number.isFinite(relChange) && relChange < convergenceRelTol) || lastRms < ICP_ABSOLUTE_RMS_CONVERGED_FLOOR_MM) {
      converged = true;
      break;
    }
  }

  return {
    transform: currentTransform,
    rmsMm: lastRms,
    inlierFraction: lastInlierFraction,
    iterations: iterationsRun,
    converged,
  };
}
