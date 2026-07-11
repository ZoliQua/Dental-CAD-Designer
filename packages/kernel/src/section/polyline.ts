// packages/kernel/src/section/polyline.ts
//
// `sectionMesh`: exact Float64 polyline extraction where a plane crosses a
// triangle mesh — the "outline" half of Task 10 (see this module's doc
// below for the "cap" half, which lives in ../boolean/manifold.ts's
// `sectionCap` since it goes through manifold-3d). This is a pure,
// synchronous, allocation-bounded function — no manifold-3d, no async, no
// Float32 anywhere — every coordinate this function ever produces is either
// (a) copied verbatim from an input mesh vertex, or (b) a single Float64
// linear interpolation between two input vertices. Consequently this
// function's own arithmetic introduces NO error beyond IEEE754 double
// rounding (~1e-16 relative) — any deviation a caller observes from an
// "ideal" analytic surface (e.g. a section of a tessellated sphere not
// landing exactly on the true sphere) is TESSELLATION error inherent in the
// input mesh, not something this algorithm adds. See polyline.test.ts's
// acceptance tests for the measured numbers and this reasoning applied to a
// concrete fixture.
//
// ## Algorithm: per-triangle candidate points, deterministic edge-graph
// stitching
//
// For each triangle (processed in increasing triangle-index order, for full
// determinism), classify each of its 3 vertices' signed distance to the
// plane (see plane.ts's `signedDistance`) as NEGATIVE, ON, or POSITIVE (see
// `ON_PLANE_EPSILON_MM` below for the threshold). Collect this triangle's
// section "candidate points":
//   - every ON vertex contributes ITSELF (its exact position, keyed by
//     vertex index — see `vertexKey`), and
//   - every edge whose two endpoints have STRICTLY opposite signs (one
//     NEGATIVE, one POSITIVE, neither ON) contributes a linearly
//     interpolated crossing point (keyed by the edge's unordered vertex
//     index pair — see `edgeKey`).
//
// Exhaustive case analysis (see polyline.test.ts + this module's design
// notes in the Task 10 report) shows this always yields exactly 0, 1, or 2
// candidates for a non-degenerate triangle (0/1 = plane touches the
// triangle without crossing its interior, skipped; 2 = a real crossing
// segment), with exactly one exception: a triangle with ALL THREE vertices
// ON the plane (coplanar with the cutting plane) would yield 3 candidates —
// explicitly skipped (see the `allOn` check below) as a documented
// degenerate case (a 2D patch lying exactly in the section plane
// contributes no 1D outline segment of its own; any real crossing at its
// boundary is still correctly picked up by the NON-coplanar triangles
// sharing those boundary edges).
//
// The key scheme above is the reason no epsilon-based point-WELDING is
// needed to stitch segments from different triangles into polylines:
// - Two triangles sharing an edge that the plane crosses (opposite signs on
//   both sides, since sign only depends on the vertex, not which triangle
//   is asking) independently compute the exact SAME interpolated point for
//   that edge (same two vertex positions, same signed distances -> same
//   `t` -> bit-identical result) and reference it under the exact same
//   `edgeKey`.
// - Two triangles sharing an ON vertex both reference it under the same
//   `vertexKey`.
// So the "same point" test across triangles is an EXACT string-key
// equality, not a distance/epsilon comparison — the standard technique for
// robust marching-triangles/marching-cubes contour stitching, and exactly
// what this task's guardrail calls "robust vertex-exactly-on-plane
// handling" in practice: an on-plane vertex is never independently
// re-computed or re-classified by different triangles, so it can never
// disagree with itself.
//
// Each triangle's (at most one) segment becomes one undirected edge in a
// graph over these keys; `stitchPolylines` below walks that graph
// deterministically (see its own doc) into closed loops and open chains.
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { MESH_WELD_EPSILON_MM } from '../intake/weld.ts';
import { normalizePlane, signedDistance, type Plane } from './plane.ts';

/**
 * On-plane classification threshold (mm) — a vertex within this distance of
 * the plane is treated as EXACTLY on it (see this module's doc). Reuses
 * `MESH_WELD_EPSILON_MM` (1e-6 mm / 1 nm) rather than inventing a new
 * constant: mesh intake already never leaves two DISTINCT vertices closer
 * together than this (../intake/weld.ts), so a vertex within it of the
 * plane is, for section purposes, indistinguishable from one sitting
 * exactly on it — any error from that choice (exact-vertex point vs. a
 * differently-classified near-degenerate edge interpolation) is bounded by
 * this same 1 nm, three orders of magnitude below this task's 1 µm
 * acceptance budget.
 */
export const ON_PLANE_EPSILON_MM = MESH_WELD_EPSILON_MM;

/** One extracted section polyline. `points` is a flat Float64 xyz array
 * (length = pointCount * 3); for a CLOSED polyline the first point is NOT
 * repeated at the end (the loop is implied — `points.length / 3` segments
 * connect point i to point (i+1) % pointCount). */
export interface SectionPolyline {
  points: Float64Array;
  closed: boolean;
}

export interface SectionMeshResult {
  polylines: SectionPolyline[];
}

type Candidate = { key: string; point: Vec3 };

// Plain numeric-literal "enum" (not a TS `enum`/`const enum` — this
// package builds under `isolatedModules`, see tsconfig.base.json, which
// disallows const enums) — -1/0/+1 double as the sign's own numeric
// meaning, which reads naturally at every comparison site below.
const SIGN_NEGATIVE = -1;
const SIGN_ON = 0;
const SIGN_POSITIVE = 1;
type Sign = typeof SIGN_NEGATIVE | typeof SIGN_ON | typeof SIGN_POSITIVE;

function classify(distance: number): Sign {
  if (distance > ON_PLANE_EPSILON_MM) return SIGN_POSITIVE;
  if (distance < -ON_PLANE_EPSILON_MM) return SIGN_NEGATIVE;
  return SIGN_ON;
}

function vertexKey(index: number): string {
  return `V${index}`;
}

function edgeKey(a: number, b: number): string {
  return a < b ? `E${a}_${b}` : `E${b}_${a}`;
}

function vec3At(positions: Float64Array, index: number): Vec3 {
  return [positions[index * 3]!, positions[index * 3 + 1]!, positions[index * 3 + 2]!];
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Per-triangle candidate extraction — see this module's top doc for the
 * case-analysis argument that this always returns 0, 1, or 2 candidates
 * (after the explicit all-on skip).
 */
function triangleCandidates(
  vi: readonly [number, number, number],
  v: readonly [Vec3, Vec3, Vec3],
  d: readonly [number, number, number],
  s: readonly [Sign, Sign, Sign],
): Candidate[] {
  if (s[0] === SIGN_ON && s[1] === SIGN_ON && s[2] === SIGN_ON) {
    return []; // Whole triangle coplanar with the cutting plane — see module doc.
  }

  const candidates: Candidate[] = [];
  for (let i = 0; i < 3; i++) {
    if (s[i] === SIGN_ON) {
      candidates.push({ key: vertexKey(vi[i]!), point: v[i]! });
    }
  }
  const edges: readonly (readonly [0 | 1 | 2, 0 | 1 | 2])[] = [
    [0, 1],
    [1, 2],
    [2, 0],
  ];
  for (const [a, b] of edges) {
    if (s[a] !== SIGN_ON && s[b] !== SIGN_ON && s[a] !== s[b]) {
      const t = d[a] / (d[a] - d[b]);
      candidates.push({ key: edgeKey(vi[a], vi[b]), point: lerp(v[a], v[b], t) });
    }
  }
  return candidates;
}

/**
 * Deterministically stitches a segment-soup edge graph (nodes = candidate
 * keys with a fixed Float64 point each, edges = one per triangle that
 * yielded exactly 2 candidates) into polylines.
 *
 * Traversal order (both here and in `sectionMesh`'s caller) only ever
 * depends on (a) increasing triangle index and (b) each node/edge's
 * FIRST-SEEN (insertion) order — `Map`/`Set` iteration in JS is
 * spec-guaranteed insertion order, so this never needs an explicit sort —
 * making the whole function a pure, deterministic function of the input
 * mesh + plane (this task's guardrail: "deterministic traversal order").
 *
 * Open chains (graph nodes of degree 1 — mesh-boundary crossings, see
 * `sectionMesh`'s open-mesh test) are walked first, starting from the
 * lowest-insertion-order unvisited degree-1 node; whatever remains after
 * that is closed loops (degree-2 everywhere) or, for pathological/
 * non-generic input where a plane passes through a branch point (a vertex
 * where more than 2 crossing segments meet — not expected for real scan or
 * synthetic fixture data, but not crashed on either), a deterministic
 * decomposition into simple paths through it (documented limitation, see
 * this module's top doc).
 */
function stitchPolylines(nodePoints: Map<string, Vec3>, adjacency: Map<string, string[]>): SectionPolyline[] {
  const visitedEdges = new Set<string>(); // canonical "keyA|keyB" (sorted) per consumed edge
  const polylines: SectionPolyline[] = [];

  function edgeVisitKey(a: string, b: string): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  function unvisitedNeighbor(key: string): string | null {
    for (const neighbor of adjacency.get(key) ?? []) {
      if (!visitedEdges.has(edgeVisitKey(key, neighbor))) {
        return neighbor;
      }
    }
    return null;
  }

  function walkFrom(start: string): { keys: string[]; closed: boolean } {
    const keys = [start];
    let current = start;
    for (;;) {
      const next = unvisitedNeighbor(current);
      if (next === null) {
        return { keys, closed: false };
      }
      visitedEdges.add(edgeVisitKey(current, next));
      if (next === start) {
        return { keys, closed: true }; // returned to the start: a closed loop
      }
      keys.push(next);
      current = next;
    }
  }

  function emit(keys: string[], closed: boolean): void {
    // A closed loop's walk above already stops BEFORE re-appending the
    // start point (it returns on detecting `next === start`), so `keys`
    // never repeats the first point — matching `SectionPolyline.points`'s
    // documented "first point not repeated" convention directly.
    if (keys.length < 2) return; // A single isolated point is not a polyline.
    const points = new Float64Array(keys.length * 3);
    for (let i = 0; i < keys.length; i++) {
      const p = nodePoints.get(keys[i]!)!;
      points[i * 3] = p[0];
      points[i * 3 + 1] = p[1];
      points[i * 3 + 2] = p[2];
    }
    polylines.push({ points, closed });
  }

  // Pass 1: open chains, rooted at degree-1 nodes (mesh-boundary crossings).
  for (const key of nodePoints.keys()) {
    const degree = (adjacency.get(key) ?? []).length;
    if (degree === 1 && unvisitedNeighbor(key) !== null) {
      const { keys, closed } = walkFrom(key);
      emit(keys, closed);
    }
  }
  // Pass 2: everything left over is closed loops (or, for a pathological
  // branch point, further simple paths/cycles through it — see doc above).
  for (const key of nodePoints.keys()) {
    while (unvisitedNeighbor(key) !== null) {
      const { keys, closed } = walkFrom(key);
      emit(keys, closed);
    }
  }

  return polylines;
}

/**
 * Extracts the ordered polyline(s) where `plane` crosses `mesh` — closed
 * loops for a plane crossing entirely through the mesh's interior, open
 * chains where a crossing runs into a mesh boundary edge (open/non-
 * watertight mesh). See this module's top doc for the exact-arithmetic
 * guarantee and the deterministic stitching algorithm.
 *
 * @throws {DegeneratePlaneError} if `plane.normal` is (near-)zero.
 */
export function sectionMesh(mesh: IndexedMesh, plane: Plane): SectionMeshResult {
  const basis = normalizePlane(plane);
  const { positions, indices } = mesh;
  const triangleCount = indices.length / 3;

  const nodePoints = new Map<string, Vec3>();
  const adjacency = new Map<string, string[]>();

  function addNode(key: string, point: Vec3): void {
    if (!nodePoints.has(key)) {
      nodePoints.set(key, point);
      adjacency.set(key, []);
    }
  }

  function addEdge(keyA: string, keyB: string): void {
    const neighborsA = adjacency.get(keyA)!;
    if (!neighborsA.includes(keyB)) {
      neighborsA.push(keyB);
      adjacency.get(keyB)!.push(keyA);
    }
  }

  for (let t = 0; t < triangleCount; t++) {
    const vi: [number, number, number] = [indices[t * 3]!, indices[t * 3 + 1]!, indices[t * 3 + 2]!];
    const v: [Vec3, Vec3, Vec3] = [
      vec3At(positions, vi[0]),
      vec3At(positions, vi[1]),
      vec3At(positions, vi[2]),
    ];
    const d: [number, number, number] = [
      signedDistance(basis, v[0]),
      signedDistance(basis, v[1]),
      signedDistance(basis, v[2]),
    ];
    const s: [Sign, Sign, Sign] = [classify(d[0]), classify(d[1]), classify(d[2])];

    const candidates = triangleCandidates(vi, v, d, s);
    if (candidates.length !== 2) {
      continue; // 0 or 1: no crossing segment for this triangle (see module doc).
    }
    const [a, b] = candidates;
    addNode(a!.key, a!.point);
    addNode(b!.key, b!.point);
    addEdge(a!.key, b!.key);
  }

  return { polylines: stitchPolylines(nodePoints, adjacency) };
}
