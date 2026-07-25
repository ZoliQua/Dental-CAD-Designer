// packages/kernel/src/rbf/rbf.ts
//
// Phase 4 Task 6 — a scattered-data RADIAL-BASIS-FUNCTION interpolant for a
// VECTOR-valued displacement field, the engine of the anatomy morph
// (anatomy/morph.ts). Given control points cᵢ each carrying a prescribed
// displacement dᵢ (∈ ℝ³), it fits a smooth field
//
//     s(x) = Σᵢ wᵢ · φ(‖x − cᵢ‖)  +  P(x)
//
// that reproduces every prescribed displacement EXACTLY at its control point
// (s(cⱼ) = dⱼ), and evaluates s at any query point.
//
// ## Kernel φ and polynomial term (the formulation, documented)
//
//  - **φ(r) = r** — the polyharmonic / "biharmonic" spline in 3-D. Chosen over
//    the thin-plate spline r²·log r (that is the 2-D biharmonic) and over a
//    Gaussian/multiquadric because φ(r)=r has **NO shape parameter** (no ε to
//    tune): the field is fully determined by the control points alone. That
//    matters twice over for Task 6 — one fewer journaled hyperparameter, and
//    nothing whose choice could silently change the result. It is the standard
//    volumetric-deformation kernel (Botsch & Kobbelt, "Real-Time Shape Editing
//    using Radial Basis Functions").
//  - **P(x) = a₀ + a₁x + a₂y + a₃z** — a degree-1 (affine) polynomial term. It
//    makes the interpolant CONDITIONALLY positive definite for φ(r)=r (the
//    required side/orthogonality conditions Σwᵢ = 0 and Σwᵢcᵢ = 0 are appended
//    below), and it lets the field reproduce ANY affine displacement (a pure
//    translation/rotation/scale of the control constraints) exactly, with zero
//    RBF weights — so anchoring a region and translating a contact produces a
//    clean localized bump, not a warped whole.
//
// ## The saddle-point (KKT) system
//
// With N control points, weights w (N×3) and polynomial coefficients v (4×3)
// solve, per displacement component, the SAME (N+4)×(N+4) symmetric system:
//
//     ⎡ A   P ⎤ ⎡ w ⎤   ⎡ d ⎤        Aᵢⱼ = φ(‖cᵢ − cⱼ‖)   (N×N; diag = φ(0) = 0)
//     ⎢       ⎥ ⎢   ⎥ = ⎢   ⎥        P    = [1, xᵢ, yᵢ, zᵢ] (N×4)
//     ⎣ Pᵀ  0 ⎦ ⎣ v ⎦   ⎣ 0 ⎦        bottom 4 RHS rows = 0 (the side conditions)
//
// This matrix is symmetric but INDEFINITE (the zero block), so it is NOT SPD —
// Cholesky does not apply. It is solved by the deterministic dense LU-with-
// partial-pivoting solver (rbf/solve.ts). The three displacement components
// (x/y/z) share one matrix, solved as a 3-column multiple-RHS — one
// factorization, three back-solves.
//
// ## Determinism
//
// Pure Float64 arithmetic in fixed order; the solve is direct + deterministic
// (rbf/solve.ts). Same control points + prescribed displacements ⇒ byte-
// identical field ⇒ byte-identical applied displacement. An all-zero
// prescribed set short-circuits to the exact zero field (guaranteeing the
// morph's 0-strength ≡ identity property even for a control set that would be
// rank-deficient for the polynomial, e.g. a single coplanar anchor ring).
import type { Vec3 } from '../bvh/geometry.ts';
import { solveDense } from './solve.ts';

/** Number of degree-1 polynomial terms: 1, x, y, z. */
export const RBF_POLY_TERMS = 4;

/** The biharmonic (3-D polyharmonic degree-1) basis: φ(r) = r. Parameter-free
 * — see this module's doc for why that is the deliberate choice. */
export function rbfPhi(r: number): number {
  return r;
}

/** One control point: pin the field's displacement at `center` to `value`. */
export interface RbfControlPoint {
  readonly center: Vec3;
  readonly value: Vec3;
}

/** A fitted vector-valued RBF field. `centers` (n×3), `weights` (n×3) and
 * `poly` (4×3, rows = [const, x, y, z] coeffs) are flat row-major Float64. */
export interface RbfField {
  readonly centers: Float64Array;
  readonly weights: Float64Array;
  readonly poly: Float64Array;
  readonly count: number;
}

function distance(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return Math.hypot(ax - bx, ay - by, az - bz);
}

/**
 * Fit the RBF displacement field to `controls` (see this module's doc for the
 * saddle-point system). Returns the field; evaluate it with `evaluateRbf` /
 * apply it with `applyRbfDisplacement`.
 *
 * An empty control set, or one whose prescribed displacements are ALL exactly
 * zero, returns the exact zero field (no solve) — see the module doc.
 *
 * @throws {SingularMatrixError} (from `solveDense`) if the control centers are
 * not unisolvent for the degree-1 polynomial (e.g. all coplanar) AND the
 * displacements are not all zero.
 */
export function fitRbf(controls: readonly RbfControlPoint[]): RbfField {
  const n = controls.length;
  const centers = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    centers[i * 3] = controls[i]!.center[0];
    centers[i * 3 + 1] = controls[i]!.center[1];
    centers[i * 3 + 2] = controls[i]!.center[2];
  }

  const zeroPoly = new Float64Array(RBF_POLY_TERMS * 3);
  if (n === 0) {
    return { centers, weights: new Float64Array(0), poly: zeroPoly, count: 0 };
  }

  let allZero = true;
  for (let i = 0; i < n; i++) {
    const v = controls[i]!.value;
    if (v[0] !== 0 || v[1] !== 0 || v[2] !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) {
    // The exact solution is w = 0, poly = 0 — return it without a solve so the
    // zero field holds even for a rank-deficient (e.g. coplanar) control set.
    return { centers, weights: new Float64Array(n * 3), poly: zeroPoly, count: n };
  }

  const size = n + RBF_POLY_TERMS;
  const M = new Float64Array(size * size);
  const B = new Float64Array(size * 3);

  for (let i = 0; i < n; i++) {
    const cix = centers[i * 3]!;
    const ciy = centers[i * 3 + 1]!;
    const ciz = centers[i * 3 + 2]!;
    for (let j = 0; j < n; j++) {
      const r = distance(cix, ciy, ciz, centers[j * 3]!, centers[j * 3 + 1]!, centers[j * 3 + 2]!);
      M[i * size + j] = rbfPhi(r);
    }
    // Polynomial block P (right of A) and its transpose Pᵀ (below A).
    const p0 = n;
    M[i * size + p0] = 1;
    M[i * size + p0 + 1] = cix;
    M[i * size + p0 + 2] = ciy;
    M[i * size + p0 + 3] = ciz;
    M[(p0) * size + i] = 1;
    M[(p0 + 1) * size + i] = cix;
    M[(p0 + 2) * size + i] = ciy;
    M[(p0 + 3) * size + i] = ciz;
    // RHS: prescribed displacement (bottom 4 rows stay zero = side conditions).
    B[i * 3] = controls[i]!.value[0];
    B[i * 3 + 1] = controls[i]!.value[1];
    B[i * 3 + 2] = controls[i]!.value[2];
  }

  const X = solveDense(M, size, B, 3); // size×3 row-major
  const weights = new Float64Array(n * 3);
  for (let i = 0; i < n * 3; i++) weights[i] = X[i]!;
  const poly = new Float64Array(RBF_POLY_TERMS * 3);
  for (let i = 0; i < RBF_POLY_TERMS * 3; i++) poly[i] = X[n * 3 + i]!;

  return { centers, weights, poly, count: n };
}

/** Evaluate the fitted field's displacement at `x`. */
export function evaluateRbf(field: RbfField, x: Vec3): Vec3 {
  const { centers, weights, poly, count } = field;
  // Polynomial part P(x) = a₀ + a₁x + a₂y + a₃z, per component.
  let dx = poly[0]! + poly[3]! * x[0] + poly[6]! * x[1] + poly[9]! * x[2];
  let dy = poly[1]! + poly[4]! * x[0] + poly[7]! * x[1] + poly[10]! * x[2];
  let dz = poly[2]! + poly[5]! * x[0] + poly[8]! * x[1] + poly[11]! * x[2];
  for (let i = 0; i < count; i++) {
    const r = distance(x[0], x[1], x[2], centers[i * 3]!, centers[i * 3 + 1]!, centers[i * 3 + 2]!);
    const phi = rbfPhi(r);
    dx += weights[i * 3]! * phi;
    dy += weights[i * 3 + 1]! * phi;
    dz += weights[i * 3 + 2]! * phi;
  }
  return [dx, dy, dz];
}

/**
 * Apply the field as a DISPLACEMENT to a flat xyz position buffer: returns a
 * NEW Float64Array where each vertex is `x + s(x)`. The input buffer is not
 * mutated (immutable-mesh discipline — callers wrap the result in a new mesh).
 */
export function applyRbfDisplacement(field: RbfField, positions: Float64Array): Float64Array {
  const count = field.count;
  const out = new Float64Array(positions.length);
  const n = positions.length / 3;
  // Fast path: the zero field leaves positions unchanged (bit-identical copy).
  if (count === 0 && isZero(field.poly)) {
    out.set(positions);
    return out;
  }
  let weightsAllZero = true;
  for (let i = 0; i < field.weights.length; i++) {
    if (field.weights[i] !== 0) {
      weightsAllZero = false;
      break;
    }
  }
  if (weightsAllZero && isZero(field.poly)) {
    out.set(positions);
    return out;
  }
  for (let v = 0; v < n; v++) {
    const x: Vec3 = [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];
    const d = evaluateRbf(field, x);
    out[v * 3] = x[0] + d[0];
    out[v * 3 + 1] = x[1] + d[1];
    out[v * 3 + 2] = x[2] + d[2];
  }
  return out;
}

function isZero(a: Float64Array): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== 0) return false;
  return true;
}
