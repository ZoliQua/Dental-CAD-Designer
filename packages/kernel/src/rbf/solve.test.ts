// packages/kernel/src/rbf/solve.test.ts
//
// Phase 4 Task 6 — the dense direct solver (rbf/solve.ts). Proves: it solves a
// HAND-COMPUTED system exactly (to Float64 precision), handles multiple RHS,
// is byte-deterministic (the Task-6 crux), rejects singular systems, and — a
// property check — recovers a known x from a well-conditioned A·x=b.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { solveDense, solveDenseSingle, SingularMatrixError } from './index.ts';

describe('solveDense — analytic / hand-computed', () => {
  it('solves a 3×3 system exactly (x=2, y=3, z=-1)', () => {
    // 2x + y - z = 8
    // -3x - y + 2z = -11
    // -2x + y + 2z = -3
    const A = new Float64Array([2, 1, -1, -3, -1, 2, -2, 1, 2]);
    const b = new Float64Array([8, -11, -3]);
    const x = solveDenseSingle(A, 3, b);
    expect(x[0]!).toBeCloseTo(2, 12);
    expect(x[1]!).toBeCloseTo(3, 12);
    expect(x[2]!).toBeCloseTo(-1, 12);
  });

  it('solves a diagonal system trivially and exactly', () => {
    const A = new Float64Array([4, 0, 0, 0, 2, 0, 0, 0, 5]);
    const b = new Float64Array([8, 6, 20]);
    const x = solveDenseSingle(A, 3, b);
    expect(x).toEqual([2, 3, 4]);
  });

  it('requires partial pivoting: a zero leading pivot still solves', () => {
    // Row 0 has a zero in column 0 — naive elimination would divide by zero;
    // partial pivoting swaps in row 1.
    const A = new Float64Array([0, 2, 1, 3, 0, 0, 1, 1, 1]);
    const b = new Float64Array([5, 9, 6]); // 3x=9 -> x=3; 2y+z=5; x+y+z=6 -> y+z=3 -> y=2,z=1
    const x = solveDenseSingle(A, 3, b);
    expect(x[0]!).toBeCloseTo(3, 12);
    expect(x[1]!).toBeCloseTo(2, 12);
    expect(x[2]!).toBeCloseTo(1, 12);
  });

  it('solves multiple right-hand sides against one matrix (identity RHS -> inverse)', () => {
    // A = [[2,0],[0,4]] ; solve A X = I -> X = A^{-1} = diag(1/2, 1/4)
    const A = new Float64Array([2, 0, 0, 4]);
    const I = new Float64Array([1, 0, 0, 1]);
    const X = solveDense(A, 2, I, 2);
    expect(Array.from(X)).toEqual([0.5, 0, 0, 0.25]);
  });
});

describe('solveDense — determinism (Task-6 crux)', () => {
  it('produces byte-identical Float64 output across two runs', () => {
    const A = new Float64Array([2.3, -1.1, 0.7, 0.4, 5.6, -2.2, -1.9, 0.3, 4.8]);
    const B = new Float64Array([1.1, 2.2, -3.3, 4.4, 0.5, -0.6]); // n=3, m=2
    const x1 = solveDense(A, 3, B, 2);
    const x2 = solveDense(A, 3, B, 2);
    expect(Buffer.from(x2.buffer)).toEqual(Buffer.from(x1.buffer)); // byte identity
  });

  it('does not mutate its inputs', () => {
    const A = new Float64Array([2, 1, -1, -3, -1, 2, -2, 1, 2]);
    const b = new Float64Array([8, -11, -3]);
    const Acopy = Float64Array.from(A);
    const bcopy = Float64Array.from(b);
    solveDense(A, 3, b, 1);
    expect(A).toEqual(Acopy);
    expect(b).toEqual(bcopy);
  });
});

describe('solveDense — singular systems', () => {
  it('throws SingularMatrixError for a rank-deficient matrix', () => {
    // Two identical rows -> singular.
    const A = new Float64Array([1, 2, 3, 1, 2, 3, 4, 5, 6]);
    const b = new Float64Array([1, 1, 1]);
    expect(() => solveDenseSingle(A, 3, b)).toThrow(SingularMatrixError);
  });

  it('throws on a zero column', () => {
    const A = new Float64Array([0, 1, 0, 3]); // column 0 all zero
    const b = new Float64Array([1, 2]);
    expect(() => solveDenseSingle(A, 2, b)).toThrow(SingularMatrixError);
  });
});

describe('solveDense — dimension guards', () => {
  it('throws RangeError on inconsistent A/B sizes', () => {
    expect(() => solveDense(new Float64Array([1, 2, 3]), 2, new Float64Array([1, 2]), 1)).toThrow(RangeError);
    expect(() => solveDense(new Float64Array([1, 0, 0, 1]), 2, new Float64Array([1]), 1)).toThrow(RangeError);
  });

  it('returns an empty result for n=0', () => {
    expect(solveDense(new Float64Array(0), 0, new Float64Array(0), 3).length).toBe(0);
  });
});

describe('solveDense — property: recovers a known solution', () => {
  it('for a diagonally-dominant (well-conditioned) A, A·x_true=b -> solve gives x_true', () => {
    fc.assert(
      fc.property(
        fc.record({
          n: fc.integer({ min: 1, max: 6 }),
          seed: fc.integer({ min: 1, max: 1_000_000 }),
        }),
        ({ n, seed }) => {
          // Deterministic pseudo-random fill (no Math.random in the test path).
          let s = seed >>> 0;
          const rnd = (): number => {
            s = (s * 1664525 + 1013904223) >>> 0;
            return s / 0xffffffff; // [0,1)
          };
          const A = new Float64Array(n * n);
          for (let i = 0; i < n; i++) {
            let rowAbs = 0;
            for (let j = 0; j < n; j++) {
              if (i !== j) {
                const v = rnd() * 2 - 1;
                A[i * n + j] = v;
                rowAbs += Math.abs(v);
              }
            }
            // Strict diagonal dominance -> guaranteed non-singular, well-conditioned.
            A[i * n + i] = rowAbs + 1 + rnd();
          }
          const xTrue = new Float64Array(n);
          for (let i = 0; i < n; i++) xTrue[i] = rnd() * 20 - 10;
          const b = new Float64Array(n);
          for (let i = 0; i < n; i++) {
            let acc = 0;
            for (let j = 0; j < n; j++) acc += A[i * n + j]! * xTrue[j]!;
            b[i] = acc;
          }
          const x = solveDenseSingle(A, n, b);
          for (let i = 0; i < n; i++) expect(x[i]!).toBeCloseTo(xTrue[i]!, 8);
        },
      ),
      { numRuns: 200 },
    );
  });
});
