# ADR-016 — Case archive container format (DQCA)

Phase 7 Task 6, Part B. Status: accepted.

## Context

The phase acceptance requires a single-file case archive (scans + full journal +
case document + settings + QC snapshots + released exports) that **round-trips to
identical state** when imported into a fresh server/DB. The archive must be
byte-**deterministic** (the export-determinism global constraint extends to
archives) and carry an integrity manifest (per-entry SHA-256 + a whole-archive
hash + a versioned format field). Archives CONTAIN patient scans (PHI), so no
archive built from a real scan is ever committed; tests use synthetic fixtures
only.

## Decision: a documented deterministic concatenation container, not ZIP

The brief allowed ZIP or a documented container. We chose a **documented
concatenation container (DQCA)**:

```
bytes 0..3    magic 'DQCA'
bytes 4..7    uint32 LE format version (1)
bytes 8..11   uint32 LE manifestLength
bytes 12..    manifest: canonical JSON (sorted keys, no whitespace) UTF-8
then          each entry's payload bytes, concatenated in manifest order
```

Manifest per entry: `name`, `kind`, `offset`, `length`, `sha256`; plus a
whole-archive `archiveSha256` (sha256 of the concatenated payload section), a
`manifestSha256` **self-hash** over the manifest's own descriptive fields
(review F-B2 — computed with the self-hash field held at a fixed placeholder),
and `formatVersion`. Entries are laid out in a fixed order (by `name`,
ascending).

### Why not ZIP

- **Determinism.** ZIP local/central headers carry per-entry mod-time and
  external-attribute (mode) fields that are environment-dependent; producing
  bit-identical ZIPs means zeroing all of them and pinning entry order/compression
  — fighting the format. A concatenation container has NO such fields: same case
  ⇒ bit-identical bytes, trivially. (`case-archive.test.ts` asserts two builds
  are byte-identical regardless of input order.)
- **Zero dependencies.** No `jszip`/`archiver` added to a medical-adjacent tree.
- **Full control of the integrity manifest.** Per-entry + whole-archive hashing,
  and a corrupted-entry rejection that NAMES the failing entry, are first-class,
  not bolted onto ZIP CRCs.
- **No timestamps anywhere in the archive.** The Case row's audit timestamps
  (`createdAt`/`updatedAt`) and each Export's `releasedAt` stay in the DB / are
  serialized as record fields inside the (hashed) case-document / export-row
  entries — never as archive-envelope metadata. `releasedAt` is preserved for
  ledger identity but does not make the archive non-deterministic for a fixed
  case, because it is a stored value, not a build-time read.

Portability across labs is preserved: the format is fully documented here and in
`case-archive.ts`, and the reader verifies the archive's **integrity** (manifest
self-hash + whole-archive + per-entry hashes) before reconstructing.

## Trust boundary: INTEGRITY, not AUTHENTICITY (review F-B1)

The archive is **client-supplied and unsigned**. The manifest detects
corruption/tampering of a *fixed* archive (integrity) but provides **no
authenticity** — an adversary who rewrites the whole archive recomputes every
hash. On import, the case document and every Export ledger row (`qcReportJson`,
`traceabilityJson`, `acknowledgmentsJson`, hashes) are reconstructed **verbatim
and are NOT re-validated**: a full re-run of the export QC needs the riding
`qcContext` (inner/outer/fit surfaces, dies, polylines), which is design-time
context the release ledger deliberately never persisted, so it is not
recoverable from the archive — re-validation on import is not tractable in this
design. To keep the ledger honest, every imported release row is stamped
**`importedUnverified: true`** (a nullable `Export` column; portable
`ALTER TABLE … ADD COLUMN` migration), so a consumer of the `Export` table can
always distinguish a server-re-validated release from an imported,
author-attested one. This is a deliberate second ledger write-path whose
provenance is explicit — never silently trusted. (A future hardening could
re-run the geometry-only outer-envelope check on imported releases whose
finalMesh container is present; the QC-gate re-run stays blocked on the
un-persisted qcContext.)

## Round-trip identity

Export gathers: the canonical case document (journal + settings + QC +
restorations + measurements ride inside it), every referenced scan mesh's stored
bytes, each restoration's persisted final-mesh container, and every Export ledger
row + its content-addressed bytes. Import into a FRESH DB reconstructs the case
with its ORIGINAL id and every Export row verbatim (original id + `releasedAt`
preserved) — **no Prisma migration**, because `create` accepts explicit
ids/timestamps, so provenance needs no new columns. Content-addressed stores make
scan/final-mesh/export-bytes storage idempotent + immutable. Proven end-to-end in
`archive-endpoint.test.ts`: case document deep-equal, scan/final-mesh bytes
byte-identical, `hashCaseJournal` match (journal replay-identical), Export rows
deep-equal, downloaded release bytes byte-identical.

## No-silent-mutation

Importing over an EXISTING case id is a typed **409 `archive-import-conflict`**;
the caller confirms with `?overwrite=true` (invariant 5). Corrupted archives are
rejected **400 `archive-invalid`** naming the failing entry.
