// packages/kernel/src/register/kabsch.analytic.test.ts
//
// Analytic coverage for coarseAlignFromPointTriples: exact recovery of a
// KNOWN rigid transform (machine precision), degenerate-triple rejection
// (both reasons, both which-triple), and a property-based sweep across many
// random rigid transforms + triples.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../bvh/geometry.ts';
import { applyMat4ToPoint, type Mat3 } from './transform.ts';
import { coarseAlignFromPointTriples, DegenerateTripleError } from './kabsch.ts';
import { applyRigid, rotationAboutAxis } from './register.test-fixtures.ts';

const SRC_TRIPLE: readonly [Vec3, Vec3, Vec3] = [
  [1, 0, 0],
  [0, 1.5, 0.2],
  [0.3, -0.4, 2],
];

describe('coarseAlignFromPointTriples — analytic: exact recovery', () => {
  it('recovers a known rigid transform to machine precision', () => {
    const rotation = rotationAboutAxis([0.2, 0.7, -0.4], 0.9);
    const translation: Vec3 = [12.5, -3.2, 7.1];
    const dstTriple = SRC_TRIPLE.map((p) => applyRigid(rotation, translation, p)) as [Vec3, Vec3, Vec3];

    const { transform } = coarseAlignFromPointTriples(SRC_TRIPLE, dstTriple);

    // Check against several OTHER points (not just the 3 used to solve),
    // confirming a genuine rigid transform was recovered, not merely one
    // that happens to satisfy the 3 input constraints via some other map.
    const probes: readonly Vec3[] = [
      [3, -1, 4],
      [0, 0, 0],
      [-5, 2.2, 1.1],
      [10, 10, -10],
    ];
    for (const p of probes) {
      const expected = applyRigid(rotation, translation, p);
      const actual = applyMat4ToPoint(transform, p);
      expect(Math.hypot(actual[0] - expected[0], actual[1] - expected[1], actual[2] - expected[2])).toBeLessThan(
        1e-9,
      );
    }

    // Rotation block stays a proper orthonormal rotation (det +1, R^T R = I).
    const r: Mat3 = [
      [transform[0]!, transform[4]!, transform[8]!],
      [transform[1]!, transform[5]!, transform[9]!],
      [transform[2]!, transform[6]!, transform[10]!],
    ];
    const det =
      r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) -
      r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0]) +
      r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
    expect(det).toBeCloseTo(1, 9);
  });

  it('is invariant to which of the 3 correspondences is listed first (order of the pairs, not the points within a pair)', () => {
    const rotation = rotationAboutAxis([1, 0, 0], 1.2);
    const translation: Vec3 = [1, 2, 3];
    const dstTriple = SRC_TRIPLE.map((p) => applyRigid(rotation, translation, p)) as [Vec3, Vec3, Vec3];
    const a = coarseAlignFromPointTriples(SRC_TRIPLE, dstTriple);
    const reordered = coarseAlignFromPointTriples(
      [SRC_TRIPLE[1], SRC_TRIPLE[2], SRC_TRIPLE[0]],
      [dstTriple[1], dstTriple[2], dstTriple[0]],
    );
    for (const p of [[2, 2, 2], [-3, 1, 0]] as Vec3[]) {
      const pa = applyMat4ToPoint(a.transform, p);
      const pb = applyMat4ToPoint(reordered.transform, p);
      expect(Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2])).toBeLessThan(1e-8);
    }
  });
});

describe('coarseAlignFromPointTriples — degenerate triples rejected', () => {
  it('rejects a coincident src pair', () => {
    const src: [Vec3, Vec3, Vec3] = [[0, 0, 0], [0, 0, 0], [1, 1, 0]];
    const dst: [Vec3, Vec3, Vec3] = [[5, 5, 5], [6, 5, 5], [5, 6, 5]];
    expect(() => coarseAlignFromPointTriples(src, dst)).toThrow(DegenerateTripleError);
    try {
      coarseAlignFromPointTriples(src, dst);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DegenerateTripleError);
      expect((error as InstanceType<typeof DegenerateTripleError>).which).toBe('src');
      expect((error as InstanceType<typeof DegenerateTripleError>).reason).toBe('coincident');
    }
  });

  it('rejects a collinear dst triple', () => {
    const src: [Vec3, Vec3, Vec3] = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
    const dst: [Vec3, Vec3, Vec3] = [[0, 0, 0], [1, 0, 0], [2, 0, 0]];
    try {
      coarseAlignFromPointTriples(src, dst);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DegenerateTripleError);
      expect((error as InstanceType<typeof DegenerateTripleError>).which).toBe('dst');
      expect((error as InstanceType<typeof DegenerateTripleError>).reason).toBe('collinear');
    }
  });

  it('rejects a collinear src triple even when dst is fine', () => {
    const src: [Vec3, Vec3, Vec3] = [[0, 0, 0], [1, 0, 0], [2, 0, 0]];
    const dst: [Vec3, Vec3, Vec3] = [[0, 0, 0], [1, 1, 0], [0, 1, 1]];
    expect(() => coarseAlignFromPointTriples(src, dst)).toThrow(DegenerateTripleError);
  });
});

const PROPERTY_SEED = 20260715;

describe('coarseAlignFromPointTriples — property: recovers random rigid transforms exactly', () => {
  it('recovers arbitrary rigid transforms from arbitrary non-degenerate triples', () => {
    fc.assert(
      fc.property(
        fc.record({
          axis: fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 3, maxLength: 3 }),
          angle: fc.double({ min: 0.05, max: 3, noNaN: true }),
          translation: fc.array(fc.double({ min: -20, max: 20, noNaN: true }), { minLength: 3, maxLength: 3 }),
          triple: fc.array(
            fc.array(fc.double({ min: -10, max: 10, noNaN: true }), { minLength: 3, maxLength: 3 }),
            { minLength: 3, maxLength: 3 },
          ),
        }),
        ({ axis, angle, translation, triple }) => {
          const axisVec: Vec3 = [axis[0]!, axis[1]!, axis[2]!];
          fc.pre(Math.hypot(...axisVec) > 0.2);
          const srcTriple = triple.map((p) => [p[0]!, p[1]!, p[2]!]) as unknown as [Vec3, Vec3, Vec3];
          // Reject near-degenerate triples up front (fc.pre, not a try/catch)
          // — this property is about RECOVERY, degeneracy rejection is its
          // own dedicated test above.
          const [p0, p1, p2] = srcTriple;
          const e1: Vec3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
          const e2: Vec3 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
          const crossNorm = Math.hypot(
            e1[1] * e2[2] - e1[2] * e2[1],
            e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0],
          );
          fc.pre(crossNorm > 1);
          fc.pre(Math.hypot(...e1) > 0.5 && Math.hypot(...e2) > 0.5);

          const rotation = rotationAboutAxis(axisVec, angle);
          const t: Vec3 = [translation[0]!, translation[1]!, translation[2]!];
          const dstTriple = srcTriple.map((p) => applyRigid(rotation, t, p)) as [Vec3, Vec3, Vec3];

          const { transform } = coarseAlignFromPointTriples(srcTriple, dstTriple);
          const probe: Vec3 = [1.1, -2.2, 3.3];
          const expected = applyRigid(rotation, t, probe);
          const actual = applyMat4ToPoint(transform, probe);
          const err = Math.hypot(actual[0] - expected[0], actual[1] - expected[1], actual[2] - expected[2]);
          expect(err).toBeLessThan(1e-6);
        },
      ),
      { seed: PROPERTY_SEED, numRuns: 60 },
    );
  });
});
