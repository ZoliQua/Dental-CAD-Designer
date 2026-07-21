// packages/kernel/src/undercut/undercutScanIndices.test.ts
//
// Tests for undercutScanIndices/undercutScanBatchIndices (Phase 3 Task 9 —
// added so axis/suggestInsertionAxis.ts's ROI-restricted sweep can avoid
// `O(mesh triangleCount)` cost per direction; see undercutScan.ts's own doc
// for the measured 45s-whole-mesh-sweep motivation). The core contract this
// file verifies: `undercutScanIndices(mesh, bvh, d, indices)` produces
// EXACTLY the same per-triangle verdicts as a whole-mesh `undercutScan`
// restricted (after the fact) to the same `indices` — i.e. this is a pure
// "evaluate fewer triangles" optimization, never a different answer.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildBvh } from '../bvh/index.ts';
import { cubeMesh, icosphereMesh, openGridPatchMesh } from '../halfedge/halfedge.test-fixtures.ts';
import { undercutScan, undercutScanBatch, undercutScanIndices, undercutScanBatchIndices } from './undercutScan.ts';

describe('undercutScanIndices — agrees exactly with a whole-mesh undercutScan, restricted after the fact', () => {
  it('cube, axis-aligned direction: every index matches undercutScan\'s own full-mesh result', () => {
    const mesh = cubeMesh();
    const bvh = buildBvh(mesh);
    const d: [number, number, number] = [0, 0, 1];
    const whole = undercutScan(mesh, bvh, d);
    const indices = Uint32Array.from([0, 1, 4, 5, 8, 9]); // an arbitrary, non-contiguous subset
    const restricted = undercutScanIndices(mesh, bvh, d, indices);
    expect(restricted.undercut.length).toBe(indices.length);
    for (let i = 0; i < indices.length; i++) {
      const t = indices[i]!;
      expect(restricted.undercut[i]).toBe(whole.undercut[t]);
      expect(restricted.depthMm[i]).toBeCloseTo(whole.depthMm[t]!, 12);
    }
  });

  it('property: for a random subset of triangle indices, undercutScanIndices matches undercutScan exactly, across shapes/directions (fast-check)', () => {
    const shapes: Record<string, ReturnType<typeof cubeMesh>> = {
      cube: cubeMesh(1),
      icosphere: icosphereMesh(3, 1),
      grid: openGridPatchMesh(4, 4, 1),
    };
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(shapes)),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.array(fc.nat(), { minLength: 1, maxLength: 30 }),
        (shapeName, dx, dy, dz, rawIndices) => {
          const len = Math.hypot(dx, dy, dz);
          if (len < 1e-6) return; // skip degenerate near-zero directions
          const mesh = shapes[shapeName]!;
          const triangleCount = mesh.indices.length / 3;
          if (triangleCount === 0) return;
          const bvh = buildBvh(mesh);
          const d: [number, number, number] = [dx / len, dy / len, dz / len];
          const indices = Uint32Array.from(rawIndices.map((n) => n % triangleCount));
          const whole = undercutScan(mesh, bvh, d);
          const restricted = undercutScanIndices(mesh, bvh, d, indices);
          for (let i = 0; i < indices.length; i++) {
            const t = indices[i]!;
            expect(restricted.undercut[i]).toBe(whole.undercut[t]);
            expect(restricted.depthMm[i]).toBeCloseTo(whole.depthMm[t]!, 9);
          }
        },
      ),
      { numRuns: 40, seed: 20260716 },
    );
  });

  it('an empty indices array returns empty output, no error', () => {
    const mesh = cubeMesh();
    const bvh = buildBvh(mesh);
    const result = undercutScanIndices(mesh, bvh, [0, 0, 1], []);
    expect(result.undercut.length).toBe(0);
    expect(result.depthMm.length).toBe(0);
    expect(result.undercutTriangleCount).toBe(0);
    expect(result.maxDepthMm).toBe(0);
  });

  it('throws RangeError for an out-of-range index', () => {
    const mesh = cubeMesh();
    const bvh = buildBvh(mesh);
    const triangleCount = mesh.indices.length / 3;
    expect(() => undercutScanIndices(mesh, bvh, [0, 0, 1], [triangleCount])).toThrow(RangeError);
    expect(() => undercutScanIndices(mesh, bvh, [0, 0, 1], [-1])).toThrow(RangeError);
  });

  it('throws RangeError for a stale/mismatched bvh (same defense as undercutScan)', () => {
    const meshA = cubeMesh(1); // 12 triangles
    const meshB = icosphereMesh(3, 1); // a different triangle count
    const bvhB = buildBvh(meshB);
    expect(() => undercutScanIndices(meshA, bvhB, [0, 0, 1], [0])).toThrow(RangeError);
  });

  it('throws TypeError for a zero-length direction', () => {
    const mesh = cubeMesh();
    const bvh = buildBvh(mesh);
    expect(() => undercutScanIndices(mesh, bvh, [0, 0, 0], [0])).toThrow(TypeError);
  });
});

describe('undercutScanBatchIndices — matches per-call undercutScanIndices, reports progress', () => {
  it('every direction\'s result matches an independent undercutScanIndices call', () => {
    const mesh = icosphereMesh(4, 2);
    const bvh = buildBvh(mesh);
    const indices = Uint32Array.from({ length: Math.min(50, mesh.indices.length / 3) }, (_, i) => i);
    const directions: [number, number, number][] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [0.3, 0.4, 0.5],
    ];
    const batch = undercutScanBatchIndices(mesh, bvh, directions, indices);
    expect(batch.length).toBe(directions.length);
    for (let i = 0; i < directions.length; i++) {
      const solo = undercutScanIndices(mesh, bvh, directions[i]!, indices);
      expect(batch[i]!.undercut).toEqual(solo.undercut);
      expect(batch[i]!.depthMm).toEqual(solo.depthMm);
      expect(batch[i]!.directionUnit).toEqual(solo.directionUnit);
    }
  });

  it('reports progress once per direction, in order, ending at (directions.length, directions.length)', () => {
    const mesh = cubeMesh();
    const bvh = buildBvh(mesh);
    const calls: [number, number][] = [];
    undercutScanBatchIndices(mesh, bvh, [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ], [0, 1, 2], { onProgress: (done, total) => calls.push([done, total]) });
    expect(calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('matches undercutScanBatch (whole mesh) restricted after the fact, for a full-triangle index list', () => {
    const mesh = cubeMesh();
    const bvh = buildBvh(mesh);
    const triangleCount = mesh.indices.length / 3;
    const allIndices = Uint32Array.from({ length: triangleCount }, (_, i) => i);
    const directions: [number, number, number][] = [
      [0, 0, 1],
      [1, 1, 1],
    ];
    const whole = undercutScanBatch(mesh, bvh, directions);
    const restricted = undercutScanBatchIndices(mesh, bvh, directions, allIndices);
    for (let i = 0; i < directions.length; i++) {
      expect(restricted[i]!.undercut).toEqual(whole[i]!.undercut);
      expect(restricted[i]!.depthMm).toEqual(whole[i]!.depthMm);
    }
  });
});
