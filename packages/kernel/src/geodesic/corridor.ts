// packages/kernel/src/geodesic/corridor.ts
//
// Step 1 of `geodesicPath` (see geodesicPath.ts's module doc): Dijkstra-like
// search over the mesh's TRIANGLE DUAL graph (nodes = triangles, edges =
// shared mesh edges, via `faceNeighbors`) from `start`'s triangle to
// `end`'s triangle — a cheap, deterministic seed for a face CORRIDOR the
// straightening step (funnel.ts) then finds the exact taut path within, and
// geodesicPath.ts's widening loop re-invokes (with a growing
// `forbiddenEdges` restriction) when that path is locally too narrow.
//
// ## Priority: incrementally-unfolded straight-line distance from `start`
//
// A naive dual-graph Dijkstra weighted by raw centroid-to-centroid distance
// (this module's first implementation) can produce "staircase" corridors
// that needlessly zig-zag/loop back near the same local region — harmless
// for the FUNNEL's correctness (it still finds the exact shortest path
// WITHIN whatever corridor it's given) but it can leave a corridor's
// straightening pinned at a bend that a genuinely straighter route would
// have avoided. This module's incremental unfolding (below) produces a much
// better-behaved corridor in practice, and — because `dualGraphDijkstra` is
// always re-run FRESH from scratch (never patched in place) — every corridor
// it returns is a valid simple path (no duplicate faces) by construction,
// which is what lets geodesicPath.ts's widening loop safely forbid one edge
// and re-seed without ANY bookkeeping risk of a self-revisiting corridor.
//
// Instead, each relaxation candidate face is placed via a SINGLE hinge-
// unfold step from its (already-finalized) parent's own 2D placement
// (`unfold.ts`'s `placeFirstFace`/`placeNextFace` — the SAME primitive
// `sequentialUnfold` builds a whole corridor's flattening from, reused here
// one relaxation at a time), chaining all the way back to `start`'s own
// triangle. The search priority is the straight-line 2D distance, in that
// chain's own developed frame, from `start`'s exact unfolded position to
// the candidate face's centroid — i.e. "how far this triangle is from
// `start`, developed flat along THIS SPECIFIC route" rather than a summed
// series of independent local hops. Backtracking/self-crossing routes
// measurably increase this quantity (moving away from `start` in the
// developed plane), so the search is naturally biased away from them.
//
// This is a best-first / greedy expansion, NOT a strict textbook Dijkstra:
// the "distance" here is recomputed per-candidate from its specific parent
// chain rather than being a path-independent additive edge weight, so
// standard Dijkstra optimality proofs don't strictly apply. That's an
// accepted trade-off — this function is only ever a SEED for
// geodesicPath.ts's exact funnel-straightening + widening steps, not the
// final answer, so an occasionally-non-optimal (but well-behaved,
// non-self-crossing) corridor is fine: see geodesicPath.ts's
// `@errorBound` for how the downstream steps recover exactness within
// whatever corridor this seeds.
//
// ## Boundary behavior (this task's brief: "document + test path crossing
// boundary edges")
//
// `faceNeighbors` returns `-1` for a boundary halfedge (no triangle on the
// other side — halfedge/types.ts's boundary convention). This function never
// creates a dual-graph edge across a `-1` neighbor, so the corridor —  and
// therefore the whole geodesic path — NEVER crosses a boundary edge (there
// is nothing on the other side to unfold into). On an open mesh, the
// shortest corridor is the shortest INTERIOR-triangle route between the two
// triangles, which may run close alongside a boundary loop (hugging it) but
// never through the hole itself. This is the documented, tested choice (see
// geodesicPath.test.ts's boundary describe block) — the alternative
// ("constrained to run exactly along the boundary polyline when that's
// shorter") is not implemented (YAGNI: not needed by Phase 3's margin-line
// use case, which always anchors ON the surface, never spans a hole).
//
// ## One-ring seed extension (vertex-exact endpoints)
//
// `start`/`end` are arbitrary surface points — triangle + barycentric, per
// types.ts's `SurfacePoint` doc — but a LEGITIMATE surface point can happen
// to sit exactly (or effectively — `surfacePoint.ts`'s
// `vertexIndexIfExact`) AT a mesh vertex: `funnel.ts`'s own
// `materializeGeodesic` emits vertex-exact bend points, and Phase 3's
// planned margin-editing re-snap workflow round-trips through them (a bend
// point becomes a later re-snap's endpoint). Whichever ONE triangle such a
// point's `triangleIndex` happens to name is essentially arbitrary — a BVH
// projection or a previous funnel pass could have attached it to any of the
// (typically 5-6) triangles incident to that vertex, all representing the
// EXACT SAME 3D point. Seeding (or terminating) the search from only that
// one triangle measurably biases the incrementally-unfolded distance
// metric toward whichever local "wedge" of the one-ring that triangle
// happens to be in — this was measured to cost up to ~0.55% length error
// on vertex-anchored pairs (vs. ~0.05% typical), against a 0.1% acceptance
// budget (see geodesicPath.ts's `@errorBound`).
//
// The fix: when `start` (`end`) is vertex-exact at vertex `v`,
// `dualGraphDijkstra` seeds (terminates) from EVERY triangle in `v`'s
// one-ring (`oneRingFaces`) simultaneously, not just `start.triangleIndex`
// (`end.triangleIndex`) — a genuine multi-source/multi-sink Dijkstra. Each
// one-ring triangle is independently placed via `placeFirstFace` (its own
// hinge-unfold chain, own 2D frame — unrelated to any other one-ring
// triangle's frame) with distance 0 AT THE VERTEX (not the face centroid —
// `anchor2D` below is the vertex's own exact local corner position within
// that triangle's placement, inherited unchanged by every face reached
// further along that SAME chain, since `placeNextFace` only ever extends a
// chain's existing frame). Whichever one-ring triangle turns out to lead to
// the shortest route wins — eliminating the single-triangle seed bias
// entirely, since every one-ring triangle is tried on equal footing. See
// geodesicPath.ts's `placeSurfacePoint2D` for the corresponding change on
// the MATERIALIZATION side (the corridor's first/last face is no longer
// guaranteed to be `start.triangleIndex`/`end.triangleIndex` itself, so the
// exact vertex position — `unfold.ts`'s `vertex2D` map — is used instead of
// a barycentric combination against a specific face).
//
// ## Determinism
//
// Search tie-breaks are fully deterministic: the priority queue (heap.ts's
// `MinHeap`) breaks exact-priority ties by lower triangle index, and
// `faceNeighbors`' fixed per-triangle-corner order means the 3 candidate
// relaxations per popped triangle are always visited in the same order. The
// one-ring seed/target extension above adds no new nondeterminism: seed
// faces are pushed in `oneRingFaces`' own fixed traversal order (itself
// deterministic — halfedge/iterate.ts), and ties across DIFFERENT seed
// chains still resolve via the same `(priority, lower id)` heap rule. No
// `Math.random`/`Date.now` anywhere.
import type { IndexedMesh } from '../mesh/types.ts';
import type { HalfedgeMesh } from './../halfedge/types.ts';
import { faceNeighbors, oneRingFaces } from '../halfedge/iterate.ts';
import { MinHeap } from './heap.ts';
import { placeFirstFace, placeNextFace, vec2Sub, vec2Length, type FacePlacement, type Vec2 } from './unfold.ts';
import { evaluateSurfacePoint, vertexIndexIfExact } from './surfacePoint.ts';
import type { SurfacePoint } from './types.ts';

function faceCentroid2D(p: readonly [Vec2, Vec2, Vec2]): Vec2 {
  return { x: (p[0].x + p[1].x + p[2].x) / 3, y: (p[0].y + p[1].y + p[2].y) / 3 };
}

function distanceToStart2D(start2D: Vec2, placement: FacePlacement): number {
  return vec2Length(vec2Sub(faceCentroid2D(placement.positions), start2D));
}

function faceCentroid3D(mesh: IndexedMesh, corners: readonly [number, number, number]): [number, number, number] {
  const p = mesh.positions;
  const [ia, ib, ic] = corners;
  return [
    (p[ia * 3]! + p[ib * 3]! + p[ic * 3]!) / 3,
    (p[ia * 3 + 1]! + p[ib * 3 + 1]! + p[ic * 3 + 1]!) / 3,
    (p[ia * 3 + 2]! + p[ib * 3 + 2]! + p[ic * 3 + 2]!) / 3,
  ];
}

/** Straight-line (chord, NOT along-surface) 3D distance from a face's
 * centroid to `endPos` — an A* heuristic (see `dualGraphDijkstra`'s doc):
 * biases the search toward faces that are actually headed toward `end`,
 * which helps it settle on a genuinely direct corridor rather than one that
 * is merely locally taut from `start`'s side without actually tracking
 * toward the target (see geodesicPath.ts's widening loop, which can only
 * react to a detected FUNNEL BEND — a corridor that's straight-but-off-
 * target within itself never trips that trigger, so a better-directed seed
 * matters here). Since this is a heuristic added to a search that is
 * already NOT a strict shortest-path guarantee (this module's top doc), it
 * does not need to be a formally admissible A* heuristic — it only needs to
 * usefully bias exploration, which the straight-line chord distance does. */
function heuristicToEnd(mesh: IndexedMesh, corners: readonly [number, number, number], endPos: readonly [number, number, number]): number {
  const c = faceCentroid3D(mesh, corners);
  return Math.hypot(c[0] - endPos[0], c[1] - endPos[1], c[2] - endPos[2]);
}

/** Thrown when no face-adjacency route exists between `start`'s triangle and
 * `endFace` — either the mesh has more than one connected component (rare:
 * callers typically already validated this at intake) or `forbiddenEdges`
 * was restricted too aggressively (a defensive case that should not arise
 * from geodesicPath.ts's own widening logic today, since it only ever
 * forbids ONE additional edge per pass on an already-connected corridor). */
export class NoCorridorError extends Error {
  constructor(startFace: number, endFace: number) {
    super(`geodesicPath: no face-adjacency route from triangle ${startFace} to ${endFace} (disconnected mesh component)`);
    this.name = 'NoCorridorError';
  }
}

/** Canonical (order-independent) key for a dual-graph edge between two
 * faces — used by `forbiddenEdges` (`dualGraphDijkstra`) and
 * geodesicPath.ts's widening loop, which forbids the specific edge a bend
 * pinched on rather than excluding either face outright (a face can still
 * legitimately appear in a re-seeded corridor via a DIFFERENT edge). */
export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Seeds a face corridor from `start` to `end` — see this module's top doc
 * for the incrementally-unfolded distance heuristic (`g`) and
 * `heuristicToEnd`'s doc for the A*-style bias (`h`) added to the search
 * PRIORITY only (`dist[]`/`g` itself stays the pure unfolded distance from
 * `start` — see below). If `forbiddenEdges` is non-null, the search may
 * never cross a dual-graph edge whose `edgeKey` is a member —
 * geodesicPath.ts's widening loop uses this to force a FRESH, still-simple-
 * path re-seed around a bend that pinched on a specific face-to-face
 * transition, without the bookkeeping risk of manually splicing a
 * (possibly self-revisiting) corridor by hand.
 *
 * @throws {NoCorridorError} if `end.triangleIndex` is unreachable from
 * `start.triangleIndex` under the given restriction.
 */
export function dualGraphDijkstra(
  mesh: IndexedMesh,
  hm: HalfedgeMesh,
  start: SurfacePoint,
  end: SurfacePoint,
  forbiddenEdges: ReadonlySet<string> | null,
): number[] {
  const startFace = start.triangleIndex;
  const endFace = end.triangleIndex;
  if (startFace === endFace) return [startFace];

  const faceCount = hm.faceCount;
  const dist = new Float64Array(faceCount).fill(Infinity);
  const prev = new Int32Array(faceCount).fill(-1);
  const placements: (FacePlacement | undefined)[] = new Array(faceCount);
  // Per-face "distance-0" anchor — the vertex/point `dist[f]` is measured
  // FROM, expressed in `f`'s own placement frame. Ordinarily every face
  // shares the SAME anchor (`start`'s single placed position), but the
  // one-ring seed extension (module doc above) gives each seed chain its
  // OWN anchor (the shared vertex's own local corner position within that
  // chain's root), inherited unchanged by every face relaxed further along
  // that same chain (`placeNextFace` only ever extends an existing frame,
  // never re-roots it).
  const anchor2D: (Vec2 | undefined)[] = new Array(faceCount);
  const visited = new Uint8Array(faceCount);
  const heap = new MinHeap();
  const endPos = evaluateSurfacePoint(mesh, end);

  const startVertex = vertexIndexIfExact(mesh, start);
  const seedFaces = startVertex !== null ? oneRingFaces(hm, startVertex) : [startFace];
  for (const f of seedFaces) {
    if (placements[f] !== undefined) continue; // defensive de-dup — oneRingFaces never repeats a face
    const rootPlacement = placeFirstFace(mesh, f);
    let a2D: Vec2;
    if (startVertex !== null) {
      const local = rootPlacement.corners.indexOf(startVertex);
      a2D = rootPlacement.positions[local as 0 | 1 | 2]!; // exact — no barycentric rounding
    } else {
      const [w0, w1, w2] = start.barycentric;
      a2D = {
        x: rootPlacement.positions[0].x * w0 + rootPlacement.positions[1].x * w1 + rootPlacement.positions[2].x * w2,
        y: rootPlacement.positions[0].y * w0 + rootPlacement.positions[1].y * w1 + rootPlacement.positions[2].y * w2,
      };
    }
    placements[f] = rootPlacement;
    anchor2D[f] = a2D;
    const d0 = distanceToStart2D(a2D, rootPlacement);
    dist[f] = d0;
    heap.push(d0 + heuristicToEnd(mesh, rootPlacement.corners, endPos), f);
  }

  // Symmetric one-ring TARGET extension: when `end` is vertex-exact, the
  // search may legitimately terminate at ANY triangle incident to that
  // vertex — `end.triangleIndex` is just one arbitrary member of that set
  // (same reasoning as the seed side, mirrored — module doc above).
  const endVertex = vertexIndexIfExact(mesh, end);
  const targetFaces: ReadonlySet<number> = endVertex !== null ? new Set(oneRingFaces(hm, endVertex)) : new Set([endFace]);

  let actualEndFace = -1;
  while (heap.size > 0) {
    const top = heap.pop()!;
    const f = top.id;
    if (visited[f]) continue;
    visited[f] = 1;
    if (targetFaces.has(f)) {
      actualEndFace = f; // early termination — see module doc
      break;
    }

    const placement = placements[f]!;
    const a2D = anchor2D[f]!;
    const neighbors = faceNeighbors(hm, f);
    for (const n of neighbors) {
      if (n === -1) continue;
      if (forbiddenEdges && forbiddenEdges.has(edgeKey(f, n))) continue;
      if (visited[n]) continue;
      let candidatePlacement: FacePlacement;
      try {
        candidatePlacement = placeNextFace(mesh, placement, n);
      } catch {
        continue; // defensive — should not happen for a genuine mesh neighbor
      }
      const candidateDist = distanceToStart2D(a2D, candidatePlacement);
      if (candidateDist < dist[n]!) {
        dist[n] = candidateDist;
        prev[n] = f;
        placements[n] = candidatePlacement;
        anchor2D[n] = a2D; // inherited — same chain/frame as `f`, see doc above
        heap.push(candidateDist + heuristicToEnd(mesh, candidatePlacement.corners, endPos), n);
      }
    }
  }

  if (actualEndFace === -1) {
    throw new NoCorridorError(startFace, endFace);
  }

  const corridor: number[] = [];
  let cur = actualEndFace;
  while (cur !== -1) {
    corridor.push(cur);
    cur = prev[cur]!;
  }
  corridor.reverse();
  return corridor;
}
