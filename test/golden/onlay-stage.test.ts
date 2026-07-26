// test/golden/onlay-stage.test.ts
//
// Phase 5 Task 7 — the onlay cusp-coverage SELECTION stage: onlay-only guard,
// journaling shape, and replay determinism (same context + selection → identical
// extended outline + journal params). Lives in the golden project so it can use
// the kernel onlay fixture (outside cad-pipeline's rootDir).
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { Vec3, FdiTooth } from '@dqcad/shared-types';
import { runCavityCuspCoverageStage, RestorationTypeMismatchError } from '@dqcad/cad-pipeline';
import type { PipelineContext } from '@dqcad/cad-pipeline';
import { modOnlayCavityMesh } from '../../packages/kernel/src/cavity/cavity.test-fixtures.ts';

const TOOTH: FdiTooth = 36;
const hashOutline = (pts: readonly Vec3[]): string => createHash('sha256').update(Buffer.from(new Float64Array(pts.flatMap((p) => [p[0], p[1], p[2]])).buffer)).digest('hex');

function makeContext(restorationType: 'inlay' | 'onlay'): { ctx: PipelineContext; covered: Uint32Array; onlayLen: number } {
  const fx = modOnlayCavityMesh();
  const profile = {
    restorationParams: { cementGapMm: 0.05, marginalGapMm: 0.02, spacerStartMm: 0.8, minWallThicknessMm: 0.5, proximalContactPenetrationMm: 0.02, occlusalContactMm: 0.02 },
    undercutBlockoutThresholdMm: 0.1, occlusalMinWallThicknessMm: 1.0, inlayMinThicknessMm: 1.0, onlayMinThicknessMm: 1.0,
    cuspCoverageMinThicknessMm: 1.5, marginExclusionMm: 1.8, maxChordDeviationMm: 0.05, connectorAreaMm2: 7,
  };
  const ctx = {
    restorationId: 'r1', restorationType, materialProfile: profile,
    insertionAxis: [0, 0, 1] as Vec3, targetMesh: { contentHash: 'onlay-hash', mesh: fx.mesh },
    marginLoops: { [TOOTH]: { closed: true, resampledPoints: fx.inlayOutline } },
    neighbors: {}, antagonist: null, stages: {},
  } as unknown as PipelineContext;
  return { ctx, covered: fx.coveredCuspTriangleIndices, onlayLen: fx.onlayOutline.length };
}

describe('runCavityCuspCoverageStage', () => {
  it('extends the outline over the covered cusp and journals cuspCoverage.select', () => {
    const { ctx, covered, onlayLen } = makeContext('onlay');
    const res = runCavityCuspCoverageStage(ctx, TOOTH, { coveredCuspTriangleIndices: covered, hashOutline });
    expect(res.operationName).toBe('cuspCoverage.select');
    expect(res.stage).toBe('innerSurface');
    expect(res.mesh).toBeNull();
    expect(res.errorBoundMm).toBeNull();
    expect(res.inputHashes).toEqual(['onlay-hash']);
    expect(res.extendedOutline.length).toBe(onlayLen);
    expect(res.params.restorationType).toBe('onlay');
    expect(res.params.coveredCuspCount).toBe(1);
  });

  it('replay reproduces the identical extended outline + journal hash', () => {
    const a = makeContext('onlay');
    const resA = runCavityCuspCoverageStage(a.ctx, TOOTH, { coveredCuspTriangleIndices: a.covered, hashOutline });
    const b = makeContext('onlay');
    const resB = runCavityCuspCoverageStage(b.ctx, TOOTH, { coveredCuspTriangleIndices: b.covered, hashOutline });
    expect(resB.params.extendedOutlineHash).toBe(resA.params.extendedOutlineHash);
    expect(hashOutline(resB.extendedOutline)).toBe(hashOutline(resA.extendedOutline));
  });

  it('rejects an INLAY context (onlay-only guard rail)', () => {
    const { ctx, covered } = makeContext('inlay');
    expect(() => runCavityCuspCoverageStage(ctx, TOOTH, { coveredCuspTriangleIndices: covered, hashOutline })).toThrow(RestorationTypeMismatchError);
  });
});
