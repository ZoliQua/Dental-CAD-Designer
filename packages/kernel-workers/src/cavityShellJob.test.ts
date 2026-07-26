// cavityShell job test (Phase 5 Task 6) — the inlay/onlay shell worker job.
// The kernel's cavity/inlayShell.test.ts covers the real cavity geometry; here
// we prove the payload→kernel wiring, byte-identity with a direct
// constructInlayShell call, progress, and cancel — on a minimal synthetic
// "bicone" (a top cone + a bottom cone sharing one bit-exact ring, welding into
// a watertight solid, exactly the shared-ring contract the real fit surface +
// occlusal patch satisfy).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { constructInlayShell, type IndexedMesh } from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './jobs/context.js';
import { cavityShellJob } from './jobs/cavityShell.js';

const NOOP_CTX: JobContext = { progress: () => {}, cancelled: () => false };

function hash(pos: Float64Array, idx: Uint32Array): string {
  const h = createHash('sha256');
  h.update(Buffer.from(pos.buffer, pos.byteOffset, pos.byteLength));
  h.update(Buffer.from(idx.buffer, idx.byteOffset, idx.byteLength));
  return h.digest('hex');
}

/** A shared ring of N points on the unit circle (z=0), plus a cone to `apexZ`.
 * The cone is an OPEN surface whose single boundary loop is the ring. */
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

function bicone(): { fit: IndexedMesh; patch: IndexedMesh } {
  const ring: [number, number, number][] = [];
  for (let i = 0; i < 24; i++) {
    const th = (2 * Math.PI * i) / 24;
    ring.push([Math.cos(th), Math.sin(th), 0]);
  }
  return { fit: cone(ring, -1), patch: cone(ring, 1) };
}

describe('cavityShell worker job', () => {
  it('produces a watertight shell byte-identical to a direct constructInlayShell call', async () => {
    const { fit, patch } = bicone();
    const direct = await constructInlayShell(fit, patch);
    const job = await cavityShellJob(
      { fitPositions: fit.positions, fitIndices: fit.indices, patchPositions: patch.positions, patchIndices: patch.indices },
      NOOP_CTX,
    );
    expect(job.watertight).toBe(true);
    expect(job.componentCount).toBe(1);
    expect(job.seamRingVertexCount).toBe(24);
    expect(job.volumeMm3).toBeGreaterThan(0);
    expect(hash(job.positions, job.indices)).toBe(hash(direct.mesh.positions, direct.mesh.indices));
  }, 60000);

  it('reports monotonic progress ending at 1', async () => {
    const { fit, patch } = bicone();
    const fractions: number[] = [];
    const ctx: JobContext = { progress: (f) => fractions.push(f), cancelled: () => false };
    await cavityShellJob({ fitPositions: fit.positions, fitIndices: fit.indices, patchPositions: patch.positions, patchIndices: patch.indices }, ctx);
    expect(fractions[0]).toBe(0);
    expect(fractions[fractions.length - 1]).toBe(1);
    expect(fractions.every((f, i) => i === 0 || f >= fractions[i - 1]!)).toBe(true);
  }, 60000);

  it('throws JobCancelledError when cancelled up front', async () => {
    const { fit, patch } = bicone();
    const ctx: JobContext = { progress: () => {}, cancelled: () => true };
    await expect(
      cavityShellJob({ fitPositions: fit.positions, fitIndices: fit.indices, patchPositions: patch.positions, patchIndices: patch.indices }, ctx),
    ).rejects.toBeInstanceOf(JobCancelledError);
  }, 60000);
});
