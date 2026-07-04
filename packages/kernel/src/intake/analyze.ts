// packages/kernel/src/intake/analyze.ts
//
// Read-only topological/geometric analysis of an IndexedMesh -> MeshStats.
// Never mutates or removes anything (contrast dropDegenerateTriangles /
// orientNormalsConsistently, which return modified meshes) — safe to call
// at any point in (or outside) the intake pipeline, e.g. to re-check stats
// after a later repair operation (Task 8).

import type { IndexedMesh } from '../mesh/types.ts';
import { checkDegenerateTriangle } from './degenerate.ts';
import { buildEdgeMap, connectedComponents, countEdgeDegrees } from './topology.ts';
import type { Bbox, MeshStats } from './types.ts';

/**
 * @errorBound Self-intersection is deliberately NOT reported here — checking
 * whether a mesh's triangles intersect each other (beyond shared edges) is a
 * separate, more expensive geometric query than anything below (which is
 * purely topological/combinatorial: edge degree, connectivity, and simple
 * per-triangle area/volume sums). Per this task's brief ("Self-intersection
 * check deferred to manifold construction") and PLAN.md §4's QC gate list
 * (watertight / manifold / no self-intersections are three SEPARATE gates),
 * that check happens later, at manifold-3d construction / QC-gate time
 * (`packages/kernel/src/boolean/manifold.ts`'s `NonManifoldInputError` path
 * covers non-manifold rejection; a dedicated self-intersection QC gate is
 * future kernel/cad-pipeline work, not part of this intake pipeline).
 * Intake reports the topological facts a caller needs to decide whether to
 * even ATTEMPT a manifold-3d construction (or a repair pass first) — it
 * does not itself validate every geometric property manifold-3d or the QC
 * gates will eventually check.
 */
export function analyzeMesh(mesh: IndexedMesh): MeshStats {
  const triangleCount = mesh.indices.length / 3;
  const edges = buildEdgeMap(mesh);
  const { boundaryEdgeCount, nonManifoldEdgeCount } = countEdgeDegrees(edges);
  const manifoldEdges = nonManifoldEdgeCount === 0;
  const watertight = manifoldEdges && boundaryEdgeCount === 0 && triangleCount > 0;

  const { componentCount } = connectedComponents(mesh, edges);

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let surfaceAreaMm2 = 0;
  let signedVolumeAcc = 0;
  let degenerateCount = 0;

  for (let t = 0; t < triangleCount; t++) {
    const base = t * 3;
    const a = mesh.indices[base]!;
    const b = mesh.indices[base + 1]!;
    const c = mesh.indices[base + 2]!;

    const ax = mesh.positions[a * 3]!;
    const ay = mesh.positions[a * 3 + 1]!;
    const az = mesh.positions[a * 3 + 2]!;
    const bx = mesh.positions[b * 3]!;
    const by = mesh.positions[b * 3 + 1]!;
    const bz = mesh.positions[b * 3 + 2]!;
    const cx = mesh.positions[c * 3]!;
    const cy = mesh.positions[c * 3 + 1]!;
    const cz = mesh.positions[c * 3 + 2]!;

    for (const [x, y, z] of [
      [ax, ay, az],
      [bx, by, bz],
      [cx, cy, cz],
    ] as const) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }

    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;
    const crossX = e1y * e2z - e1z * e2y;
    const crossY = e1z * e2x - e1x * e2z;
    const crossZ = e1x * e2y - e1y * e2x;
    surfaceAreaMm2 += Math.sqrt(crossX * crossX + crossY * crossY + crossZ * crossZ) / 2;

    // Divergence theorem: signed volume = (1/6) * sum(dot(v0, cross(v1, v2))).
    signedVolumeAcc += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;

    if (checkDegenerateTriangle(mesh, t).degenerate) degenerateCount++;
  }

  const bbox: Bbox =
    triangleCount > 0 ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } : { min: [0, 0, 0], max: [0, 0, 0] };

  return {
    watertight,
    manifoldEdges,
    componentCount,
    bbox,
    surfaceAreaMm2,
    signedVolumeMm3: watertight ? signedVolumeAcc : null,
    degenerateCount,
    boundaryEdgeCount,
  };
}
