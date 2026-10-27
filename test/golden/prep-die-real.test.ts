// test/golden/prep-die-real.test.ts
//
// Phase 10 (ADR-023 Decision 1), env-gated RUN_PREP_DIE_REAL=1 — heavy, real
// scans: the closed prep die extracted from the OPEN arch-case-01 upper-jaw
// scan for teeth 11, 12 and 21, each with its hand-traced reference margin
// (test-fixtures/margins/arch-case-01) and the insertion axis the axis tool
// suggests for it. The teeth are unprepared, so this certifies the
// extraction (a valid closed die with its clearance certificate), not a
// crown. Every number is reported.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@dqcad/shared-types';
import {
  AXIS_DEFAULT_ROI_RADIUS_MM,
  PREP_DIE_DEFAULT_REQUIRED_CLEARANCE_MM,
  analyzeMesh,
  buildBvh,
  buildHalfedge,
  extractMarginRegion,
  extractPrepDie,
  suggestInsertionAxis,
} from '@dqcad/kernel';
import { repoRoot } from '../../scripts/kernel-ops-lib.ts';
import { loadUpperjawMesh } from './upperjaw-mesh.ts';

const RUN = process.env['RUN_PREP_DIE_REAL'] === '1';

interface Reference {
  resampledPoints: readonly [number, number, number][];
  anchors: readonly { triangleIndex: number; barycentric: readonly [number, number, number] }[];
}
function loadReference(tooth: number): Reference {
  return JSON.parse(
    readFileSync(join(repoRoot, 'test-fixtures', 'margins', 'arch-case-01', `${tooth}.reference.json`), 'utf8'),
  ) as Reference;
}

describe.skipIf(!RUN)('prep die — REAL arch-case-01 (open scan) [RUN_PREP_DIE_REAL=1]', () => {
  const upper = RUN ? loadUpperjawMesh() : null;
  for (const tooth of [11, 12, 21]) {
    it(`extracts a closed, certified die for tooth ${tooth}`, { timeout: 1_800_000 }, () => {
      const scan = upper!;
      expect(analyzeMesh(scan).watertight).toBe(false);
      const ref = loadReference(tooth);
      const loop: Vec3[] = ref.resampledPoints.map((p) => [p[0], p[1], p[2]]);
      const hm = buildHalfedge(scan);
      const seeds = ref.anchors.map((a) => ({ triangleIndex: a.triangleIndex, barycentric: a.barycentric as Vec3 }));
      const axis = suggestInsertionAxis(scan, buildBvh(scan), extractMarginRegion(scan, hm, seeds, AXIS_DEFAULT_ROI_RADIUS_MM))
        .best.direction;
      const t0 = performance.now();
      const die = extractPrepDie(scan, loop, axis);
      const ms = performance.now() - t0;
      const stats = analyzeMesh(die.mesh);
      console.log(
        `[PREP-DIE REAL #${tooth}] kept=${die.keptTriangleCount} synthetic=${die.syntheticTriangleCount} ` +
          `rim=${die.rimVertexCount} folds dropped=${die.foldTrianglesDropped} clearance=${die.clearanceMm.toFixed(4)} mm volume=${die.volumeMm3.toFixed(2)} mm³ ` +
          `floor=${(die.marginMinHeightMm - die.floorHeightMm).toFixed(3)} mm below the margin, ${ms.toFixed(0)} ms`,
      );
      expect(stats.watertight).toBe(true);
      expect(stats.manifoldEdges).toBe(true);
      expect(die.clearanceMm).toBeGreaterThanOrEqual(PREP_DIE_DEFAULT_REQUIRED_CLEARANCE_MM);
    });
  }
});
