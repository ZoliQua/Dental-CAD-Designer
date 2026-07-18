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
 * Safety factor between `result.maxErrorMm` (the QEM heuristic bound — sum
 * of squared distances to ACCUMULATED triangle PLANES, not the true bounded
 * surface) and the actual measured Euclidean deviation from the original
 * mesh's surface (BVH-checked). On a smoothly curved analytic shape like a
 * sphere, a vertex's quadric mixes several non-coplanar original-triangle
 * planes whose common near-intersection sits slightly outside the actual
 * (curved, bounded) surface — this factor absorbs that documented gap.
 *
 * MEASURED (not merely "empirically calibrated" — the actual numbers this
 * test's fixture/target ratio produces, via an icosphere-subdivision probe,
 * r=10mm, target = 20% of input triangles, same as this test):
 *   subdiv 2 (320 -> 64 tri):   maxDeviationMm / maxErrorMm = 0.0833
 *   subdiv 3 (1280 -> 256 tri): maxDeviationMm / maxErrorMm = 0.0834  <- this test's exact fixture
 *   subdiv 4 (5120 -> 1024 tri): maxDeviationMm / maxErrorMm = 0.0461
 * True ratio for THIS test's configuration is ~0.08, matching the doc's
 * prior "measured true ratio ~0.05-0.08" note. `0.25` is ~3x that measured
 * worst case (0.0834 x 3 ~= 0.25) — enough margin to absorb reasonable
 * fixture/RNG-free variation without being so loose (the OLD factor of `6`,
 * i.e. ~72x the measured ratio) that a systematically-worse collapse-position
 * regression (e.g. 10x more true deviation than today, still far under the
 * old bound) would silently pass. Re-derive/re-measure if this test's shape,
 * radius, or subdivision/target-fraction changes materially.
 */
const QEM_TO_TRUE_DEVIATION_SAFETY_FACTOR = 0.25;

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

    // --- Lower-bound sanity (this test's slack shouldn't hide a broken
    // metric that trivially satisfies the upper bound above). ---
    // A `closestPoint` query that's silently broken (e.g. always returns the
    // query point itself, or always the same triangle) would report a
    // spuriously small/zero deviation and still pass the upper-bound check
    // above — this floor catches that class of bug.
    expect(maxDeviationMm).toBeGreaterThan(0);
    // `result.maxErrorMm` itself, pinned to an order-of-magnitude band around
    // the measured value for THIS exact fixture (icosphere r=10mm, subdiv 3,
    // 1280 -> 256 triangles: measured maxErrorMm ~= 11.58mm — see this file's
    // `QEM_TO_TRUE_DEVIATION_SAFETY_FACTOR` doc for the probe). Catches a
    // gross regression (e.g. a units/scale bug, or a quadric no longer
    // accumulating correctly) that shifts `maxErrorMm` by an order of
    // magnitude in EITHER direction while still passing the ratio check
    // above (which is scale-invariant and so can't catch that class of bug
    // on its own).
    expect(result.maxErrorMm).toBeGreaterThan(1);
    expect(result.maxErrorMm).toBeLessThan(100);

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
