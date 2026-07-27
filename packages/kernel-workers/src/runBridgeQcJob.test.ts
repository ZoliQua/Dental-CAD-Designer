// runBridgeQc job test (Phase 6 Task 7) — the whole-bridge QC-suite worker job.
// The full clinical acceptance runs in test/golden/bridge-acceptance.test.ts (the
// real assembled 3-unit chain); here we prove the payload→cad-pipeline wiring:
// the job returns a QcReport byte-identical to a direct runBridgeQc call at the
// same manifold-3d version, reports the full whole-bridge gate set, and cancels
// up front. Mirrors runInlayQcJob.test.ts. The geometry is the analytic
// `bridgeAssemblyFixture` fused via `assembleBridge` (the gate PASS/FAIL values
// are not the point — the wiring + determinism are).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assembleBridge, KERNEL_VERSION, type Vec3 } from '@dqcad/kernel';
import {
  runBridgeQc,
  connectorPositionalTargetMm2,
  type RunBridgeQcInput,
  type BridgeUnitQcInput,
  type ConnectorCrossSection,
} from '@dqcad/cad-pipeline';
import type { FdiTooth, QcReport } from '@dqcad/shared-types';
import { bridgeAssemblyFixture } from '@dqcad/kernel/bridge-fixtures';
import { JobCancelledError, type JobContext } from './jobs/context.js';
import { runBridgeQcJob, type RunBridgeQcPayload } from './jobs/runBridgeQc.js';

const NOOP_CTX: JobContext = { progress: () => {}, cancelled: () => false };
const TARGETS = { posteriorMm2: 9, anteriorMm2: 7 };

function reportHash(r: QcReport): string {
  return createHash('sha256').update(JSON.stringify(r)).digest('hex');
}
function flat(loop: readonly Vec3[]): Float64Array {
  return Float64Array.from(loop.flatMap((p) => [p[0], p[1], p[2]]));
}

async function scenario(): Promise<{ input: RunBridgeQcInput; payload: RunBridgeQcPayload }> {
  const fx = bridgeAssemblyFixture();
  const assembled = (await assembleBridge(fx.solids)).solid;

  const units: BridgeUnitQcInput[] = fx.units.map((u) => ({
    label: u.label,
    kind: u.kind,
    innerSurfaceMesh: u.innerSurfaceMesh,
    outerSurfaceMesh: u.outerSurfaceMesh,
    insertionAxis: u.insertionAxis,
    marginLoop: u.marginLoop,
    fitRegion: u.kind === 'abutment' ? u.fitRegion : undefined,
  }));
  const dieSolids = fx.units.filter((u) => u.die).map((u) => u.die!);
  const connectors: ConnectorCrossSection[] = fx.connectors.map((c) => {
    const teeth: [FdiTooth, FdiTooth] = [c.teeth[0] as FdiTooth, c.teeth[1] as FdiTooth];
    return { label: c.label, minAreaMm2: c.minAreaMm2, teeth, targetMm2: connectorPositionalTargetMm2(teeth[0], teeth[1], TARGETS) };
  });
  const ponticRelief = { maxAbsDeviationMm: 0.0002, style: 'hygienic', configuredReliefMm: 2.0 };

  const input: RunBridgeQcInput = {
    assembledSolid: assembled,
    units,
    dieSolids,
    connectors,
    minWallThicknessMm: 0.5,
    occlusalMinWallThicknessMm: 0.5,
    connectorAreaTargetMm2: TARGETS.posteriorMm2,
    frameworkMinThicknessMm: 0.5,
    ponticRelief,
    kernelVersion: KERNEL_VERSION,
    profileVersion: '1.4.0',
    journalHash: 'wiring-test',
  };

  const payload: RunBridgeQcPayload = {
    assembledPositions: assembled.positions,
    assembledIndices: assembled.indices,
    units: fx.units.map((u) => ({
      label: u.label,
      kind: u.kind,
      innerPositions: u.innerSurfaceMesh.positions,
      innerIndices: u.innerSurfaceMesh.indices,
      outerPositions: u.outerSurfaceMesh.positions,
      outerIndices: u.outerSurfaceMesh.indices,
      insertionAxis: u.insertionAxis,
      marginLoopFlat: flat(u.marginLoop),
      ...(u.kind === 'abutment' ? { fitRegion: u.fitRegion } : {}),
    })),
    dies: dieSolids.map((d) => ({ positions: d.positions, indices: d.indices })),
    connectors: connectors.map((c) => ({ label: c.label, minAreaMm2: c.minAreaMm2, teeth: c.teeth, targetMm2: c.targetMm2 })),
    minWallThicknessMm: 0.5,
    occlusalMinWallThicknessMm: 0.5,
    connectorAreaTargetMm2: TARGETS.posteriorMm2,
    frameworkMinThicknessMm: 0.5,
    ponticRelief,
    kernelVersion: KERNEL_VERSION,
    profileVersion: '1.4.0',
    journalHash: 'wiring-test',
  };
  return { input, payload };
}

describe('runBridgeQc worker job', () => {
  it('returns a report byte-identical to a direct runBridgeQc call, with the full whole-bridge gate set', async () => {
    const { input, payload } = await scenario();
    const direct = await runBridgeQc(input);
    const { report } = await runBridgeQcJob(payload, NOOP_CTX);
    expect(report.gates.map((g) => g.gate)).toEqual([
      'watertight',
      'manifold',
      'selfIntersection',
      'minWallThickness:14',
      'minWallThickness:15',
      'minWallThickness:16',
      'connectorCrossSection',
      'marginFit:14',
      'marginFit:16',
      'ponticRelief',
      'seating',
    ]);
    expect(reportHash(report)).toBe(reportHash(direct));
  }, 120000);

  it('throws JobCancelledError when cancelled up front', async () => {
    const { payload } = await scenario();
    const ctx: JobContext = { progress: () => {}, cancelled: () => true };
    await expect(runBridgeQcJob(payload, ctx)).rejects.toBeInstanceOf(JobCancelledError);
  }, 120000);
});
