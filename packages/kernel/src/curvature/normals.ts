// packages/kernel/src/curvature/normals.ts
//
// Area-weighted vertex normal estimate — used ONLY to fix mean curvature's
// SIGN (curvature.ts: `H = -0.5 * dot(meanCurvatureVector, normal)`), not a
// general-purpose shading/rendering normal (apps/client/src/engine owns
// THAT concern independently, in Float32, per CLAUDE.md's Float32-render-
// copy rule). Deliberately the simplest correct estimator — each face's
// UNNORMALIZED cross product (whose magnitude already equals twice its
// area, weighting the per-vertex sum by area "for free") rather than
// angle-weighted (Max, 1999) or any other refinement — because this module
// only needs a normal accurate enough to get the correct SIGN, which any
// consistent-orientation estimator gives on every mesh this kernel produces
// (intake guarantees consistently, outward-wound triangles — see
// intake/orient.ts's `orientNormalsConsistently`).
import { cross, length, sub, vertexPosition } from './vec.ts';
import type { HalfedgeMesh } from '../halfedge/types.ts';
import type { IndexedMesh } from '../mesh/types.ts';

/**
 * Flat per-vertex UNIT normals (`vertexCount * 3`, xyz-interleaved).
 * `[0, 0, 0]` at a vertex with no incident triangle, or in the degenerate
 * case where every incident face normal happens to cancel exactly (e.g. a
 * single bowtie-adjacent zero-area fan) — callers must treat an all-zero
 * entry as "undefined direction", never divide by its (zero) length.
 */
export function computeVertexNormals(hm: HalfedgeMesh, mesh: IndexedMesh): Float64Array {
  const normals = new Float64Array(hm.vertexCount * 3);
  for (let f = 0; f < hm.faceCount; f++) {
    const ia = mesh.indices[f * 3]!;
    const ib = mesh.indices[f * 3 + 1]!;
    const ic = mesh.indices[f * 3 + 2]!;
    const a = vertexPosition(mesh.positions, ia);
    const b = vertexPosition(mesh.positions, ib);
    const c = vertexPosition(mesh.positions, ic);
    const n = cross(sub(b, a), sub(c, a));
    for (const v of [ia, ib, ic]) {
      normals[v * 3]! += n[0];
      normals[v * 3 + 1]! += n[1];
      normals[v * 3 + 2]! += n[2];
    }
  }
  for (let v = 0; v < hm.vertexCount; v++) {
    const nx = normals[v * 3]!;
    const ny = normals[v * 3 + 1]!;
    const nz = normals[v * 3 + 2]!;
    const len = length([nx, ny, nz]);
    if (len > 0) {
      normals[v * 3] = nx / len;
      normals[v * 3 + 1] = ny / len;
      normals[v * 3 + 2] = nz / len;
    }
  }
  return normals;
}
