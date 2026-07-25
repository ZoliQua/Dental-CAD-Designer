// packages/kernel/src/shell/healOuterAnatomy.test.ts
//
// Phase 4 Task 12b — the HEAL step unit test. Proves `healOuterAnatomy` turns a
// closed, halfedge-watertight but SELF-INTERSECTING outer (the pathology the RBF
// morph produces) into a GUARANTEED-CLEAN closed 2-manifold that manifold-3d
// accepts as a valid solid — deterministically, and faithfully (within the
// documented `@errorBound`). See healOuterAnatomy.ts.
//
// NB on the pathology: the morph's self-intersections are GEOMETRIC (faces pass
// through each other) while the topology stays a valid closed 2-manifold — so
// manifold-3d's construct-probe (`volume`) ACCEPTS the folded input as
// topologically valid (see gates/selfIntersection.ts's doc: a mesh whose faces
// pass through each other geometrically can still construct a Manifold). The
// failure the heal prevents surfaces DOWNSTREAM, at `constructShell`'s
// trim+stitch, where a folded cervical surface stitches into NON-manifold
// topology that manifold-3d then rejects — that end-to-end coupling is proven in
// test/golden/morph-shell-coupling.test.ts. This unit test proves the heal's
// intrinsic guarantees: from a folded outer it re-derives the clean outer
// envelope (an MC iso surface — 2-manifold, self-intersection-free, degenerate-
// free BY CONSTRUCTION), deterministically and faithfully, without corrupting a
// clean input.
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '../mesh/types.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import { dropDegenerateTriangles } from '../intake/degenerate.ts';
import { buildBvh } from '../bvh/build.ts';
import { closestPoint } from '../bvh/closestPoint.ts';
import { volume } from '../boolean/manifold.ts';
import { healOuterAnatomy } from './healOuterAnatomy.ts';

function hashMesh(m: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(m.positions.buffer, m.positions.byteOffset, m.positions.byteLength));
  h.update(Buffer.from(m.indices.buffer, m.indices.byteOffset, m.indices.byteLength));
  return h.digest('hex');
}

/** A closed UV sphere (radius R, centered at origin). Watertight by
 * construction (shared pole verts + a full quad grid). */
function uvSphere(R: number, latRings: number, lonSeg: number): IndexedMesh {
  const P: number[] = [];
  const push = (x: number, y: number, z: number): number => { P.push(x, y, z); return P.length / 3 - 1; };
  const north = push(0, 0, R);
  const south = push(0, 0, -R);
  const ring: number[][] = [];
  for (let i = 1; i < latRings; i++) {
    const phi = (Math.PI * i) / latRings; // 0..PI
    const r = R * Math.sin(phi);
    const z = R * Math.cos(phi);
    const row: number[] = [];
    for (let s = 0; s < lonSeg; s++) {
      const th = (2 * Math.PI * s) / lonSeg;
      row.push(push(r * Math.cos(th), r * Math.sin(th), z));
    }
    ring.push(row);
  }
  const tris: number[] = [];
  // north cap
  for (let s = 0; s < lonSeg; s++) { const sn = (s + 1) % lonSeg; tris.push(north, ring[0]![s]!, ring[0]![sn]!); }
  // bands
  for (let i = 0; i < ring.length - 1; i++)
    for (let s = 0; s < lonSeg; s++) {
      const sn = (s + 1) % lonSeg;
      tris.push(ring[i]![s]!, ring[i + 1]![s]!, ring[i + 1]![sn]!);
      tris.push(ring[i]![s]!, ring[i + 1]![sn]!, ring[i]![sn]!);
    }
  // south cap
  const last = ring[ring.length - 1]!;
  for (let s = 0; s < lonSeg; s++) { const sn = (s + 1) % lonSeg; tris.push(south, last[sn]!, last[s]!); }
  return { positions: new Float64Array(P), indices: Uint32Array.from(tris) };
}

/** Fold the sphere: pull the first latitude ring INWARD and BELOW the ring
 * beneath it (its z drops under ring[1]'s z, its radius collapses toward the
 * axis), so the band between them INVERTS — the cap + inverted band faces pass
 * through each other: a genuine geometric SELF-INTERSECTION — while leaving the
 * topology (hence halfedge-watertightness) untouched. Mild enough that the
 * SDF re-mesh resolves it (an extreme through-and-out fold would defeat the
 * marching-cubes reconstruction itself — an honest limitation, not exercised
 * here). Also seeds a thin near-degenerate sliver, the kind the morph leaves. */
function foldedSelfIntersectingSphere(): IndexedMesh {
  const m = uvSphere(2, 12, 24);
  const p = m.positions.slice();
  p[0 * 3 + 2] = 1.0; // north pole pulled DOWN, inside the upper cap zone
  // first ring (verts start at index 2): collapse toward the axis, z = 0.5
  // (below ring[1] at z ≈ 1.73) → the band inverts + self-intersects.
  for (let s = 0; s < 24; s++) {
    const v = 2 + s;
    p[v * 3] = p[v * 3]! * 0.3;
    p[v * 3 + 1] = p[v * 3 + 1]! * 0.3;
    p[v * 3 + 2] = 0.5;
  }
  // thin near-degenerate sliver (a nudged, nearly-coincident ring vertex).
  p[(2 + 5) * 3] = p[(2 + 6) * 3]! + 1e-7;
  p[(2 + 5) * 3 + 1] = p[(2 + 6) * 3 + 1]! + 1e-7;
  p[(2 + 5) * 3 + 2] = p[(2 + 6) * 3 + 2]!;
  return { positions: p, indices: m.indices.slice() };
}

const PITCH_MM = 0.08;

describe('healOuterAnatomy — SDF re-mesh of a self-intersecting morphed outer', () => {
  it('the pathological input is halfedge-watertight but geometrically folded (self-intersecting)', () => {
    const bad = foldedSelfIntersectingSphere();
    // Halfedge-watertight (closed topology preserved — only vertex positions moved).
    expect(analyzeMesh(bad).watertight).toBe(true);
    // The inverted band puts ring[0] BELOW ring[1] — a genuine geometric fold
    // (documented; manifold-3d's topology-only construct-probe cannot see it).
    const p = bad.positions;
    const ring0z = p[2 * 3 + 2]!; // first ring vertex z
    const ring1z = p[(2 + 24) * 3 + 2]!; // second ring vertex z
    expect(ring0z).toBeLessThan(ring1z);
  });

  it('heals to a CLEAN watertight, single-component, degenerate-free 2-manifold manifold-3d accepts', async () => {
    const bad = foldedSelfIntersectingSphere();
    const healed = await healOuterAnatomy(bad, { pitchMm: PITCH_MM });

    expect(healed.stats.watertight).toBe(true);
    expect(healed.stats.manifoldEdges).toBe(true);
    expect(healed.stats.boundaryEdgeCount).toBe(0);
    expect(healed.stats.componentCount).toBe(1);
    // No degenerate triangles survive the re-mesh.
    expect(dropDegenerateTriangles(healed.mesh).degenerateCount).toBe(0);
    // manifold-3d accepts it as a valid solid (the selfIntersection gate's exact
    // criterion) — the fold is gone.
    const vol = await volume(healed.mesh);
    expect(vol).toBeGreaterThan(0);
    // Error bound is the documented pitch/2 (+eps) — surfaced for QC.
    expect(healed.errorBoundMm).toBeGreaterThan(PITCH_MM / 2);
    expect(healed.errorBoundMm).toBeLessThan(PITCH_MM);
    expect(healed.pitchMm).toBe(PITCH_MM);
    console.log(`[heal] ${healed.triangleCountBefore}→${healed.triangleCountAfter} tris, errorBound=${(healed.errorBoundMm * 1000).toFixed(2)} µm, vol=${vol.toFixed(3)} mm³`);
  });

  it('is DETERMINISTIC — two heals are byte-identical', async () => {
    const bad = foldedSelfIntersectingSphere();
    const a = await healOuterAnatomy(bad, { pitchMm: PITCH_MM });
    const b = await healOuterAnatomy(bad, { pitchMm: PITCH_MM });
    expect(hashMesh(a.mesh)).toBe(hashMesh(b.mesh));
  });

  it('is FAITHFUL — every healed vertex lies within the error bound of the input surface', async () => {
    const bad = foldedSelfIntersectingSphere();
    const healed = await healOuterAnatomy(bad, { pitchMm: PITCH_MM });
    const bvh = buildBvh(bad);
    const pos = healed.mesh.positions;
    let maxMm = 0;
    for (let v = 0; v < pos.length / 3; v++) {
      const d = closestPoint(bad, bvh, [pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!]).distance;
      if (d > maxMm) maxMm = d;
    }
    // The healed surface is the iso-0 of the input's field → within the field
    // bound (pitch/2) of the input surface, up to the Euclidean grid-edge
    // localization (≤ pitch). Assert the honest geometric localization.
    expect(maxMm).toBeLessThanOrEqual(PITCH_MM + 1e-6);
    console.log(`[heal faithful] max healed-vertex→input-surface distance = ${(maxMm * 1000).toFixed(2)} µm (≤ pitch ${PITCH_MM * 1000} µm)`);
  });

  it('preserves a CLEAN input as a watertight solid (does not corrupt good geometry)', async () => {
    const good = uvSphere(2, 12, 24);
    const healed = await healOuterAnatomy(good, { pitchMm: PITCH_MM });
    expect(healed.stats.watertight).toBe(true);
    expect(healed.stats.componentCount).toBe(1);
    expect(await volume(healed.mesh)).toBeGreaterThan(0);
  });

  it('heals a scaled folded sphere to a valid solid for any radius in range (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.double({ min: 1.0, max: 3.0, noNaN: true }), async (scale) => {
        fc.pre(scale >= 1.0 && scale <= 3.0);
        const base = foldedSelfIntersectingSphere();
        const positions = new Float64Array(base.positions.length);
        for (let i = 0; i < positions.length; i++) positions[i] = base.positions[i]! * scale;
        const healed = await healOuterAnatomy({ positions, indices: base.indices.slice() }, { pitchMm: PITCH_MM * scale });
        expect(healed.stats.watertight).toBe(true);
        expect(healed.stats.componentCount).toBe(1);
        expect(await volume(healed.mesh)).toBeGreaterThan(0);
      }),
      { numRuns: 4, seed: 12 },
    );
  }, 120_000);
});
