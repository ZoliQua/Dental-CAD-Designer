// packages/kernel/src/halfedge/iterate.ts
//
// Traversal helpers over a `HalfedgeMesh`: vertex one-ring (outgoing
// halfedges / neighbor vertices / incident faces), face loops, boundary
// loops, and Euler characteristic + genus — per this task's brief item 3.
//
// ## Allocation-light cursor pattern
//
// The PRIMARY API here is a "visit callback" cursor: `forEachOutgoing*` /
// `forEachFaceHalfedge` walk the structure with a plain `while`/`do-while`
// loop over integer halfedge indices, calling `visit(he)` for each one —
// zero heap allocation beyond the closure the caller already had to create
// for `visit` itself (no intermediate array, no generator object, no
// iterator-result object per step). `nextOutgoingHalfedge`/
// `nextIncomingIsBoundary` etc. are pure `(HalfedgeMesh, number) -> number`
// step functions callers can inline into their OWN hot loop without even a
// callback, if they need to (e.g. a future curvature computation iterating
// millions of one-rings). Convenience array-returning wrappers
// (`oneRingVertices`, `oneRingFaces`, `faceVertices`) are built on top for
// tests and occasional/UI-driven call sites where the small array
// allocation is a non-issue — they are NOT what a hot inner loop should
// call.
import type { HalfedgeMesh } from './types.ts';
import { prevHalfedge } from './build.ts';

/** The vertex a halfedge points TO (its destination) — `vertex[next[he]]`.
 * (`vertex[he]` itself is the ORIGIN — see types.ts's doc.) */
export function destinationVertex(hm: HalfedgeMesh, he: number): number {
  return hm.vertex[hm.next[he]!]!;
}

/**
 * One step of the outgoing-halfedge circulator around a vertex: given an
 * outgoing halfedge `current` (`vertex[current] === v` for some `v`),
 * returns the NEXT outgoing halfedge from the same vertex `v`, walking in
 * the CW direction (`twin(prev(he))` — see build.ts's module doc for the
 * "vertexHalfedge anchors" derivation this pairs with), or `-1` if `current`
 * is adjacent to a boundary edge in that direction (nothing further to
 * visit — see `forEachOutgoingHalfedge`'s doc for why this correctly
 * terminates a boundary vertex's one-sided fan).
 *
 * Derivation: `current` goes `v -> u`. `prevHalfedge(current)` is the
 * halfedge before it in `current`'s face, which ends AT `v` (goes `w -> v`
 * for `current`'s face's third vertex `w`). Its twin, if any, goes
 * `v -> w` — i.e. it is itself an outgoing halfedge from `v`, in the
 * neighboring face on the other side of edge `{v, w}`.
 */
export function nextOutgoingHalfedge(hm: HalfedgeMesh, current: number): number {
  return hm.twin[prevHalfedge(current)]!;
}

/**
 * Visits every outgoing halfedge from vertex `v`, starting at
 * `hm.vertexHalfedge[v]`, in CW order (see `nextOutgoingHalfedge`). For an
 * INTERIOR vertex this reaches every incident face exactly once and stops
 * when it wraps back to the start (a closed fan). For a BOUNDARY vertex,
 * because `buildHalfedge` always anchors `vertexHalfedge[v]` at `v`'s own
 * boundary-outgoing halfedge when one exists (build.ts's doc), this walk
 * starts at one end of the fan and stops cleanly at the other (a one-sided
 * fan) — still visiting every incident face exactly once. Does nothing if
 * `v` has no incident triangle (`vertexHalfedge[v] === -1`).
 *
 * **Caveat**: this walk assumes `v` is NOT a bowtie vertex
 * (`findNonManifoldVertices`, build.ts) — at a bowtie, it only reaches the
 * one "wing" reachable from the chosen anchor, not every face touching `v`.
 * `buildHalfedge` does not reject bowties (see its doc), so callers working
 * with mesh data of unknown provenance should check
 * `findNonManifoldVertices` first if completeness matters.
 */
export function forEachOutgoingHalfedge(
  hm: HalfedgeMesh,
  v: number,
  visit: (halfedge: number) => void,
): void {
  const start = hm.vertexHalfedge[v]!;
  if (start === -1) return;
  let current = start;
  do {
    visit(current);
    const nextOut = nextOutgoingHalfedge(hm, current);
    if (nextOut === -1) return;
    current = nextOut;
  } while (current !== start);
}

/** Convenience array-returning wrapper over `forEachOutgoingHalfedge` — see
 * this module's top-of-file doc for when to prefer the callback form
 * instead. */
export function oneRingOutgoingHalfedges(hm: HalfedgeMesh, v: number): number[] {
  const out: number[] = [];
  forEachOutgoingHalfedge(hm, v, (he) => out.push(he));
  return out;
}

/**
 * `v`'s one-ring neighbor vertices, in the same CW order
 * `forEachOutgoingHalfedge` visits.
 *
 * **Boundary vertices have one MORE neighbor than incident triangle**: an
 * interior vertex with `m` incident triangles has exactly `m` neighbors —
 * one per outgoing halfedge's destination, forming a closed cycle. A
 * BOUNDARY vertex with `m` incident triangles has `m + 1` neighbors (an
 * open path, not a cycle) — but only `m` outgoing halfedges exist to walk
 * (see build.ts's boundary convention: a boundary edge has exactly ONE
 * halfedge, outgoing from whichever endpoint the triangle's winding makes
 * the origin — for the fan's FAR boundary edge, that's never `v` itself).
 * The one missing neighbor — the far end of the fan — is instead the
 * ORIGIN of `prevHalfedge` of the last halfedge `forEachOutgoingHalfedge`
 * visits before terminating at the boundary; this function detects that
 * termination (vs. a closed fan wrapping back to its start) and adds it.
 */
export function oneRingVertices(hm: HalfedgeMesh, v: number): number[] {
  const out: number[] = [];
  let last = -1;
  forEachOutgoingHalfedge(hm, v, (he) => {
    out.push(destinationVertex(hm, he));
    last = he;
  });
  if (last !== -1 && hm.twin[prevHalfedge(last)]! === -1) {
    out.push(hm.vertex[prevHalfedge(last)]!);
  }
  return out;
}

/** `v`'s incident faces, in the same order `forEachOutgoingHalfedge`
 * visits — each incident face contributes exactly one outgoing halfedge
 * from `v` (its corner at `v`), so this enumerates every incident face
 * exactly once. */
export function oneRingFaces(hm: HalfedgeMesh, v: number): number[] {
  const out: number[] = [];
  forEachOutgoingHalfedge(hm, v, (he) => out.push(hm.face[he]!));
  return out;
}

/** Visits every halfedge of face `f`'s loop, starting at `f`'s first corner
 * (`f * 3`) — for this kernel's triangle-only meshes always exactly 3
 * halfedges, walked generically via `next` (rather than hardcoding "3")
 * so this stays correct if a future extension ever allows non-triangle
 * faces (YAGNI today — not needed, but costs nothing to write generically). */
export function forEachFaceHalfedge(
  hm: HalfedgeMesh,
  f: number,
  visit: (halfedge: number) => void,
): void {
  const start = f * 3;
  let current = start;
  do {
    visit(current);
    current = hm.next[current]!;
  } while (current !== start);
}

/** `f`'s 3 corner vertices, in winding order. */
export function faceVertices(hm: HalfedgeMesh, f: number): [number, number, number] {
  const out: number[] = [];
  forEachFaceHalfedge(hm, f, (he) => out.push(hm.vertex[he]!));
  return out as [number, number, number];
}

/** `f`'s 3 face-adjacent neighbors (across each of its 3 edges), `-1` where
 * that edge is a boundary — i.e. `face[twin[he]]` for each of `f`'s
 * halfedges, in the same winding order as `faceVertices`. */
export function faceNeighbors(hm: HalfedgeMesh, f: number): [number, number, number] {
  const out: number[] = [];
  forEachFaceHalfedge(hm, f, (he) => {
    const t = hm.twin[he]!;
    out.push(t === -1 ? -1 : hm.face[t]!);
  });
  return out as [number, number, number];
}

/**
 * Finds every boundary loop in `hm`: each returned array is one hole's
 * boundary, as a sequence of boundary halfedges (`twin === -1`) walked so
 * that consecutive entries chain `destinationVertex(loop[i]) ===
 * vertex(loop[i+1])` — i.e. each loop reads as a closed walk around one
 * hole. Walking a loop from a boundary halfedge `b` to the next one relies
 * on the SAME anchor guarantee `forEachOutgoingHalfedge` does:
 * `hm.vertexHalfedge[destinationVertex(hm, b)]` is `b`'s destination
 * vertex's own boundary-outgoing halfedge (build.ts's doc), which — for an
 * ordinary boundary vertex touched by exactly one boundary-edge PAIR — is
 * exactly the next boundary halfedge along this same hole.
 *
 * **Caveat**: a "pinched" boundary (a vertex touched by 2+ SEPARATE
 * boundary-edge pairs — itself a bowtie-like non-manifold vertex, just
 * along the boundary rather than in the interior) breaks this simple
 * chase: `vertexHalfedge` can only ever record ONE anchor per vertex, so
 * one of the pinched holes silently continues into the other's loop rather
 * than closing on itself. This function defends against the resulting
 * infinite loop (a visited-halfedge guard) but does not attempt to recover
 * a correct decomposition for that case — same documented gap as
 * `repair/fillSmallHoles.ts`'s `findBoundaryLoops`, and out of scope for
 * the same reason (Task 11 territory).
 */
export function findBoundaryLoops(hm: HalfedgeMesh): number[][] {
  const visited = new Uint8Array(hm.halfedgeCount);
  const loops: number[][] = [];

  for (let he = 0; he < hm.halfedgeCount; he++) {
    if (hm.twin[he]! !== -1 || visited[he]) continue;
    const loop: number[] = [];
    let current = he;
    while (!visited[current] && current !== -1) {
      visited[current] = 1;
      loop.push(current);
      const dest = destinationVertex(hm, current);
      current = hm.vertexHalfedge[dest]!;
    }
    loops.push(loop);
  }

  return loops;
}

/** `V - E + F` and the raw counts it's computed from — see
 * `computeGenus`'s doc for turning this into a genus. */
export interface EulerCharacteristic {
  /** Count of vertices actually referenced by at least one halfedge (a
   * vertex with no incident triangle contributes nothing topologically and
   * is excluded — matches `MeshStats.bbox`'s identical convention in
   * intake/types.ts). */
  vertexCount: number;
  /** Every UNDIRECTED edge counted once: an interior (twinned) edge is
   * shared by 2 halfedges, a boundary edge by 1. */
  edgeCount: number;
  faceCount: number;
  eulerCharacteristic: number;
}

/** Computes `V - E + F` for `hm` — works for both closed and open (boundary-
 * having) manifolds; see `computeGenus` for the closed-surface-only genus
 * formula built on top of this. */
export function computeEulerCharacteristic(hm: HalfedgeMesh): EulerCharacteristic {
  let boundaryHalfedgeCount = 0;
  for (let he = 0; he < hm.halfedgeCount; he++) {
    if (hm.twin[he]! === -1) boundaryHalfedgeCount++;
  }
  const interiorHalfedgeCount = hm.halfedgeCount - boundaryHalfedgeCount;
  const edgeCount = interiorHalfedgeCount / 2 + boundaryHalfedgeCount;

  let vertexCount = 0;
  for (let v = 0; v < hm.vertexCount; v++) {
    if (hm.vertexHalfedge[v]! !== -1) vertexCount++;
  }

  return {
    vertexCount,
    edgeCount,
    faceCount: hm.faceCount,
    eulerCharacteristic: vertexCount - edgeCount + hm.faceCount,
  };
}

/**
 * Genus of a CLOSED (boundary-free), orientable manifold, via
 * `V - E + F = 2 - 2g`. Only meaningful without boundary — a bounded
 * surface's genus needs the boundary-loop count `b` too
 * (`V - E + F = 2 - 2g - b`), which this function does not compute (callers
 * needing that should combine `computeEulerCharacteristic` with
 * `findBoundaryLoops(hm).length` themselves).
 *
 * @throws {Error} if `hm` has any boundary edge, or if the implied genus is
 * not a non-negative integer (a strong signal of a non-orientable or
 * otherwise malformed input this simple formula does not apply to).
 */
export function computeGenus(hm: HalfedgeMesh): number {
  let hasBoundary = false;
  for (let he = 0; he < hm.halfedgeCount; he++) {
    if (hm.twin[he]! === -1) {
      hasBoundary = true;
      break;
    }
  }
  if (hasBoundary) {
    throw new Error(
      'computeGenus: only defined for a closed (boundary-free) manifold — use computeEulerCharacteristic ' +
        'plus findBoundaryLoops(hm).length for an open surface (V - E + F = 2 - 2g - b).',
    );
  }
  const { eulerCharacteristic } = computeEulerCharacteristic(hm);
  const twiceGenus = 2 - eulerCharacteristic;
  if (twiceGenus < 0 || twiceGenus % 2 !== 0) {
    throw new Error(
      `computeGenus: Euler characteristic ${eulerCharacteristic} does not imply a non-negative integer genus ` +
        '(2 - eulerCharacteristic must be a non-negative even number) — mesh is likely non-orientable or malformed.',
    );
  }
  return twiceGenus / 2;
}
