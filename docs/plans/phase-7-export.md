# Phase 7 — Export & Manufacturing Handoff (M7)

The phase everything has been building toward (PLAN.md §Phase 7): binary STL
export (watertight, outward normals, mm; optional PLY with color) + the
**independent backend re-validation on the exact exported bytes** (the server
loads what will actually be handed to the mill, re-runs EVERY QC gate with the
Node kernel, and only then releases the file; client/server mismatch = hard
failure + bug-report payload) + the QC traceability document (PDF-ready HTML +
machine-readable JSON: all gate results, parameters, material profile version,
kernel version, journal hash) + case archive export/import (single file:
scans + journal + settings) for support and inter-lab transfer.

**Phase acceptance (PLAN.md):**
1. An **exported crown STL re-imports as watertight/manifold**.
2. The **QC JSON is schema-validated**.
3. **Tampered export bytes are REJECTED by re-validation** (falsifiable).
4. **Archive round-trip reproduces identical case state**.
Plus standing invariants: full journal reproducibility (export is a journaled
operation); QC gates block export — acknowledge-with-warning journaled, never
bypassed; dual validation stays dual (the server re-validation consumes the
BYTES, never trusts the client result).

## Global constraints (bind every task)

Identical to Phases 4/5/6 (docs/plans/phase-{4,5,6}*.md): accuracy over speed;
Float64 kernel; determinism/journaling; no hardcoded clinical defaults;
booleans via the manifold wrapper; layer rule ui→engine→kernel-workers→kernel;
KERNEL_VERSION discipline (current: **0.26.0**); tests-first; NO commit
trailers (author Zoltán Dul only); `scans/` is PHI, never committed — **and
case archives CONTAIN scans, so no archive built from a real scan is ever
committed; synthetic-fixture archives only**; NEVER touch the user's live dev
server (:5198) or committed server/port files (the P4-T13 incident); no TS
constructor parameter properties in worker-loaded closures (P5-T1); serialized
kernel-built assets for cross-layer fixtures (P5-T8); bounded+localized
acknowledgments where load-bearing (ADR-010); synthetic-data disclosure in any
UI presenting fixture results (ADR-014).

**Export determinism is a first-class requirement:** same mesh + same params +
same kernel version ⇒ **bit-identical exported bytes** (byte-pinned goldens;
no timestamps inside hashed export content — the traceability doc may carry a
display timestamp only in clearly non-hashed presentation fields, decided and
documented in T5).

## Carry-ins (fold into the matching tasks)

- **19b (FIX FIRST — T1):** `bridgeDesign.ts` never reconstructs session state
  on reload; `runQc()` (~:728) and `acknowledgeGate()` (~:753) call
  `buildQcPayload` BEFORE their try blocks → reload → edit → "Run QC" click
  silently no-ops. Fix at the ROOT (reconstruct session from persisted stages
  on `start()`) and make the payload validation surface errors at BOTH call
  sites regardless. The e2e reload path that found it becomes the regression
  test. Check the crown/cavity workflows for the same shape.
- **P6-T8 minor (T1):** `BridgeQcInputError` on the validate-qc path maps to
  500; map input-shaped failures to 4xx with diagnostics (all three branches).
- Still tracked, NOT this phase: selfIntersection true-geometric gate; live
  material picker; ~280 KB client bridge asset; captured-milestone real
  capture; real-scan certifications (retraction-cord crown, cavity, bridge).

---

## Task 1 — 19b fix + server error-mapping carry-ins

1. The 19b root fix + regression tests (node-lane store tests + the browser
   lane; the reload→runQc and reload→acknowledge paths both surface real
   results/errors, never a silent no-op). Sweep crownDesign/cavityDesign for
   the same pre-try-block validation shape; fix if present.
2. The validate-qc 4xx mapping for input-shaped errors (crown/inlay/bridge
   branches uniformly; tests per branch).

**Verify:** full chain green; the previously-silent path demonstrably surfaces.
Commit.

---

## Task 2 — Export-grade mesh serialization (io)

1. **Certify `writeStlBinary` for manufacturing export**: deterministic byte
   output (fixed triangle ordering from the canonical kernel mesh, deterministic
   header content — no timestamps; documented byte layout), **outward normals
   guaranteed and verified from mesh topology** (not trusted from input),
   mm units (documented — STL is unitless; the header comment + docs state mm),
   Float64 → Float32 STL-format narrowing documented as the format's precision
   floor (@errorBound: max coordinate error = f32 ULP at coordinate magnitude;
   measured on the fixtures and surfaced in the QC traceability doc).
2. **PLY-with-color export** (optional per PLAN): `writePlyBinaryLE` path with
   per-vertex color (e.g. QC heatmap bake-ready; keep scope minimal — the
   deterministic-bytes + re-import discipline is what matters).
3. **Re-import identity**: export → parse → intake → canonical hash equals the
   source canonical hash (up to the documented f32 narrowing — define + pin the
   equivalence precisely); property tests + byte-pinned goldens on the P4/P5/P6
   fixture restorations; fuzz the writers' output through the existing parsers.

**Verify:** byte-pins + re-import identity + normals proof; chain green. Commit.

---

## Task 3 — Client export flow (journaled, gate-enforced)

1. **Export as a journaled `Operation`**: params (restoration, format, options,
   kernel version), input mesh hash, output BYTES hash. Replay reproduces the
   exact bytes (the P4/P5/P6 record→replay discipline extends to export).
2. **Gates block export, enforced at the export action**: hard-failing
   unacknowledged gates → export refused with the failing-gate list;
   acknowledged-with-warning → allowed, acknowledgments ride into the export
   record + traceability doc. Falsifiable both ways.
3. The export request: bytes + client QcReport + journal hash + profile
   version/checksum + kernel version to the server (schema in shared-types);
   worker-side serialization (no >50 ms UI block on big meshes).

**Verify:** journaled + replay-identical; gate enforcement falsifiable; chain
green. Commit.

---

## Task 4 — Server: independent re-validation on the exported bytes *(the heart of the phase)*

1. **`POST /api/restorations/:id/export`**: receive the exported bytes +
   client QC + context → **parse the exact bytes with the Node io/kernel →
   intake → re-run EVERY gate** for the restoration type (the P4/P5/P6
   validate-qc machinery, now fed from the BYTES, not from client-shipped
   arrays — the strongest form of invariant 6). Server recomputes everything;
   geometry-scoped params ride with the request per the established precedent.
2. **Mismatch = hard failure + bug-report payload**: any client/server gate
   delta → 409 with the per-field diff + a diagnostic bundle (both reports,
   byte hash, kernel/profile versions, parse diagnostics) persisted
   server-side for support. **Tampered bytes falsifiably rejected** (the
   acceptance: flip bytes in a passing export → rejected; both a geometry
   bit-flip and a truncation).
3. **Release only after pass**: content-addressed (SHA-256) immutable storage
   of the released bytes + QC snapshot + journal hash; `GET` download route
   streams the EXACT stored bytes (hash re-verified on read); an export row
   linked to the case (Prisma migration, portable SQL).
4. Acknowledged-gate exports: allowed, the acknowledgment journaled into the
   release record; ack-tampering → 409 (the P6-T8 precedent).

**Verify:** bit-identical pass proof; tamper rejection (both modes); mismatch
diagnostic bundle; download byte-identity; chain green. Commit.

---

## Task 5 — QC traceability document *(acceptance: schema-validated JSON)*

1. **Machine-readable JSON**: every gate result (measured values, thresholds,
   pass/fail/acknowledged + acknowledgment reasons), all parameters used,
   material profile name+version+checksum, KERNEL_VERSION, journal hash,
   export bytes hash, format error bounds (the T2 f32 narrowing; every
   documented approximation bound already in QcReport). **A versioned JSON
   Schema in shared-types; generation validates against it** (the acceptance);
   deterministic content (timestamp policy decided + documented).
2. **PDF-ready HTML**: human-readable rendering of the same data (print CSS,
   self-contained, i18n ×4 — the lab hands this to a human); generated from
   the SAME JSON (no second source of truth).
3. Server-generated at release time from the SERVER's re-validation results
   (the trustworthy copy), stored with the release; client can preview from
   its own report pre-export (clearly labeled preview).

**Verify:** schema validation in CI; HTML renders all four languages;
byte-pinned golden JSON on a fixture export; chain green. Commit.

---

## Task 6 — Case archive export/import *(acceptance: round-trip identical)*

1. **Single-file archive**: scans (content-addressed bytes) + full journal +
   case document + settings + QC snapshots + released exports; an integrity
   manifest (per-entry SHA-256 + whole-archive hash); versioned format
   (documented layout; ZIP or documented container — decide + ADR).
2. **Round-trip = identical state**: export archive → import into a FRESH
   server/DB → every hash identical (case doc deep-equal, scan bytes
   byte-identical, journal replay-identical). The acceptance test runs this
   full loop. Corrupted-entry import → rejected with the failing entry named.
3. PHI discipline: archives contain patient scans — test archives from
   synthetic fixtures ONLY; import confirms before overwriting an existing
   case (no silent mutation).

**Verify:** round-trip identity proven; corruption rejection; chain green.
Commit.

---

## Task 7 — UI: export & handoff workflow

Extend the staged workflow (P5-T8 shared core): the export panel — QC status
recap (failing gates block with the list; acknowledged flagged), format
options, export → server re-validation progress → released-file download +
traceability doc (HTML view + JSON download), mismatch = the bug-report
surface (honest failure, never "retry until green"); case archive
export/import UI (with the import confirmation). i18n ×4, invalidation
cascade (design edits after export mark the release stale), node+browser
lanes, ADR-014 disclosure where fixture data is shown.

**Verify:** browser-lane critical path; i18n parity; chain green. Commit.

---

## Task 8 — End-to-end acceptance + reproducibility *(the phase gate)*

The full-loop harness (journal-lib pattern): design chain (the P4 crown
fixture) → journaled export → server re-validation → release → download →
**re-import the downloaded bytes → watertight/manifold** (acceptance 1) →
traceability JSON schema-validated (acceptance 2) → tamper variant rejected
(acceptance 3) → archive round-trip identical (acceptance 4). Recorded →
replayed → bit-identical including the export op. Run the export loop for
inlay + bridge fixtures too (the gate table per type). Runtime reported;
BLOCKED-with-numbers if anything is unreachable.

**Verify:** all four acceptance criteria measured + reproducibility. Commit.

---

## Task 9 — e2e, docs, phase wrap-up

`e2e/phase7.spec.ts` (the export flow through the real UI: gate-blocked →
acknowledged → export → download + traceability doc; isolated bootstrap, the
P4-T13 lesson); `docs/demos/phase-7.md` (honest acceptance ledger: the four
criteria with measured numbers + test names, open items, KERNEL delta);
ADR(s) for real decisions (bytes-based re-validation design; archive format;
traceability timestamp policy). Full chain + e2e green.

**Verify:** all green; docs complete. Commit.
