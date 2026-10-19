// packages/kernel/src/neighbour/neighbour.test-fixtures.ts
//
// Closed-form fixtures for `extractNeighbourRegion` (Phase 9 Task 3): an
// "arch" built from axis-aligned, finely subdivided boxes, so every expected
// answer (which faces are captured, the contact distance) is exact.
// Deliberately NOT exported from the package (test-fixture convention).
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';

/**
 * A watertight, outward-wound axis-aligned box whose six faces are each a
 * `divisions × divisions` grid (shared vertices along the edges, welded by
 * exact coordinate). Grid coordinates are `min + (max - min) * i / divisions`.
 */
export function gridBox(min: Vec3, max: Vec3, divisions: number): IndexedMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const index = new Map<string, number>();
  const vertex = (p: Vec3): number => {
    const key = `${p[0]},${p[1]},${p[2]}`;
    const existing = index.get(key);
    if (existing !== undefined) return existing;
    const id = positions.length / 3;
    positions.push(p[0], p[1], p[2]);
    index.set(key, id);
    return id;
  };
  const at = (axis: number, i: number): number =>
    min[axis]! + ((max[axis]! - min[axis]!) * i) / divisions;
  // For each face: the fixed axis + side, and the two in-plane axes ordered
  // so (u × v) points outward.
  const faces: Array<{ fixed: number; high: boolean; u: number; v: number }> = [
    { fixed: 0, high: false, u: 2, v: 1 },
    { fixed: 0, high: true, u: 1, v: 2 },
    { fixed: 1, high: false, u: 0, v: 2 },
    { fixed: 1, high: true, u: 2, v: 0 },
    { fixed: 2, high: false, u: 1, v: 0 },
    { fixed: 2, high: true, u: 0, v: 1 },
  ];
  for (const f of faces) {
    const grid: number[][] = [];
    for (let i = 0; i <= divisions; i++) {
      const row: number[] = [];
      for (let j = 0; j <= divisions; j++) {
        const p = [0, 0, 0];
        p[f.fixed] = f.high ? max[f.fixed]! : min[f.fixed]!;
        p[f.u] = at(f.u, i);
        p[f.v] = at(f.v, j);
        row.push(vertex([p[0]!, p[1]!, p[2]!]));
      }
      grid.push(row);
    }
    for (let i = 0; i < divisions; i++) {
      for (let j = 0; j < divisions; j++) {
        const a = grid[i]![j]!;
        const b = grid[i + 1]![j]!;
        const c = grid[i + 1]![j + 1]!;
        const d = grid[i]![j + 1]!;
        indices.push(a, b, c, a, c, d);
      }
    }
  }
  return { positions: Float64Array.from(positions), indices: Uint32Array.from(indices) };
}

/** Concatenates meshes into one buffer (disjoint components, index-shifted). */
export function concatMeshes(...meshes: IndexedMesh[]): IndexedMesh {
  let vertexCount = 0;
  let indexCount = 0;
  for (const m of meshes) {
    vertexCount += m.positions.length / 3;
    indexCount += m.indices.length;
  }
  const positions = new Float64Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  let vOffset = 0;
  let iOffset = 0;
  for (const m of meshes) {
    positions.set(m.positions, vOffset * 3);
    for (let i = 0; i < m.indices.length; i++) indices[iOffset + i] = m.indices[i]! + vOffset;
    vOffset += m.positions.length / 3;
    iOffset += m.indices.length;
  }
  return { positions, indices };
}

/** Rectangular margin loop at height `z` around the box footprint
 * `[x0, x1] × [y0, y1]` (`perSide` points per side). */
export function rectangleLoop(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z: number,
  perSide = 8,
): Vec3[] {
  const loop: Vec3[] = [];
  for (let i = 0; i < perSide; i++) loop.push([x0 + ((x1 - x0) * i) / perSide, y0, z]);
  for (let i = 0; i < perSide; i++) loop.push([x1, y0 + ((y1 - y0) * i) / perSide, z]);
  for (let i = 0; i < perSide; i++) loop.push([x1 - ((x1 - x0) * i) / perSide, y1, z]);
  for (let i = 0; i < perSide; i++) loop.push([x0, y1 - ((y1 - y0) * i) / perSide, z]);
  return loop;
}

/**
 * The analytic "arch": restoration tooth R = [-4,4]×[-2,2]×[0,4], its
 * neighbour N = [5,9]×[-2,2]×[0,4] (a 1 mm proximal gap at x ∈ [4,5]), and a
 * second tooth D = [10,14]×[-2,2]×[0,4] behind N (occluded from R by N).
 * Margin loop: R's footprint at z = 0. Every face is a 16×16 grid
 * (0.5 mm × 0.25 mm cells).
 */
export function boxArch(): {
  mesh: IndexedMesh;
  marginLoop: Vec3[];
  restoration: IndexedMesh;
  neighbour: IndexedMesh;
} {
  const restoration = gridBox([-4, -2, 0], [4, 2, 4], 16);
  const neighbour = gridBox([5, -2, 0], [9, 2, 4], 16);
  const distractor = gridBox([10, -2, 0], [14, 2, 4], 16);
  return {
    mesh: concatMeshes(restoration, neighbour, distractor),
    marginLoop: rectangleLoop(-4, 4, -2, 2, 0),
    restoration,
    neighbour,
  };
}
