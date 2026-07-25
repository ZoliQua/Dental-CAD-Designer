// packages/cad-pipeline/src/stages/cavityOcclusalPatch.test.ts
//
// Tests for the CAVITY occlusal-patch STAGE (cavityOcclusalPatch.ts) —
// ORCHESTRATION, not re-testing the kernel geometry (that is @dqcad/kernel's
// cavity/occlusalPatch.test.ts + seamDihedral.test.ts, on the analytic MOD
// fixture + closed-form cases). Here we prove: the restoration-type guard rails
// fire (crown REJECTED, inlay/onlay ACCEPTED — the Task 1 scaffold); the
// RestorationStageResult shape + journal fields are right; ONE journaled op;
// determinism (replay = identical hash); and the seam-dihedral gate PASSES on
// the produced patch (< 5°).
//
// The target is a small watertight BREAK-THROUGH TROUGH built inline (a
// cross-package import of @dqcad/kernel's TEST fixtures sits outside
// cad-pipeline's tsconfig rootDir — the same constraint the crown/cavity inner
// stage tests note). It is a box with a top channel open at both ±X ends — the
// minimal MOD analogue: the channel-opening rim carries two OCCLUSAL SEAM runs
// (the flat top beside the channel is the surrounding surface) plus two proximal
// FREE runs (the cut ends at ±X).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import { analyzeMesh, orientNormalsConsistently, type IndexedMesh } from '@dqcad/kernel';
import type { PipelineContext, PipelineMaterialProfile } from '../pipeline/context.ts';
import { RestorationTypeMismatchError } from '../pipeline/context.ts';
import { seamDihedralGate } from '../gates/index.ts';
import { runCavityOcclusalPatchStage, CavityOcclusalPatchMissingCavityOutlineError } from './index.ts';

// --- break-through trough fixture (mini-MOD) ---------------------------------
function troughFixture(): { mesh: IndexedMesh; outline: Vec3[] } {
  const L = 4, W = 3, H = 3, c = 1, F = 1.5; // half-length, half-width, top, channel half-width, floor
  const nx = 4;
  const xs: number[] = [];
  for (let i = 0; i <= nx; i++) xs.push(i === 0 ? -L : i === nx ? L : -L + (2 * L * i) / nx);

  const vIndex = new Map<string, number>();
  const pos: number[] = [];
  const vid = (p: Vec3): number => {
    const k = `${p[0]}|${p[1]}|${p[2]}`;
    const e = vIndex.get(k);
    if (e !== undefined) return e;
    const i = pos.length / 3;
    pos.push(p[0], p[1], p[2]);
    vIndex.set(k, i);
    return i;
  };
  const tris: number[] = [];
  const tri = (a: Vec3, b: Vec3, c2: Vec3): void => {
    const ia = vid(a), ib = vid(b), ic = vid(c2);
    if (ia === ib || ib === ic || ia === ic) return;
    tris.push(ia, ib, ic);
  };
  const quad = (a: Vec3, b: Vec3, c2: Vec3, d: Vec3): void => {
    tri(a, b, c2);
    tri(a, c2, d);
  };

  for (let s = 0; s < xs.length - 1; s++) {
    const x0 = xs[s]!, x1 = xs[s + 1]!;
    // A) bottom z=0
    quad([x0, -W, 0], [x1, -W, 0], [x1, W, 0], [x0, W, 0]);
    // B/C) top strips z=H
    quad([x0, -W, H], [x0, -c, H], [x1, -c, H], [x1, -W, H]);
    quad([x0, c, H], [x0, W, H], [x1, W, H], [x1, c, H]);
    // D/E) outer sides y=±W
    quad([x0, -W, 0], [x0, -W, H], [x1, -W, H], [x1, -W, 0]);
    quad([x0, W, 0], [x1, W, 0], [x1, W, H], [x0, W, H]);
    // F/G) channel walls y=±c, z∈[F,H]
    quad([x0, -c, F], [x0, -c, H], [x1, -c, H], [x1, -c, F]);
    quad([x0, c, F], [x1, c, F], [x1, c, H], [x0, c, H]);
    // H) channel floor z=F, y∈[-c,c]
    quad([x0, -c, F], [x1, -c, F], [x1, c, F], [x0, c, F]);
  }
  // proximal frames at x=±L — the ⊓-with-notch cross-section (project to y,z)
  const framePoly: Vec3[] = [];
  const buildFrame = (x: number): void => {
    const poly: Vec3[] = [
      [x, -W, 0], [x, W, 0], [x, W, H], [x, c, H], [x, c, F], [x, -c, F], [x, -c, H], [x, -W, H],
    ];
    // ear-clip on (y,z)
    const uv = poly.map((p) => [p[1], p[2]] as [number, number]);
    for (const [ia, ib, ic] of earClip(uv)) tri(poly[ia]!, poly[ib]!, poly[ic]!);
  };
  buildFrame(-L);
  buildFrame(L);
  void framePoly;

  let mesh: IndexedMesh = orientNormalsConsistently({ positions: new Float64Array(pos), indices: new Uint32Array(tris) }).mesh;
  if (sixSignedVolume(mesh.positions, mesh.indices) < 0) {
    const flipped = mesh.indices.slice();
    for (let t = 0; t < flipped.length; t += 3) {
      const b = flipped[t + 1]!;
      flipped[t + 1] = flipped[t + 2]!;
      flipped[t + 2] = b;
    }
    mesh = { positions: mesh.positions, indices: flipped };
  }

  // outline (channel-opening rim), same structure as modCavityMesh
  const outline: Vec3[] = [];
  for (const x of xs) outline.push([x, -c, H]); // buccal margin
  outline.push([L, -c, F], [L, c, F], [L, c, H]); // distal U
  for (let i = xs.length - 2; i >= 0; i--) outline.push([xs[i]!, c, H]); // lingual margin
  outline.push([-L, c, F], [-L, -c, F]); // mesial U
  return { mesh, outline };
}

function earClip(poly: readonly (readonly [number, number])[]): [number, number, number][] {
  const n = poly.length;
  const idx = poly.map((_, i) => i);
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    area2 += poly[i]![0] * poly[(i + 1) % n]![1] - poly[(i + 1) % n]![0] * poly[i]![1];
  }
  if (area2 < 0) idx.reverse();
  const cr = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const inTri = (px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean => {
    const d1 = cr(ax, ay, bx, by, px, py), d2 = cr(bx, by, cx, cy, px, py), d3 = cr(cx, cy, ax, ay, px, py);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  const out: [number, number, number][] = [];
  const v = idx.slice();
  let guard = 0;
  while (v.length > 3 && guard++ < 1000) {
    let clipped = false;
    for (let i = 0; i < v.length; i++) {
      const a = v[(i + v.length - 1) % v.length]!, b = v[i]!, c = v[(i + 1) % v.length]!;
      const [ax, ay] = poly[a]!, [bx, by] = poly[b]!, [cx, cy] = poly[c]!;
      if (cr(ax, ay, bx, by, cx, cy) <= 0) continue;
      let any = false;
      for (const p of v) {
        if (p === a || p === b || p === c) continue;
        if (inTri(poly[p]![0], poly[p]![1], ax, ay, bx, by, cx, cy)) { any = true; break; }
      }
      if (any) continue;
      out.push([a, b, c]);
      v.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (v.length === 3) out.push([v[0]!, v[1]!, v[2]!]);
  return out;
}

function sixSignedVolume(positions: Float64Array, indices: Uint32Array): number {
  let vol = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3, b = indices[t + 1]! * 3, c = indices[t + 2]! * 3;
    const ax = positions[a]!, ay = positions[a + 1]!, az = positions[a + 2]!;
    const bx = positions[b]!, by = positions[b + 1]!, bz = positions[b + 2]!;
    const cx = positions[c]!, cy = positions[c + 1]!, cz = positions[c + 2]!;
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return vol;
}

const hashMesh = (mesh: IndexedMesh): string => {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
};

const TOOTH: FdiTooth = 36;

function makeProfile(): PipelineMaterialProfile {
  return {
    id: 'test-emax', version: '1.0.0',
    restorationParams: { cementGapMm: 0.05, marginalGapMm: 0.02, spacerStartMm: 0.8, minWallThicknessMm: 0.7, proximalContactPenetrationMm: 0.05, occlusalContactMm: 0 },
    connectorAreaMm2: { posteriorMm2: 9, anteriorMm2: 7 },
    undercutBlockoutThresholdMm: 0.1, occlusalMinWallThicknessMm: 1.0, maxChordDeviationMm: 0.02,
    inlayMinThicknessMm: 1.0, onlayMinThicknessMm: 1.0, cuspCoverageMinThicknessMm: 1.5, marginExclusionMm: 0.2,
  };
}

function makeContext(restorationType: PipelineContext['restorationType'], mesh: IndexedMesh, outline: Vec3[]): PipelineContext {
  return {
    restorationId: 'r1', restorationType, materialProfile: makeProfile(),
    insertionAxis: [0, 0, 1], targetMesh: { contentHash: 'trough-hash', mesh },
    marginLoops: { [TOOTH]: { closed: true, resampledPoints: outline } },
    neighbors: {}, antagonist: null, stages: {},
  };
}

const OPTS = { hashMesh };

describe('runCavityOcclusalPatchStage', () => {
  it('the trough fixture is watertight + manifold (sanity)', () => {
    const { mesh } = troughFixture();
    const stats = analyzeMesh(mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.manifoldEdges).toBe(true);
  });

  it('REJECTS a crown context (assertCavityContext throws)', () => {
    const { mesh, outline } = troughFixture();
    expect(() => runCavityOcclusalPatchStage(makeContext('crown', mesh, outline), TOOTH, OPTS)).toThrow(RestorationTypeMismatchError);
  });

  it('throws MissingCavityOutlineError when the tooth has no outline in the context', () => {
    const { mesh, outline } = troughFixture();
    const ctx = makeContext('inlay', mesh, outline);
    const noOutline: PipelineContext = { ...ctx, marginLoops: {} };
    expect(() => runCavityOcclusalPatchStage(noOutline, 37 as FdiTooth, OPTS)).toThrow(CavityOcclusalPatchMissingCavityOutlineError);
  });

  it.each(['inlay', 'onlay'] as const)('ACCEPTS a %s context and produces the occlusal patch', (rt) => {
    const { mesh, outline } = troughFixture();
    const res = runCavityOcclusalPatchStage(makeContext(rt, mesh, outline), TOOTH, OPTS);
    expect(res.stage).toBe('anatomyPlacement');
    expect(res.mesh).not.toBeNull();
    expect(res.seamEdges.length).toBeGreaterThan(0);
  });

  it('result shape + ONE journaled op + errorBoundMm=0; seam dihedral gate PASSES (<5°); replay = identical hash', () => {
    const { mesh, outline } = troughFixture();
    const ctx = makeContext('inlay', mesh, outline);
    const res = runCavityOcclusalPatchStage(ctx, TOOTH, OPTS);

    expect(res.operationName).toBe('cavityOcclusalPatch.build');
    expect(res.meshContentHash).toBe(hashMesh(res.mesh!));
    expect(res.inputHashes).toEqual(['trough-hash']);
    expect(res.errorBoundMm).toBe(0);
    expect(res.params.restorationType).toBe('inlay');
    expect(typeof res.params.seamDihedralMaxDeg).toBe('number');
    expect(res.params.seamDihedralMaxDeg as number).toBeLessThan(5);

    // the seam-dihedral gate passes on the produced patch
    const gate = seamDihedralGate({
      patchMesh: res.mesh!,
      toothMesh: mesh,
      seamEdges: res.seamEdges,
      cavityTriangleIndices: res.cavityTriangleIndices,
    });
    expect(gate.passed).toBe(true);
    expect(gate.value).toBeLessThan(5);

    // determinism (replay)
    const res2 = runCavityOcclusalPatchStage(makeContext('inlay', mesh, outline), TOOTH, OPTS);
    expect(res2.meshContentHash).toBe(res.meshContentHash);
  });
});
