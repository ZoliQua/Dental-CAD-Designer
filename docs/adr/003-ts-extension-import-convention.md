# ADR-003: `.ts`-extension relative imports for the Node worker-entry closure

**Status:** Accepted

## Context

`packages/kernel-workers/src/worker-entry.node.ts` is loaded directly by
Node's native module loader inside a `worker_threads` `Worker` (Node ≥23.6,
this repo targets Node 25, strips TypeScript syntax natively — no build step
or loader registration). Node's native ESM loader resolves relative
specifiers LITERALLY, with no `.js` -> `.ts` extension mapping. Every other
file in this monorepo uses the usual TS/bundler convention of writing
`.js`-suffixed relative imports even though the source file is `.ts` (Vite,
`tsc`, and Vitest's resolver all map `./foo.js` -> `./foo.ts` when no
compiled `.js` exists — the "compiled output extension" convention). That
mapping does not exist for Node's native loader: a Node-loaded file that
imports `./foo.js` fails to resolve when only `foo.ts` is on disk.

`tsconfig.base.json` sets `allowImportingTsExtensions`, which lets a file
instead import `./foo.ts` literally — this resolves correctly under BOTH
Node's native loader AND every bundler/test-resolver in this repo (Vite,
Vitest, `tsc --noEmit`), so it is a strictly safe convention to use, but it
is more unusual (`.ts` in a shipped import path reads oddly outside this
project) and was initially applied inconsistently before being tightened
(commit `c96910f`, "Final-review fix batch... doc corrections").

Phase 2 Task 1 grew the Node-reachable closure substantially: the original
single-file `kernel-workers/src/jobs.ts` became an 8-file `jobs/` directory
(`registry.ts` + `context.ts`, `shared.ts`, `io.ts`, `intake.ts`, `bvh.ts`,
`heatmap.ts`, `section.ts`, `repair.ts`, `misc.ts`), all of it now inside the
Node-reachable import closure (`worker-entry.node.ts` -> `jobs/registry.ts`
-> every `jobs/*.ts` domain module), so this convention now applies to
strictly more files than before, and getting the boundary wrong would
manifest as a Node-only, worker-only runtime resolution failure that
`tsc --noEmit`/Vitest/Vite would NOT catch (their resolvers are more
permissive than Node's native loader).

## Decision

A file's relative imports use a literal `.ts` extension if and only if the
file is reachable — by any import path — from
`kernel-workers/src/worker-entry.node.ts`'s own module graph. Concretely,
today: `worker-entry.node.ts`, `comlink-node-adapter.ts`, every
`kernel-workers/src/jobs/*.ts` file, `kernel-workers/src/hash.ts`,
`kernel-workers/src/transfer.ts`, and every file `packages/kernel` and
`packages/io` reach via their OWN relative imports (both packages are
entirely Node-worker-reachable, per their own module docs). Every other
file — including `kernel-workers/src/pool.ts`, `index.ts`, and
`worker-entry.browser.ts`, none of which the Node native loader ever
loads — keeps the ordinary `.js`-suffixed convention.

This is a per-FILE property of the import graph, not a per-PACKAGE one:
`kernel-workers/src/pool.ts` sits in the same package as `jobs/registry.ts`
but is bundled/browser-loaded only, so it correctly uses `.js`. A new file
added to `jobs/` automatically inherits the `.ts` requirement by virtue of
being imported (transitively) from `worker-entry.node.ts` — no separate
opt-in needed, but also no automatic enforcement: this is a REVIEW-TIME
check, not (yet) a lint rule (see Consequences).

## Consequences

- Verification is manual/review-time, not automated: `npm test`'s
  `kernel-workers` project runs every job through the REAL Node
  `worker_threads` path (not a mock), so a wrong extension on any
  Node-reachable file fails loudly (module-not-found) the moment any job
  test runs — this is Phase 1/2's actual safety net, not a static check.
  A dedicated ESLint rule (or a `boundaries`-style test asserting every
  file in the closure uses `.ts`) is a plausible future addition
  (`eslint.boundaries.test.ts` already tests the layer-rule boundaries the
  same way) but does not exist yet.
- Every new job module added under `kernel-workers/src/jobs/` — the
  explicit intent of Phase 2 Task 1's split ("new jobs go in per-domain job
  modules... never grow a monolith" — PLAN's Global Constraints) — must use
  `.ts` extensions for its own relative imports from the moment it's
  created, not retrofitted later.
- `packages/kernel` and `packages/io` are ENTIRELY subject to this rule
  (every file in them is Node-worker-reachable) — a contributor adding a
  file to either package never needs to check reachability case-by-case,
  only contributors touching `kernel-workers` itself (which has a real
  bundled/browser-only side, `pool.ts`/`index.ts`/`worker-entry.browser.ts`)
  need to reason about the boundary per-file.
