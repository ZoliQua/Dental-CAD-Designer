// cavityProximalContact job tests (Phase 5 Task 5) — exercised via a real Node
// worker_threads WorkerPool. The adaptation geometry + genuine measurement +
// clamp falsifiability are covered at the kernel level
// (cavity/proximalContact.test.ts on the analytic MOD fixture); these tests
// prove the JOB wires @dqcad/kernel's `measureSeamDihedral` →
// `adaptProximalContacts` → `measureSeamDihedral` through a real worker
// correctly: coarse progress ending at 1, byte-identity with direct kernel
// calls (mesh + measurements), clamp-warning propagation, typed-error
// propagation, and cancellation. The fixture is the same compact break-through
// trough as cavityOcclusalPatchJob.test.ts (duplicated inline — the
// established kernel-workers test pattern; a cross-package import of another
// package's test fixture is not available here).
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  adaptProximalContacts,
  buildOcclusalPatch,
  measureSeamDihedral,
  orientNormalsConsistently,
  type IndexedMesh,
  type ProximalAdaptationInput,
  type Vec3,
} from '@dqcad/kernel';
import { WorkerPool } from './pool.js';
import { JobCancelledError, type JobContext } from './jobs/context.js';
import { cavityProximalContactJob } from './jobs/cavityProximalContact.js';
import type { CavityProximalContactFacePayload, CavityProximalContactPayload } from './jobs/registry.js';

const NOOP_CTX: JobContext = { progress: () => {}, cancelled: () => false };

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
const L = 4;
function troughFixture(): { mesh: IndexedMesh; outlineVecs: Vec3[] } {
  const W = 3, H = 3, c = 1, F = 1.5, nx = 4;
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
  return { mesh, outlineVecs };
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
function outwardBox(min: Vec3, max: Vec3): IndexedMesh {
  const [x0, y0, z0] = min; const [x1, y1, z1] = max;
  const v = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const idx = [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return { positions: new Float64Array(v), indices: Uint32Array.from(idx) };
}

function hashBuffers(positions: Float64Array, indices: Uint32Array): string {
  const hash = createHash('sha256');
  hash.update(Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength));
  hash.update(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength));
  return hash.digest('hex');
}

const AXIS: Vec3 = [0, 0, 1];
const PEN = 0.02;

function flat(points: readonly Vec3[]): Float64Array {
  return new Float64Array(points.flat());
}

/** Assemble the job payload + the equivalent direct-kernel inputs at gap g. */
function buildScenario(gapMm: number): {
  payload: CavityProximalContactPayload;
  patchMesh: IndexedMesh;
  toothMesh: IndexedMesh;
  adaptations: ProximalAdaptationInput[];
  cavityTriangleIndices: Uint32Array;
  seamEdges: ReturnType<typeof buildOcclusalPatch>['seamEdges'];
} {
  const { mesh, outlineVecs } = troughFixture();
  const patch = buildOcclusalPatch(mesh, outlineVecs, AXIS);
  const faceMinus = patch.proximalFaces.find((f) => f.columnPoints[0]![0] < 0)!;
  const facePlus = patch.proximalFaces.find((f) => f.columnPoints[0]![0] > 0)!;
  const nbMinus = outwardBox([-L - gapMm - 2, -5, -1], [-L - gapMm, 5, 6]);
  const nbPlus = outwardBox([L + gapMm, -5, -1], [L + gapMm + 2, 5, 6]);
  const mkFace = (face: typeof faceMinus, nb: IndexedMesh, label: string): CavityProximalContactFacePayload => ({
    label,
    columnPoints: flat(face.columnPoints),
    freeRunPoints: flat(face.freeRunPoints),
    neighborPositions: nb.positions.slice(),
    neighborIndices: nb.indices.slice(),
    targetPenetrationMm: PEN,
  });
  const adaptations: ProximalAdaptationInput[] = [
    { label: 'mesial', columnPoints: faceMinus.columnPoints, freeRunPoints: faceMinus.freeRunPoints, neighborMesh: nbMinus, targetPenetrationMm: PEN },
    { label: 'distal', columnPoints: facePlus.columnPoints, freeRunPoints: facePlus.freeRunPoints, neighborMesh: nbPlus, targetPenetrationMm: PEN },
  ];
  const payload: CavityProximalContactPayload = {
    patchPositions: patch.mesh.positions.slice(),
    patchIndices: patch.mesh.indices.slice(),
    toothPositions: mesh.positions.slice(),
    toothIndices: mesh.indices.slice(),
    seamEdges: patch.seamEdges.map((e) => ({ a: [...e.a] as Vec3, b: [...e.b] as Vec3, segment: e.segment })),
    cavityTriangleIndices: patch.cavityTriangleIndices.slice(),
    adaptations: [mkFace(faceMinus, nbMinus, 'mesial'), mkFace(facePlus, nbPlus, 'distal')],
  };
  return { payload, patchMesh: patch.mesh, toothMesh: mesh, adaptations, cavityTriangleIndices: patch.cavityTriangleIndices, seamEdges: patch.seamEdges };
}

describe('cavityProximalContact job', () => {
  it('produces a mesh + measurements BYTE-IDENTICAL to direct kernel calls, progress 0..1 monotone', { timeout: 60_000 }, async () => {
    const pool = createPool({ size: 1 });
    const s = buildScenario(0.5);

    const progress: number[] = [];
    const jobResult = await pool.run('cavityProximalContact', s.payload, { onProgress: (f) => progress.push(f) });
    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(1);
    for (let i = 1; i < progress.length; i++) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);

    // direct kernel chain
    const before = measureSeamDihedral(s.patchMesh, s.toothMesh, s.seamEdges, { excludeToothTriangles: new Set(s.cavityTriangleIndices) });
    const direct = adaptProximalContacts(s.patchMesh, s.adaptations);
    const after = measureSeamDihedral(direct.mesh, s.toothMesh, s.seamEdges, { excludeToothTriangles: new Set(s.cavityTriangleIndices) });

    expect(hashBuffers(jobResult.positions, jobResult.indices)).toBe(hashBuffers(direct.mesh.positions, direct.mesh.indices));
    expect(jobResult.seamDihedralMaxBeforeDeg).toBe(before.maxDeg);
    expect(jobResult.seamDihedralMaxAfterDeg).toBe(after.maxDeg);
    expect(jobResult.errorBoundMm).toBe(direct.errorBoundMm);
    expect(jobResult.boxes.map((b) => b.achievedSignedDistanceMm)).toEqual(direct.boxes.map((b) => b.achievedSignedDistanceMm));
    expect(jobResult.boxes.map((b) => b.contactResidualMm)).toEqual(direct.boxes.map((b) => b.contactResidualMm));
    // residuals genuinely at target on this closed-form scenario
    for (const b of jobResult.boxes) {
      expect(Math.abs(b.achievedSignedDistanceMm - -PEN)).toBeLessThan(1e-9);
      expect(b.clampBound).toBe(false);
    }
    expect(jobResult.clampedBoxes).toEqual([]);
    expect(jobResult.seamDihedralMaxAfterDeg).toBeLessThan(5);
  });

  it('propagates the clamp warning (unreachable target) honestly', { timeout: 60_000 }, async () => {
    const pool = createPool({ size: 1 });
    const s = buildScenario(3); // needs travel 3.02 > 1.5 default cap
    const jobResult = await pool.run('cavityProximalContact', s.payload);
    expect(jobResult.clampedBoxes).toEqual(['mesial', 'distal']);
    for (const b of jobResult.boxes) {
      expect(b.clampBound).toBe(true);
      expect(b.contactResidualMm).toBeGreaterThan(1);
    }
    expect(jobResult.errorBoundMm!).toBeGreaterThan(1);
  });

  it('rejects malformed payloads before heavy work and propagates kernel typed errors', { timeout: 60_000 }, async () => {
    const pool = createPool({ size: 1 });
    const s = buildScenario(0.5);
    await expect(pool.run('cavityProximalContact', { ...s.payload, adaptations: [] })).rejects.toMatchObject({ name: 'TypeError' });
    const badFace = { ...s.payload.adaptations[0]!, columnPoints: new Float64Array([99, 99, 99, 98, 98, 98, 97, 97, 97]) };
    await expect(
      pool.run('cavityProximalContact', { ...s.payload, adaptations: [badFace, s.payload.adaptations[1]!] }),
    ).rejects.toMatchObject({ name: 'ProximalColumnNotOnPatchError' });
  });

  it('throws JobCancelledError when cancelled up front', { timeout: 60_000 }, async () => {
    const pool = createPool({ size: 1 });
    const s = buildScenario(0.5);
    const controller = new AbortController();
    controller.abort();
    await expect(pool.run('cavityProximalContact', s.payload, { signal: controller.signal })).rejects.toMatchObject({ name: 'JobCancelledError' });
  });

  // --- direct in-process calls (the sculptJob.test.ts pattern): the job
  // FUNCTION's own progress/cancel/validation behaviour, coverage-visible ----
  it('direct call: coarse progress fractions [0, 0.2, 0.7, 1] and the documented result shape', async () => {
    const s = buildScenario(0.5);
    const fractions: number[] = [];
    const ctx: JobContext = { progress: (f) => fractions.push(f), cancelled: () => false };
    const out = await cavityProximalContactJob(s.payload, ctx);
    expect(fractions).toEqual([0, 0.2, 0.7, 1]);
    const direct = adaptProximalContacts(s.patchMesh, s.adaptations);
    expect(hashBuffers(out.positions, out.indices)).toBe(hashBuffers(direct.mesh.positions, direct.mesh.indices));
    expect(out.maxTravelMm).toBe(direct.maxTravelMm);
    expect(out.seamAnchorBandMm).toBe(direct.seamAnchorBandMm);
  });

  it('direct call: honours the kernel ALGORITHM overrides (maxTravelMm forces the clamp)', async () => {
    const s = buildScenario(0.5);
    const out = await cavityProximalContactJob({ ...s.payload, maxTravelMm: 0.1, seamAnchorBandMm: 0.2 }, NOOP_CTX);
    expect(out.maxTravelMm).toBe(0.1);
    expect(out.seamAnchorBandMm).toBe(0.2);
    expect(out.clampedBoxes).toEqual(['mesial', 'distal']); // 0.52 needed > 0.1 cap
  });

  it('direct call: cancelled up front → JobCancelledError; malformed flat array → TypeError', async () => {
    const s = buildScenario(0.5);
    const cancelledCtx: JobContext = { progress: () => {}, cancelled: () => true };
    await expect(cavityProximalContactJob(s.payload, cancelledCtx)).rejects.toBeInstanceOf(JobCancelledError);
    const badLen = { ...s.payload.adaptations[0]!, columnPoints: new Float64Array([1, 2]) };
    await expect(cavityProximalContactJob({ ...s.payload, adaptations: [badLen] }, NOOP_CTX)).rejects.toThrow(TypeError);
  });
});
