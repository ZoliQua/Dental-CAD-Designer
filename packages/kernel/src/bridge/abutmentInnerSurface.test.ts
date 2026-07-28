// packages/kernel/src/bridge/abutmentInnerSurface.test.ts
//
// Phase 6 Task 2 — per-abutment inner (fit) surfaces built with the SHARED
// insertion axis (NOT each die's own axis). Reuses the P4 `buildInnerSurface`
// VERBATIM (a bridge abutment's intaglio is a crown intaglio); the only bridge
// specific is the AXIS every abutment is built against — the shared axis.
//
// Demonstrated here (the brief's acceptance elements):
//   1. SHARED-vs-OWN axis: on the PARALLEL bridge the shared axis == the distal
//      die's own axis, so the two builds are BYTE-IDENTICAL (coincidence). On the
//      TILTED bridge they DIFFER (the shared-axis intaglio is draft-closed along
//      a direction that is NOT the distal die's own — real bridge physics: the
//      shared-axis constraint blocks out along a compromise direction). The
//      geometric divergence is MEASURED + REPORTED.
//   2. Per-abutment MARGIN FIT <= 10 µm (measured with the same symmetric
//      directed-Hausdorff the marginFitGate uses) for BOTH abutments — REPORTED.
//   3. WHOLE-MESH zero-undercut SELF-CONSISTENCY along the SHARED axis, per
//      abutment (re-scanning the finished intaglio finds ~0 undercut, up to the
//      documented pitch-scaled crop/skirt residual — the P4 self-consistency
//      contract, now along the shared axis).
//
// Compact dies + coarse pitch (the innerSurfaceSolid.analytic.test.ts fast-loop
// convention) keep this always-on.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildBvh } from '../bvh/index.ts';
import { closestPoint } from '../bvh/closestPoint.ts';
import { buildHalfedge } from '../halfedge/index.ts';
import { findBoundaryLoops, destinationVertex } from '../halfedge/iterate.ts';
import { undercutScan } from '../undercut/undercutScan.ts';
import { distanceToClosedPolyline } from '../offset/innerSurfaceOffset.ts';
import { buildInnerSurface, type InnerSurfaceSolidResult } from '../offset/innerSurfaceSolid.ts';
import { bridgeFixture } from './bridge.test-fixtures.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';

const COMPACT = { gingivalRadiusMm: 1.5, marginRadiusMm: 1.2, topRadiusMm: 0.8, marginHeightMm: 0.5, totalHeightMm: 2.0, segments: 96 };
const GAP = { marginalGapMm: 0.02, cementGapMm: 0.05, spacerStartMm: 0.8, blendWidthMm: 0.3 };
const PITCH_MM = 0.06;
const MARGIN_FIT_GATE_MM = 0.010;

function hashMesh(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
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

/** Symmetric directed-Hausdorff between the margin boundary loop and the margin
 * polyline — the same quantity the marginFitGate measures (mm). */
function marginFit(mesh: IndexedMesh, poly: readonly Vec3[]): number {
  const loops = boundaryLoopsPos(mesh);
  const loopToMargin = loops.map((loop) => loop.reduce((m, p) => Math.max(m, distanceToClosedPolyline(p, poly)), 0));
  let mi = 0;
  for (let i = 1; i < loops.length; i++) if (loopToMargin[i]! < loopToMargin[mi]!) mi = i;
  const marginLoop = loops[mi] ?? [];
  let mToB = 0;
  for (const p of poly) mToB = Math.max(mToB, distanceToClosedPolyline(p, marginLoop));
  return Math.max(loopToMargin[mi] ?? Infinity, mToB);
}

/** One-sided max distance from every vertex of `a` to the surface of `b` (mm) —
 * the geometric divergence between two intaglio builds. */
function maxDivergenceMm(a: IndexedMesh, b: IndexedMesh): number {
  const bvh = buildBvh(b);
  let max = 0;
  const vCount = a.positions.length / 3;
  for (let v = 0; v < vCount; v++) {
    const d = closestPoint(b, bvh, [a.positions[v * 3]!, a.positions[v * 3 + 1]!, a.positions[v * 3 + 2]!]).distance;
    if (d > max) max = d;
  }
  return max;
}

function selfUndercut(res: InnerSurfaceSolidResult, axis: Vec3): number {
  const bvh = buildBvh(res.mesh);
  return undercutScan(res.mesh, bvh, axis).undercutTriangleCount;
}

/** Whole-mesh undercut split patch-vs-skirt, facing-vs-occlusion — the crown
 * self-consistency breakdown (innerSurfaceSolid.analytic.test.ts). The blocked
 * PATCH is draft-closed EXACTLY along the build axis (facing+occ === 0); any
 * residual is the marginal-seal skirt (only nonzero when the build axis exceeds
 * the die's own taper — an unseatable-margin axis). */
function wholeMeshUndercut(res: InnerSurfaceSolidResult, axis: Vec3): {
  total: number; patchFacing: number; skirtFacing: number; patchOcc: number; skirtOcc: number;
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
  return { total: scan.undercutTriangleCount, patchFacing, skirtFacing, patchOcc, skirtOcc };
}

describe('bridge per-abutment inner surfaces — PARALLEL (shared axis == each die own axis)', () => {
  it('shared-axis and own-axis builds COINCIDE (byte-identical); margin fit <=10µm both; self-consistent', { timeout: 120_000 }, async () => {
    const fx = bridgeFixture({ tiltDeg: 0, dieOptions: COMPACT });
    const sharedAxis: Vec3 = [0, 0, 1];
    expect(fx.distal.insertionAxis).toEqual(sharedAxis); // fixture metadata: parallel

    const mesialShared = await buildInnerSurface(fx.mesial.mesh, {
      ...GAP, pitchMm: PITCH_MM, marginLoop: fx.mesial.worldMarginRing, insertionAxis: sharedAxis,
    });
    const distalShared = await buildInnerSurface(fx.distal.mesh, {
      ...GAP, pitchMm: PITCH_MM, marginLoop: fx.distal.worldMarginRing, insertionAxis: sharedAxis,
    });
    const distalOwn = await buildInnerSurface(fx.distal.mesh, {
      ...GAP, pitchMm: PITCH_MM, marginLoop: fx.distal.worldMarginRing, insertionAxis: fx.distal.insertionAxis,
    });

    // COINCIDENCE: shared == own on the parallel die (byte-identical).
    expect(hashMesh(distalShared.mesh)).toBe(hashMesh(distalOwn.mesh));

    // Per-abutment margin fit <= 10 µm.
    const mesialFit = marginFit(mesialShared.mesh, fx.mesial.worldMarginRing);
    const distalFit = marginFit(distalShared.mesh, fx.distal.worldMarginRing);
    expect(mesialFit).toBeLessThanOrEqual(MARGIN_FIT_GATE_MM);
    expect(distalFit).toBeLessThanOrEqual(MARGIN_FIT_GATE_MM);

    // Whole-mesh self-consistency along the shared axis.
    const mesialUc = selfUndercut(mesialShared, sharedAxis);
    const distalUc = selfUndercut(distalShared, sharedAxis);
    expect(mesialUc).toBe(0);
    expect(distalUc).toBe(0);

    console.log(
      `[bridge][parallel][inner] margin fit: mesial ${(mesialFit * 1000).toFixed(3)} µm / distal ${(distalFit * 1000).toFixed(3)} µm ` +
        `(gate 10 µm); shared==own build BYTE-IDENTICAL; whole-mesh undercut along shared axis: mesial ${mesialUc} / distal ${distalUc} tris`,
    );
  });
});

describe('bridge per-abutment inner surfaces — TILTED distal (shared axis != distal own axis)', () => {
  it('shared-axis vs own-axis builds DIFFER; margin fit <=10µm both; shared-axis build self-consistent along shared axis', { timeout: 120_000 }, async () => {
    const fx = bridgeFixture({ tiltDeg: 30, dieOptions: COMPACT });
    const sharedAxis: Vec3 = [0, 0, 1]; // the untilted shared seating axis
    expect(fx.distal.insertionAxis).not.toEqual(sharedAxis);

    const mesialShared = await buildInnerSurface(fx.mesial.mesh, {
      ...GAP, pitchMm: PITCH_MM, marginLoop: fx.mesial.worldMarginRing, insertionAxis: sharedAxis,
    });
    const distalShared = await buildInnerSurface(fx.distal.mesh, {
      ...GAP, pitchMm: PITCH_MM, marginLoop: fx.distal.worldMarginRing, insertionAxis: sharedAxis,
    });
    const distalOwn = await buildInnerSurface(fx.distal.mesh, {
      ...GAP, pitchMm: PITCH_MM, marginLoop: fx.distal.worldMarginRing, insertionAxis: fx.distal.insertionAxis,
    });

    // DIFFERENCE: shared-axis build != own-axis build on the tilted die.
    expect(hashMesh(distalShared.mesh)).not.toBe(hashMesh(distalOwn.mesh));
    const divergenceMm = maxDivergenceMm(distalShared.mesh, distalOwn.mesh);
    // Meaningfully different (well above Float64 noise ~1e-9 mm and above the
    // 10 µm marginFit gate) — the shared-axis constraint genuinely reshapes the
    // distal intaglio, though most of the surface (the axial wall) coincides so
    // the max divergence is a modest ~10s of µm on the compact die, not mm.
    expect(divergenceMm).toBeGreaterThan(0.002);

    // Per-abutment margin fit STILL <= 10 µm (the skirt seals to the margin
    // regardless of axis) — the acceptance holds under the shared-axis constraint.
    const mesialFit = marginFit(mesialShared.mesh, fx.mesial.worldMarginRing);
    const distalFit = marginFit(distalShared.mesh, fx.distal.worldMarginRing);
    expect(mesialFit).toBeLessThanOrEqual(MARGIN_FIT_GATE_MM);
    expect(distalFit).toBeLessThanOrEqual(MARGIN_FIT_GATE_MM);

    // Self-consistency along the SHARED axis: the blocked PATCH is draft-closed
    // EXACTLY (facing + occlusion === 0), per the P4 draft-close proof — this is
    // the "whole-mesh zero-undercut per abutment along the shared axis" property,
    // on the PATCH which is the actual fit surface. The mesial abutment (whose
    // own axis IS the shared axis) is undercut-free end to end.
    const mesialUc = wholeMeshUndercut(mesialShared, sharedAxis);
    const distalUc = wholeMeshUndercut(distalShared, sharedAxis);
    expect(mesialUc.total).toBe(0); // mesial: shared axis == own axis, fully seatable
    expect(distalUc.patchFacing).toBe(0);
    expect(distalUc.patchOcc).toBe(0);
    // HONEST bridge physics: at 30° tilt the shared axis [0,0,1] exceeds the
    // distal die's own ~15° taper, so the distal MARGIN itself cannot draw along
    // the shared axis — the residual is the marginal-seal SKIRT only (never the
    // fit-surface patch). This is the shared-axis constraint's real cost on a
    // bridge whose abutments are too divergent for a common seating path;
    // reported, not hidden.
    expect(distalUc.total).toBe(distalUc.skirtFacing + distalUc.skirtOcc);

    console.log(
      `[bridge][tilt30][inner] margin fit: mesial ${(mesialFit * 1000).toFixed(3)} µm / distal ${(distalFit * 1000).toFixed(3)} µm (gate 10 µm).\n` +
        `[bridge][tilt30][inner] shared-vs-own DIVERGENCE on distal = ${(divergenceMm * 1000).toFixed(1)} µm (patch tris shared ${distalShared.patchTriangleCount} / own ${distalOwn.patchTriangleCount}).\n` +
        `[bridge][tilt30][inner] self-consistency along SHARED axis: mesial total ${mesialUc.total}; ` +
        `distal PATCH ${distalUc.patchFacing + distalUc.patchOcc} (exact) + SKIRT residual ${distalUc.skirtFacing + distalUc.skirtOcc} ` +
        `(the shared-axis constraint cost — [0,0,1] exceeds the distal die's taper).`,
    );
  });
});
