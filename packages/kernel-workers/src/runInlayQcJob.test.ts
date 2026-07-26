// runInlayQc job test (Phase 5 Task 6) — the inlay/onlay QC-suite worker job.
// The full clinical acceptance runs in test/golden/inlay-shell-acceptance.test.ts
// (the real coupled MOD chain); here we prove the payload→cad-pipeline wiring:
// the job returns a QcReport byte-identical to a direct runInlayQc call at the
// same manifold-3d version, reports the full gate set, and cancels up front.
// The geometry is a minimal synthetic bicone inlay in a box "tooth" (the gate
// PASS/FAIL values are not the point — the wiring + determinism are).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KERNEL_VERSION, type IndexedMesh, type Vec3 } from '@dqcad/kernel';
import { runInlayQc, type RunInlayQcInput } from '@dqcad/cad-pipeline';
import type { QcReport } from '@dqcad/shared-types';
import { JobCancelledError, type JobContext } from './jobs/context.js';
import { runInlayQcJob, type RunInlayQcPayload } from './jobs/runInlayQc.js';

const NOOP_CTX: JobContext = { progress: () => {}, cancelled: () => false };
const AXIS: Vec3 = [0, 0, 1];

function reportHash(r: QcReport): string {
  return createHash('sha256').update(JSON.stringify(r)).digest('hex');
}
function cone(ring: [number, number, number][], apexZ: number): IndexedMesh {
  const P: number[] = [];
  for (const p of ring) P.push(p[0], p[1], p[2]);
  const apex = P.length / 3;
  P.push(0, 0, apexZ);
  const tris: number[] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) tris.push(i, (i + 1) % n, apex);
  return { positions: new Float64Array(P), indices: Uint32Array.from(tris) };
}
function biconeSolid(fit: IndexedMesh, patch: IndexedMesh): IndexedMesh {
  // Weld the two cones' shared ring into one watertight solid (same 24-ring).
  const off = fit.positions.length / 3;
  const positions = new Float64Array(fit.positions.length + patch.positions.length);
  positions.set(fit.positions, 0);
  positions.set(patch.positions, fit.positions.length);
  const idx = [...fit.indices];
  for (const v of patch.indices) idx.push(v + off);
  // The two rings coincide (indices 0..23 in each) — remap patch ring to fit ring.
  const remapped = idx.map((v) => (v >= off && v - off < 24 ? v - off : v));
  return { positions, indices: Uint32Array.from(remapped) };
}
function outwardBox(min: Vec3, max: Vec3): IndexedMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const idx = [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return { positions: new Float64Array(v), indices: Uint32Array.from(idx) };
}

function scenario(): { input: RunInlayQcInput; payload: RunInlayQcPayload } {
  const ring: [number, number, number][] = [];
  for (let i = 0; i < 24; i++) {
    const th = (2 * Math.PI * i) / 24;
    ring.push([Math.cos(th), Math.sin(th), 0]);
  }
  const fit = cone(ring, -1);
  const patch = cone(ring, 1);
  const inlay = biconeSolid(fit, patch);
  const tooth = outwardBox([-3, -3, -3], [3, 3, 3]);
  const outline: Vec3[] = ring;
  const input: RunInlayQcInput = {
    inlaySolid: inlay,
    fitSurfaceMesh: fit,
    patchMesh: patch,
    toothWithCavitySolid: tooth,
    cavityOutlineResampledPoints: outline,
    insertionAxis: AXIS,
    restorationType: 'inlay',
    thicknessMinimums: { inlayMinThicknessMm: 1.0, onlayMinThicknessMm: 1.0 },
    marginExclusionMm: 0.2,
    seamEdges: [],
    cavityTriangleIndices: new Uint32Array(),
    contacts: [],
    contactClampWarning: false,
    kernelVersion: KERNEL_VERSION,
    profileVersion: '1.0.0',
    journalHash: 'wiring-test',
  };
  const flat = (loop: Vec3[]): Float64Array => Float64Array.from(loop.flat());
  const payload: RunInlayQcPayload = {
    inlayPositions: inlay.positions, inlayIndices: inlay.indices,
    fitPositions: fit.positions, fitIndices: fit.indices,
    patchPositions: patch.positions, patchIndices: patch.indices,
    toothPositions: tooth.positions, toothIndices: tooth.indices,
    cavityOutline: flat(outline),
    insertionAxis: AXIS,
    restorationType: 'inlay',
    thicknessMinimums: { inlayMinThicknessMm: 1.0, onlayMinThicknessMm: 1.0 },
    marginExclusionMm: 0.2,
    seamEdges: [],
    cavityTriangleIndices: new Uint32Array(),
    contacts: [],
    contactClampWarning: false,
    kernelVersion: KERNEL_VERSION,
    profileVersion: '1.0.0',
    journalHash: 'wiring-test',
  };
  return { input, payload };
}

describe('runInlayQc worker job', () => {
  it('returns a report byte-identical to a direct runInlayQc call, with the full gate set', async () => {
    const { input, payload } = scenario();
    const direct = await runInlayQc(input);
    const { report } = await runInlayQcJob(payload, NOOP_CTX);
    expect(report.gates.map((g) => g.gate)).toEqual([
      'watertight', 'manifold', 'selfIntersection', 'minWallThickness', 'marginFit', 'seamDihedral', 'seating', 'contact',
    ]);
    expect(reportHash(report)).toBe(reportHash(direct));
  }, 60000);

  it('throws JobCancelledError when cancelled up front', async () => {
    const { payload } = scenario();
    const ctx: JobContext = { progress: () => {}, cancelled: () => true };
    await expect(runInlayQcJob(payload, ctx)).rejects.toBeInstanceOf(JobCancelledError);
  }, 60000);
});
