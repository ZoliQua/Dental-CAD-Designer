// test/golden/inner-surface-acceptance.test.ts
//
// Phase 4 Task 4 ACCEPTANCE on the REAL fixture: arch-case-01 tooth 11, the
// dentist's hand-traced reference margin (test-fixtures/margins/arch-case-01/
// 11.reference.json) on the prep scan (arch-case-01-upperjaw.stl, the mesh the
// margin was traced ON — coordinates align, no ICP). Measures the MARGIN FIT
// (the ≤10 µm phase acceptance criterion) of the constructed inner surface
// against the confirmed margin's dense `resampledPoints`, plus the blockout's
// facing/draft residual. Env-gated (RUN_INNER_SURFACE_ACCEPTANCE=1) — heavy
// (dense SDF field over the tooth-11 prep ROI on a ~250k-triangle arch) — but
// it MUST run and produce the reported acceptance number.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeMesh,
  buildBvh,
  buildHalfedge,
  buildInnerSurface,
  destinationVertex,
  distanceToClosedPolyline,
  extractMarginRegion,
  findBoundaryLoops,
  intake,
  suggestInsertionAxis,
  AXIS_DEFAULT_ROI_RADIUS_MM,
  type IndexedMesh,
  type Vec3,
} from '@dqcad/kernel';
import { repoRoot } from '../../scripts/kernel-ops-lib.ts';
import { loadUpperjawMesh } from './upperjaw-mesh.ts';

const RUN = process.env['RUN_INNER_SURFACE_ACCEPTANCE'] === '1';

interface Reference {
  anchors: readonly { triangleIndex: number; barycentric: readonly [number, number, number] }[];
  resampledPoints: readonly [number, number, number][];
  closed: boolean;
}

function loadReference(tooth: number): Reference {
  return JSON.parse(readFileSync(join(repoRoot, 'test-fixtures', 'margins', 'arch-case-01', `${tooth}.reference.json`), 'utf8')) as Reference;
}

/** Extracts the tooth-11 prep neighbourhood (triangles with any vertex within
 * `radiusMm` of the margin centroid) from the OPEN arch scan and CAPS its
 * boundary loops into a watertight local prep die (a fan to each loop's
 * centroid). The caps sit at/below the extraction boundary — buildInnerSurface
 * crops the intaglio at the margin plane, so the caps only serve to make
 * `signedDistance` well-defined near the prep (an open intraoral scan has no
 * inside/outside). This is the "extract the tooth-11 prep ROI" the brief calls
 * for; closing the raw scan to a watertight solid is otherwise repair-pipeline
 * work outside Task 4. Returns the intake-cleaned local prep die. */
function extractCappedPrep(mesh: IndexedMesh, centroid: Vec3, radiusMm: number): IndexedMesh {
  const r2 = radiusMm * radiusMm;
  const within = (v: number): boolean => {
    const dx = mesh.positions[v * 3]! - centroid[0];
    const dy = mesh.positions[v * 3 + 1]! - centroid[1];
    const dz = mesh.positions[v * 3 + 2]! - centroid[2];
    return dx * dx + dy * dy + dz * dz <= r2;
  };
  const remap = new Map<number, number>();
  const positions: number[] = [];
  const localOf = (v: number): number => {
    let l = remap.get(v);
    if (l === undefined) {
      l = positions.length / 3;
      positions.push(mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!);
      remap.set(v, l);
    }
    return l;
  };
  const tris: number[] = [];
  const tc = mesh.indices.length / 3;
  for (let t = 0; t < tc; t++) {
    const a = mesh.indices[t * 3]!, b = mesh.indices[t * 3 + 1]!, c = mesh.indices[t * 3 + 2]!;
    if (within(a) || within(b) || within(c)) tris.push(localOf(a), localOf(b), localOf(c));
  }
  let sub: IndexedMesh = { positions: new Float64Array(positions), indices: Uint32Array.from(tris) };
  // Intake first (weld/orient/drop degenerates) so halfedge boundary loops are clean.
  sub = intake({ kind: 'indexed', mesh: sub }).mesh;

  // Cap every boundary loop with a fan to its centroid.
  const hm = buildHalfedge(sub);
  const loops = findBoundaryLoops(hm).map((loop) => loop.map((he) => destinationVertex(hm, he)));
  const capPositions = Array.from(sub.positions);
  const capTris = Array.from(sub.indices);
  for (const loop of loops) {
    let cx = 0, cy = 0, cz = 0;
    for (const v of loop) { cx += sub.positions[v * 3]!; cy += sub.positions[v * 3 + 1]!; cz += sub.positions[v * 3 + 2]!; }
    cx /= loop.length; cy /= loop.length; cz /= loop.length;
    const centerIdx = capPositions.length / 3;
    capPositions.push(cx, cy, cz);
    for (let i = 0; i < loop.length; i++) {
      // Boundary halfedges traverse origin->dest with interior on one side;
      // fan (dest, origin, center) closes it (winding fixed by intake below).
      capTris.push(loop[i]!, loop[(i + 1) % loop.length]!, centerIdx);
    }
  }
  return intake({ kind: 'indexed', mesh: { positions: new Float64Array(capPositions), indices: Uint32Array.from(capTris) } }).mesh;
}

function boundaryLoopsPos(mesh: IndexedMesh): Vec3[][] {
  const hm = buildHalfedge(mesh);
  return findBoundaryLoops(hm).map((loop) =>
    loop.map((he) => {
      const v = destinationVertex(hm, he);
      return [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!] as Vec3;
    }),
  );
}

function marginFit(mesh: IndexedMesh, poly: readonly Vec3[]): { max: number; loopCount: number; otherLoopMm: number } {
  const loops = boundaryLoopsPos(mesh);
  if (loops.length === 0) return { max: Number.POSITIVE_INFINITY, loopCount: 0, otherLoopMm: 0 };
  const loopToMargin = loops.map((loop) => loop.reduce((m, p) => Math.max(m, distanceToClosedPolyline(p, poly)), 0));
  let mi = 0;
  for (let i = 1; i < loops.length; i++) if (loopToMargin[i]! < loopToMargin[mi]!) mi = i;
  const marginLoop = loops[mi]!;
  let mToB = 0;
  for (const p of poly) mToB = Math.max(mToB, distanceToClosedPolyline(p, marginLoop));
  let otherLoopMm = 0;
  for (let i = 0; i < loops.length; i++) if (i !== mi) otherLoopMm = Math.max(otherLoopMm, loopToMargin[i]!);
  return { max: Math.max(loopToMargin[mi]!, mToB), loopCount: loops.length, otherLoopMm };
}

describe.skipIf(!RUN)('buildInnerSurface — ACCEPTANCE: arch-case-01 tooth 11 (real hand-traced margin) [RUN_INNER_SURFACE_ACCEPTANCE=1]', () => {
  it('margin fit <= 10 µm against the confirmed margin resampledPoints; reports numbers', { timeout: 900_000 }, async () => {
    const mesh = loadUpperjawMesh();
    const ref = loadReference(11);
    const marginLoop: Vec3[] = ref.resampledPoints.map((p) => [p[0], p[1], p[2]]);

    // Insertion axis: the kernel's deterministic auto-suggestion over the
    // margin ROI (the same primitive Phase 3's axis tool uses) — margin fit is
    // axis-INDEPENDENT (skirt-driven), but a real axis exercises the blockout.
    const hm = buildHalfedge(mesh);
    const seeds = ref.anchors.map((a) => ({ triangleIndex: a.triangleIndex, barycentric: a.barycentric as Vec3 }));
    const region = extractMarginRegion(mesh, hm, seeds, AXIS_DEFAULT_ROI_RADIUS_MM);
    const bvh = buildBvh(mesh);
    const axis = suggestInsertionAxis(mesh, bvh, region).best.direction;

    // The raw arch scan is OPEN — extract + cap a watertight tooth-11 prep die.
    let cx = 0, cy = 0, cz = 0;
    for (const p of marginLoop) { cx += p[0]; cy += p[1]; cz += p[2]; }
    const marginCentroid: Vec3 = [cx / marginLoop.length, cy / marginLoop.length, cz / marginLoop.length];
    let maxMarginR = 0;
    for (const p of marginLoop) maxMarginR = Math.max(maxMarginR, Math.hypot(p[0] - marginCentroid[0], p[1] - marginCentroid[1], p[2] - marginCentroid[2]));
    const prep = extractCappedPrep(mesh, marginCentroid, maxMarginR + 3.0);
    const prepStats = analyzeMesh(prep);
    console.log(`[INNER-SURFACE-SOLID REAL arch-case-01 #11] capped prep: ${prep.indices.length / 3} tris, watertight=${prepStats.watertight}, boundaryEdges=${prepStats.boundaryEdgeCount}`);
    expect(prepStats.watertight).toBe(true);

    const GAP = { marginalGapMm: 0.02, cementGapMm: 0.05, spacerStartMm: 0.8, blendWidthMm: 0.3 };
    const pitchMm = 0.12; // coarse: margin fit is pitch-independent; keeps the real-arch run tractable
    const started = performance.now();
    const res = await buildInnerSurface(prep, { ...GAP, pitchMm, marginLoop, insertionAxis: axis });
    const elapsedMs = performance.now() - started;

    const fit = marginFit(res.mesh, marginLoop);

    // Facing/draft residual on the blocked patch.
    const pos = res.mesh.positions;
    const idx = res.mesh.indices;
    let facing = 0;
    for (let t = 0; t < res.patchTriangleCount; t++) {
      const a = idx[t * 3]! * 3, b = idx[t * 3 + 1]! * 3, c = idx[t * 3 + 2]! * 3;
      const nx = (pos[b + 1]! - pos[a + 1]!) * (pos[c + 2]! - pos[a + 2]!) - (pos[b + 2]! - pos[a + 2]!) * (pos[c + 1]! - pos[a + 1]!);
      const ny = (pos[b + 2]! - pos[a + 2]!) * (pos[c]! - pos[a]!) - (pos[b]! - pos[a]!) * (pos[c + 2]! - pos[a + 2]!);
      const nz = (pos[b]! - pos[a]!) * (pos[c + 1]! - pos[a + 1]!) - (pos[b + 1]! - pos[a + 1]!) * (pos[c]! - pos[a]!);
      const len = Math.hypot(nx, ny, nz);
      if (len > 0 && (nx * axis[0] + ny * axis[1] + nz * axis[2]) / len < -1e-6) facing++;
    }

    console.log(
      `[INNER-SURFACE-SOLID REAL arch-case-01 #11] axis=[${axis.map((x) => x.toFixed(3)).join(',')}] | pitch ${pitchMm} mm | ` +
        `${res.mesh.indices.length / 3} tris (patch ${res.patchTriangleCount} + skirt ${res.skirtTriangleCount}) | ${(elapsedMs / 1000).toFixed(1)} s`,
    );
    console.log(
      `[INNER-SURFACE-SOLID REAL arch-case-01 #11] MARGIN FIT (margin loop) = ${(fit.max * 1000).toFixed(3)} µm (gate 10 µm) | ` +
        `total boundary loops = ${fit.loopCount} (nearest non-margin opening ${(fit.otherLoopMm * 1000).toFixed(0)} µm away — occlusal/incisal, capped by the shell) | ` +
        `blocked-patch facing residual = ${facing}/${res.patchTriangleCount}`,
    );

    expect(fit.loopCount).toBeGreaterThanOrEqual(1);
    expect(fit.max).toBeLessThanOrEqual(0.010);
  });
});
