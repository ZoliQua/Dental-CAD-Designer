// packages/kernel/src/undercut/undercutScan.overhang.test.ts
//
// Occlusion depth EXACT against a hand-computed value, per this task's
// brief — undercut.test-fixtures.ts's `overhangStepMesh` (a T-shaped
// extrusion: a wide "slab" overhanging a narrower "column") is built so the
// depth number is derivable by hand from the fixture's own parameters, not
// just plausible-looking.
import { describe, expect, it } from 'vitest';
import { buildBvh } from '../bvh/index.ts';
import { analyzeMesh } from '../intake/index.ts';
import { overhangStepMesh } from './undercut.test-fixtures.ts';
import { undercutScan, RAY_ORIGIN_BIAS_MM } from './undercutScan.ts';

const COLUMN_X_MIN = 1;
const COLUMN_X_MAX = 3;
const SLAB_X_MIN = 0;
const SLAB_X_MAX = 4;
const COLUMN_HEIGHT = 1;
const SLAB_THICKNESS = 1;
const DEPTH = 1;

function buildFixture() {
  return overhangStepMesh(COLUMN_X_MIN, COLUMN_X_MAX, SLAB_X_MIN, SLAB_X_MAX, COLUMN_HEIGHT, SLAB_THICKNESS, DEPTH);
}

describe('overhangStepMesh — fixture self-check', () => {
  it('is watertight, positive-volume, and its volume matches the exact column+slab closed form', () => {
    const mesh = buildFixture();
    const stats = analyzeMesh(mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.signedVolumeMm3).not.toBeNull();
    const columnVolume = (COLUMN_X_MAX - COLUMN_X_MIN) * DEPTH * COLUMN_HEIGHT;
    const slabVolume = (SLAB_X_MAX - SLAB_X_MIN) * DEPTH * SLAB_THICKNESS;
    const analyticVolume = columnVolume + slabVolume;
    expect(stats.signedVolumeMm3!).toBeCloseTo(analyticVolume, 9);
  });
});

describe('undercutScan — overhanging step: occlusion depth exact against hand-computed values', () => {
  it('the overhang undersides (both sides of the slab) are undercut with depth === slabThickness exactly', () => {
    const mesh = buildFixture();
    const bvh = buildBvh(mesh);
    const result = undercutScan(mesh, bvh, [0, 0, 1], { sampling: 'corners' });

    const triangleCount = mesh.indices.length / 3;
    let overhangTrianglesChecked = 0;
    for (let t = 0; t < triangleCount; t++) {
      const i0 = mesh.indices[t * 3]!;
      const i1 = mesh.indices[t * 3 + 1]!;
      const i2 = mesh.indices[t * 3 + 2]!;
      const p = mesh.positions;
      const zs = [p[i0 * 3 + 2]!, p[i1 * 3 + 2]!, p[i2 * 3 + 2]!];
      const xs = [p[i0 * 3]!, p[i1 * 3]!, p[i2 * 3]!];
      const allAtOverhangHeight = zs.every((z) => Math.abs(z - COLUMN_HEIGHT) < 1e-9);
      if (!allAtOverhangHeight) continue;
      const allOutsideColumnFootprint = xs.every((x) => x <= COLUMN_X_MIN + 1e-9 || x >= COLUMN_X_MAX - 1e-9);
      // Only the two overhang triangles' faces (not the column-top — there
      // is none, it's interior — nor a face straddling the column edge)
      // qualify: every corner strictly outside (or exactly at) the column's
      // x-footprint AND all at z=columnHeight.
      const centroidX = (xs[0]! + xs[1]! + xs[2]!) / 3;
      if (!allOutsideColumnFootprint) continue;
      overhangTrianglesChecked++;
      expect(result.undercut[t]).toBe(1);
      // Hand-computed: a ray from this face along +Z re-enters the slab
      // immediately (this face IS the slab's underside there) and exits at
      // the slab's flat top, z = columnHeight + slabThickness — travel
      // distance = slabThickness, independent of (x, y) within the
      // overhang footprint.
      expect(result.depthMm[t]!).toBeCloseTo(SLAB_THICKNESS, 6);
      void centroidX;
    }
    expect(overhangTrianglesChecked).toBe(4); // 2 triangles per overhang side (left + right), 1 quad each
  });

  it('the column base (z=0) is undercut with depth === columnHeight + slabThickness exactly (ray passes through both)', () => {
    const mesh = buildFixture();
    const bvh = buildBvh(mesh);
    const result = undercutScan(mesh, bvh, [0, 0, 1]);

    const triangleCount = mesh.indices.length / 3;
    let baseTrianglesChecked = 0;
    for (let t = 0; t < triangleCount; t++) {
      const i0 = mesh.indices[t * 3]!;
      const i1 = mesh.indices[t * 3 + 1]!;
      const i2 = mesh.indices[t * 3 + 2]!;
      const p = mesh.positions;
      const zs = [p[i0 * 3 + 2]!, p[i1 * 3 + 2]!, p[i2 * 3 + 2]!];
      if (!zs.every((z) => Math.abs(z) < 1e-9)) continue;
      baseTrianglesChecked++;
      expect(result.undercut[t]).toBe(1);
      expect(result.depthMm[t]!).toBeCloseTo(COLUMN_HEIGHT + SLAB_THICKNESS, 6);
    }
    expect(baseTrianglesChecked).toBe(2);
  });

  it('the slab TOP (z = columnHeight + slabThickness) is not undercut and has depth 0', () => {
    const mesh = buildFixture();
    const bvh = buildBvh(mesh);
    const result = undercutScan(mesh, bvh, [0, 0, 1]);
    const targetZ = COLUMN_HEIGHT + SLAB_THICKNESS;

    const triangleCount = mesh.indices.length / 3;
    let topTrianglesChecked = 0;
    for (let t = 0; t < triangleCount; t++) {
      const i0 = mesh.indices[t * 3]!;
      const i1 = mesh.indices[t * 3 + 1]!;
      const i2 = mesh.indices[t * 3 + 2]!;
      const p = mesh.positions;
      const zs = [p[i0 * 3 + 2]!, p[i1 * 3 + 2]!, p[i2 * 3 + 2]!];
      if (!zs.every((z) => Math.abs(z - targetZ) < 1e-9)) continue;
      topTrianglesChecked++;
      expect(result.undercut[t]).toBe(0);
      expect(result.depthMm[t]!).toBe(0);
    }
    expect(topTrianglesChecked).toBe(2);
  });

  it('grazing case: the vertical side walls (normal exactly perpendicular to d) are never undercut and never self-intersect at the shared overhang edge', () => {
    // The side wall directly below the overhang's outer edge (e.g. x =
    // slabXMin, a vertical face whose normal is (-1,0,0), perpendicular to
    // d=(0,0,1) => normal.d === 0 exactly, NOT undercut) shares an edge
    // EXACTLY with the overhang underside triangle this test targets above
    // — a real grazing/self-intersection risk for the ray-origin-bias
    // policy (undercutScan.ts's doc) if the bias were too small or the
    // BVH's own edge-hit epsilon (bvh/geometry.ts's BARYCENTRIC_EPSILON)
    // interacted badly with a sample point exactly ON that shared edge.
    const mesh = buildFixture();
    const bvh = buildBvh(mesh);
    const result = undercutScan(mesh, bvh, [0, 0, 1], { sampling: 'corners' });

    const triangleCount = mesh.indices.length / 3;
    let wallTrianglesChecked = 0;
    for (let t = 0; t < triangleCount; t++) {
      const i0 = mesh.indices[t * 3]!;
      const i1 = mesh.indices[t * 3 + 1]!;
      const i2 = mesh.indices[t * 3 + 2]!;
      const p = mesh.positions;
      const xs = [p[i0 * 3]!, p[i1 * 3]!, p[i2 * 3]!];
      // The slab's outer left wall: every vertex at x = slabXMin.
      if (!xs.every((x) => Math.abs(x - SLAB_X_MIN) < 1e-9)) continue;
      wallTrianglesChecked++;
      expect(result.undercut[t]).toBe(0); // normal . d === 0 exactly — not undercut
      expect(result.depthMm[t]!).toBe(0);
    }
    expect(wallTrianglesChecked).toBe(2);

    // And the overhang triangle whose one edge is EXACTLY that shared
    // boundary still reports the correct, non-self-intersected depth (not
    // ~0 from a spurious self-hit at the shared edge, and not RAY_ORIGIN_BIAS_MM-scale).
    for (let t = 0; t < triangleCount; t++) {
      const i0 = mesh.indices[t * 3]!;
      const i1 = mesh.indices[t * 3 + 1]!;
      const i2 = mesh.indices[t * 3 + 2]!;
      const p = mesh.positions;
      const xs = [p[i0 * 3]!, p[i1 * 3]!, p[i2 * 3]!];
      const zs = [p[i0 * 3 + 2]!, p[i1 * 3 + 2]!, p[i2 * 3 + 2]!];
      const touchesSharedEdge = xs.some((x) => Math.abs(x - SLAB_X_MIN) < 1e-9) && zs.every((z) => Math.abs(z - COLUMN_HEIGHT) < 1e-9);
      if (!touchesSharedEdge) continue;
      expect(result.undercut[t]).toBe(1);
      expect(result.depthMm[t]!).toBeGreaterThan(100 * RAY_ORIGIN_BIAS_MM); // comfortably not a self-intersection artifact
      expect(result.depthMm[t]!).toBeCloseTo(SLAB_THICKNESS, 6);
    }
  });
});
