// packages/kernel/src/register/kabsch.ts
//
// coarseAlignFromPointTriples — closed-form rigid (rotation + translation)
// alignment recovering the least-squares-optimal transform mapping 3 SRC
// points onto 3 corresponding DST points (Kabsch/Horn's algorithm,
// specialized to the minimal N=3 case). This is the UI alignment tool's
// "coarse" step: 3 user-picked point PAIRS (one on each of two meshes) give
// an initial guess `icpRefine` then locally refines — see icpRefine.ts's
// module doc for why a coarse init is REQUIRED (ICP has no global-convergence
// guarantee; icpRefine's `@errorBound` documents the local-minimum caveat).
//
// ## Algorithm (Kabsch via eigen-decomposition, not a general SVD library)
//
// Standard Kabsch: `H = Σ (src_i - centroidSrc) (dst_i - centroidDst)^T`
// (the 3x3 cross-covariance), SVD `H = U Σ V^T`, `R = V U^T` (with a
// reflection fix if `det(V U^T) < 0`). For general N this needs a real SVD
// routine; for EXACTLY N=3 points, H is provably rank <= 2 (3 points minus
// their own centroid are 3 vectors summing to zero, which span at most a
// 2-D subspace) — so this module computes the two nonzero singular-vector
// pairs directly from `H^T H`'s eigen-decomposition (a 3x3 symmetric
// matrix, solved via a deterministic cyclic Jacobi rotation sweep — see
// `jacobiEigenSymmetric3x3` below) and COMPLETES the third singular vector
// of each side via a cross product (`v3 = v1 x v2`, `u3 = u1 x u2`) rather
// than trusting an arbitrary-signed SVD library output.
//
// This constructive completion is not a shortcut approximation — it is
// PROVABLY equivalent to the reflection-corrected Kabsch solution: the
// third singular value is exactly 0 for N=3 (see above), so the objective
// `tr(R H) = Σ_i Z_ii σ_i` (`Z = V^T R U`) is completely insensitive to the
// sign of the (`σ3 = 0`) term — EITHER sign choice for `u3`/`v3` is equally
// optimal, and choosing the right-handed one (cross product, rather than an
// arbitrary SVD-library sign) both (a) guarantees `det(R) = +1` (a proper
// rotation, never a reflection) and (b) is exactly what Kabsch's own
// reflection-correction step (`d = sign(det(V U^T))`, flip the last column
// if negative) would resolve to — computed directly here instead of via
// detect-then-flip.
//
// @errorBound EXACT (machine precision, ~1e-13 relative — see
// kabsch.analytic.test.ts) for a triple pair related by a genuine rigid
// transform (no picking noise). For a NON-exactly-rigid triple pair (real
// user picks, which are never perfectly consistent), this is the Kabsch
// LEAST-SQUARES optimum over those 3 correspondences specifically — not a
// global alignment of the full surfaces, which is `icpRefine`'s job.
import type { Vec3 } from '../bvh/geometry.ts';
import { composeRigid, type Mat3, type Mat4 } from './transform.ts';

/** Two pairwise-coincident points closer than this are rejected as
 * degenerate — 1e-6 mm (1 nm), the SAME magnitude as undercutScan's
 * `RAY_ORIGIN_BIAS_MM` (kernel/src/undercut/undercutScan.ts): comfortably
 * above Float64 rounding noise at dental-scan coordinate magnitudes,
 * comfortably below any physically meaningful pick separation — a real user
 * click can never coincide with a previous one this tightly by accident. */
export const COINCIDENT_POINT_EPSILON_MM = 1e-6;

/** A triple is rejected as collinear when `sin^2(angle between its two edge
 * vectors) < COLLINEAR_SIN_SQ_EPSILON`. `1e-8` rejects angles below
 * ~0.0057 degrees: tight enough that any 3 points a human could plausibly
 * intend as a non-degenerate triangle pass, loose enough to reject the
 * genuinely ill-conditioned (near-singular `H`) cases that would make the
 * eigen-decomposition below numerically unreliable. */
export const COLLINEAR_SIN_SQ_EPSILON = 1e-8;

export type DegenerateTripleReason = 'coincident' | 'collinear';

export class DegenerateTripleError extends Error {
  /** Which triple is degenerate — `'src'`/`'dst'` for `checkTripleNonDegenerate`'s
   * per-triple coincident/collinear check (a property of ONE triple, in
   * isolation). `'combined'` is for the separate, rarer guard below
   * (`sigma1`/`sigma2` near-zero in `coarseAlignFromPointTriples`): BOTH
   * triples can individually pass `checkTripleNonDegenerate` and still
   * produce a (near-)singular cross-covariance `H`, because that
   * degeneracy is a property of how the two triples' PLANES RELATE to each
   * other, not of either triple alone — attributing it to `'src'` or
   * `'dst'` specifically would misleadingly suggest re-picking just one
   * side would fix it. */
  readonly which: 'src' | 'dst' | 'combined';
  readonly reason: DegenerateTripleReason;
  constructor(which: 'src' | 'dst' | 'combined', reason: DegenerateTripleReason) {
    super(
      which === 'combined'
        ? `coarseAlignFromPointTriples: src/dst triples are individually fine but their cross-covariance is ${reason} (degenerate — the two triples' planes relate in a way that admits no unique orientation; try different picks)`
        : `coarseAlignFromPointTriples: ${which} triple is ${reason} (degenerate — cannot define a plane/orientation)`,
    );
    this.name = 'DegenerateTripleError';
    this.which = which;
    this.reason = reason;
  }
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
function matVec(m: Mat3, v: Vec3): Vec3 {
  return [dot(m[0], v), dot(m[1], v), dot(m[2], v)];
}
/** Component `i` (0/1/2) of a `Vec3` — explicit branching (not `v[i]`)
 * because TypeScript's `noUncheckedIndexedAccess` treats a DYNAMIC (non-literal)
 * index into a fixed-length tuple as possibly out of range, unlike a
 * literal `v[0]`/`v[1]`/`v[2]`; used wherever this file needs to loop over
 * row/col with a plain `number` index. */
function vecAt(v: Vec3, i: number): number {
  return i === 0 ? v[0] : i === 1 ? v[1] : v[2];
}

function checkTripleNonDegenerate(pts: readonly [Vec3, Vec3, Vec3], which: 'src' | 'dst'): void {
  const [p0, p1, p2] = pts;
  for (const [a, b] of [
    [p0, p1],
    [p0, p2],
    [p1, p2],
  ] as const) {
    if (norm(sub(a, b)) < COINCIDENT_POINT_EPSILON_MM) {
      throw new DegenerateTripleError(which, 'coincident');
    }
  }
  const e1 = sub(p1, p0);
  const e2 = sub(p2, p0);
  const crossVec = cross(e1, e2);
  const crossNormSq = dot(crossVec, crossVec);
  const denom = dot(e1, e1) * dot(e2, e2);
  // sin^2(theta) = |e1 x e2|^2 / (|e1|^2 |e2|^2) — denom > 0 here since
  // neither edge is the zero vector (both endpoints already passed the
  // coincidence check above).
  const sinSq = crossNormSq / denom;
  if (sinSq < COLLINEAR_SIN_SQ_EPSILON) {
    throw new DegenerateTripleError(which, 'collinear');
  }
}

// ---------------------------------------------------------------------------
// Jacobi eigenvalue algorithm for a symmetric 3x3 matrix — classic cyclic
// sweep (Golub & Van Loan, "Matrix Computations", section 8.4). Deterministic
// (fixed (p,q) sweep order, no randomness); converges quadratically, so a
// small fixed sweep budget comfortably reaches machine precision for a 3x3.
// ---------------------------------------------------------------------------

const JACOBI_MAX_SWEEPS = 50;
const JACOBI_OFFDIAG_EPS = 1e-15;
const JACOBI_SWEEP_PAIRS: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, 2],
  [1, 2],
];

/** In-place-style symmetric 3x3 eigen-decomposition (input matrix is not
 * mutated — this function works on its own copy): returns eigenvalues
 * (order NOT guaranteed ascending/descending — the caller sorts) and the
 * corresponding eigenVECTORS as columns of a row-major 3x3 (`eigenvectors[.][k]`
 * is the k-th eigenvector). */
function jacobiEigenSymmetric3x3(aIn: Mat3): { eigenvalues: Vec3; eigenvectors: Mat3 } {
  const a: number[][] = aIn.map((row) => [...row]);
  const v: number[][] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (let sweep = 0; sweep < JACOBI_MAX_SWEEPS; sweep++) {
    const offDiag = Math.abs(a[0]![1]!) + Math.abs(a[0]![2]!) + Math.abs(a[1]![2]!);
    if (offDiag < JACOBI_OFFDIAG_EPS) break;

    for (const [p, q] of JACOBI_SWEEP_PAIRS) {
      const apq = a[p]![q]!;
      if (apq === 0) continue;
      const app = a[p]![p]!;
      const aqq = a[q]![q]!;
      const theta = (aqq - app) / (2 * apq);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;

      // Rotate A: A' = J^T A J for the (p,q) Givens plane.
      a[p]![p] = app - t * apq;
      a[q]![q] = aqq + t * apq;
      a[p]![q] = 0;
      a[q]![p] = 0;
      for (let k = 0; k < 3; k++) {
        if (k === p || k === q) continue;
        const akp = a[k]![p]!;
        const akq = a[k]![q]!;
        const newAkp = c * akp - s * akq;
        const newAkq = s * akp + c * akq;
        a[k]![p] = newAkp;
        a[p]![k] = newAkp;
        a[k]![q] = newAkq;
        a[q]![k] = newAkq;
      }
      // Accumulate eigenvectors: V' = V J.
      for (let k = 0; k < 3; k++) {
        const vkp = v[k]![p]!;
        const vkq = v[k]![q]!;
        v[k]![p] = c * vkp - s * vkq;
        v[k]![q] = s * vkp + c * vkq;
      }
    }
  }

  return {
    eigenvalues: [a[0]![0]!, a[1]![1]!, a[2]![2]!],
    eigenvectors: [
      [v[0]![0]!, v[0]![1]!, v[0]![2]!],
      [v[1]![0]!, v[1]![1]!, v[1]![2]!],
      [v[2]![0]!, v[2]![1]!, v[2]![2]!],
    ],
  };
}

function columnOf(m: Mat3, col: number): Vec3 {
  return [vecAt(m[0], col), vecAt(m[1], col), vecAt(m[2], col)];
}

/** `H^T H` (symmetric, positive semi-definite) for a row-major 3x3 `h`. */
function transposeTimesSelf(h: Mat3): Mat3 {
  const out: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i]![j] = vecAt(h[0], i) * vecAt(h[0], j) + vecAt(h[1], i) * vecAt(h[1], j) + vecAt(h[2], i) * vecAt(h[2], j);
    }
  }
  return [
    [out[0]![0]!, out[0]![1]!, out[0]![2]!],
    [out[1]![0]!, out[1]![1]!, out[1]![2]!],
    [out[2]![0]!, out[2]![1]!, out[2]![2]!],
  ];
}

export interface CoarseAlignResult {
  /** Column-major 16-number rigid transform mapping SRC onto DST — see
   * transform.ts's module doc for the exact layout (`SceneNode.transform`
   * convention). */
  transform: Mat4;
}

/**
 * Closed-form rigid alignment from exactly 3 correspondences — see this
 * file's module doc for the algorithm and its `@errorBound`.
 *
 * @throws {DegenerateTripleError} if either triple's 3 points are
 * (near-)coincident or (near-)collinear.
 */
export function coarseAlignFromPointTriples(
  srcPts: readonly [Vec3, Vec3, Vec3],
  dstPts: readonly [Vec3, Vec3, Vec3],
): CoarseAlignResult {
  checkTripleNonDegenerate(srcPts, 'src');
  checkTripleNonDegenerate(dstPts, 'dst');

  const centroidSrc: Vec3 = [
    (srcPts[0][0] + srcPts[1][0] + srcPts[2][0]) / 3,
    (srcPts[0][1] + srcPts[1][1] + srcPts[2][1]) / 3,
    (srcPts[0][2] + srcPts[1][2] + srcPts[2][2]) / 3,
  ];
  const centroidDst: Vec3 = [
    (dstPts[0][0] + dstPts[1][0] + dstPts[2][0]) / 3,
    (dstPts[0][1] + dstPts[1][1] + dstPts[2][1]) / 3,
    (dstPts[0][2] + dstPts[1][2] + dstPts[2][2]) / 3,
  ];

  const p = srcPts.map((pt) => sub(pt, centroidSrc)) as [Vec3, Vec3, Vec3];
  const q = dstPts.map((pt) => sub(pt, centroidDst)) as [Vec3, Vec3, Vec3];

  // H = sum_i p_i q_i^T (row-major: H[row][col] = sum_i p_i[row] * q_i[col]).
  const hArr: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    const pi = p[i]!;
    const qi = q[i]!;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        hArr[row]![col] = hArr[row]![col]! + vecAt(pi, row) * vecAt(qi, col);
      }
    }
  }
  const h: Mat3 = [
    [hArr[0]![0]!, hArr[0]![1]!, hArr[0]![2]!],
    [hArr[1]![0]!, hArr[1]![1]!, hArr[1]![2]!],
    [hArr[2]![0]!, hArr[2]![1]!, hArr[2]![2]!],
  ];

  // H^T H (symmetric PSD) -> eigenvectors = H's right singular vectors (V).
  const { eigenvalues, eigenvectors } = jacobiEigenSymmetric3x3(transposeTimesSelf(h));

  // Sort descending by eigenvalue — v1/v2 (largest two) are well-conditioned
  // for a non-degenerate triple pair (see module doc: the 3rd is ~0 for
  // N=3, always, since 3 centered points span at most a 2-D subspace).
  const order = [0, 1, 2].sort((a, b) => eigenvalues[b]! - eigenvalues[a]!);
  const v1 = columnOf(eigenvectors, order[0]!);
  const v2raw = columnOf(eigenvectors, order[1]!);
  const lambda1 = Math.max(eigenvalues[order[0]!]!, 0);
  const lambda2 = Math.max(eigenvalues[order[1]!]!, 0);
  const sigma1 = Math.sqrt(lambda1);
  const sigma2 = Math.sqrt(lambda2);

  if (sigma1 < 1e-12) {
    // Both triples already passed the individual collinearity check, but H
    // can still be (near-)singular in rank if the two triples' planes
    // relate in a degenerate way — vanishingly rare for real picks, but
    // guarded rather than dividing by ~0 below. Fix batch: this is NOT a
    // property of `src` or `dst` alone (both already passed
    // `checkTripleNonDegenerate` individually) — it's the pair's combined
    // cross-covariance that's singular, so `which` says so honestly
    // (`'combined'`) rather than pinning blame on an arbitrarily-chosen
    // side — see `DegenerateTripleError.which`'s doc.
    throw new DegenerateTripleError('combined', 'collinear');
  }
  if (sigma2 < 1e-9 * sigma1) {
    throw new DegenerateTripleError('combined', 'collinear');
  }

  // Re-orthonormalize v2 against v1 (Jacobi already returns orthonormal
  // eigenvectors for distinct eigenvalues to machine precision; this is a
  // defensive Gram-Schmidt pass for the near-equal-eigenvalue edge case).
  const v2orth = sub(v2raw, scale(v1, dot(v2raw, v1)));
  const v2 = scale(v2orth, 1 / norm(v2orth));
  const v3 = cross(v1, v2);

  const u1 = scale(matVec(h, v1), 1 / sigma1);
  const u2orth = sub(matVec(h, v2), scale(u1, dot(matVec(h, v2), u1)));
  const u2 = scale(u2orth, 1 / (norm(u2orth) || 1));
  const u3 = cross(u1, u2);

  // R = V U^T = sum_i v_i u_i^T (row-major: R[row][col] = sum_i v_i[row] * u_i[col]).
  // det(R) = +1 automatically: V=[v1|v2|v3] and U=[u1|u2|u3] are both
  // constructed right-handed (v3=v1xv2, u3=u1xu2), so det(V)=det(U)=+1 —
  // see this file's module doc for why this needs no separate reflection fix.
  const rArr: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const vs: readonly Vec3[] = [v1, v2, v3];
  const us: readonly Vec3[] = [u1, u2, u3];
  for (let i = 0; i < 3; i++) {
    const vi = vs[i]!;
    const ui = us[i]!;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        rArr[row]![col] = rArr[row]![col]! + vecAt(vi, row) * vecAt(ui, col);
      }
    }
  }
  const rotation: Mat3 = [
    [rArr[0]![0]!, rArr[0]![1]!, rArr[0]![2]!],
    [rArr[1]![0]!, rArr[1]![1]!, rArr[1]![2]!],
    [rArr[2]![0]!, rArr[2]![1]!, rArr[2]![2]!],
  ];

  const translation = sub(centroidDst, matVec(rotation, centroidSrc));
  return { transform: composeRigid(rotation, translation) };
}
