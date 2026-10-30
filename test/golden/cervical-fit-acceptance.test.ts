// test/golden/cervical-fit-acceptance.test.ts
//
// Phase 10 Task 4 (ADR-023 Decision 2) — the cervical fit, end to end on the
// Phase 4 shoulder die (the e2e die's dimensions: margin Ø 8 mm at 1.5 mm, a
// 0.5 mm shoulder, taper to Ø 5 mm at 9 mm). Phase 9 Task 4 found the library
// template fails structural QC there: placement fits the template's widest
// section to the proximal gap, so its narrower cervix lands inside the margin.
//
// Here the library PREMOLAR 15 (asset 1.2.0, with its cervical ring) is
// placed, FITTED (kernel `fitCervicalRing`: the ring onto the emergence loop,
// `cervicalEmergenceOffsetMm` outside the margin), morphed against two
// proximal neighbours and an antagonist, and shelled with the trim ALONG the
// fitted ring. Asserted: the minimum-wall, seating and self-intersection
// gates pass (with watertight, manifold and margin fit; every gate is
// reported), measured against the outer surface the shell used. The same
// path WITHOUT the fit (plane trim) is run for the record and must still
// fail one of them — the regression the fit closes.
//
// Why a premolar (a decision of 2026-10-28): the placeholder INCISOR is
// about 3 mm bucco-lingually (the textbook central is about 7 mm), so on this
// round, tall die it self-intersects and has no wall whatever the cervix does
// — not a cervical problem. The round die is a premolar/molar-shaped prep;
// the incisor's proportions are a tracked open item (docs/plans/phase-10).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildInnerSurface,
  cervicalEmergenceOffsetMm,
  constructShell,
  fitCervicalRing,
  type IndexedMesh,
  type Vec3,
  detAtan2,
} from '@dqcad/kernel';
import { shoulderPrepMesh } from '@dqcad/kernel/margin-fixtures';
import { loadToothAssetInProcess } from '@dqcad/tooth-library';
import { STANDARD_ZIRCONIA_PROFILE } from '@dqcad/clinical-profiles';
import {
  runAnatomyPlacementStage,
  runCrownQc,
  runMorphingStage,
  type ContactResidualInput,
  type PipelineContext,
  type PipelineMaterialProfile,
  type PipelineToothAsset,
} from '@dqcad/cad-pipeline';
import type { FdiTooth, QcReport } from '@dqcad/shared-types';

/** A premolar: the round shoulder die is a premolar/molar-shaped prep. */
const TOOTH = 15 as FdiTooth;
const AXIS: Vec3 = [0, 0, 1];
const PITCH_MM = 0.06;
const MARGIN_R = 4.0;
const MARGIN_Z = 1.5;

function hashMesh(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
}

/** An axis-aligned closed box (outward wound). */
function box(min: Vec3, max: Vec3): IndexedMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions: Float64Array.from(positions), indices: Uint32Array.from(indices) };
}

const die = shoulderPrepMesh({ gingivalRadiusMm: 4.5, marginRadiusMm: MARGIN_R, topRadiusMm: 2.5, marginHeightMm: MARGIN_Z, totalHeightMm: 9, segments: 128 }).mesh;
/** The confirmed margin: the die's exact margin-ring vertices. */
const margin: Vec3[] = (() => {
  const out: Vec3[] = [];
  for (let v = 0; v < die.positions.length / 3; v++) {
    const x = die.positions[v * 3]!, y = die.positions[v * 3 + 1]!, z = die.positions[v * 3 + 2]!;
    if (z === MARGIN_Z && Math.abs(Math.hypot(x, y) - MARGIN_R) < 1e-9) out.push([x, y, z]);
  }
  return out.sort((a, b) => detAtan2(a[1], a[0]) - detAtan2(b[1], b[0]));
})();

const PROFILE = STANDARD_ZIRCONIA_PROFILE as unknown as PipelineMaterialProfile;
const rp = PROFILE.restorationParams;
/** Proximal neighbours flanking the die at ±X, clear of the emergence loop. */
const NEIGHBOUR_GAP_MM = 1.2;
const mesial = box([-MARGIN_R - NEIGHBOUR_GAP_MM - 4, -3, MARGIN_Z], [-MARGIN_R - NEIGHBOUR_GAP_MM, 3, 9]);
const distal = box([MARGIN_R + NEIGHBOUR_GAP_MM, -3, MARGIN_Z], [MARGIN_R + NEIGHBOUR_GAP_MM + 4, 3, 9]);
/** The opposing arch: a slab 2.5 mm above the die's top. */
const antagonist = box([-6, -6, 11.5], [6, 6, 13.5]);

function table(report: QcReport): string {
  return report.gates.map((g) => `  ${g.passed ? '✓' : '✗'} ${g.gate.padEnd(22)} ${g.message.slice(0, 160)}`).join('\n');
}

async function crown(fit: boolean): Promise<{ report: QcReport; fitResidualMm: number | null }> {
  const starter = loadToothAssetInProcess(TOOTH);
  const asset: PipelineToothAsset = {
    contentHash: starter.metadata.meshChecksum,
    mesh: starter.mesh,
    landmarks: starter.landmarks,
    canonicalFrame: starter.canonicalFrame,
  };
  const inner = await buildInnerSurface(die, {
    pitchMm: PITCH_MM,
    marginalGapMm: rp.marginalGapMm,
    cementGapMm: rp.cementGapMm,
    spacerStartMm: rp.spacerStartMm,
    blendWidthMm: 0.3,
    marginLoop: margin,
    insertionAxis: AXIS,
  });
  const ctx: PipelineContext = {
    restorationId: 'cervical-fit',
    restorationType: 'crown',
    materialProfile: PROFILE,
    insertionAxis: AXIS,
    targetMesh: { contentHash: hashMesh(die), mesh: die },
    marginLoops: { [TOOTH]: { closed: true, resampledPoints: margin } },
    neighbors: {
      [14 as FdiTooth]: { contentHash: hashMesh(mesial), mesh: mesial },
      [16 as FdiTooth]: { contentHash: hashMesh(distal), mesh: distal },
    },
    antagonist: { contentHash: hashMesh(antagonist), mesh: antagonist },
    stages: {},
  };
  const placed = runAnatomyPlacementStage(ctx, TOOTH, { asset, hashMesh });
  let anatomy = placed.mesh!;
  let fitResidualMm: number | null = null;
  if (fit) {
    const fitted = fitCervicalRing({
      mesh: anatomy,
      cervicalRing: starter.metadata.cervicalRing!,
      marginLoop: margin,
      insertionAxis: AXIS,
      emergenceOffsetMm: cervicalEmergenceOffsetMm(rp),
    });
    anatomy = fitted.mesh;
    fitResidualMm = fitted.errorBoundMm;
    console.log(
      `[cervical-fit] ring ${fitted.ringVertexCount} verts moved ≤ ${fitted.maxRingDisplacementMm.toFixed(3)} mm, ` +
        `${fitted.anchorCount} anchors, ${fitted.movedVertexCount} vertices moved, residual ${(fitted.errorBoundMm * 1000).toFixed(1)} µm`,
    );
  }
  const morph = runMorphingStage({ ...ctx, stages: { anatomyPlacement: hashMesh(anatomy) } }, TOOTH, {
    placedMesh: { contentHash: hashMesh(anatomy), mesh: anatomy },
    hashMesh,
  });
  const shell = await constructShell(morph.mesh!, inner.mesh, {
    insertionAxis: AXIS,
    marginLoop: margin,
    ...(fit ? { outerCervicalRing: starter.metadata.cervicalRing! } : {}),
  });
  const contacts: ContactResidualInput[] = (morph.params['contacts'] as ContactResidualInput[]).map((c) => ({
    kind: c.kind,
    targetPenetrationMm: c.targetPenetrationMm,
    achievedSignedDistanceMm: c.achievedSignedDistanceMm,
    contactResidualMm: c.contactResidualMm,
    regionResidualMm: c.regionResidualMm,
    clampBound: c.clampBound,
  }));
  const report = await runCrownQc({
    crownSolid: shell.mesh,
    innerSurfaceMesh: inner.mesh,
    // The outer surface the shell actually used (for the fit: cut along the
    // ring; without it: the plane-trimmed dome).
    outerSurfaceMesh: shell.outerUsedMesh,
    dieSolid: die,
    marginResampledPoints: margin,
    insertionAxis: AXIS,
    minWallThicknessMm: rp.minWallThicknessMm,
    occlusalMinWallThicknessMm: PROFILE.occlusalMinWallThicknessMm,
    connectorAreaTargetMm2: PROFILE.connectorAreaMm2.anteriorMm2,
    contacts,
    contactClampWarning: morph.params['contactClampWarning'] as boolean,
    marginExclusionMm: PROFILE.marginExclusionMm,
    kernelVersion: 'test',
    profileVersion: PROFILE.version,
    journalHash: hashMesh(shell.mesh),
  });
  return { report, fitResidualMm };
}

const STRUCTURAL = ['minWallThickness', 'seating', 'selfIntersection'];

describe('Phase 10 Task 4 — the fitted library premolar on the Phase 4 shoulder die', () => {
  it('passes the minimum-wall, seating and self-intersection gates (the unfitted template does not)', async () => {
    const fitted = await crown(true);
    console.log(`[cervical-fit] FITTED, residual ${((fitted.fitResidualMm ?? NaN) * 1000).toFixed(1)} µm\n${table(fitted.report)}`);
    for (const name of [...STRUCTURAL, 'watertight', 'manifold', 'marginFit']) {
      const g = fitted.report.gates.find((x) => x.gate === name)!;
      expect(g.passed, `${name}: ${g.message}`).toBe(true);
    }
    expect(fitted.fitResidualMm!).toBeLessThan(0.05);

    const unfitted = await crown(false);
    console.log(`[cervical-fit] UNFITTED (plane trim)\n${table(unfitted.report)}`);
    expect(STRUCTURAL.some((name) => unfitted.report.gates.find((x) => x.gate === name)!.passed === false)).toBe(true);
  }, 900_000);
});
