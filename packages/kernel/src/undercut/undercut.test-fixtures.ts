// packages/kernel/src/undercut/undercut.test-fixtures.ts
//
// TEST-ONLY mesh fixtures for the undercut/ test suite — mirrors
// curvature/curvature.test-fixtures.ts's / halfedge/halfedge.test-fixtures.ts's
// convention (not exported from packages/kernel/src/index.ts).
//
// NOTE: this file does NOT provide a "tilted cylinder" builder. The
// undercut analytic tests (undercutScan.analytic.test.ts) instead reuse
// curvature/curvature.test-fixtures.ts's `cappedCylinderMesh` UNMODIFIED
// (axis fixed along +Z) and tilt the SCAN DIRECTION `d = (sin a, 0, cos a)`
// by angle `a` instead of rotating the mesh — the two are geometrically
// equivalent (only the RELATIVE angle between the cylinder axis and `d`
// matters to `normal · d`), and tilting `d` needs no new mesh-transform code
// at all. See that test file for the derivation.
//
// No `Math.random`/`Date.now` anywhere below — closed-form over integer/
// float parameters, matching this project's determinism invariant.
import type { IndexedMesh } from '../mesh/types.ts';

type Vec3 = readonly [number, number, number];

function meshFromLists(positions: readonly Vec3[], triangles: readonly (readonly [number, number, number])[]): IndexedMesh {
  const flatPositions = new Float64Array(positions.length * 3);
  positions.forEach((p, i) => flatPositions.set(p, i * 3));
  const indices = new Uint32Array(triangles.length * 3);
  triangles.forEach((t, i) => indices.set(t, i * 3));
  return { positions: flatPositions, indices };
}

/** `6 * signed volume` via the standard divergence-theorem triangle sum
 * (same formula intake/analyze.ts's `analyzeMesh` uses for
 * `signedVolumeMm3`, reproduced locally so this fixture file can
 * self-correct its OWN winding without importing product code — see
 * `ensureOutwardWinding` below). */
function sixSignedVolume(positions: readonly Vec3[], triangles: readonly (readonly [number, number, number])[]): number {
  let sum = 0;
  for (const [ia, ib, ic] of triangles) {
    const a = positions[ia]!;
    const b = positions[ib]!;
    const c = positions[ic]!;
    sum += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return sum;
}

/** Reverses every triangle's winding if the mesh's signed volume is
 * negative — guarantees CCW-from-outside winding BY CONSTRUCTION rather
 * than by hand-derived cross-product sign reasoning (this file's
 * `overhangStepMesh` builds a T-shaped extrusion where getting that by hand
 * right for BOTH end caps is error-prone; self-correcting via the volume
 * sign, then verifying `> 0` in the consuming test, is the robust choice —
 * same spirit as curvature.analytic.test.ts's own "watertight, positive-
 * volume solid" fixture self-check, just applied at construction time
 * instead of only at test time). */
function ensureOutwardWinding(
  positions: readonly Vec3[],
  triangles: readonly (readonly [number, number, number])[],
): (readonly [number, number, number])[] {
  if (sixSignedVolume(positions, triangles) >= 0) {
    return triangles.slice();
  }
  return triangles.map(([a, b, c]) => [a, c, b] as const);
}

/**
 * An "overhanging step" (T-shaped cross-section, extruded along Y from `0`
 * to `depth`) — a closed, watertight, CCW-from-outside solid with exactly
 * ONE overhang feature: a wide "slab" (`z` in `[columnHeight, columnHeight +
 * slabThickness]`, `x` in `[slabXMin, slabXMax]`) sitting on top of a
 * narrower "column" (`z` in `[0, columnHeight]`, `x` in `[columnXMin,
 * columnXMax]`, with `slabXMin < columnXMin` and `columnXMax < slabXMax`).
 *
 * Cross-section (viewed along `+y`, i.e. in the `x`-`z` plane), traced CCW:
 * ```
 *   slabXMin (0, colH+slabT) ------------------------- slabXMax (0, colH+slabT)
 *        |                                                          |
 *   (0,colH) overhang         (columnXMax,colH)         overhang (colH)
 *   underside ----- columnXMin,colH --+                 underside
 *                                     |  columnXMax,colH |
 *                                     |                  |
 *                             columnXMin,0 ---- columnXMax,0
 * ```
 * The TWO overhang regions (`x` in `[slabXMin, columnXMin]` and `x` in
 * `[columnXMax, slabXMax]`, both at `z = columnHeight`, facing `-z`) are the
 * fixture's whole point: for insertion direction `d = (0, 0, 1)`, their
 * outward normal is EXACTLY `(0, 0, -1)` (`normal · d = -1 < 0` — undercut,
 * per this module's sign convention), and a ray from any point on either
 * overhang cast along `+d` immediately re-enters the slab's solid (the
 * overhang sits directly under the slab, by construction) and exits through
 * the slab's TOP face at `z = columnHeight + slabThickness` — i.e. `depthMm
 * === slabThickness` EXACTLY (up to the ray-origin-bias/Float64 rounding
 * documented in undercutScan.ts), independent of exactly where on the
 * overhang the sample point falls (the slab's top face is flat and spans
 * the whole overhang footprint). See undercutScan.overhang.test.ts for the
 * hand-computed assertion this fixture exists for.
 *
 * The column's OWN bottom face (`z = 0`, `x` in `[columnXMin, columnXMax]`)
 * is also undercut for `d = (0,0,1)` (flat, facing `-z`) but its `+d` ray
 * travels all the way through both the column AND the slab, exiting at the
 * slab's top — `depthMm === columnHeight + slabThickness` exactly. Requires
 * `slabXMin < columnXMin < columnXMax < slabXMax`, `columnHeight > 0`,
 * `slabThickness > 0`, `depth > 0`.
 */
export function overhangStepMesh(
  columnXMin: number,
  columnXMax: number,
  slabXMin: number,
  slabXMax: number,
  columnHeight: number,
  slabThickness: number,
  depth: number,
): IndexedMesh {
  // Footprint (x, z), CCW-traced (verified: this exact vertex order gives a
  // POSITIVE 2D shoelace sum for the parameters this file's tests use —
  // `ensureOutwardWinding` below makes the final 3D mesh correct regardless,
  // this comment just records the intent).
  const footprint: readonly Vec3[] = [
    [columnXMin, 0, 0],
    [columnXMax, 0, 0],
    [columnXMax, 0, columnHeight],
    [slabXMax, 0, columnHeight],
    [slabXMax, 0, columnHeight + slabThickness],
    [slabXMin, 0, columnHeight + slabThickness],
    [slabXMin, 0, columnHeight],
    [columnXMin, 0, columnHeight],
  ];
  const n = footprint.length;
  const near: Vec3[] = footprint.map(([x, , z]) => [x, 0, z]);
  const far: Vec3[] = footprint.map(([x, , z]) => [x, depth, z]);
  const positions: Vec3[] = [...near, ...far]; // near: 0..n-1, far: n..2n-1

  let triangles: (readonly [number, number, number])[] = [];
  // Far cap (y = depth): fan from footprint vertex 0, footprint order preserved.
  for (let i = 1; i < n - 1; i++) {
    triangles.push([n + 0, n + i, n + i + 1]);
  }
  // Near cap (y = 0): same fan, reversed.
  for (let i = 1; i < n - 1; i++) {
    triangles.push([0, i + 1, i]);
  }
  // Side walls: one quad (2 triangles) per footprint edge i -> i+1 (cyclic).
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const b0 = i;
    const b1 = j;
    const t0 = n + i;
    const t1 = n + j;
    triangles.push([b0, b1, t1]);
    triangles.push([b0, t1, t0]);
  }

  triangles = ensureOutwardWinding(positions, triangles);
  return meshFromLists(positions, triangles);
}

/** CCW-from-outside box triangle list for the 8-vertex layout
 * `[xMin,yMin,zMin], [xMax,yMin,zMin], [xMax,yMax,zMin], [xMin,yMax,zMin],
 * [xMin,yMin,zMax], [xMax,yMin,zMax], [xMax,yMax,zMax], [xMin,yMax,zMax]`
 * — same vertex numbering/winding as halfedge.test-fixtures.ts's own
 * `cubeMesh` (reproduced here, not imported, per this file's "TEST-ONLY,
 * mirrors ... convention" doc — undercut/'s own fixtures stay self-
 * contained), just parameterized by explicit min/max instead of `±halfExtent`. */
function boxTriangles(): (readonly [number, number, number])[] {
  return [
    [0, 2, 1],
    [0, 3, 2], // bottom (-z)
    [4, 5, 6],
    [4, 6, 7], // top (+z)
    [0, 1, 5],
    [0, 5, 4], // front (-y)
    [1, 2, 6],
    [1, 6, 5], // right (+x)
    [2, 3, 7],
    [2, 7, 6], // back (+y)
    [0, 4, 7],
    [0, 7, 3], // left (-x)
  ];
}

function boxVertices(xMin: number, xMax: number, yMin: number, yMax: number, zMin: number, zMax: number): Vec3[] {
  return [
    [xMin, yMin, zMin],
    [xMax, yMin, zMin],
    [xMax, yMax, zMin],
    [xMin, yMax, zMin],
    [xMin, yMin, zMax],
    [xMax, yMin, zMax],
    [xMax, yMax, zMax],
    [xMin, yMax, zMax],
  ];
}

/**
 * Two DISJOINT, individually closed/watertight axis-aligned boxes — a
 * "floor" (`z` in `[0, floorThickness]`) and a "canopy" directly above it
 * with a genuine air `gap` (`z` in `[floorThickness + gap, floorThickness +
 * gap + canopyThickness]`), both spanning the SAME `[0,width] x [0,depthY]`
 * footprint — purpose-built to exercise undercutScan.ts's OCCLUSION rule
 * (see that module's "Occlusion as an INDEPENDENT undercut detector" doc):
 * for `d = (0,0,1)`, the floor's TOP face (`normal = (0,0,1)`, `normal · d
 * = 1 > 0`, strictly FACING — not undercut by the facing rule alone) sits
 * directly under the canopy, so a `+d` ray from any point on it re-enters
 * solid material (the canopy) after crossing EXACTLY the `gap` — i.e.
 * `depthMm === gap` EXACTLY, independent of exactly where on the floor top
 * the sample point falls (both boxes are flat-topped/bottomed and share the
 * full footprint). This is a DIFFERENT mechanism from `overhangStepMesh`'s
 * overhang (whose undercut undersides are undercut BY FACING, `normal · d <
 * 0`) — here the undercut triangle's OWN normal is on the "correct" side;
 * only the SEPARATE canopy mass makes it inaccessible.
 *
 * A valid `IndexedMesh` does not require a single connected component —
 * this fixture is the plain CONCATENATION of the two boxes' own (each
 * independently correct, CCW-from-outside) triangle lists; `undercutScan`
 * operates per-triangle against the combined BVH regardless of connectivity.
 * Requires `width > 0`, `depthY > 0`, `floorThickness > 0`, `gap > 0`,
 * `canopyThickness > 0`. See undercutScan.overhang.test.ts's canopy case
 * for the hand-computed assertions this fixture exists for.
 */
export function canopyMesh(width: number, depthY: number, floorThickness: number, gap: number, canopyThickness: number): IndexedMesh {
  const floorVertices = boxVertices(0, width, 0, depthY, 0, floorThickness);
  const canopyZMin = floorThickness + gap;
  const canopyVertices = boxVertices(0, width, 0, depthY, canopyZMin, canopyZMin + canopyThickness);

  const floorTriangles = ensureOutwardWinding(floorVertices, boxTriangles());
  const canopyTrianglesLocal = ensureOutwardWinding(canopyVertices, boxTriangles());

  const vertexOffset = floorVertices.length; // 8
  const positions: Vec3[] = [...floorVertices, ...canopyVertices];
  const triangles: (readonly [number, number, number])[] = [
    ...floorTriangles,
    ...canopyTrianglesLocal.map(([a, b, c]) => [a + vertexOffset, b + vertexOffset, c + vertexOffset] as const),
  ];

  return meshFromLists(positions, triangles);
}
