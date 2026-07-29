# ADR-018 — Export request transport, `caseJournalHash`, and traceability determinism/timestamp policy

Phase 7 Tasks 3 & 5. Status: accepted.

## Context

The client sends an export to the server for independent re-validation, and the
server generates a QC traceability document stored with the release. Three
decisions bind the rest of the phase and a future maintainer will need the
"why": how the bytes + context travel; how the journal is hashed for the
mismatch-triage identity; and how the traceability document stays
byte-deterministic (the export-determinism global constraint) despite carrying
audit-relevant timing.

## Decision 1 — bytes ride as base64-in-JSON, one request

`RestorationExportRequest` carries the exported bytes as `bytesBase64` inside a
single JSON body (`POST /api/restorations/:id/export`), not as a raw
octet-stream. Rationale:

- The request is inseparable from its context (QC report, acknowledgments,
  journal hash, profile identity, kernel version); one JSON body keeps the whole
  request under a single Fastify JSON schema (the backend convention), where the
  octet-stream style smuggles context via headers/query.
- Exports are small (the largest fixture solid ≈ 2.7 MB STL ≈ 3.6 MB base64,
  well under the `meshMaxBytes` bodyLimit the server already provisions), and
  the tooth-library upload precedent already rides small mesh bytes as
  base64-in-JSON.
- Integrity is explicit: `bytesSha256` + `byteLength` are verified server-side
  against the decoded bytes **first**, before anything else runs.
- The encode runs WORKER-side (T3-F3): a main-thread base64 of a 2.7 MB export
  (~130 ms) would blow the 50 ms UI budget, so `exportRestorationMesh` returns
  `bytesBase64` from the worker and the flow passes it through verbatim.
- Fallback for a hypothetical > bodyLimit export (two-phase octet-stream upload
  + JSON finalize) is explicitly out of scope until such an export exists.

## Decision 2 — `caseJournalHash` = SHA-256 over canonical journal JSON, id/timestamp EXCLUDED

`hashCaseJournal(history)` is SHA-256 (lowercase hex) over the UTF-8 bytes of a
canonical JSON array, one element per `Operation` IN ORDER, each exactly
`{ inputHashes, kernelVersion, name, outputHashes, params }` with keys sorted
recursively (arrays keep order — order IS data). `id` and `timestamp` are
**excluded by definition**: `id` is a random UUID a replay regenerates;
`timestamp` is audit-display-only. Both are persisted verbatim, so the hash is
stable across save/load AND buys the stronger property that a journal REPLAY
(new ids/timestamps, same hashes/params) yields the SAME journal hash —
extending the P4/P5/P6 record→replay discipline to export. Values canonical JSON
cannot faithfully represent (NaN/±Infinity, bigint, typed arrays, holes …) throw
a typed `JournalHashUnserializableError` naming the path. The one shared
implementation lives in `@dqcad/kernel-workers/journal-hash` so the server
recomputes it identically; the scope INCLUDES the export op itself, and the
server recomputes over the SAVED journal with the same rule (→ 409
`export-journal-hash-mismatch` on a divergence). Deliberately NOT
`QcReport.journalHash` (which, by the P4 convention, carries the finalMesh
content hash — the stale-QC guard); the two have distinct names everywhere.

## Decision 3 — the traceability document carries ZERO timestamps

The `QcTraceabilityDocument` is serialized with `canonicalStringify` (sorted
keys, no whitespace) so the same release ⇒ **bit-identical JSON** (asserted by
two independent builds + idempotent re-release comparison + byte-pinned
goldens). To keep that true while a lab still sees WHEN a file was released:

- No timestamp key or ISO-8601 value appears anywhere in the serialized core
  (a regex test falsifiably asserts this).
- `releasedAt` lives ONLY on the `Export` ledger row. The HTML renderer may
  display it, but only via an explicit `releasedAt` option rendered under a
  labeled "server record field — not part of the hashed document" line, and the
  renderer THROWS if that option is passed for a preview.
- The HTML is rendered from the SAME JSON (no second source of truth); the
  renderer is PURE (no Date/Intl/env-locale/randomness — locale is an explicit
  parameter), self-contained (no external `src`/`href`/`url(`), i18n ×4.
- A versioned JSON Schema lives in `shared-types`; generation validates against
  it (the acceptance) and the stored bytes are served verbatim (re-serialization
  would break the byte-pinnable contract). Release documents are certified at
  `schemaVersion 2` (`outerEnvelopeCertified: true`); previews stay
  `documentKind: 'preview'` with the outer-envelope disclosure required.

## Consequences

- One JSON body + one Fastify schema for the whole export; the bytes and their
  context can never be validated apart.
- The journal hash is a stable, replay-invariant identity for mismatch triage;
  it is NOT a provenance signature (a client-authored journal proves consistency
  with the saved case, not authenticity — the invariant-4 acknowledgment path is
  the visible floor; ADR-017 pins the silent-threshold variant).
- The traceability document is a byte-deterministic regulatory record: the same
  release regenerates byte-identically forever, yet a human still sees the
  release time as an explicitly-labeled non-hashed envelope field.
