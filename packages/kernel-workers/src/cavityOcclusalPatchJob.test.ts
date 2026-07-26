// cavityOcclusalPatch job tests (Phase 5 Task 4) — exercised via a real Node
// worker_threads WorkerPool. The occlusal-patch geometry + the G1 seam
// measurement are covered at the kernel level (cavity/occlusalPatch.test.ts +
// cavity/seamDihedral.test.ts, on the analytic MOD fixture + closed-form cases);
// these tests prove the JOB wires @dqcad/kernel's `buildOcclusalPatch` +
// `measureSeamDihedral` through a real worker correctly: coarse progress ending
// at 1, byte-identity with a direct kernel call, the contentHash-keyed cache +
// BVH-mesh-reuse contract, typed-error propagation, and cancellation.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildOcclusalPatch, measureSeamDihedral, orientNormalsConsistently, type IndexedMesh, type Vec3 } from '@dqcad/kernel';
import { WorkerPool } from './pool.js';

const pools: WorkerPool[] = [];
function createPool(opts?: ConstructorParameters<typeof WorkerPool>[0]): WorkerPool {
  const pool = new WorkerPool(opts);
  pools.push(pool);
  return pool;
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.destroy()));
});

// --- compact break-through trough (mini-MOD) ---------------------------------
function troughFixture(): { mesh: IndexedMesh; outlineFlat: Float64Array; outlineVecs: Vec3[] } {
  const L = 4, W = 3, H = 3, c = 1, F = 1.5, nx = 4;
  const xs: number[] = [];
  for (let i = 0; i <= nx; i++) xs.push(i === 0 ? -L : i === nx ? L : -L + (2 * L * i) / nx);
  const vIndex = new Map<string, number>();
  const pos: number[] = [];
  const vid = (p: Vec3): number => { const k = `${p[0]}|${p[1]}|${p[2]}`; const e = vIndex.get(k); if (e !== undefined) return e; const i = pos.length / 3; pos.push(p[0], p[1], p[2]); vIndex.set(k, i); return i; };
  const tris: number[] = [];
  const tri = (a: Vec3, b: Vec3, c2: Vec3): void => { const ia = vid(a), ib = vid(b), ic = vid(c2); if (ia === ib || ib === ic || ia === ic) return; tris.push(ia, ib, ic); };
  const quad = (a: Vec3, b: Vec3, c2: Vec3, d: Vec3): void => { tri(a, b, c2); tri(a, c2, d); };
  for (let s = 0; s < xs.length - 1; s++) {
    const x0 = xs[s]!, x1 = xs[s + 1]!;
    quad([x0, -W, 0], [x1, -W, 0], [x1, W, 0], [x0, W, 0]);
    quad([x0, -W, H], [x0, -c, H], [x1, -c, H], [x1, -W, H]);
    quad([x0, c, H], [x0, W, H], [x1, W, H], [x1, c, H]);
    quad([x0, -W, 0], [x0, -W, H], [x1, -W, H], [x1, -W, 0]);
    quad([x0, W, 0], [x1, W, 0], [x1, W, H], [x0, W, H]);
    quad([x0, -c, F], [x0, -c, H], [x1, -c, H], [x1, -c, F]);
    quad([x0, c, F], [x1, c, F], [x1, c, H], [x0, c, H]);
    quad([x0, -c, F], [x1, -c, F], [x1, c, F], [x0, c, F]);
  }
  const buildFrame = (x: number): void => {
    const poly: Vec3[] = [[x, -W, 0], [x, W, 0], [x, W, H], [x, c, H], [x, c, F], [x, -c, F], [x, -c, H], [x, -W, H]];
    const uv = poly.map((p) => [p[1], p[2]] as [number, number]);
    for (const [ia, ib, ic] of earClip(uv)) tri(poly[ia]!, poly[ib]!, poly[ic]!);
  };
  buildFrame(-L);
  buildFrame(L);
  let mesh: IndexedMesh = orientNormalsConsistently({ positions: new Float64Array(pos), indices: new Uint32Array(tris) }).mesh;
  if (sixSignedVolume(mesh.positions, mesh.indices) < 0) {
    const f = mesh.indices.slice();
    for (let t = 0; t < f.length; t += 3) { const b = f[t + 1]!; f[t + 1] = f[t + 2]!; f[t + 2] = b; }
    mesh = { positions: mesh.positions, indices: f };
  }
  const outlineVecs: Vec3[] = [];
  for (const x of xs) outlineVecs.push([x, -c, H]);
  outlineVecs.push([L, -c, F], [L, c, F], [L, c, H]);
  for (let i = xs.length - 2; i >= 0; i--) outlineVecs.push([xs[i]!, c, H]);
  outlineVecs.push([-L, c, F], [-L, -c, F]);
  return { mesh, outlineFlat: new Float64Array(outlineVecs.flat()), outlineVecs };
}
function earClip(poly: readonly (readonly [number, number])[]): [number, number, number][] {
  const n = poly.length; const idx = poly.map((_, i) => i);
  let area2 = 0; for (let i = 0; i < n; i++) area2 += poly[i]![0] * poly[(i + 1) % n]![1] - poly[(i + 1) % n]![0] * poly[i]![1];
  if (area2 < 0) idx.reverse();
  const cr = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const inTri = (px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean => { const d1 = cr(ax, ay, bx, by, px, py), d2 = cr(bx, by, cx, cy, px, py), d3 = cr(cx, cy, ax, ay, px, py); return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)); };
  const out: [number, number, number][] = []; const v = idx.slice(); let guard = 0;
  while (v.length > 3 && guard++ < 1000) {
    let clipped = false;
    for (let i = 0; i < v.length; i++) {
      const a = v[(i + v.length - 1) % v.length]!, b = v[i]!, c = v[(i + 1) % v.length]!;
      const [ax, ay] = poly[a]!, [bx, by] = poly[b]!, [cx, cy] = poly[c]!;
      if (cr(ax, ay, bx, by, cx, cy) <= 0) continue;
      let any = false; for (const p of v) { if (p === a || p === b || p === c) continue; if (inTri(poly[p]![0], poly[p]![1], ax, ay, bx, by, cx, cy)) { any = true; break; } }
      if (any) continue;
      out.push([a, b, c]); v.splice(i, 1); clipped = true; break;
    }
    if (!clipped) break;
  }
  if (v.length === 3) out.push([v[0]!, v[1]!, v[2]!]);
  return out;
}
function sixSignedVolume(pos: Float64Array, idx: Uint32Array): number {
  let s = 0;
  for (let t = 0; t < idx.length / 3; t++) {
    const a = idx[t * 3]! * 3, b = idx[t * 3 + 1]! * 3, c = idx[t * 3 + 2]! * 3;
    s += pos[a]! * (pos[b + 1]! * pos[c + 2]! - pos[b + 2]! * pos[c + 1]!) - pos[a + 1]! * (pos[b]! * pos[c + 2]! - pos[b + 2]! * pos[c]!) + pos[a + 2]! * (pos[b]! * pos[c + 1]! - pos[b + 1]! * pos[c]!);
  }
  return s;
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

const AXIS: Vec3 = [0, 0, 1];

describe('cavityOcclusalPatch job', () => {
  it('produces a mesh BYTE-IDENTICAL to a direct buildOcclusalPatch call, progress 0..1', { timeout: 60_000 }, async () => {
    const pool = createPool({ size: 1 });
    const { mesh, outlineFlat, outlineVecs } = troughFixture();
    const contentHash = 'occlusal-byte-identity';
    await buildBvhFor(pool, contentHash, mesh.positions.slice(), mesh.indices.slice());

    const progress: number[] = [];
    const jobResult = await pool.run(
      'cavityOcclusalPatch',
      { contentHash, cavityOutline: outlineFlat.slice(), insertionAxis: AXIS },
      { onProgress: (f) => progress.push(f) },
    );
    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(1);
    for (let i = 1; i < progress.length; i++) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
    expect(jobResult.seamDihedralMaxDeg).toBeLessThan(5);
    expect(jobResult.seamEdges.length).toBeGreaterThan(0);

    const direct = buildOcclusalPatch(mesh, outlineVecs, AXIS);
    expect(hashBuffers(jobResult.positions, jobResult.indices)).toBe(hashBuffers(direct.mesh.positions, direct.mesh.indices));
    const dm = measureSeamDihedral(direct.mesh, mesh, direct.seamEdges, { excludeToothTriangles: new Set(direct.cavityTriangleIndices) });
    expect(jobResult.seamDihedralMaxDeg).toBe(dm.maxDeg);
    expect(jobResult.patchTriangleCount).toBe(direct.patchTriangleCount);
  });

  it('cache hit: an identical second call returns a byte-identical clone (progress [0,1])', { timeout: 60_000 }, async () => {
    const pool = createPool({ size: 1 });
    const { mesh, outlineFlat } = troughFixture();
    const contentHash = 'occlusal-cache';
    await buildBvhFor(pool, contentHash, mesh.positions, mesh.indices);
    const first = await pool.run('cavityOcclusalPatch', { contentHash, cavityOutline: outlineFlat.slice(), insertionAxis: AXIS });
    const progress: number[] = [];
    const second = await pool.run('cavityOcclusalPatch', { contentHash, cavityOutline: outlineFlat.slice(), insertionAxis: AXIS }, { onProgress: (f) => progress.push(f) });
    expect(progress).toEqual([0, 1]);
    expect(second.positions.buffer).not.toBe(first.positions.buffer);
    expect(hashBuffers(second.positions, second.indices)).toBe(hashBuffers(first.positions, first.indices));
  });

  it('rejects a contentHash with no cached BVH on this worker', async () => {
    const pool = createPool({ size: 1 });
    const { outlineFlat } = troughFixture();
    await expect(
      pool.run('cavityOcclusalPatch', { contentHash: 'never-built', cavityOutline: outlineFlat, insertionAxis: AXIS }),
    ).rejects.toMatchObject({ name: 'BvhNotCachedError' });
  });

  it('rejects an invalid axis / too-short outline before any heavy work', async () => {
    const pool = createPool({ size: 1 });
    const { mesh, outlineFlat } = troughFixture();
    const contentHash = 'occlusal-invalid';
    await buildBvhFor(pool, contentHash, mesh.positions, mesh.indices);
    await expect(pool.run('cavityOcclusalPatch', { contentHash, cavityOutline: outlineFlat.slice(), insertionAxis: [0, 0, 0] })).rejects.toMatchObject({ name: 'TypeError' });
    await expect(pool.run('cavityOcclusalPatch', { contentHash, cavityOutline: new Float64Array([0, 0, 0, 1, 1, 1]), insertionAxis: AXIS })).rejects.toMatchObject({ name: 'TypeError' });
  });
});
