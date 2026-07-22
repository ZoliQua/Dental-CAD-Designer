# ADR-005: CaseDocument schema evolution — client-side migration, server-side validation split

**Status:** Accepted

## Context

`CaseDocument` (shared-types) has already evolved once (schemaVersion 1 ->
2, Phase 3 Task 1: `MarginLine.vertexAnchors` -> `MarginAnchor[]`) and grown
new required `Restoration` fields once more within v2 itself (`pontics`/
`targetNodeId`, Phase 3 Task 2). Both changes needed an answer to the same
question: what happens to a document already sitting in the database (or
about to be saved) whose shape predates the change? A Task-11 final review
found the server's `GET /api/cases/:id` route reusing `caseDocumentSchema`
— the SAME strict schema that (correctly) gates `PUT`'s request body — as
its response schema too, which made a pre-migration document 500 on the way
out rather than reach the client migration layer built to handle it
(Critical 4 of that review). This ADR writes down the design the codebase
was already assuming (`caseDocumentMigration.ts`'s own module doc predates
this fix and already describes GET as a pass-through) so it stops
regressing by accident.

## Decision

**Migration happens client-side, on load, only. The server never migrates.
The server accepts only the CURRENT schema version on write, and returns
whatever is actually stored on read — untouched.**

Concretely, three independent rules:

1. **`PUT /api/cases/:id` is strict.** `putCaseBodySchema` (=
   `caseDocumentSchema`, `apps/server/src/schemas.ts`) validates the
   request body: `additionalProperties: false`, a full `required` list,
   `schemaVersion` pinned via `const: 2`. A client may only ever WRITE the
   current shape — this includes rejecting a schemaVersion-1 body outright
   (no server-side upgrade path exists or is planned; migration is a
   client concern per point 3). This is unchanged by this ADR.

2. **`GET /api/cases/:id` is permissive.** The route has **no**
   `schema.response` at all — Fastify falls back to plain `JSON.stringify`
   instead of routing the response through
   `@fastify/fast-json-stringify-compiler` (fast-json-stringify), which
   would otherwise (a) **throw** on any property `caseDocumentSchema` lists
   as `required` but the stored document doesn't have, and (b) **silently
   drop** any property not listed in `properties` at all. Both failure
   modes are real for a document stored before a schema change: (a) a
   pre-Task-2 v2 `Restoration` has no `pontics`/`targetNodeId`; (b) a
   document could carry a since-removed field (e.g. a hypothetical old
   `controlPoints`) fast-json-stringify would strip rather than pass
   through. Either way, the strict schema turns "the client's migration
   layer needs to see this" into "the server never lets the client see
   this" — a 500 (or corrupted JSON) before the migration code ever runs.
   Removing the response schema makes GET a byte-faithful echo of
   `documentJson`, exactly as `caseDocumentMigration.ts`'s own module doc
   already assumed.

3. **The client migrates on load, forward-only, and re-persists.** Two
   migration layers run in sequence, both in
   `apps/client/src/engine/caseDocumentMigration.ts`:
   - **schemaVersion 1 -> 2**: `MarginLine.vertexAnchors: number[]` (a
     coarse nearest-vertex hint, never authoritative) becomes
     `MarginAnchor[]`. Each anchor's `position` carries through exactly
     (zero loss — `position` was always the authoritative field); its
     `triangleIndex`/`barycentric` cannot be honestly reconstructed from a
     bare vertex index (no mesh, and pre-Task-2 no target-mesh mapping
     existed at all), so they get the documented **unresolved-anchor
     sentinel**: `triangleIndex = UNRESOLVED_MARGIN_ANCHOR_TRIANGLE_INDEX
     (-1)`, a placeholder barycentric that sums to 1. This is flagged
     loudly (a journaled `migrate-schema-v1-to-v2` Operation records
     `unresolvedAnchorCount`), never silently — CLAUDE.md invariant 5. A
     margin line with any `-1` anchor is a degraded display (straight
     lines, not the fitted spline) until re-snapped.
   - **Field-presence backfill within v2**: a v2 `Restoration` missing
     `pontics`/`targetNodeId` (added as *required* fields after v2 already
     shipped) gets `pontics: []`/`targetNodeId: null` backfilled, journaled
     as `migrate-backfill-restoration-fields`.

   Both migrations are idempotent (a no-op on an already-current document)
   and run automatically the first time a document is opened; the very
   next successful `PUT` re-persists the upgraded shape, so a given
   document is migrated at most once in its lifetime. This is the ONLY
   place either legacy shape is ever accepted — `PUT` will reject a client
   that (somehow) tries to save a pre-migration shape.

## The `-1` unresolved-anchor sentinel — consequences for every consumer

Because a v1-migrated `MarginLine` can legitimately have `triangleIndex ===
-1` anchors sitting in a live `CaseDocument` until a human re-snaps them,
every code path that turns a `MarginAnchor` into mesh-relative geometry
must either resolve it first or refuse to proceed. Task-11's review found
one place this wasn't true: `apps/client/src/engine/axis.ts`'s
`abutmentTeethOf` only checked *presence* of a `marginLines` entry, not
whether it was resolved — an unresolved anchor's `-1` flowed into
`toMarginLoopPayload` and on into the `suggestAxis`/`axisHeatmap` worker
jobs, which index `mesh.indices[triangleIndex * 3 + k]` — `mesh.indices[-3]`
is `undefined`, propagating to `NaN` through the ROI extraction with no
clean error (Important 6 of that review). The fix: `abutmentTeethOf` now
excludes any tooth whose margin line still has an unresolved anchor, and
`AxisEngine.start` throws a typed `AxisMarginUnresolvedError` (not a
generic message) naming the affected teeth when that's why no abutments
are usable — surfaced in `ui/AxisPanel.tsx` as an i18n'd "re-snap first"
guidance rather than a raw thrown-error string. Any FUTURE consumer of
`MarginAnchor.triangleIndex` should assume `-1` is a real, reachable value
on live data (not just migration-test fixtures) and guard accordingly —
`marginEditor.reSnapUnresolvedAnchors` is the one blessed way to clear it.

## Consequences

- A document's on-disk (SQLite `documentJson`) shape can lag its
  `schemaVersion`-implied shape by one migration cycle — this is
  intentional (re-persisting eagerly on every GET would need a write on a
  read path); `schemaVersion`/shape mismatches are expected and handled,
  not a bug signal.
- Any future schema change follows the SAME shape: bump `schemaVersion` (or
  add a within-version required field), add a client-side migration/
  backfill step, keep `PUT` strict against the new shape, and do **not**
  add a `schema.response` to `GET /api/cases/:id` — if a future change
  wants server-side response validation, it needs to be an explicitly
  PERMISSIVE schema (no `additionalProperties: false`, no blanket
  `required`), never a reuse of the PUT body schema.
- `apps/server/src/app.test.ts` carries a direct regression: a legacy-
  shaped document written straight to the DB (bypassing the — correctly
  strict — PUT route, simulating a real pre-migration row) round-trips
  through GET byte-intact, while PUT still rejects the same shape with
  400.
