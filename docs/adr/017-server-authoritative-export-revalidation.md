# ADR-017 — Server-authoritative export re-validation (bytes-based dual validation + profile pinning)

Phase 7 Tasks 4 (+ the T4-F1 fix round). Status: accepted.

## Context

CLAUDE.md invariant 6 requires the server to re-validate exports independently
and never "optimize" that into trusting the client result. Phase 7's central
deliverable — the manufacturing handoff — is only safe if the file the mill
actually receives is the file the server independently certified. Two attack
surfaces make a naive design unsafe:

1. **Trusting client-shipped geometry.** If the server re-ran QC on
   client-supplied gate-input arrays (the P4/P5/P6 validate-qc shape), a client
   could ship clean arrays alongside tampered STL bytes and release a bad part.
2. **Trusting client-shipped thresholds.** The QC gate thresholds
   (min wall, connector area, cusp coverage, pontic relief …) are clinical
   parameters. If the server accepted them from the request's `qcContext`, a
   client could loosen a threshold (`minWallThicknessMm: 0.05`) and ship a
   295 µm wall with a matching self-consistent report — released, "passed",
   with the loosened threshold recorded in the "authoritative" ledger. This
   exact exploit was demonstrated by the T4 review and released **200** before
   the fix.

## Decision

**The server recomputes everything it can from the delivered bytes, and pins
everything it cannot recompute against a trusted authority — the request is
evidence, never the verdict.**

1. **Re-validate on the BYTES.** `POST /api/restorations/:id/export` parses
   `request.bytesBase64` with the Node io parser → kernel intake → and the
   re-imported mesh **replaces the restoration solid everywhere it appears in
   gate inputs** (`analyzeMesh`, `measureSelfIntersection`, `measureSeating`,
   the bridge `extractFitPatch`). The server re-runs **every** gate for the
   restoration type and compares its report to the client's with an exact
   `diffQcReports` — any delta → **409 `export-qc-mismatch`** + a persisted
   diagnostic bundle, nothing released. Bytes integrity is verified FIRST
   (declared vs actual sha256/length) so a hash-upkeep-free tamper is caught
   before anything runs.

2. **The three-class boundary (defined in exactly one place).** The request
   body is `{ request, qcContext }`; `qcContext` is derived PROGRAMMATICALLY
   from the validate-qc branch schemas MINUS two groups
   (`omitBodySchemaProperties`, so the boundary cannot drift):
   - **byte-derived (removed, re-imported):** the restoration solid;
   - **request-derived (removed, taken from VERIFIED request identity):**
     `restorationType`/`kernelVersion`/`profileVersion`/`journalHash`/
     acknowledged gates;
   - **riding (kept):** the design-time surfaces the mill bytes cannot
     reconstruct (dies, inner/outer/fit surfaces, polylines, seam edges, axes,
     contact residuals) — the same trust shape as the established validate-qc
     precedent.

3. **Server-resolved profile & threshold authority (T4-F1 — the most important
   invariant defense).** Before any gate runs the server (`export-profile.ts`):
   resolves the profile named by `request.materialProfile.{id,version}` from the
   `@dqcad/clinical-profiles` registry (unknown → 409); verifies its checksum
   (fabricated → 409); and verifies **every** profile-derived constant riding in
   `qcContext` EQUAL to the resolved authority under the client engines' own
   resolution rules (crown min-wall from the saved schema-bounded params, the
   per-connector FDI positional targets recomputed, the pontic-style relief map,
   …). Any mismatch → **409 `export-profile-threshold-mismatch`** naming each
   field — refused, never silently substituted (the client must learn its
   thresholds were wrong). The free tolerance knobs with no profile source are
   schema-FORBIDDEN in the export contexts entirely. Because equality is
   enforced, feeding the riding value IS running with the server-resolved
   threshold.

4. **Release only after pass, content-addressed & immutable.** A release stores
   the exact bytes content-addressed (SHA-256, re-hashed on every read), appends
   an append-only `Export` ledger row (server report snapshot, verified
   acknowledgments, hashes, kernel/profile identity), and streams the exact
   stored bytes on `GET download`. Acknowledged-gate exports are allowed with the
   acknowledgment journal-verified into the release; a null/tampered ack ref →
   409 (warn-and-accept forbidden). The teeth identity is verified three-way
   (request = saved restoration = journaled op) so a wrong-site label cannot
   enter the ledger (T5-B1).

## Consequences

- The strongest form of invariant 6: the certified computation runs on the
  delivered geometry with server-owned thresholds; a client cannot smuggle
  clean arrays, loosened thresholds, or a mislabeled site past the gate.
- The re-import uses the T2 narrowing-equivalence (`R = narrow32(canon(M))` for
  STL): gate results are invariant under the ≤ half-ULP narrowing on the
  fixtures, so a legitimate export's client and server reports match exactly.
  When a value genuinely moves under narrowing, the diff 409s with the bundle —
  honest surfacing, not a smoothed comparison. **The Phase 7 e2e measured this
  live:** a fresh case with empty `settings` stamps `profileVersion:
  'unversioned'` in the client QC while the export resolves standard-zirconia
  1.4.0 → the server honestly refuses `export-qc-mismatch` on that field until a
  material picker sets the profile (docs/demos/phase-7.md open items).
- `export-outer-envelope-mismatch` (ADR-015) is a distinct, EARLIER gate: it
  certifies the delivered solid's outer geometry against the persisted
  finalMesh, catching a gate-invariant outward tamper the QC diff cannot see.
- The server duplicates a subset of client resolution logic (`isAckOpFor`,
  the per-field authority map) because it cannot import client engine code; the
  two are kept in documented lockstep and any drift surfaces as a spurious 409
  in the pass-proof suites.
