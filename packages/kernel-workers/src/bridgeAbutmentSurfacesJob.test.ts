// bridgeAbutmentSurfaces job tests (Phase 6 Task 2) — exercised via a real Node
// worker_threads WorkerPool. The per-abutment inner-surface geometry (shared-vs-
// own axis, self-consistency, margin fit) is covered at the kernel level
// (packages/kernel/src/bridge/abutmentInnerSurface.test.ts); these tests prove
// the job wires @dqcad/kernel's `buildInnerSurface` PER ABUTMENT (against the
// SHARED axis) through a real worker correctly: staged progress across
// abutments, genuine mid-computation cancellation, typed-error propagation, and
// per-abutment BYTE-IDENTITY with a direct kernel call.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildInnerSurface, type Vec3 } from '@dqcad/kernel';
import { JobCancelledError, WorkerPool } from './pool.js';

const pools: WorkerPool[] = [];
function createPool(opts?: ConstructorParameters<typeof WorkerPool>[0]): WorkerPool {
  const pool = new WorkerPool(opts);
  pools.push(pool);
  return pool;
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.destroy()));
});

const MARGIN_R = 1.2, TOP_R = 0.8, MARGIN_Z = 0.5, TOP_Z = 2.0;
const GAPS = { marginalGapMm: 0.02, cementGapMm: 0.05, spacerStartMm: 0.8, blendWidthMm: 0.3 };
const SHARED_AXIS: Vec3 = [0, 0, 1];

/** One watertight cone-frustum die centred at (cx, 0). */
function frustumDie(cx: number, segments = 96): { positions: number[]; indices: number[] } {
  const pos: number[] = [];
  const push = (x: number, y: number, z: number): number => { pos.push(x, y, z); return pos.length / 3 - 1; };
  const bottom: number[] = [];
  const top: number[] = [];
  for (let s = 0; s < segments; s++) { const th = (2 * Math.PI * s) / segments; bottom.push(push(cx + MARGIN_R * Math.cos(th), MARGIN_R * Math.sin(th), MARGIN_Z)); }
  for (let s = 0; s < segments; s++) { const th = (2 * Math.PI * s) / segments; top.push(push(cx + TOP_R * Math.cos(th), TOP_R * Math.sin(th), TOP_Z)); }
  const bc = push(cx, 0, MARGIN_Z);
  const tc = push(cx, 0, TOP_Z);
  const tris: number[] = [];
  for (let s = 0; s < segments; s++) {
    const sn = (s + 1) % segments;
    tris.push(bottom[s]!, bottom[sn]!, top[sn]!);
    tris.push(bottom[s]!, top[sn]!, top[s]!);
    tris.push(bc, bottom[sn]!, bottom[s]!);
    tris.push(tc, top[s]!, top[sn]!);
  }
  return { positions: pos, indices: tris };
}

/** Two dies at x = ∓6 concatenated into one "arch" mesh. */
function archMesh(): { positions: Float64Array; indices: Uint32Array } {
  const a = frustumDie(-6);
  const b = frustumDie(6);
  const va = a.positions.length / 3;
  const positions = new Float64Array([...a.positions, ...b.positions]);
  const indices = Uint32Array.from([...a.indices, ...b.indices.map((i) => i + va)]);
  return { positions, indices };
}

function marginLoop(cx: number, n: number): { flat: Float64Array; vecs: Vec3[] } {
  const flat = new Float64Array(n * 3);
  const vecs: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    const p: Vec3 = [cx + MARGIN_R * Math.cos(th), MARGIN_R * Math.sin(th), MARGIN_Z];
    flat[i * 3] = p[0]; flat[i * 3 + 1] = p[1]; flat[i * 3 + 2] = p[2];
    vecs.push(p);
  }
  return { flat, vecs };
}

function hashBuffers(positions: Float64Array, indices: Uint32Array): string {
  const hash = createHash('sha256');
  hash.update(Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength));
  hash.update(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength));
  return hash.digest('hex');
}

async function buildBvhFor(pool: WorkerPool, contentHash: string, positions: Float64Array, indices: Uint32Array): Promise<void> {
  await pool.run('buildBvh', { contentHash, positions, indices });
}

describe('bridgeAbutmentSurfaces job', () => {
  it('builds BOTH abutments (shared axis); each BYTE-IDENTICAL to a direct buildInnerSurface; staged progress ends at 1', { timeout: 180_000 }, async () => {
    const pool = createPool({ size: 1 });
    const arch = archMesh();
    const m = marginLoop(-6, 180);
    const d = marginLoop(6, 180);
    const contentHash = 'bridge-abutments-byte-identity';
    await buildBvhFor(pool, contentHash, arch.positions.slice(), arch.indices.slice());

    const progress: number[] = [];
    const jobResult = await pool.run(
      'bridgeAbutmentSurfaces',
      {
        contentHash,
        ...GAPS,
        pitchMm: 0.08,
        insertionAxis: SHARED_AXIS,
        abutments: [
          { tooth: 14, marginLoop: m.flat.slice() },
          { tooth: 16, marginLoop: d.flat.slice() },
        ],
      },
      { onProgress: (f) => progress.push(f) },
    );

    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(1);
    for (let i = 1; i < progress.length; i++) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
    expect(jobResult.abutments.map((a) => a.tooth)).toEqual([14, 16]);
    expect(jobResult.insertionAxis).toEqual(SHARED_AXIS);

    const directM = await buildInnerSurface(arch, { ...GAPS, pitchMm: 0.08, marginLoop: m.vecs, insertionAxis: SHARED_AXIS });
    const directD = await buildInnerSurface(arch, { ...GAPS, pitchMm: 0.08, marginLoop: d.vecs, insertionAxis: SHARED_AXIS });
    expect(hashBuffers(jobResult.abutments[0]!.positions, jobResult.abutments[0]!.indices)).toBe(
      hashBuffers(directM.mesh.positions, directM.mesh.indices),
    );
    expect(hashBuffers(jobResult.abutments[1]!.positions, jobResult.abutments[1]!.indices)).toBe(
      hashBuffers(directD.mesh.positions, directD.mesh.indices),
    );
    expect(jobResult.abutments[0]!.stats).toEqual(directM.stats);
    expect(jobResult.abutments[1]!.stats).toEqual(directD.stats);
  });

  it('rejects a contentHash with no cached BVH on this worker', async () => {
    const pool = createPool({ size: 1 });
    const m = marginLoop(-6, 32);
    await expect(
      pool.run('bridgeAbutmentSurfaces', {
        contentHash: 'never-built', ...GAPS, pitchMm: 0.1, insertionAxis: SHARED_AXIS,
        abutments: [{ tooth: 14, marginLoop: m.flat }],
      }),
    ).rejects.toMatchObject({ name: 'BvhNotCachedError' });
  });

  it('rejects invalid pitch / empty abutments before any heavy work', async () => {
    const pool = createPool({ size: 1 });
    const arch = archMesh();
    const m = marginLoop(-6, 32);
    const contentHash = 'bridge-abutments-invalid';
    await buildBvhFor(pool, contentHash, arch.positions, arch.indices);
    await expect(
      pool.run('bridgeAbutmentSurfaces', { contentHash, ...GAPS, pitchMm: 0, insertionAxis: SHARED_AXIS, abutments: [{ tooth: 14, marginLoop: m.flat.slice() }] }),
    ).rejects.toMatchObject({ name: 'TypeError' });
    await expect(
      pool.run('bridgeAbutmentSurfaces', { contentHash, ...GAPS, pitchMm: 0.1, insertionAxis: SHARED_AXIS, abutments: [] }),
    ).rejects.toMatchObject({ name: 'TypeError' });
  });

  it('is cancellable GENUINELY MID-COMPUTATION (abort from onProgress during the first abutment)', { timeout: 180_000 }, async () => {
    const pool = createPool({ size: 1 });
    const arch = archMesh();
    const m = marginLoop(-6, 180);
    const d = marginLoop(6, 180);
    const contentHash = 'bridge-abutments-mid-cancel';
    await buildBvhFor(pool, contentHash, arch.positions, arch.indices);

    const controller = new AbortController();
    let abortedMid = false;
    await expect(
      pool.run(
        'bridgeAbutmentSurfaces',
        {
          contentHash, ...GAPS, pitchMm: 0.04, insertionAxis: SHARED_AXIS,
          abutments: [{ tooth: 14, marginLoop: m.flat }, { tooth: 16, marginLoop: d.flat }],
        },
        {
          signal: controller.signal,
          onProgress: (f) => {
            if (f > 0 && f < 0.5 && !abortedMid) { abortedMid = true; controller.abort(); }
          },
        },
      ),
    ).rejects.toBeInstanceOf(JobCancelledError);
    expect(abortedMid).toBe(true);
  });
});
