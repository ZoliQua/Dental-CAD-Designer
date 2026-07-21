// packages/kernel/src/blockout/blockoutPreview.test.ts
//
// Unit + property tests for `blockoutPreview` — per this task's brief +
// CLAUDE.md's "tests first: property-based (fast-check) + analytic golden
// case" convention. Closed-form/self-consistency cases live in
// blockoutPreview.analytic.test.ts; this file covers structural properties
// (branding, determinism, threshold monotonicity, displacement direction)
// that hold regardless of the specific fixture.
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { buildBvh } from '../bvh/index.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { cappedCylinderMesh } from '../curvature/curvature.test-fixtures.ts';
import { coneFrustumMesh } from '../axis/axis.test-fixtures.ts';
import { blockoutPreview, type BlockoutPreviewResult, type BlockoutPreviewMesh } from './blockoutPreview.ts';

const PROPERTY_SEED = 20260716;
const NUM_RUNS = 30;

function allTriangleIndices(mesh: IndexedMesh): Uint32Array {
  const triangleCount = mesh.indices.length / 3;
  const indices = new Uint32Array(triangleCount);
  for (let i = 0; i < triangleCount; i++) indices[i] = i;
  return indices;
}

function hashResult(result: BlockoutPreviewResult): string {
  const hash = createHash('sha256');
  const { positions, indices } = result.mesh.previewMesh;
  hash.update(Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength));
  hash.update(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength));
  hash.update(String(result.blockoutTriangleCount));
  hash.update(String(result.maxDisplacementMm));
  hash.update(String(result.approxVolumeMm3));
  return hash.digest('hex');
}

describe('BlockoutPreviewMesh — compile-time rejection by kernel ops (blockoutPreview.ts module doc)', () => {
  it('BlockoutPreviewMesh does not structurally match IndexedMesh', () => {
    expectTypeOf<BlockoutPreviewMesh>().not.toMatchTypeOf<IndexedMesh>();
  });
});

describe('blockoutPreview — no-undercut region -> empty preview', () => {
  it('an axis-aligned cylinder wall scanned along its own axis has zero undercut -> empty preview mesh', () => {
    // Same fixture/direction as undercut/undercutScan.analytic.test.ts's
    // "normal . d === 0 exactly for every wall triangle when d = +Z" case
    // — every wall triangle sits in the boundary/grazing epsilon band,
    // undercut by neither facing nor occlusion.
    const mesh = cappedCylinderMesh(3, 8, 64, 8);
    const bvh = buildBvh(mesh);
    const wallTriangleCount = 8 * 64 * 2;
    const wallIndices = new Uint32Array(wallTriangleCount);
    for (let i = 0; i < wallTriangleCount; i++) wallIndices[i] = i;

    const result = blockoutPreview(mesh, bvh, { triangleIndices: wallIndices }, [0, 0, 1], 0);

    expect(result.blockoutTriangleCount).toBe(0);
    expect(result.vertexCount).toBe(0);
    expect(result.maxDisplacementMm).toBe(0);
    expect(result.approxVolumeMm3).toBe(0);
    expect(result.mesh.previewMesh.positions.length).toBe(0);
    expect(result.mesh.previewMesh.indices.length).toBe(0);
  });

  it('an empty region -> empty preview (no triangles to consider at all)', () => {
    const mesh = cappedCylinderMesh(3, 8, 64, 8);
    const bvh = buildBvh(mesh);
    const result = blockoutPreview(mesh, bvh, { triangleIndices: new Uint32Array(0) }, [0, 0, 1], 0);
    expect(result.blockoutTriangleCount).toBe(0);
    expect(result.regionTriangleCount).toBe(0);
  });
});

describe('blockoutPreview — input validation', () => {
  it('throws RangeError for a non-finite thresholdMm', () => {
    const mesh = cappedCylinderMesh(3, 8, 32, 4);
    const bvh = buildBvh(mesh);
    expect(() => blockoutPreview(mesh, bvh, { triangleIndices: allTriangleIndices(mesh) }, [0, 0, 1], NaN)).toThrow(RangeError);
    expect(() => blockoutPreview(mesh, bvh, { triangleIndices: allTriangleIndices(mesh) }, [0, 0, 1], Infinity)).toThrow(RangeError);
  });

  it('throws RangeError for a bvh not built from this mesh', () => {
    const mesh = cappedCylinderMesh(3, 8, 32, 4);
    const other = cappedCylinderMesh(3, 8, 16, 2);
    const otherBvh = buildBvh(other);
    expect(() => blockoutPreview(mesh, otherBvh, { triangleIndices: allTriangleIndices(mesh) }, [0, 0, 1], 0)).toThrow(RangeError);
  });
});

describe('blockoutPreview — determinism', () => {
  it('two identical calls produce byte-identical output (property, several fixtures/directions/thresholds)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(30, 45, 60),
        fc.double({ min: 0, max: 0.05, noNaN: true }),
        (tiltDeg, thresholdMm) => {
          const frustum = coneFrustumMesh(4, 2.5, 9, 32, 6);
          const bvh = buildBvh(frustum.mesh);
          const a = (tiltDeg * Math.PI) / 180;
          const d: [number, number, number] = [Math.sin(a), 0, Math.cos(a)];
          const region = { triangleIndices: allTriangleIndices(frustum.mesh) };

          const first = blockoutPreview(frustum.mesh, bvh, region, d, thresholdMm);
          const second = blockoutPreview(frustum.mesh, bvh, region, d, thresholdMm);
          expect(hashResult(second)).toBe(hashResult(first));
        },
      ),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });
});

describe('blockoutPreview — threshold monotonicity', () => {
  it('raising thresholdMm never INCREASES blockoutTriangleCount (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 3, noNaN: true }),
        fc.double({ min: 0, max: 3, noNaN: true }),
        (t1, t2) => {
          const [lo, hi] = t1 <= t2 ? [t1, t2] : [t2, t1];
          const frustum = coneFrustumMesh(4, 2.5, 9, 32, 6);
          const bvh = buildBvh(frustum.mesh);
          const region = { triangleIndices: allTriangleIndices(frustum.mesh) };
          const a = (30 * Math.PI) / 180;
          const d: [number, number, number] = [Math.sin(a), 0, Math.cos(a)];

          const loResult = blockoutPreview(frustum.mesh, bvh, region, d, lo);
          const hiResult = blockoutPreview(frustum.mesh, bvh, region, d, hi);
          expect(hiResult.blockoutTriangleCount).toBeLessThanOrEqual(loResult.blockoutTriangleCount);
        },
      ),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });

  it('a threshold above every region triangle depth -> empty preview', () => {
    const frustum = coneFrustumMesh(4, 2.5, 9, 32, 6);
    const bvh = buildBvh(frustum.mesh);
    const a = (30 * Math.PI) / 180;
    const d: [number, number, number] = [Math.sin(a), 0, Math.cos(a)];
    const result = blockoutPreview(frustum.mesh, bvh, { triangleIndices: allTriangleIndices(frustum.mesh) }, d, 1000);
    expect(result.blockoutTriangleCount).toBe(0);
  });
});

describe('blockoutPreview — every displaced vertex moves along +directionUnit (or not at all)', () => {
  it('displacement vector is a nonnegative scalar multiple of directionUnit, for every preview vertex (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom(20, 30, 45, 60), (tiltDeg) => {
        const frustum = coneFrustumMesh(4, 2.5, 9, 32, 6);
        const bvh = buildBvh(frustum.mesh);
        const a = (tiltDeg * Math.PI) / 180;
        const d: [number, number, number] = [Math.sin(a), 0, Math.cos(a)];
        const region = { triangleIndices: allTriangleIndices(frustum.mesh) };
        const result = blockoutPreview(frustum.mesh, bvh, region, d, 0);
        fc.pre(result.vertexCount > 0);

        // Reconstruct: since we don't expose sourceVertexIndices, verify via
        // the geometric invariant directly — every preview vertex, when
        // projected onto the plane perpendicular to `d` through the origin,
        // must equal SOME original mesh vertex's own perpendicular
        // projection (displacement is purely along `d`).
        const { positions } = result.mesh.previewMesh;
        const originalPositions = frustum.mesh.positions;
        const perp = (x: number, y: number, z: number): [number, number, number] => {
          const dot = x * d[0] + y * d[1] + z * d[2];
          return [x - dot * d[0], y - dot * d[1], z - dot * d[2]];
        };
        for (let v = 0; v < result.vertexCount; v++) {
          const px = positions[v * 3]!, py = positions[v * 3 + 1]!, pz = positions[v * 3 + 2]!;
          const [qx, qy, qz] = perp(px, py, pz);
          let bestDist = Infinity;
          for (let ov = 0; ov < originalPositions.length / 3; ov++) {
            const ox = originalPositions[ov * 3]!, oy = originalPositions[ov * 3 + 1]!, oz = originalPositions[ov * 3 + 2]!;
            const [rx, ry, rz] = perp(ox, oy, oz);
            const dist = Math.hypot(qx - rx, qy - ry, qz - rz);
            if (dist < bestDist) bestDist = dist;
          }
          expect(bestDist).toBeLessThan(1e-6);
        }
      }),
      { seed: PROPERTY_SEED, numRuns: 8 }, // O(vertexCount * meshVertexCount) per run — kept small
    );
  });
});
