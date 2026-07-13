// packages/kernel/src/curvature/curvature.ts
//
// Per-vertex discrete curvature: mean curvature H (cotangent-weighted
// Laplace-Beltrami / mixed Voronoi area, Meyer et al. 2003), Gaussian
// curvature K (angle defect / mixed area), and principal curvatures κ1/κ2
// derived from H and K. Phase 2 Task 3 (docs/plans/phase-2-kernel-core.md).
//
// ## Mean curvature H — formula and sign convention
//
// The discrete mean-curvature-NORMAL vector at vertex v (Meyer et al.,
// section 3.5, "Laplace-Beltrami Operator"), in terms of the RAW per-corner
// cotangents, is `(1 / (2*A_mixed(v))) * sum_j (cot(alpha_ij) + cot(beta_ij))
// * (p_j - p_v)`. cotan.ts's `computeCotanWeights` already bakes the leading
// `0.5 * (cot alpha + cot beta)` into its per-edge weight `w_vj` — see that
// file's module doc — so, written in terms of `w_vj`, the SAME quantity is:
//
//   L(v) = (1 / A_mixed(v)) * sum_{j in oneRing(v)} w_vj * (p_j - p_v)
//
// (`w_vj` from cotan.ts's `computeCotanWeights`, `A_mixed(v)` from
// mixedArea.ts's `computeMixedVoronoiAreas`) — NOT `1 / (2*A_mixed(v))`
// again, which would double-apply the same 0.5 the edge weight already
// carries (see this function's own inline comment at its `invA` term for
// the same point at the call site). `L(v)` converges to `-2*H*n` as the
// mesh refines, where `n` is the SAME outward unit normal intake guarantees
// consistent winding for (see intake/orient.ts) and `H` is the classical
// mean curvature SIGNED so a convex bulge as seen from outside (e.g. a
// sphere, viewed from outside) has POSITIVE H. This file reports SIGNED H,
// not `|H|` (this task's brief: "state whether H or |H|").
//
// Why `L(v)` points INWARD (opposite `n`) for a convex bulge: every
// neighbor `p_j` of a point on a convex surface lies on the same side of
// v's tangent plane as the surface's interior (a defining property of
// convexity), so `p_j - p_v` — and therefore the whole weighted sum — has a
// NEGATIVE component along the outward normal `n`. Solving `L(v) = -2*H*n`
// for H:
//
//   H(v) = -0.5 * dot(L(v), n(v))
//
// `n(v)` is normals.ts's `computeVertexNormals` estimate — needed ONLY to
// fix the SIGN of H; its magnitude is fully determined by `L(v)` and
// `A_mixed(v)` alone (no separate normal-estimate error enters the
// magnitude, since `n(v)` is unit length). This sign convention (and the
// `H = 1/r` value it produces for a sphere of radius r, verified against
// analytic closed forms) is the same one curvature.analytic.test.ts's
// sphere/cylinder/torus golden cases pin down.
//
// @errorBound This is a SECOND-ORDER-ACCURATE discretization of the
// continuous mean curvature on a smooth surface (Meyer et al.'s consistency
// result: the cotan-Laplacian recovers the exact linear-finite-element
// Laplace-Beltrami operator): for a mesh with local vertex spacing h at a
// point of curvature radius r, the error is `O((h/r)^2)` relative to the
// analytic value. See curvature.analytic.test.ts for the exact tolerance
// derivation this project's sphere/cylinder/torus golden cases use (derived
// from each fixture's own tessellation parameters, not tuned).
//
// ## Gaussian curvature K — angle defect
//
//   K(v) = (2*pi - sum_f angle_f(v)) / A_mixed(v)
//
// — the discrete Gauss-Bonnet identity (Meyer et al., section 3.6): summing
// `K(v) * A_mixed(v)` over every vertex of a CLOSED mesh recovers
// `2*pi*eulerCharacteristic` exactly in the limit, and closely even at
// finite tessellation (curvature.property.test.ts's Gauss-Bonnet property
// test). No separate sign convention is needed for K — unlike H, it does
// not depend on which way `n` points (an intrinsic, orientation-free
// quantity).
//
// ## Principal curvatures κ1/κ2
//
// From `H` and `K`: `κ1,κ2 = H +/- sqrt(H^2 - K)`, the roots of
// `κ^2 - 2*H*κ + K = 0` (since `H = (κ1+κ2)/2`, `K = κ1*κ2` by definition —
// `k1 >= k2` always, by construction of the `+/-`). The discriminant
// `H^2 - K` is analytically always `>= 0` (real curvatures), but the
// discrete estimators for H and K here are two INDEPENDENT approximations
// (different formulas, different discretization error) — near an umbilic
// point (κ1 ≈ κ2, e.g. every point on a sphere) their discrete errors can
// make `H^2 - K` slightly NEGATIVE. Clamped to `>= 0` before the `sqrt`
// (this task's brief: "clamped discriminant, documented") — the clamp only
// ever engages within Float64-rounding scale of zero (see
// curvature.property.test.ts), never masking a real, resolvable
// elliptic/hyperbolic distinction.
//
// ## Boundary policy — flag-and-exclude (this task's brief)
//
// A boundary vertex (touches at least one halfedge with no twin) has no
// well-defined one-ring "interior" area to divide by using the interior
// formulas above (the standard boundary corrections — e.g. treating the
// missing wedge as flat — are themselves approximations with their own,
// separately-debatable error model), and per this task's brief, Phase 3's
// margin/ridge detection only ever runs on INTERIOR prep-surface vertices
// anyway. So: every boundary vertex (and every ISOLATED vertex — no
// incident triangle, `vertexHalfedge === -1`, which has no one-ring at
// all) gets `H = K = k1 = k2 = 0` (never NaN/Infinity) and
// `isBoundary[v] = 1`; callers MUST check `isBoundary` before treating a 0
// as a real flat-point measurement.
//
// The SAME flag-and-exclude fallback also covers a topologically-interior
// vertex whose `mixedArea` is degenerate (not `> 0` — e.g. every incident
// triangle is itself degenerate/zero-area): with no well-defined divisor,
// it is retroactively treated exactly like a true boundary vertex
// (`isBoundary[v] = 1`, `H = K = k1 = k2 = 0`) rather than dividing by zero
// or a near-zero area (which would otherwise produce Infinity/NaN or a
// wildly unstable value) — see the `if (!(area > 0))` check at this
// function's per-vertex loop below.
import { buildHalfedge, destinationVertex, forEachOutgoingHalfedge } from '../halfedge/index.ts';
import type { HalfedgeMesh } from '../halfedge/types.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { computeCotanWeights } from './cotan.ts';
import { computeMixedVoronoiAreas } from './mixedArea.ts';
import { computeVertexNormals } from './normals.ts';
import { vertexPosition } from './vec.ts';

export interface CurvatureResult {
  /** Signed mean curvature per vertex, mm^-1 — see this file's module doc
   * for the sign convention. 0 (never NaN) at a boundary/isolated vertex. */
  H: Float64Array;
  /** Gaussian curvature per vertex, mm^-2. 0 at a boundary/isolated vertex. */
  K: Float64Array;
  /** Larger principal curvature (`k1 >= k2`), mm^-1. 0 at a
   * boundary/isolated vertex. */
  k1: Float64Array;
  /** Smaller principal curvature, mm^-1. 0 at a boundary/isolated vertex. */
  k2: Float64Array;
  /** `1` for a boundary OR isolated vertex (see this file's "Boundary
   * policy" doc), `0` otherwise — `Uint8Array` (not `boolean[]`), matching
   * this kernel's typed-array convention for per-vertex arrays. */
  isBoundary: Uint8Array;
  /** Mixed Voronoi area per vertex, mm^2 (mixedArea.ts's
   * `computeMixedVoronoiAreas`) — exposed for callers/tests that need it
   * directly (e.g. the area-partition property test) without recomputing
   * it themselves. Populated for EVERY vertex, including boundary ones
   * (unlike H/K/k1/k2, this value is well-defined regardless of the
   * boundary policy above — it's just a partition of incident triangle
   * area). */
  mixedArea: Float64Array;
}

/** Interior angle at vertex `p` within triangle (p, q, r) — `atan2(|cross|,
 * dot)`, the same numerically-stable form cotan.ts's `cotangentAtVertex`
 * builds on (robust near 0 and pi, unlike `acos(dot/(|u|*|v|))`). */
function triangleAngleAt(p: Vec3, q: Vec3, r: Vec3): number {
  const ux = q[0] - p[0];
  const uy = q[1] - p[1];
  const uz = q[2] - p[2];
  const vx = r[0] - p[0];
  const vy = r[1] - p[1];
  const vz = r[2] - p[2];
  const crossX = uy * vz - uz * vy;
  const crossY = uz * vx - ux * vz;
  const crossZ = ux * vy - uy * vx;
  const crossLen = Math.hypot(crossX, crossY, crossZ);
  const dotVal = ux * vx + uy * vy + uz * vz;
  return Math.atan2(crossLen, dotVal);
}

/**
 * Computes per-vertex discrete curvature over `mesh` — see this file's
 * module doc for every formula/convention. Builds its own `HalfedgeMesh`
 * internally (an `IndexedMesh` carries no adjacency of its own — see
 * halfedge/types.ts) unless the caller already has one (`hm`), so a caller
 * that also needs the halfedge structure for something else can skip
 * rebuilding it.
 *
 * @throws {NonManifoldEdgeError} via `buildHalfedge` if `mesh` has a
 * non-manifold edge — curvature is only defined over a (locally) oriented
 * manifold surface, same requirement as every other halfedge-based kernel
 * algorithm (repair first — see build.ts's doc).
 */
export function computeCurvature(mesh: IndexedMesh, hm: HalfedgeMesh = buildHalfedge(mesh)): CurvatureResult {
  const vertexCount = hm.vertexCount;
  const H = new Float64Array(vertexCount);
  const K = new Float64Array(vertexCount);
  const k1 = new Float64Array(vertexCount);
  const k2 = new Float64Array(vertexCount);
  const isBoundary = new Uint8Array(vertexCount);

  for (let he = 0; he < hm.halfedgeCount; he++) {
    if (hm.twin[he]! === -1) {
      isBoundary[hm.vertex[he]!] = 1;
      isBoundary[hm.vertex[hm.next[he]!]!] = 1;
    }
  }
  for (let v = 0; v < vertexCount; v++) {
    if (hm.vertexHalfedge[v]! === -1) isBoundary[v] = 1;
  }

  const mixedArea = computeMixedVoronoiAreas(hm, mesh);
  const cotanWeights = computeCotanWeights(hm, mesh);
  const normals = computeVertexNormals(hm, mesh);

  // Per-vertex angle sum (Gaussian curvature's angle-defect term) — one pass
  // over faces, alongside the mixed-area/cotan passes above; kept as a
  // local array rather than its own exported function (unlike cotan
  // weights, nothing outside this file needs the raw angle sum — Task 11's
  // reuse is specifically of the cotan weights, per this task's brief —
  // and curvature.property.test.ts's Gauss-Bonnet check verifies it via K
  // directly, so a separate export would be unused: YAGNI).
  const angleSum = new Float64Array(vertexCount);
  for (let f = 0; f < hm.faceCount; f++) {
    const ia = mesh.indices[f * 3]!;
    const ib = mesh.indices[f * 3 + 1]!;
    const ic = mesh.indices[f * 3 + 2]!;
    const a = vertexPosition(mesh.positions, ia);
    const b = vertexPosition(mesh.positions, ib);
    const c = vertexPosition(mesh.positions, ic);
    angleSum[ia]! += triangleAngleAt(a, b, c);
    angleSum[ib]! += triangleAngleAt(b, a, c);
    angleSum[ic]! += triangleAngleAt(c, a, b);
  }

  for (let v = 0; v < vertexCount; v++) {
    if (isBoundary[v]) continue; // flag-and-exclude — see module doc.
    const area = mixedArea[v]!;
    if (!(area > 0)) {
      // No well-defined one-ring area (e.g. every incident triangle
      // degenerate) — same "0, flagged" treatment as a true boundary vertex.
      isBoundary[v] = 1;
      continue;
    }

    const pv = vertexPosition(mesh.positions, v);
    let lx = 0;
    let ly = 0;
    let lz = 0;
    forEachOutgoingHalfedge(hm, v, (he) => {
      const w = cotanWeights[he]!;
      const pj = vertexPosition(mesh.positions, destinationVertex(hm, he));
      lx += w * (pj[0] - pv[0]);
      ly += w * (pj[1] - pv[1]);
      lz += w * (pj[2] - pv[2]);
    });
    // NOTE: `cotanWeights[he]` (cotan.ts) already bakes in the "0.5 *
    // (cotAlpha + cotBeta)" factor for each edge — the mean-curvature-normal
    // formula's own `1 / (2*A)` prefactor (this file's module doc) therefore
    // reduces to `1 / A` here, NOT `1 / (2*A)`: the weight's own 0.5 and the
    // formula's 0.5 are the SAME single factor, not two independent halvings.
    const invA = 1 / area;
    lx *= invA;
    ly *= invA;
    lz *= invA;

    const nx = normals[v * 3]!;
    const ny = normals[v * 3 + 1]!;
    const nz = normals[v * 3 + 2]!;
    const meanH = -0.5 * (lx * nx + ly * ny + lz * nz);
    const gaussK = (2 * Math.PI - angleSum[v]!) / area;
    const discriminant = Math.max(0, meanH * meanH - gaussK);
    const sqrtDiscriminant = Math.sqrt(discriminant);

    H[v] = meanH;
    K[v] = gaussK;
    k1[v] = meanH + sqrtDiscriminant;
    k2[v] = meanH - sqrtDiscriminant;
  }

  return { H, K, k1, k2, isBoundary, mixedArea };
}
