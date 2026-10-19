// packages/kernel/src/neighbour/extractNeighbourRegion.test.ts
//
// Phase 9 Task 3 — neighbour capture from an arch scan, tests first on a
// closed-form "arch" of boxes (neighbour.test-fixtures.ts): restoration R,
// neighbour N one millimetre away, and a second tooth D hidden behind N.
// Every expected answer is exact: which faces are captured, the contact
// distance, the window-border band.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildBvh } from '../bvh/build.ts';
import { closestPoint } from '../bvh/closestPoint.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import { findSelfIntersections } from '../intersect/selfIntersect.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { computePseudonormals } from '../sdf/pseudonormals.ts';
import { signedClosestPoint } from '../sdf/signedDistance.ts';
import { icosphereMesh } from '../halfedge/halfedge.test-fixtures.ts';
import { boxArch, concatMeshes, gridBox, rectangleLoop } from './neighbour.test-fixtures.ts';
import {
  extractNeighbourRegion,
  NeighbourRegionEmptyError,
  NeighbourSeedTooCloseError,
} from './extractNeighbourRegion.ts';

const AXIS: Vec3 = [0, 0, 1];
const SEED: Vec3 = [7, 0, 4]; // the top centre of N

function capturedVertices(mesh: IndexedMesh, triangleCount: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < triangleCount * 3; i++) {
    const v = mesh.indices[i]!;
    out.push([mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!]);
  }
  return out;
}

function translate(mesh: IndexedMesh, t: Vec3): IndexedMesh {
  const positions = new Float64Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i++) positions[i] = mesh.positions[i]! + t[i % 3]!;
  return { positions, indices: mesh.indices };
}

describe('extractNeighbourRegion — analytic box arch', () => {
  const arch = boxArch();
  const bvh = buildBvh(arch.mesh);
  const result = extractNeighbourRegion(arch.mesh, bvh, SEED, arch.marginLoop, AXIS);

  it('captures exactly the face of N that looks at the restoration, verbatim', () => {
    // N's x = 5 face is a 16 × 16 grid: 512 triangles.
    expect(result.capturedTriangleCount).toBe(512);
    for (const p of capturedVertices(result.mesh, result.capturedTriangleCount)) {
      expect(p[0]).toBe(5); // bit-exact: copied, never interpolated
      expect(Math.abs(p[1])).toBeLessThanOrEqual(2);
      expect(p[2]).toBeGreaterThanOrEqual(0);
      expect(p[2]).toBeLessThanOrEqual(4);
    }
    // The captured triangles are the source triangles, in source order.
    const nStart = arch.restoration.indices.length / 3;
    for (let i = 0; i < result.sourceTriangleIndices.length; i++) {
      const t = result.sourceTriangleIndices[i]!;
      expect(t).toBeGreaterThanOrEqual(nStart);
      if (i > 0) expect(t).toBeGreaterThan(result.sourceTriangleIndices[i - 1]!);
      for (let k = 0; k < 3; k++) {
        const src = arch.mesh.indices[t * 3 + k]!;
        const dst = result.mesh.indices[i * 3 + k]!;
        for (let c = 0; c < 3; c++)
          expect(result.mesh.positions[dst * 3 + c]).toBe(arch.mesh.positions[src * 3 + c]);
      }
    }
  });

  it('never captures the restoration tooth or the occluded tooth behind N', () => {
    for (const p of capturedVertices(result.mesh, result.capturedTriangleCount)) {
      expect(p[0]).toBeGreaterThan(4);
      expect(p[0]).toBeLessThan(10);
    }
  });

  it('closes the window into a valid solid wholly on the neighbour side of the separating plane', () => {
    const stats = analyzeMesh(result.mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.signedVolumeMm3!).toBeGreaterThan(0);
    expect(findSelfIntersections(result.mesh).intersectingPairCount).toBe(0);
    expect(result.approachDirection).toEqual([1, 0, 0]);
    expect(result.separatingPlane.normal).toEqual([1, 0, 0]);
    // Plane at the restoration's margin reach (4 mm) — the midpoint to the
    // seed (3.5 mm) would cut into the restoration's footprint.
    expect(result.separatingPlane.point[0]).toBeCloseTo(4, 12);
    for (let i = 0; i < result.mesh.positions.length; i += 3) {
      expect(result.mesh.positions[i]!).toBeGreaterThan(4);
    }
  });

  it('measures the closed-form contact: 1 mm gap, and a 20 µm penetration with the inside sign', () => {
    const regionBvh = buildBvh(result.mesh);
    const pseudo = computePseudonormals(result.mesh);
    expect(closestPoint(result.mesh, regionBvh, [4, 0.3, 2.1]).distance).toBeCloseTo(1, 12);
    const inside = signedClosestPoint(result.mesh, regionBvh, pseudo, [5.02, -0.4, 1.7]);
    expect(inside.signedDistance).toBeCloseTo(-0.02, 12);
    // Identical to the full neighbour solid for a query at the contact.
    const nBvh = buildBvh(arch.neighbour);
    const q: Vec3 = [4.5, 1.1, 3.3];
    expect(closestPoint(result.mesh, regionBvh, q).distance).toBe(
      closestPoint(arch.neighbour, nBvh, q).distance,
    );
  });

  it('reports the window-border band: the longest edge of a source triangle dropped at the border', () => {
    // N's side faces have 0.25 mm × 0.25 mm cells → diagonal 0.25·√2.
    expect(result.windowBoundaryBandMm).toBeCloseTo(Math.hypot(0.25, 0.25), 12);
    expect(result.capturedAreaMm2).toBeCloseTo(16, 9);
    expect(result.foldTrianglesDropped).toBe(0); // a clean height field
  });

  it('is deterministic (byte-identical across runs)', () => {
    const again = extractNeighbourRegion(arch.mesh, bvh, SEED, arch.marginLoop, AXIS);
    expect(
      Buffer.from(again.mesh.positions.buffer).equals(Buffer.from(result.mesh.positions.buffer)),
    ).toBe(true);
    expect(Array.from(again.mesh.indices)).toEqual(Array.from(result.mesh.indices));
  });
});

describe('extractNeighbourRegion — analytic sphere pair', () => {
  it('a sphere neighbour 1 mm away: the window contact equals the full-sphere contact, within the chord sagitta of 1 mm', () => {
    // Restoration sphere radius 4 at the origin, neighbour radius 4 at x = 9:
    // closed-form gap 1 mm along x. The margin loop is the restoration's
    // equator-ish footprint (reach 4 mm along x).
    const restoration = icosphereMesh(4, 4);
    const neighbour = translate(icosphereMesh(4, 4), [9, 0, 0]);
    const mesh = concatMeshes(restoration, neighbour);
    const loop = rectangleLoop(-4, 4, -4, 4, -1);
    const r = extractNeighbourRegion(mesh, buildBvh(mesh), [9, 0, 4], loop, AXIS);
    expect(analyzeMesh(r.mesh).watertight).toBe(true);
    const q: Vec3 = [4, 0, 0];
    const windowed = closestPoint(r.mesh, buildBvh(r.mesh), q).distance;
    expect(windowed).toBe(closestPoint(neighbour, buildBvh(neighbour), q).distance);
    // Inscribed tessellation: never closer than the analytic 1 mm, and no
    // further than the chord sagitta (edge ≈ 0.25 mm at radius 4 → < 10 µm).
    expect(windowed).toBeGreaterThanOrEqual(1);
    expect(windowed).toBeLessThan(1.01);
  });
});

describe('extractNeighbourRegion — occlusal approach (antagonist)', () => {
  it('captures the antagonist face looking down at the restoration: the closed-form 1 mm occlusal gap', () => {
    const restoration = gridBox([-4, -2, 0], [4, 2, 4], 16);
    const antagonist = gridBox([-4, -2, 5], [4, 2, 9], 16);
    const mesh = concatMeshes(restoration, antagonist);
    const loop = rectangleLoop(-4, 4, -2, 2, 0);
    const r = extractNeighbourRegion(mesh, buildBvh(mesh), [0, 0, 9], loop, AXIS, {
      approach: 'occlusal',
    });
    expect(r.approachDirection).toEqual([0, 0, 1]);
    expect(r.capturedTriangleCount).toBe(16 * 16 * 2);
    for (const p of capturedVertices(r.mesh, r.capturedTriangleCount)) expect(p[2]).toBe(5);
    expect(analyzeMesh(r.mesh).watertight).toBe(true);
    expect(closestPoint(r.mesh, buildBvh(r.mesh), [1, 0.5, 4]).distance).toBeCloseTo(1, 12);
  });

  it('follows the pick when the insertion axis points away from the antagonist', () => {
    const restoration = gridBox([-4, -2, 0], [4, 2, 4], 16);
    const antagonist = gridBox([-4, -2, -9], [4, 2, -5], 16);
    const mesh = concatMeshes(restoration, antagonist);
    const loop = rectangleLoop(-4, 4, -2, 2, 4);
    const r = extractNeighbourRegion(mesh, buildBvh(mesh), [0, 0, -9], loop, AXIS, {
      approach: 'occlusal',
    });
    expect(r.approachDirection.map((x) => x + 0)).toEqual([0, 0, -1]); // normalize -0
    for (const p of capturedVertices(r.mesh, r.capturedTriangleCount)) expect(p[2]).toBe(-5);
  });
});

describe('extractNeighbourRegion — window rules', () => {
  it('keeps only the largest component (a smaller facing fragment off to the side is dropped)', () => {
    const arch = boxArch();
    // A thin box floating beside N, its x = 6 face also looking at R, not
    // occluded by N (y ∈ [2.5, 3]) and inside the default 6 mm ball.
    const fragment = gridBox([6, 2.5, 2], [6.5, 3, 2.5], 2);
    const mesh = concatMeshes(arch.mesh, fragment);
    const r = extractNeighbourRegion(mesh, buildBvh(mesh), SEED, arch.marginLoop, AXIS);
    expect(r.capturedTriangleCount).toBe(512);
  });

  it('drops scan surface apical to the cervical cut (axial filter)', () => {
    const arch = boxArch();
    const r = extractNeighbourRegion(arch.mesh, buildBvh(arch.mesh), SEED, arch.marginLoop, AXIS, {
      cervicalOffsetMm: 1,
    });
    for (const p of capturedVertices(r.mesh, r.capturedTriangleCount))
      expect(p[2]).toBeGreaterThanOrEqual(1);
    expect(r.capturedTriangleCount).toBe(16 * 12 * 2);
  });

  it('refuses a pick inside the restoration footprint', () => {
    const arch = boxArch();
    expect(() =>
      extractNeighbourRegion(arch.mesh, buildBvh(arch.mesh), [2, 0, 4], arch.marginLoop, AXIS),
    ).toThrow(NeighbourSeedTooCloseError);
  });

  it('refuses when nothing faces the restoration inside the window', () => {
    const arch = boxArch();
    expect(() =>
      extractNeighbourRegion(arch.mesh, buildBvh(arch.mesh), SEED, arch.marginLoop, AXIS, {
        radiusMm: 0.5,
      }),
    ).toThrow(NeighbourRegionEmptyError);
  });

  it('rejects invalid options', () => {
    const arch = boxArch();
    const bvh = buildBvh(arch.mesh);
    expect(() =>
      extractNeighbourRegion(arch.mesh, bvh, SEED, arch.marginLoop, AXIS, { radiusMm: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      extractNeighbourRegion(arch.mesh, bvh, SEED, arch.marginLoop, AXIS, { closureDepthMm: -1 }),
    ).toThrow(RangeError);
    expect(() => extractNeighbourRegion(arch.mesh, bvh, SEED, [], AXIS)).toThrow(RangeError);
  });
});

describe('extractNeighbourRegion — properties', () => {
  it('is translation-equivariant: the same source triangles for any rigid shift of the case', () => {
    const arch = boxArch();
    const base = extractNeighbourRegion(
      arch.mesh,
      buildBvh(arch.mesh),
      SEED,
      arch.marginLoop,
      AXIS,
    );
    fc.assert(
      fc.property(
        fc.integer({ min: -200, max: 200 }),
        fc.integer({ min: -200, max: 200 }),
        fc.integer({ min: -200, max: 200 }),
        (ix, iy, iz) => {
          const t: Vec3 = [ix / 8, iy / 8, iz / 8];
          const mesh = translate(arch.mesh, t);
          const loop = arch.marginLoop.map((p) => [p[0] + t[0], p[1] + t[1], p[2] + t[2]] as Vec3);
          const seed: Vec3 = [SEED[0] + t[0], SEED[1] + t[1], SEED[2] + t[2]];
          const r = extractNeighbourRegion(mesh, buildBvh(mesh), seed, loop, AXIS);
          expect(Array.from(r.sourceTriangleIndices)).toEqual(
            Array.from(base.sourceTriangleIndices),
          );
          expect(r.windowBoundaryBandMm).toBeCloseTo(base.windowBoundaryBandMm, 9);
        },
      ),
      { numRuns: 25 },
    );
  });

  it('captures the contact face for every seed on a grid over N’s occlusal surface', () => {
    // Exhaustive over a fixed grid (not random sampling) so the property is
    // reproducible: x ∈ [6, 8] in 0.125 mm steps, y ∈ [−1.5, 1.5] in 0.75 mm.
    const arch = boxArch();
    const bvh = buildBvh(arch.mesh);
    for (let i = 0; i <= 16; i++) {
      for (let j = 0; j <= 4; j++) {
        const seed: Vec3 = [6 + (2 * i) / 16, -1.5 + 0.75 * j, 4];
        const r = extractNeighbourRegion(arch.mesh, bvh, seed, arch.marginLoop, AXIS);
        // The contact point straight across the gap is inside the window.
        expect(
          closestPoint(r.mesh, buildBvh(r.mesh), [4, 0, 2]).distance,
          `seed ${seed.join(',')}`,
        ).toBeCloseTo(1, 12);
      }
    }
  });

  it('regression: a pick at N’s far edge still captures N, not the strip of D peeking past it', () => {
    // Found by the seed property: seed (8, −0.5625, 4) tilts n so a strip of
    // D's x = 10 face is visible beside N and lies nearer the pick than N's
    // contact face (the component was then chosen by distance to the pick).
    const arch = boxArch();
    const r = extractNeighbourRegion(
      arch.mesh,
      buildBvh(arch.mesh),
      [8, -0.5625, 4],
      arch.marginLoop,
      AXIS,
    );
    for (const p of capturedVertices(r.mesh, r.capturedTriangleCount))
      expect(p[0]).toBeLessThan(10);
    expect(closestPoint(r.mesh, buildBvh(r.mesh), [4, 0, 2]).distance).toBeCloseTo(1, 12);
  });
});
