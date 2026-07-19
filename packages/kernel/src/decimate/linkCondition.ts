// packages/kernel/src/decimate/linkCondition.ts
//
// The LINK CONDITION (Dey, Edelsbrunner, Guha, Nekhayev 1999 — the standard
// topology-safety test for an edge collapse): collapsing edge `(a, b)` keeps
// the mesh a valid 2-manifold iff
//
//   link(a) ∩ link(b) == link(edge ab)
//
// where `link(v)` is `v`'s one-ring NEIGHBOR set (the vertices directly
// connected to `v` by an edge) and `link(edge ab)` is the set of "apex"
// vertices of the (1 or 2) triangles containing edge `(a, b)` itself. Since
// every apex vertex is trivially in BOTH `link(a)` and `link(b)` (it shares
// a triangle with each), `link(edge ab)` is always a SUBSET of the
// intersection — so the check this module performs is exactly "does the
// intersection contain anything ELSE": any additional common neighbor means
// `a` and `b` are already connected by some OTHER path through the mesh that
// doesn't go through edge `(a, b)`'s own two triangles, and merging them
// would pinch that other vertex into a non-manifold double-edge/bowtie (see
// this task's brief: "test with a fixture where naive collapse would pinch"
// — decimate.test.ts's pinch fixture exercises exactly this).
//
// `edgeCollapseIsManifoldSafe` is `decimate.ts`'s PRIMARY topology-safety
// mechanism, but not its only one: the classic link condition alone
// guarantees no non-manifold EDGE/VERTEX (bowtie) is created, but does NOT
// by itself rule out a narrower, separate degeneracy — a collapse that
// leaves two DUPLICATE triangles (identical vertex sets) behind. This
// matters at the extreme end of a decimation run (very few triangles left,
// approaching a bare tetrahedron), where a collapse can satisfy the link
// condition yet produce two coincident triangles — which then shows up as a
// genuine non-manifold edge (degree > 2) the MOMENT a third, later collapse
// touches either of them (empirically confirmed by this task's own
// property-test suite at aggressive reduction ratios before this function
// existed — see decimate.test.ts's "target of 0" case). `
// collapseWouldDuplicateTriangle` below is the separate, additional check
// `decimate.ts` runs alongside the link condition to rule this out too —
// together, the two checks are `decimate.ts`'s COMPLETE topology-safety
// mechanism: no edge collapse this module accepts can ever produce a
// non-manifold result OR a duplicate triangle, regardless of the mesh's
// geometry or how aggressively `decimateMesh` is asked to reduce it.
//
// Operates on the SAME dynamic (mutable, per-collapse-updated) adjacency
// `decimate.ts` maintains through a decimation run — see that module's
// "Dynamic mesh representation" doc — rather than the static `HalfedgeMesh`
// overlay (which cannot represent a mesh mid-collapse). This is intentional:
// there is exactly ONE implementation of the link condition, used both for
// the very first candidate-edge pass (topology identical to the input mesh)
// and every subsequent re-push after a collapse (topology already mutated),
// so there is nothing for the two cases to disagree about.

/** `v`'s current one-ring neighbor set: every OTHER vertex sharing a live
 * (non-deleted) triangle with `v`. `vertexTriangles[v]` may contain STALE
 * (deleted) triangle indices left over from a prior collapse — see
 * `decimate.ts`'s doc for why cleaning that up eagerly is skipped — so every
 * consumer here filters by `triDeleted`. */
export function oneRingNeighbors(
  v: number,
  vertexTriangles: ReadonlyArray<ReadonlySet<number>>,
  triVerts: Uint32Array,
  triDeleted: Uint8Array,
): Set<number> {
  const out = new Set<number>();
  for (const t of vertexTriangles[v]!) {
    if (triDeleted[t]) continue;
    const base = t * 3;
    const v0 = triVerts[base]!;
    const v1 = triVerts[base + 1]!;
    const v2 = triVerts[base + 2]!;
    if (v0 !== v) out.add(v0);
    if (v1 !== v) out.add(v1);
    if (v2 !== v) out.add(v2);
  }
  return out;
}

/**
 * `true` iff collapsing edge `(a, b)` is topology-safe under the CURRENT
 * `vertexTriangles`/`triVerts`/`triDeleted` state — see this module's doc
 * for the link-condition test itself. Does not check whether `(a, b)` is
 * even currently a valid edge (i.e. shares a live triangle at all) — callers
 * (`decimate.ts`) only ever invoke this for pairs already known to be
 * adjacent (from the initial edge enumeration, or a survivor's post-collapse
 * one-ring), so that precondition is always met at every call site.
 */
export function edgeCollapseIsManifoldSafe(
  a: number,
  b: number,
  vertexTriangles: ReadonlyArray<ReadonlySet<number>>,
  triVerts: Uint32Array,
  triDeleted: Uint8Array,
): boolean {
  const linkA = oneRingNeighbors(a, vertexTriangles, triVerts, triDeleted);
  const linkB = oneRingNeighbors(b, vertexTriangles, triVerts, triDeleted);

  const apexes = new Set<number>();
  for (const t of vertexTriangles[a]!) {
    if (triDeleted[t]) continue;
    const base = t * 3;
    const v0 = triVerts[base]!;
    const v1 = triVerts[base + 1]!;
    const v2 = triVerts[base + 2]!;
    const hasA = v0 === a || v1 === a || v2 === a;
    const hasB = v0 === b || v1 === b || v2 === b;
    if (!(hasA && hasB)) continue;
    const apex = v0 !== a && v0 !== b ? v0 : v1 !== a && v1 !== b ? v1 : v2;
    apexes.add(apex);
  }

  for (const n of linkA) {
    if (n === b) continue; // the edge's own other endpoint, not a "third" vertex.
    if (linkB.has(n) && !apexes.has(n)) return false; // extra shared neighbor => would pinch.
  }
  return true;
}

/** Canonical (sort-order-independent) string key for a triangle's vertex
 * SET — used only by `collapseWouldDuplicateTriangle`'s existence check
 * below, never on any other hot path in this module. */
function triangleKey(v0: number, v1: number, v2: number): string {
  const sorted = [v0, v1, v2].sort((x, y) => x - y);
  return `${sorted[0]},${sorted[1]},${sorted[2]}`;
}

/**
 * `true` iff collapsing `removed` into `survivor` — remapping every triangle
 * incident to `removed` that does NOT already contain `survivor` (the ones
 * that DO are deleted outright, per `decimate.ts`'s collapse loop) — would
 * create a triangle whose vertex set already matches some triangle
 * currently live at `survivor`. See this module's top doc for why this is a
 * separate check from the link condition (both must pass for a collapse to
 * be accepted).
 */
export function collapseWouldDuplicateTriangle(
  removed: number,
  survivor: number,
  vertexTriangles: ReadonlyArray<ReadonlySet<number>>,
  triVerts: Uint32Array,
  triDeleted: Uint8Array,
): boolean {
  const survivorTriangleKeys = new Set<string>();
  for (const t of vertexTriangles[survivor]!) {
    if (triDeleted[t]) continue;
    const base = t * 3;
    survivorTriangleKeys.add(triangleKey(triVerts[base]!, triVerts[base + 1]!, triVerts[base + 2]!));
  }
  for (const t of vertexTriangles[removed]!) {
    if (triDeleted[t]) continue;
    const base = t * 3;
    const v0 = triVerts[base]!;
    const v1 = triVerts[base + 1]!;
    const v2 = triVerts[base + 2]!;
    const hasSurvivor = v0 === survivor || v1 === survivor || v2 === survivor;
    if (hasSurvivor) continue; // deleted outright by the collapse, never remapped.
    const remapped = triangleKey(
      v0 === removed ? survivor : v0,
      v1 === removed ? survivor : v1,
      v2 === removed ? survivor : v2,
    );
    if (survivorTriangleKeys.has(remapped)) return true;
  }
  return false;
}
