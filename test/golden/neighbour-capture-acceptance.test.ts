// test/golden/neighbour-capture-acceptance.test.ts
//
// Phase 9 Task 3 ACCEPTANCE (env-gated RUN_NEIGHBOUR_CAPTURE_REAL=1 — heavy,
// real scans): a crown on arch-case-01 tooth 11 whose proximal-contact gate is
// measured against neighbours 12 and 21 CAPTURED from the same upper-arch
// scan (kernel `extractNeighbourRegion`), with the capture's `@errorBound`
// (window-border band) reported in the gate — and the antagonist captured
// from the opposite (lower) arch through the `occlusal` window.
//
// The picks are what a user's click would give: the point of the upper scan
// nearest a spot 3 mm along the insertion axis from each neighbour's own
// hand-traced cervical-outline centroid (test-fixtures/margins/arch-case-01).
// The tooth-11 margin + insertion axis are the same as the other real-case
// suites (qc-gates-acceptance.test.ts). Outcome assertions are HONEST: the
// regions are valid case-derived solids on the neighbour side, the contact
// gate is MEASURED on `case` provenance (no stand-in) and discloses the bound;
// passing is NOT demanded (the real placement / morph quality is the Phase 4
// tracked-pending), every number is reported.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import {
  AXIS_DEFAULT_ROI_RADIUS_MM,
  analyzeMesh,
  buildBvh,
  buildHalfedge,
  closestPoint,
  extractMarginRegion,
  extractNeighbourRegion,
  intake,
  suggestInsertionAxis,
  type IndexedMesh,
  type NeighbourRegionResult,
} from '@dqcad/kernel';
import { parseStl } from '@dqcad/io';
import { loadToothAssetInProcess } from '@dqcad/tooth-library';
import {
  contactGate,
  runAnatomyPlacementStage,
  runMorphingStage,
  type ContactResidualInput,
  type PipelineContext,
  type PipelineMaterialProfile,
  type PipelineToothAsset,
} from '@dqcad/cad-pipeline';
import { createHash } from 'node:crypto';
import { repoRoot } from '../../scripts/kernel-ops-lib.ts';
import { loadUpperjawMesh } from './upperjaw-mesh.ts';

const RUN = process.env['RUN_NEIGHBOUR_CAPTURE_REAL'] === '1';

const PROFILE: PipelineMaterialProfile = {
  id: 'standard-zirconia',
  version: '1.1.0',
  restorationParams: {
    cementGapMm: 0.05,
    marginalGapMm: 0.02,
    spacerStartMm: 0.8,
    minWallThicknessMm: 0.5,
    proximalContactPenetrationMm: 0.02,
    occlusalContactMm: 0,
  },
  connectorAreaMm2: { posteriorMm2: 9, anteriorMm2: 7 },
  undercutBlockoutThresholdMm: 0,
  occlusalMinWallThicknessMm: 0.5,
  maxChordDeviationMm: 0.005,
  inlayMinThicknessMm: 0.5,
  onlayMinThicknessMm: 0.5,
  cuspCoverageMinThicknessMm: 0.7,
  marginExclusionMm: 0.2,
  inlayMarginExclusionMm: 1.3,
  onlayMarginExclusionMm: 1.8,
  frameworkMinThicknessMm: 0.5,
  ponticHygienicClearanceMm: 2.0,
  ponticRidgeLapReliefMm: 0.05,
  ponticOvateDepthMm: 1.0,
  veneeringSpaceMm: 1.0,
};

interface Reference {
  resampledPoints: readonly [number, number, number][];
  closed: boolean;
  anchors: readonly { triangleIndex: number; barycentric: readonly [number, number, number] }[];
}
function loadReference(tooth: number): Reference {
  return JSON.parse(
    readFileSync(
      join(repoRoot, 'test-fixtures', 'margins', 'arch-case-01', `${tooth}.reference.json`),
      'utf8',
    ),
  ) as Reference;
}
function loadLowerjaw(): IndexedMesh {
  const bytes = readFileSync(
    join(repoRoot, 'test-fixtures', 'real-scans', 'arch-case-01', 'arch-case-01-lowerjaw.stl'),
  );
  const { soup } = parseStl(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return intake({ kind: 'soup', soup }).mesh;
}
function hashMesh(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(
    Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength),
  );
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
}
function centroidOf(points: readonly (readonly [number, number, number])[]): Vec3 {
  let x = 0,
    y = 0,
    z = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
    z += p[2];
  }
  return [x / points.length, y / points.length, z / points.length];
}
function report(label: string, r: NeighbourRegionResult): void {
  console.log(
    `[NEIGHBOUR-CAPTURE REAL #11] ${label}: captured=${r.capturedTriangleCount} tris, ` +
      `area=${r.capturedAreaMm2.toFixed(2)} mm², window border band=${(r.windowBoundaryBandMm * 1000).toFixed(1)} µm, ` +
      `fold triangles dropped=${r.foldTrianglesDropped}, ` +
      `n=[${r.approachDirection.map((v) => v.toFixed(3)).join(', ')}]`,
  );
}

describe.skipIf(!RUN)(
  'neighbour capture — REAL arch-case-01 tooth 11 with captured 12 / 21 [RUN_NEIGHBOUR_CAPTURE_REAL=1]',
  () => {
    it(
      'captures 12 / 21 + the lower-arch antagonist and measures the contact gate on case geometry',
      { timeout: 1_800_000 },
      () => {
        const TOOTH = 11 as FdiTooth;
        const upper = loadUpperjawMesh();
        const ref11 = loadReference(11);
        const loop11: Vec3[] = ref11.resampledPoints.map((p) => [p[0], p[1], p[2]]);
        const hm = buildHalfedge(upper);
        const seeds = ref11.anchors.map((a) => ({
          triangleIndex: a.triangleIndex,
          barycentric: a.barycentric as Vec3,
        }));
        const bvh = buildBvh(upper);
        const insertionAxis = suggestInsertionAxis(
          upper,
          bvh,
          extractMarginRegion(upper, hm, seeds, AXIS_DEFAULT_ROI_RADIUS_MM),
        ).best.direction;

        const pick = (tooth: number): Vec3 => {
          const c = centroidOf(loadReference(tooth).resampledPoints);
          const p = closestPoint(upper, bvh, [
            c[0] + insertionAxis[0] * 3,
            c[1] + insertionAxis[1] * 3,
            c[2] + insertionAxis[2] * 3,
          ]).point;
          return [p[0], p[1], p[2]];
        };
        const nb12 = extractNeighbourRegion(upper, bvh, pick(12), loop11, insertionAxis);
        const nb21 = extractNeighbourRegion(upper, bvh, pick(21), loop11, insertionAxis);
        report('12 (distal)', nb12);
        report('21 (mesial)', nb21);

        const lower = loadLowerjaw();
        const c11 = centroidOf(ref11.resampledPoints);
        // The antagonist seed is the margin centroid itself (the op snaps it to
        // its closest point on the lower arch) — engine/neighbourCapture.ts.
        const antagonist = extractNeighbourRegion(
          lower,
          buildBvh(lower),
          c11,
          loop11,
          insertionAxis,
          { approach: 'occlusal' },
        );
        report('antagonist (lower arch)', antagonist);

        for (const region of [nb12, nb21, antagonist]) {
          const stats = analyzeMesh(region.mesh);
          expect(stats.watertight).toBe(true);
          expect(stats.signedVolumeMm3!).toBeGreaterThan(0);
          expect(region.capturedTriangleCount).toBeGreaterThan(50);
          // Never the restoration's own side of the separating plane.
          const { point, normal } = region.separatingPlane;
          for (let i = 0; i < region.mesh.positions.length; i += 3) {
            const d =
              (region.mesh.positions[i]! - point[0]) * normal[0] +
              (region.mesh.positions[i + 1]! - point[1]) * normal[1] +
              (region.mesh.positions[i + 2]! - point[2]) * normal[2];
            expect(d).toBeGreaterThan(0);
          }
        }
        // 12 and 21 lie on opposite sides of 11.
        const dot =
          nb12.approachDirection[0] * nb21.approachDirection[0] +
          nb12.approachDirection[1] * nb21.approachDirection[1] +
          nb12.approachDirection[2] * nb21.approachDirection[2];
        expect(dot).toBeLessThan(0);

        const starter = loadToothAssetInProcess(TOOTH);
        const asset: PipelineToothAsset = {
          contentHash: starter.metadata.meshChecksum,
          mesh: starter.mesh,
          landmarks: starter.landmarks,
          canonicalFrame: starter.canonicalFrame,
        };
        const ctx: PipelineContext = {
          restorationId: 'arch-case-01-11',
          restorationType: 'crown',
          materialProfile: PROFILE,
          insertionAxis,
          targetMesh: { contentHash: 'upper', mesh: upper },
          marginLoops: {
            [TOOTH]: { closed: ref11.closed, resampledPoints: ref11.resampledPoints },
          },
          neighbors: {
            [12 as FdiTooth]: { contentHash: hashMesh(nb12.mesh), mesh: nb12.mesh },
            [21 as FdiTooth]: { contentHash: hashMesh(nb21.mesh), mesh: nb21.mesh },
          },
          antagonist: { contentHash: hashMesh(antagonist.mesh), mesh: antagonist.mesh },
          stages: {},
        };
        const placed = runAnatomyPlacementStage(ctx, TOOTH, { asset, hashMesh });
        const morph = runMorphingStage(
          { ...ctx, stages: { anatomyPlacement: placed.meshContentHash! } },
          TOOTH,
          {
            placedMesh: { contentHash: placed.meshContentHash!, mesh: placed.mesh! },
            hashMesh,
          },
        );
        const band = {
          proximalMesial: nb21.windowBoundaryBandMm,
          proximalDistal: nb12.windowBoundaryBandMm,
          antagonist: antagonist.windowBoundaryBandMm,
        } as Record<string, number>;
        const contacts: ContactResidualInput[] = (
          morph.params['contacts'] as ContactResidualInput[]
        ).map((c) => ({
          kind: c.kind,
          targetPenetrationMm: c.targetPenetrationMm,
          achievedSignedDistanceMm: c.achievedSignedDistanceMm,
          contactResidualMm: c.contactResidualMm,
          regionResidualMm: c.regionResidualMm,
          clampBound: c.clampBound,
          provenance: 'case',
          neighbourWindowBandMm: band[c.kind]!,
        }));
        const gate = contactGate({
          contacts,
          contactClampWarning: morph.params['contactClampWarning'] as boolean,
        });
        console.log(
          `[NEIGHBOUR-CAPTURE REAL #11] contacts=${JSON.stringify(contacts.map((c) => ({ k: c.kind, achieved_um: +(c.achievedSignedDistanceMm * 1000).toFixed(1), res_um: +(c.contactResidualMm * 1000).toFixed(1), clamp: c.clampBound })))}`,
        );
        console.log(
          `[NEIGHBOUR-CAPTURE REAL #11] contact gate: passed=${gate.passed} value=${gate.value} | ${gate.message}`,
        );

        // Measured on case geometry: no stand-in, a numeric value, the bound disclosed.
        expect(gate.inputProvenance).toBeUndefined();
        expect(Number.isFinite(gate.value)).toBe(true);
        expect(gate.message).toMatch(/captured neighbour window border band ≤/);
        expect(contacts.map((c) => c.kind).sort()).toEqual([
          'antagonist',
          'proximalDistal',
          'proximalMesial',
        ]);
      },
    );
  },
);
