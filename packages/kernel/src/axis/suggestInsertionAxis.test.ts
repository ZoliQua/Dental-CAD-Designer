// packages/kernel/src/axis/suggestInsertionAxis.test.ts
//
// Unit-level tests for suggestInsertionAxis/suggestInsertionAxisForRegions —
// option handling, error cases, and the determinism/ranking invariants not
// already covered by suggestInsertionAxis.analytic.test.ts's fixture-driven
// cases.
import { describe, expect, it, vi } from 'vitest';
import { buildBvh } from '../bvh/index.ts';
import { buildHalfedge } from '../halfedge/index.ts';
import { snapToSurface } from '../geodesic/surfacePoint.ts';
import { icosphereMesh } from '../halfedge/halfedge.test-fixtures.ts';
import { coneFrustumMesh } from './axis.test-fixtures.ts';
import { extractMarginRegion, regionAreaWeightedNormalSum, type AxisRegion } from './roi.ts';
import {
  suggestInsertionAxis,
  suggestInsertionAxisForRegions,
  deriveHemispherePole,
  defaultRefineCapAngleRad,
  EmptyRegionError,
  DegenerateRegionNormalError,
  AXIS_COARSE_SAMPLE_COUNT,
  AXIS_REFINE_SAMPLE_COUNT,
} from './suggestInsertionAxis.ts';

function midWallRegion(bottomRadius: number, topRadius: number, height: number, segments: number, heightSegments: number) {
  const frustum = coneFrustumMesh(bottomRadius, topRadius, height, segments, heightSegments);
  const bvh = buildBvh(frustum.mesh);
  const hm = buildHalfedge(frustum.mesh);
  const seedZ = height / 3;
  const seedRadius = bottomRadius - (bottomRadius - topRadius) * (seedZ / height);
  const seeds = [];
  for (let i = 0; i < 24; i++) {
    const theta = (2 * Math.PI * i) / 24;
    seeds.push(snapToSurface(frustum.mesh, bvh, [seedRadius * Math.cos(theta), seedRadius * Math.sin(theta), seedZ]));
  }
  const region = extractMarginRegion(frustum.mesh, hm, seeds, Math.min(2, height / 4));
  return { frustum, bvh, hm, region };
}

describe('suggestInsertionAxis — option handling & errors', () => {
  it('throws EmptyRegionError for a region with no triangles', () => {
    const { frustum, bvh } = midWallRegion(4, 2.5, 9, 32, 12);
    const empty: AxisRegion = { triangleIndices: new Uint32Array(0) };
    expect(() => suggestInsertionAxis(frustum.mesh, bvh, empty)).toThrow(EmptyRegionError);
  });

  it('deriveHemispherePole throws DegenerateRegionNormalError for a symmetric closed sphere (normals cancel)', () => {
    const mesh = icosphereMesh(5, 2);
    const region: AxisRegion = { triangleIndices: Uint32Array.from({ length: mesh.indices.length / 3 }, (_, i) => i) };
    // Sanity: this region really is degenerate for pole derivation.
    const sum = regionAreaWeightedNormalSum(mesh, region);
    expect(Math.hypot(sum[0], sum[1], sum[2])).toBeLessThan(1e-9);
    expect(() => deriveHemispherePole(mesh, region)).toThrow(DegenerateRegionNormalError);
  });

  it('an explicit options.pole bypasses deriveHemispherePole entirely (never throws DegenerateRegionNormalError even for a degenerate-normal region)', () => {
    const mesh = icosphereMesh(5, 2);
    const bvh = buildBvh(mesh);
    const region: AxisRegion = { triangleIndices: Uint32Array.from({ length: mesh.indices.length / 3 }, (_, i) => i) };
    expect(() => suggestInsertionAxis(mesh, bvh, region, { pole: [0, 0, 1], coarseCount: 4, refineCount: 0 })).not.toThrow();
  });

  it('refineCount: 0 disables refinement — result.refineCount is 0 and ranked has exactly coarseCount entries', () => {
    const { frustum, bvh, region } = midWallRegion(4, 2.5, 9, 32, 12);
    const result = suggestInsertionAxis(frustum.mesh, bvh, region, { coarseCount: 8, refineCount: 0 });
    expect(result.refineCount).toBe(0);
    expect(result.ranked.length).toBe(8);
  });

  it('a custom coarseCount/refineCount is honored, and total progress checkpoints equal coarseCount + refineCount', () => {
    const { frustum, bvh, region } = midWallRegion(4, 2.5, 9, 32, 12);
    const onProgress = vi.fn();
    const coarseCount = 6;
    const refineCount = 3;
    const result = suggestInsertionAxis(frustum.mesh, bvh, region, { coarseCount, refineCount, onProgress });
    expect(result.coarseCount).toBe(coarseCount);
    expect(result.refineCount).toBe(refineCount);
    expect(result.ranked.length).toBe(coarseCount + refineCount);
    expect(onProgress).toHaveBeenCalled();
    const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1]!;
    expect(lastCall[0]).toBe(coarseCount + refineCount); // final checkpoint reports "done" == total
    expect(lastCall[1]).toBe(coarseCount + refineCount);
  });

  it('ranked is sorted ascending by scoreMm3, and best is always ranked[0]', () => {
    const { frustum, bvh, region } = midWallRegion(4, 2.5, 9, 32, 12);
    const result = suggestInsertionAxis(frustum.mesh, bvh, region);
    for (let i = 1; i < result.ranked.length; i++) {
      expect(result.ranked[i]!.scoreMm3).toBeGreaterThanOrEqual(result.ranked[i - 1]!.scoreMm3);
    }
    expect(result.best).toBe(result.ranked[0]);
  });

  it('defaultRefineCapAngleRad decreases as coarseCount increases (a denser coarse sweep needs a smaller local refine cap)', () => {
    expect(defaultRefineCapAngleRad(64)).toBeLessThan(defaultRefineCapAngleRad(16));
  });
});

describe('suggestInsertionAxisForRegions — errors', () => {
  it('throws EmptyRegionError for an empty regions array', () => {
    const { frustum, bvh } = midWallRegion(4, 2.5, 9, 32, 12);
    expect(() => suggestInsertionAxisForRegions(frustum.mesh, bvh, [])).toThrow(EmptyRegionError);
  });

  it('a single region behaves identically to suggestInsertionAxis over the same region (common.best matches, one perRegion entry)', () => {
    const { frustum, bvh, region } = midWallRegion(4, 2.5, 9, 32, 12);
    const direct = suggestInsertionAxis(frustum.mesh, bvh, region);
    const { common, perRegion } = suggestInsertionAxisForRegions(frustum.mesh, bvh, [region]);
    expect(common.best.direction).toEqual(direct.best.direction);
    expect(perRegion.length).toBe(1);
    expect(perRegion[0]!.scoreMm3).toBeCloseTo(direct.best.scoreMm3, 9);
  });
});

describe('AXIS_COARSE_SAMPLE_COUNT / AXIS_REFINE_SAMPLE_COUNT defaults', () => {
  it('defaults sum to a modest per-suggestion direction budget (perf-budget contract — see suggestInsertionAxis.ts module doc)', () => {
    expect(AXIS_COARSE_SAMPLE_COUNT + AXIS_REFINE_SAMPLE_COUNT).toBeLessThanOrEqual(64);
  });
});
