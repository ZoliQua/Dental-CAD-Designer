// cavityInnerSurface job tests (Phase 5 Task 3) — exercised via a real Node
// worker_threads WorkerPool. The full cavity fit-surface algorithm (two-zone
// offset off the cavity surface + draft-close blockout + skirt-to-outline: zone
// accuracy, margin fit, self-consistency, `@errorBound`) is covered at the
// kernel level (packages/kernel/src/cavity/innerSurface.analytic.test.ts, on the
// analytic MOD-cavity fixture); these tests prove the JOB wires @dqcad/kernel's
// `buildCavityInnerSurface` through a real worker correctly: staged progress,
// genuine mid-computation cancellation, typed-error propagation across Comlink,
// byte-identity with a direct kernel call, and the contentHash-keyed cache +
// BVH-mesh-reuse contract.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCavityInnerSurface, orientNormalsConsistently, type IndexedMesh, type Vec3 } from '@dqcad/kernel';
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

const OUTER_H = 1.5, OPEN_H = 1.0, FLOOR_H = 0.8, TOP_Z = 3.0, FLOOR_Z = 2.0, N = 4;

function rectPerimeter(h: number, z: number, n: number): Vec3[] {
  const pts: Vec3[] = [];
  for (let side = 0; side < 4; side++) {
    for (let k = 0; k < n; k++) {
      const t = k / n;
      let x = 0, y = 0;
      if (side === 0) { x = -h + 2 * h * t; y = -h; } else if (side === 1) { x = h; y = -h + 2 * h * t; } else if (side === 2) { x = h - 2 * h * t; y = h; } else { x = -h; y = h - 2 * h * t; }
      pts.push([x, y, z]);
    }
  }
  return pts;
}
function sixSignedVolume(pos: Float64Array, idx: Uint32Array): number {
  let s = 0;
  for (let t = 0; t < idx.length / 3; t++) {
    const a = idx[t * 3]! * 3, b = idx[t * 3 + 1]! * 3, c = idx[t * 3 + 2]! * 3;
    s += pos[a]! * (pos[b + 1]! * pos[c + 2]! - pos[b + 2]! * pos[c + 1]!) - pos[a + 1]! * (pos[b]! * pos[c + 2]! - pos[b + 2]! * pos[c]!) + pos[a + 2]! * (pos[b]! * pos[c + 1]! - pos[b + 1]! * pos[c]!);
  }
  return s;
}
/** Watertight box with a rectangular tapered pocket; opening rim = the outline. */
function pocketBox(): { mesh: IndexedMesh; outlineFlat: Float64Array; outlineVecs: Vec3[] } {
  const positions: number[] = [];
  const pushRim = (pts: Vec3[]): number[] => pts.map((p) => { positions.push(p[0], p[1], p[2]); return positions.length / 3 - 1; });
  const outer = pushRim(rectPerimeter(OUTER_H, TOP_Z, N));
  const open = pushRim(rectPerimeter(OPEN_H, TOP_Z, N));
  const floor = pushRim(rectPerimeter(FLOOR_H, FLOOR_Z, N));
  const base = pushRim(rectPerimeter(OUTER_H, 0, N));
  const M = 4 * N;
  positions.push(0, 0, 0); const baseC = positions.length / 3 - 1;
  positions.push(0, 0, FLOOR_Z); const floorC = positions.length / 3 - 1;
  const tris: number[] = [];
  const quad = (a: number, b: number, c: number, d: number): void => { tris.push(a, b, c, a, c, d); };
  for (let i = 0; i < M; i++) {
    const j = (i + 1) % M;
    quad(open[i]!, outer[i]!, outer[j]!, open[j]!);
    quad(outer[i]!, outer[j]!, base[j]!, base[i]!);
    quad(open[i]!, open[j]!, floor[j]!, floor[i]!);
    tris.push(baseC, base[j]!, base[i]!);
    tris.push(floorC, floor[i]!, floor[j]!);
  }
  let mesh: IndexedMesh = orientNormalsConsistently({ positions: new Float64Array(positions), indices: new Uint32Array(tris) }).mesh;
  if (sixSignedVolume(mesh.positions, mesh.indices) < 0) {
    const f = mesh.indices.slice();
    for (let t = 0; t < f.length / 3; t++) { const tmp = f[t * 3 + 1]!; f[t * 3 + 1] = f[t * 3 + 2]!; f[t * 3 + 2] = tmp; }
    mesh = { positions: mesh.positions, indices: f };
  }
  const outlineVecs: Vec3[] = open.map((v) => [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!]);
  const outlineFlat = new Float64Array(outlineVecs.flat());
  return { mesh, outlineFlat, outlineVecs };
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

const GAPS = { marginalGapMm: 0.02, cementGapMm: 0.05, spacerStartMm: 0.8, blendWidthMm: 0.3 };
const AXIS: Vec3 = [0, 0, 1];

describe('cavityInnerSurface job', () => {
  it('produces a mesh BYTE-IDENTICAL to a direct buildCavityInnerSurface call, with staged progress ending at 1', { timeout: 120_000 }, async () => {
    const pool = createPool({ size: 1 });
    const { mesh, outlineFlat, outlineVecs } = pocketBox();
    const contentHash = 'cavity-inner-byte-identity';
    await buildBvhFor(pool, contentHash, mesh.positions.slice(), mesh.indices.slice());

    const progress: number[] = [];
    const jobResult = await pool.run(
      'cavityInnerSurface',
      { contentHash, ...GAPS, pitchMm: 0.1, cavityOutline: outlineFlat.slice(), insertionAxis: AXIS },
      { onProgress: (f) => progress.push(f) },
    );
    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(1);
    expect(progress.length).toBeGreaterThan(4);
    for (let i = 1; i < progress.length; i++) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
    expect(jobResult.errorBoundMm).toBeGreaterThan(0.1 / 2);
    expect(jobResult.skirtTriangleCount).toBeGreaterThan(0);

    const direct = await buildCavityInnerSurface(mesh, { ...GAPS, pitchMm: 0.1, cavityOutline: outlineVecs, insertionAxis: AXIS });
    expect(hashBuffers(jobResult.positions, jobResult.indices)).toBe(hashBuffers(direct.mesh.positions, direct.mesh.indices));
    expect(jobResult.errorBoundMm).toBe(direct.errorBoundMm);
    expect(jobResult.patchTriangleCount).toBe(direct.patchTriangleCount);
  });

  it('cache hit: an identical second call returns a byte-identical clone without re-running', { timeout: 120_000 }, async () => {
    const pool = createPool({ size: 1 });
    const { mesh, outlineFlat } = pocketBox();
    const contentHash = 'cavity-inner-cache';
    await buildBvhFor(pool, contentHash, mesh.positions, mesh.indices);
    const payload = { contentHash, ...GAPS, pitchMm: 0.12, insertionAxis: AXIS } as const;
    const first = await pool.run('cavityInnerSurface', { ...payload, cavityOutline: outlineFlat.slice() });
    const progress: number[] = [];
    const second = await pool.run('cavityInnerSurface', { ...payload, cavityOutline: outlineFlat.slice() }, { onProgress: (f) => progress.push(f) });
    expect(progress).toEqual([0, 1]);
    expect(second.positions.buffer).not.toBe(first.positions.buffer);
    expect(hashBuffers(second.positions, second.indices)).toBe(hashBuffers(first.positions, first.indices));
  });

  it('rejects a contentHash with no cached BVH on this worker', async () => {
    const pool = createPool({ size: 1 });
    const { outlineFlat } = pocketBox();
    await expect(
      pool.run('cavityInnerSurface', { contentHash: 'never-built', ...GAPS, pitchMm: 0.1, cavityOutline: outlineFlat, insertionAxis: AXIS }),
    ).rejects.toMatchObject({ name: 'BvhNotCachedError' });
  });

  it('rejects invalid pitch / too-narrow blend before any heavy work', async () => {
    const pool = createPool({ size: 1 });
    const { mesh, outlineFlat } = pocketBox();
    const contentHash = 'cavity-inner-invalid';
    await buildBvhFor(pool, contentHash, mesh.positions, mesh.indices);
    await expect(pool.run('cavityInnerSurface', { contentHash, ...GAPS, pitchMm: 0, cavityOutline: outlineFlat.slice(), insertionAxis: AXIS })).rejects.toMatchObject({ name: 'TypeError' });
    await expect(pool.run('cavityInnerSurface', { contentHash, ...GAPS, pitchMm: 1e-5, cavityOutline: outlineFlat.slice(), insertionAxis: AXIS })).rejects.toMatchObject({ name: 'PitchTooSmallError' });
    await expect(pool.run('cavityInnerSurface', { contentHash, ...GAPS, blendWidthMm: 0.01, pitchMm: 0.1, cavityOutline: outlineFlat.slice(), insertionAxis: AXIS })).rejects.toMatchObject({ name: 'BlendWidthTooNarrowError' });
  });

  it('is cancellable GENUINELY MID-COMPUTATION (abort from onProgress during the field-grid loop)', { timeout: 120_000 }, async () => {
    const pool = createPool({ size: 1 });
    const { mesh, outlineFlat } = pocketBox();
    const contentHash = 'cavity-inner-mid-cancel';
    await buildBvhFor(pool, contentHash, mesh.positions, mesh.indices);
    const controller = new AbortController();
    const progress: number[] = [];
    let abortedMid = false;
    await expect(
      pool.run(
        'cavityInnerSurface',
        { contentHash, ...GAPS, pitchMm: 0.05, cavityOutline: outlineFlat, insertionAxis: AXIS },
        {
          signal: controller.signal,
          onProgress: (f) => { progress.push(f); if (!abortedMid && f > 0.05 && f < 0.5) { abortedMid = true; controller.abort(); } },
        },
      ),
    ).rejects.toThrow(JobCancelledError);
    expect(abortedMid).toBe(true);
    expect(progress).not.toContain(1);
  });
});
