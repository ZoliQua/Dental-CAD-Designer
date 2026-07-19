// packages/kernel/src/sdf/pseudonormals.ts
//
// Angle-weighted pseudonormals (Bærentzen & Aanæs, "Signed Distance
// Computation Using the Angle Weighted Pseudonormal", IEEE TVCG 2005) —
// precomputed once per mesh, then reused by every `signedClosestPoint` query
// against it (signedDistance.ts). This is what makes the SIGN of a
// closest-point query well-defined and CONTINUOUS everywhere on the mesh's
// surface, including exactly on an edge or at a vertex, where a single
// triangle's own face normal is ambiguous (a query point near a convex edge
// can be "outside" relative to one incident face's normal and "inside"
// relative to the other's — the naive "use the nearest triangle's normal"
// approach flips sign depending on which of the two triangles floating-point
// rounding happens to pick as nearest, which is exactly the discontinuity
// Bærentzen & Aanæs's paper fixes).
//
// ## Why 3 separate normal arrays (face / edge / vertex)
//
// The paper's central result is that using the correct pseudonormal PER
// VORONOI-REGION of the query's closest point (a face's own normal for a
// face-interior closest point; the angle-weighted average of the two
// incident faces' normals for an edge; the angle-weighted sum of every
// incident face's normal for a vertex) makes the sign test exact for ANY
// closest point on a consistently-oriented closed manifold, not just an
// approximation that happens to work away from edges/vertices. See
// signedDistance.ts's `classifyBarycentricFeature` for how a `closestPoint`
// result's barycentric coordinates pick which of these three arrays to
// consult.
//
// ## Requires consistently-oriented, watertight input
//
// A pseudonormal is only meaningful if "outside" has a single, mesh-wide
// consistent meaning — i.e. `mesh` must be a CLOSED (watertight) 2-manifold
// with every triangle wound consistently (all outward, or all inward, but
// never mixed). `intake`'s pipeline (`orientNormalsConsistently`,
// `packages/kernel/src/intake/orient.ts`) guarantees the winding half of
// this for any mesh that passed through it; THIS module additionally
// requires watertightness (see `NonWatertightMeshError` below) and defends
// against inconsistent winding by building a real `HalfedgeMesh` (which
// rejects degree-2 edges traversed in the same direction by both incident
// triangles — see halfedge/build.ts's `NonManifoldEdgeError` "orientation"
// reason) rather than trusting the caller silently. A mesh that has NOT been
// through intake (or has been mutated since) is not defended against a
// SELF-CONSISTENT but globally-inverted winding (every triangle flipped
// together) — that still builds a valid `HalfedgeMesh` and valid
// pseudonormals, just with "inside" and "outside" swapped; nothing here can
// detect that case from topology alone (it requires knowing which side is
// physically outside, e.g. via `analyzeMesh`'s `signedVolumeMm3` sign, which
// this module deliberately does not second-guess — callers own getting
// intake's orientation step right upstream).
import type { IndexedMesh } from '../mesh/types.ts';
import { buildHalfedge, type HalfedgeMesh } from '../halfedge/index.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import type { MeshStats } from '../intake/types.ts';
import { cross, normalizeOrZero, sub, triangleAngleAt } from './vec.ts';
import type { Vec3 } from '../bvh/geometry.ts';

/**
 * Thrown by `computePseudonormals` when `mesh` is not watertight (per
 * `analyzeMesh(mesh).watertight` — see analyze.ts: closed 2-manifold, zero
 * boundary edges, zero non-manifold edges). Signed distance is only
 * well-defined for a closed surface (an open mesh has no consistent notion
 * of "inside"); this is Task 6's brief item 3's typed rejection. Offsetting
 * (Task 7) therefore also requires a watertight mesh — repair/hole-filling
 * (`packages/kernel/src/repair`) is the documented upstream fix for a mesh
 * that fails this check; open-mesh offsets are out of scope for this phase.
 */
export class NonWatertightMeshError extends Error {
  /** The full `analyzeMesh` report that triggered the rejection — surfaced
   * so a caller (or its UI) can explain WHY without recomputing stats. */
  readonly stats: MeshStats;

  constructor(stats: MeshStats) {
    super(
      `computePseudonormals: mesh is not watertight (boundaryEdgeCount=${stats.boundaryEdgeCount}, ` +
        `manifoldEdges=${stats.manifoldEdges}, componentCount=${stats.componentCount}) — signed distance ` +
        `is only meaningful for a closed (watertight, manifold) mesh. Run repair/hole-filling ` +
        `(packages/kernel/src/repair) first; open-mesh offsets are out of scope for this phase.`,
    );
    this.name = 'NonWatertightMeshError';
    this.stats = stats;
  }
}

/**
 * Precomputed angle-weighted pseudonormal arrays for a single watertight,
 * consistently-oriented `IndexedMesh` — see this module's top-of-file doc.
 * Immutable, keyed alongside a `Bvh` built from the SAME mesh (both are
 * per-mesh, per-contentHash derived data — see kernel-workers/src/jobs/sdf.ts
 * for the per-worker cache that shares the BVH cache's release lifecycle).
 */
export interface Pseudonormals {
  readonly faceCount: number;
  readonly vertexCount: number;
  readonly halfedgeCount: number;
  /** Unit face normals, `faceCount * 3` (xyz per face) — CCW-from-outside
   * cross product of the triangle's own two edges (`../mesh/types.ts`'s
   * `IndexedMesh` winding convention), `[0,0,0]` for a (defense-in-depth
   * only — see module doc) degenerate zero-area face. */
  readonly faceNormals: Float64Array;
  /** Angle-weighted, unit vertex pseudonormals, `vertexCount * 3` — sum of
   * `incidentFaceNormal * interiorAngleAtThisVertex` over every triangle
   * touching the vertex, then normalized. `[0,0,0]` for an unreferenced
   * vertex or a degenerate cancellation (defense in depth). */
  readonly vertexNormals: Float64Array;
  /** Unit edge pseudonormals, indexed by HALFEDGE (`halfedgeCount * 3`, same
   * indexing as `HalfedgeMesh` — see halfedge/types.ts): the average of the
   * two incident faces' unit normals, normalized. `edgeNormals` at a
   * halfedge `he` and its twin `twin[he]` always hold the IDENTICAL value
   * (same undirected edge) — storing one entry per halfedge rather than
   * deduplicating to one per undirected edge trades roughly 2x the array
   * size (halfedgeCount vs ~1.5x faceCount undirected edges) for direct
   * `triangleIndex*3 + localEdgeIndex` indexing with no separate edge-id
   * lookup — see signedDistance.ts's `pseudonormalForFeature` for the
   * indexing this buys. */
  readonly edgeNormals: Float64Array;
}

function computeFaceNormals(mesh: IndexedMesh, faceCount: number): Float64Array {
  const out = new Float64Array(faceCount * 3);
  for (let f = 0; f < faceCount; f++) {
    const ia = mesh.indices[f * 3]!;
    const ib = mesh.indices[f * 3 + 1]!;
    const ic = mesh.indices[f * 3 + 2]!;
    const a: Vec3 = [mesh.positions[ia * 3]!, mesh.positions[ia * 3 + 1]!, mesh.positions[ia * 3 + 2]!];
    const b: Vec3 = [mesh.positions[ib * 3]!, mesh.positions[ib * 3 + 1]!, mesh.positions[ib * 3 + 2]!];
    const c: Vec3 = [mesh.positions[ic * 3]!, mesh.positions[ic * 3 + 1]!, mesh.positions[ic * 3 + 2]!];
    const n = normalizeOrZero(cross(sub(b, a), sub(c, a)));
    out[f * 3] = n[0];
    out[f * 3 + 1] = n[1];
    out[f * 3 + 2] = n[2];
  }
  return out;
}

function computeVertexNormals(mesh: IndexedMesh, faceNormals: Float64Array, vertexCount: number): Float64Array {
  const out = new Float64Array(vertexCount * 3);
  const faceCount = mesh.indices.length / 3;
  for (let f = 0; f < faceCount; f++) {
    const ia = mesh.indices[f * 3]!;
    const ib = mesh.indices[f * 3 + 1]!;
    const ic = mesh.indices[f * 3 + 2]!;
    const a: Vec3 = [mesh.positions[ia * 3]!, mesh.positions[ia * 3 + 1]!, mesh.positions[ia * 3 + 2]!];
    const b: Vec3 = [mesh.positions[ib * 3]!, mesh.positions[ib * 3 + 1]!, mesh.positions[ib * 3 + 2]!];
    const c: Vec3 = [mesh.positions[ic * 3]!, mesh.positions[ic * 3 + 1]!, mesh.positions[ic * 3 + 2]!];
    const n: Vec3 = [faceNormals[f * 3]!, faceNormals[f * 3 + 1]!, faceNormals[f * 3 + 2]!];

    const angleA = triangleAngleAt(a, b, c);
    const angleB = triangleAngleAt(b, c, a);
    const angleC = triangleAngleAt(c, a, b);

    for (const [v, angle] of [
      [ia, angleA],
      [ib, angleB],
      [ic, angleC],
    ] as const) {
      out[v * 3] = out[v * 3]! + angle * n[0];
      out[v * 3 + 1] = out[v * 3 + 1]! + angle * n[1];
      out[v * 3 + 2] = out[v * 3 + 2]! + angle * n[2];
    }
  }
  for (let v = 0; v < vertexCount; v++) {
    const normalized = normalizeOrZero([out[v * 3]!, out[v * 3 + 1]!, out[v * 3 + 2]!]);
    out[v * 3] = normalized[0];
    out[v * 3 + 1] = normalized[1];
    out[v * 3 + 2] = normalized[2];
  }
  return out;
}

function computeEdgeNormals(hm: HalfedgeMesh, faceNormals: Float64Array): Float64Array {
  const out = new Float64Array(hm.halfedgeCount * 3);
  for (let he = 0; he < hm.halfedgeCount; he++) {
    const t = hm.twin[he]!;
    if (t === -1) {
      // Should not happen: `computePseudonormals` only calls this after
      // confirming `analyzeMesh(mesh).watertight` (zero boundary edges).
      // Defense in depth (not an expected path) rather than a crash: fall
      // back to this halfedge's own face normal, which is at worst the same
      // discontinuity a pre-pseudonormal naive implementation would have —
      // never a NaN/undefined value.
      const f = hm.face[he]!;
      out[he * 3] = faceNormals[f * 3]!;
      out[he * 3 + 1] = faceNormals[f * 3 + 1]!;
      out[he * 3 + 2] = faceNormals[f * 3 + 2]!;
      continue;
    }
    if (he > t) continue; // already computed (and mirrored) via the twin, below.
    const f0 = hm.face[he]!;
    const f1 = hm.face[t]!;
    const n0: Vec3 = [faceNormals[f0 * 3]!, faceNormals[f0 * 3 + 1]!, faceNormals[f0 * 3 + 2]!];
    const n1: Vec3 = [faceNormals[f1 * 3]!, faceNormals[f1 * 3 + 1]!, faceNormals[f1 * 3 + 2]!];
    const avg = normalizeOrZero([n0[0] + n1[0], n0[1] + n1[1], n0[2] + n1[2]]);
    out[he * 3] = avg[0];
    out[he * 3 + 1] = avg[1];
    out[he * 3 + 2] = avg[2];
    out[t * 3] = avg[0];
    out[t * 3 + 1] = avg[1];
    out[t * 3 + 2] = avg[2];
  }
  return out;
}

/**
 * Precomputes `Pseudonormals` for `mesh` — see this module's top-of-file doc
 * for the method and this file's `NonWatertightMeshError` for the
 * watertight-input requirement.
 *
 * @throws {NonWatertightMeshError} if `mesh` is not watertight.
 * @throws {NonManifoldEdgeError} (halfedge/build.ts) if `mesh` has a
 * non-manifold edge — including a degree-2 edge traversed by both incident
 * triangles in the SAME direction (inconsistent winding), the defense-in-
 * depth check for this module's "consistently-oriented input" requirement
 * (see top-of-file doc).
 *
 * @errorBound None beyond ordinary Float64 rounding: face normals are exact
 * (unnormalized cross product then a single `Math.hypot`/divide), and the
 * angle-weighting (`triangleAngleAt`, sdf/vec.ts) uses the same
 * `atan2(|cross|, dot)` form as curvature/curvature.ts's `triangleAngleAt`
 * (numerically stable near 0 and pi). The RESULT'S geometric meaning (a
 * pseudonormal is itself only piecewise-linear-exact for a polyhedral mesh —
 * it is what makes the SIGN of a nearby query point correct, not a claim
 * that it approximates a smooth surface's true normal beyond that) has no
 * additional tolerance to state here.
 */
export function computePseudonormals(mesh: IndexedMesh): Pseudonormals {
  const stats = analyzeMesh(mesh);
  if (!stats.watertight) {
    throw new NonWatertightMeshError(stats);
  }
  const hm = buildHalfedge(mesh);

  const faceCount = hm.faceCount;
  const vertexCount = hm.vertexCount;
  const halfedgeCount = hm.halfedgeCount;

  const faceNormals = computeFaceNormals(mesh, faceCount);
  const vertexNormals = computeVertexNormals(mesh, faceNormals, vertexCount);
  const edgeNormals = computeEdgeNormals(hm, faceNormals);

  return { faceCount, vertexCount, halfedgeCount, faceNormals, vertexNormals, edgeNormals };
}
