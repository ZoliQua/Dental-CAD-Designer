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
// ## Determinism
//
// Search tie-breaks are fully deterministic: the priority queue (heap.ts's
// `MinHeap`) breaks exact-priority ties by lower triangle index, and
// `faceNeighbors`' fixed per-triangle-corner order means the 3 candidate
// relaxations per popped triangle are always visited in the same order. No
// `Math.random`/`Date.now` anywhere.
import type { IndexedMesh } from '../mesh/types.ts';
import type { HalfedgeMesh } from './../halfedge/types.ts';
import { faceNeighbors } from '../halfedge/iterate.ts';
import { MinHeap } from './heap.ts';
import { placeFirstFace, placeNextFace, vec2Sub, vec2Length, type FacePlacement, type Vec2 } from './unfold.ts';
import { evaluateSurfacePoint } from './surfacePoint.ts';
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
  const visited = new Uint8Array(faceCount);
  const heap = new MinHeap();
  const endPos = evaluateSurfacePoint(mesh, end);

  const rootPlacement = placeFirstFace(mesh, startFace);
  const [w0, w1, w2] = start.barycentric;
  const start2D: Vec2 = {
    x: rootPlacement.positions[0].x * w0 + rootPlacement.positions[1].x * w1 + rootPlacement.positions[2].x * w2,
    y: rootPlacement.positions[0].y * w0 + rootPlacement.positions[1].y * w1 + rootPlacement.positions[2].y * w2,
  };
  placements[startFace] = rootPlacement;
  dist[startFace] = distanceToStart2D(start2D, rootPlacement);
  heap.push(dist[startFace]! + heuristicToEnd(mesh, rootPlacement.corners, endPos), startFace);

  while (heap.size > 0) {
    const top = heap.pop()!;
    const f = top.id;
    if (visited[f]) continue;
    visited[f] = 1;
    if (f === endFace) break; // early termination — see module doc

    const placement = placements[f]!;
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
      const candidateDist = distanceToStart2D(start2D, candidatePlacement);
      if (candidateDist < dist[n]!) {
        dist[n] = candidateDist;
        prev[n] = f;
        placements[n] = candidatePlacement;
        heap.push(candidateDist + heuristicToEnd(mesh, candidatePlacement.corners, endPos), n);
      }
    }
  }

  if (!visited[endFace]) {
    throw new NoCorridorError(startFace, endFace);
  }

  const corridor: number[] = [];
  let cur = endFace;
  while (cur !== -1) {
    corridor.push(cur);
    cur = prev[cur]!;
  }
  corridor.reverse();
  return corridor;
}
