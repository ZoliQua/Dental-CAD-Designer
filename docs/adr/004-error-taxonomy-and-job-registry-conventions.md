# ADR-004: Error taxonomy + job registry conventions

**Status:** Accepted

## Context

The codebase has accumulated a dozen-plus named `Error` subclasses across
layers (`packages/io`, `packages/kernel`, `packages/kernel-workers`,
`apps/server`, `apps/client`) with no single document tying them together,
plus an implicit (now, post-Task-1, explicit) convention for how the job
registry itself is organized and grown. Both were called out in Phase 1's
final review as debt worth writing down before Phase 2 adds more of each
(new kernel algorithms throw new error kinds; new jobs join the registry
Task 1 just split).

### Error inventory (as of this task)

| Class | Layer | Recognized by |
| --- | --- | --- |
| `IoParseError` | `packages/io` | `instanceof` (same-thread/same-module callers) |
| `IoWriteRangeError` | `packages/io` | `instanceof` |
| `IoStreamCancelledError` | `packages/io` | `instanceof` |
| `ChunkReaderError` | `packages/io` | `instanceof` |
| `NonManifoldInputError` | `packages/kernel` | `instanceof` (thrown/caught same-thread — e.g. `jobs/section.ts`'s `sectionMeshJob` catches it directly) |
| `DegeneratePlaneError` | `packages/kernel` | `instanceof` |
| `JobCancelledError` | `packages/kernel-workers` (`jobs/context.ts`) | `.name` string, ACROSS the Comlink/postMessage boundary |
| `BvhNotCachedError` | `packages/kernel-workers` (`jobs/bvh.ts`) | `.name` string, across Comlink |
| `PoolDestroyedError` | `packages/kernel-workers` (`pool.ts`) | `instanceof` (never crosses Comlink — thrown main-thread-side, by the pool itself) |
| `WorkerCrashedError` | `packages/kernel-workers` (`pool.ts`) | `instanceof` (same as above) |
| `InvalidMeshHashError` | `apps/server` | `instanceof` (thrown/caught server-side) |
| `MeshStorageIntegrityError` | `apps/server` | `instanceof` |
| `PersistenceHttpError` | `apps/client` | `instanceof` (module-private to `persistence.ts`) |

## Decision

### 1. Two recognition strategies, chosen by whether the error crosses a
   structured-clone boundary

- **Same-thread errors** (never cross Comlink/postMessage): plain
  `instanceof` checks, thrown and caught within one JS realm. This covers
  everything in `packages/io`, `packages/kernel`, `apps/server`, and
  `apps/client`'s own module-private errors (`PersistenceHttpError`), plus
  `pool.ts`'s own `PoolDestroyedError`/`WorkerCrashedError` (thrown
  main-thread-side by the pool itself, never sent across the worker
  boundary).
- **Cross-worker errors** (thrown INSIDE a job handler, observed by a
  `WorkerPool.run()` caller on the main thread): recognized by `.name`
  string, never `instanceof`. Comlink reconstructs a thrown error on the
  receiving side as a plain `Error` with the original `name`/`message`
  preserved — NOT as the original subclass (it cannot serialize a class
  reference across a postMessage boundary). `JobCancelledError` and
  `BvhNotCachedError` are the two examples today; `pool.ts`'s
  `isJobCancelledError` is the canonical pattern (`error instanceof Error
  && error.name === 'JobCancelledError'`) — any NEW error thrown from inside
  a job handler that a caller needs to distinguish must follow this same
  pattern, not add an `instanceof` check that will silently never match in
  production (only same-thread test code that imports the class directly
  would ever see it succeed, masking the bug).

### 2. One error class per distinct FAILURE MODE, not per call site

Each class name states WHAT went wrong, not WHERE (`BvhNotCachedError`, not
`MeasurePointToSurfaceError`) — this is why `measurePointToSurface` and
`raycastMesh` and `distanceHeatmap` (`jobs/bvh.ts`, `jobs/heatmap.ts`) share
ONE `BvhNotCachedError` rather than each defining their own. A generic
`TypeError`/`Error` is used (not a named subclass) when nothing downstream
ever needs to distinguish the failure programmatically — e.g. every job
handler's own payload-shape guards (`requireMeshPayload`, `jobs/shared.ts`)
throw plain `TypeError`s: callers are expected to fix a malformed payload at
the call site during development, never branch on that failure at runtime.

### 3. Job registry conventions (Phase 2 Task 1's split — `jobs/registry.ts`)

- **One domain module per file**, named for the geometry domain it serves
  (`io`, `intake`, `bvh`, `heatmap`, `section`, `repair`), or `misc.ts` for
  jobs that don't belong to one domain (utility/smoke-test jobs, plus any
  job whose payload is a generic re-hash/transform rather than a specific
  algorithm — e.g. `hashMesh`). **Never grow `misc.ts` into a new
  monolith** — a THIRD or more job sharing an obvious new domain name
  splits into its own file, mirroring why `jobs.ts` itself was split at 1575
  lines / 15 jobs.
- **A job's `Payload`/`Result` interfaces live in the SAME file as its
  handler**, exported for `jobs/registry.ts` to re-export (and, from there,
  for `index.ts`/callers to import) — never defined separately from the
  handler that produces/consumes them.
- **`jobs/registry.ts` is the ONLY file that assembles `JobPayloadMap`/
  `JobResultMap`/the `registry` object** — adding a job means (a) writing
  its handler + types in the right domain file (or a new one), (b) adding
  three lines to `registry.ts` (one entry each in `JobPayloadMap`,
  `JobResultMap`, `registry`). No other file needs to change (worker entries
  stay untouched — see `runJob`'s own doc: "adding a job only means adding
  an entry to `registry`... not touching either worker entry file").
- **No domain module imports from `jobs/registry.ts`** — this keeps the
  dependency graph a strict DAG (registry.ts is always the "top"; see that
  file's module doc). Cross-cutting helpers used by more than one domain
  module (the `JobContext`/`JobCancelledError` pair, `Vec3Payload`,
  `requireMeshPayload`) live in the dependency-free leaves
  `jobs/context.ts`/`jobs/shared.ts` instead, imported by whichever domain
  files need them (including, when one domain module's job legitimately
  needs another's helper — e.g. `jobs/heatmap.ts`'s `distanceHeatmap`
  querying `jobs/bvh.ts`'s SAME per-worker cache via its exported
  `requireCachedBvh` — a direct domain-to-domain import, always in the
  DIRECTION of the dependency, never back through `registry.ts`).
- **Every job handler is a plain exported `async` function**, typed
  directly against its own `Payload`/`Result` types (e.g. `async (payload:
  FooPayload, ctx: JobContext): Promise<FooResult> => {...}`), NOT the
  `JobHandler<J>` generic (which is `jobs/registry.ts`-private — using it in
  a domain file would require importing `JobPayloadMap`/`JobResultMap` back
  from `registry.ts`, breaking the DAG above). `registry.ts`'s own `registry:
  { [J in JobName]: JobHandler<J> }` object literal is where structural
  compatibility with `JobHandler<J>` is actually checked — every handler's
  standalone signature already matches by construction.
- **`.ts`-extension relative imports** for every file under `jobs/` — see
  ADR-003; this closure grew from one file to nine with this task's split,
  and every new job module joins it automatically.

## Consequences

- A contributor adding a job follows a fixed, three-step checklist (handler
  file, registry.ts's three additions, and — if the error needs
  cross-worker recognition — the `.name`-string pattern) rather than
  re-deriving conventions from the existing 16 jobs each time.
- The `instanceof`-vs-`.name` split is easy to get wrong silently (a same-
  thread `instanceof` check on a cross-worker error type-checks fine and
  passes any test that mocks the worker boundary away) — this ADR is the
  canonical place to check when adding a new error a caller needs to
  distinguish; `pool.ts`'s `isJobCancelledError` remains the copy-pasteable
  reference implementation.
- This taxonomy is descriptive of what exists today, not a mandate to
  unify unrelated errors under fewer classes — `packages/io`'s four error
  classes, for instance, stay separate because callers legitimately branch
  on which ONE occurred (see each class's own doc for why).
