// packages/kernel/src/axis/axis.test-fixtures.ts
//
// TEST-ONLY mesh fixtures for the axis/ test suite — mirrors
// undercut/undercut.test-fixtures.ts's / curvature/curvature.test-fixtures.ts's
// "TEST-ONLY, not exported from packages/kernel/src/index.ts" convention.
//
// No `Math.random`/`Date.now` anywhere below — closed-form over integer/
// float parameters, matching this project's determinism invariant.
import type { IndexedMesh } from '../mesh/types.ts';

type Vec3 = readonly [number, number, number];

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function meshFromLists(positions: readonly Vec3[], triangles: readonly (readonly [number, number, number])[]): IndexedMesh {
  const flatPositions = new Float64Array(positions.length * 3);
  positions.forEach((p, i) => flatPositions.set(p, i * 3));
  const indices = new Uint32Array(triangles.length * 3);
  triangles.forEach((t, i) => indices.set(t, i * 3));
  return { positions: flatPositions, indices };
}

/** Flips `face`'s winding if its raw cross-product normal points TOWARD
 * `reference` (i.e. it's currently inward-facing) — a PER-FACE orientation
 * fix (not a single whole-mesh sign flip like undercut.test-fixtures.ts's
 * `ensureOutwardWinding`), used here because this file's cap + wall
 * triangles are hand-authored in one pass and a per-face check is the only
 * way to guarantee EVERY face is independently correct regardless of
 * whether the raw authored pattern happens to already be globally
 * consistent. Mirrors scripts/generate-fixtures.ts's `orientOutward` used
 * by the production `buildStandinPrepDie` builder this file's
 * `coneFrustumMesh` deliberately parallels (see that function's doc).
 */
function orientOutward(
  positions: readonly Vec3[],
  face: readonly [number, number, number],
  reference: Vec3,
): readonly [number, number, number] {
  const [ia, ib, ic] = face;
  const a = positions[ia]!;
  const b = positions[ib]!;
  const c = positions[ic]!;
  const centroid: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  const normal = cross(sub(b, a), sub(c, a));
  const toRef = sub(reference, centroid);
  return dot(normal, toRef) > 0 ? [ia, ic, ib] : face;
}

export interface FrustumMesh {
  mesh: IndexedMesh;
  bottomRadius: number;
  topRadius: number;
  height: number;
  segments: number;
  heightSegments: number;
  center: Vec3;
}

/**
 * A capped cone frustum — bottom ring (at `center`'s z) has `bottomRadius`,
 * top ring (at `center.z + height`) has `topRadius`, wall subdivided into
 * `heightSegments` rings (mirrors curvature/curvature.test-fixtures.ts's
 * `cappedCylinderMesh`'s own `heightSegments` parameter — a region-
 * extraction test needs multiple intermediate rings along the wall so a
 * graph-distance ball SEEDED mid-wall stays genuinely local instead of
 * immediately touching the end rings via one huge single-triangle hop).
 * When `bottomRadius > topRadius` (this file's tests always use this
 * case), the wall drafts narrower toward `+Z`, mirroring
 * scripts/generate-fixtures.ts's `buildStandinPrepDie` TAPER WALL
 * construction (its `shoulderTopRing` -> `topRing` section) — minus that
 * fixture's vertical shoulder-COLLAR segment, deliberately: this fixture's
 * whole point is a wall whose outward normal has a UNIFORM,
 * comfortably-nonzero component along the true axis `[0,0,1]` everywhere
 * (`sin` of the frustum's half-angle, bounded well away from `0`), in
 * contrast to a right-CYLINDER wall's degenerate EXACTLY-zero dot product
 * at exact axis alignment (undercut/undercutScan.analytic.test.ts's own
 * `a = 0` case) — see suggestInsertionAxis.analytic.test.ts's module doc
 * for why that distinction matters for testing a coarse->fine SEARCH (as
 * opposed to re-verifying the undercut PRIMITIVE itself, which is that
 * other file's job). Every face's winding is verified/corrected per-face
 * via `orientOutward` (reference: the frustum's own centroid axis point) —
 * see that function's doc.
 */
export function coneFrustumMesh(
  bottomRadius: number,
  topRadius: number,
  height: number,
  segments: number,
  heightSegments = 1,
  center: Vec3 = [0, 0, 0],
): FrustumMesh {
  const ringIndex = (ring: number, seg: number): number => ring * segments + seg;
  const positions: Vec3[] = [];
  for (let r = 0; r <= heightSegments; r++) {
    const t = r / heightSegments;
    const z = center[2] + t * height;
    const radius = bottomRadius + (topRadius - bottomRadius) * t;
    for (let s = 0; s < segments; s++) {
      const theta = (2 * Math.PI * s) / segments;
      positions.push([center[0] + radius * Math.cos(theta), center[1] + radius * Math.sin(theta), z]);
    }
  }
  const bottomCenterIndex = positions.length;
  positions.push([center[0], center[1], center[2]]);
  const topCenterIndex = positions.length;
  positions.push([center[0], center[1], center[2] + height]);

  const reference: Vec3 = [center[0], center[1], center[2] + height / 2];
  const rawFaces: (readonly [number, number, number])[] = [];
  for (let r = 0; r < heightSegments; r++) {
    for (let s = 0; s < segments; s++) {
      const sNext = (s + 1) % segments;
      const a = ringIndex(r, s);
      const b = ringIndex(r, sNext);
      const c = ringIndex(r + 1, sNext);
      const d = ringIndex(r + 1, s);
      rawFaces.push([a, b, c]);
      rawFaces.push([a, c, d]);
    }
  }
  for (let s = 0; s < segments; s++) {
    const sNext = (s + 1) % segments;
    rawFaces.push([bottomCenterIndex, ringIndex(0, sNext), ringIndex(0, s)]);
  }
  for (let s = 0; s < segments; s++) {
    const sNext = (s + 1) % segments;
    rawFaces.push([topCenterIndex, ringIndex(heightSegments, s), ringIndex(heightSegments, sNext)]);
  }

  const triangles = rawFaces.map((f) => orientOutward(positions, f, reference));
  return {
    mesh: meshFromLists(positions, triangles),
    bottomRadius,
    topRadius,
    height,
    segments,
    heightSegments,
    center,
  };
}

/** Concatenates two disjoint meshes — `b`'s indices offset past `a`'s
 * vertex count. Mirrors scripts/kernel-ops-lib.ts's / undercut fixtures'
 * own `concatMeshes` (this repo's established "duplicate this tiny helper
 * per file" convention). */
export function concatMeshes(a: IndexedMesh, b: IndexedMesh): IndexedMesh {
  const vertexCountA = a.positions.length / 3;
  const positions = new Float64Array(a.positions.length + b.positions.length);
  positions.set(a.positions, 0);
  positions.set(b.positions, a.positions.length);
  const indices = new Uint32Array(a.indices.length + b.indices.length);
  indices.set(a.indices, 0);
  for (let i = 0; i < b.indices.length; i++) {
    indices[a.indices.length + i] = b.indices[i]! + vertexCountA;
  }
  return { positions, indices };
}
