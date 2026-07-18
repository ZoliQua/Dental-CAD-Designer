// packages/kernel/src/repair/fillSmallHoles.ts
//
// Detects boundary loops (holes) small enough to trust (per
// `FillSmallHolesOptions`) and closes them: ear-clip triangulation using
// only the loop's existing boundary vertices, then a local refinement +
// curvature-continuity (thin-plate) fairing solve over the NEW interior
// vertices that refinement adds (Phase 2 Task 11 — see this file's
// `@approximation` doc below for the upgrade from Phase 1's plain Laplacian
// relax, now kept only as a rare fallback). Reuses intake/topology.ts's
// `buildEdgeMap` for boundary-edge detection — same edge-adjacency notion
// `MeshStats.boundaryEdgeCount` is defined against.
//
// @approximation (Phase 2 Task 11 upgrade — retires the Phase 1 plan-
// deviation note, docs/plans/phase-1-import-viewer.md's "Deviations (Phase
// 1)" section) After ear-clip refinement, this function solves a discrete
// thin-plate (cotan-weighted graph bi-Laplacian) fairing energy for the
// patch's new interior vertices, with the boundary ring FIXED and the
// surrounding mesh's one-ring context feeding the solve's curvature
// information — see curvatureFill.ts's module doc for the exact
// discretization and solver. This is STILL an approximation (a linearized
// energy over a fixed patch topology, not a true continuous PDE solve, and
// not exactly G1/G2 in the strict differential-geometry sense) — but it is
// a materially BETTER continuity class than Phase 1's fixed-lambda
// Laplacian relax (which ignored the surrounding surface's curvature
// entirely): fillSmallHoles.test.ts measures and asserts a seam dihedral-
// angle bound (target < 5 degrees, PLAN Phase 5's blend language) and
// reports the measured maximum. A rare, defensive fallback to the OLD
// fixed-lambda relax remains for a loop whose local patch+context
// neighborhood cannot be built as valid halfedge topology (see
// curvatureFill.ts's "Fallback" section) — `FillSmallHolesReport.
// curvatureFallbackLoopCount` surfaces whenever this fallback fires. QC
// gates in later phases treat a filled region like any other geometry (no
// special-casing), so this remains a documented, honest limitation rather
// than a silent one.
//
// ## Bowtie-adjacent context — loud refusal, not silent degrade (Fix batch)
//
// curvatureFill.ts's solve silently under-weights a Laplacian row whose
// BOUNDARY LOOP or CONTEXT vertex is itself a bowtie vertex (its one-ring
// within the local patch+context mesh is incomplete, but `buildHalfedge`
// does not reject it — see that file's former "Known, documented,
// out-of-scope limitation" note). Per this codebase's no-silent-degradation
// rule, that gap is now closed HERE, upstream of ever calling
// `solveCurvaturePatch`: `findNonManifoldVertices` runs once per call
// (cheap, purely combinatorial), and any loop whose boundary+context vertex
// set (`loopBoundaryAndContextVertexIds` below — the exact same node set
// curvatureFill.ts's local mesh builds) contains a bowtie vertex is
// REFUSED — same skip-and-report shape as `tooManyEdges`/`tooLargeArea`/
// `degenerate` above, reason `'bowtie-adjacent'`, naming the offending
// vertex id(s) (`SkippedHole.bowtieVertexIndices`) and pointing at
// `splitNonManifoldVertices.ts` as the fix (see types.ts's doc on that
// reason). Unaffected loops on the same mesh still fill normally.
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
// ## Refining the ear-clip patch with new interior vertices
//
// Ear-clipping alone only ever introduces triangles between EXISTING
// boundary-loop vertices — no new vertices, nothing for a fairing solve to
// move, and (more importantly) it can leave the patch faceted/flat relative
// to the surrounding curved surface. This function therefore refines the
// ear-clip result once: every ear-clip triangle gets a new centroid vertex
// (fan-split into 3 sub-triangles), and every INTERIOR ear-clip diagonal
// ("chord" — as opposed to an original loop edge, which must stay
// untouched: it is shared with a pre-existing, un-refillable triangle
// outside the patch — detected via the `loopEdgeKeys` set built from the
// loop itself) gets a new midpoint vertex shared by the two ear-clip
// triangles on either side of it. This gives every new interior vertex (a
// centroid or a chord midpoint) a real, non-trivial neighbor set for
// curvatureFill.ts's thin-plate solve (see that file for the DEFAULT path)
// or, on that solve's rare fallback, for `LAPLACE_ITERATIONS`/
// `LAPLACE_LAMBDA` below's plain Jacobi Laplacian relax (Phase 1's
// original algorithm, kept only as that fallback — see this file's
// `@approximation` doc above). Boundary loop vertices are NEVER moved —
// they are shared with the rest of the mesh.
import type { IndexedMesh } from '../mesh/types.ts';
import { buildEdgeMap, type EdgeEntry } from '../intake/topology.ts';
import { countsOf } from '../intake/report.ts';
import { findNonManifoldVertices } from '../halfedge/build.ts';
import { solveCurvaturePatch } from './curvatureFill.ts';
import {
  DEFAULT_MAX_BOUNDARY_EDGES,
  type FillSmallHolesOptions,
  type FillSmallHolesReport,
  type FillSmallHolesResult,
  type SkippedHole,
} from './types.ts';

/** Fixed-lambda Jacobi Laplacian relax constants — FALLBACK ONLY (see this
 * file's `@approximation` doc and curvatureFill.ts's "Fallback" section).
 * Jacobi-style simultaneous update: every iteration's new positions are
 * computed from the PREVIOUS iteration's positions, never partially-updated
 * ones, so the result never depends on interior-vertex iteration order. */
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

/** A loop's "boundary+context vertex set" — the loop's own boundary-loop
 * vertices, plus every corner of every ORIGINAL triangle incident to any of
 * them (the loop's one-ring "context" beyond the hole, per curvatureFill.ts's
 * module doc's CONTEXT definition). This is exactly the node set that
 * function's local patch+context mesh builds — computed here, before ANY
 * ear-clip/fan vertex exists, purely from `vertexTriangles` (built once,
 * shared across every loop this call processes) so the bowtie-adjacency
 * check below never has to build the local mesh just to ask the question. */
function loopBoundaryAndContextVertexIds(
  mesh: IndexedMesh,
  loop: readonly number[],
  vertexTriangles: ReadonlyMap<number, readonly number[]>,
): Set<number> {
  const ids = new Set<number>(loop);
  for (const v of loop) {
    const incident = vertexTriangles.get(v);
    if (!incident) continue;
    for (const t of incident) {
      const base = t * 3;
      ids.add(mesh.indices[base]!);
      ids.add(mesh.indices[base + 1]!);
      ids.add(mesh.indices[base + 2]!);
    }
  }
  return ids;
}

export function fillSmallHoles(mesh: IndexedMesh, options: FillSmallHolesOptions = {}): FillSmallHolesResult {
  const maxBoundaryEdges = options.maxBoundaryEdges ?? DEFAULT_MAX_BOUNDARY_EDGES;
  const maxAreaMm2 = options.maxAreaMm2 ?? null;

  const edges = buildEdgeMap(mesh);
  const loops = findBoundaryLoops(mesh, edges);

  // Bowtie-adjacent-context refusal (Fix batch, post-Task-11 — see
  // curvatureFill.ts's "Known, documented, out-of-scope limitation" section
  // and types.ts's `'bowtie-adjacent'` doc): a loop whose boundary+context
  // vertex set includes a bowtie vertex would silently under-weight that
  // vertex's Laplacian row in the curvature-continuity solve rather than
  // failing loudly — refused below instead, before ever reaching
  // `solveCurvaturePatch`. Run ONCE per call (O(triangle count), cheap —
  // `findNonManifoldVertices` is purely combinatorial), only when there is
  // at least one loop to check against it (a fully watertight mesh has
  // nothing to fill, so nothing to gate).
  const bowtieVertexIds = loops.length > 0 ? new Set(findNonManifoldVertices(mesh).map((b) => b.vertex)) : new Set<number>();

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
  let curvatureFallbackLoopCount = 0;

  // Original-mesh vertex -> incident ORIGINAL triangle indices, ascending
  // triangle-scan order — curvatureFill.ts's "context" (the surrounding
  // mesh's one-ring beyond each loop). Built ONCE (not per loop): O(triangle
  // count), shared read-only across every loop this call fills.
  const vertexTriangles = new Map<number, number[]>();
  {
    const triangleCount = mesh.indices.length / 3;
    for (let t = 0; t < triangleCount; t++) {
      const base = t * 3;
      for (let corner = 0; corner < 3; corner++) {
        const vid = mesh.indices[base + corner]!;
        let list = vertexTriangles.get(vid);
        if (!list) {
          list = [];
          vertexTriangles.set(vid, list);
        }
        list.push(t);
      }
    }
  }

  /** FALLBACK ONLY (curvatureFill.ts's solve failed for this one loop) —
   * Phase 1's plain Jacobi Laplacian relax, scoped to a single loop's
   * interior vertices. Behaviorally identical to running it once globally
   * across every loop (the Phase 1 shape): different loops never share
   * interior vertices, and each interior vertex's neighbor set here only
   * ever contains OTHER interior vertices from the SAME loop plus fixed
   * boundary-loop vertices, never anything from a different loop. */
  function laplacianRelaxFallback(interiorIds: readonly number[], neighborsOf: ReadonlyMap<number, ReadonlySet<number>>): void {
    for (let iter = 0; iter < LAPLACE_ITERATIONS; iter++) {
      const updated: Array<[number, Vec3]> = [];
      for (const id of interiorIds) {
        const neighbors = neighborsOf.get(id)!;
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
    if (bowtieVertexIds.size > 0) {
      const contextIds = loopBoundaryAndContextVertexIds(mesh, loop, vertexTriangles);
      const bowtieHits = [...bowtieVertexIds].filter((v) => contextIds.has(v)).sort((a, b) => a - b);
      if (bowtieHits.length > 0) {
        loopsSkipped.push({
          boundaryEdgeCount,
          areaMm2,
          reason: 'bowtie-adjacent',
          sampleVertexIndex: loop[0]!,
          bowtieVertexIndices: bowtieHits,
        });
        continue;
      }
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
    // This loop's own interior adjacency (fallback-relax-only, see
    // `laplacianRelaxFallback`) and its own fan triangles (curvatureFill.ts
    // input) — both SCOPED TO THIS LOOP, not shared across loops (loops
    // never share interior vertices — see this file's module doc).
    const loopInteriorNeighbors = new Map<number, Set<number>>();
    const loopFanTriangles: [number, number, number][] = [];
    function addInteriorEdge(a: number, b: number, interiorSet: Set<number>): void {
      if (interiorSet.has(a)) {
        let set = loopInteriorNeighbors.get(a);
        if (!set) {
          set = new Set();
          loopInteriorNeighbors.set(a, set);
        }
        set.add(b);
      }
      if (interiorSet.has(b)) {
        let set = loopInteriorNeighbors.get(b);
        if (!set) {
          set = new Set();
          loopInteriorNeighbors.set(b, set);
        }
        set.add(a);
      }
    }

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
      // module doc's "Refining the ear-clip patch" section for why this
      // preserves manifoldness (every rim edge either reuses an untouched
      // original loop edge, shared with exactly one pre-existing outside
      // triangle, or a fresh half-chord shared by exactly the two ear
      // triangles flanking it; every spoke is shared by exactly the two
      // sub-triangles flanking that perimeter vertex within this same fan).
      for (let s = 0; s < perimeter.length; s++) {
        const p = perimeter[s]!;
        const q = perimeter[(s + 1) % perimeter.length]!;
        indices.push(centroidVertex, p, q);
        loopFanTriangles.push([centroidVertex, p, q]);
        newTriangleCount++;
        // Interior adjacency for the FALLBACK relax only: the spoke
        // (centroidVertex, p), the spoke (centroidVertex, q), and the rim
        // edge (p, q) — recorded against `thisLoopInterior` so only
        // genuinely-new (centroid / chord-midpoint) vertices ever get an
        // entry (boundary loop vertices are excluded, matching "boundary
        // ring stays fixed").
        addInteriorEdge(centroidVertex, p, thisLoopInterior);
        addInteriorEdge(centroidVertex, q, thisLoopInterior);
        addInteriorEdge(p, q, thisLoopInterior);
      }
    }

    // Curvature-continuity solve (DEFAULT path — see this file's
    // `@approximation` doc and curvatureFill.ts's module doc): solves for
    // `thisLoopInterior`'s positions in place. `interiorIds` in CREATION
    // order (Set iteration order is insertion order) for deterministic
    // column ordering in the solve's linear system.
    const interiorIds = [...thisLoopInterior];
    const { solved } = solveCurvaturePatch({
      mesh,
      loop,
      patchTriangles: loopFanTriangles,
      interiorIds,
      getPos,
      setPos,
      vertexTriangles,
    });
    if (!solved) {
      curvatureFallbackLoopCount++;
      laplacianRelaxFallback(interiorIds, loopInteriorNeighbors);
    }

    loopsFilled++;
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
    curvatureFallbackLoopCount,
    before: countsOf(mesh),
    after: countsOf(newMesh),
  };

  return { mesh: newMesh, report };
}
