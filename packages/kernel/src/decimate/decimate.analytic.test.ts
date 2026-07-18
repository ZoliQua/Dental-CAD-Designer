// packages/kernel/src/decimate/decimate.analytic.test.ts
//
// Analytic acceptance case for `decimateMesh` (this task's brief): a sphere
// decimated to 20% of its original triangle count. Checks:
//   1. Enclosed volume stays within a DOCUMENTED bound of the ORIGINAL
//      (pre-decimation) mesh's own volume — isolating what DECIMATION
//      itself contributes, separate from the icosphere tessellation's own
//      pre-existing facet-approximation gap against the pure analytic
//      sphere (a Task-2/halfedge-fixture concern, not this task's).
//   2. Every decimated-mesh vertex lies within a documented distance of the
//      ORIGINAL mesh's surface (BVH-checked, via `closestPoint` — the
//      honest, non-heuristic verification `decimate.ts`'s `@errorBound` doc
//      calls for, since `sqrt(QEM cost)` is a bound on distance-to-nearest-
//      ACCUMULATED-PLANE, not distance-to-the-true-bounded-surface).
import { describe, expect, it } from 'vitest';
import { buildBvh, closestPoint } from '../bvh/index.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import { icosphereMesh } from '../halfedge/halfedge.test-fixtures.ts';
import { decimateMesh } from './decimate.ts';

const SPHERE_RADIUS_MM = 10;

/**
 * Empirically-calibrated safety factor between `result.maxErrorMm` (the QEM
 * heuristic bound — sum of squared distances to ACCUMULATED triangle
 * PLANES, not the true bounded surface) and the actual measured Euclidean
 * deviation from the original mesh's surface (BVH-checked). On a smoothly
 * curved analytic shape like a sphere, a vertex's quadric mixes several
 * non-coplanar original-triangle planes whose common near-intersection sits
 * slightly outside the actual (curved, bounded) surface — this factor
 * absorbs that documented gap. Re-derive/re-measure if this test's shape or
 * subdivision level changes materially.
 */
const QEM_TO_TRUE_DEVIATION_SAFETY_FACTOR = 6;

/**
 * First-order volume-change bound (divergence theorem): if every point of a
 * closed surface displaces by at most `h` (here: the measured max vertex
 * deviation from the original surface), the enclosed volume changes by at
 * most `surfaceArea * h` (exact for a uniform-thickness shell; an
 * over-estimate in general, which is exactly what's wanted for an upper
 * bound). `VOLUME_BOUND_SAFETY_FACTOR` covers decimation's actual
 * displacement being non-uniform and not always normal-directed.
 */
const VOLUME_BOUND_SAFETY_FACTOR = 3;

describe('decimateMesh — analytic: sphere decimated to 20%', () => {
  it('stays within documented volume and per-vertex deviation bounds', () => {
    const mesh = icosphereMesh(SPHERE_RADIUS_MM, 3); // 1280 triangles
    const inputTriangleCount = mesh.indices.length / 3;
    const inputStats = analyzeMesh(mesh);
    expect(inputStats.watertight).toBe(true);

    const target = Math.round(inputTriangleCount * 0.2);
    const result = decimateMesh(mesh, { targetTriangleCount: target });
    expect(result.outputTriangleCount).toBeLessThanOrEqual(target + 4); // link-condition/queue-exhaustion slack, see decimate.ts's boundary/target doc
    expect(result.outputTriangleCount).toBeGreaterThan(0);

    const outStats = analyzeMesh(result.mesh);
    expect(outStats.watertight).toBe(true);
    expect(outStats.manifoldEdges).toBe(true);

    // --- Per-vertex deviation from the ORIGINAL surface (BVH-checked). ---
    const bvh = buildBvh(mesh);
    let maxDeviationMm = 0;
    const outVertexCount = result.mesh.positions.length / 3;
    for (let v = 0; v < outVertexCount; v++) {
      const x = result.mesh.positions[v * 3]!;
      const y = result.mesh.positions[v * 3 + 1]!;
      const z = result.mesh.positions[v * 3 + 2]!;
      const hit = closestPoint(mesh, bvh, [x, y, z]);
      maxDeviationMm = Math.max(maxDeviationMm, hit.distance);
    }
    expect(maxDeviationMm).toBeLessThanOrEqual(
      result.maxErrorMm * QEM_TO_TRUE_DEVIATION_SAFETY_FACTOR + 1e-6,
    );

    // --- Volume: decimation's OWN contribution, isolated from the
    // icosphere's pre-existing tessellation-vs-analytic-sphere gap. ---
    expect(inputStats.signedVolumeMm3).not.toBeNull();
    expect(outStats.signedVolumeMm3).not.toBeNull();
    const volumeDeltaMm3 = Math.abs(outStats.signedVolumeMm3! - inputStats.signedVolumeMm3!);
    const volumeBoundMm3 = inputStats.surfaceAreaMm2 * maxDeviationMm * VOLUME_BOUND_SAFETY_FACTOR;
    expect(volumeDeltaMm3).toBeLessThanOrEqual(volumeBoundMm3);

    // Sanity floor vs. the pure analytic sphere (loose — dominated by the
    // icosphere's own facet approximation at this subdivision level, not by
    // decimation; see this file's top doc).
    const analyticVolumeMm3 = (4 / 3) * Math.PI * SPHERE_RADIUS_MM ** 3;
    const relativeVolumeError = Math.abs(outStats.signedVolumeMm3! - analyticVolumeMm3) / analyticVolumeMm3;
    expect(relativeVolumeError).toBeLessThan(0.05);
  });
});
