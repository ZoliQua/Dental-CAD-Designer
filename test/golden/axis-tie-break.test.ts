// test/golden/axis-tie-break.test.ts
//
// Phase 11 Task 2 (ADR-024 Decision 2) — the axis suggestion's pole
// candidate and its tie-break toward the pole must never make the
// suggestion WORSE. On the real arch-case-01 upperjaw (the ROI of tooth 11's
// committed reference margin, the kernel-ops `suggestAxis` input) the
// winner's score is compared with the pre-Phase-11 search, recomputed here
// independently: the Fibonacci sweep without the pole, first strict
// improvement, the refine cap around that winner.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AXIS_COARSE_SAMPLE_COUNT,
  AXIS_DEFAULT_ROI_RADIUS_MM,
  AXIS_REFINE_SAMPLE_COUNT,
  buildBvh,
  buildHalfedge,
  defaultRefineCapAngleRad,
  extractMarginRegion,
  fibonacciCapDirections,
  fibonacciHemisphereDirections,
  regionTriangleAreasMm2,
  suggestInsertionAxis,
  undercutScanBatchIndices,
} from '@dqcad/kernel';
import type { Vec3 } from '@dqcad/shared-types';
import { repoRoot } from '../../scripts/kernel-ops-lib.ts';
import { loadUpperjawMesh } from './upperjaw-mesh.ts';

interface Reference {
  anchors: readonly { triangleIndex: number; barycentric: readonly [number, number, number] }[];
}

describe('Phase 11 Task 2 — the axis tie-break on the real scan', () => {
  it('arch-case-01 tooth 11: the winner scores ≤ the pre-Phase-11 search\'s winner', () => {
    const mesh = loadUpperjawMesh();
    const bvh = buildBvh(mesh);
    const ref = JSON.parse(
      readFileSync(join(repoRoot, 'test-fixtures', 'margins', 'arch-case-01', '11.reference.json'), 'utf8'),
    ) as Reference;
    const seeds = ref.anchors.map((a) => ({ triangleIndex: a.triangleIndex, barycentric: a.barycentric as Vec3 }));
    const region = extractMarginRegion(mesh, buildHalfedge(mesh), seeds, AXIS_DEFAULT_ROI_RADIUS_MM);
    const result = suggestInsertionAxis(mesh, bvh, region);

    const areas = regionTriangleAreasMm2(mesh, region);
    const score = (dirs: Vec3[]): Array<{ d: Vec3; s: number }> =>
      undercutScanBatchIndices(mesh, bvh, dirs, region.triangleIndices).map((r, k) => {
        let s = 0;
        for (let i = 0; i < areas.length; i++) if (r.undercut[i] === 1) s += areas[i]! * r.depthMm[i]!;
        return { d: dirs[k]!, s };
      });
    let before = { d: result.poleUsed, s: Infinity };
    for (const c of score(fibonacciHemisphereDirections(AXIS_COARSE_SAMPLE_COUNT, result.poleUsed))) if (c.s < before.s) before = c;
    const cap = defaultRefineCapAngleRad(AXIS_COARSE_SAMPLE_COUNT);
    for (const c of score(fibonacciCapDirections(AXIS_REFINE_SAMPLE_COUNT, before.d, cap))) if (c.s < before.s) before = c;

    console.log(
      `[axis-tie-break] tooth 11: before ${before.s} mm³ at ${JSON.stringify(before.d)}; ` +
        `now ${result.best.scoreMm3} mm³ at ${JSON.stringify(result.best.direction)}`,
    );
    expect(result.best.scoreMm3).toBeLessThanOrEqual(before.s);
  }, 600_000);
});
