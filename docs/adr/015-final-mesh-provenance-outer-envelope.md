# ADR-015 — Final-mesh byte provenance & outer-envelope certification (the T4-F2 closure)

Phase 7 Task 6, Part A. Status: accepted.

## Context

The T4 export re-validation (ADR-adjacent: `export-route.ts`) certifies the
delivered bytes' **gate results** by re-importing them and re-running every QC
gate. It documented a KNOWN LIMITATION (review "F2"): a coordinated byte tamper
that moves a welded vertex **outward** (away from the die), identically across
its per-triangle soup occurrences, welds cleanly, stays
watertight/manifold/single-component, and leaves **every gate value unchanged**
— thickness/marginFit measure the RIDING inner/outer surfaces, and the
solid-consuming gates (watertight, manifold, self-intersection, seating) are
insensitive to an outward move on a region far from the die. Such a tamper
RELEASES: the server report matches the client report while the delivered part's
outer shape is not the designed one. No gate measured the delivered solid's
**outer envelope** against a reference.

We reproduced this precisely: with the new assertion disabled
(`DQ_RED_PROOF=1`), the moved-apex crown export returns **200 (released)** —
`export-outer-envelope.test.ts`.

## Decision

1. **Persist the final-mesh bytes, content-addressed.** A new lossless container
   (`@dqcad/io`'s `encodeFinalMeshContainer`, magic `DQFM`) stores the exact
   Float64 positions + Uint32 indices verbatim, so the reconstructed mesh's
   content hash is byte-identical to `Restoration.stages.finalMesh` (binary STL
   is a lossy f32 boundary and cannot reproduce that hash — hence a dedicated
   container, not STL). The client persists it at save time
   (`serializeFinalMeshContent` job → `POST /api/final-meshes`), keyed
   server-side by the **content hash** (`final-mesh-storage.ts`), verified on
   both write and read.

2. **The export endpoint asserts outer-envelope equivalence.** After re-importing
   the delivered bytes, it resolves `stages.finalMesh` (journal-verified to equal
   `request.meshContentHash`) to the stored Float64 solid and asserts
   `hashMesh(reimport) === hashMesh(narrow32(canon(storedFinalMesh)))` — computed
   by serializing the stored solid with the SAME export writers and re-importing
   through the SAME intake path (the T2 equivalence), so no bespoke
   canon/narrow32 re-implementation. Mismatch → **409
   `export-outer-envelope-mismatch`**, a persisted diagnostic bundle, nothing
   released. Post-fix, the moved-apex tamper is rejected 409.

3. **What the client can materialize (honest boundary).** Only a restoration
   whose LIVE design session still holds its final-mesh buffers (the T3
   `finalMeshForExport` getters) can be serialized+persisted at save time. After
   a reload the session buffers are gone (the same reason the export flow's
   `finalMeshUnavailable` refusal exists) — such a restoration is SKIPPED, never
   fabricated. This is not a coverage gap: the store is content-addressed and
   immutable, so a finalMesh persisted at the save when its design WAS live stays
   resolvable forever; a later reload cannot re-upload it but never needs to. The
   only genuinely-unrecoverable case is a finalMesh NEVER saved with a live
   session.

4. **`outerEnvelopeCertified` stays `false` (const flip DEFERRED to T8).** The
   T5 disclosure is a schema-pinned `const false`. Flipping it to `true` requires
   a traceability `schemaVersion` bump carrying the closure evidence AND every
   flow guaranteeing persistence. We deliberately DO NOT flip it here:
   - The certification is **conditional on byte provenance being present**. When
     the finalMesh bytes are stored, the assertion runs (real defense). When they
     are absent (legacy case, or an unpersisted-final-mesh restoration), the
     release proceeds with F2 honestly OPEN for that release — exactly what
     `outerEnvelopeCertified: false` discloses.
   - A blanket `true` would over-claim for the absent-provenance path.
   - So the disclosure stays conservatively `false`; the endpoint performs the
     assertion regardless (defense is real even while the document discloses
     conservatively). The flip becomes correct once T8 makes persistence
     mandatory on every release path (a hard-refuse on absent provenance), at
     which point the schema bump lands with that evidence.

## Consequences

- The strongest tamper in the phase acceptance's model is now rejected; a real
  insider-consistent outer move is caught by geometry provenance, not gate
  results.
- No `CaseDocument` schema change: `stages.finalMesh` is unchanged (still the
  content hash); only the store now HAS the bytes behind it.
- A malicious client could still skip the finalMesh upload to reach the
  F2-open path — acceptable and disclosed until T8 makes persistence mandatory.
