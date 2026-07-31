# ADR-021 — Performance caching is determinism-preserving; the byte-identical golden is the gate

Phase 8 Task 3 (recorded at the Task 7 phase gate). Status: accepted.

## Context

Phase 8's mandate includes a "performance pass" (worker-pool tuning, BVH caching,
render LODs). In most software a perf pass is free to trade a little accuracy for
speed. In DQ-Dental-CAD it is not: the product is medical-adjacent, and CLAUDE.md's
overriding rule is *accuracy over speed — a slower correct algorithm always beats a
faster approximate one*, with two hard invariants that any cache could violate:

- **Invariant 2 (determinism):** same inputs + params + kernel version ⇒
  bit-identical outputs, independent of worker scheduling or cache residency.
- **The Phase 8 headline gate:** `npm run test:golden` must stay
  **byte-identical** across the whole phase; *a golden file changing is the alarm*,
  not a win.

A cache is a classic way to accidentally break both: a stale/poisoned entry returns
a wrong value (breaks determinism), or a "faster" approximate result subtly diverges
(moves a golden). The decision this ADR records is HOW caching is allowed to exist
in this codebase at all.

## Decision — every performance cache is a PROVABLY-PURE MEMO, gated by byte-identity

1. **A cache may only be a pure memo of a deterministic function.** A cache miss
   must recompute the *bit-identical* value a cache hit returns; the cache changes
   *when* work happens, never *what* the result is. This holds for the two live
   caches:
   - **BVH cache** (`packages/kernel-workers/src/jobs/bvh.ts`) — keyed by the
     immutable mesh `contentHash`; a miss rebuilds the identical `Bvh`. Cross-worker
     isolation + affinity routing (`engine/workers.ts`) make the result independent
     of *which* worker (i.e. of scheduling).
   - **Consolidated halfedge/curvature cache** (`meshCache.ts`, P4-T1) — one shared
     per-worker pair replacing six duplicated caches, keyed by content hash.

2. **Determinism is proven by falsifiable tests, not asserted.** Each cache has a
   test constructed so a *wrong or stale* entry fails a concrete assertion:
   - `offsetJob.test.ts`: a cache-hit result is asserted **SHA-256 byte-identical**
     to a direct, cache-free kernel `offsetMesh` call; a diverged mesh fails the hash
     equality. Eviction on `releaseBvh` is proven by a subsequent `BvhNotCachedError`.
   - `bvhJobs.test.ts`: `buildBvh` → `measurePointToSurface` asserts an exact analytic
     distance (`toBeCloseTo(2, 12)`); a poisoned/stale entry fails it. A "any idle
     worker" router is caught by a `BvhNotCachedError`.
   - `meshCache.test.ts`: a curvature computed via a *shared* halfedge is asserted
     array-for-array equal to an independent standalone computation.

3. **Render LODs are engine-only and provably cannot reach exported geometry.** The
   decimated Float32 render copies (`engine/lod.ts`, policy in `lodPolicy.ts`) are a
   separate buffer; `lod.test.ts` asserts the Float64 kernel masters keep the same
   array references and SHA-256 bytes after an LOD build, and that export/QC
   serialization slices the masters, never a render copy. LOD policy constants are
   render-perf-only (documented in `lodPolicy.ts`, NOT in `clinical-profiles/`), so
   they have zero bearing on any exported geometry or QC gate.

4. **The byte-identical golden is the enforcement mechanism.** The final gate is not
   a code review of the caches — it is `npm run test:golden` producing a
   byte-identical `test-fixtures/` tree (hash `db94d0c3baa3`, unchanged across all of
   Phase 8) plus bit-identical determinism/journal-replay goldens. A cache that
   changed any result *cannot* pass. `KERNEL_VERSION` stays **0.26.0**: a bump would
   itself signal an accidental accuracy change to investigate.

## Consequences

- Performance work is bounded to rendering / LOD / worker-scheduling and to
  determinism-preserving memoization — never to the kernel geometry math (adding a
  `Float32Array` to `kernel`/`io`/`cad-pipeline` stays a bug even if tests pass).
- The honest, non-churn outcome of a perf pass can legitimately be "already optimal —
  here are the measurements" (Phase 8 Task 3: the carry-in levers were already done in
  P2-T12 / P4-T1; the harness `test/golden/perf-harness.perf.test.ts` records the
  baseline, and no production code changed). Manufacturing churn to "look busy" would
  violate this discipline, not honor it.
- Any future cache added to a computed result inherits this contract: a
  byte-identity test against the cache-free path, or it does not ship.
