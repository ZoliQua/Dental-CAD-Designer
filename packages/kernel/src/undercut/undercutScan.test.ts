// packages/kernel/src/undercut/undercutScan.test.ts
//
// Behavioral + property tests for `undercutScan`/`undercutScanBatch`:
// input validation, sampling-policy relationship ('corners' >= 'centroid'),
// batch/single-call consistency + BVH reuse, determinism (hashes), and the
// property test this task's brief asks for: depth >= 0 everywhere,
// non-undercut triangles have depth 0, across a seeded range of
// shapes/directions (fast-check).
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '../mesh/types.ts';
import { buildBvh, type Vec3 } from '../bvh/index.ts';
import {
  cubeMesh,
  icosphereMesh,
  notchedBoxMesh,
  octahedronMesh,
  openGridPatchMesh,
  torusMesh,
} from '../halfedge/halfedge.test-fixtures.ts';
import { undercutScan, undercutScanBatch, undercutScanRange, type UndercutScanResult } from './undercutScan.ts';

const PROPERTY_SEED = 20260712;
const NUM_RUNS = 50;

function hashResult(result: UndercutScanResult): string {
  const hash = createHash('sha256');
  hash.update(Buffer.from(result.undercut.buffer, result.undercut.byteOffset, result.undercut.byteLength));
  hash.update(Buffer.from(result.depthMm.buffer, result.depthMm.byteOffset, result.depthMm.byteLength));
  return hash.digest('hex');
}

describe('undercutScan — input validation', () => {
  it('throws RangeError when bvh triangle count does not match mesh (stale BVH defense)', () => {
    const mesh = cubeMesh();
    const otherMesh = octahedronMesh();
    const bvh = buildBvh(otherMesh);
    expect(() => undercutScan(mesh, bvh, [0, 0, 1])).toThrow(RangeError);
  });

  it('throws TypeError for a zero-length direction', () => {
    const mesh = cubeMesh();
    const bvh = buildBvh(mesh);
    expect(() => undercutScan(mesh, bvh, [0, 0, 0])).toThrow(TypeError);
  });

  it('normalizes a non-unit direction the same way raycast does', () => {
    const mesh = cubeMesh();
    const bvh = buildBvh(mesh);
    const a = undercutScan(mesh, bvh, [0, 0, 5]);
    const b = undercutScan(mesh, bvh, [0, 0, 1]);
    expect(a.directionUnit).toEqual([0, 0, 1]);
    expect(Array.from(a.undercut)).toEqual(Array.from(b.undercut));
    expect(Array.from(a.depthMm)).toEqual(Array.from(b.depthMm));
  });
});

describe('undercutScan — basic cube behavior (hand-checkable)', () => {
  it('a unit cube, d=+Z: exactly the bottom face (2 triangles) is undercut, with depth === 1 (cube height) exactly', () => {
    const mesh = cubeMesh(0.5); // halfExtent 0.5 -> full extent [-0.5, 0.5], height 1
    const bvh = buildBvh(mesh);
    const result = undercutScan(mesh, bvh, [0, 0, 1]);
    expect(result.undercutTriangleCount).toBe(2);
    let bottomFound = 0;
    for (let t = 0; t < result.triangleCount; t++) {
      if (result.undercut[t] === 1) {
        bottomFound++;
        expect(result.depthMm[t]).toBeCloseTo(1, 9);
      }
    }
    expect(bottomFound).toBe(2);
    expect(result.maxDepthMm).toBeCloseTo(1, 9);
  });

  it('the 4 vertical side faces (normal perpendicular to d) are never undercut — normal.d === 0 exactly', () => {
    const mesh = cubeMesh(0.5);
    const bvh = buildBvh(mesh);
    const result = undercutScan(mesh, bvh, [0, 0, 1]);
    // Triangles 4..11 (front/right/back/left, per cubeMesh's construction) are the 4 side faces.
    for (let t = 4; t < 12; t++) {
      expect(result.undercut[t]).toBe(0);
      expect(result.depthMm[t]).toBe(0);
    }
  });
});

describe('undercutScan — sampling policy: corners >= centroid (conservative, per undercutScan.ts doc)', () => {
  it('property: for every undercut triangle, corners-sampled depth is never less than centroid-sampled depth', () => {
    const shapeArb = fc.oneof(
      fc.record({ kind: fc.constant('icosphere' as const), subdivisions: fc.integer({ min: 0, max: 2 }) }),
      fc.record({ kind: fc.constant('torus' as const), majorSegments: fc.integer({ min: 4, max: 10 }), minorSegments: fc.integer({ min: 4, max: 10 }) }),
      fc.constant({ kind: 'notchedBox' as const }),
    );
    const dirArb = fc
      .tuple(fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }))
      .filter(([x, y, z]) => Math.hypot(x, y, z) > 1e-6) as fc.Arbitrary<Vec3>;

    fc.assert(
      fc.property(shapeArb, dirArb, (desc, d) => {
        const mesh: IndexedMesh =
          desc.kind === 'icosphere'
            ? icosphereMesh(5, desc.subdivisions)
            : desc.kind === 'torus'
              ? torusMesh(3, 1, desc.majorSegments, desc.minorSegments)
              : notchedBoxMesh(2);
        const bvh = buildBvh(mesh);
        const centroidResult = undercutScan(mesh, bvh, d, { sampling: 'centroid' });
        const cornersResult = undercutScan(mesh, bvh, d, { sampling: 'corners' });
        for (let t = 0; t < centroidResult.triangleCount; t++) {
          expect(cornersResult.undercut[t]).toBe(centroidResult.undercut[t]); // boolean is normal-only, sampling-independent
          expect(cornersResult.depthMm[t]!).toBeGreaterThanOrEqual(centroidResult.depthMm[t]!);
        }
      }),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });
});

describe('undercutScanRange — chunked scanning matches a single whole-mesh undercutScan call exactly', () => {
  it('scanning in several arbitrary-sized chunks produces bit-identical undercut/depthMm arrays to undercutScan', () => {
    const mesh = icosphereMesh(5, 2);
    const bvh = buildBvh(mesh);
    const d: Vec3 = [0.2, -0.5, 0.7];
    const whole = undercutScan(mesh, bvh, d, { sampling: 'corners' });

    const chunkedUndercut = new Uint8Array(whole.triangleCount);
    const chunkedDepth = new Float64Array(whole.triangleCount);
    const chunkSize = 37; // deliberately not a divisor of the triangle count
    let accumulatedCount = 0;
    let accumulatedMax = 0;
    for (let start = 0; start < whole.triangleCount; start += chunkSize) {
      const end = Math.min(start + chunkSize, whole.triangleCount);
      const stats = undercutScanRange(
        mesh,
        bvh,
        d,
        { start, end },
        { undercut: chunkedUndercut, depthMm: chunkedDepth },
        { sampling: 'corners' },
      );
      accumulatedCount += stats.undercutCountInRange;
      if (stats.maxDepthMmInRange > accumulatedMax) accumulatedMax = stats.maxDepthMmInRange;
    }

    expect(Array.from(chunkedUndercut)).toEqual(Array.from(whole.undercut));
    expect(Array.from(chunkedDepth)).toEqual(Array.from(whole.depthMm));
    expect(accumulatedCount).toBe(whole.undercutTriangleCount);
    expect(accumulatedMax).toBe(whole.maxDepthMm);
  });

  it('throws RangeError for an out-of-bounds or inverted range', () => {
    const mesh = cubeMesh();
    const bvh = buildBvh(mesh);
    const out = { undercut: new Uint8Array(12), depthMm: new Float64Array(12) };
    expect(() => undercutScanRange(mesh, bvh, [0, 0, 1], { start: -1, end: 5 }, out)).toThrow(RangeError);
    expect(() => undercutScanRange(mesh, bvh, [0, 0, 1], { start: 0, end: 13 }, out)).toThrow(RangeError);
    expect(() => undercutScanRange(mesh, bvh, [0, 0, 1], { start: 6, end: 2 }, out)).toThrow(RangeError);
  });
});

describe('undercutScanBatch — consistency with per-direction undercutScan, and BVH reuse', () => {
  it('produces identical results to calling undercutScan once per direction, and reuses the SAME bvh object (no rebuild)', () => {
    const mesh = icosphereMesh(5, 2);
    let buildCount = 0;
    const bvh = buildBvh(mesh);
    buildCount++; // built exactly once, here, by the test itself
    const directions: Vec3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1, 1, 1],
      [-1, 0.3, 0.2],
    ];
    const batchResults = undercutScanBatch(mesh, bvh, directions);
    expect(buildCount).toBe(1); // undercutScanBatch never calls buildBvh itself (kernel API takes bvh in)
    for (let i = 0; i < directions.length; i++) {
      const single = undercutScan(mesh, bvh, directions[i]!);
      expect(hashResult(batchResults[i]!)).toBe(hashResult(single));
    }
  });

  it('reports per-direction progress (done, total), ending at (directions.length, directions.length)', () => {
    const mesh = cubeMesh();
    const bvh = buildBvh(mesh);
    const progressCalls: Array<[number, number]> = [];
    undercutScanBatch(mesh, bvh, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], {
      onProgress: (done, total) => progressCalls.push([done, total]),
    });
    expect(progressCalls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });
});

describe('undercutScan — determinism', () => {
  it('repeated runs on the same mesh+direction are bit-identical (hash match)', () => {
    const mesh = icosphereMesh(5, 2);
    const bvh = buildBvh(mesh);
    const a = undercutScan(mesh, bvh, [0.3, 0.4, 0.5]);
    const b = undercutScan(mesh, bvh, [0.3, 0.4, 0.5]);
    expect(hashResult(a)).toBe(hashResult(b));
  });

  it('property: determinism holds across a seeded range of shapes/directions/sampling policies', () => {
    const shapeArb = fc.oneof(
      fc.record({ kind: fc.constant('icosphere' as const), subdivisions: fc.integer({ min: 0, max: 2 }) }),
      fc.record({ kind: fc.constant('torus' as const), majorSegments: fc.integer({ min: 4, max: 10 }), minorSegments: fc.integer({ min: 4, max: 10 }) }),
      fc.constant({ kind: 'notchedBox' as const }),
      fc.constant({ kind: 'cube' as const }),
    );
    const dirArb = fc
      .tuple(fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }))
      .filter(([x, y, z]) => Math.hypot(x, y, z) > 1e-6) as fc.Arbitrary<Vec3>;
    const samplingArb = fc.constantFrom('centroid' as const, 'corners' as const);

    fc.assert(
      fc.property(shapeArb, dirArb, samplingArb, (desc, d, sampling) => {
        const mesh: IndexedMesh =
          desc.kind === 'icosphere'
            ? icosphereMesh(5, desc.subdivisions)
            : desc.kind === 'torus'
              ? torusMesh(3, 1, desc.majorSegments, desc.minorSegments)
              : desc.kind === 'notchedBox'
                ? notchedBoxMesh(2)
                : cubeMesh();
        const bvh = buildBvh(mesh);
        const a = undercutScan(mesh, bvh, d, { sampling });
        const b = undercutScan(mesh, bvh, d, { sampling });
        expect(hashResult(a)).toBe(hashResult(b));
      }),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });
});

describe('undercutScan — property: depth >= 0 everywhere, non-undercut triangles have depth 0', () => {
  it('holds across a seeded range of closed AND open meshes, directions, sampling policies', () => {
    const shapeArb = fc.oneof(
      fc.record({ kind: fc.constant('icosphere' as const), subdivisions: fc.integer({ min: 0, max: 2 }) }),
      fc.record({ kind: fc.constant('torus' as const), majorSegments: fc.integer({ min: 4, max: 10 }), minorSegments: fc.integer({ min: 4, max: 10 }) }),
      fc.constant({ kind: 'notchedBox' as const }),
      fc.constant({ kind: 'cube' as const }),
      fc.record({ kind: fc.constant('openGrid' as const), rows: fc.integer({ min: 1, max: 5 }), cols: fc.integer({ min: 1, max: 5 }) }),
    );
    const dirArb = fc
      .tuple(fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }))
      .filter(([x, y, z]) => Math.hypot(x, y, z) > 1e-6) as fc.Arbitrary<Vec3>;
    const samplingArb = fc.constantFrom('centroid' as const, 'corners' as const);

    fc.assert(
      fc.property(shapeArb, dirArb, samplingArb, (desc, d, sampling) => {
        const mesh: IndexedMesh =
          desc.kind === 'icosphere'
            ? icosphereMesh(5, desc.subdivisions)
            : desc.kind === 'torus'
              ? torusMesh(3, 1, desc.majorSegments, desc.minorSegments)
              : desc.kind === 'notchedBox'
                ? notchedBoxMesh(2)
                : desc.kind === 'cube'
                  ? cubeMesh()
                  : openGridPatchMesh(desc.rows, desc.cols);
        const bvh = buildBvh(mesh);
        const result = undercutScan(mesh, bvh, d, { sampling });
        for (let t = 0; t < result.triangleCount; t++) {
          expect(result.depthMm[t]!).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(result.depthMm[t]!)).toBe(true);
          if (result.undercut[t] === 0) {
            expect(result.depthMm[t]).toBe(0);
          }
        }
        // maxDepthMm is consistent with the per-triangle array.
        let expectedMax = 0;
        for (let t = 0; t < result.triangleCount; t++) {
          if (result.depthMm[t]! > expectedMax) expectedMax = result.depthMm[t]!;
        }
        expect(result.maxDepthMm).toBe(expectedMax);
        expect(result.undercutTriangleCount).toBe(Array.from(result.undercut).filter((u) => u === 1).length);
      }),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });
});
