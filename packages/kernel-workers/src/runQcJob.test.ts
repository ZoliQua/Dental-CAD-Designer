// runQc job test (Phase 4 Task 9) — the crown QC-gate-suite worker job.
// cad-pipeline's gate tests cover each gate's logic; here we prove the
// payload→runCrownQc wiring, the full 8-gate report shape, monotonic per-gate
// progress to 1, and cooperative cancellation. A genuine watertight synthetic
// crown is built (buildInnerSurface + constructShell) so every gate has real
// input; contact residuals are supplied on-target inline (the morph is not the
// subject here).
import { describe, expect, it } from 'vitest';
import { buildInnerSurface, constructShell, KERNEL_VERSION, type IndexedMesh, type Vec3 } from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './jobs/context.js';
import { runQcJob } from './jobs/runQc.js';

const AXIS: Vec3 = [0, 0, 1];
const MARGIN_R = 1.2, TOP_R = 0.8, MARGIN_Z = 0.5, TOP_Z = 2.0;

function buildFrustum(mR: number, tR: number, mZ: number, tZ: number, seg: number, capTop: boolean, capBot: boolean): IndexedMesh {
  const P: number[] = [];
  const push = (x: number, y: number, z: number): number => { P.push(x, y, z); return P.length / 3 - 1; };
  const b: number[] = [], t: number[] = [];
  for (let s = 0; s < seg; s++) { const th = (2 * Math.PI * s) / seg; b.push(push(mR * Math.cos(th), mR * Math.sin(th), mZ)); }
  for (let s = 0; s < seg; s++) { const th = (2 * Math.PI * s) / seg; t.push(push(tR * Math.cos(th), tR * Math.sin(th), tZ)); }
  const tr: number[] = [];
  for (let s = 0; s < seg; s++) { const sn = (s + 1) % seg; tr.push(b[s]!, b[sn]!, t[sn]!); tr.push(b[s]!, t[sn]!, t[s]!); }
  if (capBot) { const bc = push(0, 0, mZ); for (let s = 0; s < seg; s++) { const sn = (s + 1) % seg; tr.push(bc, b[sn]!, b[s]!); } }
  if (capTop) { const tc = push(0, 0, tZ); for (let s = 0; s < seg; s++) { const sn = (s + 1) % seg; tr.push(tc, t[s]!, t[sn]!); } }
  return { positions: new Float64Array(P), indices: Uint32Array.from(tr) };
}
function marginFlat(r: number, z: number, n: number): Float64Array {
  const flat: number[] = [];
  for (let i = 0; i < n; i++) { const th = (2 * Math.PI * i) / n; flat.push(r * Math.cos(th), r * Math.sin(th), z); }
  return new Float64Array(flat);
}

async function buildPayload() {
  const die = buildFrustum(MARGIN_R, TOP_R, MARGIN_Z, TOP_Z, 96, true, true);
  const marginPts: Vec3[] = [];
  const marginFlatArr = marginFlat(MARGIN_R, MARGIN_Z, 240);
  for (let i = 0; i < marginFlatArr.length; i += 3) marginPts.push([marginFlatArr[i]!, marginFlatArr[i + 1]!, marginFlatArr[i + 2]!]);
  const inner = (await buildInnerSurface(die, { pitchMm: 0.1, marginalGapMm: 0.02, cementGapMm: 0.05, spacerStartMm: 0.8, blendWidthMm: 0.3, marginLoop: marginPts, insertionAxis: AXIS })).mesh;
  const outer = buildFrustum(MARGIN_R + 1.0, TOP_R + 1.0, MARGIN_Z, TOP_Z + 1.0, 96, true, false);
  const shell = await constructShell(outer, inner, { insertionAxis: AXIS, marginLoop: marginPts });
  return {
    crownPositions: shell.mesh.positions, crownIndices: shell.mesh.indices,
    innerPositions: inner.positions, innerIndices: inner.indices,
    outerPositions: shell.outerUsedMesh.positions, outerIndices: shell.outerUsedMesh.indices,
    diePositions: die.positions, dieIndices: die.indices,
    marginLoop: marginFlatArr, insertionAxis: AXIS,
    minWallThicknessMm: 0.5, occlusalMinWallThicknessMm: 0.5, connectorAreaTargetMm2: 7,
    contacts: [
      { kind: 'proximalMesial', targetPenetrationMm: 0.02, achievedSignedDistanceMm: -0.02, contactResidualMm: 0.0002, regionResidualMm: 0.0003, clampBound: false },
      { kind: 'proximalDistal', targetPenetrationMm: 0.02, achievedSignedDistanceMm: -0.02, contactResidualMm: 0.0002, regionResidualMm: 0.0003, clampBound: false },
      { kind: 'antagonist', targetPenetrationMm: 0, achievedSignedDistanceMm: 0, contactResidualMm: 0.0001, regionResidualMm: 0.0001, clampBound: false },
    ],
    contactClampWarning: false,
    kernelVersion: KERNEL_VERSION, profileVersion: '1.1.0', journalHash: 'jh',
  };
}

describe('runQcJob', () => {
  it('runs the full 8-gate report; progress climbs to 1', async () => {
    const payload = await buildPayload();
    const progresses: number[] = [];
    const ctx: JobContext = { progress: (f) => progresses.push(f), cancelled: () => false };
    const { report } = await runQcJob(payload, ctx);

    expect(report.gates.map((g) => g.gate)).toEqual([
      'watertight', 'manifold', 'selfIntersection', 'minWallThickness', 'marginFit', 'seating', 'connectorCrossSection', 'contact',
    ]);
    expect(report.kernelVersion).toBe(KERNEL_VERSION);
    for (const g of report.gates) expect(g.passed, `${g.gate}: ${g.message}`).toBe(true);
    expect(report.passed).toBe(true);
    expect(progresses.at(-1)).toBe(1);
    // Monotonic non-decreasing.
    for (let i = 1; i < progresses.length; i++) expect(progresses[i]!).toBeGreaterThanOrEqual(progresses[i - 1]!);
  }, 120000);

  it('throws JobCancelledError when cancelled up front', async () => {
    const payload = await buildPayload();
    const ctx: JobContext = { progress: () => {}, cancelled: () => true };
    await expect(runQcJob(payload, ctx)).rejects.toBeInstanceOf(JobCancelledError);
  }, 120000);
});
