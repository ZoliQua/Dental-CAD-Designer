// packages/kernel/src/halfedge/build.ts
//
// `buildHalfedge(mesh)`: builds a `HalfedgeMesh` overlay (types.ts) over an
// `IndexedMesh` — typed-array storage throughout (no per-edge objects, no
// string keys), per this task's brief (docs/plans/phase-2-kernel-core.md
// Task 2 item 1).
//
// ## Construction algorithm
//
// 1. `next`/`vertex`/`face` are filled directly from the fixed
//    triangle-corner grouping (see types.ts's "Layout" doc) — O(faceCount),
//    no adjacency needed yet.
// 2. `twin` pairing: every halfedge's directed edge (origin -> destination)
//    is bucketed by its UNDIRECTED edge key (`edgeKey`, ../mesh/edgeKey.ts —
//    the same integer-keyed scheme this task's intake rebuild uses, for the
//    same reason: no string allocation/hashing per edge at multi-million-
//    triangle scale). A bucket of size 1 is a boundary edge (`twin` stays
//    `-1`, its default). A bucket of size 2 whose two halfedges run in
//    OPPOSITE directions (different origin vertices) is an ordinary
//    manifold-interior edge — they become each other's twin. Any other
//    bucket shape (size > 2, or size 2 running the SAME direction) cannot
//    be represented by a halfedge structure at all — see
//    `NonManifoldEdgeError`'s doc — and `buildHalfedge` REJECTS the whole
//    mesh rather than guessing a pairing (this task's brief, item 4: "callers
//    repair first — repair ops exist").
// 3. `vertexHalfedge` anchors: see types.ts's doc on why a boundary vertex's
//    anchor is specifically its own boundary-outgoing halfedge (not just any
//    outgoing one) — this is what makes `forEachOutgoingHalfedge`'s
//    single-direction walk (iterate.ts) complete for boundary vertices. Two
//    passes: the first assigns any outgoing halfedge as a provisional
//    anchor; the second overwrites it with a boundary halfedge wherever one
//    exists. Iteration order is always `he = 0..halfedgeCount-1` (input-
//    determined), so the result is fully deterministic (CLAUDE.md invariant
//    2) regardless of `Map` iteration order elsewhere in this function.
//
// ## Complexity
//
// O(faceCount) time and space (a handful of typed arrays sized to
// `halfedgeCount = faceCount * 3`, plus one `Map<number, number[]>` no
// larger than the edge count, ~1.5 * faceCount for a closed manifold) — see
// this task's perf evidence (test/golden/halfedge-intake.perf.test.ts) for
// measured numbers at the 2.5M/5M-triangle scale.
import type { IndexedMesh } from '../mesh/types.ts';
import { assertSafeVertexCountForEdgeKey, edgeKey } from '../mesh/edgeKey.ts';
import type { HalfedgeMesh } from './types.ts';

/** Given any halfedge in a triangle's fixed 3-cycle, the PREVIOUS halfedge
 * in that same face loop — the arithmetic inverse of `next` (types.ts:
 * `next[he] = floor(he/3)*3 + (he%3+1)%3`). Pure/allocation-free; not
 * stored as an array (unlike `next`) because every face is a triangle
 * (fixed valence 3, see types.ts's "Layout" doc), so it is always exactly
 * this one arithmetic expression away — storing it would be a redundant
 * `halfedgeCount`-sized array with no information `next` doesn't already
 * carry. Used by this module's one-ring circulators (iterate.ts) and by
 * `buildHalfedge` itself (indirectly, via the derivation in this module's
 * doc). */
export function prevHalfedge(he: number): number {
  const base = he - (he % 3);
  return base + (((he % 3) + 2) % 3);
}

/** One non-manifold edge `buildHalfedge` found — see `NonManifoldEdgeError`'s
 * doc for what each `reason` means. */
export interface NonManifoldEdgeInfo {
  /** Lower vertex index of the undirected edge (a < b). */
  a: number;
  /** Higher vertex index of the undirected edge. */
  b: number;
  /** Number of triangles incident on this edge (always >= 2 — a `reason:
   * 'degree'` entry has degree > 2; a `reason: 'orientation'` entry always
   * has degree exactly 2, reported for completeness). */
  degree: number;
  /** `'degree'`: the edge is shared by more than 2 triangles — the classic
   * non-manifold-edge case (this task's brief's `findNonManifoldVertices`
   * is a DIFFERENT, narrower check — bowtie VERTICES, where every
   * individual edge still has degree <= 2 — see that function's doc).
   * `'orientation'`: the edge is shared by EXACTLY 2 triangles, but both
   * traverse it in the SAME direction (both `a -> b` or both `b -> a`)
   * rather than opposite directions. A halfedge twin pair requires one
   * halfedge per direction — this is exactly as unrepresentable as a
   * degree-3 edge, and it always indicates the two triangles are wound
   * INCONSISTENTLY relative to each other (see intake/orient.ts, whose
   * `orientNormalsConsistently` is the standard fix upstream of
   * `buildHalfedge` in the intake pipeline). */
  reason: 'degree' | 'orientation';
}

/**
 * Thrown by `buildHalfedge` when `mesh` has one or more non-manifold edges
 * — a halfedge structure is only defined for an (locally) oriented manifold
 * surface, so this is a hard rejection, not a best-effort result (contrast
 * intake/orient.ts's `orientationAmbiguous` flag, which reports and
 * continues). Per this task's brief: "callers repair first" — see
 * `repair/splitNonManifoldEdges.ts` (degree case) and
 * `intake/orientNormalsConsistently` (orientation case) for the fixes.
 * `findNonManifoldVertices` (this file) additionally detects bowtie
 * VERTICES, a separate condition `buildHalfedge` does NOT reject (every
 * edge can be perfectly manifold at degree <= 2 while a vertex is still a
 * bowtie — see that function's doc); fixing bowties is Task 11, out of
 * scope here.
 */
export class NonManifoldEdgeError extends Error {
  /** Every offending edge found (not just the first) — sorted by `(a, b)`
   * ascending for a deterministic error regardless of the internal `Map`'s
   * iteration order. */
  readonly edges: readonly NonManifoldEdgeInfo[];

  constructor(edges: readonly NonManifoldEdgeInfo[]) {
    const first = edges[0]!;
    super(
      `buildHalfedge: mesh has ${edges.length} non-manifold edge(s) — halfedge topology requires every edge ` +
        `shared by exactly 2 triangles with opposite winding (or exactly 1, for a boundary edge). ` +
        `First offending edge: (${first.a}, ${first.b}), degree ${first.degree}, reason "${first.reason}".`,
    );
    this.name = 'NonManifoldEdgeError';
    this.edges = edges;
  }
}

/**
 * Builds a `HalfedgeMesh` overlay over `mesh` — see this module's top-of-file
 * doc for the construction algorithm and types.ts for the resulting
 * structure's exact layout/conventions.
 *
 * @throws {TypeError} if `mesh.indices.length` is not a multiple of 3.
 * @throws {RangeError} if `mesh.positions.length / 3` exceeds the safe
 * integer edge-key bound (`../mesh/edgeKey.ts`) — not expected at this
 * project's ~5M-triangle NFR ceiling, see that module's doc.
 * @throws {NonManifoldEdgeError} if `mesh` has any non-manifold edge (degree
 * > 2, or degree 2 with inconsistent winding) — see that error's doc.
 */
export function buildHalfedge(mesh: IndexedMesh): HalfedgeMesh {
  const faceCount = mesh.indices.length / 3;
  if (!Number.isInteger(faceCount)) {
    throw new TypeError('buildHalfedge: mesh.indices.length must be a multiple of 3');
  }
  const vertexCount = mesh.positions.length / 3;
  assertSafeVertexCountForEdgeKey(vertexCount, 'buildHalfedge');
  const halfedgeCount = faceCount * 3;

  const next = new Uint32Array(halfedgeCount);
  const vertex = new Uint32Array(halfedgeCount);
  const face = new Uint32Array(halfedgeCount);
  const twin = new Int32Array(halfedgeCount).fill(-1);

  for (let f = 0; f < faceCount; f++) {
    const base = f * 3;
    for (let k = 0; k < 3; k++) {
      const he = base + k;
      next[he] = base + ((k + 1) % 3);
      vertex[he] = mesh.indices[he]!;
      face[he] = f;
    }
  }

  // edgeKey -> halfedge indices sharing that undirected edge (see this
  // module's doc). Typically length 1 (boundary) or 2 (manifold interior);
  // only grows past 2 for a genuinely non-manifold edge.
  //
  // Why a `Map<number, number[]>` here is acceptable today, despite being
  // structurally the same "one small array per key, built via `.push()`"
  // pattern that OOM'd `intake/orient.ts`'s `buildDegreeTwoAdjacency` at 5M
  // triangles (Phase 2 Task 2 report, .superpowers/sdd/p2-task-2-report.md
  // §3): this allocates roughly one bucket per undirected edge — ~7.5M small
  // arrays at the 5M-triangle NFR ceiling (~1.5 * faceCount for a closed
  // manifold) — a materially smaller object count than `orient.ts`'s prior
  // ~5M arrays PLUS ~15M pushed `Neighbor` objects, and this was MEASURED,
  // not just assumed to be fine by comparison: the combined intake +
  // `buildHalfedge` perf run (test/golden/halfedge-intake.perf.test.ts, same
  // report §4) completed `buildHalfedge` alone in 4.52 s at 5M triangles,
  // within an 8 GB heap (~3.73 GB total RSS for the whole pipeline) — no
  // cliff observed, unlike `orient.ts`'s. If a future task's memory budget
  // gets tighter (e.g. Tasks 3-11 calling `buildHalfedge` repeatedly rather
  // than once per pipeline run), the known follow-up is the same CSR
  // (compressed-sparse-row) typed-array conversion `orient.ts` already went
  // through: two passes over `mesh.indices` — one to count halfedges per
  // edge key, one to fill fixed-size `Uint32Array` slots — instead of a
  // `Map` of pushed arrays.
  const edgeHalfedges = new Map<number, number[]>();
  for (let he = 0; he < halfedgeCount; he++) {
    const from = vertex[he]!;
    const to = vertex[next[he]!]!;
    const a = Math.min(from, to);
    const b = Math.max(from, to);
    const key = edgeKey(a, b, vertexCount);
    const bucket = edgeHalfedges.get(key);
    if (bucket) bucket.push(he);
    else edgeHalfedges.set(key, [he]);
  }

  const violations: NonManifoldEdgeInfo[] = [];
  for (const [key, bucket] of edgeHalfedges) {
    if (bucket.length === 1) continue; // boundary edge — twin stays -1.
    const a = Math.floor(key / vertexCount);
    const b = key - a * vertexCount;
    if (bucket.length === 2) {
      const [he0, he1] = bucket as [number, number];
      if (vertex[he0]! === vertex[he1]!) {
        violations.push({ a, b, degree: 2, reason: 'orientation' });
        continue;
      }
      twin[he0] = he1;
      twin[he1] = he0;
      continue;
    }
    violations.push({ a, b, degree: bucket.length, reason: 'degree' });
  }

  if (violations.length > 0) {
    violations.sort((x, y) => x.a - y.a || x.b - y.b);
    throw new NonManifoldEdgeError(violations);
  }

  // vertexHalfedge anchors — see this module's top-of-file doc, step 3.
  const vertexHalfedge = new Int32Array(vertexCount).fill(-1);
  for (let he = 0; he < halfedgeCount; he++) {
    const v = vertex[he]!;
    if (vertexHalfedge[v] === -1) vertexHalfedge[v] = he;
  }
  for (let he = 0; he < halfedgeCount; he++) {
    if (twin[he] === -1) vertexHalfedge[vertex[he]!] = he;
  }

  return { mesh, vertexCount, faceCount, halfedgeCount, twin, next, vertex, face, vertexHalfedge };
}

/** One vertex `findNonManifoldVertices` flagged as a bowtie — see that
 * function's doc. */
export interface NonManifoldVertexReport {
  /** The bowtie vertex's index. */
  vertex: number;
  /** Number of mutually-disconnected triangle "fans" meeting at this vertex
   * (always >= 2 — a proper manifold vertex, closed or boundary, has
   * exactly 1). */
  fanCount: number;
}

/**
 * Detects BOWTIE vertices in `mesh`: a vertex where two (or more) otherwise-
 * manifold triangle fans meet ONLY at that single point, with no shared
 * edge connecting them — a form of non-manifoldness invisible to plain
 * edge-degree counting (every edge around a bowtie vertex can easily have
 * degree <= 2, so `intake/topology.ts#countEdgeDegrees` and this module's
 * own `buildHalfedge` twin-pairing both see nothing wrong). Detection only —
 * per this task's brief, FIXING bowtie vertices (splitting them into one
 * vertex per fan) is Task 11's job, not this function's.
 *
 * ## Algorithm
 *
 * For each vertex `v`, every incident triangle `(v, a, b)` contributes a
 * "link edge" `{a, b}` between two of `v`'s neighbor vertices (the triangle
 * corners other than `v`). A proper manifold vertex's link edges chain into
 * exactly ONE connected graph (a closed cycle for an interior vertex, an
 * open path for a boundary vertex); a bowtie vertex's link edges instead
 * form 2+ mutually disconnected components — one per "wing" of the bowtie.
 * This is computed with one small union-find PER VERTEX, scoped to that
 * vertex's own (typically ~4-8) neighbors via a local vertex-id -> slot
 * `Map` — deliberately not a single global structure, since two different
 * vertices' neighbor sets are unrelated and must never be cross-linked.
 * Degenerate triangles (a repeated vertex index — see intake/degenerate.ts)
 * are skipped: they contribute no meaningful link edge.
 *
 * This is independent of `buildHalfedge`: it works on the raw `IndexedMesh`
 * (not a `HalfedgeMesh`) and does not require the mesh to be edge-manifold
 * — a mesh can have both non-manifold edges AND bowtie vertices, and this
 * function still reports every bowtie it finds regardless.
 *
 * @errorBound None — this is an exact combinatorial check (no floating-point
 * comparison of any kind), so there is no tolerance/approximation to bound.
 */
export function findNonManifoldVertices(mesh: IndexedMesh): NonManifoldVertexReport[] {
  const triangleCount = mesh.indices.length / 3;

  // Per-vertex local union-find over "neighbor slots". Lazily created (most
  // vertices are touched by only a handful of triangles).
  const slotOf: Map<number, Map<number, number>> = new Map(); // vertex -> (neighborVertex -> local slot)
  const parent: Map<number, number[]> = new Map(); // vertex -> local parent array (union-find)

  function localSlot(v: number, neighbor: number): number {
    let slots = slotOf.get(v);
    if (!slots) {
      slots = new Map();
      slotOf.set(v, slots);
      parent.set(v, []);
    }
    let slot = slots.get(neighbor);
    if (slot === undefined) {
      const p = parent.get(v)!;
      slot = p.length;
      p.push(slot);
      slots.set(neighbor, slot);
    }
    return slot;
  }

  function find(v: number, x: number): number {
    const p = parent.get(v)!;
    let root = x;
    while (p[root] !== root) root = p[root]!;
    let cur = x;
    while (p[cur] !== root) {
      const nextCur = p[cur]!;
      p[cur] = root;
      cur = nextCur;
    }
    return root;
  }

  function union(v: number, x: number, y: number): void {
    const p = parent.get(v)!;
    const rx = find(v, x);
    const ry = find(v, y);
    if (rx !== ry) p[rx] = ry;
  }

  for (let t = 0; t < triangleCount; t++) {
    const base = t * 3;
    const a = mesh.indices[base]!;
    const b = mesh.indices[base + 1]!;
    const c = mesh.indices[base + 2]!;
    if (a === b || b === c || a === c) continue; // degenerate — no meaningful link edge.

    union(a, localSlot(a, b), localSlot(a, c));
    union(b, localSlot(b, c), localSlot(b, a));
    union(c, localSlot(c, a), localSlot(c, b));
  }

  const reports: NonManifoldVertexReport[] = [];
  for (const [v, p] of parent) {
    if (p.length === 0) continue;
    const roots = new Set<number>();
    for (let i = 0; i < p.length; i++) roots.add(find(v, i));
    if (roots.size > 1) reports.push({ vertex: v, fanCount: roots.size });
  }
  reports.sort((x, y) => x.vertex - y.vertex); // deterministic (Map iteration order is insertion order, but sort defensively)
  return reports;
}
