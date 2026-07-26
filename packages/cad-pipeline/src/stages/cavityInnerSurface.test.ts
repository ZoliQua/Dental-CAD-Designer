// packages/cad-pipeline/src/stages/cavityInnerSurface.test.ts
//
// Tests for the CAVITY inner-surface STAGE (cavityInnerSurface.ts) —
// ORCHESTRATION, not re-testing the kernel geometry (that is @dqcad/kernel's
// cavity/innerSurface.analytic.test.ts, on the analytic MOD-cavity fixture).
// Here we prove: the restoration-type guard rails fire (crown context REJECTED,
// inlay/onlay ACCEPTED — the Task 1 scaffold); the profile gaps flow through to
// the kernel; the RestorationStageResult shape (mesh, injected content hash,
// operationName, journal params, inputHashes, errorBoundMm) is right; the stage
// is deterministic (journal-replay = identical hash); and the margin-fit gate
// passes ≤10µm on the produced fit surface.
//
// The target is a small watertight BOX-WITH-A-RECTANGULAR-POCKET built inline
// (a cross-package import of @dqcad/kernel's TEST fixtures would sit outside
// cad-pipeline's tsconfig rootDir — same constraint the crown stage test notes).
// The pocket's opening rim is the cavity outline; the walls taper inward toward
// the floor (removable along +Z). Small + coarse pitch keeps the build ~1-2 s.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import { analyzeMesh, orientNormalsConsistently, type IndexedMesh } from '@dqcad/kernel';
import type { PipelineContext, PipelineMaterialProfile } from '../pipeline/context.ts';
import { RestorationTypeMismatchError } from '../pipeline/context.ts';
import { marginFitGate } from '../gates/index.ts';
import {
  MissingCavityOutlineError,
  MissingClinicalParamError,
  runCavityInnerSurfaceStage,
} from './cavityInnerSurface.ts';

// --- Inline watertight box-with-rectangular-pocket: opening rim = outline ---
const OUTER_H = 1.5; // outer box half-size (x, y)
const OPEN_H = 1.0; // pocket opening half-size (z = TOP_Z)
const FLOOR_H = 0.8; // pocket floor half-size (tapered inward -> removable +Z)
const TOP_Z = 3.0;
const FLOOR_Z = 2.0;
const N = 4; // subdivisions per rim side

function rectPerimeter(h: number, z: number, n: number): Vec3[] {
  const pts: Vec3[] = [];
  for (let side = 0; side < 4; side++) {
    for (let k = 0; k < n; k++) {
      const t = k / n;
      let x = 0, y = 0;
      if (side === 0) { x = -h + 2 * h * t; y = -h; }
      else if (side === 1) { x = h; y = -h + 2 * h * t; }
      else if (side === 2) { x = h - 2 * h * t; y = h; }
      else { x = -h; y = h - 2 * h * t; }
      pts.push([x, y, z]);
    }
  }
  return pts;
}

function sixSignedVolume(pos: Float64Array, idx: Uint32Array): number {
  let s = 0;
  for (let t = 0; t < idx.length / 3; t++) {
    const a = idx[t * 3]! * 3, b = idx[t * 3 + 1]! * 3, c = idx[t * 3 + 2]! * 3;
    s += pos[a]! * (pos[b + 1]! * pos[c + 2]! - pos[b + 2]! * pos[c + 1]!)
      - pos[a + 1]! * (pos[b]! * pos[c + 2]! - pos[b + 2]! * pos[c]!)
      + pos[a + 2]! * (pos[b]! * pos[c + 1]! - pos[b + 1]! * pos[c]!);
  }
  return s;
}

/** A watertight box with a rectangular tapered pocket in its top; returns the
 * mesh + the dense opening-rim outline (every point a mesh vertex). */
function pocketBox(): { mesh: IndexedMesh; outline: Vec3[] } {
  const positions: number[] = [];
  const pushRim = (pts: Vec3[]): number[] => pts.map((p) => { positions.push(p[0], p[1], p[2]); return positions.length / 3 - 1; });
  const outer = pushRim(rectPerimeter(OUTER_H, TOP_Z, N)); // top outer rim
  const open = pushRim(rectPerimeter(OPEN_H, TOP_Z, N)); // pocket opening rim (the OUTLINE)
  const floor = pushRim(rectPerimeter(FLOOR_H, FLOOR_Z, N)); // pocket floor rim
  const base = pushRim(rectPerimeter(OUTER_H, 0, N)); // box base rim
  const M = 4 * N;
  positions.push(0, 0, 0); const baseC = positions.length / 3 - 1;
  positions.push(0, 0, FLOOR_Z); const floorC = positions.length / 3 - 1;

  const tris: number[] = [];
  const quad = (a: number, b: number, c: number, d: number): void => { tris.push(a, b, c, a, c, d); };
  for (let i = 0; i < M; i++) {
    const j = (i + 1) % M;
    quad(open[i]!, outer[i]!, outer[j]!, open[j]!); // top frame (annulus)
    quad(outer[i]!, outer[j]!, base[j]!, base[i]!); // box side
    quad(open[i]!, open[j]!, floor[j]!, floor[i]!); // pocket wall (tapered)
    tris.push(baseC, base[j]!, base[i]!); // base fan
    tris.push(floorC, floor[i]!, floor[j]!); // pocket floor fan
  }
  const flat = new Float64Array(positions);
  const idx = new Uint32Array(tris);
  let mesh: IndexedMesh = orientNormalsConsistently({ positions: flat, indices: idx }).mesh;
  if (sixSignedVolume(mesh.positions, mesh.indices) < 0) {
    const flipped = mesh.indices.slice();
    for (let t = 0; t < flipped.length / 3; t++) { const tmp = flipped[t * 3 + 1]!; flipped[t * 3 + 1] = flipped[t * 3 + 2]!; flipped[t * 3 + 2] = tmp; }
    mesh = { positions: mesh.positions, indices: flipped };
  }
  const outline: Vec3[] = open.map((v) => [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!]);
  return { mesh, outline };
}

const hashMesh = (mesh: IndexedMesh): string => {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
};

const TOOTH: FdiTooth = 36;

function makeProfile(over: Partial<PipelineMaterialProfile['restorationParams']> = {}): PipelineMaterialProfile {
  return {
    id: 'test-emax', version: '1.0.0',
    restorationParams: {
      cementGapMm: 0.05, marginalGapMm: 0.02, spacerStartMm: 0.8,
      minWallThicknessMm: 0.7, proximalContactPenetrationMm: 0.05, occlusalContactMm: 0,
      ...over,
    },
    connectorAreaMm2: { posteriorMm2: 9, anteriorMm2: 7 },
    undercutBlockoutThresholdMm: 0.1, occlusalMinWallThicknessMm: 1.0, maxChordDeviationMm: 0.02,
    inlayMinThicknessMm: 1.0, onlayMinThicknessMm: 1.0, cuspCoverageMinThicknessMm: 1.5, marginExclusionMm: 0.2,
  };
}

function makeContext(restorationType: PipelineContext['restorationType'], mesh: IndexedMesh, outline: Vec3[], profileOver = {}): PipelineContext {
  return {
    restorationId: 'r1', restorationType, materialProfile: makeProfile(profileOver),
    insertionAxis: [0, 0, 1], targetMesh: { contentHash: 'cav-hash', mesh },
    marginLoops: { [TOOTH]: { closed: true, resampledPoints: outline } },
    neighbors: {}, antagonist: null, stages: {},
  };
}

const OPTS = { pitchMm: 0.1, hashMesh };

describe('runCavityInnerSurfaceStage — restoration-type guard rails (Task 1 scaffold)', () => {
  it('REJECTS a crown context (assertCavityContext throws RestorationTypeMismatchError)', async () => {
    const { mesh, outline } = pocketBox();
    const ctx = makeContext('crown', mesh, outline);
    await expect(runCavityInnerSurfaceStage(ctx, TOOTH, OPTS)).rejects.toBeInstanceOf(RestorationTypeMismatchError);
  });

  it.each(['inlay', 'onlay'] as const)('ACCEPTS a %s context (the cavity guard passes)', async (rt) => {
    const { mesh, outline } = pocketBox();
    const ctx = makeContext(rt, mesh, outline);
    const res = await runCavityInnerSurfaceStage(ctx, TOOTH, OPTS);
    expect(res.stage).toBe('innerSurface');
    expect(res.mesh).not.toBeNull();
  }, 60_000);
});

describe('runCavityInnerSurfaceStage — orchestration + result shape', () => {
  it('produces a fit surface; profile gaps journaled; margin fit ≤ 10 µm; deterministic (replay = identical hash)', { timeout: 120_000 }, async () => {
    const { mesh, outline } = pocketBox();
    const ctx = makeContext('inlay', mesh, outline);
    const res = await runCavityInnerSurfaceStage(ctx, TOOTH, OPTS);

    // Result shape + journal fields.
    expect(res.operationName).toBe('cavityInnerSurface.build');
    expect(res.meshContentHash).toBe(hashMesh(res.mesh!));
    expect(res.inputHashes).toEqual(['cav-hash']);
    expect(res.params.restorationType).toBe('inlay');
    expect(res.params.marginalGapMm).toBe(0.02);
    expect(res.params.cementGapMm).toBe(0.05);
    expect(res.params.spacerStartMm).toBe(0.8);
    expect(res.errorBoundMm).toBeGreaterThan(0);

    // Margin fit ≤ 10 µm on the cavity outline (the phase acceptance measurable).
    const gate = marginFitGate({ innerSurfaceMesh: res.mesh!, marginResampledPoints: outline });
    console.log(`[CAVITY-STAGE] margin fit ${((gate.value ?? Infinity) * 1000).toFixed(3)} µm (gate ${(gate.threshold ?? 0) * 1000} µm), passed=${gate.passed}`);
    expect(gate.passed).toBe(true);

    // Determinism / journal replay: a second run with the same context + options
    // reproduces the identical mesh hash (CLAUDE.md invariant 2/3).
    const replay = await runCavityInnerSurfaceStage(ctx, TOOTH, OPTS);
    expect(replay.meshContentHash).toBe(res.meshContentHash);

    // Produced fit surface is a valid open patch (analyzeMesh sanity).
    expect(analyzeMesh(res.mesh!).boundaryEdgeCount).toBeGreaterThan(0);
  });
});

describe('runCavityInnerSurfaceStage — guards', () => {
  it('throws MissingCavityOutlineError when the tooth has no outline', async () => {
    const { mesh } = pocketBox();
    const ctx: PipelineContext = { ...makeContext('inlay', mesh, []), marginLoops: {} };
    await expect(runCavityInnerSurfaceStage(ctx, TOOTH, OPTS)).rejects.toBeInstanceOf(MissingCavityOutlineError);
  });

  it('throws MissingClinicalParamError when a gap param is non-finite', async () => {
    const { mesh, outline } = pocketBox();
    const ctx = makeContext('inlay', mesh, outline, { cementGapMm: NaN });
    await expect(runCavityInnerSurfaceStage(ctx, TOOTH, OPTS)).rejects.toBeInstanceOf(MissingClinicalParamError);
  });
});
