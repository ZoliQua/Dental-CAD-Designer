// packages/cad-pipeline/src/stages/innerSurface.test.ts
//
// Tests for the inner-surface STAGE (innerSurface.ts) — orchestration, not
// re-testing the kernel geometry (that is @dqcad/kernel's
// innerSurfaceOffset.analytic.test.ts, on the analytic shoulder-prep die).
// Here we prove: the profile gaps flow through to the kernel; the ROI is
// derived correctly; the RestorationStageResult shape (mesh, injected
// content hash, operationName, journal params, inputHashes, errorBoundMm) is
// right; the stage is deterministic (journal-replay = identical hash); and
// the required-param / missing-margin guards fire.
//
// The target is a small watertight cone-frustum die built inline (a
// cross-package import of @dqcad/kernel's TEST fixtures would sit outside
// cad-pipeline's tsconfig rootDir) — its bottom rim is the analytic margin
// circle, the taper wall is the prep. Small + clinical pitch keeps each
// offset ~1-2 s.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import {
  analyzeMesh,
  buildBvh,
  computePseudonormals,
  signedClosestPoint,
  INNER_SURFACE_DEFAULT_BLEND_WIDTH_MM,
  type IndexedMesh,
} from '@dqcad/kernel';
import type { PipelineContext, PipelineMaterialProfile } from '../pipeline/context.ts';
import { marginFitGate } from '../gates/index.ts';
import {
  MissingClinicalParamError,
  MissingMarginLoopError,
  prepRegionRoiBbox,
  runInnerSurfaceStage,
} from './innerSurface.ts';

// --- Inline watertight cone-frustum die: bottom rim = margin circle ---
const MARGIN_R = 1.2;
const TOP_R = 0.8;
const MARGIN_Z = 0.5;
const TOP_Z = 2.0;

function sixSignedVolume(pos: Float64Array, idx: Uint32Array): number {
  let s = 0;
  for (let t = 0; t < idx.length / 3; t++) {
    const a = idx[t * 3]! * 3;
    const b = idx[t * 3 + 1]! * 3;
    const c = idx[t * 3 + 2]! * 3;
    const ax = pos[a]!, ay = pos[a + 1]!, az = pos[a + 2]!;
    const bx = pos[b]!, by = pos[b + 1]!, bz = pos[b + 2]!;
    const cx = pos[c]!, cy = pos[c + 1]!, cz = pos[c + 2]!;
    s += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return s;
}

function buildFrustumDie(segments = 96): IndexedMesh {
  const positions: number[] = [];
  const push = (x: number, y: number, z: number): number => {
    positions.push(x, y, z);
    return positions.length / 3 - 1;
  };
  const bottom: number[] = [];
  const top: number[] = [];
  for (let s = 0; s < segments; s++) {
    const th = (2 * Math.PI * s) / segments;
    bottom.push(push(MARGIN_R * Math.cos(th), MARGIN_R * Math.sin(th), MARGIN_Z));
  }
  for (let s = 0; s < segments; s++) {
    const th = (2 * Math.PI * s) / segments;
    top.push(push(TOP_R * Math.cos(th), TOP_R * Math.sin(th), TOP_Z));
  }
  const bottomCenter = push(0, 0, MARGIN_Z);
  const topCenter = push(0, 0, TOP_Z);
  const tris: number[] = [];
  for (let s = 0; s < segments; s++) {
    const sn = (s + 1) % segments;
    // lateral wall
    tris.push(bottom[s]!, bottom[sn]!, top[sn]!);
    tris.push(bottom[s]!, top[sn]!, top[s]!);
    // bottom cap
    tris.push(bottomCenter, bottom[sn]!, bottom[s]!);
    // top cap
    tris.push(topCenter, top[s]!, top[sn]!);
  }
  const pos = new Float64Array(positions);
  let idx = new Uint32Array(tris);
  if (sixSignedVolume(pos, idx) < 0) {
    idx = Uint32Array.from(
      (() => {
        const flipped: number[] = [];
        for (let t = 0; t < idx.length / 3; t++) flipped.push(idx[t * 3]!, idx[t * 3 + 2]!, idx[t * 3 + 1]!);
        return flipped;
      })(),
    );
  }
  return { positions: pos, indices: idx };
}

function marginCircle(n: number): Vec3[] {
  const loop: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    loop.push([MARGIN_R * Math.cos(th), MARGIN_R * Math.sin(th), MARGIN_Z]);
  }
  return loop;
}

function hashMesh(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
}

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
  ponticOvateDepthMm: 1.0, veneeringSpaceMm: 1.0,
};

const TOOTH: FdiTooth = 11 as FdiTooth;

function makeContext(overrides?: Partial<PipelineContext>): PipelineContext {
  const die = buildFrustumDie();
  return {
    restorationId: 'r-test',
    restorationType: 'crown',
    materialProfile: PROFILE,
    insertionAxis: [0, 0, 1],
    targetMesh: { contentHash: 'die-hash-abc', mesh: die },
    marginLoops: { [TOOTH]: { closed: true, resampledPoints: marginCircle(480) } },
    neighbors: {},
    antagonist: null,
    stages: {},
    ...overrides,
  };
}

describe('prepRegionRoiBbox', () => {
  it('bounds the prep ABOVE the margin plane (min z ~= marginZ; excludes below)', () => {
    const die = buildFrustumDie();
    const loop = marginCircle(480);
    const roi = prepRegionRoiBbox(die, loop, [0, 0, 1]);
    expect(roi.min[2]).toBeCloseTo(MARGIN_Z, 6); // margin ring is the lowest included point
    expect(roi.max[2]).toBeCloseTo(TOP_Z, 6);
    // Radial extent covers the margin ring (radius MARGIN_R).
    expect(roi.max[0]).toBeGreaterThanOrEqual(MARGIN_R - 1e-9);
    expect(roi.min[0]).toBeLessThanOrEqual(-MARGIN_R + 1e-9);
  });

  it('throws for a zero-length insertion axis (cannot orient the prep-region split)', () => {
    const die = buildFrustumDie();
    expect(() => prepRegionRoiBbox(die, marginCircle(48), [0, 0, 0])).toThrow(TypeError);
  });
});

describe('runInnerSurfaceStage — orchestration', () => {
  it(
    'flows profile gaps through to the kernel; returns a correctly-shaped, journalable result',
    { timeout: 120_000 },
    async () => {
      const ctx = makeContext();
      const result = await runInnerSurfaceStage(ctx, TOOTH, { pitchMm: 0.06, hashMesh });

      expect(result.stage).toBe('innerSurface');
      expect(result.mesh).not.toBeNull();
      expect(result.meshContentHash).toBe(hashMesh(result.mesh!));
      expect(result.operationName).toBe('innerSurface.build');
      expect(result.inputHashes).toEqual(['die-hash-abc']);
      expect(result.errorBoundMm).toBeGreaterThan(0);

      // Journaled params carry the RESOLVED profile gaps + undercut threshold
      // (proof they came from the profile, not a kernel/pipeline default).
      expect(result.params['marginalGapMm']).toBe(0.02);
      expect(result.params['cementGapMm']).toBe(0.05);
      expect(result.params['spacerStartMm']).toBe(0.8);
      // undercutBlockoutThresholdMm is DELIBERATELY absent — the full draft-close
      // ignores it, so journaling it would be a false audit record (see stage doc).
      expect(result.params['undercutBlockoutThresholdMm']).toBeUndefined();
      expect(result.params['pitchMm']).toBe(0.06);
      expect(result.params['blendWidthMm']).toBe(INNER_SURFACE_DEFAULT_BLEND_WIDTH_MM);
      expect(result.params['tooth']).toBe(TOOTH);
      expect(result.params['skirtTriangleCount']).toBeGreaterThan(0);

      analyzeMesh(result.mesh!);
      expect(result.mesh!.indices.length).toBeGreaterThan(0);

      // ACCEPTANCE: the finished inner surface's boundary == the margin loop
      // (the skirt) -> margin-fit gate PASSES at ~0 (<< 10 µm).
      const fit = marginFitGate({ innerSurfaceMesh: result.mesh!, marginResampledPoints: marginCircle(480) });
      expect(fit.passed).toBe(true);
      expect(fit.value!).toBeLessThanOrEqual(0.010);

      // Spot-check the gaps actually landed on the geometry: near-margin
      // vertices offset ~marginalGap, high vertices ~cementGap.
      const bvh = buildBvh(ctx.targetMesh.mesh);
      const pn = computePseudonormals(ctx.targetMesh.mesh);
      let marginalHit = 0;
      let cementHit = 0;
      expect(result.errorBoundMm).not.toBeNull();
      const bound = result.errorBoundMm ?? 0;
      for (let v = 0; v < result.mesh!.positions.length / 3; v++) {
        const p: Vec3 = [
          result.mesh!.positions[v * 3]!,
          result.mesh!.positions[v * 3 + 1]!,
          result.mesh!.positions[v * 3 + 2]!,
        ];
        const z = p[2]!;
        const off = signedClosestPoint(ctx.targetMesh.mesh, bvh, pn, p).signedDistance;
        if (z < 0.9 && z > MARGIN_Z + 0.1 && Math.abs(off - 0.02) <= bound) marginalHit++;
        if (z > 1.6 && Math.abs(off - 0.05) <= bound) cementHit++;
      }
      expect(marginalHit).toBeGreaterThan(10);
      expect(cementHit).toBeGreaterThan(10);
    },
  );

  it('is deterministic — journal-replay reproduces an identical hash + params', { timeout: 120_000 }, async () => {
    const a = await runInnerSurfaceStage(makeContext(), TOOTH, { pitchMm: 0.07, hashMesh });
    const b = await runInnerSurfaceStage(makeContext(), TOOTH, { pitchMm: 0.07, hashMesh });
    expect(b.meshContentHash).toBe(a.meshContentHash);
    expect(b.params).toEqual(a.params);
    expect(b.errorBoundMm).toBe(a.errorBoundMm);
  });

  it('throws MissingMarginLoopError when the tooth has no margin loop', async () => {
    const ctx = makeContext({ marginLoops: {} });
    await expect(runInnerSurfaceStage(ctx, TOOTH, { pitchMm: 0.05, hashMesh })).rejects.toThrow(MissingMarginLoopError);
  });

  it('throws MissingClinicalParamError when a required gap is non-finite (never defaulted)', async () => {
    const badProfile: PipelineMaterialProfile = {
      ...PROFILE,
      restorationParams: { ...PROFILE.restorationParams, cementGapMm: Number.NaN },
    };
    const ctx = makeContext({ materialProfile: badProfile });
    await expect(runInnerSurfaceStage(ctx, TOOTH, { pitchMm: 0.05, hashMesh })).rejects.toThrow(
      MissingClinicalParamError,
    );
  });
});
