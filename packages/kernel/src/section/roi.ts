// packages/kernel/src/section/roi.ts
//
// `extractLocalSubmesh`: crops an `IndexedMesh` to just the triangles with
// AT LEAST ONE vertex within `radiusMm` (ambient Euclidean distance) of
// `center`, reindexing vertices into a compact new buffer. This is a fast,
// approximate ROI PRE-FILTER for `sectionMesh`'s magnifier cross-section
// preview (Phase 3 margin-editor UX task 3 — kernel-workers' `jobs/
// section.ts`'s `roiRadiusMm` option), NOT a general-purpose mesh-cropping
// tool: it deliberately does NOT clip triangles that only PARTIALLY overlap
// the ROI sphere (no new boundary vertices are ever synthesized) — a
// triangle is either wholly included (verbatim, exact Float64 vertex
// positions — no precision loss) or wholly excluded.
//
// This means a polyline `sectionMesh` later extracts from this submesh can
// be TRUNCATED at the ROI boundary (an open end where a real margin/surface
// feature continues past the queried radius) — an intentional, documented
// WINDOWING of the query DOMAIN, not a numerical approximation of the
// geometry itself: every point `sectionMesh` reports from this submesh is
// exactly as precise as a full-mesh query would have produced for that same
// triangle (this function only ever copies vertex positions verbatim, never
// interpolates one).
//
// @errorBound Zero — this function performs no interpolation/approximation
// of any coordinate; the only "error" a caller can observe is a truncated
// query DOMAIN (see above), not degraded precision within it.
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';

/**
 * Crops `mesh` to triangles with at least one vertex within `radiusMm` of
 * `center`, reindexing surviving vertices into a compact new buffer (never
 * copies unused vertices). Single linear pass over every triangle (no BVH
 * traversal needed — a plain squared-distance check per vertex is already
 * cheap enough at this module's real-mesh scale; see this task's report for
 * the measured cost on the real 250k-triangle upperjaw).
 *
 * @throws {RangeError} if `radiusMm` is not finite and > 0.
 */
export function extractLocalSubmesh(mesh: IndexedMesh, center: Vec3, radiusMm: number): IndexedMesh {
  if (!(radiusMm > 0) || !Number.isFinite(radiusMm)) {
    throw new RangeError(`extractLocalSubmesh: radiusMm must be finite and > 0, got ${radiusMm}`);
  }
  const radiusSq = radiusMm * radiusMm;
  const { positions, indices } = mesh;
  const triangleCount = indices.length / 3;
  const remap = new Map<number, number>(); // old vertex index -> new (compact) vertex index
  const newPositions: number[] = [];
  const newIndices: number[] = [];

  function withinRadius(vi: number): boolean {
    const dx = positions[vi * 3]! - center[0];
    const dy = positions[vi * 3 + 1]! - center[1];
    const dz = positions[vi * 3 + 2]! - center[2];
    return dx * dx + dy * dy + dz * dz <= radiusSq;
  }

  function remapVertex(vi: number): number {
    const existing = remap.get(vi);
    if (existing !== undefined) return existing;
    const newIndex = newPositions.length / 3;
    newPositions.push(positions[vi * 3]!, positions[vi * 3 + 1]!, positions[vi * 3 + 2]!);
    remap.set(vi, newIndex);
    return newIndex;
  }

  for (let t = 0; t < triangleCount; t++) {
    const a = indices[t * 3]!;
    const b = indices[t * 3 + 1]!;
    const c = indices[t * 3 + 2]!;
    if (!withinRadius(a) && !withinRadius(b) && !withinRadius(c)) continue;
    newIndices.push(remapVertex(a), remapVertex(b), remapVertex(c));
  }

  return { positions: Float64Array.from(newPositions), indices: Uint32Array.from(newIndices) };
}
