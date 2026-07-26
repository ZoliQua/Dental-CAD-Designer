// packages/kernel/src/cavity/occlusalPatch.test.ts
//
// Phase 5 Task 4 — the occlusal patch + G1 seam blend on the MOD fixture:
//   - the seam/free partition matches the fixture's CLOSED-FORM segment labels
//     (buccal/lingual occlusal margins = SEAM; proximal U's = FREE);
//   - the blended patch's boundary loop == the cavity outline EXACTLY (bit-exact);
//   - the MEASURED seam dihedral (occlusal seam ONLY) < 5° — REPORTED;
//   - FALSIFIABILITY: a deliberately-UNBLENDED flat lid → the gate FAILS with a
//     large dihedral (proves the gate can fail on the same fixture);
//   - determinism (byte-identical double run, committed sha256 pin).
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { modCavityMesh } from './cavity.test-fixtures.ts';
import {
  buildOcclusalPatch,
  SEAM_SURROUNDING_MAX_ANGLE_DEG,
  OcclusalSeamPartitionError,
} from './occlusalPatch.ts';
import { measureSeamDihedral, type SeamEdge } from './seamDihedral.ts';
import { buildHalfedge, findBoundaryLoops, destinationVertex } from '../halfedge/index.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';

const AXIS: Vec3 = [0, 0, 1];

function sha256(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(new Float64Array(mesh.positions).buffer));
  h.update(Buffer.from(new Uint32Array(mesh.indices).buffer));
  return h.digest('hex');
}

function boundaryLoopPositions(mesh: IndexedMesh): Vec3[][] {
  const hm = buildHalfedge(mesh);
  return findBoundaryLoops(hm).map((loop) =>
    loop.map((he) => {
      const v = destinationVertex(hm, he);
      return [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!] as Vec3;
    }),
  );
}

function coordSet(pts: Vec3[]): Set<string> {
  return new Set(pts.map((p) => `${p[0]}|${p[1]}|${p[2]}`));
}

describe('buildOcclusalPatch — MOD fixture G1 seam blend', () => {
  const fx = modCavityMesh();
  const res = buildOcclusalPatch(fx.mesh, fx.cavityOutline, AXIS);

  it('partitions the outline into 2 occlusal SEAM runs + 2 proximal FREE runs matching the closed-form labels', () => {
    // Closed-form: SEAM edges have BOTH endpoints on the occlusal table
    // (z === tableZ, |y| === isthmusHalfWidthMm); FREE edges touch the proximal
    // U (a point off the table).
    const onTable = (p: Vec3): boolean => p[2] === fx.tableZ && Math.abs(p[1]) === fx.isthmusHalfWidthMm;
    for (const e of res.seamEdges) {
      expect(onTable(e.a) && onTable(e.b)).toBe(true);
    }
    // every free edge has at least one endpoint OFF the occlusal table
    for (const e of res.freeEdges) {
      expect(onTable(e.a) && onTable(e.b)).toBe(false);
    }
    // buccal seam at y = -iHW, lingual at y = +iHW
    const buccal = res.seamEdges.filter((e) => e.segment === 'buccal');
    const lingual = res.seamEdges.filter((e) => e.segment === 'lingual');
    expect(buccal.length).toBeGreaterThan(0);
    expect(lingual.length).toBeGreaterThan(0);
    expect(buccal.length + lingual.length).toBe(res.seamEdges.length);
    // sign of y is uniform within each occlusal margin run
    const ySign = (edges: SeamEdge[]): Set<number> => new Set(edges.flatMap((e) => [Math.sign(e.a[1]), Math.sign(e.b[1])]));
    expect(ySign(buccal).size).toBe(1);
    expect(ySign(lingual).size).toBe(1);
    expect([...ySign(buccal)][0]).toBe(-[...ySign(lingual)][0]!);
  });

  it('patch boundary loop == the cavity outline EXACTLY (bit-exact, single loop)', () => {
    const loops = boundaryLoopPositions(res.mesh);
    expect(loops.length).toBe(1);
    const boundary = coordSet(loops[0]!);
    // every dedup-outline point is a boundary vertex, and vice-versa
    const outlineSet = coordSet(fx.cavityOutline as Vec3[]);
    // The dedup outline (what the patch shares) equals the fixture outline set
    // (the fixture outline has no dupes), so the sets must be equal.
    expect(boundary.size).toBe(outlineSet.size);
    for (const k of outlineSet) expect(boundary.has(k)).toBe(true);
  });

  it('MEASURED seam dihedral (occlusal seam only) < 5° — REPORTED', () => {
    const m = measureSeamDihedral(res.mesh, fx.mesh, res.seamEdges, {
      excludeToothTriangles: new Set(res.cavityTriangleIndices),
    });
    console.log(
      `[OCCLUSAL PATCH] seam dihedral max=${m.maxDeg.toFixed(4)}° mean=${m.meanDeg.toFixed(4)}° ` +
        `perSegment buccal=${(m.perSegmentMaxDeg.buccal ?? 0).toFixed(4)}° lingual=${(m.perSegmentMaxDeg.lingual ?? 0).toFixed(4)}° ` +
        `(n=${m.sampleCount}); a-priori bound=${res.seamDihedralBoundDeg.toFixed(4)}°`,
    );
    expect(m.sampleCount).toBe(res.seamEdges.length);
    expect(m.maxDeg).toBeLessThan(5);
    // the a-priori construction bound is a genuine upper bound on the residual
    expect(m.maxDeg).toBeLessThanOrEqual(res.seamDihedralBoundDeg + 1e-9);
  });

  it('FALSIFIABILITY: an unblended FLAT LID over the same opening → seam dihedral >> 5° (gate FAILS)', () => {
    // A flat lid at z = tableZ spanning the occlusal opening — the naive
    // no-blend restoration. Build it as two triangles per buccal/lingual seam
    // edge, capped flat; measure against the SAME tooth + seam edges.
    // Simplest flat lid whose boundary carries the seam edges: for each buccal
    // seam edge (b0,b1) and paired lingual edge, make a flat quad at tableZ.
    // Here we just need the seam boundary triangles to be FLAT (+Z), so build a
    // fan lid over the opening rectangle at z = tableZ.
    const lidTris: number[] = [];
    const pos: number[] = [];
    const vidMap = new Map<string, number>();
    const lv = (p: Vec3): number => {
      const k = `${p[0]}|${p[1]}|${p[2]}`;
      const e = vidMap.get(k);
      if (e !== undefined) return e;
      const i = pos.length / 3;
      pos.push(p[0], p[1], p[2]);
      vidMap.set(k, i);
      return i;
    };
    // buccal & lingual seam vertices, paired by mesiodistal index, flat strip
    const buccal = res.seamEdges.filter((e) => e.segment === 'buccal');
    for (const e of buccal) {
      // flat quad: (e.a, e.b) on buccal at tableZ, and the two lingual points at
      // the same x, tableZ — approximate the lid as a flat strip at z=tableZ.
      const a: Vec3 = e.a;
      const b: Vec3 = e.b;
      const aL: Vec3 = [a[0], -a[1], a[2]]; // mirror to lingual (fixture is y-symmetric)
      const bL: Vec3 = [b[0], -b[1], b[2]];
      // triangle carrying the buccal seam edge, flat (+Z): (a, b, aL)
      lidTris.push(lv(a), lv(b), lv(aL));
      lidTris.push(lv(b), lv(bL), lv(aL));
    }
    const lid: IndexedMesh = { positions: new Float64Array(pos), indices: new Uint32Array(lidTris) };
    // measure ONLY the buccal seam edges (present on the lid boundary)
    const m = measureSeamDihedral(lid, fx.mesh, buccal, {
      excludeToothTriangles: new Set(res.cavityTriangleIndices),
    });
    console.log(`[FLAT LID falsify] seam dihedral max=${m.maxDeg.toFixed(3)}° (must be >> 5°)`);
    expect(m.maxDeg).toBeGreaterThan(20); // the cusp-incline angle ~24.8° — gate FAILS
  });

  it('determinism: byte-identical double run + committed sha256 pin', () => {
    const a = buildOcclusalPatch(fx.mesh, fx.cavityOutline, AXIS);
    const b = buildOcclusalPatch(fx.mesh, fx.cavityOutline, AXIS);
    const ha = sha256(a.mesh);
    const hb = sha256(b.mesh);
    expect(ha).toBe(hb);
    console.log(`[OCCLUSAL PATCH GOLDEN] sha256 = ${ha}`);
    expect(ha).toBe('33b0f565b104599879d3092f7de416f0d991375d9d74d318a6f60efaf9f3bd52');
  });

  it('onlay reduced-cusp variant: patch builds, seam dihedral still < 5° (per-station tooth slope adapts)', () => {
    const on = modCavityMesh({ reducedCusp: true });
    const r = buildOcclusalPatch(on.mesh, on.cavityOutline, AXIS);
    const m = measureSeamDihedral(r.mesh, on.mesh, r.seamEdges, {
      excludeToothTriangles: new Set(r.cavityTriangleIndices),
    });
    console.log(`[ONLAY reduced-cusp] seam dihedral max=${m.maxDeg.toFixed(4)}° (buccal cusp lowered)`);
    expect(m.maxDeg).toBeLessThan(5);
  });

  it('exposes the documented algorithm parameters (journaling echo)', () => {
    expect(res.seamSurroundingMaxAngleDeg).toBe(SEAM_SURROUNDING_MAX_ANGLE_DEG);
    expect(res.crossSegments).toBe(48);
    expect(res.patchTriangleCount).toBeGreaterThan(0);
  });

  it('throws on a zero-length axis, a too-short outline, and an invalid crossSegments', () => {
    expect(() => buildOcclusalPatch(fx.mesh, fx.cavityOutline, [0, 0, 0])).toThrow(TypeError);
    expect(() => buildOcclusalPatch(fx.mesh, [[0, 0, 0]] as Vec3[], AXIS)).toThrow(TypeError);
    expect(() => buildOcclusalPatch(fx.mesh, fx.cavityOutline, AXIS, { crossSegments: 1 })).toThrow(TypeError);
  });

  it('throws OcclusalSeamPartitionError when the seam/free partition is degenerate (both ways)', () => {
    // Tiny seam-surrounding angle → NOTHING qualifies as an occlusal seam → 0
    // seam runs (all free).
    expect(() => buildOcclusalPatch(fx.mesh, fx.cavityOutline, AXIS, { seamSurroundingMaxAngleDeg: 0.5 })).toThrow(OcclusalSeamPartitionError);
    // A near-180° angle → EVERYTHING qualifies as seam → 1 wrapping seam run / 0
    // free runs.
    expect(() => buildOcclusalPatch(fx.mesh, fx.cavityOutline, AXIS, { seamSurroundingMaxAngleDeg: 179 })).toThrow(OcclusalSeamPartitionError);
  });
});
