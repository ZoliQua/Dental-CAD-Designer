// packages/kernel/src/rbf/solve.ts
//
// Phase 4 Task 6 — a small, dense, DIRECT Float64 linear-system solver, built
// for the RBF-morph weight solve (rbf/rbf.ts) whose determinism bar is the
// whole point of Task 6 (CLAUDE.md invariant 2). No linear-algebra solver
// existed in the kernel before this; this one is deliberately minimal (dense,
// no sparsity, no BLAS) — the RBF systems it solves are (control-point +
// 4)-square, a few hundred at most, so O(n³) Gaussian elimination is
// milliseconds and correctness/determinism beat cleverness (the accuracy-over-
// speed rule).
//
// ## Why a DIRECT solve, deterministically (the crux)
//
// The morph must be journal-reproducible: same constraints + params + kernel
// version ⇒ BYTE-IDENTICAL morphed mesh. An iterative solver that stops on a
// residual tolerance has an iteration count that can vary with rounding, so
// its output is not guaranteed bit-identical run to run. A DIRECT factorization
// (Gaussian elimination) performs a FIXED arithmetic sequence determined only
// by the input values — no convergence loop, no tolerance — so the same input
// produces byte-identical Float64 output every time.
//
// ## Partial pivoting with a DETERMINISTIC tie-break
//
// Partial pivoting (swap in the row with the largest |pivot| in the current
// column) is required for numerical stability. The pivot search here breaks
// exact ties by LOWEST row index — the comparison is strict `>` (a later row
// replaces the current best ONLY if strictly larger), so the earliest maximal
// row always wins. This mirrors the kernel's other deterministic tie-breaks
// (bvh/closestPoint.ts's "lowest triangle index wins on exact ties"). The
// pivot sequence is therefore a pure function of the input matrix, and so is
// every subsequent arithmetic operation.
import type { Vec3 } from '../bvh/geometry.ts';

export class SingularMatrixError extends Error {
  constructor(message: string) {
    super(`rbf/solve: ${message}`);
    this.name = 'SingularMatrixError';
  }
}

/**
 * A pivot whose magnitude is at or below `SOLVE_SINGULAR_PIVOT_EPSILON ×
 * max(1, ‖A‖_max)` (the matrix's largest-magnitude initial entry) is treated
 * as singular — the system has no unique solution (e.g. an RBF control set
 * that is not unisolvent for the degree-1 polynomial: all centers coplanar).
 * Relative to the matrix scale so it is meaningful at any coordinate
 * magnitude. `1e-12` is ~4 orders above Float64 epsilon, tight enough to admit
 * every well-posed RBF system built here yet reject a genuinely rank-deficient
 * one.
 */
export const SOLVE_SINGULAR_PIVOT_EPSILON = 1e-12;

/**
 * Solve `A · X = B` for `X`, where `A` is `n×n` and `B` is `n×m`, both stored
 * ROW-MAJOR in Float64Array (`A[row*n + col]`, `B[row*m + col]`). Returns `X`
 * as a fresh `n×m` row-major Float64Array. Gaussian elimination with partial
 * pivoting (see this module's doc for the determinism guarantees). The `m`
 * right-hand sides are eliminated together (one factorization, m back-solves)
 * — the RBF morph solves the x/y/z displacement components against ONE shared
 * system matrix, so `m = 3`.
 *
 * Neither `A` nor `B` is mutated (both are copied into private working
 * buffers).
 *
 * @throws {SingularMatrixError} if a column has no usable pivot (see
 * `SOLVE_SINGULAR_PIVOT_EPSILON`).
 * @throws {RangeError} on inconsistent dimensions.
 */
export function solveDense(A: Float64Array, n: number, B: Float64Array, m: number): Float64Array {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`solveDense: n must be a non-negative integer, got ${n}`);
  if (!Number.isInteger(m) || m < 0) throw new RangeError(`solveDense: m must be a non-negative integer, got ${m}`);
  if (A.length !== n * n) throw new RangeError(`solveDense: A must have n*n=${n * n} entries, got ${A.length}`);
  if (B.length !== n * m) throw new RangeError(`solveDense: B must have n*m=${n * m} entries, got ${B.length}`);
  if (n === 0) return new Float64Array(0);

  // Private working copies (inputs are never mutated).
  const work = Float64Array.from(A);
  const rhs = Float64Array.from(B);

  // Scale for the relative singularity threshold: the largest |entry| of A.
  let scale = 0;
  for (let i = 0; i < work.length; i++) {
    const a = Math.abs(work[i]!);
    if (a > scale) scale = a;
  }
  const pivotFloor = SOLVE_SINGULAR_PIVOT_EPSILON * Math.max(1, scale);

  // Forward elimination with partial pivoting.
  for (let k = 0; k < n; k++) {
    // Deterministic partial pivot: largest |A[r][k]| among r >= k, lowest row
    // index wins on a tie (strict `>`).
    let pivotRow = k;
    let maxAbs = Math.abs(work[k * n + k]!);
    for (let r = k + 1; r < n; r++) {
      const a = Math.abs(work[r * n + k]!);
      if (a > maxAbs) {
        maxAbs = a;
        pivotRow = r;
      }
    }
    if (maxAbs <= pivotFloor) {
      throw new SingularMatrixError(`no usable pivot in column ${k} (|pivot|=${maxAbs} <= ${pivotFloor})`);
    }
    if (pivotRow !== k) {
      swapRows(work, n, k, pivotRow);
      swapRows(rhs, m, k, pivotRow);
    }
    const pivot = work[k * n + k]!;
    for (let r = k + 1; r < n; r++) {
      const factor = work[r * n + k]! / pivot;
      if (factor === 0) continue;
      work[r * n + k] = 0;
      for (let c = k + 1; c < n; c++) {
        work[r * n + c] = work[r * n + c]! - factor * work[k * n + c]!;
      }
      for (let c = 0; c < m; c++) {
        rhs[r * m + c] = rhs[r * m + c]! - factor * rhs[k * m + c]!;
      }
    }
  }

  // Back substitution (writes the solution in place over `rhs`).
  for (let k = n - 1; k >= 0; k--) {
    const pivot = work[k * n + k]!;
    for (let c = 0; c < m; c++) {
      let s = rhs[k * m + c]!;
      for (let j = k + 1; j < n; j++) {
        s -= work[k * n + j]! * rhs[j * m + c]!;
      }
      rhs[k * m + c] = s / pivot;
    }
  }
  return rhs;
}

function swapRows(mat: Float64Array, cols: number, a: number, b: number): void {
  for (let c = 0; c < cols; c++) {
    const tmp = mat[a * cols + c]!;
    mat[a * cols + c] = mat[b * cols + c]!;
    mat[b * cols + c] = tmp;
  }
}

/** Convenience: solve `A · x = b` for a single right-hand side (`m = 1`),
 * returning `x` as a plain number[] of length `n`. */
export function solveDenseSingle(A: Float64Array, n: number, b: Float64Array): number[] {
  const x = solveDense(A, n, b, 1);
  return Array.from(x);
}

/** Small helper the RBF builder shares: squared Euclidean distance between two
 * `Vec3`s (kept here so both the solver's own tests and rbf.ts can use it). */
export function distanceVec3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
