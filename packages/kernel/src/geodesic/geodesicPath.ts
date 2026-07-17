// packages/kernel/src/geodesic/geodesicPath.ts
//
// Phase 2 Task 4: shortest surface path between two arbitrary surface points
// (triangle + barycentric — see types.ts's `SurfacePoint`, NOT just mesh
// vertices).
//
// ## Method: dual-graph Dijkstra corridor seed + sequential-unfold funnel
// straightening, with bounded corridor re-seeding widening (discrete "edge
// flip")
//
// 1. **Seed** (corridor.ts + this file's `geodesicPath`): a best-first
//    search over the triangle DUAL graph (nodes = triangles, edges = shared
//    mesh edges via `faceNeighbors`) from `start`'s triangle to `end`'s
//    triangle, priority = the straight-line distance from `start`, measured
//    by INCREMENTALLY hinge-unfolding each candidate triangle into the SAME
//    developed 2D frame as its parent (see corridor.ts's module doc — this
//    is a much better-behaved proxy for along-surface distance than raw
//    centroid-to-centroid hops, and in particular avoids the self-crossing
//    "staircase" corridors a naive centroid-distance weight can produce).
//    Because this priority is a CHAIN-dependent heuristic, not a
//    path-independent additive weight, THREE independent candidate
//    corridors are tried and the shortest kept: forward (start -> end),
//    backward (end -> start, reversed), and a midpoint SPLIT (two
//    roughly-half-length searches spliced through the forward corridor's
//    own middle face — see `geodesicPath`'s own inline doc for why halving
//    the chain length matters). Each produces an ordered face CORRIDOR: a
//    simply-connected strip of triangles that plausibly contains the true
//    geodesic.
// 2. **Unfold** (unfold.ts): sequentially flattens a corridor into a single
//    shared 2D plane, hinge by hinge, preserving every triangle's real 3D
//    edge lengths exactly (an isometric per-triangle flattening) — the SAME
//    primitive step 1's search already uses per-candidate, just now applied
//    to a whole finalized corridor at once.
// 3. **Straighten** (funnel.ts): runs the standard "funnel"/taut-string
//    algorithm (Lee & Preparata; the same algorithm navmesh pathfinding
//    calls the "Simple Stupid Funnel Algorithm") over the unfolded portals —
//    this finds the EXACT shortest path within the fixed corridor (a proven
//    property of the funnel algorithm), which corresponds 1:1 (via the
//    isometric unfolding) to the exact shortest path along the corridor's
//    real 3D triangle strip.
// 4. **Iterative widening** (this file, `geodesicPath`'s main loop): the
//    seed corridor from step 1 is still a heuristic, so it can be locally
//    too NARROW. Two independent triggers each identify a dual-graph edge
//    to forbid, then the WHOLE corridor is re-seeded from scratch (step 1
//    again, all 3 candidates) under the growing `forbiddenEdges`
//    restriction:
//     - a funnel BEND: the taut path gets pinned at a vertex a differently-
//       routed corridor could avoid — the SPECIFIC edge it pinched on
//       (`corridor[allIndex - 1] <-> corridor[allIndex]`) is forbidden;
//     - no bend (`findWorstDeviationFace`): a corridor can be internally
//       straight (zero bends) yet still not the globally shortest one,
//       since the funnel is only ever exact RELATIVE TO its own corridor —
//       the interior face whose centroid deviates farthest from the
//       straight `start2D -> end2D` line has its two corridor-adjacent
//       edges forbidden instead.
//    Forbidding (rather than hand-splicing the existing corridor) is the
//    discrete analog of an "edge flip": a completely fresh search always
//    yields a valid, non-self-revisiting simple path by construction. The
//    re-seeded corridor is kept only if it strictly shortens the total
//    path; a re-seed that doesn't help is discarded.
//
// ## Iterative straightening — convergence criterion (this task's brief)
//
// The widening loop (step 4) stops, in order of priority, when:
//   (a) the relative length improvement over the previous pass is below
//       `GEODESIC_REL_TOL` (default `1e-9`) — i.e. the corridor has
//       converged to (numerically) a local optimum;
//   (b) no interior bend vertex exists (the taut path is already a single
//       straight run — nothing to widen);
//   (c) every current bend's pinch edge was already forbidden (nothing new
//       to try), the re-seed under the newly-forbidden edges returns the
//       IDENTICAL corridor, or the re-seeded corridor doesn't actually
//       shorten the path (this widening step made no progress); or
//   (d) `maxIterations` (default `GEODESIC_MAX_ITERATIONS = 8`) passes have
//       run — a hard cap, purely a hang-guard for pathological/degenerate
//       inputs (e.g. near-antipodal points on a closed surface, which have
//       many equally-short candidate geodesics — see
//       geodesicPath.test.ts's degenerate-case tests).
// `GeodesicPathResult.iterations` reports how many widening passes actually
// applied an improving re-seed (0 if the very first corridor was already
// locally taut). `GeodesicPathResult.converged` (types.ts) reports WHICH of
// the two families above actually stopped the loop: `true` for (a)/(b)/(c)
// (a genuine convergence criterion was met), `false` only for (d) (the hard
// cap fired first — see geodesicPath.test.ts's cap-boundary test for a case
// where the exact same accuracy is reached at `maxIterations = 4` (reports
// `converged: false`, since the cap fires before the loop can check for
// convergence) as at the default cap (reports `converged: true`, since the
// loop keeps running long enough to actually verify no further improvement
// is available) — the flag is honest about what was VERIFIED, not just
// about the numeric answer.
//
// ## Determinism
//
// Every step is a deterministic function of `(mesh, hm, start, end)`: no
// `Math.random`/`Date.now` anywhere, the dual-graph search ties break on
// lower triangle index (heap.ts), the unfold's "which side" ambiguity is
// resolved by a fixed rule (unfold.ts), the funnel algorithm itself has no
// ties to break (it's a closed-form geometric construction), the 3-candidate
// seed picks the strictly-shortest materialized result (a later exact tie
// never overrides the earlier `forward`/`backward`/`midSplit` candidate —
// fixed evaluation order), the widening loop scans bend vertices in the
// funnel's own fixed output order when building `forbiddenEdges`, and
// `findWorstDeviationFace`'s fallback trigger scans corridor faces in
// increasing index order, keeping the first strictly-largest deviation. See
// geodesicPath.test.ts's determinism (hash) tests.
//
// ## Boundary behavior (open meshes)
//
// The dual graph never has an edge across a boundary halfedge (`twin ===
// -1` — halfedge/types.ts), so a corridor — and therefore any geodesic path
// this module produces — NEVER crosses a boundary edge: there is no
// triangle on the other side to unfold into. On an open mesh the shortest
// path is the shortest route through INTERIOR triangles only, which may run
// close alongside a boundary loop when that is the short way around a hole,
// but never through it. See corridor.ts's module doc for further discussion
// and geodesicPath.test.ts's boundary-crossing test.
//
// ## @errorBound
//
// Two independent, separately-bounded error sources:
//
// 1. **Algorithmic (corridor optimality).** With widening ENABLED (the
//    default), each accepted re-seed strictly shortens the path (or is
//    discarded), so the sequence of `materialized.length` values across
//    iterations is non-increasing by construction; there is no formal proof
//    this converges to the GLOBAL polyhedral-geodesic optimum within
//    `GEODESIC_MAX_ITERATIONS` passes for an ARBITRARY mesh (a
//    pathologically coarse or highly non-uniform triangulation could in
//    principle need more passes than the cap) — this is a documented,
//    accepted approximation, not an exact algorithm (unlike e.g.
//    Chen-Han/MMP, out of this task's scope — see the brief). On the
//    smooth, generically-triangulated meshes this method targets (e.g. an
//    icosphere), 0-2 widening passes are sufficient in practice — see
//    geodesicPath.analytic.test.ts's measured `iterations`.
// 2. **Tessellation (polyhedral vs. smooth-surface geodesic).** The
//    polyhedral geodesic itself differs from the TRUE smooth-surface
//    geodesic (e.g. a sphere's great-circle arc) because the mesh only
//    approximates the smooth surface. For a surface with local curvature
//    radius `r`, tessellated so that one mesh edge subtends angle `theta` at
//    the surface's local center of curvature, EACH straight mesh-edge chord
//    has length `2*r*sin(theta/2) = r*theta*(1 - theta^2/24 + O(theta^4))` —
//    i.e. UNDERESTIMATES the true arc length `r*theta` by a RELATIVE
//    fraction `theta^2/24 + O(theta^4)`. Since this fractional error is the
//    SAME for every segment of a piecewise-geodesic-following polyline (not
//    just one chord), the TOTAL polyhedral geodesic length also
//    underestimates the true smooth-surface geodesic length by
//    approximately this same relative fraction `theta^2/24` (same
//    chord-vs-arc derivation style as curvature.analytic.test.ts /
//    scripts/generate-fixtures.ts's icosphere tolerance derivations). See
//    geodesicPath.analytic.test.ts's top-of-file comment for this bound
//    applied concretely to the icosphere acceptance fixture (subdivision
//    level chosen so `theta^2/24` is comfortably under the 0.1% acceptance
//    budget) and the MEASURED max error over the seeded point-pair set.
//
// ### Vertex-exact endpoints (one-ring seed extension — fix batch)
//
// A THIRD, previously-undocumented error source affected `start`/`end`
// points sitting exactly (or effectively — `surfacePoint.ts`'s
// `vertexIndexIfExact`) AT a mesh vertex: `dualGraphDijkstra` used to seed
// (terminate) the corridor search from only the ONE triangle such a point's
// `triangleIndex` happened to name, even though every triangle incident to
// that vertex represents the exact same 3D point. This measurably biased
// the seed corridor toward whichever local "wedge" of the one-ring that
// triangle happened to be in — up to ~0.55% length error in the worst
// hunted case (fast-check's shrink-biased vertex sampling), well over the
// 0.1% acceptance budget, even though TYPICAL (non-vertex) points measured
// comfortably under it (see above). This is now FIXED: `dualGraphDijkstra`
// seeds/terminates from the vertex's WHOLE one-ring simultaneously (a
// genuine multi-source/multi-sink search — see corridor.ts's "One-ring seed
// extension" module doc for the mechanism), which makes the result
// PROVABLY INDEPENDENT of which one-ring triangle a caller happened to
// attach the point to (geodesicPath.vertexEndpoints.test.ts's "attachment
// invariance" test asserts this directly — bit-identical results across
// every one-ring choice). Measured max error on a seeded vertex-anchored
// pair set post-fix: see that same test file's "budget" test — comparable
// to the typical-case accuracy above, well under the 0.1% budget.
import type { HalfedgeMesh } from '../halfedge/types.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { dualGraphDijkstra, edgeKey } from './corridor.ts';
import { materializeGeodesic, type MaterializedPath } from './funnel.ts';
import { surfacePointDistanceSquared, vertexIndexIfExact } from './surfacePoint.ts';
import { sequentialUnfold, triarea2, vec2Length, vec2Sub, type UnfoldedCorridor, type Vec2 } from './unfold.ts';
import type { GeodesicOptions, GeodesicPathResult, SurfacePoint } from './types.ts';

/** Hard cap on corridor-widening passes — see this file's "Iterative
 * straightening" doc. */
export const GEODESIC_MAX_ITERATIONS = 8;
/** Relative total-length improvement below which widening is treated as
 * converged — see this file's "Iterative straightening" doc. */
export const GEODESIC_REL_TOL = 1e-9;

/**
 * Places `sp` in the corridor's shared unfolded 2D frame. If `sp` is
 * vertex-exact (`vertexIndexIfExact` — see corridor.ts's "one-ring seed
 * extension" doc), the EXACT vertex position already recorded in
 * `unfolded.vertex2D` is used instead of a barycentric combination against
 * `face2D[corridorIndex]` — this matters because `dualGraphDijkstra`'s
 * one-ring seeding means the corridor's first/last face is not necessarily
 * `sp.triangleIndex` itself (any triangle in the vertex's one-ring can win
 * the search), and even when it is, the exact vertex placement avoids any
 * barycentric-rounding noise at the one point where an exact answer is
 * available for free. Falls back to the ordinary barycentric placement if
 * the corridor doesn't happen to touch that vertex at all (defensive —
 * should not arise from `dualGraphDijkstra`'s own corridors, only possible
 * for a hand-built corridor bypassing it).
 */
function placeSurfacePoint2D(mesh: IndexedMesh, sp: SurfacePoint, unfolded: UnfoldedCorridor, corridorIndex: number): Vec2 {
  const vertex = vertexIndexIfExact(mesh, sp);
  if (vertex !== null) {
    const exact = unfolded.vertex2D.get(vertex);
    if (exact) return exact;
  }
  const [p0, p1, p2] = unfolded.face2D[corridorIndex]!;
  const [w0, w1, w2] = sp.barycentric;
  return { x: p0.x * w0 + p1.x * w1 + p2.x * w2, y: p0.y * w0 + p1.y * w1 + p2.y * w2 };
}

function runCorridor(mesh: IndexedMesh, corridor: readonly number[], start: SurfacePoint, end: SurfacePoint): MaterializedPath {
  const unfolded = sequentialUnfold(mesh, corridor);
  const start2D = placeSurfacePoint2D(mesh, start, unfolded, 0);
  const end2D = placeSurfacePoint2D(mesh, end, unfolded, corridor.length - 1);
  return materializeGeodesic(mesh, corridor, unfolded, start, start2D, end, end2D);
}

/**
 * Finds the corridor face whose centroid, in the corridor's own unfolded 2D
 * frame, deviates FARTHEST (perpendicular distance) from the straight line
 * `start2D -> end2D` — used as a fallback widening TRIGGER
 * (`geodesicPath`'s main loop) for the case the funnel reports ZERO
 * interior bends yet the corridor is still not the shortest one available:
 * a "straight run within a bulging corridor" produces no bend for the
 * primary (bend-triggered) widening step to react to, since the funnel is
 * only ever taut RELATIVE TO its own (possibly bulging) corridor — this
 * geometric deviation check is an independent signal that doesn't depend on
 * a bend having been detected. Returns `null` if the corridor has fewer
 * than 3 faces (nothing strictly "between" start/end to bulge through).
 */
function findWorstDeviationFace(
  corridor: readonly number[],
  face2D: readonly [Vec2, Vec2, Vec2][],
  start2D: Vec2,
  end2D: Vec2,
): { corridorIndex: number; deviation: number } | null {
  if (corridor.length < 3) return null;
  const chord = vec2Sub(end2D, start2D);
  const chordLen = vec2Length(chord);
  if (chordLen === 0) return null;
  let best = -1;
  let bestDeviation = 0;
  for (let i = 1; i < corridor.length - 1; i++) {
    const [p0, p1, p2] = face2D[i]!;
    const centroid: Vec2 = { x: (p0.x + p1.x + p2.x) / 3, y: (p0.y + p1.y + p2.y) / 3 };
    // Perpendicular distance from `centroid` to the infinite line through
    // start2D/end2D: |cross(chord, centroid - start2D)| / |chord|.
    const deviation = Math.abs(triarea2(start2D, end2D, centroid)) / chordLen;
    if (deviation > bestDeviation) {
      bestDeviation = deviation;
      best = i;
    }
  }
  return best === -1 ? null : { corridorIndex: best, deviation: bestDeviation };
}

function sameCorridor(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Shortest path from `start` to `end` along `mesh`'s surface — see this
 * file's module doc for the method, convergence criterion, determinism, and
 * `@errorBound`.
 *
 * @throws {NoCorridorError} (corridor.ts) if `start` and `end` are on
 * different connected components of `mesh`.
 */
export function geodesicPath(
  mesh: IndexedMesh,
  hm: HalfedgeMesh,
  start: SurfacePoint,
  end: SurfacePoint,
  options: GeodesicOptions = {},
): GeodesicPathResult {
  const maxIterations = options.maxIterations ?? GEODESIC_MAX_ITERATIONS;
  const relTol = options.relativeTolerance ?? GEODESIC_REL_TOL;

  // Degenerate case: same point (this task's brief: "length 0"). Trivially
  // converged — there is nothing to straighten/widen.
  if (surfacePointDistanceSquared(mesh, start, end) === 0) {
    return { points: [start, end], length: 0, iterations: 0, converged: true };
  }

  const forbiddenEdges = new Set<string>();
  // Multi-candidate seed: corridor.ts's search priority is a CHAIN-dependent
  // heuristic (not a path-independent additive weight — see its module
  // doc), so small per-step biases can compound over a LONG chain of hinge-
  // unfolds. Three cheap, independent candidate corridors are tried and the
  // shortest kept:
  //  - forward (start -> end) and backward (end -> start, reversed) — not
  //    symmetric, since the heuristic is chain-dependent, so the two
  //    searches can legitimately disagree;
  //  - a midpoint SPLIT: the forward corridor's own MIDDLE face (no BVH
  //    projection needed — just an index into the already-computed forward
  //    corridor) is used as a temporary waypoint, and two INDEPENDENT,
  //    roughly-half-length searches (start -> mid, mid -> end) are spliced
  //    together. Halving the chain length roughly halves the opportunity
  //    for compounding drift, and empirically resolves the specific
  //    "internally-straight-but-not-globally-shortest, so bend detection
  //    never fires" case the bend-triggered widening loop below cannot
  //    reach on its own (see geodesicPath.analytic.test.ts's acceptance
  //    test for the measured effect on a long icosphere path).
  // All three are O(one corridor search) each — negligible next to a
  // typical LOCAL margin-line segment (Phase 3's primary use case), and
  // still fast in aggregate for the occasional long path (see this task's
  // perf test on the upperjaw fixture).
  const forwardCorridor = dualGraphDijkstra(mesh, hm, start, end, null);
  const backwardCorridor = dualGraphDijkstra(mesh, hm, end, start, null).reverse();
  const midFace = forwardCorridor[Math.floor(forwardCorridor.length / 2)]!;
  const mid: SurfacePoint = { triangleIndex: midFace, barycentric: [1 / 3, 1 / 3, 1 / 3] };
  const midSplitCorridor = [
    ...dualGraphDijkstra(mesh, hm, start, mid, null),
    ...dualGraphDijkstra(mesh, hm, mid, end, null).slice(1),
  ];

  let corridor = forwardCorridor;
  let materialized = runCorridor(mesh, corridor, start, end);
  for (const candidateCorridor of [backwardCorridor, midSplitCorridor]) {
    const candidateMaterialized = runCorridor(mesh, candidateCorridor, start, end);
    if (candidateMaterialized.length < materialized.length) {
      corridor = candidateCorridor;
      materialized = candidateMaterialized;
    }
  }
  let prevLength = Infinity;
  let iterations = 0;
  // `converged` tracks whether the loop's LAST break was a genuine
  // convergence criterion ((a)/(b)/(c) below) rather than the hard cap
  // (d) — see types.ts's `GeodesicPathResult.converged` doc. Defaults
  // `false`: only explicitly flipped `true` at each convergence break, so a
  // cap-triggered exit (which never reaches one of those breaks) correctly
  // reports `false` by construction.
  let converged = false;

  for (let iter = 0; iter <= maxIterations; iter++) {
    const relImprovement = (prevLength - materialized.length) / Math.max(prevLength, 1e-12);
    iterations = iter;
    if (iter > 0 && relImprovement < relTol) {
      converged = true;
      break; // converged — see (a) above
    }
    prevLength = materialized.length;
    if (iter === maxIterations) break; // hang-guard cap — see (d) above; `converged` stays false

    // Forbid every bend's pinch edge (fixed scan order — see this file's
    // "Determinism" doc), then re-derive the WHOLE corridor fresh under
    // that restriction — see this file's "Iterative widening" doc for why
    // a fresh re-seed (always a valid simple path) is used instead of
    // manually splicing the existing corridor.
    let addedForbidden = false;
    for (const bend of materialized.bendVertices) {
      const key = edgeKey(corridor[bend.allIndex - 1]!, corridor[bend.allIndex]!);
      if (!forbiddenEdges.has(key)) {
        forbiddenEdges.add(key);
        addedForbidden = true;
      }
    }
    if (!addedForbidden) {
      // No bend to react to (see (b) above) OR every current pinch was
      // already forbidden — fall back to `findWorstDeviationFace` (this
      // file's doc above it): a corridor can be internally taut (zero
      // bends) yet still not the globally shortest one, since the funnel
      // is only ever exact RELATIVE TO its own corridor. Forbid the
      // most-bulging interior face's two corridor-adjacent edges and retry
      // — an independent widening trigger that doesn't require a bend.
      const unfolded = sequentialUnfold(mesh, corridor);
      const start2D = placeSurfacePoint2D(mesh, start, unfolded, 0);
      const end2D = placeSurfacePoint2D(mesh, end, unfolded, corridor.length - 1);
      const worst = findWorstDeviationFace(corridor, unfolded.face2D, start2D, end2D);
      if (worst) {
        for (const key of [
          edgeKey(corridor[worst.corridorIndex - 1]!, corridor[worst.corridorIndex]!),
          edgeKey(corridor[worst.corridorIndex]!, corridor[worst.corridorIndex + 1]!),
        ]) {
          if (!forbiddenEdges.has(key)) {
            forbiddenEdges.add(key);
            addedForbidden = true;
          }
        }
      }
    }
    if (!addedForbidden) {
      converged = true;
      break; // nothing left to try — see (b)/(c) above
    }

    let nextCorridor: number[];
    try {
      nextCorridor = dualGraphDijkstra(mesh, hm, start, end, forbiddenEdges);
    } catch {
      // No route avoids every forbidden edge tried so far — keep the best
      // result found. This is a genuine convergence state (nothing MORE to
      // try), not a cap truncation.
      converged = true;
      break;
    }
    if (sameCorridor(nextCorridor, corridor)) {
      converged = true;
      break; // re-seed found nothing new — see (c) above
    }

    const nextMaterialized = runCorridor(mesh, nextCorridor, start, end);
    if (!(nextMaterialized.length < materialized.length)) {
      converged = true;
      break; // no improvement — see (c) above
    }

    corridor = nextCorridor;
    materialized = nextMaterialized;
  }

  return { points: materialized.points, length: materialized.length, iterations, converged };
}
