# ADR-019 — Telemetry-free, local-only, PHI-free error-report bundle

Phase 8 Task 5. Status: accepted.

## Context

DQ-Dental-CAD processes patient scans (PHI) on a single-user local machine. When
the app hits an unhandled error, a maintainer needs enough context to diagnose
it (versions, the error + stack, the sequence of events, which case was open).
The industry-default way to get that is a remote error-reporting SDK (Sentry,
Bugsnag, a custom `POST /telemetry`) that phones home automatically on every
crash.

For this product that default is unacceptable: an automatic upload of crash
context from a machine that holds patient scans is a PHI-egress channel by
construction, and "we tried to scrub it" is not a defensible posture for
medical-adjacent software (CLAUDE.md: *accuracy over speed; no silent data
mutation; scans/ is PHI*). An error report that leaks patient data — or phones
home at all — is worse than no error report.

## Decision — the bundle is local-only, telemetry-free, and PHI-free by construction

1. **No remote reporting. Ever.** There is no error-reporting SDK, no telemetry
   endpoint, no automatic upload. The diagnostic bundle is produced ON the user's
   machine as a downloadable local file that **the user** chooses whether to
   share (email it to support, drop it in a ticket — their decision, their
   channel). The bundle module (`apps/client/src/engine/diagnosticBundle.ts`)
   imports and uses **no transport** — no `fetch`, `XMLHttpRequest`, `WebSocket`,
   or `navigator.sendBeacon`. The download is a `Blob` → object URL → synthetic
   `<a download>` click → revoke, entirely local.

   *Guarded by* `diagnosticBundle.no-egress.test.ts`: it spies all four network
   globals and asserts ZERO calls across the whole build + serialize + download
   path, and (falsifiably) that a seeded `fetch(...)` IS caught by the same spy.

2. **PHI-free by an ALLOWLIST, never a denylist scrub.** The bundle is assembled
   from a fixed allowlist of fields; the case document is read for **only**
   `id` (a random UUID — not a patient identifier), its journal HASH
   (`hashCaseJournal`, a one-way SHA-256 — never the journal content), and the
   journal/restoration COUNTS. The builder never serializes the document, so it
   never touches `patientRef`, `meshes` (scan geometry / scanner filenames),
   `scene`, the content of `restorations` / `measurements` / `settings`, nor any
   case NAME. A new PHI-class field added to `CaseDocument` tomorrow is therefore
   **excluded by default** — there is no scrub step that could forget it.

   *Guarded by* `diagnosticBundle.no-phi.test.ts`: it seeds synthetic PHI
   (patientRef, a patient-named scan file, a case name, a journal param, a
   scan-blob marker) into a case, builds the bundle, and asserts none of it
   appears in the serialized bytes — and (falsifiably) that the SAME marker
   placed into an allowlisted path IS found by the same substring scan, so the
   "absent" assertions are not vacuous.

3. **The log ring is PHI-free by construction, not by review.** The bounded
   in-memory log (`engine/diagnosticLog.ts`, capacity 200, oldest-dropped) accepts
   an `event` label (code-controlled) plus a SCALAR-only `fields` bag
   (`string | number | boolean`). A whole case object or geometry buffer is a
   type error at the call site, and any non-scalar value is dropped at runtime —
   so an object/array can never be serialized into an entry. The discipline for
   callers: log ids, content hashes, versions, counts, and event names — never
   case content.

### The allowlist (exactly what a maintainer gets)

| field | source | why PHI-safe |
| --- | --- | --- |
| `schemaVersion`, `generatedAt` | constant / clock | format + timestamp metadata |
| `app.appVersion` / `kernelVersion` / `manifoldVersion` | `APP_VERSION` / `KERNEL_VERSION` / null | build/version strings |
| `environment.userAgent` / `language` / `platform` | `navigator` | device/browser facts, not patient data |
| `case.id` | `CaseDocument.id` | a random UUID; identifies the record, not a patient |
| `case.journalHash` | `hashCaseJournal(history)` | one-way SHA-256; never the journal content |
| `case.journalOperationCount` / `restorationCount` | array lengths | sizes, not content |
| `error.name` / `message` / `stack` | the thrown error | the failure itself (technical) |
| `log` | `diagnosticLogSnapshot()` | the bounded, scalar-only, PHI-free ring |

`manifoldVersion` is `null` on the client: there is no authoritative browser
constant for the installed manifold-3d build (the same honest posture as
`engine/traceabilityPreview.ts`). The server, which CAN resolve it
(`apps/server/src/manifold-version.ts`), is out of scope here — the client bundle
is the primary deliverable and the error surface is client-side.

## Consequences

- A maintainer gets versions + error + a technical event trail + which case
  (by id/hash/size) — enough to reproduce most client crashes — with zero PHI
  and zero network dependency.
- The error MESSAGE is developer-technical text shown framed by translated
  labels; it is the one allowlisted field that could in principle echo input, so
  it is reviewed as such (never a place to interpolate raw case content).
- Because nothing is uploaded, a bundle only reaches a maintainer if the user
  sends it — which is the correct consent boundary for PHI-adjacent software, and
  is documented to beta technicians as such.
- If a future deployment ever wants opt-in remote submission, it must be an
  explicit, separately-consented, separately-reviewed channel — this ADR is the
  record that the DEFAULT is, and stays, telemetry-free.
