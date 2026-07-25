// packages/kernel/src/rbf/rbf.test.ts
//
// Phase 4 Task 6 — the RBF displacement interpolant (rbf/rbf.ts). Proves the
// core interpolation contract (s(cⱼ) = dⱼ exactly), affine reproduction (the
// degree-1 polynomial term reproduces a pure translation with zero weights),
// the zero-field short-circuit (0-strength ≡ identity), and byte determinism.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  fitRbf,
  evaluateRbf,
  applyRbfDisplacement,
  rbfPhi,
  type RbfControlPoint,
  type Vec3,
} from './index.ts';

const NON_COPLANAR: Vec3[] = [
  [0, 0, 0],
  [3, 0, 0],
  [0, 2, 0],
  [0, 0, 4],
  [1, 1, 1],
  [-2, 1, 3],
];

describe('rbfPhi', () => {
  it('is the biharmonic kernel φ(r)=r', () => {
    expect(rbfPhi(0)).toBe(0);
    expect(rbfPhi(2.5)).toBe(2.5);
  });
});

describe('fitRbf / evaluateRbf — interpolation contract', () => {
  it('reproduces every prescribed displacement exactly at its control point', () => {
    const controls: RbfControlPoint[] = NON_COPLANAR.map((c, i) => ({
      center: c,
      value: [Math.sin(i), Math.cos(i * 1.7), 0.3 * i - 0.5] as Vec3,
    }));
    const field = fitRbf(controls);
    for (const ctrl of controls) {
      const d = evaluateRbf(field, ctrl.center);
      expect(d[0]).toBeCloseTo(ctrl.value[0], 9);
      expect(d[1]).toBeCloseTo(ctrl.value[1], 9);
      expect(d[2]).toBeCloseTo(ctrl.value[2], 9);
    }
  });

  it('reproduces a pure affine (translation) displacement everywhere with ~zero weights', () => {
    const t: Vec3 = [1.5, -2.0, 0.75];
    const controls: RbfControlPoint[] = NON_COPLANAR.map((c) => ({ center: c, value: t }));
    const field = fitRbf(controls);
    // Weights should be ~0 (the polynomial alone reproduces a constant field).
    for (let i = 0; i < field.weights.length; i++) expect(field.weights[i]!).toBeCloseTo(0, 8);
    // The field equals the translation at an arbitrary off-control query point.
    const d = evaluateRbf(field, [7, -3, 5]);
    expect(d[0]).toBeCloseTo(t[0], 7);
    expect(d[1]).toBeCloseTo(t[1], 7);
    expect(d[2]).toBeCloseTo(t[2], 7);
  });

  it('reproduces a linear displacement field d(x)=L·x exactly (affine reproduction)', () => {
    // A linear map: d(x) = [0.2x - 0.1y, 0.3z, -0.05x + 0.4y].
    const lin = (x: Vec3): Vec3 => [0.2 * x[0] - 0.1 * x[1], 0.3 * x[2], -0.05 * x[0] + 0.4 * x[1]];
    const controls: RbfControlPoint[] = NON_COPLANAR.map((c) => ({ center: c, value: lin(c) }));
    const field = fitRbf(controls);
    for (let i = 0; i < field.weights.length; i++) expect(field.weights[i]!).toBeCloseTo(0, 7);
    const q: Vec3 = [4, -6, 2];
    const d = evaluateRbf(field, q);
    const expected = lin(q);
    expect(d[0]).toBeCloseTo(expected[0], 6);
    expect(d[1]).toBeCloseTo(expected[1], 6);
    expect(d[2]).toBeCloseTo(expected[2], 6);
  });
});

describe('fitRbf — zero-field short-circuit (0-strength ≡ identity)', () => {
  it('returns the exact zero field for all-zero displacements (even a coplanar ring)', () => {
    // A coplanar ring (z=0) would be rank-deficient for the poly — but the
    // all-zero short-circuit returns the zero field without a solve.
    const ring: RbfControlPoint[] = [];
    for (let i = 0; i < 8; i++) {
      const th = (2 * Math.PI * i) / 8;
      ring.push({ center: [Math.cos(th), Math.sin(th), 0], value: [0, 0, 0] });
    }
    const field = fitRbf(ring);
    expect(field.weights.every((w) => w === 0)).toBe(true);
    expect(field.poly.every((p) => p === 0)).toBe(true);
    const positions = new Float64Array([1, 2, 3, -4, 5, -6]);
    const out = applyRbfDisplacement(field, positions);
    expect(Buffer.from(out.buffer)).toEqual(Buffer.from(positions.buffer)); // bit-identical
  });

  it('empty control set is the identity', () => {
    const field = fitRbf([]);
    const positions = new Float64Array([1, 2, 3]);
    expect(Array.from(applyRbfDisplacement(field, positions))).toEqual([1, 2, 3]);
  });
});

describe('applyRbfDisplacement', () => {
  it('applies x + s(x) and never mutates the input buffer', () => {
    const controls: RbfControlPoint[] = NON_COPLANAR.map((c, i) => ({ center: c, value: [0.1 * i, 0, 0] as Vec3 }));
    const field = fitRbf(controls);
    const positions = Float64Array.from(NON_COPLANAR.flat());
    const before = Float64Array.from(positions);
    const out = applyRbfDisplacement(field, positions);
    expect(positions).toEqual(before); // input untouched
    // Output at control[1] (value [0.1,0,0]) is displaced by 0.1 in x.
    expect(out[3]!).toBeCloseTo(NON_COPLANAR[1]![0] + 0.1, 8);
  });
});

describe('fitRbf — determinism (Task-6 crux)', () => {
  it('byte-identical field + applied positions across two fits', () => {
    const controls: RbfControlPoint[] = NON_COPLANAR.map((c, i) => ({
      center: c,
      value: [Math.sin(i * 2.1), 0.2 * i, Math.cos(i)] as Vec3,
    }));
    const f1 = fitRbf(controls);
    const f2 = fitRbf(controls);
    expect(Buffer.from(f1.weights.buffer)).toEqual(Buffer.from(f2.weights.buffer));
    expect(Buffer.from(f1.poly.buffer)).toEqual(Buffer.from(f2.poly.buffer));
    const positions = Float64Array.from([0.1, 0.2, 0.3, 9, 8, 7, -1, -2, -3]);
    const o1 = applyRbfDisplacement(f1, positions);
    const o2 = applyRbfDisplacement(f2, positions);
    expect(Buffer.from(o1.buffer)).toEqual(Buffer.from(o2.buffer));
  });
});

describe('fitRbf — property: interpolation holds for random non-degenerate controls', () => {
  it('s(cⱼ) = dⱼ for random 3-D control sets (guaranteed-distinct, non-coplanar centers)', () => {
    // Centers are a 3-D lattice (guaranteed distinct + non-coplanar) + a small
    // bounded jitter, so the control set is ALWAYS unisolvent — the test
    // exercises interpolation accuracy over many geometries WITHOUT relying on
    // fast-check's degenerate/duplicate-biased raw point clouds (Task-5 lesson:
    // don't seed a property around inputs the code legitimately rejects). Only
    // the displacements and the jitter are randomized.
    fc.assert(
      fc.property(
        fc.record({
          nx: fc.integer({ min: 2, max: 3 }),
          ny: fc.integer({ min: 2, max: 3 }),
          nz: fc.integer({ min: 2, max: 2 }),
          jitter: fc.double({ min: 0, max: 0.3, noNaN: true }),
          seed: fc.integer({ min: 1, max: 1_000_000 }),
        }),
        ({ nx, ny, nz, jitter, seed }) => {
          let s = seed >>> 0;
          const rnd = (): number => {
            s = (s * 1664525 + 1013904223) >>> 0;
            return s / 0xffffffff;
          };
          const controls: RbfControlPoint[] = [];
          for (let i = 0; i < nx; i++) {
            for (let j = 0; j < ny; j++) {
              for (let k = 0; k < nz; k++) {
                controls.push({
                  center: [
                    i * 2 + (rnd() - 0.5) * jitter,
                    j * 2 + (rnd() - 0.5) * jitter,
                    k * 2 + (rnd() - 0.5) * jitter,
                  ],
                  value: [(rnd() - 0.5) * 3, (rnd() - 0.5) * 3, (rnd() - 0.5) * 3],
                });
              }
            }
          }
          const field = fitRbf(controls);
          for (const ctrl of controls) {
            const out = evaluateRbf(field, ctrl.center);
            expect(out[0]).toBeCloseTo(ctrl.value[0], 5);
            expect(out[1]).toBeCloseTo(ctrl.value[1], 5);
            expect(out[2]).toBeCloseTo(ctrl.value[2], 5);
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
