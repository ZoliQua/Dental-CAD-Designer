// packages/kernel/src/cavity/seamDihedral.test.ts
//
// Phase 5 Task 4 — CLOSED-FORM VALIDATION OF THE MEASUREMENT, independently of
// any blend (the brief's non-negotiable: the G1 instrument must be proven on
// inputs with a known answer BEFORE it judges a blend, and it must be
// falsifiable). Cases:
//   (a) a flat patch meeting a coplanar plane           → 0° EXACTLY
//   (b) two flat strips at a known wedge angle β         → β EXACTLY
//   (c) a flat disk cap meeting a UV-sphere zone          → the colatitude θ0
//       (closed-form seam angle) within discretization, CONVERGING as the mesh
//       refines (the "spherical cap meeting a sphere → closed-form seam angle")
//   (d) FALSIFIABILITY: a large wedge reads large (a gate would fail); a tiny
//       wedge reads tiny (a gate would pass) — the number tracks the real bend.
import { describe, it, expect } from 'vitest';
import { measureSeamDihedral, SeamEdgeNotOnMeshError, type SeamEdge } from './seamDihedral.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';

function mesh(positions: number[], indices: number[]): IndexedMesh {
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

describe('measureSeamDihedral — closed-form validation (blend-independent)', () => {
  it('(a) flat patch meeting a coplanar plane → 0° exactly', () => {
    // Seam edge = the x-axis segment (0,0,0)->(1,0,0). Patch on +y, tooth on -y,
    // both in the z=0 plane. Both outward normals +Z.
    const patch = mesh(
      [0, 0, 0, 1, 0, 0, 0.5, 1, 0],
      [0, 1, 2], // normal +Z
    );
    const tooth = mesh(
      [0, 0, 0, 1, 0, 0, 0.5, -1, 0],
      [1, 0, 2], // (b,a,q) → +Z
    );
    const seam: SeamEdge[] = [{ a: [0, 0, 0], b: [1, 0, 0], segment: 'flat' }];
    const m = measureSeamDihedral(patch, tooth, seam);
    expect(m.sampleCount).toBe(1);
    expect(m.maxDeg).toBe(0);
    expect(m.meanDeg).toBe(0);
    expect(m.perSegmentMaxDeg.flat).toBe(0);
  });

  it('(b) two flat strips at a known wedge angle β → β exactly', () => {
    for (const betaDeg of [5, 24.775, 30, 60]) {
      const beta = (betaDeg * Math.PI) / 180;
      // Patch (+y, z=0 plane) normal +Z; tooth (-y) tilted so its normal is
      // (0, sinβ, cosβ) → angle β from +Z. Shared seam edge = the x-axis.
      const patch = mesh([0, 0, 0, 1, 0, 0, 0.5, 1, 0], [0, 1, 2]);
      const tooth = mesh(
        [0, 0, 0, 1, 0, 0, 0.5, -Math.cos(beta), Math.sin(beta)],
        [1, 0, 2],
      );
      const seam: SeamEdge[] = [{ a: [0, 0, 0], b: [1, 0, 0], segment: 'wedge' }];
      const m = measureSeamDihedral(patch, tooth, seam);
      expect(m.maxDeg).toBeCloseTo(betaDeg, 9);
      expect(m.meanDeg).toBeCloseTo(betaDeg, 9);
    }
  });

  // --- UV-sphere zone + flat disk cap: measured seam dihedral = colatitude θ0
  function sphereCapCase(theta0: number, nPhi: number, nBands: number, dTheta: number) {
    const R = 10;
    const capZ = R * Math.cos(theta0);
    const seamRing: Vec3[] = [];
    for (let j = 0; j < nPhi; j++) {
      const phi = (2 * Math.PI * j) / nPhi;
      seamRing.push([R * Math.sin(theta0) * Math.cos(phi), R * Math.sin(theta0) * Math.sin(phi), R * Math.cos(theta0)]);
    }
    // Patch: flat disk fan at z=capZ, outward normal +Z.
    const pPos: number[] = [0, 0, capZ]; // center = vertex 0
    for (const p of seamRing) pPos.push(p[0], p[1], p[2]);
    const pIdx: number[] = [];
    for (let j = 0; j < nPhi; j++) {
      const a = 1 + j;
      const b = 1 + ((j + 1) % nPhi);
      pIdx.push(0, a, b); // CCW from top → +Z
    }
    const patch = mesh(pPos, pIdx);

    // Tooth: sphere zone below θ0 (rings θ0, θ0+dθ, ...). Outward = radial.
    const rings: Vec3[][] = [];
    for (let k = 0; k <= nBands; k++) {
      const th = theta0 + k * dTheta;
      const ring: Vec3[] = [];
      for (let j = 0; j < nPhi; j++) {
        const phi = (2 * Math.PI * j) / nPhi;
        ring.push([R * Math.sin(th) * Math.cos(phi), R * Math.sin(th) * Math.sin(phi), R * Math.cos(th)]);
      }
      rings.push(ring);
    }
    // ring 0 shares seamRing coordinates bit-exactly (same formula) — the patch
    // uses seamRing directly, so patch and tooth share the seam vertices.
    const tPos: number[] = [];
    const tVid = new Map<string, number>();
    const tvid = (p: Vec3): number => {
      const key = `${p[0]}|${p[1]}|${p[2]}`;
      const e = tVid.get(key);
      if (e !== undefined) return e;
      const i = tPos.length / 3;
      tPos.push(p[0], p[1], p[2]);
      tVid.set(key, i);
      return i;
    };
    const tIdx: number[] = [];
    const pushOutward = (a: Vec3, b: Vec3, c: Vec3): void => {
      const ia = tvid(a), ib = tvid(b), ic = tvid(c);
      // outward = normal points away from origin (same side as centroid)
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3, cz = (a[2] + b[2] + c[2]) / 3;
      if (nx * cx + ny * cy + nz * cz >= 0) tIdx.push(ia, ib, ic);
      else tIdx.push(ia, ic, ib);
    };
    for (let k = 0; k < nBands; k++) {
      const A = rings[k]!;
      const B = rings[k + 1]!;
      for (let j = 0; j < nPhi; j++) {
        const j1 = (j + 1) % nPhi;
        pushOutward(A[j]!, A[j1]!, B[j]!);
        pushOutward(A[j1]!, B[j1]!, B[j]!);
      }
    }
    const tooth = mesh(tPos, tIdx);

    const seam: SeamEdge[] = [];
    for (let j = 0; j < nPhi; j++) {
      seam.push({ a: seamRing[j]!, b: seamRing[(j + 1) % nPhi]!, segment: 'sphere' });
    }
    return measureSeamDihedral(patch, tooth, seam);
  }

  it('(c) flat disk cap meeting a UV-sphere zone → colatitude θ0, converging as it refines', () => {
    const theta0 = (35 * Math.PI) / 180; // 35° colatitude
    const theta0Deg = 35;
    // coarse
    const coarse = sphereCapCase(theta0, 24, 3, (5 * Math.PI) / 180);
    // fine (more φ, smaller dθ band)
    const fine = sphereCapCase(theta0, 96, 3, (1 * Math.PI) / 180);
    // Both track the colatitude; refining moves closer to θ0.
    expect(coarse.meanDeg).toBeGreaterThan(theta0Deg - 4);
    expect(coarse.meanDeg).toBeLessThan(theta0Deg + 4);
    expect(Math.abs(fine.meanDeg - theta0Deg)).toBeLessThan(Math.abs(coarse.meanDeg - theta0Deg));
    expect(Math.abs(fine.meanDeg - theta0Deg)).toBeLessThan(0.7);
    expect(fine.sampleCount).toBe(96);
  });

  it('(d) falsifiability: the number tracks the real bend (large fails, tiny passes)', () => {
    const big = measureSeamDihedral(
      mesh([0, 0, 0, 1, 0, 0, 0.5, 1, 0], [0, 1, 2]),
      mesh([0, 0, 0, 1, 0, 0, 0.5, -Math.cos(0.4), Math.sin(0.4)], [1, 0, 2]),
      [{ a: [0, 0, 0], b: [1, 0, 0], segment: 'w' }],
    );
    expect(big.maxDeg).toBeGreaterThan(5); // ~22.9° → a 5° gate FAILS
    const tiny = measureSeamDihedral(
      mesh([0, 0, 0, 1, 0, 0, 0.5, 1, 0], [0, 1, 2]),
      mesh([0, 0, 0, 1, 0, 0, 0.5, -Math.cos(0.03), Math.sin(0.03)], [1, 0, 2]),
      [{ a: [0, 0, 0], b: [1, 0, 0], segment: 'w' }],
    );
    expect(tiny.maxDeg).toBeLessThan(5); // ~1.7° → a 5° gate PASSES
  });

  it('throws SeamEdgeNotOnMeshError when a seam edge is not a shared bit-exact edge', () => {
    const patch = mesh([0, 0, 0, 1, 0, 0, 0.5, 1, 0], [0, 1, 2]);
    const tooth = mesh([0, 0, 0, 1, 0, 0, 0.5, -1, 0], [1, 0, 2]);
    // an edge nobody has
    expect(() =>
      measureSeamDihedral(patch, tooth, [{ a: [9, 9, 9], b: [8, 8, 8], segment: 'x' }]),
    ).toThrow(SeamEdgeNotOnMeshError);
  });

  it('excludeToothTriangles disambiguates the surrounding triangle on a closed (2-adjacent) seam edge', () => {
    // Seam edge (0,0,0)-(1,0,0) with TWO tooth triangles adjacent: one "cavity"
    // (below, -Z) and one "surrounding" (the coplanar +Z one). Excluding the
    // cavity one must leave the surrounding one → 0° against a +Z patch.
    const patch = mesh([0, 0, 0, 1, 0, 0, 0.5, 1, 0], [0, 1, 2]);
    const tooth = mesh(
      [0, 0, 0, 1, 0, 0, 0.5, -1, 0, 0.5, -1, -1],
      [
        1, 0, 2, // surrounding (+Z), triangle 0
        0, 1, 3, // cavity wall (drops to -Z), triangle 1
      ],
    );
    const seam: SeamEdge[] = [{ a: [0, 0, 0], b: [1, 0, 0], segment: 's' }];
    // Without exclusion → ambiguous (2 adjacent) → throws.
    expect(() => measureSeamDihedral(patch, tooth, seam)).toThrow(SeamEdgeNotOnMeshError);
    // Excluding triangle 1 (the cavity wall) → surrounding triangle 0, dihedral 0.
    const m = measureSeamDihedral(patch, tooth, seam, { excludeToothTriangles: new Set([1]) });
    expect(m.maxDeg).toBe(0);
  });
});
