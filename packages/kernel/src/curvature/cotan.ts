// packages/kernel/src/curvature/cotan.ts
//
// Cotangent edge weights — the building block of the discrete
// Laplace-Beltrami operator this module's mean-curvature estimator
// (curvature.ts) uses. Kept in its OWN file and exported standalone (not
// buried inside `computeCurvature`) per this task's brief: Task 11's
// thin-plate-spline fairing solve reuses this SAME per-edge cotan weight as
// its discrete Laplacian's stiffness-matrix entries, so it needs to be a
// separately-callable, separately-testable function, not an implementation
// detail of curvature.
//
// ## Convention
//
// For an interior (twinned) undirected edge {i, j} shared by two triangles
// (i, j, k) and (j, i, l), the cotan weight is the classic
//
//   w_ij = 0.5 * (cot(angle at k) + cot(angle at l))
//
// where "angle at k" is triangle (i,j,k)'s interior angle at its vertex
// OTHER than i and j (the angle "opposite" edge ij within that triangle) —
// see Pinkall & Polthier, "Computing Discrete Minimal Surfaces and Their
// Conjugates" (1993), and Meyer, Desbrun, Schröder, Barr, "Discrete
// Differential-Geometry Operators for Triangulated 2-Manifolds" (2003),
// section 3.5. For a BOUNDARY edge (only one incident triangle), the weight
// is just the single available term, `0.5 * cot(angle at k)` — there is no
// "other side" to add.
//
// `computeCotanWeights` returns one weight PER HALFEDGE (not per undirected
// edge) purely so callers can index it directly by the same halfedge index
// they're already circulating with (halfedge/iterate.ts's
// `forEachOutgoingHalfedge` cursor pattern) — `weights[he]` and
// `weights[twin[he]]` are always the SAME value (the edge weight is
// symmetric; see cotan.test.ts's symmetry property test), so storing one
// entry per halfedge is a convenience duplication, not two different
// numbers.
import type { HalfedgeMesh } from '../halfedge/types.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { cross, dot, length, sub, vertexPosition } from './vec.ts';
import type { Vec3 } from '../bvh/geometry.ts';

/**
 * Below this `|cross(u,v)|` magnitude, a triangle corner's angle is treated
 * as ill-defined (degenerate/zero-area triangle) and its cotangent is
 * reported as 0 rather than +/-Infinity or NaN — see `cotangentAtVertex`'s
 * `@errorBound`.
 */
const DEGENERATE_CROSS_EPSILON = 1e-15;

/**
 * Cotangent of a triangle's interior angle at vertex `p`, given the OTHER
 * two vertices `q`, `r` — i.e. `cot(angle q-p-r)`. Uses `dot/|cross|` (not
 * `cos/sin` via `acos`), the standard numerically-stable formulation:
 * `cot(theta) = dot(u,v) / |cross(u,v)|` for `u = q - p`, `v = r - p`.
 *
 * @errorBound Degenerates to 0 (never `Infinity`/`NaN`) when `|cross(u,v)|`
 * is below `DEGENERATE_CROSS_EPSILON` — a genuinely degenerate (zero-area)
 * triangle has an ill-defined angle, so contributing a zero weight (rather
 * than an unbounded one) keeps every downstream sum finite.
 * `dropDegenerateTriangles` (intake) already removes true zero-area
 * triangles from any mesh that went through kernel intake, so this is
 * defense-in-depth for out-of-pipeline callers (test fixtures, future direct
 * mesh construction) — it never fires on this project's real pipeline
 * output.
 */
export function cotangentAtVertex(p: Vec3, q: Vec3, r: Vec3): number {
  const u = sub(q, p);
  const v = sub(r, p);
  const crossLen = length(cross(u, v));
  if (crossLen < DEGENERATE_CROSS_EPSILON) return 0;
  return dot(u, v) / crossLen;
}

/**
 * Cotangent of `he`'s face's interior angle OPPOSITE `he`'s own edge — i.e.
 * the angle at the third corner (`vertex[next[next[he]]]`), exactly the
 * "angle at k" this file's module doc calls out for `he`'s triangle's side
 * of edge {origin(he), destination(he)}.
 */
export function cotangentOpposite(hm: HalfedgeMesh, mesh: IndexedMesh, he: number): number {
  const from = hm.vertex[he]!;
  const to = hm.vertex[hm.next[he]!]!;
  const opposite = hm.vertex[hm.next[hm.next[he]!]!]!;
  const p = vertexPosition(mesh.positions, opposite);
  const q = vertexPosition(mesh.positions, from);
  const r = vertexPosition(mesh.positions, to);
  return cotangentAtVertex(p, q, r);
}

/**
 * Per-halfedge cotan edge weight — see this file's module doc for the exact
 * formula and the "one value, two slots" convention. `O(halfedgeCount)`.
 */
export function computeCotanWeights(hm: HalfedgeMesh, mesh: IndexedMesh): Float64Array {
  const weights = new Float64Array(hm.halfedgeCount);
  for (let he = 0; he < hm.halfedgeCount; he++) {
    const twin = hm.twin[he]!;
    const own = cotangentOpposite(hm, mesh, he);
    const other = twin === -1 ? 0 : cotangentOpposite(hm, mesh, twin);
    weights[he] = 0.5 * (own + other);
  }
  return weights;
}
