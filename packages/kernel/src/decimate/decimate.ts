// packages/kernel/src/decimate/decimate.ts
//
// QEM (quadric error metric) edge-collapse mesh decimation — Phase 2 Task
// 10, for RENDER LODs only. HARD INVARIANT (docs/plans/phase-2-kernel-core.md
// Global Constraints, this task's brief): the kernel's Float64 data of
// record is NEVER decimated implicitly — `decimateMesh` is a pure function
// that takes an `IndexedMesh` and returns a NEW, separate `IndexedMesh`; it
// never mutates its input, and nothing in this module (or the engine/worker
// wiring built on top of it) ever writes a decimated result back over a
// mesh's Float64 master buffers. Every kernel-golden-hash regression test
// (Task 8's suite) stays byte-identical across this task specifically
// because decimation is opt-in, output-only, and this module is never on
// any golden-mesh's compute path.
//
// ## Golden policy (documented decision, Task 10)
//
// Decimation deliberately has NO kernel-ops golden entry. The golden suite
// (test/golden, Task 8) exists to version-gate the numerical outputs of
// operations that feed the case DATA OF RECORD (journal replay, exports, QC
// gates); a decimated mesh is render-only display tooling — never
// journaled, never persisted, never exported, never an input to any other
// kernel op — so pinning its exact bytes behind the kernel-version-bump
// workflow would add ceremony (a mandatory version bump + changelog for any
// LOD quality tweak) with zero reproducibility payoff. Determinism is
// instead pinned by decimate.property.test.ts's double-run hash test (same
// inputs => bit-identical outputs, this project's invariant 2), which is
// the property that actually matters for a render copy.
//
// ## Algorithm (Garland-Heckbert QEM edge collapse — see quadric.ts)
//
// 1. `buildHalfedge(mesh)` — validates the input is edge-manifold (throws
//    `NonManifoldEdgeError` otherwise, same "callers repair first" policy as
//    every other kernel algorithm that needs a well-formed topology) and
//    identifies the ORIGINAL boundary vertices (see "Boundary policy" below).
// 2. Per-vertex QEM quadric = sum of `triangleQuadric` over every incident
//    (original) triangle.
// 3. A DYNAMIC mesh representation (mutable, unlike the static
//    `HalfedgeMesh` overlay — see "Dynamic mesh representation" below) is
//    built once, then repeatedly edge-collapsed.
// 4. Every non-boundary-adjacent edge is a candidate: its collapse cost is
//    the QEM error at the quadric-optimal merged position (`quadric.ts`'s
//    `solveOptimalPosition`, with a documented fallback chain — see
//    `optimalCollapsePosition` below), pushed into a priority queue.
// 5. Repeatedly pop the lowest-cost candidate; if it is stale (see "Lazy
//    invalidation") or fails the link condition (`linkCondition.ts`) or
//    exceeds `errorBoundMm`, skip it; otherwise perform the collapse, bump
//    the survivor's quadric/version, and re-push every edge in its new
//    one-ring. Stop when `targetTriangleCount` is reached or the queue
//    empties.
// 6. Compact surviving vertices/triangles into a fresh `IndexedMesh`.
//
// ## Determinism (CLAUDE.md / Global Constraints invariant)
//
// Every floating-point comparison here is over EXACT input data (no
// Math.random/Date.now anywhere in this file) and the priority queue
// (`../geodesic/heap.ts`'s `MinHeap`, reused as-is) breaks EXACT cost ties
// by a monotonically-increasing integer push id (lower id wins — see
// `tryPushEdge`), which is itself assigned in a fixed, input-order-derived
// sequence (initial edges enumerated by ascending halfedge index; re-pushes
// after a collapse enumerated by `Set` insertion order over a per-vertex
// adjacency built in a fixed triangle-array order) — so two runs over the
// same input always perform the identical sequence of collapses in the
// identical order, byte-for-byte (pinned by decimate.property.test.ts's
// determinism-hash test).
//
// ## Dynamic mesh representation
//
// `buildHalfedge`'s `HalfedgeMesh` (halfedge/types.ts) is a fixed,
// `faceCount`-sized set of typed arrays — it cannot represent a mesh
// mid-collapse (triangle count shrinking, vertices merging). This module
// therefore builds its OWN small mutable structure once, seeded from that
// initial halfedge topology:
//   - `vx`/`vy`/`vz` (Float64Array, vertexCount): live vertex positions.
//   - `vertexDeleted` (Uint8Array): `1` once a vertex has been collapsed away.
//   - `vertexVersion` (Uint32Array): bumped every time a SURVIVING vertex's
//     position/quadric changes (i.e. every collapse it survives) — the lazy
//     heap-invalidation mechanism (see below).
//   - `vertexTriangles` (`Set<number>[]`, one per vertex): triangle indices
//     currently incident to each vertex. May contain STALE (deleted)
//     entries after a collapse (cleaning them out eagerly costs more than
//     the `triDeleted` filter every consumer already applies) —
//     `linkCondition.ts`'s doc calls this out explicitly.
//   - `triVerts` (Uint32Array, `faceCount * 3`): mutable copy of
//     `mesh.indices` — a collapsed vertex's slot is overwritten with its
//     survivor's index in every remaining incident triangle.
//   - `triDeleted` (Uint8Array, faceCount): `1` once a triangle is removed
//     (either straddled the collapsed edge, or a duplicate would result —
//     see the collapse loop).
//
// ## Priority queue & lazy invalidation
//
// `MinHeap` (`../geodesic/heap.ts`) has no decrease-key operation, so this
// module uses the standard "push a fresh entry, lazily discard stale pops"
// technique: each `tryPushEdge(a, b)` call computes the candidate's cost
// AND validates the link condition ONCE, at push time, and records
// `(a, b, position, cost, versionA, versionB)` in `pushMeta` under a fresh
// monotonic id (`nextPushId`). At pop time, the entry is trusted AS-IS
// (cost, position, and the link-condition result are all reused without
// recomputation) IFF `vertexVersion[a] === versionA && vertexVersion[b] ===
// versionB` — i.e. neither endpoint has been touched (moved, requadric'd,
// or had its adjacency change) since this exact entry was pushed, which is
// precisely the condition under which nothing about the push-time
// computation could have gone stale. A version mismatch (or either endpoint
// already `vertexDeleted`) means some OTHER, more specific re-push already
// exists (or will exist) for the current true state of that vertex — see
// the collapse loop's "re-push every edge incident to the survivor" step —
// so a stale entry is simply discarded, never recomputed in place.
//
// ## Boundary policy (this task's brief: "boundary edges not collapsed, or
// constrained — document policy")
//
// This module NEVER collapses an edge with an ORIGINAL boundary vertex as
// either endpoint (`isFrozen`, computed once from the input `buildHalfedge`
// topology — any vertex touching a `twin === -1` halfedge). This is the
// simpler of the brief's two allowed policies ("boundary edges not
// collapsed") but applied slightly more conservatively — at the VERTEX
// level, not just the exact boundary edge — which is what makes it correct
// with NO further bookkeeping: since a frozen vertex is never a collapse
// endpoint, none of its incident triangles are ever remapped or deleted, so
// its ENTIRE star (and therefore the whole boundary loop's connectivity and
// every boundary vertex's position) is provably untouched from input to
// output, for the whole run — decimate.test.ts's boundary-patch fixture
// pins this exactly (before/after boundary-loop vertex sets and positions
// compared). A closed/watertight mesh (this module's primary target — every
// real dental-scan mesh reaching this point via the intake pipeline) has no
// boundary at all, so `isFrozen` is entirely empty and every edge is a
// candidate.
//
// @errorBound `errorBoundMm` (an OPTIONAL stopping criterion, alongside/
// instead of `targetTriangleCount`) bounds `sqrt(cost)` for every collapse
// this function actually ACCEPTS, where `cost` is the QEM cost
// (`quadric.ts`'s `quadricError`) at the chosen merged position: since a
// vertex's quadric is the sum, over every ORIGINAL triangle transitively
// merged into it, of that triangle's plane quadric, `sqrt(cost)` is the
// Euclidean distance from the merged position to AT LEAST the nearest of
// those planes (a sum of non-negative squared terms is `>= ` any one term)
// — a standard, well-known QEM heuristic bound (Garland & Heckbert 1997),
// not a hard worst-case guarantee against the true original SURFACE (which
// can be closer than any one supporting plane, e.g. near high curvature) —
// decimate.analytic.test.ts's sphere case independently verifies the actual
// Euclidean deviation via `bvh.closestPoint` against the true input mesh,
// which is the honest, non-heuristic check. `result.maxErrorMm` reports the
// actual realized maximum (`<= errorBoundMm` whenever that option is given
// — enforced by the loop below, never merely hoped for).
import type { IndexedMesh } from '../mesh/types.ts';
import { buildHalfedge } from '../halfedge/build.ts';
import { edgeKey } from '../mesh/edgeKey.ts';
import { MinHeap } from '../geodesic/heap.ts';
import {
  addQuadric,
  addQuadricInPlace,
  quadricError,
  solveOptimalPosition,
  triangleQuadric,
  zeroQuadric,
  type Quadric,
} from './quadric.ts';
import {
  collapseWouldDuplicateTriangle,
  edgeCollapseIsManifoldSafe,
  oneRingNeighbors,
} from './linkCondition.ts';

export interface DecimateMeshOptions {
  /** Stop once the live triangle count is `<= targetTriangleCount` (or the
   * candidate queue empties first — see this module's "Boundary policy" doc
   * for why reaching the exact target is not always possible). Non-negative
   * integer. At least one of `targetTriangleCount`/`errorBoundMm` is
   * required. */
  targetTriangleCount?: number;
  /** Stop accepting collapses once the next candidate's cost would exceed
   * this bound, mm — see this module's `@errorBound`. Finite, `> 0`. */
  errorBoundMm?: number;
}

export interface DecimateMeshResult {
  /** A fresh `IndexedMesh` — `mesh` (the input) is never mutated. */
  mesh: IndexedMesh;
  inputTriangleCount: number;
  outputTriangleCount: number;
  /** Number of edge collapses actually performed. */
  collapseCount: number;
  /** Max `sqrt(QEM cost)` actually accepted across every performed collapse,
   * mm — `0` if `collapseCount === 0`. See this module's `@errorBound`. */
  maxErrorMm: number;
}

/**
 * A resumable decimation run — see `beginDecimation`'s doc. Exists so a
 * caller with real time constraints (kernel-workers' `decimateMesh` job —
 * measured at several SECONDS on a real ~250k-triangle scan, well past this
 * project's "heavy compute in workers, with progress + cooperative
 * cancellation" threshold) can drive the SAME algorithm `decimateMesh`
 * itself runs in one blocking call, but in small chunks with a real
 * `await`/progress-report/cancellation-check point BETWEEN chunks — the
 * same "kernel exposes a steppable primitive, the job drives it" split
 * `offset/offsetMesh.ts` and `kernel-workers/jobs/offset.ts` already
 * establish for a similarly multi-second operation.
 */
export interface DecimationSession {
  /** Triangle count of the ORIGINAL (undecimated) input mesh — fixed for
   * the life of the session. */
  readonly inputTriangleCount: number;
  /** Current live (not-yet-deleted) triangle count — decreases
   * monotonically as `step` performs collapses. */
  liveTriangleCount(): number;
  /** `true` once no further collapse will ever be performed (the requested
   * `targetTriangleCount` has been reached, or the candidate queue is
   * exhausted — see decimate.ts's "Boundary policy" doc for why the queue
   * can empty before reaching an aggressive target). Once `true`, further
   * `step` calls are no-ops. */
  isDone(): boolean;
  /** Approximate, DISPLAY-ONLY progress estimate in `[0, 1]` — derived from
   * `liveTriangleCount` vs. `targetTriangleCount` when a target was given
   * (exact and monotonic), or from queue-exhaustion (`collapseCount /
   * (collapseCount + <current queue size>)`, necessarily approximate — the
   * queue holds stale entries too) when only `errorBoundMm` was given.
   * NEVER used for control flow inside this module — passing/reading it can
   * never affect `finish()`'s output, so it has no bearing on determinism.
   */
  progressFraction(): number;
  /** Performs up to `maxCollapses` more ACCEPTED collapses (fewer if
   * `isDone()` becomes `true` first, e.g. reaching the target mid-chunk).
   * Returns the number actually performed. Calling `step` with a larger
   * `maxCollapses` than remaining work is safe (just performs whatever is
   * left and returns that count) — `decimateMesh` itself calls
   * `step(Infinity)` once. */
  step(maxCollapses: number): number;
  /** Compacts the CURRENT state into the final `DecimateMeshResult` —
   * see decimate.ts's compaction doc. Safe to call at ANY point, not only
   * once `isDone()` — every already-applied collapse has fully updated the
   * dynamic state (`decimateMesh`'s "Dynamic mesh representation" doc), so
   * the live state is always a validly-compactable mesh, letting a caller
   * with its own time budget stop early and still get a valid (just less
   * reduced) result. Idempotent: a second call returns the SAME cached
   * result object without recomputing. */
  finish(): DecimateMeshResult;
}

/** Candidate collapse position + cost — see this module's `@errorBound` doc
 * for what `cost` bounds. */
function optimalCollapsePosition(
  qa: Quadric,
  qb: Quadric,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): { pos: readonly [number, number, number]; cost: number } {
  const q = addQuadric(qa, qb);
  const solved = solveOptimalPosition(q);
  if (solved) {
    const cost = quadricError(q, solved[0], solved[1], solved[2]);
    if (Number.isFinite(cost)) {
      return { pos: solved, cost: Math.max(0, cost) };
    }
  }
  // Fallback chain (this task's guardrail: "fall back to midpoint/endpoints
  // when the 3x3 solve is singular"): the solve failed (singular quadric) or
  // produced a non-finite cost — evaluate the quadric at both ORIGINAL
  // endpoints and their MIDPOINT, and keep whichever of the three has the
  // lowest cost. This is a strict superset of "always use the midpoint" (it
  // can only do better) while staying exactly as cheap to compute (3 fixed
  // evaluations, no search).
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const mz = (az + bz) / 2;
  const candidates: ReadonlyArray<readonly [number, number, number]> = [
    [ax, ay, az],
    [bx, by, bz],
    [mx, my, mz],
  ];
  let best = candidates[0]!;
  let bestCost = quadricError(q, best[0], best[1], best[2]);
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i]!;
    const cost = quadricError(q, c[0], c[1], c[2]);
    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  }
  return { pos: best, cost: Math.max(0, bestCost) };
}

/**
 * QEM edge-collapse decimation of `mesh` to `options.targetTriangleCount`
 * and/or `options.errorBoundMm` — see this module's top-of-file doc for the
 * full algorithm, determinism argument, boundary policy, and `@errorBound`.
 * Pure: `mesh` is never mutated (see this module's top doc — the HARD
 * INVARIANT this task exists to uphold). Runs the WHOLE decimation in one
 * blocking call — `beginDecimation`/`DecimationSession` below is the
 * chunked equivalent kernel-workers' job uses for progress/cancellation.
 *
 * @throws {TypeError} if neither `targetTriangleCount` nor `errorBoundMm` is
 * given, or either is out of range.
 * @throws {NonManifoldEdgeError} (`../halfedge/build.ts`) if `mesh` is not
 * edge-manifold — repair first (see that error's doc for the fix modules).
 */
export function decimateMesh(mesh: IndexedMesh, options: DecimateMeshOptions): DecimateMeshResult {
  const session = beginDecimation(mesh, options);
  session.step(Number.POSITIVE_INFINITY);
  return session.finish();
}

/**
 * Sets up a resumable `DecimationSession` for `mesh`/`options` — everything
 * `decimateMesh` does BEFORE its main collapse loop (option validation,
 * `buildHalfedge` topology validation, the dynamic mesh representation, and
 * the initial candidate-edge enumeration — see decimate.ts's top-of-file
 * doc for all of it), stopping short of actually performing any collapses.
 * See `DecimationSession`'s doc for why this split exists.
 *
 * @throws {TypeError} if neither `targetTriangleCount` nor `errorBoundMm` is
 * given, or either is out of range.
 * @throws {NonManifoldEdgeError} (`../halfedge/build.ts`) if `mesh` is not
 * edge-manifold — repair first (see that error's doc for the fix modules).
 */
export function beginDecimation(mesh: IndexedMesh, options: DecimateMeshOptions): DecimationSession {
  const { targetTriangleCount, errorBoundMm } = options;
  if (targetTriangleCount === undefined && errorBoundMm === undefined) {
    throw new TypeError(
      'decimateMesh: at least one of options.targetTriangleCount/options.errorBoundMm must be given',
    );
  }
  if (
    targetTriangleCount !== undefined &&
    !(Number.isInteger(targetTriangleCount) && targetTriangleCount >= 0)
  ) {
    throw new TypeError(
      `decimateMesh: targetTriangleCount must be a non-negative integer, got ${targetTriangleCount}`,
    );
  }
  if (errorBoundMm !== undefined && !(Number.isFinite(errorBoundMm) && errorBoundMm > 0)) {
    throw new TypeError(`decimateMesh: errorBoundMm must be finite and > 0, got ${errorBoundMm}`);
  }

  const vertexCount = mesh.positions.length / 3;
  const faceCount = mesh.indices.length / 3;

  // Validates edge-manifoldness (throws NonManifoldEdgeError otherwise) and
  // gives us the ORIGINAL boundary halfedges for the "frozen vertex" policy.
  const hm = buildHalfedge(mesh);
  const isFrozen = new Uint8Array(vertexCount);
  for (let he = 0; he < hm.halfedgeCount; he++) {
    if (hm.twin[he] === -1) {
      isFrozen[hm.vertex[he]!] = 1;
      isFrozen[hm.vertex[hm.next[he]!]!] = 1;
    }
  }

  // --- Dynamic mesh representation (see this module's top doc). ---
  const vx = new Float64Array(vertexCount);
  const vy = new Float64Array(vertexCount);
  const vz = new Float64Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    vx[v] = mesh.positions[v * 3]!;
    vy[v] = mesh.positions[v * 3 + 1]!;
    vz[v] = mesh.positions[v * 3 + 2]!;
  }
  const vertexDeleted = new Uint8Array(vertexCount);
  const vertexVersion = new Uint32Array(vertexCount);
  const vertexTriangles: Set<number>[] = Array.from({ length: vertexCount }, () => new Set<number>());
  const triDeleted = new Uint8Array(faceCount);
  const triVerts = Uint32Array.from(mesh.indices);
  for (let t = 0; t < faceCount; t++) {
    vertexTriangles[triVerts[t * 3]!]!.add(t);
    vertexTriangles[triVerts[t * 3 + 1]!]!.add(t);
    vertexTriangles[triVerts[t * 3 + 2]!]!.add(t);
  }

  // Per-vertex quadric = sum of incident (original) triangle plane quadrics.
  const quadrics: Quadric[] = Array.from({ length: vertexCount }, zeroQuadric);
  for (let t = 0; t < faceCount; t++) {
    const a = triVerts[t * 3]!;
    const b = triVerts[t * 3 + 1]!;
    const c = triVerts[t * 3 + 2]!;
    const q = triangleQuadric(vx[a]!, vy[a]!, vz[a]!, vx[b]!, vy[b]!, vz[b]!, vx[c]!, vy[c]!, vz[c]!);
    addQuadricInPlace(quadrics[a]!, q);
    addQuadricInPlace(quadrics[b]!, q);
    addQuadricInPlace(quadrics[c]!, q);
  }

  // --- Priority queue with lazy invalidation (see this module's doc). ---
  const heap = new MinHeap();
  let nextPushId = 0;
  interface PushMeta {
    a: number;
    b: number;
    pos: readonly [number, number, number];
    cost: number;
    versionA: number;
    versionB: number;
  }
  const pushMeta = new Map<number, PushMeta>();

  function tryPushEdge(a: number, b: number): void {
    if (isFrozen[a] || isFrozen[b]) return;
    if (vertexDeleted[a] || vertexDeleted[b]) return;
    if (!edgeCollapseIsManifoldSafe(a, b, vertexTriangles, triVerts, triDeleted)) return;
    // `a` (the lower original index) is always `removed` and `b` always
    // `survivor` if this candidate is later accepted — see the collapse
    // loop below — so check duplication in that same, fixed direction.
    if (collapseWouldDuplicateTriangle(a, b, vertexTriangles, triVerts, triDeleted)) return;
    const { pos, cost } = optimalCollapsePosition(
      quadrics[a]!,
      quadrics[b]!,
      vx[a]!,
      vy[a]!,
      vz[a]!,
      vx[b]!,
      vy[b]!,
      vz[b]!,
    );
    const id = nextPushId++;
    pushMeta.set(id, { a, b, pos, cost, versionA: vertexVersion[a]!, versionB: vertexVersion[b]! });
    heap.push(cost, id);
  }

  // Initial candidates: every distinct undirected edge, enumerated in fixed
  // ascending-halfedge-index order (determinism — see this module's doc).
  const seenEdges = new Set<number>();
  for (let he = 0; he < hm.halfedgeCount; he++) {
    const v0 = hm.vertex[he]!;
    const v1 = hm.vertex[hm.next[he]!]!;
    const a = Math.min(v0, v1);
    const b = Math.max(v0, v1);
    const key = edgeKey(a, b, vertexCount);
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    tryPushEdge(a, b);
  }

  // --- Session state for the main collapse loop (driven by step()). ---
  let liveTriangleCount = faceCount;
  let collapseCount = 0;
  let maxErrorMm = 0;
  let cachedResult: DecimateMeshResult | null = null;

  function targetReached(): boolean {
    return targetTriangleCount !== undefined && liveTriangleCount <= targetTriangleCount;
  }

  /** Performs up to `maxCollapses` ACCEPTED collapses — the main collapse
   * loop, verbatim, just bounded. See `DecimationSession.step`'s doc. */
  function step(maxCollapses: number): number {
    let performed = 0;
    while (heap.size > 0 && performed < maxCollapses) {
      if (targetReached()) break;
      const top = heap.pop()!;
      const meta = pushMeta.get(top.id)!;
      pushMeta.delete(top.id);
      const { a, b, pos, cost, versionA, versionB } = meta;

      // Stale checks (see "Lazy invalidation" doc) — `continue`, not
      // `break`: a later (fresher) push for a currently-cheaper edge
      // elsewhere in the mesh can legitimately have a LOWER cost than an
      // earlier accepted collapse, so the popped sequence is not globally
      // sorted across the whole run and an early `break` here would be
      // incorrect, not just suboptimal.
      if (vertexDeleted[a] || vertexDeleted[b]) continue;
      if (vertexVersion[a] !== versionA || vertexVersion[b] !== versionB) continue;
      if (errorBoundMm !== undefined && Math.sqrt(cost) > errorBoundMm) continue;

      // Collapse: `b` (the higher original vertex index — arbitrary but
      // fixed and deterministic; every candidate is pushed with `a < b`,
      // see above) survives at the computed optimal `pos`; `a` is removed.
      const survivor = b;
      const removed = a;
      vx[survivor] = pos[0];
      vy[survivor] = pos[1];
      vz[survivor] = pos[2];
      addQuadricInPlace(quadrics[survivor]!, quadrics[removed]!);
      vertexDeleted[removed] = 1;

      for (const t of vertexTriangles[removed]!) {
        if (triDeleted[t]) continue;
        const base = t * 3;
        const v0 = triVerts[base]!;
        const v1 = triVerts[base + 1]!;
        const v2 = triVerts[base + 2]!;
        const hasSurvivor = v0 === survivor || v1 === survivor || v2 === survivor;
        // Every OTHER vertex of this (live) triangle — not `removed` itself
        // — has its ADJACENCY change as a direct result of this collapse:
        // the triangle either disappears outright (shrinking that vertex's
        // one-ring) or gets remapped so `removed` becomes `survivor` in it
        // (changing that vertex's neighbor SET, not just something
        // cosmetic). Bumping their version here — not just the survivor's —
        // is what makes the lazy-invalidation staleness check (this
        // module's doc) correctly discard any heap entry whose
        // link-condition verdict was computed against their now-stale
        // one-ring, rather than trusting a verdict that silently no longer
        // holds (a real bug this task's own property-test suite caught
        // before this fix existed — see decimate.property.test.ts's
        // output-validity property, which fails without these bumps at
        // aggressive reduction ratios).
        if (v0 !== removed) vertexVersion[v0]!++;
        if (v1 !== removed) vertexVersion[v1]!++;
        if (v2 !== removed) vertexVersion[v2]!++;
        if (hasSurvivor) {
          // One of the (1 or 2) triangles straddling the collapsed edge
          // itself — both its vertices are gone/merged, so it collapses to
          // a degenerate (zero-area) sliver; drop it.
          triDeleted[t] = 1;
          liveTriangleCount--;
          continue;
        }
        if (v0 === removed) triVerts[base] = survivor;
        else if (v1 === removed) triVerts[base + 1] = survivor;
        else triVerts[base + 2] = survivor;
        vertexTriangles[survivor]!.add(t);
      }
      vertexTriangles[removed]!.clear();

      collapseCount++;
      performed++;
      maxErrorMm = Math.max(maxErrorMm, Math.sqrt(cost));
      cachedResult = null; // state advanced — any earlier finish() snapshot is stale.

      // Re-push every edge in the survivor's NEW one-ring — see "Lazy
      // invalidation": this is what makes any stale entry still referencing
      // `survivor` (with its old version) get discarded at pop time.
      for (const n of oneRingNeighbors(survivor, vertexTriangles, triVerts, triDeleted)) {
        tryPushEdge(Math.min(survivor, n), Math.max(survivor, n));
      }
    }
    return performed;
  }

  function finish(): DecimateMeshResult {
    if (cachedResult) return cachedResult;

    // A vertex might survive `vertexDeleted` (never itself collapsed away)
    // yet end up referenced by zero live triangles — a known, rare edge
    // case where every triangle around it happened to be consumed as an
    // "apex" triangle by neighboring collapses (the link condition
    // guarantees no NON-MANIFOLD result, not that every vertex stays
    // referenced). Pruned here (into a LOCAL mask — NOT `vertexDeleted`
    // itself, so an early `finish()` snapshot never corrupts a session
    // that later keeps stepping): an LOD render copy has no use for a
    // stray unreferenced vertex (contrast intake/weld's own convention of
    // tolerating them in the data of record — this is a render-only mesh,
    // not one).
    const referenced = new Uint8Array(vertexCount);
    for (let t = 0; t < faceCount; t++) {
      if (triDeleted[t]) continue;
      const base = t * 3;
      referenced[triVerts[base]!] = 1;
      referenced[triVerts[base + 1]!] = 1;
      referenced[triVerts[base + 2]!] = 1;
    }

    // --- Compact into the output mesh. ---
    const vertexRemap = new Int32Array(vertexCount).fill(-1);
    let outVertexCount = 0;
    for (let v = 0; v < vertexCount; v++) {
      if (vertexDeleted[v] || !referenced[v]) continue;
      vertexRemap[v] = outVertexCount++;
    }
    const outPositions = new Float64Array(outVertexCount * 3);
    for (let v = 0; v < vertexCount; v++) {
      const nv = vertexRemap[v]!;
      if (nv === -1) continue;
      outPositions[nv * 3] = vx[v]!;
      outPositions[nv * 3 + 1] = vy[v]!;
      outPositions[nv * 3 + 2] = vz[v]!;
    }
    const outIndices = new Uint32Array(liveTriangleCount * 3);
    let w = 0;
    for (let t = 0; t < faceCount; t++) {
      if (triDeleted[t]) continue;
      const base = t * 3;
      outIndices[w * 3] = vertexRemap[triVerts[base]!]!;
      outIndices[w * 3 + 1] = vertexRemap[triVerts[base + 1]!]!;
      outIndices[w * 3 + 2] = vertexRemap[triVerts[base + 2]!]!;
      w++;
    }

    cachedResult = {
      mesh: { positions: outPositions, indices: outIndices },
      inputTriangleCount: faceCount,
      outputTriangleCount: liveTriangleCount,
      collapseCount,
      maxErrorMm,
    };
    return cachedResult;
  }

  return {
    inputTriangleCount: faceCount,
    liveTriangleCount: () => liveTriangleCount,
    isDone: () => heap.size === 0 || targetReached(),
    progressFraction: () => {
      if (targetTriangleCount !== undefined) {
        const total = faceCount - targetTriangleCount;
        if (total <= 0) return 1;
        return Math.min(1, (faceCount - liveTriangleCount) / total);
      }
      // errorBoundMm-only run: approximate by queue drain — see
      // `DecimationSession.progressFraction`'s doc (display-only).
      return collapseCount / Math.max(1, collapseCount + heap.size);
    },
    step,
    finish,
  };
}
