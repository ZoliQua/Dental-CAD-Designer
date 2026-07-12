// packages/kernel/src/repair/fillSmallHoles.ts
//
// Detects boundary loops (holes) small enough to trust (per
// `FillSmallHolesOptions`) and closes them: ear-clip triangulation using
// only the loop's existing boundary vertices, then a local refinement +
// Laplacian relax pass over the NEW interior vertices that refinement adds.
// Reuses intake/topology.ts's `buildEdgeMap` for boundary-edge detection —
// same edge-adjacency notion `MeshStats.boundaryEdgeCount` is defined
// against.
//
// @approximation The fill this function produces is SMOOTH but explicitly
// NOT curvature-continuous with the surrounding surface: the Laplacian relax
// below (a handful of fixed-lambda averaging passes) blends the patch's
// interior vertices toward their neighbors' positions, which removes gross
// faceting but does not solve for (or even estimate) the surrounding
// surface's actual curvature. A curvature-continuous fill (e.g. solving a
// biharmonic/thin-plate energy against the boundary's tangent continuity) is
// explicitly deferred to the Phase 2 kernel — see
// docs/plans/phase-1-import-viewer.md's Task 8 "Deviations (Phase 1)" note.
// QC gates in later phases treat a filled region like any other geometry (no
// special-casing), so this is a documented, honest limitation rather than a
// silent one.
//
// ## Boundary-loop walk direction
//
// Each boundary edge {a, b} has exactly one incident triangle, which
// traverses it in a specific direction (`EdgeIncidence.directed`: `true`
// means the triangle's winding goes a -> b, `false` means b -> a — see
// topology.ts). Call that the edge's "surface direction" `from -> to`. The
// HOLE's boundary, walked in the direction that produces correctly
// (CCW-from-outside) wound fill triangles, is the REVERSE of every edge's
// surface direction: `holeNext[to] = from`. This is the standard
// hole-filling convention (an inner/hole boundary is wound opposite to an
// outer silhouette for a consistently outward-facing surface) and is what
// `findBoundaryLoops` below builds.
//
// ## Ear-clipping on a projected best-fit plane
//
// A boundary loop is, in general, a 3D (non-planar) polygon. This function
// projects it onto its Newell-normal best-fit plane (the SAME normal
// estimator used for polygon area, see `loopNormalAndArea`) purely to make
// the ear-clip CONVEXITY/CONTAINMENT decisions in 2D — the resulting
// triangles still use the loop's real, unprojected 3D vertex positions.
// **Limitation, by design**: a highly non-planar loop's projection can
// mis-classify ears (e.g. treat a vertex as convex when the true 3D polygon
// is not even simple), producing a poor-quality fill — this is exactly WHY
// `maxBoundaryEdges` defaults small (32): bigger loops are far likelier to
// be badly non-planar, and this function has no fallback for that case
// beyond `maxAreaMm2`/`maxBoundaryEdges` refusing to attempt it at all.
//
// ## Local Laplacian relax of the new patch
//
// Ear-clipping alone only ever introduces triangles between EXISTING
// boundary-loop vertices — no new vertices, nothing to relax, and (more
// importantly) it can leave the patch faceted/flat relative to the
// surrounding curved surface. This function therefore refines the ear-clip
// result once: every ear-clip triangle gets a new centroid vertex (fan-split
// into 3 sub-triangles), and every INTERIOR ear-clip diagonal ("chord" —
// as opposed to an original loop edge, which must stay untouched: it is
// shared with a pre-existing, un-refillable triangle outside the patch —
// detected via the `loopEdgeKeys` set built from the loop itself) gets a new
// midpoint vertex shared by the two ear-clip
// triangles on either side of it. This gives every new interior vertex (a
// centroid or a chord midpoint) a real, non-trivial neighbor set — chord
// midpoints in particular are adjacent to TWO centroids plus their 2 chord
// endpoints — worth Laplacian-averaging. `LAPLACE_ITERATIONS`/
// `LAPLACE_LAMBDA` below are fixed, documented constants (Jacobi-style
// simultaneous update — every iteration's new positions are computed from
// the PREVIOUS iteration's positions, never partially-updated ones, so the
// result never depends on interior-vertex iteration order). Boundary loop
// vertices are NEVER moved — they are shared with the rest of the mesh.
import type { IndexedMesh } from '../mesh/types.ts';
import { buildEdgeMap, type EdgeEntry } from '../intake/topology.ts';
import { countsOf } from '../intake/report.ts';
import {
  DEFAULT_MAX_BOUNDARY_EDGES,
  type FillSmallHolesOptions,
  type FillSmallHolesReport,
  type FillSmallHolesResult,
  type SkippedHole,
} from './types.ts';

const LAPLACE_ITERATIONS = 4;
const LAPLACE_LAMBDA = 0.5;
/** Below this squared length, a loop's best-fit-plane normal is treated as
 * degenerate (collinear/zero-area loop) — see `SkippedHoleReason.degenerate`
 * in types.ts. mm^4 units (normal components are mm^2 polygon-area-vector
 * terms, per Newell's method). */
const DEGENERATE_NORMAL_LENGTH_SQ_THRESHOLD = 1e-18;
const CONVEXITY_EPS = 1e-12;

type Vec3 = readonly [number, number, number];

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}
function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

function vertexPos(mesh: IndexedMesh, v: number): Vec3 {
  return [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!];
}

/** Finds every boundary loop in `mesh` (see module doc's "walk direction"
 * section). A boundary vertex touched by more than one boundary edge pair
 * (a non-manifold boundary — e.g. two separate holes pinched at one vertex)
 * breaks the simple next-vertex chain this function relies on; such a chain
 * is defensively abandoned (not returned as a loop) rather than looping
 * forever or silently producing a wrong triangulation — an acceptable,
 * documented gap for Phase 1's synthetic/real-scan boundary shapes, which do
 * not produce pinched boundaries in practice. */
function findBoundaryLoops(mesh: IndexedMesh, edges: Map<number, EdgeEntry>): number[][] {
  const holeNext = new Map<number, number>();
  for (const entry of edges.values()) {
    if (entry.incidences.length !== 1) continue;
    const inc = entry.incidences[0]!;
    const [from, to] = inc.directed ? [entry.a, entry.b] : [entry.b, entry.a];
    if (holeNext.has(to)) {
      // Non-manifold boundary vertex (`to` already has an outgoing hole-walk
      // edge) — mark unusable by removing any chance of a clean cycle
      // through it; see doc above.
      holeNext.delete(to);
      holeNext.set(to, Number.NaN);
      continue;
    }
    holeNext.set(to, from);
  }

  const visited = new Set<number>();
  const loops: number[][] = [];
  const maxSteps = holeNext.size + 1;

  for (const start of holeNext.keys()) {
    if (visited.has(start)) continue;
    const loop: number[] = [start];
    visited.add(start);
    let current = holeNext.get(start)!;
    let steps = 0;
    let ok = true;
    while (current !== start) {
      if (Number.isNaN(current) || visited.has(current) || steps > maxSteps) {
        ok = false;
        break;
      }
      loop.push(current);
      visited.add(current);
      const nextValue = holeNext.get(current);
      if (nextValue === undefined) {
        ok = false;
        break;
      }
      current = nextValue;
      steps++;
    }
    if (ok && loop.length >= 3) {
      loops.push(loop);
    }
  }
  return loops;
}

/** Newell's method: a polygon normal (proportional to signed area, valid
 * even for a non-planar loop) plus the resulting planar-polygon area
 * estimate (`0.5 * |normal|`). See module doc's ear-clipping section for why
 * this is only an ESTIMATE for non-planar loops. */
function loopNormalAndArea(mesh: IndexedMesh, loop: readonly number[]): { normal: Vec3; areaMm2: number } {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = vertexPos(mesh, loop[i]!);
    const b = vertexPos(mesh, loop[(i + 1) % loop.length]!);
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const normal: Vec3 = [nx, ny, nz];
  return { normal, areaMm2: 0.5 * length(normal) };
}

function loopCentroid(mesh: IndexedMesh, loop: readonly number[]): Vec3 {
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const v of loop) {
    const p = vertexPos(mesh, v);
    sx += p[0];
    sy += p[1];
    sz += p[2];
  }
  return [sx / loop.length, sy / loop.length, sz / loop.length];
}

/** Right-handed (u, v, normal) basis: `u` is an arbitrary unit vector
 * perpendicular to `normal` (Gram-Schmidt off a non-parallel axis), `v =
 * normalize(cross(normal, u))` so `u x v === normal` — see module doc for
 * why this orientation makes a CCW-around-`normal` 3D loop project to a CCW
 * 2D polygon in (u, v) coordinates. */
function orthonormalBasis(normal: Vec3): { u: Vec3; v: Vec3 } {
  const n = normalize(normal);
  const axis: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(sub(axis, [n[0] * dot(axis, n), n[1] * dot(axis, n), n[2] * dot(axis, n)]));
  const v = normalize(cross(n, u));
  return { u, v };
}

function project2D(mesh: IndexedMesh, loop: readonly number[], centroid: Vec3, u: Vec3, v: Vec3): [number, number][] {
  return loop.map((vertex) => {
    const rel = sub(vertexPos(mesh, vertex), centroid);
    return [dot(rel, u), dot(rel, v)] as [number, number];
  });
}

function cross2D(o: [number, number], a: [number, number], b: [number, number]): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function pointInTriangle2D(
  p: [number, number],
  a: [number, number],
  b: [number, number],
  c: [number, number],
): boolean {
  const d1 = cross2D(a, b, p);
  const d2 = cross2D(b, c, p);
  const d3 = cross2D(c, a, p);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * Ear-clips a simple, CCW-oriented 2D polygon (see module doc). Returns
 * triangles as LOCAL indices into `points` (0..points.length-1). Falls back
 * to plain fan triangulation from vertex 0 if the ear test ever stalls
 * (should only happen for a self-intersecting-after-projection polygon —
 * see module doc's non-planar-loop limitation) so this always terminates
 * with a full triangulation rather than leaving a partial hole.
 */
function earClip2D(points: readonly [number, number][]): [number, number, number][] {
  const n = points.length;
  let remaining = Array.from({ length: n }, (_, i) => i);
  const triangles: [number, number, number][] = [];
  let guard = 0;
  const guardLimit = n * n + 8;

  while (remaining.length > 3 && guard < guardLimit) {
    guard++;
    let clipped = false;
    for (let i = 0; i < remaining.length; i++) {
      const iPrev = remaining[(i - 1 + remaining.length) % remaining.length]!;
      const iCur = remaining[i]!;
      const iNext = remaining[(i + 1) % remaining.length]!;
      const pPrev = points[iPrev]!;
      const pCur = points[iCur]!;
      const pNext = points[iNext]!;
      if (cross2D(pPrev, pCur, pNext) <= CONVEXITY_EPS) continue; // reflex or degenerate — not a valid ear
      let containsOther = false;
      for (const j of remaining) {
        if (j === iPrev || j === iCur || j === iNext) continue;
        if (pointInTriangle2D(points[j]!, pPrev, pCur, pNext)) {
          containsOther = true;
          break;
        }
      }
      if (containsOther) continue;
      triangles.push([iPrev, iCur, iNext]);
      remaining = remaining.filter((idx) => idx !== iCur);
      clipped = true;
      break;
    }
    if (!clipped) break; // stalled — fall through to the fan fallback below
  }

  if (remaining.length === 3) {
    triangles.push([remaining[0]!, remaining[1]!, remaining[2]!]);
  } else if (remaining.length > 3) {
    for (let i = 1; i < remaining.length - 1; i++) {
      triangles.push([remaining[0]!, remaining[i]!, remaining[i + 1]!]);
    }
  }
  return triangles;
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a},${b}` : `${b},${a}`;
}

export function fillSmallHoles(mesh: IndexedMesh, options: FillSmallHolesOptions = {}): FillSmallHolesResult {
  const maxBoundaryEdges = options.maxBoundaryEdges ?? DEFAULT_MAX_BOUNDARY_EDGES;
  const maxAreaMm2 = options.maxAreaMm2 ?? null;

  const edges = buildEdgeMap(mesh);
  const loops = findBoundaryLoops(mesh, edges);

  const positions: number[] = Array.from(mesh.positions);
  const indices: number[] = Array.from(mesh.indices);
  let nextVertexIndex = positions.length / 3;

  function addVertex(p: Vec3): number {
    positions.push(p[0], p[1], p[2]);
    return nextVertexIndex++;
  }
  function getPos(v: number): Vec3 {
    return [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];
  }
  function setPos(v: number, p: Vec3): void {
    positions[v * 3] = p[0];
    positions[v * 3 + 1] = p[1];
    positions[v * 3 + 2] = p[2];
  }

  const loopsSkipped: SkippedHole[] = [];
  let loopsFilled = 0;
  let newVertexCount = 0;
  let newTriangleCount = 0;

  // Interior (relaxable) vertices introduced by refinement, across every
  // loop filled this call — Jacobi Laplacian relax runs once, at the end,
  // over the union (cheaper than per-loop, and loops never share interior
  // vertices with each other so the result is identical either way).
  const interiorNeighbors = new Map<number, Set<number>>();
  function addInteriorEdge(a: number, b: number, interiorSet: Set<number>): void {
    if (interiorSet.has(a)) {
      let set = interiorNeighbors.get(a);
      if (!set) {
        set = new Set();
        interiorNeighbors.set(a, set);
      }
      set.add(b);
    }
    if (interiorSet.has(b)) {
      let set = interiorNeighbors.get(b);
      if (!set) {
        set = new Set();
        interiorNeighbors.set(b, set);
      }
      set.add(a);
    }
  }

  for (const loop of loops) {
    const boundaryEdgeCount = loop.length;
    const { normal, areaMm2 } = loopNormalAndArea(mesh, loop);

    if (dot(normal, normal) < DEGENERATE_NORMAL_LENGTH_SQ_THRESHOLD) {
      loopsSkipped.push({ boundaryEdgeCount, areaMm2, reason: 'degenerate', sampleVertexIndex: loop[0]! });
      continue;
    }
    if (boundaryEdgeCount > maxBoundaryEdges) {
      loopsSkipped.push({ boundaryEdgeCount, areaMm2, reason: 'tooManyEdges', sampleVertexIndex: loop[0]! });
      continue;
    }
    if (maxAreaMm2 !== null && areaMm2 > maxAreaMm2) {
      loopsSkipped.push({ boundaryEdgeCount, areaMm2, reason: 'tooLargeArea', sampleVertexIndex: loop[0]! });
      continue;
    }

    const centroid = loopCentroid(mesh, loop);
    const { u, v } = orthonormalBasis(normal);
    const points2D = project2D(mesh, loop, centroid, u, v);
    const earTriangles = earClip2D(points2D); // local indices into `loop`

    const loopEdgeKeys = new Set<string>();
    for (let i = 0; i < loop.length; i++) {
      loopEdgeKeys.add(edgeKey(loop[i]!, loop[(i + 1) % loop.length]!));
    }
    const chordMidpoints = new Map<string, number>();
    const thisLoopInterior = new Set<number>();

    function getChordMidpoint(gi: number, gj: number): number {
      const key = edgeKey(gi, gj);
      let mid = chordMidpoints.get(key);
      if (mid === undefined) {
        const pi = getPos(gi);
        const pj = getPos(gj);
        mid = addVertex([(pi[0] + pj[0]) / 2, (pi[1] + pj[1]) / 2, (pi[2] + pj[2]) / 2]);
        chordMidpoints.set(key, mid);
        thisLoopInterior.add(mid);
        newVertexCount++;
      }
      return mid;
    }

    for (const [li, lj, lk] of earTriangles) {
      const gi = loop[li]!;
      const gj = loop[lj]!;
      const gk = loop[lk]!;
      const pi = getPos(gi);
      const pj = getPos(gj);
      const pk = getPos(gk);
      const centroidVertex = addVertex([(pi[0] + pj[0] + pk[0]) / 3, (pi[1] + pj[1] + pk[1]) / 3, (pi[2] + pj[2] + pk[2]) / 3]);
      thisLoopInterior.add(centroidVertex);
      newVertexCount++;

      const perimeter: number[] = [gi];
      if (!loopEdgeKeys.has(edgeKey(gi, gj))) perimeter.push(getChordMidpoint(gi, gj));
      perimeter.push(gj);
      if (!loopEdgeKeys.has(edgeKey(gj, gk))) perimeter.push(getChordMidpoint(gj, gk));
      perimeter.push(gk);
      if (!loopEdgeKeys.has(edgeKey(gk, gi))) perimeter.push(getChordMidpoint(gk, gi));

      // Fan sub-triangles (centroid, perimeter[s], perimeter[s+1]) — see
      // module doc's "Local Laplacian relax" section for why this preserves
      // manifoldness (every rim edge either reuses an untouched original
      // loop edge, shared with exactly one pre-existing outside triangle, or
      // a fresh half-chord shared by exactly the two ear triangles flanking
      // it; every spoke is shared by exactly the two sub-triangles flanking
      // that perimeter vertex within this same fan).
      for (let s = 0; s < perimeter.length; s++) {
        const p = perimeter[s]!;
        const q = perimeter[(s + 1) % perimeter.length]!;
        indices.push(centroidVertex, p, q);
        newTriangleCount++;
        // Interior adjacency for relax: the spoke (centroidVertex, p), the
        // spoke (centroidVertex, q), and the rim edge (p, q) — recorded
        // against `thisLoopInterior` so only genuinely-new (centroid /
        // chord-midpoint) vertices ever get an entry (boundary loop
        // vertices are excluded, matching "boundary ring stays fixed").
        addInteriorEdge(centroidVertex, p, thisLoopInterior);
        addInteriorEdge(centroidVertex, q, thisLoopInterior);
        addInteriorEdge(p, q, thisLoopInterior);
      }
    }

    loopsFilled++;
  }

  // Laplacian relax: Jacobi-style simultaneous update over every interior
  // vertex introduced above, `LAPLACE_ITERATIONS` passes at blend factor
  // `LAPLACE_LAMBDA` — see module doc. Boundary loop vertices never appear
  // as keys in `interiorNeighbors` (addInteriorEdge only records entries for
  // vertices in a loop's `thisLoopInterior` set), so they are structurally
  // impossible to move here.
  const interiorIds = [...interiorNeighbors.keys()];
  for (let iter = 0; iter < LAPLACE_ITERATIONS; iter++) {
    const updated: Array<[number, Vec3]> = [];
    for (const id of interiorIds) {
      const neighbors = interiorNeighbors.get(id)!;
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (const n of neighbors) {
        const p = getPos(n);
        sx += p[0];
        sy += p[1];
        sz += p[2];
      }
      const avg: Vec3 = [sx / neighbors.size, sy / neighbors.size, sz / neighbors.size];
      const cur = getPos(id);
      updated.push([
        id,
        [
          cur[0] + LAPLACE_LAMBDA * (avg[0] - cur[0]),
          cur[1] + LAPLACE_LAMBDA * (avg[1] - cur[1]),
          cur[2] + LAPLACE_LAMBDA * (avg[2] - cur[2]),
        ],
      ]);
    }
    for (const [id, p] of updated) setPos(id, p);
  }

  const newMesh: IndexedMesh = {
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
  };

  const report: FillSmallHolesReport = {
    maxBoundaryEdges,
    maxAreaMm2,
    loopsFound: loops.length,
    loopsFilled,
    loopsSkipped,
    newVertexCount,
    newTriangleCount,
    before: countsOf(mesh),
    after: countsOf(newMesh),
  };

  return { mesh: newMesh, report };
}
