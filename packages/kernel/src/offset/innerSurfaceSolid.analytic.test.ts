// packages/kernel/src/offset/innerSurfaceSolid.analytic.test.ts
//
// ANALYTIC + ACCEPTANCE tests for the full crown inner surface
// (`buildInnerSurface`: two-zone offset + solid undercut blockout +
// skirt-to-margin) on the shoulder-prep die (margin/marginRidge.test-fixtures.ts's
// `shoulderPrepMesh`, analytic margin circle). Acceptance evidence:
//
//   - MARGIN FIT: the finished inner surface's boundary loop == the margin
//     polyline, so the margin-fit max distance is ~0 (<< the 10 µm phase gate).
//     Measured here directly (the same directed-Hausdorff the marginFitGate
//     computes), always-on at a coarse pitch (margin fit is skirt-driven,
//     PITCH-INDEPENDENT), plus a gated clinical-pitch run.
//   - SELF-CONSISTENCY: the blocked patch has ZERO facing/draft undercut along
//     the insertion axis (draft-close is correct by construction). Exercised on
//     a die + a TILT beyond its taper (so the die genuinely has undercut the
//     blockout must fill — a control asserts that).
//   - SKIRT CONTINUITY: exactly one boundary loop, its vertices ARE the margin
//     points (gap -> 0 at the margin).
//   - SEATING: no inner-surface vertex penetrates the die beyond the marginal
//     seal (min signed distance to the die >= ~0).
//   - DETERMINISM: two runs are byte-identical (hash equality).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { buildBvh } from '../bvh/build.ts';
import { buildHalfedge } from '../halfedge/build.ts';
import { findBoundaryLoops, destinationVertex } from '../halfedge/iterate.ts';
import { computePseudonormals } from '../sdf/pseudonormals.ts';
import { signedClosestPoint } from '../sdf/signedDistance.ts';
import { undercutScan } from '../undercut/undercutScan.ts';
import { shoulderPrepMesh } from '../margin/marginRidge.test-fixtures.ts';
import { buildInnerSurface, distanceToClosedPolyline, type InnerSurfaceSolidResult } from './index.ts';

const COMPACT = { gingivalRadiusMm: 1.5, marginRadiusMm: 1.2, topRadiusMm: 0.8, marginHeightMm: 0.5, totalHeightMm: 2.0, segments: 96 };
const GAP = { marginalGapMm: 0.02, cementGapMm: 0.05, spacerStartMm: 0.8, blendWidthMm: 0.3 };

function circle(r: number, z: number, n: number): Vec3[] {
  const l: Vec3[] = [];
  for (let i = 0; i < n; i++) { const t = (2 * Math.PI * i) / n; l.push([r * Math.cos(t), r * Math.sin(t), z]); }
  return l;
}

function hashMesh(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
}

/** Boundary loops of `mesh` as ordered vertex positions. */
function boundaryLoopsPos(mesh: IndexedMesh): Vec3[][] {
  const hm = buildHalfedge(mesh);
  return findBoundaryLoops(hm).map((loop) =>
    loop.map((he) => {
      const v = destinationVertex(hm, he);
      return [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!] as Vec3;
    }),
  );
}

/** Symmetric directed-Hausdorff between the MARGIN boundary loop (the loop
 * closest to the margin polyline) and the margin polyline — the same quantity
 * the marginFitGate measures. */
function marginFit(mesh: IndexedMesh, poly: readonly Vec3[]): { max: number; loopCount: number; boundaryVerts: number } {
  const loops = boundaryLoopsPos(mesh);
  const loopToMargin = loops.map((loop) => loop.reduce((m, p) => Math.max(m, distanceToClosedPolyline(p, poly)), 0));
  let mi = 0;
  for (let i = 1; i < loops.length; i++) if (loopToMargin[i]! < loopToMargin[mi]!) mi = i;
  const marginLoop = loops[mi] ?? [];
  let mToB = 0;
  for (const p of poly) mToB = Math.max(mToB, distanceToClosedPolyline(p, marginLoop));
  return { max: Math.max(loopToMargin[mi] ?? Infinity, mToB), loopCount: loops.length, boundaryVerts: marginLoop.length };
}

/** Facing/draft residual on the blocked PATCH (triangles [0, patchTriangleCount)):
 * count + worst normal.axis among triangles facing away from the axis. */
function facingResidual(res: InnerSurfaceSolidResult, axis: Vec3): { count: number; worst: number } {
  const EPS = 1e-6;
  const pos = res.mesh.positions;
  const idx = res.mesh.indices;
  let count = 0;
  let worst = 0;
  for (let t = 0; t < res.patchTriangleCount; t++) {
    const a = idx[t * 3]! * 3, b = idx[t * 3 + 1]! * 3, c = idx[t * 3 + 2]! * 3;
    const nx = (pos[b + 1]! - pos[a + 1]!) * (pos[c + 2]! - pos[a + 2]!) - (pos[b + 2]! - pos[a + 2]!) * (pos[c + 1]! - pos[a + 1]!);
    const ny = (pos[b + 2]! - pos[a + 2]!) * (pos[c]! - pos[a]!) - (pos[b]! - pos[a]!) * (pos[c + 2]! - pos[a + 2]!);
    const nz = (pos[b]! - pos[a]!) * (pos[c + 1]! - pos[a + 1]!) - (pos[b + 1]! - pos[a + 1]!) * (pos[c]! - pos[a]!);
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0)) continue;
    const d = (nx * axis[0] + ny * axis[1] + nz * axis[2]) / len;
    if (d < -EPS) { count++; worst = Math.min(worst, d); }
  }
  return { count, worst };
}

/** WHOLE-MESH undercut breakdown along `axis` over the ENTIRE finished
 * intaglio (patch + skirt), splitting the undercut triangles into
 * patch-vs-skirt and facing-vs-occlusion — the honest, complete
 * self-consistency measurement (the brief's "re-scan the blocked-out inner
 * SURFACE"). */
function wholeMeshUndercut(res: InnerSurfaceSolidResult, axis: Vec3): {
  total: number;
  triangleCount: number;
  patchFacing: number;
  skirtFacing: number;
  patchOcc: number;
  skirtOcc: number;
} {
  const bvh = buildBvh(res.mesh);
  const scan = undercutScan(res.mesh, bvh, axis);
  const pos = res.mesh.positions;
  const idx = res.mesh.indices;
  const tc = idx.length / 3;
  let patchFacing = 0, skirtFacing = 0, patchOcc = 0, skirtOcc = 0;
  for (let t = 0; t < tc; t++) {
    if (scan.undercut[t] !== 1) continue;
    const a = idx[t * 3]! * 3, b = idx[t * 3 + 1]! * 3, c = idx[t * 3 + 2]! * 3;
    const nx = (pos[b + 1]! - pos[a + 1]!) * (pos[c + 2]! - pos[a + 2]!) - (pos[b + 2]! - pos[a + 2]!) * (pos[c + 1]! - pos[a + 1]!);
    const ny = (pos[b + 2]! - pos[a + 2]!) * (pos[c]! - pos[a]!) - (pos[b]! - pos[a]!) * (pos[c + 2]! - pos[a + 2]!);
    const nz = (pos[b]! - pos[a]!) * (pos[c + 1]! - pos[a + 1]!) - (pos[b + 1]! - pos[a + 1]!) * (pos[c]! - pos[a]!);
    const len = Math.hypot(nx, ny, nz) || 1;
    const facing = (nx * axis[0] + ny * axis[1] + nz * axis[2]) / len < -1e-12;
    const isPatch = t < res.patchTriangleCount;
    if (facing) { if (isPatch) patchFacing++; else skirtFacing++; }
    else { if (isPatch) patchOcc++; else skirtOcc++; }
  }
  return { total: scan.undercutTriangleCount, triangleCount: tc, patchFacing, skirtFacing, patchOcc, skirtOcc };
}

/** Seating pre-check: the deepest an inner-surface vertex reaches INTO the die
 * (negative signed distance = penetration). >= ~0 means the die stays inside
 * the intaglio (no seating collision beyond the marginal seal). */
function seatingMinSignedDistance(mesh: IndexedMesh, die: IndexedMesh): number {
  const bvh = buildBvh(die);
  const pn = computePseudonormals(die);
  let minSd = Infinity;
  const vCount = mesh.positions.length / 3;
  for (let v = 0; v < vCount; v++) {
    const sd = signedClosestPoint(die, bvh, pn, [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!]).signedDistance;
    if (sd < minSd) minSd = sd;
  }
  return minSd;
}

const MARGIN_FIT_GATE_MM = 0.010;

// GOLDEN (committed): the byte-hash of the compact-die +Z build at pitch
// 0.06 mm, margin loop of 240 points. This pins buildInnerSurface's output
// against regression — it may change ONLY with a KERNEL_VERSION bump + a
// docs/CHANGELOG-kernel.md entry (CLAUDE.md golden discipline). Generated
// under KERNEL_VERSION 0.10.0.
const GOLDEN_COMPACT_DIE_HASH = '691d1d6285ec9247cffc15cd35d9c1715fceb09b62da847e1a84a2403bcdbdb6';

describe('buildInnerSurface — ANALYTIC: margin fit + skirt continuity (die, axis +Z, coarse pitch)', () => {
  let res: InnerSurfaceSolidResult;
  const loop = circle(COMPACT.marginRadiusMm, COMPACT.marginHeightMm, 240);
  let elapsedMs = 0;
  it('builds; margin fit << 10 µm; exactly one boundary loop == the margin', { timeout: 120_000 }, async () => {
    const die = shoulderPrepMesh(COMPACT);
    const started = performance.now();
    res = await buildInnerSurface(die.mesh, { ...GAP, pitchMm: 0.06, marginLoop: loop, insertionAxis: [0, 0, 1] });
    elapsedMs = performance.now() - started;
    const fit = marginFit(res.mesh, loop);
    console.log(
      `[INNER-SURFACE-SOLID +Z] ${res.mesh.indices.length / 3} tris (patch ${res.patchTriangleCount} + skirt ${res.skirtTriangleCount}) | ` +
        `${(elapsedMs / 1000).toFixed(2)} s | MARGIN FIT max = ${(fit.max * 1000).toFixed(4)} µm (gate ${MARGIN_FIT_GATE_MM * 1000} µm) | ` +
        `boundary loops = ${fit.loopCount}, boundary verts = ${fit.boundaryVerts}`,
    );
    expect(fit.loopCount).toBe(1);
    expect(fit.max).toBeLessThanOrEqual(MARGIN_FIT_GATE_MM);
    // Construction fidelity: essentially exact (float noise only).
    expect(fit.max).toBeLessThan(1e-6);
    expect(res.marginVertexCount).toBe(loop.length);

    // SKIRT CONTINUITY: the ONLY boundary is the margin loop (no gap/overlap
    // seam elsewhere) — the margin loop is fully manifold-stitched into the
    // patch. Its vertex count equals the margin loop's, and it is the sole
    // boundary (boundaryEdgeCount == margin vertex count for a simple loop).
    expect(res.stats.boundaryEdgeCount).toBe(loop.length);

    // GOLDEN: byte-hash pinned (KERNEL_VERSION-gated regression). If this
    // fails, buildInnerSurface's output changed — investigate; only re-pin
    // together with a KERNEL_VERSION bump + a changelog entry.
    expect(hashMesh(res.mesh)).toBe(GOLDEN_COMPACT_DIE_HASH);
  });

  it('seating: no inner-surface vertex penetrates the die beyond the marginal seal', { timeout: 120_000 }, async () => {
    const die = shoulderPrepMesh(COMPACT);
    const minSd = seatingMinSignedDistance(res.mesh, die.mesh);
    console.log(`[INNER-SURFACE-SOLID +Z] SEATING: min signed-distance to die = ${(minSd * 1000).toFixed(2)} µm (>= 0 => no penetration)`);
    // The intaglio sits OUTSIDE the die by >= the marginal gap, touching (~0)
    // only at the margin. Allow one pitch of MC slack below zero.
    expect(minSd).toBeGreaterThan(-0.06);
  });

  it('is deterministic — a second run is byte-identical (hash equality)', { timeout: 120_000 }, async () => {
    const die = shoulderPrepMesh(COMPACT);
    const run = () => buildInnerSurface(die.mesh, { ...GAP, pitchMm: 0.08, marginLoop: circle(COMPACT.marginRadiusMm, COMPACT.marginHeightMm, 180), insertionAxis: [0, 0, 1] });
    const a = await run();
    const b = await run();
    expect(hashMesh(b.mesh)).toBe(hashMesh(a.mesh));
    expect(b.errorBoundMm).toBe(a.errorBoundMm);
    expect(b.patchTriangleCount).toBe(a.patchTriangleCount);
    expect(b.skirtTriangleCount).toBe(a.skirtTriangleCount);
  });
});

describe('buildInnerSurface — SELF-CONSISTENCY: undercut blockout', () => {
  const loop = circle(COMPACT.marginRadiusMm, COMPACT.marginHeightMm, 240);

  // PRIMARY GUARD (the brief's deliverable 1: re-scan the WHOLE blocked-out
  // inner surface). On a CLINICALLY VALID insertion axis (in-taper, so the
  // margin itself is seatable) the ENTIRE finished intaglio — patch AND skirt
  // AND occlusion — is undercut-free. This guards the shipped property (a
  // folded/torn skirt would surface here); it is NOT a favourable subset.
  it.each([
    { label: '+Z (on-axis)', axis: [0, 0, 1] as Vec3 },
    { label: '~11.5deg in-taper', axis: [Math.sin(0.2), 0, Math.cos(0.2)] as Vec3 },
  ])('WHOLE finished intaglio has ZERO undercut on a valid in-taper axis ($label)', { timeout: 120_000 }, async ({ axis }) => {
    const die = shoulderPrepMesh(COMPACT);
    const res = await buildInnerSurface(die.mesh, { ...GAP, pitchMm: 0.06, marginLoop: loop, insertionAxis: axis });
    const u = wholeMeshUndercut(res, axis);
    const fit = marginFit(res.mesh, loop);
    console.log(
      `[INNER-SURFACE-SOLID VALID ${axis.map((x) => x.toFixed(2)).join(',')}] WHOLE-MESH undercut = ${u.total}/${u.triangleCount} ` +
        `(patchFacing ${u.patchFacing}, skirtFacing ${u.skirtFacing}, patchOcc ${u.patchOcc}, skirtOcc ${u.skirtOcc}) | margin fit ${(fit.max * 1000).toFixed(4)} µm`,
    );
    expect(u.total).toBe(0); // entire finished mesh, patch + skirt + occlusion
    expect(res.stats.manifoldEdges).toBe(true); // no non-manifold edges (continuity)
    expect(fit.max).toBeLessThanOrEqual(MARGIN_FIT_GATE_MM);
  });

  // The >taper case documents WHERE any residual comes from and proves it is
  // NEVER the offset/blockout patch. On an axis EXCEEDING the die taper (~15deg
  // — an UNSEATABLE axis, on which the confirmed margin itself cannot draw) the
  // draft-close still leaves the PATCH fully undercut-free; the only residual is
  // the marginal-seal SKIRT (which wraps under toward the margin). NOT
  // "occlusal-cap self-occlusion" (measured: 0 patch occlusion) — it is the
  // skirt near the margin on an axis that is itself invalid.
  it('the die has real undercut; on a >taper (unseatable) axis, the blocked PATCH is still 0 undercut (any residual is the skirt only)', { timeout: 120_000 }, async () => {
    const die = shoulderPrepMesh(COMPACT);
    const axis: Vec3 = [Math.sin(0.5), 0, Math.cos(0.5)]; // ~28.6deg, beyond the ~15deg taper

    const dieScan = undercutScan(die.mesh, buildBvh(die.mesh), axis);
    expect(dieScan.undercutTriangleCount).toBeGreaterThan(50); // control: real undercut to block

    const res = await buildInnerSurface(die.mesh, { ...GAP, pitchMm: 0.06, marginLoop: loop, insertionAxis: axis });
    const u = wholeMeshUndercut(res, axis);
    const fit = marginFit(res.mesh, loop);
    console.log(
      `[INNER-SURFACE-SOLID >TAPER ${axis.map((x) => x.toFixed(2)).join(',')}] die undercut ${dieScan.undercutTriangleCount} | ` +
        `WHOLE-MESH undercut = ${u.total}/${u.triangleCount} (patchFacing ${u.patchFacing}, skirtFacing ${u.skirtFacing}, patchOcc ${u.patchOcc}, skirtOcc ${u.skirtOcc}) | margin fit ${(fit.max * 1000).toFixed(4)} µm`,
    );
    // The offset/blockout PATCH is undercut-free even here (draft-close is exact).
    expect(u.patchFacing).toBe(0);
    expect(u.patchOcc).toBe(0);
    // Any residual is the marginal-seal skirt only — NOT occlusal-cap self-occlusion.
    expect(u.total).toBe(u.skirtFacing + u.skirtOcc);
    // Margin seal intact under the tilted axis too.
    expect(fit.loopCount).toBe(1);
    expect(fit.max).toBeLessThanOrEqual(MARGIN_FIT_GATE_MM);
  });
});

const RUN_ACCEPTANCE = process.env['RUN_INNER_SURFACE_ACCEPTANCE'] === '1';

describe.skipIf(!RUN_ACCEPTANCE)('buildInnerSurface — ACCEPTANCE: clinical pitch on the default-size die [RUN_INNER_SURFACE_ACCEPTANCE=1]', () => {
  it('margin fit at clinical pitch 0.02 mm; reports perf', { timeout: 900_000 }, async () => {
    const die = shoulderPrepMesh(); // defaults: marginRadius 3.5
    const loop = circle(die.marginRadiusMm, die.marginHeightMm, 720);
    const started = performance.now();
    const res = await buildInnerSurface(die.mesh, { ...GAP, pitchMm: 0.02, marginLoop: loop, insertionAxis: [0, 0, 1] });
    const elapsedMs = performance.now() - started;
    const fit = marginFit(res.mesh, loop);
    const facing = facingResidual(res, [0, 0, 1]);
    console.log(
      `[INNER-SURFACE-SOLID ACCEPTANCE] default die @ pitch 0.02 mm | ${res.mesh.indices.length / 3} tris | ${(elapsedMs / 1000).toFixed(1)} s | ` +
        `MARGIN FIT max = ${(fit.max * 1000).toFixed(4)} µm | facing residual ${facing.count}`,
    );
    expect(fit.max).toBeLessThanOrEqual(MARGIN_FIT_GATE_MM);
    expect(facing.count).toBe(0);
  });
});
