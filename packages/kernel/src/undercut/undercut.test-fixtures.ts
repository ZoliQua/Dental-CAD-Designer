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
