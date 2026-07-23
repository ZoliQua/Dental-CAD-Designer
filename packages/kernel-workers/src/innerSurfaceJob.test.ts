// innerSurface job tests (Phase 4 Tasks 3+4) — exercised via a real Node
// worker_threads WorkerPool. The full inner-surface algorithm (two-zone
// offset + solid undercut blockout + skirt-to-margin: zone accuracy, C1
// blend, draft-close self-consistency, margin fit, `@errorBound`) is covered
// at the kernel level (packages/kernel/src/offset/innerSurfaceSolid*.test.ts);
// these tests prove the job wires @dqcad/kernel's `buildInnerSurface` through a
// real worker correctly: staged progress, genuine mid-computation
// cancellation, typed-error propagation across Comlink, byte-identity with a
// direct kernel call, and the contentHash-keyed cache + BVH-mesh-reuse contract.
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

/** A shoulder-prep-like cone frustum die (bottom rim = margin circle at z),
 * closed & watertight — a small analytic prep the inner-surface op accepts. */
function frustumDie(marginR: number, topR: number, marginZ: number, topZ: number, segments = 96): { positions: Float64Array; indices: Uint32Array } {
  const pos: number[] = [];
  const push = (x: number, y: number, z: number): number => { pos.push(x, y, z); return pos.length / 3 - 1; };
  const bottom: number[] = [];
  const top: number[] = [];
  for (let s = 0; s < segments; s++) { const th = (2 * Math.PI * s) / segments; bottom.push(push(marginR * Math.cos(th), marginR * Math.sin(th), marginZ)); }
  for (let s = 0; s < segments; s++) { const th = (2 * Math.PI * s) / segments; top.push(push(topR * Math.cos(th), topR * Math.sin(th), topZ)); }
  const bc = push(0, 0, marginZ);
  const tc = push(0, 0, topZ);
  const tris: number[] = [];
  for (let s = 0; s < segments; s++) {
    const sn = (s + 1) % segments;
    tris.push(bottom[s]!, bottom[sn]!, top[sn]!);
    tris.push(bottom[s]!, top[sn]!, top[s]!);
    tris.push(bc, bottom[sn]!, bottom[s]!);
    tris.push(tc, top[s]!, top[sn]!);
  }
  return { positions: new Float64Array(pos), indices: Uint32Array.from(tris) };
}

function marginLoop(r: number, z: number, n: number): { flat: Float64Array; vecs: Vec3[] } {
  const flat = new Float64Array(n * 3);
  const vecs: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    const p: Vec3 = [r * Math.cos(th), r * Math.sin(th), z];
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

async function buildBvhFor(pool: WorkerPool, contentHash: string, positions: Float64Array, indices: Uint32Array) {
  await pool.run('buildBvh', { contentHash, positions, indices });
}

const GAPS = { marginalGapMm: 0.02, cementGapMm: 0.05, spacerStartMm: 0.8, blendWidthMm: 0.3 };
const AXIS: Vec3 = [0, 0, 1];
const MARGIN_R = 1.2, TOP_R = 0.8, MARGIN_Z = 0.5, TOP_Z = 2.0;

describe('innerSurface job', () => {
  it('produces a mesh BYTE-IDENTICAL to a direct buildInnerSurface call, with staged progress ending at 1', { timeout: 120_000 }, async () => {
    const pool = createPool({ size: 1 });
    const die = frustumDie(MARGIN_R, TOP_R, MARGIN_Z, TOP_Z);
    const { flat, vecs } = marginLoop(MARGIN_R, MARGIN_Z, 180);
    const contentHash = 'inner-surface-byte-identity';
    await buildBvhFor(pool, contentHash, die.positions.slice(), die.indices.slice());

    const progress: number[] = [];
    const jobResult = await pool.run(
      'innerSurface',
      { contentHash, ...GAPS, pitchMm: 0.08, marginLoop: flat.slice(), insertionAxis: AXIS },
      { onProgress: (f) => progress.push(f) },
    );

    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(1);
    expect(progress.length).toBeGreaterThan(4);
    for (let i = 1; i < progress.length; i++) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
    expect(jobResult.errorBoundMm).toBeGreaterThan(0.08 / 2);
    expect(jobResult.skirtTriangleCount).toBeGreaterThan(0);

    const direct = await buildInnerSurface(die, { ...GAPS, pitchMm: 0.08, marginLoop: vecs, insertionAxis: AXIS });
    expect(hashBuffers(jobResult.positions, jobResult.indices)).toBe(hashBuffers(direct.mesh.positions, direct.mesh.indices));
    expect(jobResult.stats).toEqual(direct.stats);
    expect(jobResult.errorBoundMm).toBe(direct.errorBoundMm);
    expect(jobResult.patchTriangleCount).toBe(direct.patchTriangleCount);
  });

  it('cache hit: an identical second call returns a byte-identical clone without re-running', { timeout: 120_000 }, async () => {
    const pool = createPool({ size: 1 });
    const die = frustumDie(MARGIN_R, TOP_R, MARGIN_Z, TOP_Z);
    const { flat } = marginLoop(MARGIN_R, MARGIN_Z, 120);
    const contentHash = 'inner-surface-cache';
    await buildBvhFor(pool, contentHash, die.positions, die.indices);
    const payload = { contentHash, ...GAPS, pitchMm: 0.1, insertionAxis: AXIS } as const;

    const first = await pool.run('innerSurface', { ...payload, marginLoop: flat.slice() });
    const progress: number[] = [];
    const second = await pool.run('innerSurface', { ...payload, marginLoop: flat.slice() }, { onProgress: (f) => progress.push(f) });
    expect(progress).toEqual([0, 1]);
    expect(second.positions.buffer).not.toBe(first.positions.buffer);
    expect(hashBuffers(second.positions, second.indices)).toBe(hashBuffers(first.positions, first.indices));
  });

  it('rejects a contentHash with no cached BVH on this worker', async () => {
    const pool = createPool({ size: 1 });
    const { flat } = marginLoop(MARGIN_R, MARGIN_Z, 32);
    await expect(
      pool.run('innerSurface', { contentHash: 'never-built', ...GAPS, pitchMm: 0.1, marginLoop: flat, insertionAxis: AXIS }),
    ).rejects.toMatchObject({ name: 'BvhNotCachedError' });
  });

  it('propagates NonWatertightMeshError for an open target', async () => {
    const pool = createPool({ size: 1 });
    const open = { positions: new Float64Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), indices: Uint32Array.from([0, 1, 2, 0, 2, 3]) };
    const { flat } = marginLoop(0.3, 0.1, 24);
    const contentHash = 'inner-surface-open';
    await buildBvhFor(pool, contentHash, open.positions, open.indices);
    await expect(
      pool.run('innerSurface', { contentHash, ...GAPS, pitchMm: 0.1, marginLoop: flat, insertionAxis: AXIS }),
    ).rejects.toMatchObject({ name: 'NonWatertightMeshError' });
  });

  it('rejects invalid pitch / too-narrow blend before any heavy work', async () => {
    const pool = createPool({ size: 1 });
    const die = frustumDie(MARGIN_R, TOP_R, MARGIN_Z, TOP_Z);
    const { flat } = marginLoop(MARGIN_R, MARGIN_Z, 32);
    const contentHash = 'inner-surface-invalid';
    await buildBvhFor(pool, contentHash, die.positions, die.indices);
    await expect(
      pool.run('innerSurface', { contentHash, ...GAPS, pitchMm: 0, marginLoop: flat.slice(), insertionAxis: AXIS }),
    ).rejects.toMatchObject({ name: 'TypeError' });
    await expect(
      pool.run('innerSurface', { contentHash, ...GAPS, pitchMm: 1e-5, marginLoop: flat.slice(), insertionAxis: AXIS }),
    ).rejects.toMatchObject({ name: 'PitchTooSmallError' });
    await expect(
      pool.run('innerSurface', { contentHash, ...GAPS, blendWidthMm: 0.01, pitchMm: 0.1, marginLoop: flat.slice(), insertionAxis: AXIS }),
    ).rejects.toMatchObject({ name: 'BlendWidthTooNarrowError' });
  });

  it('is cancellable GENUINELY MID-COMPUTATION (abort from onProgress during the field-grid loop)', { timeout: 120_000 }, async () => {
    const pool = createPool({ size: 1 });
    const die = frustumDie(MARGIN_R, TOP_R, MARGIN_Z, TOP_Z);
    const { flat } = marginLoop(MARGIN_R, MARGIN_Z, 180);
    const contentHash = 'inner-surface-mid-cancel';
    await buildBvhFor(pool, contentHash, die.positions, die.indices);

    const controller = new AbortController();
    const progress: number[] = [];
    let abortedMid = false;
    await expect(
      pool.run(
        'innerSurface',
        { contentHash, ...GAPS, pitchMm: 0.04, marginLoop: flat, insertionAxis: AXIS },
        {
          signal: controller.signal,
          onProgress: (f) => {
            progress.push(f);
            if (!abortedMid && f > 0.05 && f < 0.5) { abortedMid = true; controller.abort(); }
          },
        },
      ),
    ).rejects.toThrow(JobCancelledError);
    expect(abortedMid).toBe(true);
    expect(progress).not.toContain(1);
  });
});
