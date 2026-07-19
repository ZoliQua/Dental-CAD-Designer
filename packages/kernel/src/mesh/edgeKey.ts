// packages/kernel/src/mesh/edgeKey.ts
//
// Integer edge-key encoding shared by intake/topology.ts's edge-adjacency
// map and halfedge/build.ts's twin-pairing pass (Phase 2 Task 2's intake
// scalability rebuild — see docs/plans/phase-2-kernel-core.md Task 2 item 5:
// "replace ... string-keyed edge maps with integer-keyed"). Replaces the
// earlier `` `${a},${b}` `` STRING key (cheap to read but pays a template-
// string allocation + string hashing on every one of a mesh's
// ~1.5 * triangleCount edge visits) with a single integer a `Map<number,
// ...>` can key on directly (SMI/heap-number hashing, no string allocation,
// no string-table pressure) — this is the primary lever this task pulls for
// intake's topology.ts/orient.ts/analyze.ts perf at 2.5M-5M triangle scale.

/**
 * `edgeKey(a, b, vertexCount) = a * vertexCount + b` (standard base-
 * `vertexCount` positional encoding of the pair) is injective over
 * `0 <= a < b < vertexCount`, with largest possible value
 * `(vertexCount - 2) * vertexCount + (vertexCount - 1) < vertexCount^2`.
 * For this to round-trip exactly through a JS `number` (IEEE 754 double,
 * exact integers only up to `2^53 - 1 = Number.MAX_SAFE_INTEGER`), we need
 * `vertexCount^2 <= Number.MAX_SAFE_INTEGER`, i.e.
 * `vertexCount <= floor(sqrt(Number.MAX_SAFE_INTEGER)) = 94,906,265`. This
 * project's NFR ceiling is ~5M triangles / ~2.5-5M vertices (PLAN.md §7,
 * docs/plans/phase-2-kernel-core.md Task 2 item 5: "V up to ~5M vertices ->
 * min*V+max up to 2.5e13, safe") — roughly 19-38x below this bound — so
 * `assertSafeVertexCountForEdgeKey` below is a defensive assertion against
 * pathological/future input, not an expected runtime path.
 */
export const MAX_SAFE_EDGE_KEY_VERTEX_COUNT = Math.floor(Math.sqrt(Number.MAX_SAFE_INTEGER));

/** Throws if `vertexCount` would let `edgeKey` produce a key that can't
 * round-trip exactly through a JS number — see this module's doc for the
 * bound's derivation. `context` is prefixed onto the error message (e.g.
 * the throwing function's name) for a useful stack-free diagnostic. */
export function assertSafeVertexCountForEdgeKey(vertexCount: number, context: string): void {
  if (vertexCount > MAX_SAFE_EDGE_KEY_VERTEX_COUNT) {
    throw new RangeError(
      `${context}: vertexCount ${vertexCount} exceeds the safe integer edge-key bound ` +
        `(${MAX_SAFE_EDGE_KEY_VERTEX_COUNT}) for edgeKey = a * vertexCount + b`,
    );
  }
}

/**
 * Packs undirected edge `{a, b}` into one integer key. Callers must pass
 * `a < b` (every call site already computes a canonical min/max pair before
 * calling this — asserting it here would cost a branch on every one of a
 * mesh's edge visits for a property callers already guarantee).
 */
export function edgeKey(a: number, b: number, vertexCount: number): number {
  return a * vertexCount + b;
}

/** Inverse of `edgeKey` — recovers `{a, b}` from a key (used only for
 * diagnostics/error messages, never on a hot path). */
export function decodeEdgeKey(key: number, vertexCount: number): { a: number; b: number } {
  const a = Math.floor(key / vertexCount);
  const b = key - a * vertexCount;
  return { a, b };
}
